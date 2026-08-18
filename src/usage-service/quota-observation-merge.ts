import type { QuotaObservation } from "../schemas/quota";
import { instantMs } from "./quota-windows";

/**
 * Folding a new quota reading into the stored one, window by window.
 *
 * Each window is observed on its own schedule, so each advances on its own
 * evidence: a payload that reports only the five-hour window must leave the
 * stored weekly fact — and its older timestamp — exactly as it was. Getting
 * this wrong makes a stale number look fresh, and a fresh-looking stale
 * number is what a spawn gets admitted against.
 */

const newer = (left: string | null, right: string | null): boolean => {
  const incoming = instantMs(left);
  const stored = instantMs(right);
  return incoming !== null && (stored === null || incoming >= stored);
};

/** A window's boundary is a fact of its own, and does not travel with its gauge. A vendor can state when the period turns over while stating nothing about how much of it is spent (grok's `_x.ai/billing` since 0.2.112); such a reading writes no `*ObservedAt`, so keying its reset to the gauge's recency would pick the prior window every time and the new boundary would never land — the stored reset would sit frozen at a time that has already passed, which reads downstream as "reset unknown" forever. A boundary only ever moves forward: a period that has turned over ends later than the one it replaced. So the later of the two wins, which also makes an out-of-order arrival harmless — an older reading cannot drag a fresh boundary backwards. An incoming reading with no boundary at all asserts nothing and keeps the stored one. */
const laterBoundary = (
  incoming: string | null,
  stored: string | null,
): string | null => {
  if (incoming === null) return stored;
  if (stored === null) return incoming;
  const incomingMs = instantMs(incoming);
  const storedMs = instantMs(stored);
  if (incomingMs === null) return stored;
  if (storedMs === null) return incoming;
  return incomingMs > storedMs ? incoming : stored;
};

export function mergeObservationWindows(
  prior: QuotaObservation | null,
  incoming: QuotaObservation,
): QuotaObservation {
  if (prior === null) return incoming;
  const five = newer(incoming.fiveHourObservedAt, prior.fiveHourObservedAt)
    ? incoming
    : prior;
  const week = newer(incoming.weeklyObservedAt, prior.weeklyObservedAt)
    ? incoming
    : prior;
  const fiveLeads = newer(five.fiveHourObservedAt, week.weeklyObservedAt);
  const lead = fiveLeads
    ? {
        observedAt: five.fiveHourObservedAt,
        source: five.fiveHourSource ?? five.source,
        confidence: five.fiveHourConfidence ?? five.confidence,
      }
    : {
        observedAt: week.weeklyObservedAt,
        source: week.weeklySource ?? week.source,
        confidence: week.weeklyConfidence ?? week.confidence,
      };
  return {
    ...incoming,
    fiveHourUsed: five.fiveHourUsed,
    fiveHourResetAt: laterBoundary(
      incoming.fiveHourResetAt,
      five.fiveHourResetAt,
    ),
    fiveHourObservedAt: five.fiveHourObservedAt,
    fiveHourSource: five.fiveHourSource,
    fiveHourConfidence: five.fiveHourConfidence,
    weeklyUsed: week.weeklyUsed,
    weeklyResetAt: laterBoundary(incoming.weeklyResetAt, week.weeklyResetAt),
    weeklyObservedAt: week.weeklyObservedAt,
    weeklySource: week.weeklySource,
    weeklyConfidence: week.weeklyConfidence,
    observedAt: lead.observedAt ?? incoming.observedAt,
    source: lead.source,
    confidence: lead.confidence,
  };
}
