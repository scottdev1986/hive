import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  type Discovered,
  discovered,
  known,
  unknown,
  unknownVendor,
} from "../schemas";
import {
  KimiHttpUsageTransport,
  KimiUsagesResponseSchema,
  type KimiUsageTransport,
  kimiUsageWindowMinutes,
  kimiUsageWindowPercent,
} from "./kimi-usage";
import {
  type ClaudeProbeTransport,
  ClaudeStdioProbeTransport,
  type CodexProbeTransport,
  CodexStdioProbeTransport,
  type GrokProbeTransport,
  GrokStdioProbeTransport,
} from "./quota-sources";

/**
 * Measures whether running a model would overflow its plan pool into paid
 * usage credits. Model names and dates do not establish billing mode.
 *
 * A model can spend money only after a plan pool that gates it is exhausted.
 * Whether paid overflow is disabled is provider-specific: Claude exposes it,
 * while Codex exposes a current balance but not its auto-top-up switch.
 * `spendRisk()` therefore treats plan headroom as free, exhausted paid capacity
 * as requiring consent, proven-disabled overflow as unable to charge, and an
 * unobservable overflow switch as unknown.
 *
 * Every field is `Discovered`. **An absent key is unknown, never `false`** — and
 * here that rule has teeth: a misspelled key would read back as "credits are
 * off", which renders as "this model cannot run", and Hive would silently
 * disable a model the user is happily using while every test stayed green.
 */

/** The surface these facts come from: the same free `get_usage` frame quota reads. */
const USAGE = "claude.get_usage" as const;
const CODEX_LIMITS = "codex.account/rateLimits/read" as const;
const GROK_BILLING = "grok._x.ai/billing" as const;

/**
 * `get_usage` billing blocks. The wire uses snake_case keys; an unrecognized
 * key does not raise and instead reads as null, which means unknown here.
 */
const CreditBlockSchema = z
  .object({
    rate_limits: z
      .object({
        extra_usage: z
          .object({
            is_enabled: z.boolean().nullable().optional(),
            disabled_reason: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        spend: z
          .object({
            enabled: z.boolean().nullable().optional(),
            can_toggle: z.boolean().nullable().optional(),
            disabled_reason: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        five_hour: z
          .object({ utilization: z.number().nullable() })
          .passthrough()
          .nullable()
          .optional(),
        seven_day: z
          .object({ utilization: z.number().nullable() })
          .passthrough()
          .nullable()
          .optional(),
        model_scoped: z
          .array(
            z
              .object({
                display_name: z.string().nullable(),
                utilization: z.number().nullable(),
              })
              .passthrough(),
          )
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export interface AccountBilling {
  /** Whether paid overflow is known available or known disabled. */
  creditsEnabled: Discovered<boolean>;
  /** The vendor's own reason, when it gives one. Printed, never paraphrased. */
  disabledReason: string | null;
  /** Percent used of the plan pool every model spends from. */
  generalUtilization: Discovered<number>;
  /** Percent used of each model's own extra ceiling, by the vendor's display name. */
  modelUtilization: Record<string, number>;
  /** Provider-specific uncertainty that must be named in a consent request. */
  overflowUncertainty?: string | null;
}

export type AccountBillings = Partial<
  Record<CapabilityProvider, AccountBilling>
>;

/** The vendors whose billing actually read back. A vendor that answered null is
 * omitted — absent means unknown here, and the derivation reads it as such —
 * but the caller supplies a slot for every known vendor, so "unknown" is a
 * measured null and never a vendor nobody remembered to ask. */
export function knownBillings(
  read: Record<CapabilityProvider, AccountBilling | null>,
): AccountBillings {
  const billings: AccountBillings = {};
  for (const provider of CAPABILITY_PROVIDERS) {
    const billing = read[provider];
    if (billing !== null) billings[provider] = billing;
  }
  return billings;
}

/**
 * Read the billing facts out of one `get_usage` response.
 *
 * `extra_usage.is_enabled` and `spend.enabled` are two views of one fact, so both
 * are read and cross-checked. If they disagree, the fact is `malformed` — not
 * "probably off". Two vendor blocks contradicting each other is precisely the
 * moment to stop guessing.
 */
export function accountBillingFromUsage(
  response: unknown,
  observedAt: string,
): AccountBilling {
  const parsed = CreditBlockSchema.safeParse(response);
  if (!parsed.success) {
    return {
      creditsEnabled: unknown("malformed", USAGE, observedAt),
      disabledReason: null,
      generalUtilization: unknown("malformed", USAGE, observedAt),
      modelUtilization: {},
      overflowUncertainty: null,
    };
  }
  const limits = parsed.data.rate_limits;
  const extra = limits?.extra_usage;
  const spend = limits?.spend;

  const flags = [extra?.is_enabled, spend?.enabled].filter(
    (flag): flag is boolean => typeof flag === "boolean",
  );
  const [firstFlag] = flags;
  const creditsEnabled: Discovered<boolean> =
    firstFlag === undefined
      ? // The surface answered and carried no credit flag. That is not "off".
        unknown(
          limits === null || limits === undefined
            ? "surface-silent"
            : "field-absent",
          USAGE,
          observedAt,
        )
      : flags.every((flag) => flag === firstFlag)
        ? known(firstFlag, USAGE, observedAt)
        : unknown("malformed", USAGE, observedAt);

  const utilization = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  // Every model spends the account-wide pool; the worst of the two windows is the
  // one that will actually stop a spawn.
  const general = [
    utilization(limits?.five_hour?.utilization),
    utilization(limits?.seven_day?.utilization),
  ].filter((value): value is number => value !== null);

  const modelUtilization: Record<string, number> = {};
  for (const scoped of limits?.model_scoped ?? []) {
    const used = utilization(scoped.utilization);
    if (scoped.display_name !== null && used !== null) {
      modelUtilization[scoped.display_name.toLowerCase()] = used;
    }
  }

  return {
    creditsEnabled,
    disabledReason: extra?.disabled_reason ?? spend?.disabled_reason ?? null,
    generalUtilization:
      general.length === 0
        ? unknown("field-absent", USAGE, observedAt)
        : known(Math.max(...general), USAGE, observedAt),
    modelUtilization,
    overflowUncertainty: null,
  };
}

const CodexCreditSnapshotSchema = z
  .object({
    hasCredits: z.boolean().optional(),
    unlimited: z.boolean().optional(),
    balance: z.string().nullable().optional(),
  })
  .passthrough();

const CodexWindowSchema = z
  .object({
    usedPercent: z.number(),
  })
  .passthrough()
  .nullable()
  .optional();

const CodexLimitSnapshotSchema = z
  .object({
    limitName: z.string().nullable().optional(),
    primary: CodexWindowSchema,
    secondary: CodexWindowSchema,
    credits: CodexCreditSnapshotSchema.nullable().optional(),
  })
  .passthrough();

const CodexBillingSchema = z
  .object({
    rateLimits: CodexLimitSnapshotSchema,
    rateLimitsByLimitId: z
      .record(z.string(), CodexLimitSnapshotSchema)
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Read Codex's billing facts from `account/rateLimits/read`.
 *
 * False `hasCredits` and `unlimited` values prove only that no paid capacity is
 * currently present. Codex exposes no auto-top-up setting, so false or zero is
 * deliberately unknown as an overflow switch. Headroom resolves to no-spend;
 * exhaustion resolves to ask with the uncertainty named.
 */
export function accountBillingFromCodexRateLimits(
  response: unknown,
  observedAt: string,
): AccountBilling {
  const parsed = CodexBillingSchema.safeParse(response);
  if (!parsed.success) {
    return {
      creditsEnabled: unknown("malformed", CODEX_LIMITS, observedAt),
      disabledReason: null,
      generalUtilization: unknown("malformed", CODEX_LIMITS, observedAt),
      modelUtilization: {},
      overflowUncertainty: "Codex billing data was malformed",
    };
  }

  const root = parsed.data.rateLimits;
  const used = (snapshot: z.infer<typeof CodexLimitSnapshotSchema>): number[] =>
    [snapshot.primary?.usedPercent, snapshot.secondary?.usedPercent].filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  const general = used(root);
  const modelUtilization: Record<string, number> = {};
  for (const snapshot of Object.values(parsed.data.rateLimitsByLimitId ?? {})) {
    const values = used(snapshot);
    if (
      snapshot.limitName !== null &&
      snapshot.limitName !== undefined &&
      values.length > 0
    ) {
      modelUtilization[snapshot.limitName.toLowerCase()] = Math.max(...values);
    }
  }

  const credits = root.credits;
  const hasPaidCapacity =
    credits?.hasCredits === true || credits?.unlimited === true;
  const creditsEnabled: Discovered<boolean> = hasPaidCapacity
    ? known<boolean>(true, CODEX_LIMITS, observedAt)
    : unknown(
        credits === null || credits === undefined
          ? "field-absent"
          : "surface-silent",
        CODEX_LIMITS,
        observedAt,
      );

  return {
    creditsEnabled,
    disabledReason: null,
    generalUtilization:
      general.length === 0
        ? unknown("field-absent", CODEX_LIMITS, observedAt)
        : known(Math.max(...general), CODEX_LIMITS, observedAt),
    modelUtilization,
    overflowUncertainty: hasPaidCapacity
      ? null
      : "Codex reports no current credit balance, but its CLI does not expose " +
        "whether auto-top-up is enabled; proceeding after the plan is exhausted " +
        "may purchase credits",
  };
}

const GrokBillingSchema = z
  .object({
    subscription_tier: z.string().nullable().optional(),
    config: z
      .object({
        creditUsagePercent: z.number().nullable().optional(),
        onDemandCap: z
          .object({ val: z.number().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
        onDemandUsed: z
          .object({ val: z.number().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
        prepaidBalance: z
          .object({ val: z.number().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Read Grok money-guard + weekly utilization from `_x.ai/billing`.
 *
 * `creditUsagePercent` is the gauge (plan pool used). The money rails
 * (`onDemandCap` / `onDemandUsed` / `prepaidBalance`) answer whether paid
 * overflow is live. All three rails at zero is measured paid-overflow-off;
 * any positive rail is paid capacity. Do not map a money-rail zero onto
 * utilization: the rails and the plan gauge measure different things.
 */
export function accountBillingFromGrokBilling(
  response: unknown,
  observedAt: string,
): AccountBilling {
  const parsed = GrokBillingSchema.safeParse(response);
  if (!parsed.success || parsed.data.config == null) {
    return {
      creditsEnabled: unknown("malformed", GROK_BILLING, observedAt),
      disabledReason: null,
      generalUtilization: unknown("malformed", GROK_BILLING, observedAt),
      modelUtilization: {},
      overflowUncertainty: "Grok billing data was malformed",
    };
  }
  const config = parsed.data.config;
  const moneyVal = (
    rail: { val?: number | null } | null | undefined,
  ): number | null =>
    typeof rail?.val === "number" && Number.isFinite(rail.val)
      ? rail.val
      : null;
  const cap = moneyVal(config.onDemandCap);
  const used = moneyVal(config.onDemandUsed);
  const prepaid = moneyVal(config.prepaidBalance);
  const railsPresent = cap !== null && used !== null && prepaid !== null;
  const anyPositive = (cap ?? 0) > 0 || (used ?? 0) > 0 || (prepaid ?? 0) > 0;
  const creditsEnabled: Discovered<boolean> = !railsPresent
    ? unknown("field-absent", GROK_BILLING, observedAt)
    : known(anyPositive, GROK_BILLING, observedAt);

  // Same decode as `readingsFromGrokBilling`, and deliberately identical: xAI
  // omits `creditUsagePercent` while it rounds to zero, so an absent key is a
  // measured 0 rather than an unknown. A key that is PRESENT but unreadable
  // stays unknown — two decoders disagreeing about one field is how a wire
  // reading drifts.
  const percent = config.creditUsagePercent;
  const generalUtilization: Discovered<number> =
    percent === undefined || percent === null
      ? known(0, GROK_BILLING, observedAt)
      : typeof percent === "number" &&
          Number.isFinite(percent) &&
          percent >= 0 &&
          percent <= 100
        ? known(percent, GROK_BILLING, observedAt)
        : unknown("field-absent", GROK_BILLING, observedAt);

  return {
    creditsEnabled,
    disabledReason: null,
    generalUtilization,
    modelUtilization: {},
    overflowUncertainty: null,
  };
}

// ---------------------------------------------------------------------------
// Kimi: GET /usages — the CLI's own /usage panel endpoint.
// ---------------------------------------------------------------------------

const KIMI_USAGES = "kimi.usages" as const;

/**
 * One /usages response → an AccountBilling. The numbers arrive as strings.
 * The AccountBilling shape has room for exactly one window, so the SHORTEST
 * rate window is the one surfaced because it is the first to bite mid-session.
 * The weekly quota is
 * part of the same payload but has no field here — it stays unread rather
 * than being blended into a number that would misname it. The payload
 * carries no paid-overflow rail, so creditsEnabled is surface-silent
 * unknown, never a guessed false.
 */
export function accountBillingFromKimiUsage(
  response: unknown,
  observedAt: string,
): AccountBilling {
  const quiet = (reason: string): AccountBilling => ({
    creditsEnabled: unknown("surface-silent", KIMI_USAGES, observedAt),
    disabledReason: null,
    generalUtilization: unknown(
      reason as "malformed" | "field-absent",
      KIMI_USAGES,
      observedAt,
    ),
    modelUtilization: {},
    overflowUncertainty: null,
  });
  const parsed = KimiUsagesResponseSchema.safeParse(response);
  // usage and limits are both optional, so a shape-changed payload parses
  // clean with neither — that is the surface going quiet, and it is
  // malformed, not a confident "no windows".
  if (!parsed.success) return quiet("malformed");
  if (parsed.data.usage == null && parsed.data.limits == null) {
    return quiet("malformed");
  }

  const windows = (parsed.data.limits ?? [])
    .filter((entry) => entry !== null)
    .map((entry) => ({
      minutes: kimiUsageWindowMinutes(
        entry.window.duration,
        entry.window.timeUnit,
      ),
      detail: entry.detail,
    }))
    .filter(
      (entry): entry is typeof entry & { minutes: number } =>
        entry.minutes !== null,
    )
    .sort((left, right) => left.minutes - right.minutes);
  const shortest = windows[0];
  if (shortest === undefined) return quiet("field-absent");
  const percent = kimiUsageWindowPercent(shortest.detail);
  if (percent === null) return quiet("malformed");

  return {
    creditsEnabled: unknown("surface-silent", KIMI_USAGES, observedAt),
    disabledReason: null,
    generalUtilization: known(
      Math.round(percent * 10) / 10,
      KIMI_USAGES,
      observedAt,
    ),
    modelUtilization: {},
    overflowUncertainty: null,
  };
}

export type SpendRisk =
  /** Cannot cost money: either credits are off, or the plan still covers it. */
  | { state: "no-spend"; detail: string }
  /** Would overflow the plan into PAID credits. Ask him first. */
  | { state: "would-spend"; detail: string }
  /** Cannot be determined. Resolves to ASK — silence is not consent. */
  | { state: "unknown"; detail: string };

/**
 * Would launching this model right now spend the user's real money?
 *
 * The guard keys on money, not on a model's name.
 *
 * **With usage credits proven OFF, nothing can silently spend money.** A request that
 * outruns the plan simply hits the plan limit and fails — the provider refuses,
 * no charge occurs. So the guard does not fire at all in that state, whatever the
 * pools say. A guard that nags a user who cannot be charged is a broken guard,
 * and one he learns to click through is worse than none.
 *
 * With credits on, an exhausted pool means the next spawn is billed. That is
 * the case to ask about.
 *
 * A spawn that begins with plan headroom can cross into credits mid-run, and no
 * available surface predicts its eventual usage. Hive cannot ask in advance for
 * that case without asking on every spawn.
 *
 * Absence from `model_scoped` is not billing evidence. The list holds models
 * with an extra ceiling; models without one use the account-wide pool.
 */
export function spendRisk(
  billing: AccountBilling,
  displayName: string,
): SpendRisk {
  // The one fact that settles it on its own. No credits, no charge — the plan
  // limit is a wall, not a meter.
  if (
    billing.creditsEnabled.state === "known" &&
    !billing.creditsEnabled.value
  ) {
    return {
      state: "no-spend",
      detail:
        "usage credits are off, so nothing can be charged: a request past " +
        "the plan limit is refused, not billed",
    };
  }

  const own = billing.modelUtilization[displayName.toLowerCase()];
  const general = billing.generalUtilization;
  if (general.state !== "known" && own === undefined) {
    return {
      state: "unknown",
      detail:
        "no plan-usage reading, so Hive cannot tell whether this spawn " +
        "would be billed to credits — and it will not spend your money on a " +
        "guess",
    };
  }
  const worst = Math.max(
    own ?? 0,
    general.state === "known" ? general.value : 0,
  );
  if (worst < 100) {
    const which =
      own === undefined
        ? `account plan pool ${worst}% used`
        : `${displayName} pool ${own}% used`;
    return {
      state: "no-spend",
      detail: `the plan still covers this (${which})`,
    };
  }

  // The pool is spent, and credits are on (or unreadable). Either way the next
  // spawn may be billed, and that is his call to make, not Hive's.
  return {
    state: "would-spend",
    detail:
      billing.creditsEnabled.state === "known"
        ? `the ${displayName} plan pool is exhausted and usage credits are ON, so ` +
          "this spawn would be billed to credits — real money"
        : billing.overflowUncertainty == null
          ? `the ${displayName} plan pool is exhausted and Hive cannot read whether ` +
            "usage credits are on, so it cannot rule out a charge"
          : `the ${displayName} plan pool is exhausted. ${billing.overflowUncertainty}`,
  };
}

export type PoolAvailability =
  | { state: "available" }
  | { state: "exhausted"; detail: string };

/**
 * Can this model run? This differs from whether it would cost anything.
 *
 * `spendRisk` answers the money question. An exhausted pool with credits off
 * cannot charge, but the vendor also refuses it. Such a model is unavailable,
 * not free.
 *
 * The rule keys on MONEY and METERING, never on a model's name: a model the vendor
 * meters separately, whose own pool is spent, with nothing that can pay the
 * overflow, cannot run. Any model, any vendor, no date, no list. When the pool has
 * headroom it is available; when it is spent but credits could pay, it is not an
 * availability question at all — it is a spend question, and `spendRisk` asks him.
 */
export function poolAvailability(
  billing: AccountBilling,
  displayName: string,
): PoolAvailability {
  const own = billing.modelUtilization[displayName.toLowerCase()];
  // No dedicated pool is the NORMAL case (it is how Opus, Sonnet and Haiku all
  // read today): the model simply draws on the plan pool. It is not "unknown", and
  // treating it as unknown-and-excluded would exclude every model on the account.
  if (own === undefined || own < 100) return { state: "available" };
  // The pool is spent. Whether that is fatal depends on whether anything can pay.
  if (
    billing.creditsEnabled.state === "known" &&
    !billing.creditsEnabled.value
  ) {
    return {
      state: "exhausted",
      detail:
        `its own ${displayName} pool is spent (${own}%) and usage credits ` +
        "are OFF, so nothing can pay for the overflow — the vendor refuses the " +
        "request rather than billing it. The model cannot run, so it is not a " +
        "candidate; a capable model that can run is chosen instead",
    };
  }
  // Credits are on, or unreadable. Money might pay for this, so it is the spend
  // guard's question and his call — not an availability fact.
  return { state: "available" };
}

/**
 * Read this account's billing facts from the live CLI.
 *
 * It rides the transports quota discovery already uses: Claude's free
 * `initialize` + `get_usage` exchange or Codex's free app-server handshake plus
 * `account/rateLimits/read`. Neither starts a thread or turn. A failure yields
 * `null`, and the caller treats the risk as UNKNOWN rather than as zero: an
 * unreadable bill is not a free one.
 */
/**
 * How stale a remembered billing reading may be and still answer the spend
 * question. Judgment, not a measurement, so it is printed beside every use of it
 * rather than buried here.
 *
 * The bound protects exactly one thing. A remembered reading is dangerous only if
 * BOTH the pool has since crossed 100% AND usage credits have since been turned
 * ON — below 100% there is nothing to bill, and with credits off nothing can pay.
 * Credits are a setting the USER changes deliberately; he is not toggling them
 * while a spawn is in flight. So the window only has to be short enough that his
 * own pools cannot silently have gone from headroom to exhausted-and-billing
 * without him knowing, and 30 minutes is comfortably inside that.
 *
 * Past it, the memory expires and the honest answer returns: unknown, so ask.
 */
export const BILLING_MEMORY_TTL_MINUTES = 30;

/** The persisted shape of a remembered reading. A file we cannot parse is NO
 * memory, never a partially-trusted one. */
const AccountBillingSchema = z.strictObject({
  creditsEnabled: discovered(z.boolean()),
  disabledReason: z.string().nullable(),
  generalUtilization: discovered(z.number()),
  modelUtilization: z.record(z.string(), z.number()),
  overflowUncertainty: z.string().nullable().optional(),
});

const billingMemoryPath = (provider: CapabilityProvider): string =>
  join(
    Bun.env.HIVE_HOME ?? join(homedir(), ".hive"),
    `billing-${provider}.json`,
  );

/** A reading is USABLE when the surface actually answered something. A response
 * in which every field is unknown is a surface that went quiet, not a bill. */
const usable = (billing: AccountBilling): boolean =>
  billing.creditsEnabled.state === "known" ||
  billing.generalUtilization.state === "known" ||
  Object.keys(billing.modelUtilization).length > 0;

const warnedStale = new Set<string>();

/**
 * The billing reader that heals itself.
 *
 * `readAccountBilling` returns null, or only unknown fields, whenever the
 * vendor's telemetry endpoint goes quiet. Treat this as transient: refusing
 * every launch on a telemetry hiccup creates an outage even when credits are
 * known off and a charge is impossible.
 *
 * So: retry, then fall back to the last reading that actually said something —
 * carried at its TRUE AGE, because the `Discovered<T>` fields keep their own
 * `observedAt` and every surface that prints them prints the age. A remembered
 * pool percentage is not a guess; it is a measurement with a timestamp, which is
 * exactly what the routing ladder's last-known-good rung already is. What it is
 * never allowed to do is turn an unknown into a confident answer: past the TTL the
 * memory expires and the caller gets the honest unknown back.
 *
 * Heal quietly, fail loudly: serving a stale reading warns ONCE per provider, not
 * on every spawn.
 */
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
  const now = options.now?.() ?? new Date();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const path = options.path ?? billingMemoryPath(provider);

  // Two attempts. A telemetry endpoint that dropped one request usually answers
  // the next; one retry buys most of the recovery for one round trip.
  let live = await read(provider);
  if (live === null || !usable(live)) {
    live = await read(provider);
  }

  if (live !== null && usable(live)) {
    warnedStale.delete(provider);
    await Bun.write(path, `${JSON.stringify(live, null, 2)}\n`).catch(() => {});
    return live;
  }

  const file = Bun.file(path);
  if (!(await file.exists())) return live;
  const remembered = AccountBillingSchema.safeParse(
    await file.json().catch(() => null),
  );
  if (!remembered.success) return live;

  const observedAt =
    remembered.data.creditsEnabled.observedAt ??
    remembered.data.generalUtilization.observedAt;
  const ageMinutes = (now.getTime() - Date.parse(observedAt)) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > BILLING_MEMORY_TTL_MINUTES) {
    // Expired. The honest unknown comes back, and the guard asks — which is the
    // right answer once the memory is too old to stand behind.
    return live;
  }

  if (!warnedStale.has(provider)) {
    warnedStale.add(provider);
    warn(
      `Hive cannot read ${provider} billing right now (the vendor's usage surface ` +
        `is quiet). Falling back to the last reading, ${Math.round(ageMinutes)}m ` +
        "old, rather than refusing to launch: with usage credits off nothing can " +
        "be charged, so refusing would protect you from a charge that cannot " +
        "happen. Spawns continue; this heals itself when the surface answers.",
    );
  }
  return remembered.data;
}

export async function readAccountBilling(
  provider: CapabilityProvider = "claude",
  observedAt: string = new Date().toISOString(),
  timeoutMs = 10_000,
  transports?: {
    claude?: ClaudeProbeTransport;
    codex?: CodexProbeTransport;
    grok?: GrokProbeTransport;
    kimi?: KimiUsageTransport;
  },
): Promise<AccountBilling | null> {
  // The switch sits OUTSIDE the catch, and that placement is the whole point.
  // Inside it, an unknown vendor's throw would be swallowed into the same
  // `null` a quiet vendor surface produces — and null here means "billing
  // unknown", which the money guard is built to tolerate. The one branch that
  // must never be silent would have been the quietest of all.
  const read = billingReader(provider, timeoutMs, transports);
  try {
    return await read(observedAt);
  } catch {
    return null;
  }
}

function billingReader(
  provider: CapabilityProvider,
  timeoutMs: number,
  transports?: {
    claude?: ClaudeProbeTransport;
    codex?: CodexProbeTransport;
    grok?: GrokProbeTransport;
    kimi?: KimiUsageTransport;
  },
): (observedAt: string) => Promise<AccountBilling | null> {
  switch (provider) {
    case "codex":
      return async (observedAt) => {
        const payload = await (
          transports?.codex ?? new CodexStdioProbeTransport()
        ).readRateLimits(timeoutMs);
        return accountBillingFromCodexRateLimits(payload.limits, observedAt);
      };
    case "claude":
      return async (observedAt) => {
        const payload = await (
          transports?.claude ?? new ClaudeStdioProbeTransport()
        ).readUsage(timeoutMs);
        return accountBillingFromUsage(payload.usage, observedAt);
      };
    case "grok":
      return async (observedAt) => {
        const payload = await (
          transports?.grok ?? new GrokStdioProbeTransport()
        ).readBilling(timeoutMs);
        return accountBillingFromGrokBilling(payload.billing, observedAt);
      };
    case "kimi":
      return async (observedAt) => {
        const payload = await (
          transports?.kimi ?? new KimiHttpUsageTransport()
        ).readUsage(timeoutMs);
        if (payload.status !== "ok") {
          // A quiet surface is an all-unknown billing, never a zero: the
          // billing memory then serves the last real reading at its true age.
          return {
            creditsEnabled: unknown(
              "surface-silent",
              "kimi.usages",
              observedAt,
            ),
            disabledReason: null,
            generalUtilization: unknown(
              "surface-silent",
              "kimi.usages",
              observedAt,
            ),
            modelUtilization: {},
            overflowUncertainty: `Kimi usage unreadable: ${payload.reason}`,
          };
        }
        return accountBillingFromKimiUsage(payload.response, observedAt);
      };
    case "opencode":
      // opencode exposes no session-free billing or quota surface either.
      return async () => null;
    default:
      return unknownVendor(provider, "readAccountBilling");
  }
}
