import {
  type AuthorizedLaunch,
  requireAuthorizedLaunch,
} from "../daemon/routing-service/authorized-launch";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  type CapabilityRecord,
} from "../schemas/capability";
import {
  DEFAULT_PERCENT_ESTIMATES,
  type QuotaConfig,
  type QuotaObservation,
  type QuotaObservationInput,
  QuotaObservationSchema,
  type QuotaPoolStatus,
  type QuotaScope,
  type QuotaStatus,
} from "../schemas/quota";
import type { RoutingCategory } from "../schemas/routing-policy";
import { systemClock } from "../shared/clock";
import type { QuotaLedger } from "./quota-ledger";
import type {
  DiscoveredQuotaPool,
  QuotaReservation,
  ReserveQuotaInput,
} from "./quota-ledger-records";
import {
  type DrainedWindow,
  drainedWindowFor,
  gapStatus,
  measured,
  type ResolvedQuotaLimit,
  statusForLimit,
  unconfiguredTotals,
} from "./quota-pool-status";
import {
  generalLimit,
  limitsFor,
  type QuotaCandidateIdentity,
  resolvedLimits,
  sameScope,
  scopeKey,
} from "./quota-pools";
import type {
  DiscoveredPoolReading,
  QuotaProbe,
  QuotaProbeResult,
} from "./quota-sources";
import { add, instantMs, iso } from "./quota-windows";
import { accountBillingFromUsage } from "./usage-credits/claude";
import { accountBillingFromCodexRateLimits } from "./usage-credits/codex";
import { accountBillingFromGrokBilling } from "./usage-credits/grok";
import { accountBillingFromKimiUsage } from "./usage-credits/kimi";
import { rememberBilling } from "./usage-credits/usage-credit-memory";

export interface ControlQuotaRequest extends QuotaCandidateIdentity {
  agentName: string;
  category: RoutingCategory;
  controlMessageId: string;
}

export type QuotaAlertSink = (body: string) => Promise<void>;
export type QuotaClock = () => Date;

export interface QuotaRefreshReport {
  provider: CapabilityProvider;
  status: "ok" | "unavailable" | "skipped" | "rate-limited";
  pools: number;
  reason?: string;
  observedAt?: string | null;
  startedAt?: string;
  completedAt?: string;
  retryAt?: string;
  delivery?: "started" | "queued" | "coalesced" | "rate-limited";
}

const OPERATOR_PROBE_MIN_INTERVAL_MS = 5_000;
const UNCONFIGURED_ESTIMATE_UNITS = 10;

interface CompletedProbe {
  status: "probed";
  result: QuotaProbeResult;
  startedAt: string;
  completedAt: string;
}

interface RateLimitedProbe {
  status: "rate-limited";
  completedAt: string;
  retryAt: string;
}

type ProbeAttempt = CompletedProbe | RateLimitedProbe;

interface ActiveProbe {
  startedAtMs: number;
  completion: Promise<CompletedProbe>;
}

interface QueuedProbe {
  attempt: Promise<ProbeAttempt>;
}

/** The pool a probe reading describes. A window the reading did not carry leaves its meter state `unknown` rather than claiming the provider does not meter it: absent and not-metered are different facts, and only the provider can state the second one. */
function discoveredPoolFrom(
  reading: DiscoveredPoolReading,
): DiscoveredQuotaPool {
  return {
    provider: reading.provider,
    account: reading.account,
    pool: reading.pool,
    models: reading.models,
    label: reading.label,
    fiveHourWindowMinutes: reading.fiveHour?.windowMinutes ?? null,
    weeklyWindowMinutes: reading.weekly?.windowMinutes ?? null,
    fiveHourMeterState:
      reading.fiveHourMeterState ??
      (reading.fiveHour === null ? "unknown" : "metered"),
    weeklyMeterState:
      reading.weeklyMeterState ??
      (reading.weekly === null ? "unknown" : "metered"),
    discoveredAt: reading.observedAt,
    source: reading.source,
  };
}

export class QuotaService {
  private alertSink: QuotaAlertSink | null = null;
  private readonly probes: QuotaProbe[];
  private readonly probeReads = new Map<CapabilityProvider, ActiveProbe>();
  private readonly queuedOperatorProbeReads = new Map<
    CapabilityProvider,
    QueuedProbe
  >();
  private readonly lastOperatorProbeStartedAt = new Map<
    CapabilityProvider,
    number
  >();
  private readonly probeErrors = new Map<CapabilityProvider, string>();
  private lastRefreshAt: Date | null = null;

  constructor(
    readonly ledger: QuotaLedger,
    readonly config: QuotaConfig,
    private readonly clock: QuotaClock = systemClock,
    probes: QuotaProbe[] = [],
  ) {
    this.probes = probes;
    for (const [index, left] of config.limits.entries()) {
      for (const right of config.limits.slice(index + 1)) {
        if (!sameScope(left, right)) continue;
        const comparable = [
          "fiveHourAllowance",
          "weeklyAllowance",
          "weeklyWindow",
          "timezone",
          "resetWeekday",
          "resetHour",
          "resetMinute",
          "observationMaxAgeMinutes",
        ] as const;
        if (comparable.some((field) => left[field] !== right[field])) {
          throw new Error(
            `Quota pool ${left.provider}/${left.account}/${left.pool} has inconsistent limits`,
          );
        }
      }
    }
  }

  setAlertSink(sink: QuotaAlertSink): void {
    this.alertSink = sink;
  }

  replaceCapabilityCatalog(
    provider: CapabilityProvider,
    records: readonly CapabilityRecord[],
  ): void {
    this.ledger.replaceModelCatalog(
      provider,
      records.flatMap((record) => {
        const variantId =
          record.variant === null
            ? null
            : `${record.canonicalId}[${record.variant}]`;
        const modelIds = [
          ...new Set(
            [
              record.canonicalId,
              record.launchToken,
              variantId,
              ...record.aliases,
            ].filter((id): id is string => id !== null && id.length > 0),
          ),
        ];
        const displayNames = [
          ...new Set(
            [
              record.displayName,
              record.canonicalId,
              record.launchToken,
              ...record.aliases,
            ].filter(
              (name): name is string => name !== null && name.length > 0,
            ),
          ),
        ];
        return modelIds.flatMap((modelId) =>
          displayNames.map((displayName) => ({
            provider,
            modelId,
            displayName,
            discoveredAt: record.observedAt,
          })),
        );
      }),
    );
  }

  /** Persist readings a provider already handed us — probe results or a later snapshot. One-window plans store the window they have. */
  applyDiscoveredReadings(readings: readonly DiscoveredPoolReading[]): void {
    for (const reading of readings) {
      this.ledger.upsertDiscoveredPool(discoveredPoolFrom(reading));
      this.recordDiscoveredReading(reading);
    }
  }

  poolsGoverning(
    candidate: QuotaCandidateIdentity,
    now = this.clock(),
  ): QuotaPoolStatus[] {
    return limitsFor(this.ledger, this.config, candidate).map((limit) =>
      statusForLimit(this.ledger, limit, now),
    );
  }

  /** §07: is any pool metering this model spent, and when does the drained window reset? The drain handler's one per-agent read. */
  drainFor(
    candidate: QuotaCandidateIdentity,
    now = this.clock(),
  ): DrainedWindow | null {
    return drainedWindowFor(this.poolsGoverning(candidate, now));
  }

  /** Whether this provider has a usage surface at all (a probe). opencode does not: its drain is only knowable through vendor errors. A metered provider whose pool has not been read yet is UNKNOWN, not unmetered — and unknown stays a spawnable wildcard (§10), never a drain. */
  isMetered(provider: CapabilityProvider): boolean {
    return this.probes.some((probe) => probe.provider === provider);
  }

  /** §07: every metered provider's general pool is spent. Unmetered routes are not knowable here — the drain handler joins its own error record. */
  allMeteredDrained(now = this.clock()): boolean {
    const providers = [...new Set(this.probes.map((probe) => probe.provider))];
    if (providers.length === 0) return false;
    return providers.every((provider) => {
      const general = generalLimit(this.ledger, this.config, provider);
      return (
        general !== null &&
        drainedWindowFor([statusForLimit(this.ledger, general, now)]) !== null
      );
    });
  }

  nearestDrainResets(now = this.clock()): {
    fiveHour: string | null;
    weekly: string | null;
  } {
    const nearest = {
      fiveHour: null as string | null,
      weekly: null as string | null,
    };
    for (const limit of resolvedLimits(this.ledger, this.config)) {
      if (!limit.routable || !limit.models.includes("*")) continue;
      const status = statusForLimit(this.ledger, limit, now);
      for (const window of ["fiveHour", "weekly"] as const) {
        const value = status[window];
        if (value.availability !== "available") continue;
        if (value.remainingPct === null || value.remainingPct > 0) continue;
        if (value.resetsAt === null) continue;
        const current = nearest[window];
        const candidateMs = instantMs(value.resetsAt);
        const currentMs = instantMs(current);
        if (
          current === null ||
          (candidateMs !== null &&
            (currentMs === null || candidateMs < currentMs))
        ) {
          nearest[window] = value.resetsAt;
        }
      }
    }
    return nearest;
  }

  reconcileAgentModel(
    agentName: string,
    liveModel: string,
    at = iso(this.clock()),
  ): QuotaReservation[] | null {
    const held = this.ledger.getActiveReservationForAgent(agentName);
    if (held === null || held.model === liveModel) return null;
    const now = new Date(at);
    const candidate = {
      tool: held.provider,
      model: liveModel,
      ...(held.effort === null ? {} : { effort: held.effort }),
    };
    const entries = limitsFor(this.ledger, this.config, candidate).map(
      (limit) => ({
        limit,
        status: statusForLimit(this.ledger, limit, now),
      }),
    );
    if (entries.length === 0) return null;
    return this.ledger.replaceReservationGroup(
      held.id,
      this.reservationInputs(
        held.agentName,
        candidate,
        entries,
        held.category,
        now,
        held.purpose === "control" && held.controlMessageId !== null
          ? { purpose: "control", controlMessageId: held.controlMessageId }
          : undefined,
      ),
      held.startedAt,
    );
  }

  private estimateFor(
    limit: ResolvedQuotaLimit,
    category: RoutingCategory,
  ): { fiveHour: number; weekly: number } {
    if (limit.unit === "units") {
      return {
        fiveHour: UNCONFIGURED_ESTIMATE_UNITS,
        weekly: UNCONFIGURED_ESTIMATE_UNITS,
      };
    }
    const percent = DEFAULT_PERCENT_ESTIMATES[category];
    return { fiveHour: percent.fiveHour, weekly: percent.weekly };
  }

  /** The booking for a run no pool can measure. Accounting still happens: the run books against its own `unconfigured:` pool, which is what the status displays already read. */
  private unconfiguredReservationInput(
    agentName: string,
    candidate: QuotaCandidateIdentity,
    category: RoutingCategory,
    now: Date,
    purpose?: { purpose: "control"; controlMessageId: string },
  ): ReserveQuotaInput {
    return {
      id: crypto.randomUUID(),
      agentName,
      provider: candidate.tool,
      account: "default",
      pool: `unconfigured:${candidate.model}`,
      model: candidate.model,
      effort: candidate.effort ?? null,
      category,
      estimatedUnits: UNCONFIGURED_ESTIMATE_UNITS,
      now: iso(now),
      expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
      ...(purpose ?? {}),
    };
  }

  private reservationInputs(
    agentName: string,
    candidate: QuotaCandidateIdentity,
    entries: { limit: ResolvedQuotaLimit; status: QuotaPoolStatus }[],
    category: RoutingCategory,
    now: Date,
    purpose?: { purpose: "control"; controlMessageId: string },
  ): ReserveQuotaInput[] {
    return entries.map((entry) => {
      const estimate = this.estimateFor(entry.limit, category);
      return {
        id: crypto.randomUUID(),
        agentName,
        provider: entry.limit.provider,
        account: entry.limit.account,
        pool: entry.limit.pool,
        model: candidate.model,
        effort: candidate.effort ?? null,
        category,
        estimatedUnits: estimate.fiveHour,
        estimatedWeeklyUnits: estimate.weekly,
        now: iso(now),
        expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
        ...(purpose ?? {}),
      };
    });
  }

  /** Is this route currently known not to start? Returns the moment it becomes eligible again, or null when nothing is holding it back. Eligibility is headroom *and* viability. Ranking on headroom alone is what made this necessary: Codex sitting at 0% weekly outscores Claude at 63% every time, so the emptiest pool silently outranked the question of whether a route could produce a working agent at all — and a gate that refuses an exhausted model only to hand the work to a route that cannot start has protected nothing. Nothing here knows the name of a vendor or a category. It reports what happened when Hive last tried, and it forgets on a schedule. */
  launchCooldown(
    candidate: QuotaCandidateIdentity,
    now: Date = this.clock(),
  ): { until: string; reason: string } | null {
    const health = this.ledger.routeHealth(
      candidate.tool,
      candidate.model,
      candidate.effort ?? null,
    );
    if (
      health === null ||
      health.consecutiveFailures === 0 ||
      health.lastFailureAt === null
    ) {
      return null;
    }
    // Repeat failures hold the route back longer, but never indefinitely: the cooldown is capped so a route always gets retried and can always come back.
    const minutes = Math.min(
      this.config.launchQuarantineMinutes * health.consecutiveFailures,
      this.config.launchQuarantineMinutes * 4,
    );
    const until = add(new Date(health.lastFailureAt), minutes * 60_000);
    return new Date(until) <= now
      ? null
      : {
          until,
          reason:
            health.lastFailureReason ?? "a previous launch never proved life",
        };
  }

  noteLaunchSucceeded(
    candidate: QuotaCandidateIdentity,
    at = iso(this.clock()),
  ): void {
    this.ledger.recordLaunchSuccess(
      candidate.tool,
      candidate.model,
      candidate.effort ?? null,
      at,
    );
  }

  /** Read live limits from every provider and fold them into the store. Runs at daemon start (`force`) and on the maintenance tick. A provider that answers writes an authoritative or reported observation stamped per window; a provider that cannot answer records why, and Hive reports the gap as unknown rather than carrying forward a number nobody measured. Each probe costs a subprocess, and Claude's usage endpoint rate-limits under polling, so a provider whose pools are already fresh is skipped. Probing answers at startup and whenever a prior reading goes stale; connected sessions no longer scrape statusline for the same windows. */
  async refreshFromProviders(
    now = this.clock(),
    options: {
      force?: boolean;
      providers?: readonly CapabilityProvider[];
      trigger?: "operator";
    } = {},
  ): Promise<QuotaRefreshReport[]> {
    if (!this.config.discovery) return [];
    const reports: QuotaRefreshReport[] = [];
    let probed = false;
    for (const probe of this.probes) {
      if (
        options.providers !== undefined &&
        !options.providers.includes(probe.provider)
      )
        continue;
      if (options.force !== true && this.shouldSkipProbe(probe.provider, now)) {
        reports.push({ provider: probe.provider, status: "skipped", pools: 0 });
        continue;
      }
      const read =
        options.trigger === "operator"
          ? await this.readProbeForOperator(probe, now)
          : { attempt: await this.readProbe(probe), delivery: undefined };
      if (read.attempt.status === "rate-limited") {
        reports.push({
          provider: probe.provider,
          status: "rate-limited",
          pools: 0,
          reason:
            "operator probes are limited to one vendor call every 5 seconds",
          completedAt: read.attempt.completedAt,
          retryAt: read.attempt.retryAt,
          delivery: "rate-limited",
        });
        continue;
      }
      probed = true;
      const result = read.attempt.result;
      const operatorEvidence =
        options.trigger === "operator"
          ? {
              observedAt:
                result.status === "ok"
                  ? (result.pools
                      .map((pool) => pool.observedAt)
                      .sort()
                      .at(-1) ?? null)
                  : null,
              startedAt: read.attempt.startedAt,
              completedAt: read.attempt.completedAt,
              delivery: read.delivery,
            }
          : {};
      if (result.status === "unavailable") {
        this.probeErrors.set(probe.provider, result.reason);
        reports.push({
          provider: probe.provider,
          status: "unavailable",
          pools: 0,
          reason: result.reason,
          ...operatorEvidence,
        });
        await this.alertProbeFailure(probe.provider, result.reason, now);
        continue;
      }
      this.probeErrors.delete(probe.provider);
      this.ledger.setAlertState({
        provider: probe.provider,
        account: "default",
        pool: "live-probe",
        window: "data",
        level: "normal",
        notifiedAt: null,
        boundaryAt: null,
      });
      // The catalog is what binds a metered sub-pool to the models it gates, so it is stored before the pools that depend on it are resolved. Some billing surfaces carry no model catalog. That absence cannot erase a vendor claim measured by capability discovery.
      if (result.catalog.length > 0) {
        this.ledger.replaceModelCatalog(
          probe.provider,
          result.catalog.map((entry) => ({
            ...entry,
            discoveredAt: iso(now),
          })),
        );
      }
      for (const reading of result.pools) {
        this.ledger.upsertDiscoveredPool(discoveredPoolFrom(reading));
        this.recordDiscoveredReading(reading);
      }
      await this.rememberProbeBilling(probe.provider, result);
      reports.push({
        provider: probe.provider,
        status: "ok",
        pools: result.pools.length,
        ...operatorEvidence,
      });
    }
    if (probed) this.lastRefreshAt = now;
    return reports;
  }

  /** Periodic and daemon-internal refreshes may share any provider read already in flight. Operator refreshes use the stricter post-request path below. */
  private async readProbe(probe: QuotaProbe): Promise<CompletedProbe> {
    const existing = this.probeReads.get(probe.provider);
    if (existing !== undefined) return existing.completion;
    return this.startProbe(probe, false).completion;
  }

  /** An operator request is answered only by a probe that starts at or after the click. A request arriving behind an older probe queues one successor; other requests waiting for that successor share it. */
  private async readProbeForOperator(
    probe: QuotaProbe,
    requestedAt: Date,
  ): Promise<{
    attempt: ProbeAttempt;
    delivery: "started" | "queued" | "coalesced" | "rate-limited";
  }> {
    const active = this.probeReads.get(probe.provider);
    if (active !== undefined && active.startedAtMs >= requestedAt.getTime()) {
      return { attempt: await active.completion, delivery: "coalesced" };
    }
    const queued = this.queuedOperatorProbeReads.get(probe.provider);
    if (queued !== undefined) {
      return { attempt: await queued.attempt, delivery: "coalesced" };
    }
    if (active !== undefined) {
      const successor = this.queueOperatorProbe(probe, active.completion);
      const attempt = await successor.attempt;
      return {
        attempt,
        delivery: attempt.status === "rate-limited" ? "rate-limited" : "queued",
      };
    }
    const attempt = await this.startOperatorProbe(probe);
    return {
      attempt,
      delivery: attempt.status === "rate-limited" ? "rate-limited" : "started",
    };
  }

  private queueOperatorProbe(
    probe: QuotaProbe,
    predecessor: Promise<CompletedProbe>,
  ): QueuedProbe {
    let queued!: QueuedProbe;
    const attempt = (async (): Promise<ProbeAttempt> => {
      await predecessor.catch(() => undefined);
      if (this.queuedOperatorProbeReads.get(probe.provider) === queued) {
        this.queuedOperatorProbeReads.delete(probe.provider);
      }
      return this.startOperatorProbe(probe);
    })();
    queued = { attempt };
    this.queuedOperatorProbeReads.set(probe.provider, queued);
    return queued;
  }

  private startOperatorProbe(probe: QuotaProbe): Promise<ProbeAttempt> {
    const current = this.clock();
    const previous = this.lastOperatorProbeStartedAt.get(probe.provider);
    if (
      previous !== undefined &&
      current.getTime() - previous < OPERATOR_PROBE_MIN_INTERVAL_MS
    ) {
      return Promise.resolve({
        status: "rate-limited",
        completedAt: iso(current),
        retryAt: iso(new Date(previous + OPERATOR_PROBE_MIN_INTERVAL_MS)),
      });
    }
    return this.startProbe(probe, true).completion;
  }

  private startProbe(probe: QuotaProbe, operator: boolean): ActiveProbe {
    const startedAt = this.clock();
    let active!: ActiveProbe;
    const completion = Promise.resolve()
      .then(() => probe.read())
      .then(
        (result): CompletedProbe => ({
          status: "probed",
          result,
          startedAt: iso(startedAt),
          completedAt: iso(this.clock()),
        }),
      )
      .finally(() => {
        if (this.probeReads.get(probe.provider) === active) {
          this.probeReads.delete(probe.provider);
        }
      });
    active = { startedAtMs: startedAt.getTime(), completion };
    this.probeReads.set(probe.provider, active);
    if (operator) {
      this.lastOperatorProbeStartedAt.set(probe.provider, startedAt.getTime());
    }
    return active;
  }

  /** Persist one probe reading. Only gauged windows are stamped. A boundary with no gauge still lands; used stays null. */
  private recordDiscoveredReading(reading: DiscoveredPoolReading): void {
    if (reading.fiveHour === null && reading.weekly === null) return;
    const scope = {
      provider: reading.provider,
      account: reading.account,
      pool: reading.pool,
    };
    // A user override claims this scope in their own planning units, so the provider's percentages are mapped onto the allowance they declared rather than stored as though a percent were a unit.
    const target = resolvedLimits(this.ledger, this.config).find(
      (candidate) => scopeKey(candidate) === scopeKey(scope),
    );
    const scale = (usedPct: number, allowance: number): number =>
      target === undefined || target.unit === "percent"
        ? usedPct
        : (usedPct * allowance) / 100;
    // The gauge, or null when this reading did not carry one. Everything that claims a measurement below keys off this, never off the window's presence.
    const fiveHourPct = reading.fiveHour?.usedPct ?? null;
    const weeklyPct = reading.weekly?.usedPct ?? null;
    this.ledger.upsertObservation(
      QuotaObservationSchema.parse({
        ...scope,
        fiveHourUsed:
          fiveHourPct === null
            ? null
            : scale(fiveHourPct, target?.fiveHourAllowance ?? 100),
        weeklyUsed:
          weeklyPct === null
            ? null
            : scale(weeklyPct, target?.weeklyAllowance ?? 100),
        observedAt: reading.observedAt,
        fiveHourResetAt: reading.fiveHour?.resetsAt ?? null,
        weeklyResetAt: reading.weekly?.resetsAt ?? null,
        source: reading.source,
        confidence: reading.confidence,
        ...(fiveHourPct === null
          ? {}
          : {
              fiveHourObservedAt: reading.observedAt,
              fiveHourSource: reading.source,
              fiveHourConfidence: reading.confidence,
            }),
        ...(weeklyPct === null
          ? {}
          : {
              weeklyObservedAt: reading.observedAt,
              weeklySource: reading.source,
              weeklyConfidence: reading.confidence,
            }),
      }),
    );
  }

  private shouldSkipProbe(provider: CapabilityProvider, now: Date): boolean {
    if (!this.hasFreshReading(provider, now)) return false;
    if (this.lastRefreshAt === null) return false;
    return (
      now.getTime() - this.lastRefreshAt.getTime() <
      this.config.refreshIntervalMinutes * 60_000
    );
  }

  /** Whether every routable pool for this provider is measured. One fresh general pool must not skip a stale model-scoped cap. */
  private hasFreshReading(provider: CapabilityProvider, now: Date): boolean {
    const limits = resolvedLimits(this.ledger, this.config).filter(
      (limit) => limit.provider === provider && limit.routable,
    );
    if (limits.length === 0) return false;
    return limits.every(
      (limit) =>
        measured(statusForLimit(this.ledger, limit, now), limit) !== null,
    );
  }

  probeError(provider: CapabilityProvider): string | null {
    return this.probeErrors.get(provider) ?? null;
  }

  refreshedAt(): string | null {
    return this.lastRefreshAt?.toISOString() ?? null;
  }

  /** True when the last refresh is older than the configured interval, or when a routable pool has gone blind — a passed reset voids the reading that described the old window, and Hive would rather re-read than route on a number it can no longer vouch for. */
  needsRefresh(now = this.clock()): boolean {
    if (!this.config.discovery) return false;
    if (this.lastRefreshAt === null) return true;
    if (
      now.getTime() - this.lastRefreshAt.getTime() >=
      this.config.refreshIntervalMinutes * 60_000
    ) {
      return true;
    }
    return resolvedLimits(this.ledger, this.config)
      .filter((limit) => limit.routable && limit.unit === "percent")
      .some((limit) => {
        const status = statusForLimit(this.ledger, limit, now);
        return measured(status) === null;
      });
  }

  private requireMatchingControlReservation(
    reservation: QuotaReservation,
    request: ControlQuotaRequest,
  ): QuotaReservation {
    if (
      reservation.agentName !== request.agentName ||
      reservation.provider !== request.tool ||
      reservation.model !== request.model ||
      reservation.category !== request.category ||
      reservation.purpose !== "control"
    ) {
      throw new Error(
        `Control reservation ${reservation.id} does not match the recorded execution identity for ${request.agentName}`,
      );
    }
    return reservation;
  }

  statuses(now = this.clock()): QuotaStatus[] {
    const resolved = resolvedLimits(this.ledger, this.config);
    const seen = new Set<string>();
    const values: QuotaStatus[] = [];
    for (const limit of resolved) {
      const key = scopeKey(limit);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push({
        ...statusForLimit(this.ledger, limit, now),
        models: [
          ...new Set(
            resolved
              .filter((candidate) => sameScope(candidate, limit))
              .flatMap((candidate) => candidate.models),
          ),
        ],
      });
    }
    const trackedProviders = new Set<string>();
    for (const unconfigured of this.ledger.unconfiguredScopes()) {
      // A model that a live pool now meters is not an unmetered model, whatever an old compatibility-mode reservation left lying in the ledger. Opus has no dedicated meter and never did — it is metered by the general subscription pool like every other Claude model without one — so reporting it as an uncovered gap invented a pool that does not exist and advertised the healthiest model on the plan as "unconstrained", which is the single most attractive thing a router can be told. The stale rows stay for accounting; they are no longer rendered as a hole in coverage.
      if (
        limitsFor(this.ledger, this.config, {
          tool: unconfigured.provider,
          model: unconfigured.model,
        }).length > 0
      ) {
        continue;
      }
      trackedProviders.add(unconfigured.provider);
      values.push(
        gapStatus(
          unconfigured.provider,
          unconfigured.model,
          unconfiguredTotals(this.ledger, unconfigured, now),
          this.probeError(unconfigured.provider),
        ),
      );
    }
    for (const provider of CAPABILITY_PROVIDERS) {
      if (trackedProviders.has(provider)) continue;
      if (
        resolved.some((limit) => limit.provider === provider && limit.routable)
      ) {
        continue;
      }
      values.push(
        gapStatus(
          provider,
          "*",
          { reserved: 0, fiveHourRecorded: 0, weeklyRecorded: 0 },
          this.probeError(provider),
        ),
      );
    }
    return values;
  }

  /** Book one already-selected launch against its governing pools, never refusing for usage: pool exhaustion is a mid-work condition, handled by the drain handler, and selection belongs to the router. An unmetered candidate is normal for a provider with no usage surface (opencode) or a quiet one; it books against its `unconfigured:` pool, which is what the status displays already read. */
  reserveLaunch(
    agentName: string,
    candidate: AuthorizedLaunch,
    category: RoutingCategory,
  ): QuotaReservation {
    requireAuthorizedLaunch(candidate);
    const now = this.clock();
    const entries = limitsFor(this.ledger, this.config, candidate).map(
      (limit) => ({
        limit,
        status: statusForLimit(this.ledger, limit, now),
      }),
    );
    const inputs: ReserveQuotaInput[] =
      entries.length === 0
        ? [
            this.unconfiguredReservationInput(
              agentName,
              candidate,
              category,
              now,
            ),
          ]
        : this.reservationInputs(agentName, candidate, entries, category, now);
    const reservation = this.ledger.reserveGroupUnchecked(inputs)[0];
    if (reservation === undefined) {
      throw new Error("Quota ledger returned an empty reservation");
    }
    return reservation;
  }

  reserveControlRun(request: ControlQuotaRequest): QuotaReservation {
    const existing = this.ledger.getActiveControlReservation(
      request.controlMessageId,
    );
    if (existing !== null) {
      return this.requireMatchingControlReservation(existing, request);
    }

    const now = this.clock();
    const entries = limitsFor(this.ledger, this.config, request).map(
      (limit) => ({
        limit,
        status: statusForLimit(this.ledger, limit, now),
      }),
    );
    // A run no pool can measure cannot be authorized or refused on the numbers. Accounting still happens: the run gets an explicit unbounded reservation.
    if (entries.length === 0) {
      const reservation = this.ledger.insertUnboundedReservation(
        this.unconfiguredReservationInput(
          request.agentName,
          request,
          request.category,
          now,
          {
            purpose: "control",
            controlMessageId: request.controlMessageId,
          },
        ),
      );
      return this.requireMatchingControlReservation(reservation, request);
    }

    const inputs = this.reservationInputs(
      request.agentName,
      request,
      entries,
      request.category,
      now,
      { purpose: "control", controlMessageId: request.controlMessageId },
    ).map((input, index) => ({
      ...input,
      ...(index === 0 ? {} : { controlMessageId: undefined }),
    }));
    // §05: a critical acknowledgement is never refused on usage either. It books unchecked, on its own model, always.
    const reservations = this.ledger.reserveGroupUnchecked(inputs);
    const reservation = reservations[0];
    if (reservation === undefined) {
      throw new Error("Quota ledger returned an empty control reservation");
    }
    return this.requireMatchingControlReservation(reservation, request);
  }

  /** The run proved life. That is the only evidence that a route works, so it is also what clears the route: whatever Hive concluded from an earlier failed launch, a working agent supersedes it, and the quarantine lifts at once. */
  markStarted(reservationId: string, at = iso(this.clock())): void {
    this.ledger.markStarted(reservationId, at);
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null) return;
    this.ledger.recordLaunchSuccess(
      reservation.provider,
      reservation.model,
      reservation.effort,
      at,
    );
  }

  /** Settle a reservation into recorded usage. Each window is debited its own amount. Committing the five-hour estimate to the weekly ledger too would overstate weekly spend several-fold for a percent-denominated pool — a run is a large slice of five hours and a small slice of a week — and an overstated ledger refuses spawns that would have fit. When the provider reports one actual figure and no weekly counterpart, that figure is scaled by the ratio the reservation itself was estimated at. */
  reconcile(
    reservationId: string,
    units?: number,
    source: "provider" | "gateway" | "estimated" = "estimated",
    at = iso(this.clock()),
    weeklyUnits?: number,
  ): void {
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null) return;
    const estimatedWeekly =
      reservation.estimatedWeeklyUnits ?? reservation.estimatedUnits;
    const ratio =
      reservation.estimatedUnits > 0
        ? estimatedWeekly / reservation.estimatedUnits
        : 1;
    this.ledger.reconcile(
      reservationId,
      units ?? reservation.estimatedUnits,
      weeklyUnits ?? (units === undefined ? estimatedWeekly : units * ratio),
      units === undefined ? "estimated" : source,
      at,
    );
  }

  /** Settle a reservation whose run is over or never happened. `launchFailure` is the caller saying "this route did not produce a working agent" — the spawn failed outright, not merely a worktree that could not be created or a name that collided. Only that is evidence about the *route*, so only that is recorded against it. Attributing an unrelated failure to a model would quarantine a healthy route and make Hive the outage. */
  cancel(
    reservationId: string,
    at = iso(this.clock()),
    launchFailure?: string,
  ): void {
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null || reservation.status !== "active") return;
    if (launchFailure !== undefined && reservation.startedAt === null) {
      this.ledger.recordLaunchFailure(
        reservation.provider,
        reservation.model,
        reservation.effort,
        launchFailure,
        at,
      );
    }
    if (reservation.startedAt === null) {
      this.ledger.release(reservationId, at);
    } else {
      this.reconcile(reservationId, undefined, "estimated", at);
    }
  }

  async recoverExpired(now = this.clock()): Promise<number> {
    return (await this.recoverExpiredReservations(now)).length;
  }

  async listExpiredReservations(
    now = this.clock(),
  ): Promise<QuotaReservation[]> {
    return await this.ledger.expired(iso(now));
  }

  async recoverExpiredReservations(
    now = this.clock(),
  ): Promise<QuotaReservation[]> {
    const expired = await this.listExpiredReservations(now);
    for (const reservation of expired) {
      await this.cancel(reservation.id, iso(now));
    }
    return expired;
  }

  observe(observation: QuotaObservationInput): QuotaObservation {
    const raw = QuotaObservationSchema.parse(observation);
    const parsed: QuotaObservation =
      raw.fiveHourObservedAt === null && raw.weeklyObservedAt === null
        ? {
            ...raw,
            fiveHourObservedAt: raw.observedAt,
            fiveHourSource: raw.source,
            fiveHourConfidence: raw.confidence,
            weeklyObservedAt: raw.observedAt,
            weeklySource: raw.source,
            weeklyConfidence: raw.confidence,
          }
        : raw;
    const limit = resolvedLimits(this.ledger, this.config).find(
      (candidate) =>
        candidate.provider === parsed.provider &&
        candidate.account === parsed.account &&
        candidate.pool === parsed.pool,
    );
    if (limit === undefined) {
      throw new Error(
        `Quota pool is not known: ${parsed.provider}/${parsed.account}/${parsed.pool}`,
      );
    }
    return this.ledger.upsertObservation(parsed);
  }

  private async rememberProbeBilling(
    provider: CapabilityProvider,
    result: Extract<QuotaProbeResult, { status: "ok" }>,
  ): Promise<void> {
    if (result.wire === undefined) return;
    const observedAt = iso(this.clock());
    const billing =
      provider === "claude"
        ? accountBillingFromUsage(result.wire, observedAt)
        : provider === "codex"
          ? accountBillingFromCodexRateLimits(result.wire, observedAt)
          : provider === "grok"
            ? accountBillingFromGrokBilling(result.wire, observedAt)
            : provider === "kimi"
              ? accountBillingFromKimiUsage(result.wire, observedAt)
              : null;
    if (billing === null) return;
    await rememberBilling(provider, billing);
  }

  private async sendAlert(body: string): Promise<void> {
    if (this.alertSink === null) return;
    try {
      await this.alertSink(body);
    } catch {}
  }

  private async alertProbeFailure(
    provider: CapabilityProvider,
    reason: string,
    now: Date,
  ): Promise<void> {
    const scope: QuotaScope = {
      provider,
      account: "default",
      pool: "live-probe",
    };
    const prior = this.ledger.getAlertState(scope, "data");
    if (prior?.level === "unknown") return;
    this.ledger.setAlertState({
      ...scope,
      window: "data",
      level: "unknown",
      notifiedAt: iso(now),
      boundaryAt: null,
    });
    await this.sendAlert(
      `Hive could not read live quota limits from ${provider}: ${reason}. ` +
        "Existing readings are kept and marked stale; no capacity number is " +
        "being invented in their place.",
    );
  }
}
