import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  discovered,
  known,
  unknown,
  type CapabilityProvider,
  type Discovered,
} from "../schemas/capability";
import {
  ClaudeStdioProbeTransport,
  CodexStdioProbeTransport,
  type ClaudeProbeTransport,
  type CodexProbeTransport,
} from "./quota-sources";

/**
 * What it costs this account to run a model, measured — never inferred from a
 * date, a name, or a table.
 *
 * The design this replaces encoded a billing belief as a calendar constant
 * (`FABLE_AUTO_ROUTING_CUTOFF`): *after this date, Fable costs extra, so stop
 * routing to it.* That is a proxy, and proxies fail silently. Driving the live
 * surface on 2026-07-12 — after that very date — shows why:
 *
 *   rate_limits.model_scoped: [{ display_name: "Fable", utilization: 12, resets_at: … }]
 *
 * Fable still has a live plan-scoped weekly pool with 88% of it unused. It is
 * drawing PLAN capacity, not credits. The constant's premise is not true, and a
 * router obeying it is wrong about the world in a direction nobody would notice.
 *
 * **Usage credits are not a per-model billing mode.** No vendor field anywhere
 * declares how a model is billed — I walked every key of `initialize` and
 * `get_usage`. What the vendor does say, in `spend.disclaimer`, is what credits
 * actually are: *"Usage credits cover you when you hit your plan limits."* They
 * are the **overflow**. So the question worth asking is not "has this model moved
 * to credits" (unanswerable, and the wrong shape) but the one the user actually
 * cares about:
 *
 *   **Would running this model right now spend real money?**
 *
 * The plan side is measurable. A model can spend money only once a plan pool
 * that gates it is exhausted; until then it is covered by the plan already paid
 * for. Whether overflow is disabled is provider-specific: Claude says so
 * directly, while Codex exposes a current balance but not its auto-top-up switch.
 * Hence `spendRisk()` below: plan headroom → free; exhausted + paid capacity →
 * ask; exhausted + proven-off overflow → nothing can pay; exhausted + an
 * unobservable overflow switch → ask rather than guess.
 *
 * Every field is `Discovered`. **An absent key is unknown, never `false`** — and
 * here that rule has teeth: a misspelled key would read back as "credits are
 * off", which renders as "this model cannot run", and Hive would silently
 * disable a model the user is happily using while every test stayed green.
 */

/** The surface these facts come from: the same free `get_usage` frame quota reads. */
const USAGE = "claude.get_usage" as const;
const CODEX_LIMITS = "codex.account/rateLimits/read" as const;

/**
 * `get_usage`'s billing blocks, as claude 2.1.207 sends them. The key names are
 * snake_case and came off the live wire with a positive control — `extra_usage`
 * carried a real boolean and `spend` a real currency block. A *guessed* key does
 * not raise; it reads back as `null`, and null here means "cannot run".
 */
const CreditBlockSchema = z.object({
  rate_limits: z.object({
    extra_usage: z.object({
      is_enabled: z.boolean().nullable().optional(),
      disabled_reason: z.string().nullable().optional(),
    }).passthrough().nullable().optional(),
    spend: z.object({
      enabled: z.boolean().nullable().optional(),
      can_toggle: z.boolean().nullable().optional(),
      disabled_reason: z.string().nullable().optional(),
    }).passthrough().nullable().optional(),
    five_hour: z.object({ utilization: z.number().nullable() })
      .passthrough().nullable().optional(),
    seven_day: z.object({ utilization: z.number().nullable() })
      .passthrough().nullable().optional(),
    model_scoped: z.array(
      z.object({
        display_name: z.string().nullable(),
        utilization: z.number().nullable(),
      }).passthrough(),
    ).nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

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
  const creditsEnabled: Discovered<boolean> = flags.length === 0
    // The surface answered and carried no credit flag. That is not "off".
    ? unknown(limits === null || limits === undefined ? "surface-silent" : "field-absent", USAGE, observedAt)
    : flags.every((flag) => flag === flags[0])
    ? known(flags[0]!, USAGE, observedAt)
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
    generalUtilization: general.length === 0
      ? unknown("field-absent", USAGE, observedAt)
      : known(Math.max(...general), USAGE, observedAt),
    modelUtilization,
    overflowUncertainty: null,
  };
}

const CodexCreditSnapshotSchema = z.object({
  hasCredits: z.boolean().optional(),
  unlimited: z.boolean().optional(),
  balance: z.string().nullable().optional(),
}).passthrough();

const CodexWindowSchema = z.object({
  usedPercent: z.number(),
}).passthrough().nullable().optional();

const CodexLimitSnapshotSchema = z.object({
  limitName: z.string().nullable().optional(),
  primary: CodexWindowSchema,
  secondary: CodexWindowSchema,
  credits: CodexCreditSnapshotSchema.nullable().optional(),
}).passthrough();

const CodexBillingSchema = z.object({
  rateLimits: CodexLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), CodexLimitSnapshotSchema)
    .nullable().optional(),
}).passthrough();

/**
 * Read Codex's billing facts from `account/rateLimits/read`.
 *
 * Positive controls from the live 0.144.1 payload are the populated plan type
 * and windows beside `credits = { hasCredits: false, unlimited: false,
 * balance: "0" }`. The two false booleans prove only that no credits are
 * sitting in the account. They do NOT prove auto-top-up is off: Codex exposes
 * no such setting, and OpenAI documents that an eligible account may purchase
 * credits automatically. Therefore false/zero is deliberately UNKNOWN as an
 * overflow switch. Headroom still resolves to no-spend; exhaustion resolves to
 * ASK with the unobservable auto-top-up state named.
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
    [snapshot.primary?.usedPercent, snapshot.secondary?.usedPercent]
      .filter((value): value is number =>
        typeof value === "number" && Number.isFinite(value)
      );
  const general = used(root);
  const modelUtilization: Record<string, number> = {};
  for (const snapshot of Object.values(parsed.data.rateLimitsByLimitId ?? {})) {
    const values = used(snapshot);
    if (
      snapshot.limitName !== null && snapshot.limitName !== undefined &&
      values.length > 0
    ) {
      modelUtilization[snapshot.limitName.toLowerCase()] = Math.max(...values);
    }
  }

  const credits = root.credits;
  const hasPaidCapacity = credits?.hasCredits === true ||
    credits?.unlimited === true;
  const creditsEnabled: Discovered<boolean> = hasPaidCapacity
    ? known<boolean>(true, CODEX_LIMITS, observedAt)
    : unknown(
      credits === null || credits === undefined ? "field-absent" : "surface-silent",
      CODEX_LIMITS,
      observedAt,
    );

  return {
    creditsEnabled,
    disabledReason: null,
    generalUtilization: general.length === 0
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
 * The guard keys on MONEY, not on a model's name. There is no special case for
 * Fable or for anything else: the thing worth protecting is his wallet.
 *
 * **With usage credits proven OFF, nothing can silently spend money.** A request that
 * outruns the plan simply hits the plan limit and fails — the provider refuses,
 * no charge occurs. So the guard does not fire at all in that state, whatever the
 * pools say. A guard that nags a user who cannot be charged is a broken guard,
 * and one he learns to click through is worse than none.
 *
 * With credits ON, the vendor's own rule takes over — *"usage credits cover you
 * when you hit your plan limits"* — so an exhausted pool means the next spawn is
 * billed. That is the case to ask about, and it is measured, not guessed.
 *
 * A DECLARED GAP, stated rather than papered over: a spawn that BEGINS with plan
 * headroom can still cross into credits mid-run, and no free surface predicts how
 * much a spawn will consume. Hive cannot ask in advance for that case. It is a
 * false negative it cannot close, and pretending otherwise — by asking on every
 * spawn — would trade a real gap for a prompt nobody reads.
 *
 * **Absence from `model_scoped` is not evidence of anything.** Opus is absent from
 * that list and is plainly plan-billed: the list holds models with an EXTRA
 * ceiling, not "the models on the plan". A model with no ceiling of its own is
 * judged by the account-wide pool.
 */
export function spendRisk(
  billing: AccountBilling,
  displayName: string,
): SpendRisk {
  // The one fact that settles it on its own. No credits, no charge — the plan
  // limit is a wall, not a meter.
  if (
    billing.creditsEnabled.state === "known" && !billing.creditsEnabled.value
  ) {
    return {
      state: "no-spend",
      detail: "usage credits are off, so nothing can be charged: a request past " +
        "the plan limit is refused, not billed",
    };
  }

  const own = billing.modelUtilization[displayName.toLowerCase()];
  const general = billing.generalUtilization;
  if (general.state !== "known" && own === undefined) {
    return {
      state: "unknown",
      detail: "no plan-usage reading, so Hive cannot tell whether this spawn " +
        "would be billed to credits — and it will not spend your money on a " +
        "guess",
    };
  }
  const worst = Math.max(
    own ?? 0,
    general.state === "known" ? general.value : 0,
  );
  if (worst < 100) {
    const which = own === undefined
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
    detail: billing.creditsEnabled.state === "known"
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
 * Can this model actually RUN — a question nobody was asking, and a different
 * question from whether it would cost anything.
 *
 * `spendRisk` answers the MONEY question, and for an exhausted pool with credits
 * off it correctly answers "no charge: a request past the plan limit is REFUSED,
 * not billed". It says the word *refused* and then throws the fact away. Refused
 * is not free — it is UNAVAILABLE, and routing to it hands the user a dead agent
 * on a model the vendor was never going to run.
 *
 * That is exactly the state the user expects Fable to enter ("fable switches to
 * usage credits only tonight, and since we do not have credits, any time we want
 * deep it should automatically go to 4.8"). Without this, an exhausted-and-
 * unpayable model stays the router's first choice forever, because it is free.
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
    billing.creditsEnabled.state === "known" && !billing.creditsEnabled.value
  ) {
    return {
      state: "exhausted",
      detail: `its own ${displayName} pool is spent (${own}%) and usage credits ` +
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
 * `readAccountBilling` returns `null` — or a response in which every field is
 * unknown — whenever the vendor's telemetry endpoint goes quiet. That is a
 * TRANSIENT condition (Claude's `get_usage` fell silent at 01:40 on 2026-07-12 and
 * was answering again by 02:00, with the CLI healthy throughout), and treating it
 * as "Hive cannot rule out a charge" turned a hiccup in a telemetry endpoint into
 * an outage of every automatic Claude spawn. Refusing to launch protects the user
 * from a charge that, with credits off, is not merely unlikely but IMPOSSIBLE.
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
  const read = options.read ?? ((p: CapabilityProvider) => readAccountBilling(p));
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

  const observedAt = remembered.data.creditsEnabled.observedAt ??
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
  },
): Promise<AccountBilling | null> {
  try {
    if (provider === "codex") {
      const payload = await (transports?.codex ?? new CodexStdioProbeTransport())
        .readRateLimits(timeoutMs);
      return accountBillingFromCodexRateLimits(payload.limits, observedAt);
    }
    const payload = await (transports?.claude ?? new ClaudeStdioProbeTransport())
      .readUsage(timeoutMs);
    return accountBillingFromUsage(payload.usage, observedAt);
  } catch {
    return null;
  }
}
