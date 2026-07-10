import {
  type QuotaConfig,
  type QuotaLimit,
  type QuotaObservation,
  type QuotaPoolStatus,
  type QuotaScope,
  type QuotaStatus,
  type RoutingTier,
} from "../schemas";
import {
  QuotaLedger,
  type QuotaAlertState,
  type QuotaReservation,
} from "./quota-ledger";

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

export class QuotaService {
  private alertSink: QuotaAlertSink | null = null;

  constructor(
    readonly ledger: QuotaLedger,
    readonly config: QuotaConfig,
    private readonly clock: QuotaClock = () => new Date(),
  ) {
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
   * Convert Codex app-server percentages into this ledger's configured units.
   * The provider windows are identified by duration instead of position: the
   * shortest window is the rolling five-hour bucket and the longest is the
   * weekly bucket. A partial snapshot is not promoted to authoritative data.
   */
  async observeCodexRateLimits(
    model: string,
    response: CodexRateLimitsResponse,
    observedAt = iso(this.clock()),
  ): Promise<CodexQuotaReading | null> {
    const limit = this.limitFor({ tool: "codex", model });
    if (limit === null) return null;

    const byId = response.rateLimitsByLimitId ?? {};
    const snapshot = byId[limit.pool] ??
      Object.values(byId).find((candidate) =>
        candidate.limitId === limit.pool
      ) ?? response.rateLimits;
    const windows = [snapshot.primary, snapshot.secondary]
      .filter((window): window is CodexRateLimitWindow => window !== null)
      .filter((window) =>
        Number.isFinite(window.usedPercent) && window.usedPercent >= 0 &&
        window.windowDurationMins !== null &&
        Number.isFinite(window.windowDurationMins)
      )
      .sort((left, right) =>
        left.windowDurationMins! - right.windowDurationMins!
      );
    if (windows.length < 2) return null;
    const fiveHour = windows[0]!;
    const weekly = windows.at(-1)!;
    const reading = {
      fiveHourUsed: limit.fiveHourAllowance * fiveHour.usedPercent / 100,
      weeklyUsed: limit.weeklyAllowance * weekly.usedPercent / 100,
    };
    await this.observe({
      provider: "codex",
      account: limit.account,
      pool: limit.pool,
      ...reading,
      observedAt,
      fiveHourResetAt: unixSecondsToIso(fiveHour.resetsAt),
      weeklyResetAt: unixSecondsToIso(weekly.resetsAt),
      source: "provider",
      confidence: "authoritative",
    });
    return reading;
  }

  private limitFor(candidate: QuotaRouteCandidate): QuotaLimit | null {
    return this.config.limits.find((limit) =>
      limit.provider === candidate.tool &&
      limit.models.includes(candidate.model)
    ) ?? this.config.limits.find((limit) =>
      limit.provider === candidate.tool && limit.models.includes("*")
    ) ?? null;
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

  private statusForLimit(limit: QuotaLimit, now: Date): QuotaPoolStatus {
    const scope: QuotaScope = limit;
    const bounds = this.windowBounds(limit, now);
    const observation = this.ledger.getObservation(scope);
    const totals = this.ledger.usageTotals(
      scope,
      bounds.fiveHourStart,
      bounds.weeklyStart,
      observation?.observedAt ?? null,
    );
    const observationAge = observation === null
      ? Number.POSITIVE_INFINITY
      : now.getTime() - new Date(observation.observedAt).getTime();
    const observationFresh = observation !== null && observationAge <=
      limit.observationMaxAgeMinutes * 60_000;
    const fiveObservationValid = observation !== null &&
      (observation.fiveHourResetAt === null ||
        new Date(observation.fiveHourResetAt) > now);
    const weeklyObservationValid = observation !== null &&
      (observation.weeklyResetAt === null ||
        new Date(observation.weeklyResetAt) > now);
    const supplementalFive = fiveObservationValid
      ? Math.max(
        0,
        observation!.fiveHourUsed + totals.afterObservation - totals.fiveHour,
      )
      : 0;
    const supplementalWeek = weeklyObservationValid
      ? Math.max(
        0,
        observation!.weeklyUsed + totals.afterObservation - totals.weekly,
      )
      : 0;
    const fiveUsed = totals.fiveHour + supplementalFive;
    const weeklyUsed = totals.weekly + supplementalWeek;
    const fiveRemaining = Math.max(
      0,
      limit.fiveHourAllowance - fiveUsed - totals.reserved,
    );
    const weeklyRemaining = Math.max(
      0,
      limit.weeklyAllowance - weeklyUsed - totals.reserved,
    );
    const earliestFive = this.ledger.earliestUsageAt(
      scope,
      bounds.fiveHourStart,
    );
    const earliestWeek = limit.weeklyWindow === "rolling"
      ? this.ledger.earliestUsageAt(scope, bounds.weeklyStart)
      : null;
    return {
      provider: limit.provider,
      account: limit.account,
      pool: limit.pool,
      models: limit.models,
      confidence: observation === null
        ? "estimated"
        : observationFresh
          ? observation.confidence
          : "stale",
      freshness: observation === null
        ? "missing"
        : observationFresh
          ? "fresh"
          : "stale",
      source: observation?.source ?? "ledger",
      fiveHour: {
        allowance: limit.fiveHourAllowance,
        used: fiveUsed,
        reserved: totals.reserved,
        remaining: fiveRemaining,
        remainingPct: fiveRemaining / limit.fiveHourAllowance,
        resetsAt: (fiveObservationValid ? observation?.fiveHourResetAt : null) ??
          (earliestFive === null
            ? null
            : add(new Date(earliestFive), 5 * HOUR_MS)),
      },
      weekly: {
        allowance: limit.weeklyAllowance,
        used: weeklyUsed,
        reserved: totals.reserved,
        remaining: weeklyRemaining,
        remainingPct: weeklyRemaining / limit.weeklyAllowance,
        resetsAt: (weeklyObservationValid ? observation?.weeklyResetAt : null) ??
          bounds.weeklyEnd ??
          (earliestWeek === null
            ? null
            : add(new Date(earliestWeek), 7 * DAY_MS)),
      },
    };
  }

  statuses(now = this.clock()): QuotaStatus[] {
    const seen = new Set<string>();
    const values: QuotaStatus[] = [];
    for (const limit of this.config.limits) {
      const key = scopeKey(limit);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push({
        ...this.statusForLimit(limit, now),
        models: [...new Set(this.config.limits
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
      values.push({
        provider: unconfigured.provider,
        model: unconfigured.model,
        configured: false,
        confidence: "missing",
        reason: "No matching allowance; compatibility routing is active",
        reserved: totals.reserved,
        fiveHourRecorded: totals.fiveHour,
        weeklyRecorded: totals.weekly,
      });
    }
    if (this.config.limits.length === 0) {
      for (const provider of ["claude", "codex"] as const) {
        if (trackedProviders.has(provider)) continue;
        values.push({
          provider,
          model: "*",
          configured: false,
          confidence: "missing",
          reason: "No allowance is configured; compatibility routing is active",
          reserved: 0,
          fiveHourRecorded: 0,
          weeklyRecorded: 0,
        });
      }
    }
    return values;
  }

  private supplemental(
    limit: QuotaLimit,
    status: QuotaPoolStatus,
    now: Date,
  ): { five: number; week: number; observationAt: string | null } {
    const bounds = this.windowBounds(limit, now);
    const observation = this.ledger.getObservation(limit);
    const totals = this.ledger.usageTotals(
      limit,
      bounds.fiveHourStart,
      bounds.weeklyStart,
      observation?.observedAt ?? null,
    );
    return {
      five: Math.max(0, status.fiveHour.used - totals.fiveHour),
      week: Math.max(0, status.weekly.used - totals.weekly),
      observationAt: observation?.observedAt ?? null,
    };
  }

  async routeAndReserve(request: QuotaRouteRequest): Promise<QuotaRouteDecision> {
    const now = this.clock();
    const estimate = this.config.estimates[request.tier];
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
      const fivePost = (status.fiveHour.remaining - estimate) /
        status.fiveHour.allowance;
      const weekPost = (status.weekly.remaining - estimate) /
        status.weekly.allowance;
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
        const reservation = this.ledger.insertUnboundedReservation({
          id: crypto.randomUUID(),
          agentName: request.agentName,
          provider: item.candidate.tool,
          account: "default",
          pool: `unconfigured:${item.candidate.model}`,
          model: item.candidate.model,
          tier: request.tier,
          estimatedUnits: estimate,
          now: iso(now),
          expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
        });
        const status: QuotaStatus = {
          provider: item.candidate.tool,
          model: item.candidate.model,
          configured: false,
          confidence: "missing",
          reason: "No matching quota allowance; compatibility routing is active",
          reserved: estimate,
          fiveHourRecorded: 0,
          weeklyRecorded: 0,
        };
        await this.alertUnknown(item.candidate, now);
        return {
          ...item.candidate,
          reservation,
          status,
          reason: `${item.candidate.tool} selected in compatibility mode`,
        };
      }
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
        estimatedUnits: estimate,
        now: iso(now),
        expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
        fiveHourStart: bounds.fiveHourStart,
        weeklyStart: bounds.weeklyStart,
        observationAt: supplemental.observationAt,
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
        failures.push(
          `${item.candidate.tool}/${item.candidate.model}: ` +
            `5h ${item.status.fiveHour.remaining.toFixed(1)} remaining` +
            `${item.status.fiveHour.resetsAt ? ` (resets ${item.status.fiveHour.resetsAt})` : ""}, ` +
            `weekly ${item.status.weekly.remaining.toFixed(1)} remaining` +
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
          const preserveDeep = request.tier === "cheap" ||
            request.tier === "standard";
          const fiveFloor = preserveDeep
            ? otherLimit.fiveHourAllowance * this.config.reserveFiveHourPct
            : 0;
          const weekFloor = preserveDeep
            ? otherLimit.weeklyAllowance * this.config.reserveWeeklyPct
            : 0;
          if (
            otherStatus.fiveHour.remaining - estimate >= fiveFloor &&
            otherStatus.weekly.remaining - estimate >= weekFloor
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
    const estimate = this.config.estimates[request.tier];
    const limit = this.limitFor(request);
    if (limit === null) {
      const reservation = this.ledger.insertUnboundedReservation({
        id: crypto.randomUUID(),
        agentName: request.agentName,
        provider: request.tool,
        account: "default",
        pool: `unconfigured:${request.model}`,
        model: request.model,
        tier: request.tier,
        estimatedUnits: estimate,
        now: iso(now),
        expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
        purpose: "control",
        controlMessageId: request.controlMessageId,
      });
      await this.alertUnknown(request, now);
      return this.requireMatchingControlReservation(reservation, request);
    }

    const status = this.statusForLimit(limit, now);
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
      estimatedUnits: estimate,
      now: iso(now),
      expiresAt: add(now, this.config.reservationTtlMinutes * 60_000),
      fiveHourStart: bounds.fiveHourStart,
      weeklyStart: bounds.weeklyStart,
      observationAt: supplemental.observationAt,
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
      throw new QuotaExhaustedError(
        `Insufficient quota for critical control ${request.controlMessageId}: ` +
          `${request.tool}/${request.model} has ` +
          `${status.fiveHour.remaining.toFixed(1)} five-hour and ` +
          `${status.weekly.remaining.toFixed(1)} weekly units remaining; ` +
          `${estimate.toFixed(1)} are required. The agent remains write-revoked, ` +
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

  async reconcile(
    reservationId: string,
    units?: number,
    source: "provider" | "gateway" | "estimated" = "estimated",
    at = iso(this.clock()),
  ): Promise<void> {
    const reservation = this.ledger.getReservation(reservationId);
    if (reservation === null) return;
    this.ledger.reconcile(
      reservationId,
      units ?? reservation.estimatedUnits,
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

  async observe(observation: QuotaObservation): Promise<QuotaObservation> {
    const limit = this.config.limits.find((candidate) =>
      candidate.provider === observation.provider &&
      candidate.account === observation.account &&
      candidate.pool === observation.pool
    );
    if (limit === undefined) {
      throw new Error(
        `Quota pool is not configured: ${observation.provider}/${observation.account}/${observation.pool}`,
      );
    }
    const value = this.ledger.upsertObservation(observation);
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
    await this.sendAlert(
      `Hive quota data is unconfigured for ${candidate.tool}/${candidate.model}. ` +
        "Hive is preserving the legacy route and tracking conservative estimates; " +
        "configure ~/.hive/quota.toml or run `hive quota reconcile` after adding a pool.",
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

  private async alertPool(limit: QuotaLimit, now: Date): Promise<void> {
    const status = this.statusForLimit(limit, now);
    for (const [window, value] of [
      ["five-hour", status.fiveHour],
      ["weekly", status.weekly],
    ] as const) {
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
            `${window} capacity has ${value.remaining.toFixed(1)}/${value.allowance.toFixed(1)} ` +
            `units remaining (${(value.remainingPct * 100).toFixed(0)}%), ` +
            `${value.reserved.toFixed(1)} reserved` +
            `${value.resetsAt ? `, expected reset ${value.resetsAt}` : ", reset unknown"}. ` +
            `Telemetry is ${confidenceLabel(status)}.`,
        );
      }
    }
  }
}
