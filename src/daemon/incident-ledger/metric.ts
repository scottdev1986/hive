// metric.ts
//
// The memory programme's success measure, computed from the incident-exposure
// ledger and from nothing else.
//
// Two numbers are co-primary. Repeat-incident rate answers "when a trap we had
// already met was in play again, how often did it still bite?" Avoided-repeat
// cost answers "how much damage did not happen?" The first alone is blind to
// success: a system that goes from repeating every known failure to repeating
// none can show a flat rate the whole way if the remaining incidents are always
// first-of-kind. The second alone is blind to regression. Read together they
// move in opposite directions for the same underlying change, which is what
// makes either of them trustworthy.
//
// WHY THE CORPUS IS NOT AN INPUT
//
// The owner's constraint is that writing articles must not improve the score.
// That is enforced structurally rather than by rule: this function is never
// handed the article corpus, so no count of it can appear in any output. The
// only article-shaped datum that reaches here is citedArticleIds on an exposure,
// and it is confined to articleReward, which splits a total that is fixed before
// any citation is read. See the conservation property on articleReward.

import type {
  IncidentCost,
  IncidentExposure,
} from "../../schemas/incident-exposure";

/**
 * A cost that has been summed or divided. Distinct from IncidentCost, which is
 * a single validated measurement and therefore whole.
 */
export type CostTotal = {
  readonly agentRuns: number;
  readonly wallMs: number;
};

export type MemoryMetric = {
  /** Known trap in play, and it bit anyway. */
  readonly repeatIncidents: number;

  /** Known trap in play, machine-witnessed, and it did not bite. */
  readonly avoidedRepeats: number;

  /**
   * repeatIncidents / (repeatIncidents + avoidedRepeats). Null when no known
   * trap was in play at all, which is a different statement from zero and must
   * not be reported as one.
   */
  readonly repeatIncidentRate: number | null;

  /** Damage actually paid for the repeats, as measured at the time. */
  readonly repeatIncidentCost: CostTotal;

  /**
   * Co-primary with repeatIncidentRate. For each avoided repeat, what that same
   * trap cost the last time it bit. Historical measurements only, so nothing
   * done today can inflate it.
   */
  readonly avoidedRepeatCost: CostTotal;

  /** First-of-kind incidents: nothing to deliver, so an admission opportunity. */
  readonly novelIncidents: number;

  /**
   * Avoided repeats resting only on an agent's own citation. Reported so the
   * gap between claimed and demonstrated avoidance is visible, never scored.
   */
  readonly unverifiedAvoidedRepeats: number;

  /** Repeats where an article was cited and the trap bit regardless. */
  readonly deliveryFailures: number;

  /**
   * Per-article reward, the signal a utility term can consume.
   *
   * Conservation: the sum over all articles is at most avoidedRepeatCost, which
   * is computed before any citation is examined. Writing an article cannot
   * enlarge the pool, and citing several articles for one avoidance splits that
   * avoidance between them, so padding a citation list dilutes the very
   * articles it names.
   */
  readonly articleReward: Readonly<Record<string, CostTotal>>;
};

const ZERO: CostTotal = { agentRuns: 0, wallMs: 0 };

function add(a: CostTotal, b: CostTotal): CostTotal {
  return { agentRuns: a.agentRuns + b.agentRuns, wallMs: a.wallMs + b.wallMs };
}

function share(cost: CostTotal, ways: number): CostTotal {
  return { agentRuns: cost.agentRuns / ways, wallMs: cost.wallMs / ways };
}

/**
 * Scores the exposures observed at or after `since`, using every exposure given
 * to decide what counted as already-known.
 *
 * `since` cannot be pushed onto the caller: narrowing the list would also hide
 * the history that makes a trap known, and a window with no history behind it
 * classifies every repeat as first-of-kind. Pass null to score the whole ledger.
 */
export function computeMemoryMetric(
  exposures: readonly IncidentExposure[],
  since: string | null,
): MemoryMetric {
  const windowStart = since === null ? null : Date.parse(since);
  const ordered = [...exposures].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
  );

  // Cost of the most recent hit per signature, as the scan reaches each row.
  // Its presence is also what makes a signature "known" from that point on.
  const lastHitCost = new Map<string, IncidentCost>();
  const articleReward = new Map<string, CostTotal>();
  let repeatIncidents = 0;
  let avoidedRepeats = 0;
  let novelIncidents = 0;
  let unverifiedAvoidedRepeats = 0;
  let deliveryFailures = 0;
  let repeatIncidentCost = ZERO;
  let avoidedRepeatCost = ZERO;

  for (const exposure of ordered) {
    const priorCost = lastHitCost.get(exposure.signature);
    const scored =
      windowStart === null || Date.parse(exposure.observedAt) >= windowStart;

    if (exposure.outcome === "hit") {
      if (scored && priorCost === undefined) {
        novelIncidents += 1;
      } else if (scored) {
        repeatIncidents += 1;
        repeatIncidentCost = add(repeatIncidentCost, exposure.cost);
        if (exposure.citedArticleIds.length > 0) deliveryFailures += 1;
      }
      lastHitCost.set(exposure.signature, exposure.cost);
      continue;
    }

    // Avoiding a trap that has never bitten here is unremarkable and
    // unpriceable: there is no measured cost to credit it with.
    if (!scored || priorCost === undefined) continue;

    if (exposure.witness === "citation-only") {
      unverifiedAvoidedRepeats += 1;
      continue;
    }

    avoidedRepeats += 1;
    avoidedRepeatCost = add(avoidedRepeatCost, priorCost);

    const cited = new Set(exposure.citedArticleIds);
    if (cited.size === 0) continue;
    const credit = share(priorCost, cited.size);
    for (const articleId of cited) {
      articleReward.set(
        articleId,
        add(articleReward.get(articleId) ?? ZERO, credit),
      );
    }
  }

  const scoredExposures = repeatIncidents + avoidedRepeats;
  return {
    repeatIncidents,
    avoidedRepeats,
    repeatIncidentRate:
      scoredExposures === 0 ? null : repeatIncidents / scoredExposures,
    repeatIncidentCost,
    avoidedRepeatCost,
    novelIncidents,
    unverifiedAvoidedRepeats,
    deliveryFailures,
    articleReward: Object.fromEntries(articleReward),
  };
}
