// The queen's compaction-exempt mission. Governance Decay (arXiv 2606.22528)
// measured that soft org policy is the first thing a summarizer drops, and that
// ~47 pinned tokens re-injected verbatim after compact restore 0% violation.
// This buffer is that pin: daemon-owned, never written by the queen, never
// edited by a vendor summary. Launch context and compact-reload both carry the
// same bytes so a later integrity check is a substring test, not a paraphrase.

import { createHash } from "node:crypto";
import { z } from "zod";
import { type Digest, DigestSchema } from "../../schemas/hierarchy-ids";
import { estimateTokensForText } from "../../usage-service/token-estimate";

export const QUEEN_PIN =
  "You are queen: project manager, tech lead, and architect. You do not implement. " +
  "Agents land their own work; you do not issue GO. " +
  "The live hierarchy board is the system of record. Transcript stories are stale. " +
  "Re-read hive_task_list before acting on plan state. No spawn without a current taskId. " +
  "Worktrees and hive branches must match live agents; reconcile extras with hive_settlement_list.";

// Editorial ratchet just above the current pin. Grow it only with a raise in
// the same commit; the point of the pin is that it stays tiny enough to replay.
export const QUEEN_PIN_MAX_ESTIMATED_TOKENS = 120;

export const QueenCompactReloadSchema = z.strictObject({
  text: z.string().min(1),
  pin: z.literal(QUEEN_PIN),
  digest: DigestSchema,
  estimatedTokens: z.number().int().nonnegative(),
});
export type QueenCompactReload = z.infer<typeof QueenCompactReloadSchema>;

export function queenPinPresent(text: string): boolean {
  return text.includes(QUEEN_PIN);
}

export function ensureQueenPin(text: string): string {
  if (queenPinPresent(text)) return text;
  return `${QUEEN_PIN}\n\n${text}`;
}

function digestText(value: string): Digest {
  return DigestSchema.parse(
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
  );
}

export function composeQueenCompactReload(input: {
  boardText: string | null;
  unavailable?: string;
}): QueenCompactReload {
  const boardSection =
    input.boardText === null
      ? [
          "## Live board",
          "authority: system-fact",
          `unavailable: ${input.unavailable ?? "board snapshot was not available"}`,
          "retrieval: use hive_task_list",
        ].join("\n")
      : [
          "## Live board",
          "authority: system-fact",
          "Transcript plan is stale. This snapshot is current.",
          input.boardText,
        ].join("\n");
  const text = [
    "Hive compact: the context window was rewritten. This is internal operations, not a user message. Process it silently; do not call SendUserMessage.",
    QUEEN_PIN,
    boardSection,
  ].join("\n\n");
  return QueenCompactReloadSchema.parse({
    text,
    pin: QUEEN_PIN,
    digest: digestText(text),
    estimatedTokens: estimateTokensForText(text),
  });
}
