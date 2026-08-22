import { unknown } from "../../schemas/capability";
import { KimiUsagesResponseSchema } from "../kimi-usage";
import { readingsFromKimiUsages } from "../quota-sources";
import type { AccountBilling } from "./usage-credit-types";
import { utilizationFromPools } from "./utilization";

const KIMI_USAGES = "kimi.usages" as const;

/** One /usages response → an AccountBilling. The numbers arrive as strings. The quota reader owns window parsing; this projection takes the most-used account-wide window because that is the first pool that can block a launch. The payload carries no paid-overflow rail, so creditsEnabled is surface-silent unknown, never a guessed false. */
export function accountBillingFromKimiUsage<T>(
  response: T,
  observedAt: string,
): AccountBilling {
  const quiet = (): AccountBilling => ({
    creditsEnabled: unknown("surface-silent", KIMI_USAGES, observedAt),
    generalUtilization: unknown("malformed", KIMI_USAGES, observedAt),
    modelUtilization: {},
    overflowUncertainty: null,
  });
  const parsed = KimiUsagesResponseSchema.safeParse(response);
  if (!parsed.success) return quiet();
  if (parsed.data.usage == null && parsed.data.limits == null) {
    return quiet();
  }

  const pools = readingsFromKimiUsages(parsed.data, "billing", observedAt);
  if (pools.length === 0) return quiet();
  const utilization = utilizationFromPools(pools, KIMI_USAGES, observedAt);

  return {
    creditsEnabled: unknown("surface-silent", KIMI_USAGES, observedAt),
    ...utilization,
    overflowUncertainty: null,
  };
}
