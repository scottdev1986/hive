import type { QuotaLimit } from "../schemas/quota";

/**
 * When a quota window starts and ends.
 *
 * Every number the quota service publishes is read against a window, so the
 * window's edges decide what counts as spent. That makes this arithmetic
 * behaviour rather than formatting: a boundary off by an hour moves real
 * spend into or out of the period a spawn is admitted against.
 */

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;

export function iso(date: Date): string {
  return date.toISOString();
}

/** Instant from an ISO string, or null when the value is missing or unparseable. Offset-aware — do not compare the strings. */
export function instantMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function subtract(date: Date, milliseconds: number): string {
  return new Date(date.getTime() - milliseconds).toISOString();
}

export function add(date: Date, milliseconds: number): string {
  return new Date(date.getTime() + milliseconds).toISOString();
}

/** Advance a provider-stated boundary into the window containing `now`. A reset is evidence that the old window ended, even when no new gauge arrived; without both that evidence and the provider's window length there is nothing safe to derive. */
export function rolledWindowBounds(
  resetAt: string | null | undefined,
  windowMinutes: number | null,
  now: Date,
): { start: string; end: string } | null {
  if (resetAt == null || windowMinutes === null) return null;
  const reset = Date.parse(resetAt);
  const duration = windowMinutes * 60_000;
  if (
    !Number.isFinite(reset) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    reset > now.getTime()
  ) {
    return null;
  }
  const periods = Math.floor((now.getTime() - reset) / duration) + 1;
  const end = reset + periods * duration;
  return {
    start: new Date(end - duration).toISOString(),
    end: new Date(end).toISOString(),
  };
}

type ZonedParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}>;

function zonedParts(date: Date, timeZone: string): ZonedParts {
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
      values.weekday = [
        "Sun",
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
      ].indexOf(part.value);
    } else {
      values[part.type] = Number(part.value);
    }
  }
  const { year, month, day, hour, minute, second, weekday } = values;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    weekday === undefined ||
    weekday < 0
  ) {
    throw new Error(`Unable to read calendar parts in timezone ${timeZone}`);
  }
  return { year, month, day, hour, minute, second, weekday };
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
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const difference = desired - observed;
    if (difference === 0) break;
    guess += difference;
  }
  const resolved = zonedParts(new Date(guess), timeZone);
  if (
    resolved.year === year &&
    resolved.month === month &&
    resolved.day === day &&
    resolved.hour === hour &&
    resolved.minute === minute
  ) {
    return new Date(guess);
  }

  // A configured wall time can be absent during a daylight-saving jump. Resolve that boundary to the first valid local minute after the gap.
  const searchStart = desired - 18 * HOUR_MS;
  const searchEnd = desired + 18 * HOUR_MS;
  for (
    let candidate = searchStart;
    candidate <= searchEnd;
    candidate += 60_000
  ) {
    const parts = zonedParts(new Date(candidate), timeZone);
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour * 60 + parts.minute >= hour * 60 + minute
    ) {
      return new Date(candidate);
    }
  }
  throw new Error(
    `Unable to resolve calendar quota boundary in timezone ${timeZone}`,
  );
}

export function calendarWeekBounds(now: Date, limit: QuotaLimit) {
  const local = zonedParts(now, limit.timezone);
  let daysBack = (local.weekday - limit.resetWeekday + 7) % 7;
  const beforeReset =
    daysBack === 0 &&
    (local.hour < limit.resetHour ||
      (local.hour === limit.resetHour && local.minute < limit.resetMinute));
  if (beforeReset) daysBack = 7;
  const localDate = new Date(
    Date.UTC(local.year, local.month - 1, local.day - daysBack),
  );
  const start = zonedToUtc(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth() + 1,
    localDate.getUTCDate(),
    limit.resetHour,
    limit.resetMinute,
    limit.timezone,
  );
  const nextDate = new Date(
    Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate() + 7,
    ),
  );
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

/** The two windows this pool is read against. A rolling week is measured back from now; a calendar week is measured from the user's own stated reset, and only that form has an end — a rolling window has no boundary to publish beyond the readings themselves. */
export function windowBounds(
  limit: QuotaLimit & {
    fiveHourWindowMinutes?: number | null;
    weeklyWindowMinutes?: number | null;
  },
  now: Date,
) {
  const fiveHourMs = (limit.fiveHourWindowMinutes ?? 5 * 60) * 60_000;
  if (limit.weeklyWindow === "calendar") {
    const weekly = calendarWeekBounds(now, limit);
    return {
      fiveHourStart: subtract(now, fiveHourMs),
      weeklyStart: weekly.start,
      weeklyEnd: weekly.end,
    };
  }
  const weeklyMs = (limit.weeklyWindowMinutes ?? 7 * 24 * 60) * 60_000;
  return {
    fiveHourStart: subtract(now, fiveHourMs),
    weeklyStart: subtract(now, weeklyMs),
    weeklyEnd: null,
  };
}
