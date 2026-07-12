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

export type ModelCost =
  /** Covered by the plan the user already pays for. Costs nothing extra. */
  | { state: "on-plan"; detail: string }
  /** The plan pool that gates it is spent; running it now spends real money. */
  | { state: "spends-credits"; detail: string }
  /** Its pool is spent and nothing can pay: no credits. It genuinely cannot run. */
  | { state: "unpayable"; detail: string }
  /** Not measurable. Never rendered as any of the above. */
  | { state: "unknown"; detail: string };

/**
 * What running this model right now would cost.
 *
 * A model with its own ceiling (Fable has one; most models do not) is gated by
 * whichever pool bites first — its own or the account-wide one. **Absence from
 * `model_scoped` means the model has no extra ceiling, not that it has no plan
 * coverage**: Opus is absent from that list and is plainly plan-billed. Reading
 * absence as "no plan" would have disabled Opus, which is the same absence-is-not-
 * false trap in a costume.
 */
export function modelCost(
  billing: AccountBilling,
  displayName: string,
): ModelCost {
  const own = billing.modelUtilization[displayName.toLowerCase()];
  const general = billing.generalUtilization;
  if (general.state !== "known" && own === undefined) {
    return {
      state: "unknown",
      detail: "no plan-usage reading for this account, so whether this model " +
        "would spend money is not measurable",
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
      state: "on-plan",
      detail: `covered by the plan (${which}); costs no extra money`,
    };
  }

  // The gating pool is spent. From here on the vendor bills usage credits — its
  // own words: "Usage credits cover you when you hit your plan limits."
  if (billing.creditsEnabled.state !== "known") {
    return {
      state: "unknown",
      detail: "the plan pool is exhausted and Hive cannot read whether usage " +
        "credits are enabled, so it will not auto-route into a possible charge",
    };
  }
  if (!billing.creditsEnabled.value) {
    return {
      state: "unpayable",
      detail: `the ${displayName} plan pool is exhausted and usage credits are ` +
        `off${
          billing.disabledReason === null ? "" : ` (${billing.disabledReason})`
        }, so nothing can pay for this spawn`,
    };
  }
  return {
    state: "spends-credits",
    detail: `the ${displayName} plan pool is exhausted, so this spawn would be ` +
      "billed to usage credits — real money, which Hive does not spend without " +
      "being asked",
  };
}

/**
 * Read this account's billing facts from the live CLI.
 *
 * It rides the transport quota discovery already uses — the same free
 * `initialize` + `get_usage` frames, no second probe and no second session. A
 * failure yields `null`, which switches the cost filter OFF rather than ON: an
 * unreadable bill is not a free one, but it is not grounds to refuse every model
 * on suspicion either. The router then falls back to its other eligibility rules
 * and says, in the surface, that it could not read the bill.
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
