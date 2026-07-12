import { z } from "zod";
import { known, unknown, type Discovered } from "../schemas/capability";
import {
  ClaudeStdioProbeTransport,
  type ClaudeProbeTransport,
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
 * That is fully measurable. A model spends money only once a plan pool that gates
 * it is exhausted; until then it is covered by the plan already paid for. Hence
 * `modelCost()` below: plan headroom → free; exhausted + credits on → real money,
 * ask first; exhausted + credits off → nothing can pay for it, so it genuinely
 * cannot run.
 *
 * Every field is `Discovered`. **An absent key is unknown, never `false`** — and
 * here that rule has teeth: a misspelled key would read back as "credits are
 * off", which renders as "this model cannot run", and Hive would silently
 * disable a model the user is happily using while every test stayed green.
 */

/** The surface these facts come from: the same free `get_usage` frame quota reads. */
const USAGE = "claude.get_usage" as const;

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
  /** Whether usage credits — the overflow that pays past the plan — are on. */
  creditsEnabled: Discovered<boolean>;
  /** The vendor's own reason, when it gives one. Printed, never paraphrased. */
  disabledReason: string | null;
  /** Percent used of the plan pool every model spends from. */
  generalUtilization: Discovered<number>;
  /** Percent used of each model's own extra ceiling, by the vendor's display name. */
  modelUtilization: Record<string, number>;
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
 * **With usage credits OFF, nothing can silently spend money.** A request that
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
      : `the ${displayName} plan pool is exhausted and Hive cannot read whether ` +
        "usage credits are on, so it cannot rule out a charge",
  };
}

/**
 * Read this account's billing facts from the live CLI.
 *
 * It rides the transport quota discovery already uses — the same free
 * `initialize` + `get_usage` frames, no second probe and no second session. A
 * failure yields `null`, and the caller then treats the risk as UNKNOWN rather
 * than as zero: an unreadable bill is not a free one.
 */
export async function readAccountBilling(
  transport: ClaudeProbeTransport = new ClaudeStdioProbeTransport(),
  observedAt: string = new Date().toISOString(),
  timeoutMs = 10_000,
): Promise<AccountBilling | null> {
  try {
    const payload = await transport.readUsage(timeoutMs);
    return accountBillingFromUsage(payload.usage, observedAt);
  } catch {
    return null;
  }
}
