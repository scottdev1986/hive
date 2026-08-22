import type { CapabilityProvider } from "../schemas/capability";
import type {
  QuotaConfidence,
  QuotaLimit,
  QuotaMeterState,
  QuotaPoolOrigin,
  QuotaPoolStatus,
  QuotaScope,
  QuotaUnconfiguredStatus,
  QuotaWindowStatus,
} from "../schemas/quota";
import type { QuotaLedger } from "./quota-ledger";
import {
  add,
  DAY_MS,
  HOUR_MS,
  rolledWindowBounds,
  subtract,
  windowBounds,
} from "./quota-windows";

/**
 * What a pool's numbers are, as opposed to what to do about them.
 *
 * This is the read side of quota: it turns a resolved pool plus the ledger's
 * stored facts into the status every display and every gate reads. It decides
 * nothing — admission, discovery, and reservations all live in the service
 * that calls this. The one rule it enforces throughout is that an unmeasured
 * window is unknown and never zero, because a confidently wrong number is
 * worse than an admitted unknown.
 */

/** A pool after discovery and overrides are folded together. `unit` decides how every number attached to it is read: a discovered pool is percent-denominated with an allowance of exactly 100, because providers report the fraction of a window consumed and never the window's absolute size. A manual pool keeps the user's own planning units. */
export interface ResolvedQuotaLimit extends QuotaLimit {
  origin: QuotaPoolOrigin;
  unit: "percent" | "units";
  routable: boolean;
  label: string | null;
  overridesDiscovered: boolean;
  fiveHourWindowMinutes: number | null;
  weeklyWindowMinutes: number | null;
  fiveHourMeterState: QuotaMeterState;
  weeklyMeterState: QuotaMeterState;
}

export function statusForLimit(
  ledger: QuotaLedger,
  limit: ResolvedQuotaLimit,
  now: Date,
): QuotaPoolStatus {
  const scope: QuotaScope = limit;
  const bounds = windowBounds(limit, now);
  const observation = ledger.getObservation(scope);
  const fresh = (observedAt: string | null): boolean => {
    if (observedAt === null) return false;
    const age = now.getTime() - new Date(observedAt).getTime();
    return age >= 0 && age <= limit.observationMaxAgeMinutes * 60_000;
  };
  const rolled = (window: "fiveHour" | "weekly") => {
    const observedAt = observation?.[`${window}ObservedAt`] ?? null;
    const meterState =
      window === "fiveHour" ? limit.fiveHourMeterState : limit.weeklyMeterState;
    if (observedAt === null || meterState === "not-metered") return null;
    return rolledWindowBounds(
      observation?.[`${window}ResetAt`],
      window === "fiveHour"
        ? limit.fiveHourWindowMinutes
        : limit.weeklyWindowMinutes,
      now,
    );
  };
  const fiveHourRoll = rolled("fiveHour");
  const weeklyRoll = rolled("weekly");
  const totals = ledger.usageTotals(
    scope,
    fiveHourRoll?.start ?? bounds.fiveHourStart,
    weeklyRoll?.start ?? bounds.weeklyStart,
  );
  const valid = (resetAt: string | null | undefined): boolean =>
    resetAt === null || resetAt === undefined || new Date(resetAt) > now;

  /** One window's facts. `observed` is null when nobody ever measured this window; for a percent-denominated pool that makes usage genuinely unknown, because Hive's own ledger cannot see what the user spent outside it. A unit-denominated pool always has the user's allowance and Hive's own conservative ledger to fall back on, and says so by reporting `estimated`. */
  const windowStatus = (window: "fiveHour" | "weekly"): QuotaWindowStatus => {
    const other = window === "fiveHour" ? "weekly" : "fiveHour";
    const observedAt = observation?.[`${window}ObservedAt`] ?? null;
    const resetsAtRaw = observation?.[`${window}ResetAt`] ?? null;
    const rolledBounds = window === "fiveHour" ? fiveHourRoll : weeklyRoll;
    const derivedObservedAt = rolledBounds?.start ?? null;
    // The reset starts a trustworthy zero, not a permanent one. Using it as the derived observation time lets the ordinary freshness rule return the window to unknown if the provider stays silent.
    const derivedFresh = fresh(derivedObservedAt);
    const windowMinutes =
      window === "fiveHour"
        ? limit.fiveHourWindowMinutes
        : limit.weeklyWindowMinutes;
    const meterState =
      window === "fiveHour" ? limit.fiveHourMeterState : limit.weeklyMeterState;
    const absenceObservedAt = observation?.[`${other}ObservedAt`] ?? null;
    const notMetered =
      limit.origin === "discovered" && meterState === "not-metered";
    if (notMetered) {
      return {
        availability: "not-metered",
        unit: limit.unit,
        allowance: null,
        used: null,
        reserved: null,
        reservedIsEstimate: null,
        remaining: null,
        remainingPct: null,
        resetsAt: null,
        confidence:
          observation?.[`${other}Confidence`] ??
          observation?.confidence ??
          "missing",
        source:
          observation?.[`${other}Source`] ?? observation?.source ?? "none",
        observedAt: absenceObservedAt,
        windowMinutes: null,
      };
    }
    const observationValid =
      observedAt !== null && rolledBounds === null && valid(resetsAtRaw);
    const ledgerUsed = window === "fiveHour" ? totals.fiveHour : totals.weekly;
    const reserved =
      window === "fiveHour" ? totals.reserved : totals.reservedWeekly;
    const allowance =
      window === "fiveHour" ? limit.fiveHourAllowance : limit.weeklyAllowance;
    const reportedUsed = observation?.[`${window}Used`] ?? 0;
    const afterObservation = derivedFresh
      ? ledgerUsed
      : window === "fiveHour"
        ? totals.afterFiveHourObservation
        : totals.afterWeeklyObservation;
    // A measurement beats an estimate. The provider's reading already counts everything spent before it was taken — Hive's own runs included — so the only spend it cannot know about is what happened *after* it. That, and only that, is what Hive adds. Do not take max(the whole ledger, the reading): ledger rows are Hive's own `estimatesPct` guesses, written at `confidence: "estimated"`. The floor therefore let a guess outrank a measurement. The user can see the real number on their own screen. A confidently wrong number is worse than an admitted unknown, and an estimate wearing a measurement's badge is the worst of both.
    const unverified = observationValid || derivedFresh ? afterObservation : 0;
    // A known reset is evidence about the new window even though it is not a new measurement. Without either a measurement or that boundary, a percent pool remains unknown because Hive cannot see spend outside itself.
    const unmeasured =
      limit.unit === "percent" && !observationValid && !derivedFresh;
    const used = unmeasured
      ? null
      : observationValid
        ? reportedUsed + unverified
        : derivedFresh
          ? unverified
          : ledgerUsed;
    const remaining =
      used === null ? null : Math.max(0, allowance - used - reserved);
    const earliest =
      limit.unit === "units"
        ? window === "fiveHour"
          ? ledger.earliestUsageAt(scope, bounds.fiveHourStart)
          : limit.weeklyWindow === "rolling"
            ? ledger.earliestUsageAt(scope, bounds.weeklyStart)
            : null
        : null;
    // A boundary the vendor stated is published whether or not anyone gauged the window. Reporting "reset unknown" about a reset the vendor named is a lie of omission, and it is what `hive quota` did for grok once its billing payload dropped the usage gauge and kept the period end (`readingsFromGrokBilling`). Usage stays `null` and availability stays `unknown`, so `drainedWindowFor` still cannot drain this pool — only the boundary is published, never a number nobody read.
    const statedReset =
      resetsAtRaw !== null && valid(resetsAtRaw) ? resetsAtRaw : null;
    const fallbackReset =
      limit.unit === "units"
        ? window === "fiveHour"
          ? earliest === null
            ? null
            : add(new Date(earliest), 5 * HOUR_MS)
          : (bounds.weeklyEnd ??
            (earliest === null ? null : add(new Date(earliest), 7 * DAY_MS)))
        : null;
    // The label describes the number actually being published, not the reading it was built from. A measured base with Hive's own estimate of the spend since is partly a guess, and calling it `authoritative` would be a claim Hive cannot support — `authoritative` is the strongest thing this system ever says, so it is reserved for a figure the provider alone produced.
    const confidence: QuotaConfidence = unmeasured
      ? "missing"
      : !observationValid
        ? "estimated"
        : !fresh(observedAt)
          ? "stale"
          : unverified > 0
            ? "estimated"
            : (observation?.[`${window}Confidence`] ??
              observation?.confidence ??
              "missing");
    return {
      availability: unmeasured ? "unknown" : "available",
      unit: limit.unit,
      allowance: used === null ? null : allowance,
      used,
      reserved,
      reservedIsEstimate: true,
      remaining,
      remainingPct: remaining === null ? null : remaining / allowance,
      resetsAt:
        rolledBounds?.end ??
        (observationValid ? resetsAtRaw : (statedReset ?? fallbackReset)),
      confidence,
      source: unmeasured
        ? "none"
        : !observationValid
          ? "ledger"
          : (observation?.[`${window}Source`] ?? observation?.source ?? "none"),
      observedAt: derivedFresh
        ? derivedObservedAt
        : observationValid
          ? observedAt
          : null,
      windowMinutes,
    };
  };

  const fiveHour = windowStatus("fiveHour");
  const weekly = windowStatus("weekly");
  const anyDerived =
    fresh(fiveHourRoll?.start ?? null) || fresh(weeklyRoll?.start ?? null);
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
    confidence:
      observation === null
        ? limit.unit === "percent"
          ? "missing"
          : "estimated"
        : anyDerived
          ? "estimated"
          : anyFresh
            ? observation.confidence
            : "stale",
    freshness: observation === null ? "missing" : anyFresh ? "fresh" : "stale",
    source: anyDerived
      ? "ledger"
      : (observation?.source ?? (limit.unit === "percent" ? "none" : "ledger")),
    fiveHour,
    weekly,
  };
}

/** What the ledger already recorded against a provider Hive cannot yet measure. The five-hour and weekly windows are read on the same fixed rolling bounds every unconfigured scope uses: there is no resolved pool here to state its own. */
export function unconfiguredTotals(
  ledger: QuotaLedger,
  scope: QuotaScope,
  now: Date,
) {
  const totals = ledger.usageTotals(
    scope,
    subtract(now, 5 * HOUR_MS),
    subtract(now, 7 * DAY_MS),
  );
  return {
    reserved: totals.reserved,
    fiveHourRecorded: totals.fiveHour,
    weeklyRecorded: totals.weekly,
  };
}

export function gapStatus(
  provider: CapabilityProvider,
  model: string,
  recorded: {
    reserved: number;
    fiveHourRecorded: number;
    weeklyRecorded: number;
  },
  probeError: string | null,
): QuotaUnconfiguredStatus {
  return {
    provider,
    model,
    configured: false,
    confidence: "missing",
    reason:
      probeError === null
        ? `Hive has not read live limits from ${provider} yet; usage is unknown and routing is unconstrained`
        : `Live limits from ${provider} are unavailable: ${probeError}`,
    probeError,
    ...recorded,
    recordedIsLocalEstimate: true,
  };
}

/** A pool can only constrain a spawn when every window it meters has a measured usage. An unmeasured window is unknown, and Hive will not subtract an estimate from an unknown to manufacture headroom it cannot see. A window the provider does not meter for this pool is a different thing entirely, and must not be read as unknown. Claude's model-scoped caps are weekly-only: Fable's pool has no five-hour window at all. Treating that absence as "unmeasured" would make the pool permanently unknowable, and an unknowable pool constrains nothing — the 99% weekly number would go right on being ignored, which is the bug this exists to prevent. */
function meters(
  limit: ResolvedQuotaLimit,
  status: QuotaPoolStatus,
  window: "fiveHour" | "weekly",
): boolean {
  if (status[window].availability === "not-metered") return false;
  const declared =
    window === "fiveHour"
      ? limit.fiveHourWindowMinutes
      : limit.weeklyWindowMinutes;
  return declared !== null || status[window].observedAt !== null;
}

export function measured(
  status: QuotaPoolStatus,
  limit?: ResolvedQuotaLimit,
): { fiveRemaining: number; weekRemaining: number } | null {
  if (status.origin === "discovered" && status.freshness !== "fresh") {
    return null;
  }
  const unbounded = Number.POSITIVE_INFINITY;
  const read = (window: "fiveHour" | "weekly"): number | null => {
    if (limit !== undefined && !meters(limit, status, window)) {
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

/** One drained metering window: which pool, which window, when it resets (null when the provider never said — a hold cannot be scheduled on it). */
export interface DrainedWindow {
  pool: string;
  window: "fiveHour" | "weekly";
  resetsAt: string | null;
}

/** Is any pool metering this model spent right now, and when does the drained window reset? One drained window is a drain: a model-scoped cap at zero empties the model even while the general pool has room. The estimate exception lives here and nowhere else: when the provider's API is down this reads the last-known windows (statusForLimit already carries them, provenance-stamped "stale") and treats them as the estimate the user accepted for the drain decision only. Spawn admission, billing, and every other reader keep the strict never-invent posture. */
export function drainedWindowFor(
  statuses: readonly QuotaPoolStatus[],
): DrainedWindow | null {
  let drained: DrainedWindow | null = null;
  for (const status of statuses) {
    for (const window of ["fiveHour", "weekly"] as const) {
      const value = status[window];
      // An unmetered or unmeasured window cannot be drained — unknown stays unknown, it never reads as empty.
      if (value.availability !== "available") continue;
      if (value.remainingPct === null || value.remainingPct > 0) continue;
      const candidate: DrainedWindow = {
        pool: status.pool,
        window,
        resetsAt: value.resetsAt,
      };
      if (
        drained === null ||
        (candidate.resetsAt !== null &&
          (drained.resetsAt === null || candidate.resetsAt < drained.resetsAt))
      )
        drained = candidate;
    }
  }
  return drained;
}
