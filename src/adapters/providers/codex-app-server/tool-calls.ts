// Classifies Codex tool items and whether they finished successfully without
// inventing fields the provider did not report.

import { isRecord } from "../../../shared/is-record";
import type { ToolKind } from "../protocol/types";

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return nonEmptyString(value);
  if (!Array.isArray(value)) return null;
  const text = value
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!isRecord(entry)) return [];
      const line = nonEmptyString(entry.text) ?? nonEmptyString(entry.content);
      return line === null ? [] : [line];
    })
    .join("\n")
    .trim();
  return text === "" ? null : text;
}

export function commandForItem(item: Record<string, unknown>): {
  readonly name: string;
  readonly detail: string | null;
  readonly toolKind: ToolKind;
} | null {
  switch (item.type) {
    case "commandExecution":
      return {
        name: "commandExecution",
        detail: typeof item.command === "string" ? item.command : null,
        toolKind: "execute",
      };
    case "fileChange":
      return { name: "fileChange", detail: null, toolKind: "edit" };
    case "mcpToolCall":
      return {
        name:
          typeof item.server === "string" && typeof item.tool === "string"
            ? `${item.server}/${item.tool}`
            : "mcpToolCall",
        detail: null,
        toolKind: "other",
      };
    case "dynamicToolCall":
      return {
        name: typeof item.tool === "string" ? item.tool : "dynamicToolCall",
        detail: null,
        toolKind: "other",
      };
    case "collabAgentToolCall":
      return {
        name: typeof item.tool === "string" ? item.tool : "collabAgentToolCall",
        detail: null,
        toolKind: "other",
      };
    default:
      return null;
  }
}

export function toolSucceeded(item: Record<string, unknown>): boolean {
  return item.status === "completed" || item.success === true;
}

/** Extracts only completion output, never the request detail that started the
 * call. Codex varies the result envelope by tool kind, so the adapter owns the
 * small vocabulary instead of making downstream consumers parse vendor JSON. */
export function toolFailureReason(
  item: Record<string, unknown>,
): string | null {
  const error = item.error;
  const errorRecord = isRecord(error) ? error : null;
  const result = isRecord(item.result) ? item.result : null;
  return (
    nonEmptyString(errorRecord?.message) ??
    nonEmptyString(error) ??
    nonEmptyString(item.message) ??
    nonEmptyString(item.stderr) ??
    nonEmptyString(item.aggregatedOutput) ??
    nonEmptyString(item.output) ??
    contentText(result?.content) ??
    nonEmptyString(result?.message)
  );
}
