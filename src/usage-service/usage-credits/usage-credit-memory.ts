import { join } from "node:path";
import { getHiveHome } from "../../hive-home/home";
import type { CapabilityProvider } from "../../schemas/capability";
import { readAccountBilling } from "./reader";
import {
  AccountBillingSchema,
  type AccountBilling,
} from "./usage-credit-types";

/** How stale a remembered billing reading may be and still answer the spend question. Judgment, not a measurement, so it is printed beside every use of it rather than buried here. The bound protects exactly one thing. A remembered reading is dangerous only if BOTH the pool has since crossed 100% AND usage credits have since been turned ON — below 100% there is nothing to bill, and with credits off nothing can pay. Credits are a setting the USER changes deliberately; he is not toggling them while a spawn is in flight. So the window only has to be short enough that his own pools cannot silently have gone from headroom to exhausted-and-billing without him knowing, and 30 minutes is comfortably inside that. Past it, the memory expires and the honest answer returns: unknown, so ask. */
export const BILLING_MEMORY_TTL_MINUTES = 30;

const billingMemoryPath = (provider: CapabilityProvider): string =>
  join(getHiveHome(), `billing-${provider}.json`);

const usable = (billing: AccountBilling): boolean =>
  billing.creditsEnabled.state === "known" ||
  billing.generalUtilization.state === "known" ||
  Object.keys(billing.modelUtilization).length > 0;

const warnedStale = new Set<string>();

async function rememberedBilling(
  provider: CapabilityProvider,
  options: { now?: () => Date; path?: string } = {},
): Promise<{ value: AccountBilling; ageMinutes: number } | null> {
  const now = options.now?.() ?? new Date();
  const path = options.path ?? billingMemoryPath(provider);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const remembered = AccountBillingSchema.safeParse(
    await file.json().catch(() => null),
  );
  if (!remembered.success) return null;

  const observedAt = remembered.data.creditsEnabled.observedAt;
  const ageMinutes = (now.getTime() - Date.parse(observedAt)) / 60_000;
  if (
    !Number.isFinite(ageMinutes) ||
    ageMinutes < 0 ||
    ageMinutes > BILLING_MEMORY_TTL_MINUTES
  ) {
    return null;
  }
  return { value: remembered.data, ageMinutes };
}

/** Read only the daemon's last valid billing observation. Never contacts a provider, so request handlers and UI projections can use it safely. */
export async function readRememberedBilling(
  provider: CapabilityProvider,
  options: { now?: () => Date; path?: string } = {},
): Promise<AccountBilling | null> {
  return (await rememberedBilling(provider, options))?.value ?? null;
}

/** The billing reader that heals itself. `readAccountBilling` returns null, or only unknown fields, whenever the vendor's telemetry endpoint goes quiet. Treat this as transient: refusing every launch on a telemetry hiccup creates an outage even when credits are known off and a charge is impossible. So: read live once, then fall back to the last reading that said something — carried at its TRUE AGE, because the `Discovered<T>` fields keep their own `observedAt` and every surface that prints them prints the age. A remembered pool percentage is not a guess; it is a measurement with a timestamp, which is exactly what the routing ladder's last-known-good rung already is. What it is never allowed to do is turn an unknown into a confident answer: past the TTL the memory expires and the caller gets the honest unknown back. Heal quietly, fail loudly: serving a stale reading warns ONCE per provider, not on every spawn. */
export async function readBillingWithMemory(
  provider: CapabilityProvider,
  options: {
    read?: (provider: CapabilityProvider) => Promise<AccountBilling | null>;
    now?: () => Date;
    warn?: (message: string) => void;
    path?: string;
  } = {},
): Promise<AccountBilling | null> {
  const read =
    options.read ?? ((p: CapabilityProvider) => readAccountBilling(p));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const path = options.path ?? billingMemoryPath(provider);

  // One live attempt, then one bounded last-known-good fallback. Repeating the same failed probe immediately adds latency and repeats deterministic faults.
  const live = await read(provider).catch(() => null);

  if (live !== null && usable(live)) {
    warnedStale.delete(provider);
    await Bun.write(path, `${JSON.stringify(live, null, 2)}\n`).catch(() => {});
    return live;
  }

  const remembered = await rememberedBilling(provider, {
    now: options.now,
    path,
  });
  if (remembered === null) {
    return live;
  }

  if (!warnedStale.has(provider)) {
    warnedStale.add(provider);
    warn(
      `Hive cannot read ${provider} billing right now (the vendor's usage surface ` +
        `is quiet). Falling back to the last reading, ${Math.round(remembered.ageMinutes)}m ` +
        "old, rather than refusing to launch: with usage credits off nothing can " +
        "be charged, so refusing would protect you from a charge that cannot " +
        "happen. Spawns continue; this heals itself when the surface answers.",
    );
  }
  return remembered.value;
}
