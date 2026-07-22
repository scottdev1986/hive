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

/**
 * What the user is being asked about — and it is not always a model.
 *
 * When Hive cannot read a vendor's billing AT ALL, it cannot distinguish one
 * model's cost from another's, so it cannot honestly ask a per-model question:
 * the only truthful question left is "may Hive spend money on this vendor?".
 * That subject is the PROVIDER. When billing IS readable, the charge is a fact
 * about a specific model, and the subject is that model's canonical id.
 *
 * Keying the unreadable-billing question on a model id was a livelock: the
 * vendor's default model can move between the ask and the spawn (grok's did,
 * silently, on 2026-07-12), which orphans the answer the user already gave and
 * refuses the spawn against a question nobody can answer.
 */
export type ConsentSubject = string;

/** Stable per subject, so the same question is never asked twice. */
export const consentId = (subject: ConsentSubject): string =>
  `${PREFIX}${subject}`;

export function readCostConsent(
  db: Pick<HiveDatabase, "getApproval">,
  subject: ConsentSubject,
): ConsentState {
  const approval: Approval | null = db.getApproval(consentId(subject));
  if (approval === null) return "none";
  // Only tool-permission rows are invalidated as stale. If a malformed or
  // manually edited cost row carries it, fail closed instead of granting.
  return approval.status === "stale" ? "denied" : approval.status;
}

/**
 * Ask, once. Returns the state after asking: an existing answer is left exactly
 * as it was, so a denial stays denied rather than being quietly re-opened by the
 * next spawn that wanted the model.
 */
export function requestCostConsent(
  db: Pick<HiveDatabase, "getApproval" | "insertApproval">,
  subject: ConsentSubject,
  detail: string,
  now: string = new Date().toISOString(),
): ConsentState {
  const existing = readCostConsent(db, subject);
  if (existing !== "none") return existing;
  db.insertApproval({
    id: consentId(subject),
    // Not an agent's request: it is the router asking the account's owner.
    agentName: "router",
    // Boilerplate around the subject the caller already has: safe to trim on
    // the polled MCP surface.
    kind: "cost-consent",
    description:
      `SPEND REAL MONEY on ${subject}? ${detail} ` +
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
