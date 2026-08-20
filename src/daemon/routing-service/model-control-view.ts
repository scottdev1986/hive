import type {
  CapabilityDiscoveryResult,
  CapabilityProvider,
  CapabilityRecord,
  Discovered,
} from "../../schemas/capability";
import type {
  QuotaPoolStatus,
  QuotaStatus,
  QuotaWindowStatus,
} from "../../schemas/quota";
import {
  type CandidateEffort,
  DEFAULT_ROUTER_MODE,
  modelPolicyState,
  providerPolicyState,
  ROUTE_DEFAULT_WEIGHT,
  ROUTE_WEIGHT_MAX,
  ROUTE_WEIGHT_MIN,
  ROUTING_CATEGORY_CATALOG,
  ROUTING_MODE_CATALOG,
  routeShares,
  type RoutingPolicy,
} from "../../schemas/routing-policy";
import type {
  TokenCounts,
  TokenUsageSession,
  TokenUsageSubject,
} from "../../schemas/token-usage-schema";
import type { AccountBilling } from "../../usage-service/usage-credits/usage-credit-types";
import type { ModelControlSnapshot } from "./model-control-snapshot";

export type WorkspaceMeterState =
  | {
      state: "measured";
      usedPercent: number;
      resetsAt: string | null;
      observedAt: string | null;
      confidence: string;
    }
  | {
      state: "stale";
      usedPercent: number;
      resetsAt: string | null;
      observedAt: string | null;
    }
  | { state: "unknown"; reason: string }
  | { state: "not-metered" };

export type WorkspaceProviderUsage =
  | {
      state: "metered";
      windows: ReadonlyArray<{ label: string; meter: WorkspaceMeterState }>;
    }
  | { state: "silent"; reason: string }
  | { state: "unmetered" }
  | { state: "unknown"; reason: string };

export type WorkspaceEffortAxis =
  | { state: "known"; levels: string[]; defaultLevel: string | null }
  | { state: "none" }
  | { state: "unknown"; reason: string };

export interface WorkspaceModelPresentation {
  canonicalId: string;
  variant: string | null;
  displayId: string;
  name: string;
  effortAxis: WorkspaceEffortAxis;
  poolExhausted: boolean;
}

export interface WorkspaceProviderPresentation {
  catalogState: "available" | "unavailable";
  catalogReason: string | null;
  planLabel: string | null;
  billingChip: "paid-overflow-off" | "credits-available" | "unknown";
  spendCaveat: string | null;
  usage: WorkspaceProviderUsage;
  models: WorkspaceModelPresentation[];
}

export interface WorkspaceRoutingModelState {
  provider: string;
  model: string;
  state: "enabled" | "disabled" | "unconfigured";
  source: "provider" | "model" | "none";
  rowState:
    | "enabled"
    | "seeded-off"
    | "disabled-by-self"
    | "disabled-by-provider"
    | "unavailable";
  preferenceOn: boolean;
}

export interface WorkspaceRoutingCandidateState {
  scope: string;
  provider: string;
  model: string;
  status:
    | "effective"
    | "provider-off"
    | "model-disabled"
    | "awaiting-consent"
    | "unresolvable";
  /** Configured share of this scope's spawns, 0–1, from `routeShares`. Published so the Task Router renders the daemon's arithmetic instead of its own. */
  configuredShare: number;
}

export interface WorkspaceRoutingCatalogEntry {
  provider: string;
  model: string;
  effortOptions: WorkspaceRoutingEffortOption[];
  addEffortOptions: WorkspaceRoutingEffortOption[];
  startingEffort: CandidateEffort;
}

export interface WorkspaceRoutingEffortOption {
  argument: string;
  label: string;
  effort: CandidateEffort;
}

export interface WorkspaceRoutingModePresentation {
  id: string;
  label: string;
  caption: string;
  weightEditable: boolean;
}

export interface WorkspaceRoutingPresentation {
  policy: RoutingPolicy;
  categories: typeof ROUTING_CATEGORY_CATALOG;
  modes: WorkspaceRoutingModePresentation[];
  defaultMode: string;
  weightRange: { minimum: number; maximum: number; defaultValue: number };
  catalog: WorkspaceRoutingCatalogEntry[];
  providers: Record<string, { state: "enabled" | "disabled" | "unconfigured" }>;
  models: WorkspaceRoutingModelState[];
  candidates: WorkspaceRoutingCandidateState[];
  warnings: Array<"no-providers-enabled" | "no-global-route">;
}

export interface WorkspaceTokenHeadline {
  newInputTokens: number | null;
  freshInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number;
  newTokens: number | null;
  cumulativeInputTokens: number;
  cumulativeTotalTokens: number;
}

export interface WorkspaceTokenUsageRow {
  name: string;
  provider: string;
  model: string | null;
  counts: TokenCounts | null;
  headline: WorkspaceTokenHeadline | null;
  unknownReason: string | null;
}

export interface WorkspaceTokenSessionPresentation {
  sessionId: string;
  fleet: WorkspaceTokenHeadline | null;
  hiveControl: WorkspaceTokenHeadline | null;
  workerSessions: WorkspaceTokenHeadline | null;
  rows: WorkspaceTokenUsageRow[];
  controlSharePercent: number | null;
}

/** The Workspace endpoint's complete read model. Raw facts stay available for
 * evidence/details, while every semantic choice the UI renders is named here
 * by the daemon that owns those facts. */
export interface WorkspaceModelControlView {
  schemaVersion: 1;
  observedAt: string;
  snapshot: ModelControlSnapshot;
  routing: WorkspaceRoutingPresentation;
  providers: Record<string, WorkspaceProviderPresentation>;
  tokenSessions: WorkspaceTokenSessionPresentation[];
}

const discoveredValue = <T>(fact: Discovered<T>): T | null =>
  fact.state === "known" ? fact.value : null;

function meterState(window: QuotaWindowStatus): WorkspaceMeterState {
  if (window.availability === "not-metered") return { state: "not-metered" };
  if (window.unit !== "percent") {
    return {
      state: "unknown",
      reason: "manual-unit pool — not a discovered percent meter",
    };
  }
  const used =
    window.used ??
    (window.remainingPct !== null && window.allowance !== null
      ? Math.max(0, Math.min(100, 100 - window.remainingPct * 100))
      : null);
  if (used === null) {
    return { state: "unknown", reason: "no reading for this window" };
  }
  if (window.confidence === "stale") {
    return {
      state: "stale",
      usedPercent: used,
      resetsAt: window.resetsAt,
      observedAt: window.observedAt,
    };
  }
  return {
    state: "measured",
    usedPercent: used,
    resetsAt: window.resetsAt,
    observedAt: window.observedAt,
    confidence: window.confidence,
  };
}

function discoveredPools(
  provider: string,
  quota: QuotaStatus[],
): QuotaPoolStatus[] {
  return quota.filter(
    (entry): entry is QuotaPoolStatus =>
      "pool" in entry &&
      entry.provider === provider &&
      entry.origin === "discovered",
  );
}

function providerUsage(
  provider: string,
  surface: "metered" | "none" | undefined,
  quota: QuotaStatus[] | null,
  quotaError: string | null,
): WorkspaceProviderUsage {
  if (surface === "none") return { state: "unmetered" };
  if (surface !== "metered") {
    return { state: "unknown", reason: "unsupported or absent usage surface" };
  }
  if (quota === null) {
    return {
      state: "unknown",
      reason: quotaError ?? "the Hive daemon could not be reached",
    };
  }
  const pools = discoveredPools(provider, quota);
  const pool = pools.find((entry) => entry.models.includes("*")) ?? pools[0];
  if (pool !== undefined) {
    return {
      state: "metered",
      windows: [
        { label: "5 hour window", meter: meterState(pool.fiveHour) },
        { label: "7 day window", meter: meterState(pool.weekly) },
      ],
    };
  }
  const unconfigured = quota.find(
    (entry) => !("pool" in entry) && entry.provider === provider,
  );
  if (unconfigured !== undefined && !("pool" in unconfigured)) {
    return {
      state: "silent",
      reason: unconfigured.probeError ?? unconfigured.reason,
    };
  }
  return { state: "silent", reason: `${provider} reported no usage data` };
}

function effortAxis(model: CapabilityRecord): WorkspaceEffortAxis {
  if (model.supportsEffort.state === "known" && !model.supportsEffort.value) {
    return { state: "none" };
  }
  if (model.supportedEffortLevels.state === "known") {
    if (model.supportedEffortLevels.value.length === 0) {
      return { state: "unknown", reason: "vendor listed no effort levels" };
    }
    return {
      state: "known",
      levels: model.supportedEffortLevels.value,
      defaultLevel: discoveredValue(model.defaultEffort),
    };
  }
  return {
    state: "unknown",
    reason:
      (model.supportedEffortLevels.state === "unknown"
        ? model.supportedEffortLevels.reason
        : null) ??
      (model.supportsEffort.state === "unknown"
        ? model.supportsEffort.reason
        : null) ??
      "unspecified",
  };
}

function displayName(model: CapabilityRecord): string {
  if (
    model.displayName !== null &&
    !model.displayName.toLowerCase().includes("default") &&
    !model.displayName.toLowerCase().includes("recommended")
  ) {
    return model.displayName;
  }
  let id = model.canonicalId;
  const prefix = `${model.provider.toLowerCase()}-`;
  if (id.toLowerCase().startsWith(prefix)) id = id.slice(prefix.length);
  const words: string[] = [];
  for (const token of id.split("-")) {
    const numeric = /^[0-9.]+$/.test(token);
    const previous = words.at(-1);
    if (numeric && previous !== undefined && /^[0-9.]+$/.test(previous)) {
      words[words.length - 1] = `${previous}.${token}`;
    } else if (numeric) {
      words.push(token);
    } else if (token !== "") {
      words.push(token.slice(0, 1).toUpperCase() + token.slice(1));
    }
  }
  return words.length === 0 ? model.canonicalId : words.join(" ");
}

function modelPoolExhausted(
  provider: string,
  canonicalId: string,
  quota: QuotaStatus[] | null,
): boolean {
  if (quota === null) return false;
  return discoveredPools(provider, quota)
    .filter(
      (pool) => !pool.models.includes("*") && pool.models.includes(canonicalId),
    )
    .some((pool) =>
      [pool.fiveHour, pool.weekly].some(
        (window) =>
          window.unit === "percent" &&
          window.used !== null &&
          window.confidence !== "stale" &&
          window.used >= (window.allowance ?? 100),
      ),
    );
}

function planLabel(
  provider: string,
  quota: QuotaStatus[] | null,
): string | null {
  if (quota === null) return null;
  return (
    discoveredPools(provider, quota).find((pool) => pool.models.includes("*"))
      ?.label ?? null
  );
}

function billingPresentation(
  billing: AccountBilling | null,
): Pick<WorkspaceProviderPresentation, "billingChip" | "spendCaveat"> {
  if (billing === null) {
    return {
      billingChip: "unknown",
      spendCaveat: "Hive cannot read this vendor's billing",
    };
  }
  if (billing.creditsEnabled.state === "known") {
    return billing.creditsEnabled.value
      ? {
          billingChip: "credits-available",
          spendCaveat: "usage credits are enabled on this account",
        }
      : { billingChip: "paid-overflow-off", spendCaveat: null };
  }
  return {
    billingChip: "unknown",
    spendCaveat:
      billing.overflowUncertainty ??
      "the vendor's paid-overflow switch is unreadable",
  };
}

function catalogRecords(
  discovery: CapabilityDiscoveryResult | undefined,
): CapabilityRecord[] {
  return discovery?.status === "ok" ? discovery.records : [];
}

function modelAvailable(model: CapabilityRecord): boolean {
  return (
    discoveredValue(model.entitled) !== false &&
    discoveredValue(model.hidden) !== true
  );
}

function headline(counts: TokenCounts | null): WorkspaceTokenHeadline | null {
  if (counts === null) return null;
  const opaque: WorkspaceTokenHeadline = {
    newInputTokens: null,
    freshInputTokens: null,
    cacheReadTokens: counts.cachedInputTokens,
    cacheWriteTokens: counts.cacheCreationInputTokens,
    outputTokens: counts.outputTokens,
    newTokens: null,
    cumulativeInputTokens: counts.inputTokens,
    cumulativeTotalTokens: counts.totalTokens,
  };
  if (counts.cachedInputTokens === null) return opaque;
  const newInputTokens = counts.inputTokens - counts.cachedInputTokens;
  if (newInputTokens < 0) return opaque;
  const freshInputTokens =
    counts.cacheCreationInputTokens === null
      ? null
      : newInputTokens - counts.cacheCreationInputTokens;
  return {
    ...opaque,
    newInputTokens,
    freshInputTokens:
      freshInputTokens !== null && freshInputTokens >= 0
        ? freshInputTokens
        : null,
    newTokens: newInputTokens + counts.outputTokens,
  };
}

function individualTokenRow(
  subject: TokenUsageSubject,
): WorkspaceTokenUsageRow {
  if (subject.reading.state === "measured") {
    return {
      name: subject.name,
      provider: subject.provider,
      model: subject.model,
      counts: subject.reading.counts,
      headline: headline(subject.reading.counts),
      unknownReason: null,
    };
  }
  return {
    name: subject.name,
    provider: subject.provider,
    model: subject.model,
    counts: null,
    headline: null,
    unknownReason: subject.reading.reason,
  };
}

function tokenRows(session: TokenUsageSession): WorkspaceTokenUsageRow[] {
  const orchestrators = session.subjects.filter(
    (subject) => subject.role === "orchestrator",
  );
  const rows: WorkspaceTokenUsageRow[] = [];
  const current = orchestrators
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1);
  if (current !== undefined) {
    const counts = session.hiveControl.counts;
    const unknownReason = orchestrators.find(
      (subject) => subject.reading.state === "unknown",
    );
    rows.push({
      name: "Queen",
      provider: current.provider,
      model: current.model,
      counts,
      headline: headline(counts),
      unknownReason:
        counts === null
          ? unknownReason?.reading.state === "unknown"
            ? unknownReason.reading.reason
            : "No provider token reading has been observed"
          : null,
    });
  }
  return [
    ...rows,
    ...session.subjects
      .filter((subject) => subject.role !== "orchestrator")
      .map(individualTokenRow),
  ];
}

function tokenSession(
  session: TokenUsageSession,
): WorkspaceTokenSessionPresentation {
  const fleet = headline(session.fleet.counts);
  const hiveControl = headline(session.hiveControl.counts);
  const numerator =
    hiveControl?.newTokens ?? session.hiveControl.counts?.totalTokens;
  const denominator = fleet?.newTokens ?? session.fleet.counts?.totalTokens;
  return {
    sessionId: session.id,
    fleet,
    hiveControl,
    workerSessions: headline(session.workerSessions.counts),
    rows: tokenRows(session),
    controlSharePercent:
      numerator !== undefined && denominator !== undefined && denominator > 0
        ? (numerator / denominator) * 100
        : null,
  };
}

function candidateEffortArgument(effort: CandidateEffort): string {
  return effort.mode === "exact" ? `exact:${effort.value}` : effort.mode;
}

function effortOption(
  effort: CandidateEffort,
  label: string,
): WorkspaceRoutingEffortOption {
  return { argument: candidateEffortArgument(effort), label, effort };
}

function startingCandidateEffort(
  policy: RoutingPolicy,
  provider: string,
  model: string,
): CandidateEffort {
  const effort = policy.models.find(
    (row) => row.provider === provider && row.model === model,
  )?.effort;
  switch (effort?.mode) {
    case "exact":
      return { mode: "exact", value: effort.value };
    case "none":
      return { mode: "none" };
    case "provider-controlled":
      return { mode: "provider-controlled" };
    case "hive-decides":
      return { mode: "hive-decides" };
    default:
      return { mode: "hive-decides" };
  }
}

function routingPresentation(
  snapshot: ModelControlSnapshot,
  policy: RoutingPolicy,
): WorkspaceRoutingPresentation {
  const providerIds = Object.keys(snapshot.providers);
  const availableCatalog = new Set<string>();
  const routingCatalog = new Map<
    string,
    {
      provider: string;
      model: string;
      effortLevels: Set<string>;
      defaultEffortLevels: Set<string>;
      supportsNoEffort: boolean;
    }
  >();
  const observedModels = new Set<string>();
  for (const [provider, discovery] of Object.entries(snapshot.providers)) {
    for (const model of catalogRecords(discovery)) {
      const key = `${provider}\0${model.canonicalId}`;
      observedModels.add(key);
      if (modelAvailable(model)) {
        availableCatalog.add(key);
        const entry = routingCatalog.get(key) ?? {
          provider,
          model: model.canonicalId,
          effortLevels: new Set<string>(),
          defaultEffortLevels: new Set<string>(),
          supportsNoEffort: false,
        };
        const axis = effortAxis(model);
        if (axis.state === "known") {
          for (const level of axis.levels) entry.effortLevels.add(level);
          if (axis.defaultLevel !== null) {
            entry.defaultEffortLevels.add(axis.defaultLevel);
          }
        } else if (axis.state === "none") {
          entry.supportsNoEffort = true;
        }
        routingCatalog.set(key, entry);
      }
    }
  }
  for (const row of policy.models) {
    if (row.effort.mode === "exact") {
      routingCatalog
        .get(`${row.provider}\0${row.model}`)
        ?.effortLevels.add(row.effort.value);
    }
  }
  for (const route of [policy.global, ...Object.values(policy.categories)]) {
    for (const candidate of route?.candidates ?? []) {
      if (candidate.effort.mode === "exact") {
        routingCatalog
          .get(`${candidate.provider}\0${candidate.model}`)
          ?.effortLevels.add(candidate.effort.value);
      }
    }
  }
  const modelKeys = new Set(observedModels);
  for (const row of policy.models)
    modelKeys.add(`${row.provider}\0${row.model}`);
  for (const route of [policy.global, ...Object.values(policy.categories)]) {
    for (const candidate of route?.candidates ?? []) {
      modelKeys.add(`${candidate.provider}\0${candidate.model}`);
    }
  }
  const models = [...modelKeys]
    .sort()
    .map((key): WorkspaceRoutingModelState => {
      const [provider = "", model = ""] = key.split("\0");
      const reading = modelPolicyState(
        policy,
        provider as CapabilityProvider,
        model,
      );
      const available = availableCatalog.has(key);
      const own = policy.models.find(
        (row) => row.provider === provider && row.model === model,
      );
      const rowState: WorkspaceRoutingModelState["rowState"] = !available
        ? "unavailable"
        : reading.state === "enabled"
          ? "enabled"
          : reading.state === "unconfigured"
            ? "seeded-off"
            : reading.source === "provider"
              ? "disabled-by-provider"
              : "disabled-by-self";
      return {
        provider,
        model,
        state: reading.state,
        source: reading.source,
        rowState,
        preferenceOn: own?.state === "enabled",
      };
    });
  const modelByKey = new Map(
    models.map((model) => [`${model.provider}\0${model.model}`, model]),
  );
  const candidates: WorkspaceRoutingCandidateState[] = [];
  for (const [scope, route] of [
    ["global", policy.global] as const,
    ...Object.entries(policy.categories),
  ]) {
    const shares = route === null || route === undefined ? [] : routeShares(route);
    for (const candidate of route?.candidates ?? []) {
      const share =
        shares.find(
          (entry) =>
            entry.candidate.provider === candidate.provider &&
            entry.candidate.model === candidate.model,
        )?.share ?? 0;
      const model = modelByKey.get(`${candidate.provider}\0${candidate.model}`);
      const status: WorkspaceRoutingCandidateState["status"] =
        model === undefined || model.rowState === "unavailable"
          ? "unresolvable"
          : model.rowState === "enabled"
            ? "effective"
            : model.rowState === "disabled-by-provider"
              ? "provider-off"
              : model.rowState === "disabled-by-self"
                ? "model-disabled"
                : "awaiting-consent";
      candidates.push({
        scope,
        provider: candidate.provider,
        model: candidate.model,
        status,
        configuredShare: share,
      });
    }
  }
  const warnings: WorkspaceRoutingPresentation["warnings"] = [];
  if (
    providerIds.length > 0 &&
    providerIds.every(
      (provider) =>
        providerPolicyState(policy, provider as CapabilityProvider) !==
        "enabled",
    )
  ) {
    warnings.push("no-providers-enabled");
  }
  if (policy.global === null) warnings.push("no-global-route");
  return {
    policy,
    categories: ROUTING_CATEGORY_CATALOG,
    modes: ROUTING_MODE_CATALOG.map((mode) => ({ ...mode })),
    defaultMode: DEFAULT_ROUTER_MODE,
    weightRange: {
      minimum: ROUTE_WEIGHT_MIN,
      maximum: ROUTE_WEIGHT_MAX,
      defaultValue: ROUTE_DEFAULT_WEIGHT,
    },
    catalog: [...routingCatalog.values()]
      .map((entry) => {
        const exactOptions = [...entry.effortLevels]
          .sort()
          .map((level) =>
            effortOption(
              { mode: "exact", value: level },
              entry.defaultEffortLevels.has(level)
                ? `${level} (vendor recommends)`
                : level,
            ),
          );
        const noneOption = effortOption({ mode: "none" }, "No effort setting");
        return {
          provider: entry.provider,
          model: entry.model,
          effortOptions: [
            effortOption({ mode: "hive-decides" }, "Hive decides"),
            noneOption,
            effortOption(
              { mode: "provider-controlled" },
              "Provider controlled",
            ),
            ...exactOptions,
          ],
          addEffortOptions:
            exactOptions.length > 0
              ? exactOptions
              : entry.supportsNoEffort
                ? [noneOption]
                : [
                    effortOption(
                      { mode: "provider-controlled" },
                      "Provider controlled",
                    ),
                  ],
          startingEffort: startingCandidateEffort(
            policy,
            entry.provider,
            entry.model,
          ),
        };
      })
      .sort((left, right) =>
        `${left.provider}\0${left.model}`.localeCompare(
          `${right.provider}\0${right.model}`,
        ),
      ),
    providers: Object.fromEntries(
      providerIds.map((provider) => [
        provider,
        {
          state: providerPolicyState(policy, provider as CapabilityProvider),
        },
      ]),
    ),
    models,
    candidates,
    warnings,
  };
}

export function buildWorkspaceModelControlView(
  snapshot: ModelControlSnapshot,
  policy: RoutingPolicy,
): WorkspaceModelControlView {
  const providers = Object.fromEntries(
    Object.entries(snapshot.providers).map(([provider, discovery]) => {
      const billing = snapshot.billing[provider as CapabilityProvider] ?? null;
      const billingView = billingPresentation(billing);
      return [
        provider,
        {
          catalogState: discovery.status === "ok" ? "available" : "unavailable",
          catalogReason:
            discovery.status === "unavailable" ? discovery.reason : null,
          planLabel: planLabel(provider, snapshot.quota),
          ...billingView,
          usage: providerUsage(
            provider,
            snapshot.usageSurfaces[provider as CapabilityProvider],
            snapshot.quota,
            snapshot.quotaError,
          ),
          models: catalogRecords(discovery).map((model) => ({
            canonicalId: model.canonicalId,
            variant: model.variant,
            displayId:
              model.variant === null
                ? model.canonicalId
                : `${model.canonicalId}[${model.variant}]`,
            name: displayName(model),
            effortAxis: effortAxis(model),
            poolExhausted: modelPoolExhausted(
              provider,
              model.canonicalId,
              snapshot.quota,
            ),
          })),
        } satisfies WorkspaceProviderPresentation,
      ];
    }),
  );
  return {
    schemaVersion: 1,
    observedAt: snapshot.generatedAt,
    snapshot,
    routing: routingPresentation(snapshot, policy),
    providers,
    tokenSessions: snapshot.tokenUsage?.sessions.map(tokenSession) ?? [],
  };
}
