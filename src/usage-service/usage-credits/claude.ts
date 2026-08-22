import { z } from "zod";
import { known, unknown } from "../../schemas/capability";
import { readingsFromClaudeUsage } from "../quota-sources";
import type { AccountBilling } from "./usage-credit-types";
import { utilizationFromPools } from "./utilization";
import { isBoolean } from "../../shared/is-record";

const USAGE = "claude.get_usage" as const;

const CreditBlockSchema = z.object({
  rate_limits: z
    .object({
      extra_usage: z
        .object({
          is_enabled: z.boolean().nullable().optional(),
        })
        .nullable()
        .optional(),
      spend: z
        .object({
          enabled: z.boolean().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export function accountBillingFromUsage<T>(
  response: T,
  observedAt: string,
): AccountBilling {
  const utilization = utilizationFromPools(
    readingsFromClaudeUsage(response, "billing", observedAt),
    USAGE,
    observedAt,
  );
  const parsed = CreditBlockSchema.safeParse(response);
  if (!parsed.success) {
    return {
      creditsEnabled: unknown("malformed", USAGE, observedAt),
      ...utilization,
      overflowUncertainty: null,
    };
  }
  const limits = parsed.data.rate_limits;
  const extra = limits?.extra_usage;
  const spend = limits?.spend;

  const flags = [extra?.is_enabled, spend?.enabled].filter(
    (flag): flag is boolean => isBoolean(flag),
  );
  const [firstFlag] = flags;
  const creditsEnabled: AccountBilling["creditsEnabled"] =
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

  return {
    creditsEnabled,
    ...utilization,
    overflowUncertainty: null,
  };
}
