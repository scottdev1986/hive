import {
  DEFAULT_PERCENT_ESTIMATES,
  QuotaObservationSchema,
  type QuotaConfidence,
  type QuotaConfig,
  type QuotaLimit,
  type QuotaObservation,
  type QuotaObservationInput,
  type QuotaPoolOrigin,
  type QuotaPoolStatus,
  type QuotaScope,
  type QuotaStatus,
  type QuotaUnconfiguredStatus,
  type QuotaWindowStatus,
  type RoutingTier,
} from "../schemas";
import {
  QuotaLedger,
  type QuotaAlertState,
  type QuotaReservation,
} from "./quota-ledger";
import {
  orderRateLimitWindows,
  readingsFromCodexResponse,
  type DiscoveredPoolReading,
  type QuotaProbe,
} from "./quota-sources";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export interface QuotaRouteCandidate {
  tool: "claude" | "codex";
  model: string;
}

export interface QuotaRouteRequest {
  agentName: string;
  tier: RoutingTier;
  preferredTool: "claude" | "codex";
  explicitTool?: "claude" | "codex";
  reviewOfTool?: "claude" | "codex";
  candidates: QuotaRouteCandidate[];
}

export interface QuotaRouteDecision extends QuotaRouteCandidate {
  reservation: QuotaReservation;
  status: QuotaStatus;
  reason: string;
}

export interface ControlQuotaRequest extends QuotaRouteCandidate {
  agentName: string;
  tier: RoutingTier;
  controlMessageId: string;
}

export type QuotaAlertSink = (body: string) => Promise<void>;
export type QuotaClock = () => Date;

function iso(date: Date): string {
  return date.toISOString();
}

function subtract(date: Date, milliseconds: number): string {
  return new Date(date.getTime() - milliseconds).toISOString();
}

function add(date: Date, milliseconds: number): string {
  return new Date(date.getTime() + milliseconds).toISOString();
}

function unixSecondsToIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return new Date(value * 1_000).toISOString();
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date)) {
    if (part.type === "literal") continue;
    if (part.type === "weekday") {
      values.weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        .indexOf(part.value);
    } else {
      values[part.type] = Number(part.value);
    }
  }
  return values;
}

function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const observed = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    const difference = desired - observed;
    if (difference === 0) break;
    guess += difference;
  }
  const resolved = zonedParts(new Date(guess), timeZone);
  if (
    resolved.year === year && resolved.month === month &&
    resolved.day === day && resolved.hour === hour &&
    resolved.minute === minute
  ) {
    return new Date(guess);
  }

  // A configured wall time can be absent during a daylight-saving jump.
  // Resolve that boundary to the first valid local minute after the gap.
  const searchStart = desired - 18 * HOUR_MS;
  const searchEnd = desired + 18 * HOUR_MS;
  for (let candidate = searchStart; candidate <= searchEnd; candidate += 60_000) {
    const parts = zonedParts(new Date(candidate), timeZone);
    if (
      parts.year === year && parts.month === month && parts.day === day &&
      parts.hour! * 60 + parts.minute! >= hour * 60 + minute
    ) {
      return new Date(candidate);
    }
  }
  throw new Error(
    `Unable to resolve calendar quota boundary in timezone ${timeZone}`,
  );
}

export function calendarWeekBounds(now: Date, limit: QuotaLimit): {
  start: string;
  end: string;
} {
  const local = zonedParts(now, limit.timezone);
  let daysBack = (local.weekday! - limit.resetWeekday + 7) % 7;
  const beforeReset = daysBack === 0 && (
    local.hour! < limit.resetHour ||
    (local.hour === limit.resetHour && local.minute! < limit.resetMinute)
  );
  if (beforeReset) daysBack = 7;
  const localDate = new Date(Date.UTC(
    local.year!,
    local.month! - 1,
    local.day! - daysBack,
  ));
  const start = zonedToUtc(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth() + 1,
    localDate.getUTCDate(),
    limit.resetHour,
    limit.resetMinute,
    limit.timezone,
  );
  const nextDate = new Date(Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate() + 7,
  ));
  const end = zonedToUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    limit.resetHour,
    limit.resetMinute,
    limit.timezone,
  );
  return { start: iso(start), end: iso(end) };
}

function scopeKey(scope: QuotaScope): string {
  return `${scope.provider}\0${scope.account}\0${scope.pool}`;
}

function sameScope(left: QuotaLimit, right: QuotaLimit): boolean {
  return left.provider === right.provider && left.account === right.account &&
    left.pool === right.pool;
}

function confidenceLabel(status: QuotaPoolStatus): string {
  return `${status.confidence}/${status.freshness} from ${status.source}`;
}

/** Unknown is rendered as the word, never as a number a reader could trust. */
export function describeRemaining(
  window: { remaining: number | null },
  unit: string,
): string {
  return window.remaining === null
    ? "unknown"
    : `${window.remaining.toFixed(1)}${unit}`;
}

export class QuotaExhaustedError extends Error {
  constructor(message: string, readonly fallback?: QuotaRouteCandidate) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export interface CodexRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
}

export interface CodexQuotaReading {
  fiveHourUsed: number;
  weeklyUsed: number;
}

/**
 * A pool after discovery and overrides are folded together. `unit` decides how
 * every number attached to it is read: a discovered pool is percent-denominated
 * with an allowance of exactly 100, because providers report the fraction of a
 * window consumed and never the window's absolute size. A manual pool keeps the
 * operator's own planning units.
 */
export interface ResolvedQuotaLimit extends QuotaLimit {
  origin: QuotaPoolOrigin;
  unit: "percent" | "units";
  routable: boolean;
  label: string | null;
  overridesDiscovered: boolean;
  fiveHourWindowMinutes: number | null;
  weeklyWindowMinutes: number | null;
}

export interface QuotaRefreshReport {
  provider: "claude" | "codex";
  status: "ok" | "unavailable" | "skipped";
  pools: number;
  reason?: string;
}

/** How long a discovered reading stays fresh, given the configured refresh. */
const discoveredMaxAgeMinutes = (config: QuotaConfig): number =>
  Math.max(2 * config.refreshIntervalMinutes, 30);

export class QuotaService {
  private alertSink: QuotaAlertSink | null = null;
  private readonly probes: QuotaProbe[];
  private readonly probeErrors = new Map<"claude" | "codex", string>();
  private lastRefreshAt: Date | null = null;

  constructor(
    readonly ledger: QuotaLedger,
    readonly config: QuotaConfig,
    private readonly clock: QuotaClock = () => new Date(),
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

  /**
   * Record a Codex app-server rate-limit snapshot.
   *
   * These percentages are the most authoritative quota signal Hive ever sees, and
   * they arrive on every turn. They are stored whether or not anyone wrote a
   * `quota.toml`: an unconfigured install discovers its pool from this very
   * payload. (Hive used to look up a configured pool first and drop the reading
   * when none existed, which is how an installation could run for weeks with an
   * empty observation table and nothing but its own estimates.)
   *
   * Windows are identified by duration rather than by position, so a plan that
   * reports its weekly bucket first cannot silently invert the two.
   */
  async observeCodexRateLimits(
    model: string,
    response: CodexRateLimitsResponse,
    observedAt = iso(this.clock()),
  ): Promise<CodexQuotaReading | null> {
    for (const reading of readingsFromCodexResponse(response, "default", observedAt)) {
      this.ledger.upsertDiscoveredPool({
        provider: reading.provider,
        account: reading.account,
        pool: reading.pool,
        models: reading.models,
        label: reading.label,
        fiveHourWindowMinutes: reading.fiveHour?.windowMinutes ?? null,
        weeklyWindowMinutes: reading.weekly?.windowMinutes ?? null,
        discoveredAt: reading.observedAt,
        source: reading.source,
      });
    }

    const limit = this.limitFor({ tool: "codex", model });
    // An operator override is denominated in their own planning units, so the
    // provider's percentages are mapped onto the allowance they declared.
    if (limit !== null && limit.origin === "manual") {
      const byId = response.rateLimitsByLimitId ?? {};
      const snapshot = byId[limit.pool] ??
        Object.values(byId).find((candidate) => candidate.limitId === limit.pool) ??
        response.rateLimits;
      const windows = orderRateLimitWindows(snapshot);
      if (windows.fiveHour === null || windows.weekly === null) return null;
      const reading = {
        fiveHourUsed: limit.fiveHourAllowance * windows.fiveHour.usedPct / 100,
        weeklyUsed: limit.weeklyAllowance * windows.weekly.usedPct / 100,
      };
      await this.observe({
        provider: "codex",
        account: limit.account,
        pool: limit.pool,
        ...reading,
        observedAt,
        fiveHourResetAt: windows.fiveHour.resetsAt,
        weeklyResetAt: windows.weekly.resetsAt,
        source: "provider",
        confidence: "authoritative",
        fiveHourObservedAt: observedAt,
        fiveHourSource: "provider",
        fiveHourConfidence: "authoritative",
        weeklyObservedAt: observedAt,
        weeklySource: "provider",
        weeklyConfidence: "authoritative",
      });
      return reading;
    }

    // Otherwise the discovered pool is the one that matters, and it is
    // percent-denominated: the reading *is* the percentage.
    const routable = readingsFromCodexResponse(response, "default", observedAt)
      .find((reading) => reading.models.includes("*"));
    if (routable === undefined) return null;
    await this.recordDiscoveredReading(routable);
    if (routable.fiveHour === null || routable.weekly === null) return null;
    return {
      fiveHourUsed: routable.fiveHour.usedPct,
      weeklyUsed: routable.weekly.usedPct,
    };
  }

  /**
   * Every pool Hive knows about: the operator's explicit overrides first, then
   * everything the providers told us about themselves. A manual pool that shares
   * a discovered pool's scope replaces it outright and says so, which is the only
   * form `quota.toml` still takes — Hive never requires one to route.
   */
  resolvedLimits(): ResolvedQuotaLimit[] {
    const manualScopes = new Set(this.config.limits.map(scopeKey));
    const manual = this.config.limits.map((limit): ResolvedQuotaLimit => ({
      ...limit,
      origin: "manual",
      unit: "units",
      routable: limit.models.length > 0,
      label: null,
      overridesDiscovered: false,
      fiveHourWindowMinutes: 5 * 60,
      weeklyWindowMinutes: 7 * 24 * 60,
    }));
    const discovered: ResolvedQuotaLimit[] = [];
    for (const pool of this.ledger.discoveredPools()) {
      if (manualScopes.has(scopeKey(pool))) {
        const override = manual.find((limit) =>
          scopeKey(limit) === scopeKey(pool)
        );
        if (override !== undefined) {
          override.overridesDiscovered = true;
          override.label = pool.label;
        }
        continue;
      }
      discovered.push({
        provider: pool.provider,
        account: pool.account,
        pool: pool.pool,
        models: pool.models,
        // A provider reports the fraction of a window it has consumed, never the
        // window's size. Percent is therefore the pool's native currency and 100
        // is its allowance by construction, not by assumption.
        fiveHourAllowance: 100,
        weeklyAllowance: 100,
        weeklyWindow: "rolling",
        timezone: "UTC",
        resetWeekday: 1,
        resetHour: 0,
        resetMinute: 0,
        observationMaxAgeMinutes: discoveredMaxAgeMinutes(this.config),
        origin: "discovered",
        unit: "percent",
        routable: pool.models.length > 0,
        label: pool.label,
        overridesDiscovered: false,
        fiveHourWindowMinutes: pool.fiveHourWindowMinutes,
        weeklyWindowMinutes: pool.weeklyWindowMinutes,
      });
    }
    return [...manual, ...discovered];
  }

  private limitFor(candidate: QuotaRouteCandidate): ResolvedQuotaLimit | null {
    const routable = this.resolvedLimits().filter((limit) => limit.routable);
    return routable.find((limit) =>
      limit.provider === candidate.tool &&
      limit.models.includes(candidate.model)
    ) ?? routable.find((limit) =>
      limit.provider === candidate.tool && limit.models.includes("*")
    ) ?? null;
  }

  /**
   * Hive's own guess at what a run will cost, in the pool's own currency. This is
   * the one number here that no provider supplies, so it is always an estimate
   * and every reservation built from it is labelled one. A real observation
   * overwrites the usage it stood in for as soon as the provider reports.
   */
  private estimateFor(
    limit: ResolvedQuotaLimit,
    tier: RoutingTier,
  ): { fiveHour: number; weekly: number } {
    if (limit.unit === "units") {
      const estimate = this.config.estimates[tier]!;
      return { fiveHour: estimate, weekly: estimate };
    }
    const percent = this.config.estimatesPct[tier] ??
      DEFAULT_PERCENT_ESTIMATES[tier];
    return { fiveHour: percent.fiveHour, weekly: percent.weekly };
  }

  /**
   * Read live limits from every provider and fold them into the store.
   *
   * Runs at daemon start (`force`) and on the maintenance tick. A provider that
   * answers writes an authoritative or reported observation stamped per window; a
   * provider that cannot answer records why, and Hive reports the gap as unknown
   * rather than carrying forward a number nobody measured.
   *
   * Each probe costs a subprocess, and Claude's usage endpoint rate-limits under
   * polling, so a provider whose pools are already fresh is skipped. Those free
   * feeds — the Codex app-server's push notifications and Claude's statusLine —
   * keep a busy hive current without any probing at all; probing exists to answer
   * the question at startup and whenever the free feeds fall silent.
   */
  async refreshFromProviders(
    now = this.clock(),
    options: { force?: boolean } = {},
  ): Promise<QuotaRefreshReport[]> {
    if (!this.config.discovery) return [];
    const reports: QuotaRefreshReport[] = [];
    for (const probe of this.probes) {
      if (options.force !== true && this.hasFreshReading(probe.provider, now)) {
        reports.push({ provider: probe.provider, status: "skipped", pools: 0 });
        continue;
      }
      const result = await probe.read();
      if (result.status === "unavailable") {
        this.probeErrors.set(probe.provider, result.reason);
        reports.push({
          provider: probe.provider,
          status: "unavailable",
          pools: 0,
          reason: result.reason,
        });
        await this.alertProbeFailure(probe.provider, result.reason, now);
        continue;
      }
      this.probeErrors.delete(probe.provider);
      // Rearm the outage alert so the next real failure is announced again.
      this.ledger.setAlertState({
        provider: probe.provider,
        account: "default",
        pool: "live-probe",
        window: "data",
        level: "normal",
        notifiedAt: null,
        boundaryAt: null,
      });
      for (const reading of result.pools) {
        this.ledger.upsertDiscoveredPool({
          provider: reading.provider,
          account: reading.account,
          pool: reading.pool,
          models: reading.models,
          label: reading.label,
          fiveHourWindowMinutes: reading.fiveHour?.windowMinutes ?? null,
          weeklyWindowMinutes: reading.weekly?.windowMinutes ?? null,
          discoveredAt: reading.observedAt,
          source: reading.source,
        });
        await this.recordDiscoveredReading(reading);
      }
      reports.push({
        provider: probe.provider,
        status: "ok",
        pools: result.pools.length,
      });
    }
    this.lastRefreshAt = now;
    return reports;
  }

  /**
   * Persist one probe reading. Only the windows the provider actually reported
   * are stamped; an absent window keeps whatever provenance it already had, so a
   * partial reading can never make a stale fact look fresh.
   */
  private async recordDiscoveredReading(
    reading: DiscoveredPoolReading,
  ): Promise<void> {
    if (reading.fiveHour === null && reading.weekly === null) return;
    const scope = {
      provider: reading.provider,
      account: reading.account,
      pool: reading.pool,
    };
    const prior = this.ledger.getObservation(scope);
    // An operator override claims this scope in their own planning units, so the
    // provider's percentages are mapped onto the allowance they declared rather
    // than stored as though a percent were a unit.
    const target = this.resolvedLimits().find((candidate) =>
      scopeKey(candidate) === scopeKey(scope)
    );
    const scale = (usedPct: number, allowance: number): number =>
      target === undefined || target.unit === "percent"
        ? usedPct
        : usedPct * allowance / 100;
    this.ledger.upsertObservation(QuotaObservationSchema.parse({
      ...scope,
      fiveHourUsed: reading.fiveHour === null
        ? prior?.fiveHourUsed ?? 0
        : scale(reading.fiveHour.usedPct, target?.fiveHourAllowance ?? 100),
      weeklyUsed: reading.weekly === null
        ? prior?.weeklyUsed ?? 0
        : scale(reading.weekly.usedPct, target?.weeklyAllowance ?? 100),
      observedAt: reading.observedAt,
      fiveHourResetAt: reading.fiveHour?.resetsAt ?? null,
      weeklyResetAt: reading.weekly?.resetsAt ?? null,
      source: reading.source,
      confidence: reading.confidence,
      ...(reading.fiveHour === null ? {} : {
        fiveHourObservedAt: reading.observedAt,
        fiveHourSource: reading.source,
        fiveHourConfidence: reading.confidence,
      }),
      ...(reading.weekly === null ? {} : {
        weeklyObservedAt: reading.observedAt,
        weeklySource: reading.source,
        weeklyConfidence: reading.confidence,
      }),
    }));
    const limit = this.resolvedLimits().find((candidate) =>
      scopeKey(candidate) === scopeKey(scope)
    );
    if (limit !== undefined) await this.alertPool(limit, this.clock());
  }

  /**
   * Whether a routable pool for this provider already carries a live reading in
   * both windows. Only a measurement counts: a manual pool sitting on Hive's own
   * `estimated` ledger has never been read from the provider, and skipping its
   * probe would be how an operator's override silently disables discovery.
   */
  private hasFreshReading(provider: "claude" | "codex", now: Date): boolean {
    const live = (confidence: QuotaConfidence): boolean =>
      confidence === "authoritative" || confidence === "reported";
    return this.resolvedLimits()
      .filter((limit) => limit.provider === provider && limit.routable)
      .some((limit) => {
        const status = this.statusForLimit(limit, now);
        return live(status.fiveHour.confidence) && live(status.weekly.confidence);
      });
  }

  /** Why a provider's live numbers are missing, if they are. */
  probeError(provider: "claude" | "codex"): string | null {
    return this.probeErrors.get(provider) ?? null;
  }

  refreshedAt(): string | null {
    return this.lastRefreshAt?.toISOString() ?? null;
  }

  /**
   * True when the last refresh is older than the configured interval, or when a
   * routable pool has gone blind — a passed reset voids the reading that
   * described the old window, and Hive would rather re-read than route on a
   * number it can no longer vouch for.
   */
  needsRefresh(now = this.clock()): boolean {
    if (!this.config.discovery) return false;
    if (this.lastRefreshAt === null) return true;
    if (
      now.getTime() - this.lastRefreshAt.getTime() >=
        this.config.refreshIntervalMinutes * 60_000
    ) {
      return true;
    }
    return this.resolvedLimits()
      .filter((limit) => limit.routable && limit.unit === "percent")
      .some((limit) => {
        const status = this.statusForLimit(limit, now);
        return this.measured(status) === null;
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
      reservation.tier !== request.tier || reservation.purpose !== "control"
    ) {
      throw new Error(
        `Control reservation ${reservation.id} does not match the recorded execution identity for ${request.agentName}`,
      );
    }
    return reservation;
  }

  private windowBounds(limit: QuotaLimit, now: Date): {
    fiveHourStart: string;
    weeklyStart: string;
    weeklyEnd: string | null;
  } {
    if (limit.weeklyWindow === "calendar") {
      const weekly = calendarWeekBounds(now, limit);
      return {
        fiveHourStart: subtract(now, 5 * HOUR_MS),
        weeklyStart: weekly.start,
        weeklyEnd: weekly.end,
      };
    }
    return {
      fiveHourStart: subtract(now, 5 * HOUR_MS),
      weeklyStart: subtract(now, 7 * DAY_MS),
      weeklyEnd: null,
    };
  }

  private statusForLimit(
    limit: ResolvedQuotaLimit,
    now: Date,
  ): QuotaPoolStatus {
    const scope: QuotaScope = limit;
    const bounds = this.windowBounds(limit, now);
    const observation = this.ledger.getObservation(scope);
    const totals = this.ledger.usageTotals(
      scope,
      bounds.fiveHourStart,
      bounds.weeklyStart,
      {
        fiveHourObservedAt: observation?.fiveHourObservedAt ?? null,
        weeklyObservedAt: observation?.weeklyObservedAt ?? null,
      },
    );
    const fresh = (observedAt: string | null): boolean => {
      if (observedAt === null) return false;
      const age = now.getTime() - new Date(observedAt).getTime();
      return age >= 0 && age <= limit.observationMaxAgeMinutes * 60_000;
    };
    const valid = (resetAt: string | null | undefined): boolean =>
      resetAt === null || resetAt === undefined || new Date(resetAt) > now;

    /**
     * One window's facts. `observed` is null when nobody ever measured this
     * window; for a percent-denominated pool that makes usage genuinely unknown,
     * because Hive's own ledger cannot see what the human spent outside it. A
     * unit-denominated pool always has the operator's allowance and Hive's own
     * conservative ledger to fall back on, and says so by reporting `estimated`.
     */
    const windowStatus = (
      window: "fiveHour" | "weekly",
    ): QuotaWindowStatus => {
      const observedAt = observation?.[`${window}ObservedAt`] ?? null;
      const resetsAtRaw = observation?.[`${window}ResetAt`] ?? null;
      const observationValid = observedAt !== null && valid(resetsAtRaw);
      const ledgerUsed = window === "fiveHour" ? totals.fiveHour : totals.weekly;
      const reserved = window === "fiveHour"
        ? totals.reserved
        : totals.reservedWeekly;
      const allowance = window === "fiveHour"
        ? limit.fiveHourAllowance
        : limit.weeklyAllowance;
      const reportedUsed = observation?.[`${window}Used`] ?? 0;
      const afterObservation = window === "fiveHour"
        ? totals.afterFiveHourObservation
        : totals.afterWeeklyObservation;
      // The conservative combination from SPEC: an external reading and the local
      // ledger merge by max(), so an optimistic provider number can never free
      // capacity Hive already knows it spent.
      const supplemental = observationValid
        ? Math.max(0, reportedUsed + afterObservation - ledgerUsed)
        : 0;
      // A percent pool measures the *account*, which the human also spends from
      // outside Hive. Without a live reading — never taken, or voided by a reset
      // that has since passed — its usage is genuinely unknown. A unit pool can
      // still fall back on the operator's allowance and Hive's own ledger, and
      // reports that fallback as the estimate it is.
      const unmeasured = limit.unit === "percent" && !observationValid;
      const used = unmeasured ? null : ledgerUsed + supplemental;
      const remaining = used === null
        ? null
        : Math.max(0, allowance - used - reserved);
      const earliest = window === "fiveHour"
        ? this.ledger.earliestUsageAt(scope, bounds.fiveHourStart)
        : limit.weeklyWindow === "rolling"
          ? this.ledger.earliestUsageAt(scope, bounds.weeklyStart)
          : null;
      const fallbackReset = window === "fiveHour"
        ? (earliest === null ? null : add(new Date(earliest), 5 * HOUR_MS))
        : bounds.weeklyEnd ??
          (earliest === null ? null : add(new Date(earliest), 7 * DAY_MS));
      const confidence: QuotaConfidence = unmeasured
        ? "missing"
        : !observationValid
          ? "estimated"
          : fresh(observedAt)
            ? observation?.[`${window}Confidence`] ?? observation!.confidence
            : "stale";
      return {
        unit: limit.unit,
        allowance: used === null ? null : allowance,
        used,
        reserved,
        reservedIsEstimate: true,
        remaining,
        remainingPct: remaining === null ? null : remaining / allowance,
        resetsAt: (observationValid ? resetsAtRaw : null) ?? fallbackReset,
        confidence,
        source: unmeasured
          ? "none"
          : !observationValid
            ? "ledger"
            : observation?.[`${window}Source`] ?? observation!.source,
        observedAt: observationValid ? observedAt : null,
        windowMinutes: window === "fiveHour"
          ? limit.fiveHourWindowMinutes
          : limit.weeklyWindowMinutes,
      };
    };

    const fiveHour = windowStatus("fiveHour");
    const weekly = windowStatus("weekly");
    const anyFresh = fresh(fiveHour.observedAt) || fresh(weekly.observedAt);
    return {
      provider: limit.provider,
      account: limit.account,
      pool: limit.pool,
      origin: limit.origin,
      overridesDiscovered: limit.overridesDiscovered,
      models: limit.models,
      label: limit.label,
      routable: limit.routable,
      confidence: observation === null
        ? (limit.unit === "percent" ? "missing" : "estimated")
        : anyFresh
          ? observation.confidence
          : "stale",
      freshness: observation === null
        ? "missing"
        : anyFresh
          ? "fresh"
          : "stale",
      source: observation?.source ?? (limit.unit === "percent" ? "none" : "ledger"),
      fiveHour,
      weekly,
    };
  }

  statuses(now = this.clock()): QuotaStatus[] {
    const resolved = this.resolvedLimits();
    const seen = new Set<string>();
    const values: QuotaStatus[] = [];
    for (const limit of resolved) {
      const key = scopeKey(limit);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push({
        ...this.statusForLimit(limit, now),
        models: [...new Set(resolved
          .filter((candidate) => sameScope(candidate, limit))
          .flatMap((candidate) => candidate.models))],
      });
    }
    const trackedProviders = new Set<string>();
    for (const unconfigured of this.ledger.unconfiguredScopes()) {
      trackedProviders.add(unconfigured.provider);
      const totals = this.ledger.usageTotals(
        unconfigured,
        subtract(now, 5 * HOUR_MS),
        subtract(now, 7 * DAY_MS),
      );
      values.push(this.gapStatus(unconfigured.provider, unconfigured.model, {
        reserved: totals.reserved,
        fiveHourRecorded: totals.fiveHour,
        weeklyRecorded: totals.weekly,
      }));
    }
    // A provider with no routable pool has no live numbers. Say which provider,
    // and say why, instead of implying an operator forgot to fill in a file.
    for (const provider of ["claude", "codex"] as const) {
      if (trackedProviders.has(provider)) continue;
      if (resolved.some((limit) => limit.provider === provider && limit.routable)) {
        continue;
      }
      values.push(this.gapStatus(provider, "*", {
        reserved: 0,
        fiveHourRecorded: 0,
        weeklyRecorded: 0,
      }));
    }
    return values;
  }

  private gapStatus(
    provider: "claude" | "codex",
    model: string,
    recorded: {
      reserved: number;
      fiveHourRecorded: number;
      weeklyRecorded: number;
    },
  ): QuotaUnconfiguredStatus {
    const probeError = this.probeErrors.get(provider) ?? null;
    return {
      provider,
      model,
      configured: false,
      confidence: "missing",
      reason: probeError === null
        ? `Hive has not read live limits from ${provider} yet; usage is unknown and routing is unconstrained`
        : `Live limits from ${provider} are unavailable: ${probeError}`,
      probeError,
      ...recorded,
      recordedIsLocalEstimate: true,
    };
  }

  private supplemental(
    limit: ResolvedQuotaLimit,
    status: QuotaPoolStatus,
    now: Date,
  ): {
    five: number;
    week: number;
    fiveHourObservedAt: string | null;
    weeklyObservedAt: string | null;
  } {
    const bounds = this.windowBounds(limit, now);
    const observation = this.ledger.getObservation(limit);
    const cutoffs = {
      fiveHourObservedAt: observation?.fiveHourObservedAt ?? null,
      weeklyObservedAt: observation?.weeklyObservedAt ?? null,
    };
    const totals = this.ledger.usageTotals(
      limit,
      bounds.fiveHourStart,
      bounds.weeklyStart,
      cutoffs,
    );
    return {
      five: Math.max(0, (status.fiveHour.used ?? 0) - totals.fiveHour),
      week: Math.max(0, (status.weekly.used ?? 0) - totals.weekly),
      ...cutoffs,
    };
  }

  /**
   * A pool can only constrain a spawn when both windows have a measured usage.
   * An unmeasured window is unknown, and Hive will not subtract an estimate from
   * an unknown to manufacture headroom it cannot see.
   */
  private measured(status: QuotaPoolStatus): {
    fiveRemaining: number;
    weekRemaining: number;
  } | null {
    return status.fiveHour.remaining === null || status.weekly.remaining === null
      ? null
      : {
        fiveRemaining: status.fiveHour.remaining,
        weekRemaining: status.weekly.remaining,
      };
  }

  async routeAndReserve(request: QuotaRouteRequest): Promise<QuotaRouteDecision> {
    const now = this.clock();
    const preferred = request.reviewOfTool !== undefined &&
        request.tier === "review"
      ? (request.reviewOfTool === "claude" ? "codex" : "claude")
      : request.preferredTool;
    let candidates = request.candidates.filter((candidate) =>
      request.explicitTool === undefined || candidate.tool === request.explicitTool
    );
    if (candidates.length === 0) {
      throw new QuotaExhaustedError(
        `Requested provider ${request.explicitTool} has no route for ${request.tier}`,
      );
    }

    const evaluated = candidates.map((candidate) => {
      const limit = this.limitFor(candidate);
      if (limit === null) {
        return { candidate, limit, status: null, score: -1 };
      }
      const status = this.statusForLimit(limit, now);
      const measured = this.measured(status);
      if (measured === null) {
        // Unknown headroom scores exactly like an unknown pool: it cannot be
        // ranked against a measured one, and it routes in compatibility mode.
        return { candidate, limit: null, status: null, score: -1 };
      }
      const estimate = this.estimateFor(limit, request.tier);
      const fivePost = (measured.fiveRemaining - estimate.fiveHour) /
        limit.fiveHourAllowance;
      const weekPost = (measured.weekRemaining - estimate.weekly) /
        limit.weeklyAllowance;
      return {
        candidate,
        limit,
        status,
        score: Math.min(fivePost, weekPost),
      };
    });
    evaluated.sort((left, right) =>
      right.score - left.score ||
      Number(right.candidate.tool === preferred) -
        Number(left.candidate.tool === preferred) ||
      left.candidate.tool.localeCompare(right.candidate.tool)
    );

    const failures: string[] = [];
    let safeFallback: QuotaRouteCandidate | undefined;
    for (const item of evaluated) {
      if (item.limit === null || item.status === null) {
        const fallbackEstimate = this.config.estimates[request.tier]!;
        const reservation = this.ledger.insertUnboundedReservation({
          id: crypto.randomUUID(),
          agentName: request.agentName,
          provider: item.candidate.tool,
          account: "default",
          pool: `unconfigured:${item.candidate.model}`,
          model: item.candidate.model,
          tier: request.tier,
          estimatedUnits: fallbackEstimate,
          now: iso(now),
          expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
        });
        const status = this.gapStatus(item.candidate.tool, item.candidate.model, {
          reserved: fallbackEstimate,
          fiveHourRecorded: 0,
          weeklyRecorded: 0,
        });
        await this.alertUnknown(item.candidate, now);
        return {
          ...item.candidate,
          reservation,
          status,
          reason: `${item.candidate.tool} selected in compatibility mode`,
        };
      }
      const estimate = this.estimateFor(item.limit, request.tier);
      const bounds = this.windowBounds(item.limit, now);
      const supplemental = this.supplemental(item.limit, item.status, now);
      const preserveDeep = request.tier === "cheap" ||
        request.tier === "standard";
      const reservation = this.ledger.tryReserve({
        id: crypto.randomUUID(),
        agentName: request.agentName,
        provider: item.limit.provider,
        account: item.limit.account,
        pool: item.limit.pool,
        model: item.candidate.model,
        tier: request.tier,
        estimatedUnits: estimate.fiveHour,
        estimatedWeeklyUnits: estimate.weekly,
        now: iso(now),
        expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
        fiveHourStart: bounds.fiveHourStart,
        weeklyStart: bounds.weeklyStart,
        fiveHourObservedAt: supplemental.fiveHourObservedAt,
        weeklyObservedAt: supplemental.weeklyObservedAt,
        supplementalFiveHourUsed: supplemental.five,
        supplementalWeeklyUsed: supplemental.week,
        fiveHourAllowance: item.limit.fiveHourAllowance,
        weeklyAllowance: item.limit.weeklyAllowance,
        fiveHourFloor: preserveDeep
          ? item.limit.fiveHourAllowance * this.config.reserveFiveHourPct
          : 0,
        weeklyFloor: preserveDeep
          ? item.limit.weeklyAllowance * this.config.reserveWeeklyPct
          : 0,
      });
      if (reservation !== null) {
        if (request.explicitTool === undefined ||
          item.candidate.tool === request.explicitTool) {
          await this.alertPool(item.limit, now);
          return {
            ...item.candidate,
            reservation,
            status: this.statusForLimit(item.limit, now),
            reason: item.candidate.tool === preferred
              ? "preferred provider has the best safe headroom"
              : "preferred provider lacks safe headroom",
          };
        }
        safeFallback = item.candidate;
        this.ledger.release(reservation.id, iso(now));
      } else {
        const unit = item.limit.unit === "percent" ? "%" : "";
        failures.push(
          `${item.candidate.tool}/${item.candidate.model}: ` +
            `5h ${describeRemaining(item.status.fiveHour, unit)} remaining` +
            `${item.status.fiveHour.resetsAt ? ` (resets ${item.status.fiveHour.resetsAt})` : ""}, ` +
            `weekly ${describeRemaining(item.status.weekly, unit)} remaining` +
            `${item.status.weekly.resetsAt ? ` (resets ${item.status.weekly.resetsAt})` : ""}`,
        );
      }
    }

    if (request.explicitTool !== undefined) {
      const other = request.candidates.find((candidate) =>
        candidate.tool !== request.explicitTool
      );
      if (other !== undefined) {
        const otherLimit = this.limitFor(other);
        if (otherLimit !== null) {
          const otherStatus = this.statusForLimit(otherLimit, now);
          const measured = this.measured(otherStatus);
          const estimate = this.estimateFor(otherLimit, request.tier);
          const preserveDeep = request.tier === "cheap" ||
            request.tier === "standard";
          const fiveFloor = preserveDeep
            ? otherLimit.fiveHourAllowance * this.config.reserveFiveHourPct
            : 0;
          const weekFloor = preserveDeep
            ? otherLimit.weeklyAllowance * this.config.reserveWeeklyPct
            : 0;
          if (
            measured !== null &&
            measured.fiveRemaining - estimate.fiveHour >= fiveFloor &&
            measured.weekRemaining - estimate.weekly >= weekFloor
          ) {
            safeFallback ??= other;
          }
        }
      }
    }
    throw new QuotaExhaustedError(
      `Quota pressure makes this spawn unsafe. ${failures.join("; ")}` +
        (safeFallback === undefined
          ? ". No safe fallback is currently known."
          : `. Recommended fallback: ${safeFallback.tool}/${safeFallback.model}.`),
      safeFallback,
    );
  }

  async reserveControlRun(
    request: ControlQuotaRequest,
  ): Promise<QuotaReservation> {
    const existing = this.ledger.getActiveControlReservation(
      request.controlMessageId,
    );
    if (existing !== null) {
      return this.requireMatchingControlReservation(existing, request);
    }

    const now = this.clock();
    const limit = this.limitFor(request);
    const status = limit === null ? null : this.statusForLimit(limit, now);
    // A pool whose headroom is unknown cannot authorize or refuse a control run.
    // Accounting still happens: the run gets an explicit unbounded reservation.
    if (limit === null || status === null || this.measured(status) === null) {
      const reservation = this.ledger.insertUnboundedReservation({
        id: crypto.randomUUID(),
        agentName: request.agentName,
        provider: request.tool,
        account: "default",
        pool: `unconfigured:${request.model}`,
        model: request.model,
        tier: request.tier,
        estimatedUnits: this.config.estimates[request.tier]!,
        now: iso(now),
        expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
        purpose: "control",
        controlMessageId: request.controlMessageId,
      });
      await this.alertUnknown(request, now);
      return this.requireMatchingControlReservation(reservation, request);
    }

    const estimate = this.estimateFor(limit, request.tier);
    const bounds = this.windowBounds(limit, now);
    const supplemental = this.supplemental(limit, status, now);
    const reservation = this.ledger.tryReserve({
      id: crypto.randomUUID(),
      agentName: request.agentName,
      provider: limit.provider,
      account: limit.account,
      pool: limit.pool,
      model: request.model,
      tier: request.tier,
      estimatedUnits: estimate.fiveHour,
      estimatedWeeklyUnits: estimate.weekly,
      now: iso(now),
      expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
      fiveHourStart: bounds.fiveHourStart,
      weeklyStart: bounds.weeklyStart,
      fiveHourObservedAt: supplemental.fiveHourObservedAt,
      weeklyObservedAt: supplemental.weeklyObservedAt,
      supplementalFiveHourUsed: supplemental.five,
      supplementalWeeklyUsed: supplemental.week,
      fiveHourAllowance: limit.fiveHourAllowance,
      weeklyAllowance: limit.weeklyAllowance,
      // A critical acknowledgement may use the last safe capacity. It never
      // falls back to another provider or model, but it also must not preserve
      // a deep-work reserve at the expense of delivering the control.
      fiveHourFloor: 0,
      weeklyFloor: 0,
      purpose: "control",
      controlMessageId: request.controlMessageId,
    });
    if (reservation === null) {
      const unit = limit.unit === "percent" ? "%" : "";
      throw new QuotaExhaustedError(
        `Insufficient quota for critical control ${request.controlMessageId}: ` +
          `${request.tool}/${request.model} has ` +
          `${describeRemaining(status.fiveHour, unit)} five-hour and ` +
          `${describeRemaining(status.weekly, unit)} weekly remaining; ` +
          `${estimate.fiveHour.toFixed(1)}${unit} five-hour and ` +
          `${estimate.weekly.toFixed(1)}${unit} weekly are required. ` +
          "The agent remains write-revoked, " +
          "the worktree is preserved, and Hive will not switch models.",
      );
    }
    const matched = this.requireMatchingControlReservation(reservation, request);
    await this.alertPool(limit, now);
    return matched;
  }

  markStarted(reservationId: string, at = iso(this.clock())): void {
    this.ledger.markStarted(reservationId, at);
  }

  /**
   * Settle a reservation into recorded usage.
   *
   * Each window is debited its own amount. Committing the five-hour estimate to
   * the weekly ledger too would overstate weekly spend several-fold for a
   * percent-denominated pool — a run is a large slice of five hours and a small
   * slice of a week — and an overstated ledger refuses spawns that would have
   * fit. When the provider reports one actual figure and no weekly counterpart,
   * that figure is scaled by the ratio the reservation itself was estimated at.
   */
  async reconcile(
    reservationId: string,
    units?: number,
    source: "provider" | "gateway" | "estimated" = "estimated",
    at = iso(this.clock()),
    weeklyUnits?: number,
  ): Promise<void> {
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null) return;
    const estimatedWeekly = reservation.estimatedWeeklyUnits ??
      reservation.estimatedUnits;
    const ratio = reservation.estimatedUnits > 0
      ? estimatedWeekly / reservation.estimatedUnits
      : 1;
    this.ledger.reconcile(
      reservationId,
      units ?? reservation.estimatedUnits,
      weeklyUnits ?? (units === undefined ? estimatedWeekly : units * ratio),
      units === undefined ? "estimated" : source,
      at,
    );
    const limit = this.limitFor({
      tool: reservation.provider,
      model: reservation.model,
    });
    if (limit !== null) await this.alertPool(limit, new Date(at));
  }

  async cancel(
    reservationId: string,
    at = iso(this.clock()),
  ): Promise<void> {
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null || reservation.status !== "active") return;
    if (reservation.startedAt === null) {
      this.ledger.release(reservationId, at);
    } else {
      await this.reconcile(reservationId, undefined, "estimated", at);
    }
  }

  async recoverExpired(now = this.clock()): Promise<number> {
    return (await this.recoverExpiredReservations(now)).length;
  }

  async recoverExpiredReservations(
    now = this.clock(),
  ): Promise<QuotaReservation[]> {
    const expired = this.ledger.expired(iso(now));
    for (const reservation of expired) {
      await this.cancel(reservation.id, iso(now));
    }
    return expired;
  }

  /**
   * Record a Claude Code statusLine subscriber reading (five-hour/weekly used
   * percentage plus reset timestamps) as a semi-official "reported"
   * observation. Percentages are mapped onto the configured pool allowance.
   * Returns null when no pool is configured for the agent's model — the
   * conservative local estimates then remain the only Claude-side signal —
   * and never overwrites an equally fresh authoritative feed.
   */
  async observeStatusline(
    agent: { tool: "claude" | "codex"; model: string },
    report: {
      fiveHour?: { usedPct: number; resetsAt: string | null };
      sevenDay?: { usedPct: number; resetsAt: string | null };
      observedAt: string;
    },
  ): Promise<QuotaObservation | null> {
    if (report.fiveHour === undefined && report.sevenDay === undefined) {
      return null;
    }
    // A statusLine reading from an unconfigured install discovers the pool it
    // belongs to rather than being thrown away for want of a `quota.toml`.
    const limit = this.limitFor({ tool: agent.tool, model: agent.model }) ??
      this.discoverStatuslinePool(agent.tool, report.observedAt);
    const prior = this.ledger.getObservation(limit);
    if (
      prior !== null && prior.confidence === "authoritative" &&
      prior.observedAt >= report.observedAt
    ) {
      return null;
    }
    const scale = (usedPct: number, allowance: number): number =>
      limit.unit === "percent" ? usedPct : usedPct * allowance / 100;
    const observation = QuotaObservationSchema.parse({
      provider: limit.provider,
      account: limit.account,
      pool: limit.pool,
      fiveHourUsed: report.fiveHour === undefined
        ? prior?.fiveHourUsed ?? 0
        : scale(report.fiveHour.usedPct, limit.fiveHourAllowance),
      weeklyUsed: report.sevenDay === undefined
        ? prior?.weeklyUsed ?? 0
        : scale(report.sevenDay.usedPct, limit.weeklyAllowance),
      observedAt: report.observedAt,
      fiveHourResetAt: report.fiveHour?.resetsAt ??
        prior?.fiveHourResetAt ?? null,
      weeklyResetAt: report.sevenDay?.resetsAt ?? prior?.weeklyResetAt ?? null,
      source: "statusline",
      confidence: "reported",
      // Only the windows this payload actually carried are stamped. A statusLine
      // that reports the five-hour window alone leaves the weekly fact — and its
      // older timestamp — untouched.
      ...(report.fiveHour === undefined ? {} : {
        fiveHourObservedAt: report.observedAt,
        fiveHourSource: "statusline",
        fiveHourConfidence: "reported",
      }),
      ...(report.sevenDay === undefined ? {} : {
        weeklyObservedAt: report.observedAt,
        weeklySource: "statusline",
        weeklyConfidence: "reported",
      }),
    });
    // The statusLine refreshes every few hundred milliseconds; unchanged
    // readings are re-recorded at most every five minutes to keep freshness
    // current without write and alert churn.
    if (
      prior !== null && prior.source === "statusline" &&
      prior.fiveHourUsed === observation.fiveHourUsed &&
      prior.weeklyUsed === observation.weeklyUsed &&
      prior.fiveHourResetAt === observation.fiveHourResetAt &&
      prior.weeklyResetAt === observation.weeklyResetAt &&
      new Date(observation.observedAt).getTime() -
          new Date(prior.observedAt).getTime() < 5 * 60_000
    ) {
      return prior;
    }
    const value = this.ledger.upsertObservation(observation);
    await this.alertPool(limit, new Date(report.observedAt));
    return value;
  }

  /**
   * Register the pool a Claude statusLine reading belongs to. The provider does
   * not name it, so Hive uses the one pool a subscription actually has, and marks
   * the fact that it was learned from the statusLine rather than a probe.
   */
  private discoverStatuslinePool(
    provider: "claude" | "codex",
    observedAt: string,
  ): ResolvedQuotaLimit {
    this.ledger.upsertDiscoveredPool({
      provider,
      account: "default",
      pool: "subscription",
      models: ["*"],
      label: null,
      fiveHourWindowMinutes: 5 * 60,
      weeklyWindowMinutes: 7 * 24 * 60,
      discoveredAt: observedAt,
      source: "statusline",
    });
    return this.resolvedLimits().find((limit) =>
      limit.provider === provider && limit.pool === "subscription" &&
      limit.account === "default"
    )!;
  }

  async observe(
    observation: QuotaObservationInput,
  ): Promise<QuotaObservation> {
    const raw = QuotaObservationSchema.parse(observation);
    // A whole-pool observation — an operator's `hive quota reconcile`, say —
    // measured both windows at once, so both windows carry its provenance.
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
    const limit = this.resolvedLimits().find((candidate) =>
      candidate.provider === parsed.provider &&
      candidate.account === parsed.account &&
      candidate.pool === parsed.pool
    );
    if (limit === undefined) {
      throw new Error(
        `Quota pool is not known: ${parsed.provider}/${parsed.account}/${parsed.pool}`,
      );
    }
    const value = this.ledger.upsertObservation(parsed);
    await this.alertPool(limit, this.clock());
    return value;
  }

  private async sendAlert(body: string): Promise<void> {
    if (this.alertSink === null) return;
    try {
      await this.alertSink(body);
    } catch {
      // Quota accounting and routing must survive an unavailable root viewer.
      // MessageDelivery persists before attempting the wake, so normal failures
      // remain recoverable from the orchestrator inbox.
    }
  }

  /**
   * Hive could not read this provider's live limits, so it does not know the
   * account's headroom. It says exactly that. It does not tell the operator to go
   * fill in a configuration file — a hand-typed allowance is a guess, and a guess
   * is what this whole subsystem exists to avoid.
   */
  private async alertUnknown(
    candidate: QuotaRouteCandidate,
    now: Date,
  ): Promise<void> {
    const scope: QuotaScope = {
      provider: candidate.tool,
      account: "default",
      pool: `unconfigured:${candidate.model}`,
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
    const cause = this.probeErrors.get(candidate.tool);
    await this.sendAlert(
      `Hive could not read live quota limits from ${candidate.tool} for ` +
        `${candidate.model}, so this account's headroom is unknown. ` +
        (cause === undefined
          ? "No live reading has arrived yet. "
          : `Reason: ${cause}. `) +
        "The spawn proceeded on the legacy route and Hive is tracking a local " +
        "estimate of its own usage only. Hive will adopt real numbers " +
        "automatically as soon as the provider answers.",
    );
  }

  /** One durable, deduplicated message per provider outage — never a wall of them. */
  private async alertProbeFailure(
    provider: "claude" | "codex",
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

  private level(remainingPct: number): "normal" | "warning" | "critical" {
    if (remainingPct <= this.config.criticalRemainingPct) return "critical";
    if (remainingPct <= this.config.warningRemainingPct) return "warning";
    return "normal";
  }

  private severity(level: QuotaAlertState["level"]): number {
    return level === "critical" ? 2 : level === "warning" ? 1 : 0;
  }

  private async alertPool(limit: ResolvedQuotaLimit, now: Date): Promise<void> {
    const status = this.statusForLimit(limit, now);
    const unit = limit.unit === "percent" ? "%" : "";
    for (const [window, value] of [
      ["five-hour", status.fiveHour],
      ["weekly", status.weekly],
    ] as const) {
      // An unmeasured window cannot cross a threshold. Alerting on it would mean
      // thresholding a number Hive invented.
      if (value.remainingPct === null || value.allowance === null) continue;
      const current = this.level(value.remainingPct);
      const prior = this.ledger.getAlertState(limit, window);
      const boundaryChanged = prior?.boundaryAt !== null &&
        prior?.boundaryAt !== value.resetsAt &&
        (prior?.boundaryAt === undefined || new Date(prior.boundaryAt) <= now);
      let previousLevel = boundaryChanged ? "normal" : prior?.level ?? "normal";
      if (this.severity(current) < this.severity(previousLevel)) {
        const threshold = previousLevel === "critical"
          ? this.config.criticalRemainingPct
          : this.config.warningRemainingPct;
        if (value.remainingPct <= threshold + this.config.hysteresisPct) {
          continue;
        }
        previousLevel = current;
      }
      const notify = this.severity(current) > this.severity(previousLevel);
      this.ledger.setAlertState({
        provider: status.provider,
        account: status.account,
        pool: status.pool,
        window,
        level: current,
        notifiedAt: notify ? iso(now) : prior?.notifiedAt ?? null,
        boundaryAt: value.resetsAt,
      });
      if (notify) {
        await this.sendAlert(
          `Hive quota ${current}: ${status.provider}/${status.account}/${status.pool} ` +
            `${window} capacity has ${value.remaining!.toFixed(1)}${unit} of ` +
            `${value.allowance.toFixed(1)}${unit} remaining ` +
            `(${(value.remainingPct * 100).toFixed(0)}%), ` +
            `${value.reserved.toFixed(1)}${unit} reserved (estimated)` +
            `${value.resetsAt ? `, expected reset ${value.resetsAt}` : ", reset unknown"}. ` +
            `Telemetry is ${confidenceLabel(status)}.`,
        );
      }
    }
  }
}
