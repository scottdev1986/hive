import { z } from "zod";
import { known, unknown } from "../../schemas/capability";
import { readingsFromCodexResponse } from "../quota-sources";
import type { AccountBilling } from "./usage-credit-types";
import { utilizationFromPools } from "./utilization";

const CODEX_LIMITS = "codex.account/rateLimits/read" as const;

const CodexCreditSnapshotSchema = z.object({
  hasCredits: z.boolean().optional(),
  unlimited: z.boolean().optional(),
});

const CodexBillingSchema = z.object({
  rateLimits: z.object({
    credits: CodexCreditSnapshotSchema.nullable().optional(),
  }),
});

/** Read Codex's billing facts from `account/rateLimits/read`. False `hasCredits` and `unlimited` values prove only that no paid capacity is currently present. Codex exposes no auto-top-up setting, so false or zero is deliberately unknown as an overflow switch. Headroom resolves to no-spend; exhaustion resolves to ask with the uncertainty named. */
export function accountBillingFromCodexRateLimits(
  response: unknown,
  observedAt: string,
): AccountBilling {
  const utilization = utilizationFromPools(
    readingsFromCodexResponse(response, "billing", observedAt),
    CODEX_LIMITS,
    observedAt,
  );
  const parsed = CodexBillingSchema.safeParse(response);
  if (!parsed.success) {
    return {
      creditsEnabled: unknown("malformed", CODEX_LIMITS, observedAt),
      ...utilization,
      overflowUncertainty: null,
    };
  }
  const credits = parsed.data.rateLimits.credits;
  const hasPaidCapacity =
    credits?.hasCredits === true || credits?.unlimited === true;
  const creditsEnabled: AccountBilling["creditsEnabled"] = hasPaidCapacity
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
    ...utilization,
    overflowUncertainty: hasPaidCapacity
      ? null
      : "Codex reports no current credit balance, but its CLI does not expose " +
        "whether auto-top-up is enabled; proceeding after the plan is exhausted " +
        "may purchase credits",
  };
}
