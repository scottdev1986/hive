import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDirectory } from "../adapters/tools/claude";
import { findLatestCodexRollout } from "../adapters/tools/codex";

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
