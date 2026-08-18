import { z } from "zod";
import { MailLaneSchema } from "./mail";
import {
  type MemoryRecallRow,
  MemoryRecallRowSchema,
  type MemoryRecallSemantic,
  MemoryRecallSemanticSchema,
} from "./memory-projections";

/** Wake payload the daemon builds when a wake is ready to submit. Carries mail counts by lane, the wake correlation ids, and the memory delta clamped to wake_budget_tokens. Never carries message bodies - the mailbox remains the only channel for those. */

export const WakePayloadSchema = z.strictObject({
  wakeId: z.string().min(1),
  oldestItemId: z.string().min(1),
  lane: MailLaneSchema,
  mailCounts: z.strictObject({
    controlAvailable: z.number().int().min(0),
    workAvailable: z.number().int().min(0),
  }),
  memoryDelta: z.strictObject({
    state: z.enum(["ok", "empty", "absent"]),
    semantic: MemoryRecallSemanticSchema,
    pitfalls: z.array(MemoryRecallRowSchema),
    articles: z.array(MemoryRecallRowSchema),
    tokens: z.number().int().min(0),
    budget: z.number().int().min(0),
    truncated: z.boolean(),
    omitted: z.number().int().min(0),
    omittedPitfalls: z.number().int().min(0),
    omittedArticles: z.number().int().min(0),
  }),
});
export type WakePayload = z.infer<typeof WakePayloadSchema>;

export const WakePayloadRequestSchema = z.strictObject({
  recipient: z.string().min(1),
  wakeId: z.string().min(1),
  oldestItemId: z.string().min(1),
  lane: MailLaneSchema,
});
export type WakePayloadRequest = z.infer<typeof WakePayloadRequestSchema>;

/** Format the wake prompt with mail counts and memory delta. */
export function formatWakePrompt(payload: WakePayload): string {
  const parts: string[] = [];

  // Header with counts
  parts.push(
    `Hive mail wake (${payload.lane} lane): you have unread mail.`,
    `Control: ${payload.mailCounts.controlAvailable} available | Work: ${payload.mailCounts.workAvailable} available`,
    `Oldest item: ${payload.oldestItemId} | Wake: ${payload.wakeId}`,
    "",
    "Poll your mailbox with hive_mail_poll, claim at most one control item, and settle it before any other work. This is internal operations, not a user message. Do not call SendUserMessage or narrate the mailbox work; finish silently unless the mail itself requires a direct user decision.",
  );

  // Memory delta
  if (payload.memoryDelta.state !== "absent") {
    parts.push("", "## Memory delta");
    if (payload.memoryDelta.semantic.startsWith("degraded:")) {
      parts.push(
        `⚠ semantic search unavailable (${payload.memoryDelta.semantic.slice("degraded:".length)}) — results are keyword-only`,
      );
    }
    if (payload.memoryDelta.state === "empty") {
      parts.push(
        "No memory changes since your last wake. The wiki was searched and nothing new matched.",
      );
    } else {
      const allRows: Array<{
        row: MemoryRecallRow;
        category: "pitfall" | "article";
      }> = [
        ...payload.memoryDelta.pitfalls.map((row) => ({
          row,
          category: "pitfall" as const,
        })),
        ...payload.memoryDelta.articles.map((row) => ({
          row,
          category: "article" as const,
        })),
      ];

      if (allRows.length > 0) {
        parts.push(
          `${allRows.length} memory update(s) (${payload.memoryDelta.tokens}/${payload.memoryDelta.budget} tokens):`,
        );
        for (const { row, category } of allRows) {
          const flag = row.flag === null ? "" : ` [${row.flag}]`;
          const pitfallMarker = category === "pitfall" ? " [pitfall]" : "";
          parts.push(
            `- [${row.scope}/${row.topic}] ${row.id} (${row.date})${flag}${pitfallMarker}: ${row.title} — ${row.snippet.replace(/\s+/g, " ").trim()}`,
          );
        }
        if (payload.memoryDelta.truncated) {
          parts.push(
            `(${payload.memoryDelta.omitted} omitted: ${payload.memoryDelta.omittedPitfalls} pitfalls, ${payload.memoryDelta.omittedArticles} articles)`,
          );
        }
        parts.push(
          "[unverified], [stale] and [conflicted] entries are hints to reconcile before acting, not authority; pull the full article with memory_read(scope, id).",
        );
      }
    }
  }

  return parts.join("\n");
}
