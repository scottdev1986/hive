import type { Approval, HiveDatabase } from "./db";

/**
 * The user's standing answer to "may Hive spend your money on this model?".
 *
 * It rides the approvals queue Hive already has — the same table `hive_approvals`
 * lists and `hive_approve` resolves — rather than a second consent mechanism with
 * its own vocabulary and its own bugs. Two properties make that reuse safe:
 *
 * **The id is deterministic**, so a model is asked about exactly once. A queue
 * that re-asks every spawn is a queue the user learns to click through, which is
 * how a consent prompt becomes a rubber stamp.
 *
 * **A pending request is not a yes.** Only `approved` unblocks auto-routing;
 * `pending`, `denied`, and "never asked" all leave the model out of the candidate
 * list. Silence never authorizes a charge — an unanswered question is not
 * permission.
 *
 * None of this touches an explicit pin. Pinning a model *is* the consent, and it
 * never reaches this queue: Hive does not ask a user to approve the thing he just
 * told it to do.
 */

export type ConsentState = "approved" | "denied" | "pending" | "none";

const PREFIX = "cost-consent:";

/** Stable per model, so the same question is never asked twice. */
export const consentId = (canonicalId: string): string =>
  `${PREFIX}${canonicalId}`;

export function readCostConsent(
  db: Pick<HiveDatabase, "getApproval">,
  canonicalId: string,
): ConsentState {
  const approval: Approval | null = db.getApproval(consentId(canonicalId));
  if (approval === null) return "none";
  return approval.status;
}

/**
 * Ask, once. Returns the state after asking: an existing answer is left exactly
 * as it was, so a denial stays denied rather than being quietly re-opened by the
 * next spawn that wanted the model.
 */
export function requestCostConsent(
  db: Pick<HiveDatabase, "getApproval" | "insertApproval">,
  canonicalId: string,
  detail: string,
  now: string = new Date().toISOString(),
): ConsentState {
  const existing = readCostConsent(db, canonicalId);
  if (existing !== "none") return existing;
  db.insertApproval({
    id: consentId(canonicalId),
    // Not an agent's request: it is the router asking the account's owner.
    agentName: "router",
    // Boilerplate around the model id the caller already has: safe to trim on
    // the polled MCP surface.
    kind: "cost-consent",
    description:
      `SPEND REAL MONEY on ${canonicalId}? ${detail} ` +
      "Approve to let Hive run it and bill your usage credits; deny to keep it " +
      "out until your plan resets. This asks about the CHARGE, not the model — " +
      "Hive will not spend your money without your say-so, and it will not ask " +
      "you twice.",
    status: "pending",
    createdAt: now,
    resolvedAt: null,
  });
  return "pending";
}
