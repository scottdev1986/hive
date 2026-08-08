import type { AccountBilling } from "./usage-credit-types";

export type SpendRisk =
  /** Cannot cost money: either credits are off, or the plan still covers it. */
  | { state: "no-spend"; detail: string }
  | { state: "would-spend"; detail: string }
  /** Cannot be determined. Resolves to ASK — silence is not consent. */
  | { state: "unknown"; detail: string };

interface PoolUsage {
  label: string;
  value: number;
}

const modelPools = (
  billing: AccountBilling,
  displayName: string,
): PoolUsage[] => {
  const pools: PoolUsage[] = [];
  if (billing.generalUtilization.state === "known") {
    pools.push({
      label: "account plan pool",
      value: billing.generalUtilization.value,
    });
  }
  const own = billing.modelUtilization[displayName.toLowerCase()];
  if (own !== undefined) {
    pools.push({ label: `${displayName} pool`, value: own });
  }
  return pools.sort((left, right) => right.value - left.value);
};

/** Would launching this model right now spend the user's real money? The guard keys on money, not on a model's name. **With usage credits proven OFF, nothing can silently spend money.** A request that outruns the plan simply hits the plan limit and fails — the provider refuses, no charge occurs. So the guard does not fire at all in that state, whatever the pools say. A guard that nags a user who cannot be charged is a broken guard, and one he learns to click through is worse than none. With credits on, an exhausted pool means the next spawn is billed. That is the case to ask about. A spawn that begins with plan headroom can cross into credits mid-run, and no available surface predicts its eventual usage. Hive cannot ask in advance for that case without asking on every spawn. Absence from `model_scoped` is not billing evidence. The list holds models with an extra ceiling; models without one use the account-wide pool. */
export function spendRisk(
  billing: AccountBilling,
  displayName: string,
): SpendRisk {
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

  const pools = modelPools(billing, displayName);
  const exhausted = pools.find((pool) => pool.value >= 100);
  if (exhausted !== undefined) {
    return {
      state: "would-spend",
      detail:
        billing.creditsEnabled.state === "known"
          ? `the ${exhausted.label} is exhausted and usage credits are ON, so ` +
            "this spawn would be billed to credits — real money"
          : billing.overflowUncertainty == null
            ? `the ${exhausted.label} is exhausted and Hive cannot read whether ` +
              "usage credits are on, so it cannot rule out a charge"
            : `the ${exhausted.label} is exhausted. ${billing.overflowUncertainty}`,
    };
  }

  // Every model draws on the general pool. A healthy model-specific pool cannot prove plan headroom when that account-wide reading is absent.
  if (billing.generalUtilization.state !== "known") {
    return {
      state: "unknown",
      detail:
        "no plan-usage reading, so Hive cannot tell whether this spawn " +
        "would be billed to credits — and it will not spend your money on a " +
        "guess",
    };
  }
  const limiting = pools[0];
  return {
    state: "no-spend",
    detail: `the plan still covers this (${limiting?.label ?? "account plan pool"} ${limiting?.value ?? 0}% used)`,
  };
}

export type PoolAvailability =
  | { state: "available" }
  | { state: "exhausted"; detail: string };

/** Can this model run? This differs from whether it would cost anything. `spendRisk` answers the money question. An exhausted pool with credits off cannot charge, but the vendor also refuses it. Such a model is unavailable, not free. The rule keys on MONEY and METERING, never on a model's name: a model the vendor meters separately, whose own pool is spent, with nothing that can pay the overflow, cannot run. Any model, any vendor, no date, no list. When the pool has headroom it is available; when it is spent but credits could pay, it is not an availability question at all — it is a spend question, and `spendRisk` asks him. */
export function poolAvailability(
  billing: AccountBilling,
  displayName: string,
): PoolAvailability {
  const exhausted = modelPools(billing, displayName).find(
    (pool) => pool.value >= 100,
  );
  if (exhausted === undefined) return { state: "available" };

  // A spent pool is fatal only when paid overflow is proven unavailable.
  if (
    billing.creditsEnabled.state === "known" &&
    !billing.creditsEnabled.value
  ) {
    return {
      state: "exhausted",
      detail:
        `the ${exhausted.label} is spent (${exhausted.value}%) and usage credits ` +
        "are OFF, so nothing can pay for the overflow — the vendor refuses the " +
        "request rather than billing it. The model cannot run, so it is not a " +
        "candidate; a capable model that can run is chosen instead",
    };
  }
  return { state: "available" };
}
