import type { CapabilityProvider } from "../schemas/capability";
import type { QuotaConfig, QuotaLimit, QuotaScope } from "../schemas/quota";
import type { QuotaLedger } from "./quota-ledger";
import type { DiscoveredQuotaPool } from "./quota-ledger-records";
import type { ResolvedQuotaLimit } from "./quota-pool-status";

/**
 * Which pools meter a candidate.
 *
 * Discovery writes what the providers said and `quota.toml` writes what the
 * user said; this folds the two into the pool list everything else reads.
 * It answers "which meters govern this model", never "may it spawn" — the
 * numbers belong to quota-pool-status.ts and the decision to quota.ts.
 */

/** Enough of a launch to find its meters. Structurally what `AuthorizedLaunch` already carries, so an authorized candidate is one of these without conversion — and pool resolution stays clear of the launch-authorization module. */
export interface QuotaCandidateIdentity {
  tool: CapabilityProvider;
  model: string;
  effort?: string;
}

export function scopeKey(scope: QuotaScope): string {
  return `${scope.provider}\0${scope.account}\0${scope.pool}`;
}

export function sameScope(left: QuotaLimit, right: QuotaLimit): boolean {
  return (
    left.provider === right.provider &&
    left.account === right.account &&
    left.pool === right.pool
  );
}

const discoveredMaxAgeMinutes = (config: QuotaConfig): number =>
  Math.max(2 * config.refreshIntervalMinutes, 30);

/** Join a discovered pool to the models it meters, using the provider's own model catalog. A quota payload names its sub-pools the way the vendor's model catalog names its models — `"Fable"`, `"GPT-5.3-Codex-Spark"` — but carries no model id (Claude reports `scope.model.id: null` beside the display name). The catalog carries both, so the binding is discovered by matching the pool's own label against the provider's own display names. Nothing is hardcoded and nothing is guessed: a pool whose label matches no model in the catalog binds to nothing, stays unroutable, and says so — which is the honest state for a pool whose subject Hive cannot identify. A pool the provider already scoped to every model keeps its wildcard. */
function poolBinder(
  ledger: QuotaLedger,
): (pool: DiscoveredQuotaPool) => string[] {
  const byDisplayName = new Map<string, Set<string>>();
  for (const entry of ledger.modelCatalog()) {
    const key = `${entry.provider}\0${entry.displayName.toLowerCase()}`;
    const models = byDisplayName.get(key) ?? new Set<string>();
    models.add(entry.modelId);
    byDisplayName.set(key, models);
  }
  return (pool) => {
    if (pool.models.includes("*")) return ["*"];
    if (pool.label === null) return [];
    const key = `${pool.provider}\0${pool.label.toLowerCase()}`;
    return [...(byDisplayName.get(key) ?? [])].sort();
  };
}

/** Every pool Hive knows about: the user's explicit overrides first, then everything the providers told us about themselves. A manual pool that shares a discovered pool's scope replaces it outright and says so, which is the only form `quota.toml` still takes — Hive never requires one to route. */
export function resolvedLimits(
  ledger: QuotaLedger,
  config: QuotaConfig,
): ResolvedQuotaLimit[] {
  const manualScopes = new Set(config.limits.map(scopeKey));
  const manual = config.limits.map(
    (limit): ResolvedQuotaLimit => ({
      ...limit,
      origin: "manual",
      unit: "units",
      routable: limit.models.length > 0,
      label: null,
      overridesDiscovered: false,
      fiveHourWindowMinutes: 5 * 60,
      weeklyWindowMinutes: 7 * 24 * 60,
      fiveHourMeterState: "metered",
      weeklyMeterState: "metered",
    }),
  );
  const discovered: ResolvedQuotaLimit[] = [];
  const bind = poolBinder(ledger);
  for (const pool of ledger.discoveredPools()) {
    if (manualScopes.has(scopeKey(pool))) {
      const override = manual.find(
        (limit) => scopeKey(limit) === scopeKey(pool),
      );
      if (override !== undefined) {
        override.overridesDiscovered = true;
        override.label = pool.label;
      }
      continue;
    }
    const models = bind(pool);
    discovered.push({
      provider: pool.provider,
      account: pool.account,
      pool: pool.pool,
      models,
      // A provider reports the fraction of a window it has consumed, never the window's size. Percent is therefore the pool's native currency and 100 is its allowance by construction, not by assumption.
      fiveHourAllowance: 100,
      weeklyAllowance: 100,
      weeklyWindow: "rolling",
      timezone: "UTC",
      resetWeekday: 1,
      resetHour: 0,
      resetMinute: 0,
      observationMaxAgeMinutes: discoveredMaxAgeMinutes(config),
      origin: "discovered",
      unit: "percent",
      routable: models.length > 0,
      label: pool.label,
      overridesDiscovered: false,
      fiveHourWindowMinutes: pool.fiveHourWindowMinutes,
      weeklyWindowMinutes: pool.weeklyWindowMinutes,
      fiveHourMeterState: pool.fiveHourMeterState,
      weeklyMeterState: pool.weeklyMeterState,
    });
  }
  return [...manual, ...discovered];
}

/** Every pool that meters this model — not the first one that matches. A model with its own cap spends from two meters at once: the account-wide pool everything draws on, and its own. Returning just one of them is what let a Fable spawn be checked against the general pool's 61% while Fable's own pool sat at 99% and never entered the decision. Both govern; the tighter one decides. A model with no cap of its own is metered by the general pool alone, which is the ordinary case and is not a gap in coverage. */
export function limitsFor(
  ledger: QuotaLedger,
  config: QuotaConfig,
  candidate: QuotaCandidateIdentity,
): ResolvedQuotaLimit[] {
  const routable = resolvedLimits(ledger, config).filter(
    (limit) => limit.routable && limit.provider === candidate.tool,
  );
  const general = routable.filter((limit) => limit.models.includes("*"));
  const specific = routable.filter(
    (limit) =>
      !limit.models.includes("*") && limit.models.includes(candidate.model),
  );
  return [...general, ...specific];
}

export function limitFor(
  ledger: QuotaLedger,
  config: QuotaConfig,
  candidate: QuotaCandidateIdentity,
): ResolvedQuotaLimit | null {
  const limits = limitsFor(ledger, config, candidate);
  return limits.at(-1) ?? null;
}

export function generalLimit(
  ledger: QuotaLedger,
  config: QuotaConfig,
  provider: CapabilityProvider,
): ResolvedQuotaLimit | null {
  return (
    resolvedLimits(ledger, config).find(
      (limit) =>
        limit.routable &&
        limit.provider === provider &&
        limit.models.includes("*"),
    ) ?? null
  );
}
