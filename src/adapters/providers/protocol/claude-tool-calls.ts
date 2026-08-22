import { isRecord } from "../../../shared/is-record";
import type { ToolFileChange, ToolKind } from "./types";
import { claudeQuestionText } from "./claude-stream-questions";
import { asString } from "./claude-stream-wire";

/** Claude Code names its tools rather than classifying them, so the kind is read off the name. An unrecognized tool is left unclassified instead of being called `other`, which would claim the vendor said something it did not. */
const CLAUDE_TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  BashOutput: "execute",
  Glob: "search",
  Grep: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  Task: "think",
  TodoWrite: "other",
};

export function claudeToolKind(toolName: string): ToolKind | null {
  return CLAUDE_TOOL_KINDS[toolName] ?? null;
}

export function claudeToolLocations(input: unknown): readonly string[] {
  if (!isRecord(input)) return [];
  const path =
    asString(input.file_path) ??
    asString(input.notebook_path) ??
    asString(input.path);
  return path === null ? [] : [path];
}

/** The file changes a Claude tool call describes. Edit reports the fragment it is replacing rather than the whole file, so the change carries that fragment: a patch of the part that changed is honest about what was reported, where padding it out to a whole-file diff would not be. */
export function claudeToolChanges(
  toolName: string,
  input: unknown,
): readonly ToolFileChange[] {
  if (!isRecord(input)) return [];
  const path = asString(input.file_path);
  if (path === null) return [];
  if (toolName === "Write") {
    const content = asString(input.content);
    return content === null ? [] : [{ path, oldText: null, newText: content }];
  }
  if (toolName === "Edit") {
    const oldText = asString(input.old_string);
    const newText = asString(input.new_string);
    return oldText === null || newText === null
      ? []
      : [{ path, oldText, newText }];
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const changes: ToolFileChange[] = [];
    for (const edit of input.edits) {
      if (!isRecord(edit)) continue;
      const oldText = asString(edit.old_string);
      const newText = asString(edit.new_string);
      if (oldText === null || newText === null) continue;
      changes.push({ path, oldText, newText });
    }
    return changes;
  }
  return [];
}

/** A line a person can read, rather than the call's arguments as JSON. The whole input is still carried on the event's `raw`, so nothing is lost by choosing the readable field here. */
export function claudeToolDetail(
  toolName: string,
  input: unknown,
): string | null {
  if (input === undefined) return null;
  if (!isRecord(input)) return JSON.stringify(input);
  const readable =
    asString(input.command) ??
    asString(input.pattern) ??
    asString(input.query) ??
    asString(input.url) ??
    asString(input.description) ??
    asString(input.file_path) ??
    asString(input.notebook_path);
  if (readable !== null) return readable;
  if (toolName === "AskUserQuestion") {
    const spelled = claudeQuestionText(input);
    if (spelled !== null) return spelled;
  }
  if (Object.keys(input).length === 0) return null;
  return JSON.stringify(input);
}
