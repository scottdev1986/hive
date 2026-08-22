import { z } from "zod";
import { known, unknown } from "../../schemas/capability";
import { readingsFromGrokBilling } from "../quota-sources";
import type { AccountBilling } from "./usage-credit-types";
import { utilizationFromPools } from "./utilization";
import { isNumber } from "../../shared/is-record";

const GROK_BILLING = "grok._x.ai/billing" as const;

const GrokMoneyValSchema = z
  .object({ val: z.number().nullable().optional() })
  .nullable()
  .optional();

const GrokBillingSchema = z.object({
  config: z
    .object({
      onDemandCap: GrokMoneyValSchema,
      onDemandUsed: GrokMoneyValSchema,
      prepaidBalance: GrokMoneyValSchema,
    })
    .nullable()
    .optional(),
});

/** Read Grok money-guard + weekly utilization from `_x.ai/billing`. `creditUsagePercent` is the gauge (plan pool used). The money rails (`onDemandCap` / `onDemandUsed` / `prepaidBalance`) answer whether paid overflow is live. All three rails at zero is measured paid-overflow-off; any positive rail is paid capacity. Do not map a money-rail zero onto utilization: the rails and the plan gauge measure different things. */
export function accountBillingFromGrokBilling<T>(
  response: T,
  observedAt: string,
): AccountBilling {
  const utilization = utilizationFromPools(
    readingsFromGrokBilling(response, "billing", observedAt),
    GROK_BILLING,
    observedAt,
  );
  const parsed = GrokBillingSchema.safeParse(response);
  if (!parsed.success || parsed.data.config == null) {
    return {
      creditsEnabled: unknown("malformed", GROK_BILLING, observedAt),
      ...utilization,
      overflowUncertainty: null,
    };
  }
  const config = parsed.data.config;
  const moneyVal = (
    rail: { val?: number | null } | null | undefined,
  ): number | null =>
    isNumber(rail?.val) && Number.isFinite(rail.val) ? rail.val : null;
  const cap = moneyVal(config.onDemandCap);
  const used = moneyVal(config.onDemandUsed);
  const prepaid = moneyVal(config.prepaidBalance);
  const railsPresent = cap !== null && used !== null && prepaid !== null;
  const anyPositive = (cap ?? 0) > 0 || (used ?? 0) > 0 || (prepaid ?? 0) > 0;
  const creditsEnabled: AccountBilling["creditsEnabled"] = !railsPresent
    ? unknown("field-absent", GROK_BILLING, observedAt)
    : known(anyPositive, GROK_BILLING, observedAt);

  return {
    creditsEnabled,
    ...utilization,
    overflowUncertainty: null,
  };
}
