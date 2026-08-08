import { percentOfWindow } from "../../../usage-service/context-occupancy";
import type {
  ElicitationOption,
  NormalizedProviderEvent,
  ToolFileChange,
  ToolKind,
  VendorCommand,
} from "./types";

export type EmittableNormalizedEvent<T = NormalizedProviderEvent> =
  T extends NormalizedProviderEvent
    ? Omit<T, "sequence" | "occurredAt" | "raw"> & { raw?: unknown }
    : never;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Preserve a vendor's own terminal explanation across the shared ACP path. */
export function vendorFailureReason(value: unknown, fallback: string): string {
  const root = asRecord(value);
  const error = asRecord(root?.error);
  return (
    asString(error?.message)?.trim() ||
    asString(root?.message)?.trim() ||
    asString(root?.error)?.trim() ||
    fallback
  );
}

function contentText(content: unknown): string {
  const record = asRecord(content);
  if (record === null) return "";
  if (typeof record.text === "string") return record.text;
  return "";
}

const TOOL_KINDS = new Set<string>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

function toolKind(value: unknown): ToolKind | null {
  const kind = asString(value)?.toLowerCase() ?? null;
  return kind !== null && TOOL_KINDS.has(kind) ? (kind as ToolKind) : null;
}

/** The kind of work a tool call is doing, from wherever the vendor states it. Grok omits ACP's `kind` and puts its own under `_meta["x.ai/tool"]`, where the vocabulary is close but not identical — `list` has no ACP equivalent and stays unclassified rather than being forced into `other`. */
function resolvedToolKind(update: Record<string, unknown>): ToolKind | null {
  const declared = toolKind(update.kind);
  if (declared !== null) return declared;
  const meta = asRecord(asRecord(update._meta)?.["x.ai/tool"]);
  return toolKind(meta?.kind);
}

function toolLocations(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const entry of value) {
    const path = asString(asRecord(entry)?.path);
    if (path !== null && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** A question asked as an ordinary tool call, rendered as text. Grok's `ask_user_question` arrives as a `tool_call` rather than a `session/request_permission`, and it does not block on a reply — the turn runs on and the call completes on its own. There is no answer channel to offer, so the question and its choices are shown as the call's detail: a person can read what was asked and reply in the composer, which is the only route the vendor left open. */
function askedQuestionText(rawInput: unknown): string | null {
  const questions = asRecord(rawInput)?.questions;
  if (!Array.isArray(questions)) return null;
  const blocks: string[] = [];
  for (const entry of questions) {
    const record = asRecord(entry);
    const text = asString(record?.question);
    if (text === null) continue;
    const lines = [text];
    if (Array.isArray(record?.options)) {
      for (const option of record.options) {
        const label = asString(asRecord(option)?.label);
        if (label === null) continue;
        const description = asString(asRecord(option)?.description);
        lines.push(
          description === null
            ? `  • ${label}`
            : `  • ${label} — ${description}`,
        );
      }
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.length === 0 ? null : blocks.join("\n\n");
}

function namedLocations(
  locations: unknown,
  content: unknown,
): readonly string[] {
  const named = toolLocations(locations);
  if (named.length > 0) return named;
  const paths: string[] = [];
  for (const change of toolFileChanges(content)) {
    if (!paths.includes(change.path)) paths.push(change.path);
  }
  return paths;
}

export function toolOutputText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null || record.type === "diff") continue;
    const text = contentText(record.content) || contentText(record);
    if (text !== "") texts.push(text);
  }
  return texts.length === 0 ? null : texts.join("\n");
}

/** The `type: "diff"` members of an ACP `ToolCallContent[]`. ACP sends whole file contents rather than a patch, so the rendering side is what turns these into a diff — this only stops them being thrown away. */
export function toolFileChanges(value: unknown): readonly ToolFileChange[] {
  if (!Array.isArray(value)) return [];
  const changes: ToolFileChange[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record?.type !== "diff") continue;
    const path = asString(record.path);
    const newText = asString(record.newText) ?? asString(record.new_text);
    if (path === null || newText === null) continue;
    changes.push({
      path,
      oldText: asString(record.oldText) ?? asString(record.old_text),
      newText,
    });
  }
  return changes;
}

export function normalizeSessionUpdate(
  params: unknown,
  turnId: string | null,
): EmittableNormalizedEvent[] {
  const root = asRecord(params);
  if (root === null) {
    return [{ kind: "unrecognized", raw: params }];
  }
  const update = asRecord(root.update) ?? root;
  const kind =
    asString(update.sessionUpdate) ?? asString(update.session_update);
  const activeTurn = turnId ?? "unknown-turn";

  switch (kind) {
    case "agent_message_chunk":
    case "user_message_chunk": {
      const text = contentText(update.content);
      if (text === "" && kind === "user_message_chunk") {
        return [{ kind: "unrecognized", raw: params }];
      }
      if (kind === "user_message_chunk") {
        return [{ kind: "unrecognized", raw: params }];
      }
      return [
        {
          kind: "message-delta",
          turnId: activeTurn,
          text,
          raw: params,
        },
      ];
    }
    case "agent_thought_chunk": {
      return [
        {
          kind: "thought-delta",
          turnId: activeTurn,
          text: contentText(update.content),
          raw: params,
        },
      ];
    }
    case "tool_call": {
      const toolCallId =
        asString(update.toolCallId) ??
        asString(update.tool_call_id) ??
        "unknown-tool";
      const metaTool = asRecord(asRecord(update._meta)?.["x.ai/tool"]);
      const resolvedName =
        asString(metaTool?.name) ??
        asString(update.name) ??
        asString(update.title) ??
        "tool";
      return [
        {
          kind: "tool-started",
          turnId: activeTurn,
          toolCallId,
          toolName: resolvedName,
          detail:
            askedQuestionText(update.rawInput ?? update.raw_input) ??
            asString(update.title),
          toolKind: resolvedToolKind(update),
          locations: namedLocations(update.locations, update.content),
          changes: toolFileChanges(update.content),
          output: toolOutputText(update.content),
          raw: params,
        },
      ];
    }
    case "tool_call_update": {
      const toolCallId =
        asString(update.toolCallId) ??
        asString(update.tool_call_id) ??
        "unknown-tool";
      const status = asString(update.status);
      // A collection the update did not mention is left standing rather than replaced with nothing: ACP puts a call's diff on whichever update happens to carry it, and that is often the one that also completes it. Only what this update actually states is carried. Grok sends `_meta` on every update but names the tool kind on only some of them, so writing an unresolved kind would blank the icon a moment after showing it.
      const updatedKind = resolvedToolKind(update);
      const updatedLocations = namedLocations(update.locations, update.content);
      const carried = {
        ...(updatedKind === null ? {} : { toolKind: updatedKind }),
        ...(updatedLocations.length === 0
          ? {}
          : { locations: updatedLocations }),
        ...(update.content === undefined
          ? {}
          : {
              changes: toolFileChanges(update.content),
              output: toolOutputText(update.content),
            }),
      };
      if (status === "completed" || status === "failed" || status === "error") {
        const finished: EmittableNormalizedEvent[] = [];
        // The detail and the changes have to land before the call stops being running, or a completed call shows the title it was started with.
        if (Object.keys(carried).length > 0 || update.title !== undefined) {
          finished.push({
            kind: "tool-updated",
            turnId: activeTurn,
            toolCallId,
            detail: asString(update.title),
            ...carried,
            raw: params,
          });
        }
        finished.push(
          status === "completed"
            ? {
                kind: "tool-finished",
                turnId: activeTurn,
                toolCallId,
                status: "ok",
                raw: params,
              }
            : {
                kind: "tool-finished",
                turnId: activeTurn,
                toolCallId,
                status: "error",
                reason: toolOutputText(update.content),
                raw: params,
              },
        );
        return finished;
      }
      return [
        {
          kind: "tool-updated",
          turnId: activeTurn,
          toolCallId,
          detail: asString(update.title),
          ...carried,
          raw: params,
        },
      ];
    }
    case "available_commands_update": {
      const commands = parseAvailableCommands(update.availableCommands);
      return [{ kind: "commands-updated", commands, raw: params }];
    }
    case "usage_update": {
      return [
        {
          kind: "usage-updated",
          turnId: activeTurn,
          contextPercent: numberOrNull(
            update.used !== undefined && update.size !== undefined
              ? // used/size → percent when both are finite numbers
                percentOfWindow(
                  typeof update.used === "number" ? update.used : null,
                  typeof update.size === "number" ? update.size : null,
                )
              : (update.contextPercent ?? update.context_percent),
          ),
          inputTokens: numberOrNull(update.inputTokens ?? update.input_tokens),
          outputTokens: numberOrNull(
            update.outputTokens ?? update.output_tokens,
          ),
          raw: params,
        },
      ];
    }
    case "plan":
    case "plan_update": {
      const entries = Array.isArray(update.entries)
        ? update.entries.map((entry) => {
            if (typeof entry === "string") return entry;
            const rec = asRecord(entry);
            return (
              asString(rec?.content) ??
              asString(rec?.text) ??
              JSON.stringify(entry)
            );
          })
        : [];
      return [
        {
          kind: "plan-updated",
          turnId: activeTurn,
          entries,
          raw: params,
        },
      ];
    }
    default:
      return [{ kind: "unrecognized", raw: params }];
  }
}

export function normalizeVendorNotification(
  method: string,
  params: unknown,
  turnId: string | null,
): EmittableNormalizedEvent[] {
  const root = asRecord(params);
  if (
    method === "_x.ai/session/prompt_complete" ||
    method.endsWith("/prompt_complete")
  ) {
    const stop = asString(root?.stopReason) ?? asString(root?.stop_reason);
    const promptId =
      asString(root?.promptId) ??
      asString(root?.prompt_id) ??
      turnId ??
      "unknown-turn";
    if (stop === "cancelled" || stop === "interrupted") {
      return [{ kind: "interrupted", turnId: promptId, raw: params }];
    }
    if (stop === "end_turn" || stop === "max_tokens" || stop === null) {
      return [{ kind: "turn-idle", turnId: promptId, raw: params }];
    }
    return [
      {
        kind: "turn-failed",
        turnId: promptId,
        reason: vendorFailureReason(root, stop ?? "unknown stopReason"),
        raw: params,
      },
    ];
  }

  if (method === "_x.ai/session_notification") {
    const update = asRecord(root?.update);
    const kind = asString(update?.sessionUpdate);
    if (kind === "turn_completed") {
      const stop =
        asString(update?.stop_reason) ?? asString(update?.stopReason);
      const promptId =
        asString(update?.prompt_id) ??
        asString(update?.promptId) ??
        turnId ??
        "unknown-turn";
      if (stop === "cancelled" || stop === "interrupted") {
        return [{ kind: "interrupted", turnId: promptId, raw: params }];
      }
      const usage = asRecord(update?.usage);
      const terminal: EmittableNormalizedEvent =
        stop === "end_turn" || stop === "max_tokens" || stop === null
          ? { kind: "turn-idle", turnId: promptId, raw: params }
          : {
              kind: "turn-failed",
              turnId: promptId,
              reason: vendorFailureReason(update, stop ?? "unknown stopReason"),
              raw: params,
            };
      const events: EmittableNormalizedEvent[] = [terminal];
      if (usage !== null) {
        events.unshift({
          kind: "usage-updated",
          turnId: promptId,
          contextPercent: null,
          ...decodeUsageTokens(usage),
          usageKey: `turn:${promptId}`,
          cumulative: false,
          source: "grok-turn-completed",
          observedAt: new Date().toISOString(),
          raw: params,
        });
      }
      return events;
    }
    if (kind === "pending_interaction") {
      // Permission is delivered as session/request_permission; this is context only.
      return [{ kind: "unrecognized", raw: params }];
    }
  }

  return [{ kind: "unrecognized", raw: params }];
}

export function parseAvailableCommands(
  value: unknown,
): readonly VendorCommand[] {
  if (!Array.isArray(value)) return [];
  const out: VendorCommand[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (rec === null) continue;
    const name = asString(rec.name);
    if (name === null) continue;
    // OpenCode documented ACP gap: never surface undo/redo even if a future build leaks them into available_commands_update.
    if (
      name === "undo" ||
      name === "redo" ||
      name === "/undo" ||
      name === "/redo"
    ) {
      continue;
    }
    const description = asString(rec.description);
    const input = asRecord(rec.input);
    const argumentHint =
      asString(input?.hint) ?? asString(rec.input) ?? undefined;
    out.push({
      name,
      description,
      ...(argumentHint !== undefined ? { argumentHint } : {}),
    });
  }
  return out;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function decodeUsageTokens(usage: Record<string, unknown>): {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly reasoningTokens: number | null;
} {
  return {
    inputTokens: numberOrNull(usage.inputTokens ?? usage.input_tokens),
    outputTokens: numberOrNull(usage.outputTokens ?? usage.output_tokens),
    cachedInputTokens: numberOrNull(
      usage.cachedReadTokens ?? usage.cached_read_tokens,
    ),
    cacheCreationInputTokens: numberOrNull(
      usage.cacheCreationTokens ?? usage.cache_creation_tokens,
    ),
    reasoningTokens: numberOrNull(
      usage.reasoningTokens ?? usage.reasoning_tokens,
    ),
  };
}

export function permissionOptions(
  params: unknown,
): readonly { optionId: string; kind: string; name: string }[] {
  const root = asRecord(params);
  const options = root?.options;
  if (!Array.isArray(options)) return [];
  const out: { optionId: string; kind: string; name: string }[] = [];
  for (const entry of options) {
    const rec = asRecord(entry);
    if (rec === null) continue;
    const optionId = asString(rec.optionId) ?? asString(rec.id);
    if (optionId === null) continue;
    out.push({
      optionId,
      kind: asString(rec.kind) ?? "",
      name: asString(rec.name) ?? "",
    });
  }
  return out;
}

export function toolNameFromPermission(params: unknown): string | null {
  const root = asRecord(params);
  const toolCall = asRecord(root?.toolCall) ?? asRecord(root?.tool_call);
  if (toolCall === null) return null;
  const meta = asRecord(asRecord(toolCall._meta)?.["x.ai/tool"]);
  return (
    asString(meta?.name) ??
    asString(toolCall.title) ??
    asString(toolCall.name) ??
    null
  );
}

export function permissionSummary(params: unknown): string {
  const root = asRecord(params);
  const toolCall = asRecord(root?.toolCall) ?? asRecord(root?.tool_call);
  if (toolCall === null) return "permission request";
  const title = asString(toolCall.title);
  if (title !== null) return title;
  const rawInput = asRecord(toolCall.rawInput) ?? asRecord(toolCall.raw_input);
  const command = asString(rawInput?.command);
  if (command !== null) return command;
  return "permission request";
}

export function permissionDetail(params: unknown): string | null {
  const root = asRecord(params);
  const toolCall = asRecord(root?.toolCall) ?? asRecord(root?.tool_call);
  if (toolCall === null) return null;
  const texts: string[] = [];
  if (Array.isArray(toolCall.content)) {
    for (const entry of toolCall.content) {
      const record = asRecord(entry);
      if (record === null) continue;
      const text = contentText(record.content) || contentText(record);
      if (text !== "") texts.push(text);
    }
  }
  if (texts.length > 0) return texts.join("\n");
  const rawInput = asRecord(toolCall.rawInput) ?? asRecord(toolCall.raw_input);
  return asString(rawInput?.command) ?? asString(rawInput?.question);
}

/** The answers the vendor will accept, in the shape the screen shows them. An option list Hive cannot read stays empty rather than being filled with a plausible allow/deny pair: the picker offers nothing sooner than it offers a choice the vendor never made. */
export function elicitationOptions(
  params: unknown,
): readonly ElicitationOption[] {
  return permissionOptions(params).map((option) => ({
    optionId: option.optionId,
    name: option.name === "" ? option.optionId : option.name,
    kind: option.kind.startsWith("allow")
      ? "allow"
      : option.kind.startsWith("reject")
        ? "reject"
        : null,
  }));
}
