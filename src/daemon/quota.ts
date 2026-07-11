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
  type DiscoveredQuotaPool,
  type QuotaAlertState,
  type QuotaReservation,
  type ReserveQuotaInput,
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
  /**
   * What the caller should say out loud about this route. A spawn that succeeds
   * with a pool near its limit, or that fell back off an exhausted model, is not
   * a silent success — the orchestrator is promised a warning under quota
   * pressure, and this is where it comes from. Empty when every governing pool
   * is comfortable.
   */
  warnings: string[];
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
  /** Unspent "full reset" grants. Hive reports them and never redeems one. */
  rateLimitResetCredits?: { availableCount?: number } | null;
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
  /** Unspent usage-limit reset grants, as the provider reports them. Read only. */
  private readonly resetCredits = new Map<"claude" | "codex", number>();
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
    const bind = this.poolBinder();
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
      const models = bind(pool);
      discovered.push({
        provider: pool.provider,
        account: pool.account,
        pool: pool.pool,
        models,
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
        routable: models.length > 0,
        label: pool.label,
        overridesDiscovered: false,
        fiveHourWindowMinutes: pool.fiveHourWindowMinutes,
        weeklyWindowMinutes: pool.weeklyWindowMinutes,
      });
    }
    return [...manual, ...discovered];
  }

  /**
   * Join a discovered pool to the models it meters, using the provider's own
   * model catalog.
   *
   * A quota payload names its sub-pools the way the vendor's model catalog names
   * its models — `"Fable"`, `"GPT-5.3-Codex-Spark"` — but carries no model id
   * (Claude reports `scope.model.id: null` beside the display name). The catalog
   * carries both, so the binding is discovered by matching the pool's own label
   * against the provider's own display names. Nothing is hardcoded and nothing is
   * guessed: a pool whose label matches no model in the catalog binds to nothing,
   * stays unroutable, and says so — which is the honest state for a pool whose
   * subject Hive cannot identify.
   *
   * A pool the provider already scoped to every model keeps its wildcard.
   */
  private poolBinder(): (pool: DiscoveredQuotaPool) => string[] {
    const byDisplayName = new Map<string, Set<string>>();
    for (const entry of this.ledger.modelCatalog()) {
      const key = `${entry.provider}\0${entry.displayName.toLowerCase()}`;
      const models = byDisplayName.get(key) ?? new Set<string>();
      models.add(entry.modelId);
      byDisplayName.set(key, models);
    }
    return (pool) => {
      if (pool.models.includes("*")) return ["*"];
      if (pool.label === null) return [];
      const key = `${pool.provider}\0${pool.label.toLowerCase()}`;
      return [...byDisplayName.get(key) ?? []].sort();
    };
  }

  /**
   * Every pool that meters this model — not the first one that matches.
   *
   * A model with its own cap spends from two meters at once: the account-wide
   * pool everything draws on, and its own. Returning just one of them is what let
   * a Fable spawn be checked against the general pool's 61% while Fable's own
   * pool sat at 99% and never entered the decision. Both govern; the tighter one
   * decides. A model with no cap of its own is metered by the general pool alone,
   * which is the ordinary case and is not a gap in coverage.
   */
  private limitsFor(candidate: QuotaRouteCandidate): ResolvedQuotaLimit[] {
    const routable = this.resolvedLimits().filter((limit) =>
      limit.routable && limit.provider === candidate.tool
    );
    const general = routable.filter((limit) => limit.models.includes("*"));
    const specific = routable.filter((limit) =>
      !limit.models.includes("*") && limit.models.includes(candidate.model)
    );
    return [...general, ...specific];
  }

  /** The pool a run is booked against: its own cap if it has one, else general. */
  private limitFor(candidate: QuotaRouteCandidate): ResolvedQuotaLimit | null {
    const limits = this.limitsFor(candidate);
    return limits.at(-1) ?? null;
  }

  /**
   * Which pools meter this model, and what each of them currently reads. This is
   * the question "how much quota does this model have left?" actually reduces to,
   * and before this it had no answer: a model's numbers were whatever single pool
   * happened to match it first.
   */
  poolsGoverning(
    candidate: QuotaRouteCandidate,
    now = this.clock(),
  ): QuotaPoolStatus[] {
    return this.limitsFor(candidate).map((limit) =>
      this.statusForLimit(limit, now)
    );
  }

  /** The account-wide pool: what every model spends from, whatever else it has. */
  private generalLimit(
    provider: "claude" | "codex",
  ): ResolvedQuotaLimit | null {
    return this.resolvedLimits().find((limit) =>
      limit.routable && limit.provider === provider &&
      limit.models.includes("*")
    ) ?? null;
  }

  /**
   * Point an agent's in-flight reservation at the model it is really running.
   *
   * Hive records a model when it spawns an agent, and a human is free to switch
   * models in that session afterwards — which is normal, supported, and
   * invisible to the spawn-time record. The reservation then holds capacity in
   * the wrong meter: quota booked against `claude-fable-5` while the session
   * actually burns the general subscription pool as Opus, or worse the reverse,
   * where a switch *onto* a capped model spends a cap nothing is holding.
   *
   * What this does, and does not do: the reservation is a forward-looking
   * estimate that has not been reconciled yet, so it is moved wholesale onto the
   * pools that meter the new model. Usage already reconciled into the ledger is
   * left exactly where it is. Nothing records *when* mid-run the switch
   * happened, so splitting past spend between two pools would mean inventing the
   * split — and an invented number is worse than a misfiled one, because it
   * looks like a measurement.
   *
   * The re-keyed reservation is written whether or not the new pool has room: the
   * agent is already running and refusing the booking would not stop it. Pretending
   * the capacity is not being spent is exactly the blindness this whole change
   * exists to end — so the spend is recorded, and the pool alerts if it is over.
   */
  async reconcileAgentModel(
    agentName: string,
    liveModel: string,
    at = iso(this.clock()),
  ): Promise<QuotaReservation[] | null> {
    const held = this.ledger.getActiveReservationForAgent(agentName);
    if (held === null || held.model === liveModel) return null;
    const now = new Date(at);
    const candidate = { tool: held.provider, model: liveModel };
    const entries = this.limitsFor(candidate).map((limit) => ({
      limit,
      status: this.statusForLimit(limit, now),
    }));
    if (entries.length === 0) return null;
    // Release first, then re-book: the released capacity is immediately
    // available to the pools the run is really spending from, and a run can
    // never be counted twice while the swap is in flight.
    this.ledger.release(held.id, at);
    const reservations = this.ledger.reserveGroupUnchecked(
      this.reservationInputs(
        held.agentName,
        candidate,
        entries,
        held.tier,
        now,
        held.purpose === "control" && held.controlMessageId !== null
          ? { purpose: "control", controlMessageId: held.controlMessageId }
          : undefined,
      ),
    );
    for (const entry of entries) await this.alertPool(entry.limit, now);
    return reservations;
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

  /** One reservation per pool the run spends from; the first is the primary. */
  private reservationInputs(
    agentName: string,
    candidate: QuotaRouteCandidate,
    entries: { limit: ResolvedQuotaLimit; status: QuotaPoolStatus }[],
    tier: RoutingTier,
    now: Date,
    purpose?: { purpose: "control"; controlMessageId: string },
  ): ReserveQuotaInput[] {
    // Cheap and standard work leaves a floor untouched so a deep run still has
    // somewhere to land. A deep run itself is allowed to spend down to the line.
    const preserveDeep = tier === "cheap" || tier === "standard";
    return entries.map((entry) => {
      const estimate = this.estimateFor(entry.limit, tier);
      const bounds = this.windowBounds(entry.limit, now);
      const supplemental = this.supplemental(entry.limit, entry.status, now);
      // A window this pool does not meter cannot refuse the run. Handing the
      // ledger an unbounded allowance for it says exactly that, and keeps the
      // metered window — the weekly cap that actually governs — doing the gating.
      const allowanceFor = (window: "fiveHour" | "weekly"): number =>
        this.meters(entry.limit, entry.status, window)
          ? (window === "fiveHour"
            ? entry.limit.fiveHourAllowance
            : entry.limit.weeklyAllowance)
          : Number.POSITIVE_INFINITY;
      return {
        id: crypto.randomUUID(),
        agentName,
        provider: entry.limit.provider,
        account: entry.limit.account,
        pool: entry.limit.pool,
        model: candidate.model,
        tier,
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
        fiveHourAllowance: allowanceFor("fiveHour"),
        weeklyAllowance: allowanceFor("weekly"),
        fiveHourFloor: preserveDeep
          ? entry.limit.fiveHourAllowance * this.config.reserveFiveHourPct
          : 0,
        weeklyFloor: preserveDeep
          ? entry.limit.weeklyAllowance * this.config.reserveWeeklyPct
          : 0,
        ...(purpose ?? {}),
      };
    });
  }

  /**
   * Is this route currently known not to start? Returns the moment it becomes
   * eligible again, or null when nothing is holding it back.
   *
   * Eligibility is headroom *and* viability. Ranking on headroom alone is what
   * made this necessary: Codex sitting at 0% weekly outscores Claude at 63% every
   * time, so the emptiest pool silently outranked the question of whether a route
   * could produce a working agent at all — and a gate that refuses an exhausted
   * model only to hand the work to a route that cannot start has protected
   * nothing.
   *
   * Nothing here knows the name of a vendor or a tier. It reports what happened
   * when Hive last tried, and it forgets on a schedule.
   */
  private quarantinedUntil(
    candidate: QuotaRouteCandidate,
    now: Date,
  ): { until: string; reason: string } | null {
    const health = this.ledger.routeHealth(candidate.tool, candidate.model);
    if (
      health === null || health.consecutiveFailures === 0 ||
      health.lastFailureAt === null
    ) {
      return null;
    }
    // Repeat failures hold the route back longer, but never indefinitely: the
    // cooldown is capped so a route always gets retried and can always come back.
    const minutes = Math.min(
      this.config.launchQuarantineMinutes * health.consecutiveFailures,
      this.config.launchQuarantineMinutes * 4,
    );
    const until = add(new Date(health.lastFailureAt), minutes * 60_000);
    return new Date(until) <= now ? null : {
      until,
      reason: health.lastFailureReason ?? "a previous launch never proved life",
    };
  }

  /** An agent came up. Whatever we thought about this route, it works. */
  noteLaunchSucceeded(
    candidate: QuotaRouteCandidate,
    at = iso(this.clock()),
  ): void {
    this.ledger.recordLaunchSuccess(candidate.tool, candidate.model, at);
  }

  /**
   * Could this candidate be launched right now? Every pool that meters it must
   * have room — a model whose own cap is spent has no room even when the general
   * pool is wide open, so it is never offered as a fallback.
   */
  private hasRoom(
    candidate: QuotaRouteCandidate,
    tier: RoutingTier,
    now: Date,
  ): boolean {
    // A route that cannot start is not a fallback, whatever its headroom says.
    if (this.quarantinedUntil(candidate, now) !== null) return false;
    const limits = this.limitsFor(candidate);
    const preserveDeep = tier === "cheap" || tier === "standard";
    const checked = limits.map((limit) => {
      const status = this.statusForLimit(limit, now);
      const measured = this.measured(status, limit);
      if (measured === null) return null;
      const estimate = this.estimateFor(limit, tier);
      const fiveFloor = preserveDeep
        ? limit.fiveHourAllowance * this.config.reserveFiveHourPct
        : 0;
      const weekFloor = preserveDeep
        ? limit.weeklyAllowance * this.config.reserveWeeklyPct
        : 0;
      return measured.fiveRemaining - estimate.fiveHour >= fiveFloor &&
        measured.weekRemaining - estimate.weekly >= weekFloor;
    });
    // A fallback is only recommended when Hive can actually see that it fits.
    // Every pool that could be checked must have room, and at least one must have
    // been checkable — an unmeasured model is not a *safe* fallback, it is an
    // unknown one, and recommending it would be the same false confidence that
    // put two agents on an exhausted model.
    return checked.some((room) => room !== null) &&
      checked.every((room) => room !== false);
  }

  /** The pool with the least room: the one that actually governs the run. */
  private tightest(
    entries: { limit: ResolvedQuotaLimit; status: QuotaPoolStatus }[],
  ): { limit: ResolvedQuotaLimit; status: QuotaPoolStatus } {
    const room = (entry: { limit: ResolvedQuotaLimit; status: QuotaPoolStatus }) =>
      Math.min(
        entry.status.fiveHour.remainingPct ?? Number.POSITIVE_INFINITY,
        entry.status.weekly.remainingPct ?? Number.POSITIVE_INFINITY,
      );
    return entries.reduce((tightest, entry) =>
      room(entry) < room(tightest) ? entry : tightest
    );
  }

  /** Which pool blocked this route, how much is left, and when it comes back. */
  private describeBlock(
    candidate: QuotaRouteCandidate,
    limit: ResolvedQuotaLimit,
    status: QuotaPoolStatus,
  ): string {
    const unit = limit.unit === "percent" ? "%" : "";
    const window = (name: "fiveHour" | "weekly"): string =>
      `${describeRemaining(status[name], unit)} remaining` +
      (status[name].resetsAt === null
        ? ""
        : ` (resets ${status[name].resetsAt})`);
    const scope = limit.models.includes("*")
      ? `${limit.provider} general pool ${limit.pool}`
      : `${limit.provider} pool ${limit.pool}`;
    const windows = this.meters(limit, status, "fiveHour")
      ? `5h ${window("fiveHour")}, weekly ${window("weekly")}`
      : `weekly ${window("weekly")}`;
    return `${candidate.tool}/${candidate.model} is blocked by ${scope}: ${windows}`;
  }

  /**
   * A route that squeaked through on a pool near its limit is not a clean
   * success. The orchestrator is promised a warning under quota pressure, so a
   * governing pool below the warning threshold — after this run's own estimated
   * cost — says so by name.
   */
  private pressureWarnings(
    candidate: QuotaRouteCandidate,
    entries: { limit: ResolvedQuotaLimit; status: QuotaPoolStatus }[],
    tier: RoutingTier,
  ): string[] {
    const warnings: string[] = [];
    for (const entry of entries) {
      const measured = this.measured(entry.status, entry.limit);
      if (measured === null) {
        if (!entry.limit.models.includes("*")) {
          warnings.push(
            `${entry.limit.provider} pool ${entry.limit.pool} meters ` +
            `${candidate.model} but has no live reading, so it could not be checked.`,
          );
        }
        continue;
      }
      const estimate = this.estimateFor(entry.limit, tier);
      const after = Math.min(
        (measured.fiveRemaining - estimate.fiveHour) /
          entry.limit.fiveHourAllowance,
        (measured.weekRemaining - estimate.weekly) / entry.limit.weeklyAllowance,
      );
      if (after > this.config.warningRemainingPct) continue;
      const unit = entry.limit.unit === "percent" ? "%" : "";
      const tightWindow =
        (measured.weekRemaining - estimate.weekly) / entry.limit.weeklyAllowance <
            (measured.fiveRemaining - estimate.fiveHour) /
              entry.limit.fiveHourAllowance
          ? "weekly"
          : "fiveHour";
      const status = entry.status[tightWindow];
      warnings.push(
        `${entry.limit.provider} pool ${entry.limit.pool} is at ` +
        `${describeRemaining(status, unit)} remaining ` +
        `(${tightWindow === "weekly" ? "weekly" : "5h"} window` +
        `${status.resetsAt === null ? "" : `, resets ${status.resetsAt}`}) ` +
        `after this ${tier} run.`,
      );
    }
    return warnings;
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
      // The catalog is what binds a metered sub-pool to the models it gates, so
      // it is stored before the pools that depend on it are resolved.
      this.ledger.upsertModelCatalog(result.catalog.map((entry) => ({
        ...entry,
        discoveredAt: iso(now),
      })));
      if (result.resetCredits !== undefined) {
        this.resetCredits.set(probe.provider, result.resetCredits);
      }
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
      // A measurement beats an estimate. The provider's reading already counts
      // everything spent before it was taken — Hive's own runs included — so the
      // only spend it cannot know about is what happened *after* it. That, and
      // only that, is what Hive adds.
      //
      // Hive used to take max(its whole ledger, the reading), on the reasoning
      // that an optimistic provider number must never free capacity Hive knew it
      // had spent. But Hive never knew: those ledger rows are its own
      // `estimatesPct` guesses, written at `confidence: "estimated"`. The floor
      // therefore let a guess outrank a measurement, and it did — on 2026-07-11
      // Codex reported 0% of the weekly window used, Hive's estimates summed to
      // 12%, and `hive quota` published 12% under `source: provider,
      // confidence: authoritative`. The user could see the real number on his own
      // screen. A confidently wrong number is worse than an admitted unknown, and
      // an estimate wearing a measurement's badge is the worst of both.
      const unverified = observationValid ? afterObservation : 0;
      // A percent pool measures the *account*, which the human also spends from
      // outside Hive. Without a live reading — never taken, or voided by a reset
      // that has since passed — its usage is genuinely unknown. A unit pool can
      // still fall back on the operator's allowance and Hive's own ledger, and
      // reports that fallback as the estimate it is.
      const unmeasured = limit.unit === "percent" && !observationValid;
      const used = unmeasured
        ? null
        : observationValid
          ? reportedUsed + unverified
          : ledgerUsed;
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
      // The label describes the number actually being published, not the reading
      // it was built from. A measured base with Hive's own estimate of the spend
      // since is partly a guess, and calling it `authoritative` would be a claim
      // Hive cannot support — `authoritative` is the strongest thing this system
      // ever says, so it is reserved for a figure the provider alone produced.
      const confidence: QuotaConfidence = unmeasured
        ? "missing"
        : !observationValid
          ? "estimated"
          : !fresh(observedAt)
            ? "stale"
            : unverified > 0
              ? "estimated"
              : observation?.[`${window}Confidence`] ?? observation!.confidence;
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
      // A model that a live pool now meters is not an unmetered model, whatever
      // an old compatibility-mode reservation left lying in the ledger. Opus has
      // no dedicated meter and never did — it is metered by the general
      // subscription pool like every other Claude model without one — so
      // reporting it as an uncovered gap invented a pool that does not exist and
      // advertised the healthiest model on the plan as "unconstrained", which is
      // the single most attractive thing a router can be told. The stale rows stay
      // for accounting; they are no longer rendered as a hole in coverage.
      if (
        this.limitsFor({
          tool: unconfigured.provider,
          model: unconfigured.model,
        }).length > 0
      ) {
        continue;
      }
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
    // What the ledger does *not* already account for. The reserve path adds the
    // ledger's own total back on top of this, so handing it `used - ledgerUsed`
    // makes the committed figure come out at exactly `used` — the same number
    // `hive quota` publishes. It is deliberately allowed to go negative: when
    // Hive's estimates have over-counted against what the provider actually
    // measured, the correction must be able to give that headroom back, or the
    // gate would go on refusing spawns on the strength of a fiction the provider
    // has already contradicted.
    return {
      five: (status.fiveHour.used ?? 0) - totals.fiveHour,
      week: (status.weekly.used ?? 0) - totals.weekly,
      ...cutoffs,
    };
  }

  /**
   * A pool can only constrain a spawn when every window it meters has a measured
   * usage. An unmeasured window is unknown, and Hive will not subtract an
   * estimate from an unknown to manufacture headroom it cannot see.
   *
   * A window the provider does not meter for this pool is a different thing
   * entirely, and must not be read as unknown. Claude's model-scoped caps are
   * weekly-only: Fable's pool has no five-hour window at all. Treating that
   * absence as "unmeasured" would make the pool permanently unknowable, and an
   * unknowable pool constrains nothing — the 99% weekly number would go right on
   * being ignored, which is the bug this exists to prevent.
   */
  private meters(
    limit: ResolvedQuotaLimit,
    status: QuotaPoolStatus,
    window: "fiveHour" | "weekly",
  ): boolean {
    const declared = window === "fiveHour"
      ? limit.fiveHourWindowMinutes
      : limit.weeklyWindowMinutes;
    return declared !== null || status[window].observedAt !== null;
  }

  private measured(
    status: QuotaPoolStatus,
    limit?: ResolvedQuotaLimit,
  ): { fiveRemaining: number; weekRemaining: number } | null {
    const unbounded = Number.POSITIVE_INFINITY;
    const read = (window: "fiveHour" | "weekly"): number | null => {
      if (limit !== undefined && !this.meters(limit, status, window)) {
        return unbounded;
      }
      return status[window].remaining;
    };
    const fiveRemaining = read("fiveHour");
    const weekRemaining = read("weekly");
    return fiveRemaining === null || weekRemaining === null
      ? null
      : { fiveRemaining, weekRemaining };
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
      const entries = this.limitsFor(candidate).map((limit) => ({
        limit,
        status: this.statusForLimit(limit, now),
      }));
      // Compatibility mode is for a provider Hive has no number for at all — not
      // for a run that merely has one dark meter among several. As long as *some*
      // governing pool is measured, the run is constrained by it: a Fable pool
      // read at 99% still refuses the spawn even if the general pool has gone
      // stale, and a measured general pool still gates a model whose own cap has
      // not been read yet. Only when every pool that meters this model is unknown
      // does Hive admit that it cannot judge.
      const known = entries.filter((entry) =>
        this.measured(entry.status, entry.limit) !== null
      );
      if (entries.length === 0 || known.length === 0) {
        return { candidate, entries: [], score: -1, unknown: true };
      }
      let score = Number.POSITIVE_INFINITY;
      for (const entry of entries) {
        const measured = this.measured(entry.status, entry.limit);
        if (measured === null) continue;
        const estimate = this.estimateFor(entry.limit, request.tier);
        score = Math.min(
          score,
          (measured.fiveRemaining - estimate.fiveHour) /
            entry.limit.fiveHourAllowance,
          (measured.weekRemaining - estimate.weekly) /
            entry.limit.weeklyAllowance,
        );
      }
      return { candidate, entries, score, unknown: false };
    });
    evaluated.sort((left, right) =>
      right.score - left.score ||
      Number(right.candidate.tool === preferred) -
        Number(left.candidate.tool === preferred) ||
      left.candidate.tool.localeCompare(right.candidate.tool)
    );

    // Viability, before headroom gets a vote. A route Hive has just watched fail
    // to produce a working agent is not a route, however much quota it has.
    const quarantine = new Map<
      typeof evaluated[number],
      { until: string; reason: string }
    >();
    for (const item of evaluated) {
      const held = this.quarantinedUntil(item.candidate, now);
      if (held !== null) quarantine.set(item, held);
    }
    const viable = evaluated.filter((item) => !quarantine.has(item));
    // If every route is quarantined, try anyway rather than refuse everything.
    // Hive's own recent bad luck is a weaker fact than a human needing an agent,
    // and this is also what lets a single explicitly-pinned model still launch:
    // an explicit directive is not overridden by a cooldown. It warns, loudly.
    const attemptable = viable.length > 0 ? viable : evaluated;
    const quarantineWarnings = attemptable === evaluated
      ? [...quarantine.values()].map((held) =>
        `Every candidate route recently failed to start (${held.reason}); ` +
        `launching anyway because there is no alternative.`
      )
      : [...quarantine.entries()].map(([item, held]) =>
        `${item.candidate.tool}/${item.candidate.model} was passed over: it ` +
        `failed to start (${held.reason}) and is retried after ${held.until}.`
      );

    const failures: string[] = [];
    let safeFallback: QuotaRouteCandidate | undefined;
    for (const item of attemptable) {
      if (item.unknown) {
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
          warnings: [
            `Hive has no live usage for ${item.candidate.tool}; ` +
            `${item.candidate.model} is running unconstrained.`,
            ...quarantineWarnings,
          ],
        };
      }
      const reserved = this.ledger.tryReserveGroup(
        this.reservationInputs(
          request.agentName,
          item.candidate,
          item.entries,
          request.tier,
          now,
        ),
      );
      if (!reserved.ok) {
        // Name the pool that refused, not just the model. "Fable is blocked" is
        // useless without which meter blocked it, how much is left, and when it
        // comes back — the caller has to be able to act on this.
        const blocked = item.entries.find((entry) =>
          entry.limit.pool === reserved.blockedBy.pool &&
          entry.limit.provider === reserved.blockedBy.provider &&
          entry.limit.account === reserved.blockedBy.account
        );
        failures.push(
          blocked === undefined
            ? `${item.candidate.tool}/${item.candidate.model}: no headroom`
            : this.describeBlock(item.candidate, blocked.limit, blocked.status),
        );
        continue;
      }
      const primary = reserved.reservations[0]!;
      const governing = this.tightest(item.entries);
      if (
        request.explicitTool === undefined ||
        item.candidate.tool === request.explicitTool
      ) {
        for (const entry of item.entries) await this.alertPool(entry.limit, now);
        return {
          ...item.candidate,
          reservation: primary,
          status: this.statusForLimit(governing.limit, now),
          reason: item.candidate.tool === preferred
            ? "preferred provider has the best safe headroom"
            : "preferred provider lacks safe headroom",
          warnings: [
            ...this.pressureWarnings(item.candidate, item.entries, request.tier),
            ...quarantineWarnings,
          ],
        };
      }
      safeFallback = item.candidate;
      this.ledger.release(primary.id, iso(now));
    }

    if (request.explicitTool !== undefined) {
      const other = request.candidates.find((candidate) =>
        candidate.tool !== request.explicitTool
      );
      if (other !== undefined && this.hasRoom(other, request.tier, now)) {
        safeFallback ??= other;
      }
    }
    const blockedProviders = new Set(
      attemptable.map((item) => item.candidate.tool),
    );
    throw new QuotaExhaustedError(
      `Quota pressure makes this spawn unsafe. ${failures.join("; ")}` +
        (safeFallback === undefined
          ? ". No safe fallback is currently known."
          : `. Recommended fallback: ${safeFallback.tool}/${safeFallback.model}.`) +
        quarantineWarnings.map((warning) => ` ${warning}`).join("") +
        this.describeResetCredits(blockedProviders),
      safeFallback,
    );
  }

  /**
   * Mention the unspent reset grants; never spend one.
   *
   * The account carries a finite number of "full reset" credits, readable in the
   * same free call as the limits. Hive will not redeem one to get its own way:
   * an agent that can quietly spend a human's scarce credits to unblock itself is
   * a bad agent, and the fact that it would look helpful is exactly what makes it
   * dangerous. The human is told the option exists and decides.
   */
  private describeResetCredits(providers: Set<"claude" | "codex">): string {
    const notes: string[] = [];
    for (const provider of providers) {
      const credits = this.resetCredits.get(provider) ?? 0;
      if (credits <= 0) continue;
      notes.push(
        ` ${provider} reports ${credits} unspent usage-limit reset ` +
        `${credits === 1 ? "credit" : "credits"}. Hive will not spend one on ` +
        `its own — redeem it yourself if you want this run to proceed now.`,
      );
    }
    return notes.join("");
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
    const entries = this.limitsFor(request).map((limit) => ({
      limit,
      status: this.statusForLimit(limit, now),
    }));
    // A run no pool can measure cannot be authorized or refused on the numbers.
    // Accounting still happens: the run gets an explicit unbounded reservation.
    const known = entries.filter((entry) =>
      this.measured(entry.status, entry.limit) !== null
    );
    if (known.length === 0) {
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

    // A critical acknowledgement may use the last safe capacity. It never falls
    // back to another provider or model, but it also must not preserve a
    // deep-work reserve at the expense of delivering the control — so the floors
    // the tier would normally protect are dropped to zero here.
    const inputs = this.reservationInputs(
      request.agentName,
      request,
      entries,
      request.tier,
      now,
      { purpose: "control", controlMessageId: request.controlMessageId },
    ).map((input) => ({ ...input, fiveHourFloor: 0, weeklyFloor: 0 }));
    const group = this.ledger.tryReserveGroup(inputs);
    const governing = this.tightest(entries);
    const limit = governing.limit;
    const status = governing.status;
    if (!group.ok) {
      const blocked = entries.find((entry) =>
        entry.limit.pool === group.blockedBy.pool &&
        entry.limit.provider === group.blockedBy.provider &&
        entry.limit.account === group.blockedBy.account
      ) ?? governing;
      const unit = blocked.limit.unit === "percent" ? "%" : "";
      const estimate = this.estimateFor(blocked.limit, request.tier);
      throw new QuotaExhaustedError(
        `Insufficient quota for critical control ${request.controlMessageId}: ` +
          `${this.describeBlock(request, blocked.limit, blocked.status)}; ` +
          `${estimate.fiveHour.toFixed(1)}${unit} five-hour and ` +
          `${estimate.weekly.toFixed(1)}${unit} weekly are required. ` +
          "The agent remains write-revoked, " +
          "the worktree is preserved, and Hive will not switch models.",
      );
    }
    const reservation = group.reservations[0]!;
    const matched = this.requireMatchingControlReservation(reservation, request);
    await this.alertPool(limit, now);
    return matched;
  }

  /**
   * The run proved life. That is the only evidence that a route works, so it is
   * also what clears the route: whatever Hive concluded from an earlier failed
   * launch, a working agent supersedes it, and the quarantine lifts at once.
   */
  markStarted(reservationId: string, at = iso(this.clock())): void {
    this.ledger.markStarted(reservationId, at);
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null) return;
    this.ledger.recordLaunchSuccess(
      reservation.provider,
      reservation.model,
      at,
    );
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

  /**
   * Settle a reservation whose run is over or never happened.
   *
   * `launchFailure` is the caller saying "this route did not produce a working
   * agent" — the spawn failed outright, not merely a worktree that could not be
   * created or a name that collided. Only that is evidence about the *route*, so
   * only that is recorded against it. Attributing an unrelated failure to a model
   * would quarantine a healthy route and make Hive the outage.
   */
  async cancel(
    reservationId: string,
    at = iso(this.clock()),
    launchFailure?: string,
  ): Promise<void> {
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null || reservation.status !== "active") return;
    if (launchFailure !== undefined && reservation.startedAt === null) {
      this.ledger.recordLaunchFailure(
        reservation.provider,
        reservation.model,
        launchFailure,
        at,
      );
    }
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
      /**
       * The model this session is *actually* running, as the statusLine payload
       * reports it. It is the live truth; the model Hive stored at spawn is a
       * guess that goes stale the moment a human switches models mid-session.
       * Sent with the agent's name so the run's reservation can be found and
       * moved onto the meter it is really spending from.
       */
      model?: string;
      agent?: string;
    },
  ): Promise<QuotaObservation | null> {
    if (report.model !== undefined && report.agent !== undefined) {
      await this.reconcileAgentModel(
        report.agent,
        report.model,
        report.observedAt,
      );
    }
    if (report.fiveHour === undefined && report.sevenDay === undefined) {
      return null;
    }
    // These percentages are the *account's* five-hour and seven-day windows, so
    // they belong to the pool that meters the account — never to a model's own
    // sub-pool. Writing them against the running model would file the general
    // pool's numbers under, say, `weekly:Fable`, overwriting a real 99% Fable
    // measurement with the account's 62% and destroying the very reading the
    // gate depends on. A statusLine reading from an unconfigured install still
    // discovers its pool rather than being thrown away for want of a
    // `quota.toml`; a manual pool that declares no wildcard keeps taking them.
    const limit = this.generalLimit(agent.tool) ??
      this.limitFor({ tool: agent.tool, model: agent.model }) ??
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
