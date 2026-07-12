/**
 * The benchmark fit policy, live by user order 2026-07-12
 * (docs/benchmark-fit-policy-proposal.md): one pure reordering step over the
 * eligible candidate list, acting after pins, capability floors, and user
 * policy have produced that list, and before quota ranks it.
 *
 * Ordering only, structurally: the decision returns the same candidates it
 * was given — never one more, never one fewer — so a benchmark can place a
 * candidate but has no code path by which to exclude one. Absence of data
 * never gates; capability floors were applied before this step ever ran.
 */

export type FitBenchmarkRow = {
  sourceId: string;
  effort: string;
  scores: Record<string, number>;
  releaseDate: string;
};

export type FitCandidate = {
  /** The route token for this candidate, verbatim from the eligible list. */
  token: string;
  canonicalId: string;
  /** Vendor-advertised effort levels in the vendor's own order, or null when
   * discovery could not read them. Never invented. */
  advertisedEfforts: string[] | null;
  /** Published rows for this model from current/last-good sources. */
  rows: FitBenchmarkRow[];
};

export type FitPlacement = {
  token: string;
  canonicalId: string;
  /** Exact-match score at the routed effort, or null. Never synthesized. */
  score: number | null;
  /** The evidence basis for this placement, always stated. */
  basis: string;
};

export type FitDecision = {
  /** The eligible list, reordered. Same members, same length, always. */
  order: FitPlacement[];
  /** Effort economy's pick for the leading candidate, when evidence proves a
   * lower advertised effort sufficient; null means the routed effort stands. */
  effort: { value: string; basis: string } | null;
  /** True when the policy moved the leading candidate or the effort. */
  changed: boolean;
  /** What the policy did and on what evidence, for routing telemetry. */
  detail: string;
};

/** User-approved 2026-07-12: scores within this band on the source's own
 * scale are tied and the policy order stands. */
export const MATERIALITY_BAND = 5;

/** The approved kind→column mapping: coding work reads the coding column;
 * every other kind is unmapped and the policy is inert for it. */
export const CODING_SCORE_COLUMN = "code_generation";

const evidenceFor = (
  candidate: FitCandidate,
  routedEffort: string,
  column: string,
): FitPlacement => {
  const exact = candidate.rows.find((row) =>
    row.effort === routedEffort && row.scores[column] !== undefined
  );
  if (exact !== undefined) {
    return {
      token: candidate.token,
      canonicalId: candidate.canonicalId,
      score: exact.scores[column]!,
      basis: `${exact.sourceId} ${column}=${
        exact.scores[column]
      } at ${routedEffort} (${exact.releaseDate})`,
    };
  }
  if (candidate.rows.length > 0) {
    const measured = [...new Set(candidate.rows.map((row) => row.effort))]
      .join("/");
    return {
      token: candidate.token,
      canonicalId: candidate.canonicalId,
      score: null,
      basis: `inferred: below ${candidate.canonicalId} ${measured} (${
        candidate.rows[0]!.sourceId
      } ${candidate.rows[0]!.releaseDate}); ordinal only, holds cross-model position`,
    };
  }
  return {
    token: candidate.token,
    canonicalId: candidate.canonicalId,
    score: null,
    basis:
      "uncovered: no stale measurement, vendor tiering, or placement pin available; holds policy position",
  };
};

/**
 * Apply the three-rule fit policy to one tier's eligible candidate list.
 *
 * `column` is the score column mapped for the tier's task kind, or null for
 * an unmapped kind (the policy is then inert). `routedEffort` is the effort
 * the tier resolved before this step.
 */
export function applyFitPolicy(input: {
  candidates: FitCandidate[];
  routedEffort: string | null;
  column: string | null;
  band?: number;
}): FitDecision {
  const band = input.band ?? MATERIALITY_BAND;
  const inert = (why: string): FitDecision => ({
    order: input.candidates.map((candidate) => ({
      token: candidate.token,
      canonicalId: candidate.canonicalId,
      score: null,
      basis: why,
    })),
    effort: null,
    changed: false,
    detail: `fit policy (band=${band}): ${why}`,
  });
  if (input.column === null) {
    return inert("kind has no mapped score column; the policy is inert here");
  }
  if (input.routedEffort === null || input.candidates.length === 0) {
    return inert("no routed effort or no candidates to evaluate");
  }
  const column = input.column;
  const routedEffort = input.routedEffort;
  const evidence = input.candidates.map((candidate) =>
    evidenceFor(candidate, routedEffort, column)
  );

  // Only measured candidates move, and only relative to each other: reorder
  // them within the slots they already occupy, material differences only.
  // Unmeasured candidates keep their exact positions.
  const slots = evidence.flatMap((entry, index) =>
    entry.score === null ? [] : [index]
  );
  const measured = slots.map((slot) => evidence[slot]!);
  for (let pass = 0; pass < measured.length; pass++) {
    for (let i = 0; i + 1 < measured.length; i++) {
      if (measured[i + 1]!.score! >= measured[i]!.score! + band) {
        [measured[i], measured[i + 1]] = [measured[i + 1]!, measured[i]!];
      }
    }
  }
  const order = [...evidence];
  slots.forEach((slot, at) => order[slot] = measured[at]!);
  const derivedFirst = evidence[0]!;
  const policyFirst = order[0]!;
  const orderFinding = policyFirst.token === derivedFirst.token
    ? `order stands: ${
      order.map((entry) => `${entry.canonicalId} [${entry.basis}]`).join(" > ")
    }`
    : `placed ${policyFirst.canonicalId} [${policyFirst.basis}] ahead of ${derivedFirst.canonicalId} [${derivedFirst.basis}]`;

  // Effort economy on the leading candidate: the lowest advertised effort
  // whose measured score sits within the band of the routed effort's measured
  // score is sufficient, and unneeded high effort is waste. Both efforts must
  // be measured — inference alone proves ordering, never sufficiency.
  let effort: FitDecision["effort"] = null;
  const leader = input.candidates.find((candidate) =>
    candidate.token === policyFirst.token
  )!;
  if (policyFirst.score !== null && leader.advertisedEfforts !== null) {
    const routedAt = leader.advertisedEfforts.indexOf(routedEffort);
    const sufficient = leader.advertisedEfforts
      .slice(0, routedAt === -1 ? 0 : routedAt)
      .flatMap((level) => {
        const row = leader.rows.find((entry) =>
          entry.effort === level && entry.scores[column] !== undefined
        );
        return row === undefined ||
            row.scores[column]! < policyFirst.score! - band
          ? []
          : [{ level, row }];
      })[0];
    if (sufficient !== undefined) {
      effort = {
        value: sufficient.level,
        basis: `effort economy: ${sufficient.row.sourceId} ${column}=${
          sufficient.row.scores[column]
        } at ${sufficient.level} within band of ${policyFirst.score} at ${routedEffort} (${sufficient.row.releaseDate})`,
      };
    }
  }

  return {
    order,
    effort,
    changed: policyFirst.token !== derivedFirst.token || effort !== null,
    detail: `fit policy (band=${band}, ${column}): ${orderFinding}${
      effort === null ? "" : `; ${effort.basis} — routes ${effort.value}`
    }`,
  };
}
