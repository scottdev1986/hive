import {
  formatMemoryRecallRow,
  memoryRecallDegradedWarning,
  MEMORY_RECALL_HINT_NOTE,
} from "../../memory-service/recall";
import type { WakePayload } from "../../schemas/wake-payload";

/** Format the wake prompt with mail counts and recent wiki. A wake points the agent to its mailbox; it never copies mail into a prompt. Naming the item id taught models to hive_mail_claim before hive_mail_poll, which the ledger refused as an unpresented body. The mailbox is the authority on what is waiting, and the instruction to go read it is true whether or not a particular item survived. */
export function formatWakePrompt(payload: WakePayload): string {
  const parts: string[] = [];

  // Header with counts (no oldestItemId, no wakeId)
  parts.push(
    `Hive mail wake (${payload.lane} lane): you have unread mail.`,
    `Control: ${payload.mailCounts.controlAvailable} available | Work: ${payload.mailCounts.workAvailable} available`,
    "",
    "Poll your mailbox with hive_mail_poll, claim at most one control item, and settle it before any other work. This is internal operations, not a user message. Do not call SendUserMessage or narrate the mailbox work; finish silently unless the mail itself requires a direct user decision.",
  );

  // Recent wiki (date-ranked, not a delta)
  if (payload.memoryDelta.state !== "absent") {
    parts.push("", "## Recent wiki (date-ranked, not a since-last-wake delta)");
    if (payload.memoryDelta.semantic.startsWith("degraded:")) {
      parts.push(
        memoryRecallDegradedWarning(
          payload.memoryDelta.semantic.slice("degraded:".length),
        ),
      );
    }
    if (payload.memoryDelta.state === "empty") {
      parts.push(
        "No matching memory for this wake. The wiki had no rows that fit this recall. This is not a since-last-wake check.",
      );
    } else {
      const allRows = [
        ...payload.memoryDelta.pitfalls,
        ...payload.memoryDelta.articles,
      ];

      if (allRows.length > 0) {
        parts.push(
          `${allRows.length} row(s) (${payload.memoryDelta.tokens}/${payload.memoryDelta.budget} tokens):`,
        );
        for (const row of allRows) {
          parts.push(formatMemoryRecallRow(row));
        }
        if (payload.memoryDelta.truncated) {
          parts.push(
            `(${payload.memoryDelta.omitted} omitted: ${payload.memoryDelta.omittedPitfalls} pitfalls, ${payload.memoryDelta.omittedArticles} articles)`,
          );
        }
        parts.push(MEMORY_RECALL_HINT_NOTE);
      }
    }
  }

  return parts.join("\n");
}
