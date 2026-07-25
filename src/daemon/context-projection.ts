import { createHash } from "node:crypto";
import type { AgentMessage, ContextProjection } from "../schemas";
import { ContextProjectionSchema } from "../schemas";

export const MESSAGE_BATCH_MAX_BYTES = 8 * 1_024;
export const MESSAGE_BATCH_MAX_MESSAGES = 8;

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function batchId(providerRunId: string, messages: readonly AgentMessage[]) {
  const hex = createHash("sha256")
    .update(providerRunId)
    .update("\0")
    .update(messages.map((message) => message.id).join("\0"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function preview(
  body: string,
  budget: number,
  sha256: string,
  messageId: string,
): { body: string; omittedBytes: number } {
  if (bytes(body) <= budget) return { body, omittedBytes: 0 };
  const points = [...body];
  let low = 0;
  let high = points.length;
  let best = { body: "", omittedBytes: bytes(body) };
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const omitted = points.slice(head, points.length - tail).join("");
    const omittedBytes = bytes(omitted);
    const marker =
      `\n…[${omittedBytes} bytes omitted; sha256=${sha256}; ` +
      `retrieve with hive_read_message {"id":"${messageId}"}]…\n`;
    const candidate =
      points.slice(0, head).join("") +
      marker +
      (tail === 0 ? "" : points.slice(points.length - tail).join(""));
    if (bytes(candidate) <= budget) {
      best = { body: candidate, omittedBytes };
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best;
}

export function buildNormalMessageBatchProjection(
  messages: readonly AgentMessage[],
  providerRunId: string,
): ContextProjection {
  const batch = messages.slice(0, MESSAGE_BATCH_MAX_MESSAGES);
  if (
    batch.length === 0 ||
    batch.some((message) => message.priority !== "normal")
  ) {
    throw new Error(
      "A normal message batch requires at least one normal message",
    );
  }
  const heading = `📨 ${batch.length} normal message${batch.length === 1 ? "" : "s"} (ordered by durable sequence)`;
  const headers = batch.map(
    (message) => `message ${message.id} from ${message.from}:`,
  );
  const fixed = bytes([heading, ...headers].join("\n\n"));
  const bodyBudget = Math.floor(
    (MESSAGE_BATCH_MAX_BYTES - fixed - batch.length * 2) / batch.length,
  );
  const previews = batch.map((message) =>
    preview(message.body, bodyBudget, digest(message.body), message.id),
  );
  const body = [
    heading,
    ...headers.map(
      (header, index) => `${header}\n${previews[index]?.body ?? ""}`,
    ),
  ].join("\n\n");
  return ContextProjectionSchema.parse({
    projectionId: batchId(providerRunId, batch),
    providerRunId,
    purpose: "message-batch",
    body,
    sourceRefs: batch.map((message) => ({
      kind: "message",
      id: message.id,
      retrieval: {
        tool: "hive_read_message",
        arguments: { id: message.id },
      },
    })),
    sourceDigests: batch.map((message) => digest(message.body)),
    omitted: {
      sources: previews.filter((item) => item.omittedBytes > 0).length,
      bytes: previews.reduce((sum, item) => sum + item.omittedBytes, 0),
    },
    complete: previews.every((item) => item.omittedBytes === 0),
  });
}
