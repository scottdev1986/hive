import { type Review, ReviewSchema } from "../../schemas/integration-stage";

/**
 * Fold every stored review document for a run down to the live verdict per
 * reviewId. Re-reviewing appends a revision rather than editing the old one,
 * so the highest revision is the one in force. Returning every revision would
 * put a superseded verdict on the same footing as the current one.
 *
 * Pure: the store lists the documents; this only picks which ones are live.
 */

export function selectLiveReviews(documents: readonly unknown[]): Review[] {
  const live = new Map<string, Review>();
  for (const document of documents) {
    const review = ReviewSchema.parse(document);
    const held = live.get(review.reviewId);
    if (held !== undefined && BigInt(review.revision) <= BigInt(held.revision))
      continue;
    live.set(review.reviewId, review);
  }
  return [...live.values()];
}
