import type { AgentBindingRef } from "../../schemas/hierarchy-node";
import {
  type Review,
  isReviewCurrentForCandidate,
} from "../../schemas/integration-stage";

export interface ReviewAdmissionReader {
  candidateAuthorAgentIds(candidate: Review["candidate"]): readonly string[];
  hasOverlappingAuthorTask(reviewer: AgentBindingRef, taskId: string): boolean;
  hasFreshValidationEvidenceAt(commitSha: string): boolean;
}

/** Returns whether an independent review supports the supplied candidate. An identical-patch rebase is the only stale-base exception. It still needs validation evidence bound to the new commit; the old review is never rewritten or silently attached to a different SHA. The caller owns pairing the review's task with the candidate's task. */
export function isReviewAdmittedForCandidate(
  review: Review,
  candidate: Review["candidate"],
  reader: ReviewAdmissionReader,
): boolean {
  if (review.verdict !== "accepted") return false;

  if (
    review.authors.some((author) => author.agentId === review.reviewer.agentId)
  ) {
    return false;
  }

  if (
    reader.candidateAuthorAgentIds(candidate).includes(review.reviewer.agentId)
  ) {
    return false;
  }

  if (
    reader.hasOverlappingAuthorTask(
      review.reviewer,
      review.revisions.task.taskId,
    )
  ) {
    return false;
  }

  if (
    isReviewCurrentForCandidate(review, candidate) &&
    review.candidate.commitSha === candidate.commitSha
  ) {
    return true;
  }

  return (
    review.invalidation.state === "current" &&
    review.candidate.patchDigest === candidate.patchDigest &&
    review.candidate.baseSha !== candidate.baseSha &&
    review.candidate.commitSha !== candidate.commitSha &&
    reader.hasFreshValidationEvidenceAt(candidate.commitSha)
  );
}
