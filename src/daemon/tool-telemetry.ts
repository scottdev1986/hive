import { Database } from "bun:sqlite";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDirectory } from "../adapters/providers/claude-cli";
import { findCodexRolloutBySessionId } from "../adapters/providers/codex-cli";
import { findLatestGrokSessionDirectory } from "../adapters/providers/grok-cli";
import { findKimiSessionDirectory } from "../adapters/providers/kimi-cli";
import { opencodeDatabasePath } from "../adapters/providers/opencode-cli";
import { type CapabilityProvider, unknownVendor } from "../schemas/capability";

/**
 * Hook payloads carry neither context nor activity, so these readers use each
 * tool's durable artifacts. Reads are bounded and missing or malformed
 * artifacts report nulls rather than invented measurements.
 */
export interface ToolTelemetry {
  /** 0-100, or null for *unknown* — no usage record in the rollout. Null is
   * not zero and not full: unknown occupancy must not be read as available
   * context.
   * Codex only — the Claude reader reports tokens, not a percentage
   * (ClaudeContextTelemetry below), because its transcript never states the
   * window they fill. */
  contextPct: number | null;
  /** ISO timestamp of the artifact's last write, or null when none exists.
   * For a Codex TUI agent this is the only mid-turn liveness signal the
   * daemon has. */
  lastActivityAt: string | null;
}

export type TelemetryReader = (
  worktreePath: string,
  toolSessionId?: string,
) => Promise<ToolTelemetry>;

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
    } catch {}
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
 * is a property of the account's plan, so the same model id can have different
 * windows. Do not divide by a hardcoded window: it can report a partially used
 * context as full. This reader reports the numerator only — the
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
    const total =
      asCount(usage.input_tokens) +
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
  const directory =
    home === undefined
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
  toolSessionId: string | undefined,
  home?: string,
): Promise<ToolTelemetry> {
  if (toolSessionId === undefined) return NO_TELEMETRY;
  const rollout =
    home === undefined
      ? await findCodexRolloutBySessionId(worktreePath, toolSessionId)
      : await findCodexRolloutBySessionId(worktreePath, toolSessionId, home);
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

/** Codex's rollout records exact task boundaries. Read newest first so an
 * active task wins over every completed predecessor in the same session. */
export function lastCodexTurnCompleted(tail: string): boolean | null {
  const entries = parseJsonLines(tail);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "event_msg" ||
      !isRecord(entry.payload)
    )
      continue;
    if (entry.payload.type === "task_started") return false;
    if (entry.payload.type === "task_complete") return true;
  }
  return null;
}

/**
 * Grok telemetry, read from the session's own artifacts. Grok exposes no
 * native status transport — no statusline, no app-server — so nothing ever
 * reported a turn boundary for it and its rows froze at "spawning" for their
 * whole life.
 * These two files are the only observation there is: `signals.json` states the
 * context reading the vendor itself computed, and `updates.jsonl` records the
 * turn.
 */
export interface GrokTelemetry extends ToolTelemetry {
  /** True when the session's last update is `turn_completed` — the turn ended
   * and the agent is idle. False while a turn is still streaming. Null when no
   * update is readable: unknown, which is not idle and not working. */
  turnCompleted: boolean | null;
}

export type GrokTelemetryReader = (
  worktreePath: string,
  toolSessionId: string | undefined,
) => Promise<GrokTelemetry>;

const NO_GROK_TELEMETRY: GrokTelemetry = {
  contextPct: null,
  lastActivityAt: null,
  turnCompleted: null,
};

/** The last update in `tail`, or null when none parses. `turn_completed` is
 * genuinely the final record a turn writes, so the last record's kind is the
 * turn's state — no need to reconstruct turn boundaries. */
export function lastGrokTurnCompleted(tail: string): boolean | null {
  const entries = parseJsonLines(tail);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || !isRecord(entry.params)) continue;
    const update = entry.params.update;
    if (!isRecord(update) || typeof update.sessionUpdate !== "string") continue;
    return update.sessionUpdate === "turn_completed";
  }
  return null;
}

/** Read one already-resolved vendor artifact. Locating the artifact is kept
 * outside this poll path: recursively rediscovering all Codex rollouts every
 * second would turn a status dot into permanent filesystem churn. */
export async function readNativeTurnCompleted(
  path: string,
  tool: "codex" | "grok",
): Promise<boolean | null> {
  const tail = await readFileTail(path);
  if (tail === null) return null;
  return tool === "codex"
    ? lastCodexTurnCompleted(tail)
    : lastGrokTurnCompleted(tail);
}

export async function readGrokTelemetry(
  worktreePath: string,
  toolSessionId?: string,
  home?: string,
): Promise<GrokTelemetry> {
  if (toolSessionId === undefined) return NO_GROK_TELEMETRY;
  const directory = await findLatestGrokSessionDirectory(
    worktreePath,
    toolSessionId,
    home,
  );
  if (directory === null) return NO_GROK_TELEMETRY;

  // The vendor computes the occupancy against the window it actually served,
  // so this reads its number rather than dividing by a window of our own
  // choosing — the mistake the Claude reader's comment above is a monument to.
  let contextPct: number | null = null;
  try {
    const signals: unknown = JSON.parse(
      await readFile(join(directory, "signals.json"), "utf8"),
    );
    if (isRecord(signals) && typeof signals.contextWindowUsage === "number") {
      contextPct = clampPct(signals.contextWindowUsage);
    }
  } catch {
    // No signals.json is the shape of a cancelled turn, and of a turn that has
    // not finished one yet. Either way the occupancy is unknown, never zero.
  }

  const updates = join(directory, "updates.jsonl");
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(updates)).mtimeMs;
  } catch {
    return { contextPct, lastActivityAt: null, turnCompleted: null };
  }
  const lastActivityAt = new Date(mtimeMs).toISOString();
  const tail = await readFileTail(updates);
  return {
    contextPct,
    lastActivityAt,
    turnCompleted: tail === null ? null : lastGrokTurnCompleted(tail),
  };
}

// ---------------------------------------------------------------------------
// Count the graphify MCP calls each agent actually made, from the
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
    case "grok":
      return countGrokGraphifyCalls(slice);
    case "kimi":
      return countKimiGraphifyCalls(slice);
    case "opencode":
      // opencode's sessions live in a sqlite database, so its count is a
      // query (countOpencodeGraphifyCalls below) and never a line scan:
      // readGraphifyCalls returns from the opencode case before reaching
      // this counter.
      return 0;
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
        isRecord(item) &&
        item.type === "tool_use" &&
        typeof item.name === "string" &&
        // graph_locate is graph usage that rides Hive's own server, so the
        // adoption count must see it or the rollout metric undercounts.
        (item.name.startsWith("mcp__graphify__") ||
          item.name === "mcp__hive__graph_locate")
      )
        count++;
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
    )
      count++;
  }
  return count;
}

/**
 * Grok wraps every MCP call in one native tool, so the call's own name is NOT
 * the record's name. Measured against a real session: each call records as
 * `{"sessionUpdate":"tool_call","title":"use_tool","rawInput":{"tool_name":
 * "graphify__query_graph",...}}` — `title` is the literal string `use_tool`
 * for all of them. A counter keyed on the record's name therefore reads zero
 * forever, which is why this reads `rawInput.tool_name` and nothing else.
 */
function countGrokGraphifyCalls(slice: string): number {
  let count = 0;
  for (const entry of parseJsonLines(slice)) {
    if (!isRecord(entry) || !isRecord(entry.params)) continue;
    const update = entry.params.update;
    if (!isRecord(update) || update.sessionUpdate !== "tool_call") continue;
    if (!isRecord(update.rawInput)) continue;
    const name = update.rawInput.tool_name;
    if (typeof name !== "string") continue;
    // graph_locate rides Hive's own server, so the adoption count must see it
    // or the rollout metric undercounts — same rule as the other two vendors.
    if (name.startsWith("graphify__") || name === "hive__graph_locate") count++;
  }
  return count;
}

/**
 * Kimi's wire.jsonl wraps each loop event: a call is
 * `{"type":"context.append_loop_event","event":{"type":"tool.call","name":
 * "mcp__<server>__<tool>",...}}` — the record shape verified against a real
 * session's hive MCP calls, the graphify names against the same session's
 * model-facing tools snapshot. Tool *declarations* carry the same names
 * (`llm.tools_snapshot` and `mcp.tools_discovered` records list every tool),
 * so the counter keys on the tool.call event shape, or merely shipping the
 * graph tools would read as using them.
 */
function countKimiGraphifyCalls(slice: string): number {
  let count = 0;
  for (const entry of parseJsonLines(slice)) {
    if (!isRecord(entry) || entry.type !== "context.append_loop_event") {
      continue;
    }
    const event = entry.event;
    if (!isRecord(event) || event.type !== "tool.call") continue;
    if (typeof event.name !== "string") continue;
    if (
      event.name.startsWith("mcp__graphify__") ||
      event.name === "mcp__hive__graph_locate"
    )
      count++;
  }
  return count;
}

/**
 * opencode's tool calls are `part` rows whose data is
 * `{"type":"tool","tool":"<server>_<tool>",...}` — `hive_hive_send`,
 * `graphify_query_graph` — verified against a real session's rows. Rows are
 * indexed by session and a byte offset has no meaning inside a database, so
 * each sweep recounts the session's own rows instead of advancing a cursor.
 * A database without this session is unknown, never zero: the CLI has not
 * persisted the conversation yet, so there is nothing measured to report.
 */
function countOpencodeGraphifyCalls(
  path: string,
  toolSessionId: string,
): number | null {
  const db = new Database(path, { readonly: true });
  try {
    const session = db
      .query("SELECT 1 FROM session WHERE id = ?")
      .get(toolSessionId);
    if (session === null) return null;
    let count = 0;
    for (const row of db
      .query(
        "SELECT json_extract(data, '$.tool') AS tool FROM part " +
          "WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'",
      )
      .all(toolSessionId)) {
      if (!isRecord(row) || typeof row.tool !== "string") continue;
      if (row.tool.startsWith("graphify_") || row.tool === "hive_graph_locate")
        count++;
    }
    return count;
  } finally {
    db.close();
  }
}

/**
 * Advance a call-count cursor against the agent's own artifact. Every reader
 * requires `toolSessionId`: reused worktrees retain dead predecessors'
 * artifacts, so a latest-by-directory lookup cannot identify this agent.
 * Returns the cursor unchanged when there is nothing new, and null when there
 * is nothing to read at all — unknown, not zero.
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
      const directory =
        home === undefined
          ? claudeProjectDirectory(worktreePath)
          : claudeProjectDirectory(worktreePath, home);
      path = join(directory, `${toolSessionId}.jsonl`);
      break;
    }
    case "codex": {
      if (toolSessionId === undefined) return null;
      const rollout =
        home === undefined
          ? await findCodexRolloutBySessionId(worktreePath, toolSessionId)
          : await findCodexRolloutBySessionId(
              worktreePath,
              toolSessionId,
              home,
            );
      if (rollout === null) return cursor ?? null;
      path = rollout.path;
      break;
    }
    case "grok": {
      if (toolSessionId === undefined) return null;
      // updates.jsonl is Grok's measured source — never a transcript parser
      // from another vendor. No session directory yet is unknown, not zero.
      const directory = await findLatestGrokSessionDirectory(
        worktreePath,
        toolSessionId,
        home,
      );
      if (directory === null) return cursor ?? null;
      path = join(directory, "updates.jsonl");
      break;
    }
    case "kimi": {
      if (toolSessionId === undefined) return null;
      // The main agent's wire.jsonl is Kimi's durable transcript; subagents
      // write their own wire files under agents/<id> and describe other
      // conversations. No session directory yet is unknown, not zero.
      const directory = await findKimiSessionDirectory(toolSessionId, home);
      if (directory === null) return cursor ?? null;
      path = join(directory, "agents", "main", "wire.jsonl");
      break;
    }
    case "opencode": {
      if (toolSessionId === undefined) return null;
      const database = opencodeDatabasePath(home);
      try {
        const count = countOpencodeGraphifyCalls(database, toolSessionId);
        if (count === null) return cursor ?? null;
        return { path: database, offset: 0, count };
      } catch {
        return cursor ?? null;
      }
    }
    default:
      return unknownVendor(tool, "readGraphifyCalls");
  }

  const base =
    cursor !== undefined && cursor.path === path
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
