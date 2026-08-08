import {
  type CapabilitySurface,
  known,
  unknown,
} from "../../schemas/capability";
import type { DiscoveredPoolReading } from "../quota-sources";
import type { AccountBilling } from "./usage-credit-types";

const poolPercent = (pool: DiscoveredPoolReading): number | null => {
  const values = [pool.fiveHour?.usedPct, pool.weekly?.usedPct].filter(
    (value): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100,
  );
  return values.length === 0 ? null : Math.max(...values);
};

export function utilizationFromPools(
  pools: readonly DiscoveredPoolReading[],
  surface: CapabilitySurface,
  observedAt: string,
): Pick<AccountBilling, "generalUtilization" | "modelUtilization"> {
  const general = pools
    .filter((pool) => pool.models.includes("*"))
    .map(poolPercent)
    .filter((value): value is number => value !== null);
  const modelUtilization: Record<string, number> = {};

  for (const pool of pools) {
    if (pool.models.includes("*") || pool.label === null) continue;
    const percent = poolPercent(pool);
    if (percent === null) continue;
    const name = pool.label.toLowerCase();
    modelUtilization[name] = Math.max(modelUtilization[name] ?? 0, percent);
  }

  return {
    generalUtilization:
      general.length === 0
        ? unknown("field-absent", surface, observedAt)
        : known(Math.max(...general), surface, observedAt),
    modelUtilization,
  };
}
