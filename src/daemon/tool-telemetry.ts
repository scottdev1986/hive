import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDirectory } from "../adapters/tools/claude";
import { findLatestCodexRollout } from "../adapters/tools/codex";
import { type CapabilityProvider, unknownVendor } from "../schemas/capability";

/**
 * Context and activity read from each tool's durable artifacts (SPEC
 * decision 2): Claude's transcript is its context source, and the default
 * Codex TUI driver reads rollout files. Hook traffic carries neither —
 * Claude's Stop payload has no usage and Codex's notify has no tokens — so
 * without this sensor every agent's context% sits at 0 forever and the
 * decision-7 recycle threshold can never fire. Both readers are pull-based,
 * bounded (one tail read per agent per sweep), and best-effort: a missing or
 * unparseable artifact reports nulls, never an error.
 */
export interface ToolTelemetry {
  /** 0-100, or null for *unknown* — no usage record in the rollout. Null is
   * not zero and not full: an agent whose occupancy is unknown must not be
   * recycled on the strength of it, and must not be read as having room.
   * Codex only — the Claude reader reports tokens, not a percentage
   * (ClaudeContextTelemetry below), because its transcript never states the
   * window they fill. */
  contextPct: number | null;
  /** ISO timestamp of the artifact's last write, or null when none exists.
   * For a Codex TUI agent this is the only mid-turn liveness signal the
   * daemon has. */
  lastActivityAt: string | null;
}

export type TelemetryReader = (worktreePath: string) => Promise<ToolTelemetry>;

const NO_TELEMETRY: ToolTelemetry = { contextPct: null, lastActivityAt: null };

// Enough tail to cover the last few assistant turns of either format without
// ever reading a multi-hundred-MB transcript whole.
const TAIL_BYTES = 256 * 1024;

async function readFileTail(path: string): Promise<string | null> {
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const offset = Math.max(0, size - TAIL_BYTES);
      const length = size - offset;
      if (length === 0) return "";
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(length),
        0,
        length,
        offset,
      );
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function parseJsonLines(tail: string): unknown[] {
  // The tail may begin mid-line; unparseable fragments are simply skipped.
  const parsed: unknown[] = [];
  for (const line of tail.split("\n")) {
    if (line.length === 0) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return parsed;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function clampPct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Claude context telemetry: measured TOKENS, never a percentage.
 *
 * The transcript records how many tokens a turn carried but never the window
 * they fill, and the model id cannot supply the window either: the 1M upgrade
 * is a property of the account's plan, so `claude-opus-4-8` is 200k on one
 * plan and 1M on another with a byte-identical string. A previous version of
 * this file divided by a hardcoded 200_000 and reported live agents at ~22%
 * of a 1M window as 100% full; every decision downstream of that number was
 * made against a fiction. So this reader reports the numerator only — the
 * resident context in tokens, summed from the transcript — and the sweep
 * (server.ts) divides by the window the statusline payload measured, or
 * reports unknown when no window has ever been observed.
 */
export interface ClaudeContextTelemetry {
  /** Resident context in tokens — the last non-sidechain assistant turn's
   * usage sum (input + cache reads + cache writes + output), which is exactly
   * the quantity Claude Code's own `context_window.current_usage` reports.
   * Null when no such turn is visible: unknown, not empty. */
  contextTokens: number | null;
  /** ISO timestamp of the transcript's last write, or null when none exists. */
  lastActivityAt: string | null;
}

export type ClaudeTelemetryReader = (
  worktreePath: string,
  toolSessionId: string | undefined,
) => Promise<ClaudeContextTelemetry>;

const NO_CLAUDE_TELEMETRY: ClaudeContextTelemetry = {
  contextTokens: null,
  lastActivityAt: null,
};

/** The last non-sidechain assistant turn's usage sum in `tail`, or null.
 * Scanned backwards: only the most recent turn describes the context that is
 * resident *now*. Sidechain (subagent) turns report a different conversation's
 * context and are skipped. */
export function lastAssistantContextTokens(tail: string): number | null {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // The tail may begin mid-line, and a partial write may end it.
      continue;
    }
    if (!isRecord(entry) || entry.type !== "assistant") continue;
    if (entry.isSidechain === true) continue;
    if (!isRecord(entry.message) || !isRecord(entry.message.usage)) continue;
    const usage = entry.message.usage;
    const total = asCount(usage.input_tokens) +
      asCount(usage.cache_creation_input_tokens) +
      asCount(usage.cache_read_input_tokens) +
      asCount(usage.output_tokens);
    if (total > 0) return total;
  }
  return null;
}

/**
 * Read this agent's own `<toolSessionId>.jsonl`, never "the newest file in
 * the directory". Worktrees are reused across respawns, so the project
 * directory still holds every dead predecessor's transcript, and a fresh
 * agent that has not spoken yet would otherwise inherit its predecessor's
 * context reading. No session id means no hook traffic yet and nothing of
 * this agent's own to read: unknown, not a neighbour's number.
 */
export async function readClaudeTelemetry(
  worktreePath: string,
  toolSessionId: string | undefined,
  home?: string,
): Promise<ClaudeContextTelemetry> {
  if (toolSessionId === undefined) return NO_CLAUDE_TELEMETRY;
  const directory = home === undefined
    ? claudeProjectDirectory(worktreePath)
    : claudeProjectDirectory(worktreePath, home);
  const path = join(directory, `${toolSessionId}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return NO_CLAUDE_TELEMETRY;
  }
  const lastActivityAt = new Date(mtimeMs).toISOString();
  const tail = await readFileTail(path);
  if (tail === null) return { contextTokens: null, lastActivityAt };
  return { contextTokens: lastAssistantContextTokens(tail), lastActivityAt };
}

export async function readCodexTelemetry(
  worktreePath: string,
  home?: string,
): Promise<ToolTelemetry> {
  const rollout = home === undefined
    ? await findLatestCodexRollout(worktreePath)
    : await findLatestCodexRollout(worktreePath, home);
  if (rollout === null) return NO_TELEMETRY;
  const lastActivityAt = new Date(rollout.mtimeMs).toISOString();
  const tail = await readFileTail(rollout.path);
  if (tail === null) return { contextPct: null, lastActivityAt };

  // Rollouts carry explicit token_count events with the model's context
  // window; the last request's prompt size plus its reply is the occupancy.
  let contextPct: number | null = null;
  for (const entry of parseJsonLines(tail)) {
    if (!isRecord(entry) || !isRecord(entry.payload)) continue;
    const payload = entry.payload;
    if (payload.type !== "token_count" || !isRecord(payload.info)) continue;
    const info = payload.info;
    const window = asCount(info.model_context_window);
    if (window === 0) continue;
    const usage = isRecord(info.last_token_usage)
      ? info.last_token_usage
      : isRecord(info.total_token_usage)
      ? info.total_token_usage
      : null;
    if (usage === null) continue;
    const total = asCount(usage.input_tokens) + asCount(usage.output_tokens);
    if (total > 0) contextPct = clampPct((100 * total) / window);
  }
  return { contextPct, lastActivityAt };
}

// ---------------------------------------------------------------------------
// Graphify adoption telemetry (docs/architecture/graphify-integration.md,
// layer 3): count the graphify MCP calls each agent actually made, from the
// same durable artifacts the context readers use. Measured, never assumed —
// a shipped tool nobody calls is pure context cost, and only this number can
// say which it is. Counts are cursor-incremental (each sweep reads only the
// bytes appended since the last one) and rebuild from offset zero after a
// daemon restart, because the transcripts are durable and the cursor is not.
// ---------------------------------------------------------------------------

export interface GraphifyCallCursor {
  /** The artifact the count came from. A changed path resets the count: a
   * fresh rollout is a fresh conversation, never a continuation. */
  path: string;
  /** Bytes already counted — always the end of a complete line. */
  offset: number;
  count: number;
}

/** Count graphify MCP calls in complete transcript lines. Pure; exported for
 * tests. Claude records tool use as assistant-message content items named
 * `mcp__<server>__<tool>`; Codex rollouts record `mcp_tool_call_end` events
 * whose invocation names the server (both shapes verified against real
 * artifacts of the pinned versions). */
export function countGraphifyCallLines(
  slice: string,
  tool: CapabilityProvider,
): number {
  // The vendor is resolved before the scan, not per line: an unknown vendor
  // must fail on an empty slice too, or it reports a plausible zero.
  switch (tool) {
    case "claude":
      return countClaudeGraphifyCalls(slice);
    case "codex":
      return countCodexGraphifyCalls(slice);
    default:
      return unknownVendor(tool, "countGraphifyCallLines");
  }
}

function countClaudeGraphifyCalls(slice: string): number {
  let count = 0;
  for (const entry of parseJsonLines(slice)) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    if (!isRecord(entry.message) || !Array.isArray(entry.message.content)) {
      continue;
    }
    for (const item of entry.message.content) {
      if (
        isRecord(item) && item.type === "tool_use" &&
        typeof item.name === "string" &&
        // graph_locate is graph usage that rides Hive's own server, so the
        // adoption count must see it or the rollout metric undercounts.
        (item.name.startsWith("mcp__graphify__") ||
          item.name === "mcp__hive__graph_locate")
      ) count++;
    }
  }
  return count;
}

function countCodexGraphifyCalls(slice: string): number {
  let count = 0;
  for (const entry of parseJsonLines(slice)) {
    if (!isRecord(entry)) continue;
    if (!isRecord(entry.payload)) continue;
    const payload = entry.payload;
    if (payload.type !== "mcp_tool_call_end") continue;
    if (
      isRecord(payload.invocation) &&
      (payload.invocation.server === "graphify" ||
        (payload.invocation.server === "hive" &&
          payload.invocation.tool === "graph_locate"))
    ) count++;
  }
  return count;
}

/**
 * Advance a call-count cursor against the agent's own artifact. Claude reads
 * are keyed by `toolSessionId` — never "newest file in the directory", which
 * inherits a dead predecessor's transcript across respawns. The Codex rollout
 * is still discovered per worktree and carries that known aliasing; the
 * changed-path reset above bounds it to one rollout's worth. Returns the
 * cursor unchanged when there is nothing new, and null when there is nothing
 * to read at all — unknown, not zero.
 */
export async function readGraphifyCalls(
  tool: CapabilityProvider,
  worktreePath: string,
  toolSessionId: string | undefined,
  cursor: GraphifyCallCursor | undefined,
  home?: string,
): Promise<GraphifyCallCursor | null> {
  let path: string;
  switch (tool) {
    case "claude": {
      if (toolSessionId === undefined) return null;
      const directory = home === undefined
        ? claudeProjectDirectory(worktreePath)
        : claudeProjectDirectory(worktreePath, home);
      path = join(directory, `${toolSessionId}.jsonl`);
      break;
    }
    case "codex": {
      const rollout = home === undefined
        ? await findLatestCodexRollout(worktreePath)
        : await findLatestCodexRollout(worktreePath, home);
      if (rollout === null) return cursor ?? null;
      path = rollout.path;
      break;
    }
    default:
      return unknownVendor(tool, "readGraphifyCalls");
  }

  const base = cursor !== undefined && cursor.path === path
    ? cursor
    : { path, offset: 0, count: 0 };
  let slice: string;
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size <= base.offset) return base;
      const length = size - base.offset;
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(length),
        0,
        length,
        base.offset,
      );
      slice = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return cursor ?? null;
  }
  // Only complete lines count; a partial trailing write is left for the next
  // sweep so no entry is ever split and lost.
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline === -1) return base;
  const complete = slice.slice(0, lastNewline + 1);
  return {
    path,
    offset: base.offset + Buffer.byteLength(complete, "utf8"),
    count: base.count + countGraphifyCallLines(complete, tool),
  };
}
