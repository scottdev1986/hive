/**
 * The MCP tool response shape every Hive tool handler returns.
 *
 * All 34 tool handlers call it, so it has to be shared before the first group
 * moves — otherwise each extracted group carries its own copy and they drift.
 *
 * The value is sent twice on purpose: `content` is what a model reads, and
 * `structuredContent` is what a program reads. `note` appends a second text
 * block for a caveat the model must see without it polluting the structured
 * payload — a degraded-recall warning is a sentence to the reader, not a field.
 */
export function toolResult(value: unknown, key: string, note?: string | null) {
  const payload = { type: "text" as const, text: JSON.stringify(value) };
  return {
    content:
      note === undefined || note === null
        ? [payload]
        : [payload, { type: "text" as const, text: note }],
    structuredContent: { [key]: value },
  };
}
