import { open, readdir, stat } from "node:fs/promises";
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
  /** 0-100, or null for *unknown* — no usage record, or (for Claude) no
   * measured context window to divide by. Null is not zero and not full: an
   * agent whose occupancy is unknown must not be recycled on the strength of
   * it, and must not be read as having room. */
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

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Newest `<session>.jsonl` in the worktree's Claude project directory — the
 * same most-recently-modified rule SPEC decision 2 prescribes over the
 * stale-able Stop-hook transcript_path. */
async function findLatestClaudeTranscript(
  worktreePath: string,
  home?: string,
): Promise<{ path: string; mtimeMs: number } | null> {
  const directory = home === undefined
    ? claudeProjectDirectory(worktreePath)
    : claudeProjectDirectory(worktreePath, home);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    try {
      const path = join(directory, entry);
      const info = await stat(path);
      if (newest === null || info.mtimeMs > newest.mtimeMs) {
        newest = { path, mtimeMs: info.mtimeMs };
      }
    } catch {
      // A transcript deleted mid-scan is simply not a candidate.
    }
  }
  return newest;
}

/**
 * Claude's liveness from its transcript — and deliberately NOT its occupancy.
 *
 * This function used to divide the transcript's token count by a hardcoded
 * 200_000, and the comment that justified the constant argued that a
 * larger-window model would merely read "conservatively high", erring toward
 * recycling early. Both halves were wrong.
 *
 * The window is wrong because it cannot be known from here. The transcript
 * records how many tokens a turn used but never the window they fill, and the
 * model id cannot supply it either: the 1M upgrade is a property of the
 * account's plan, so `claude-opus-4-8` is 200k on one plan and 1M on another
 * with a byte-identical string, and the CLI's `[1m]` marker never reaches the
 * transcript. There is no denominator in this file, only a plausible-looking
 * one.
 *
 * The reasoning is wrong because reading high is not the safe direction.
 * Recycling an agent is not free: it discards the context we paid to build and
 * re-pays, out of a quota pool that may be nearly exhausted, to rebuild it. The
 * bug that followed was not a rounding error. Live agents at ~22% of a 1M
 * window reported 100% full, and every decision downstream of that number was
 * made against a fiction — agents were respawned and re-briefed when they
 * should have been reused. A number the orchestrator acts on is never safe to
 * guess in either direction, and "unknown" is a better answer than a confident
 * wrong one, because a missing number stops a bad decision and a wrong number
 * causes one.
 *
 * So occupancy is not computed here at all any more. It is measured by Claude
 * Code, handed to `hive statusline` on every render, and travels the single
 * POST /statusline route onto the agent's row (cli/statusline.ts). This sweep
 * reports `contextPct: null` — unknown — and the transcript's only remaining
 * job is `lastActivityAt`. Codex is untouched below and needs no such
 * surgery: its rollout states `model_context_window` outright, which is the
 * same principle already working. Read what the tool measures; infer only what
 * nothing tells us.
 */
export async function readClaudeTelemetry(
  worktreePath: string,
  home?: string,
): Promise<ToolTelemetry> {
  const transcript = await findLatestClaudeTranscript(worktreePath, home);
  if (transcript === null) return NO_TELEMETRY;
  return {
    contextPct: null,
    lastActivityAt: new Date(transcript.mtimeMs).toISOString(),
  };
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
