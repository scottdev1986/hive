import { z } from "zod";

/**
 * What an incident actually cost, in quantities that were counted rather than
 * estimated: how many provider runs burned on it and how long the burn lasted.
 *
 * Deliberately not tokens or money. src/usage-service/ owns those numbers; a
 * second derivation here would be a second answer, and one of them would be
 * wrong.
 */
export const IncidentCostSchema = z
  .strictObject({
    agentRuns: z.number().int().positive(),
    wallMs: z.number().int().nonnegative(),
  })
  .readonly();

export type IncidentCost = z.infer<typeof IncidentCostSchema>;

const exposureIdentity = {
  exposureId: z.string().uuid(),

  /**
   * Fingerprint of the cause, not of the symptom. Two exposures share a
   * signature when the same underlying trap was in play, however differently it
   * surfaced.
   */
  signature: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }),

  /**
   * Articles an agent recorded consulting before acting. This is attribution
   * evidence only: it says which article to thank, never whether anything was
   * avoided. Nothing an agent writes here can create or enlarge a score.
   */
  citedArticleIds: z.array(z.string().min(1)).readonly(),
};

/**
 * One occasion on which a known trap was in play during a run.
 *
 * A "hit" is an incident: the trap bit, and the damage was counted. An
 * "avoided" exposure is the counterpart nobody can observe directly — the trap
 * was demonstrably in play and nothing went wrong.
 *
 * The witness field is what keeps that second case honest. Only
 * recurrence-predicate exposures score: something machine-checkable about the
 * run or the repository matched the condition that produced the original
 * incident. A citation-only exposure rests entirely on an agent's own account
 * of itself, so it is recorded and reported but never credited — otherwise an
 * agent could improve the number by talking.
 */
export const IncidentExposureSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    ...exposureIdentity,
    outcome: z.literal("hit"),
    cost: IncidentCostSchema,
  }),
  z.strictObject({
    ...exposureIdentity,
    outcome: z.literal("avoided"),
    witness: z.enum(["recurrence-predicate", "citation-only"]),
  }),
]);

export type IncidentExposure = z.infer<typeof IncidentExposureSchema>;
