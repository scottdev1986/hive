/**
 * The context window, taken from the tool that measures it.
 *
 * Claude's transcript records how many tokens a turn used but never the window
 * those tokens fill, and the model id cannot supply it either: the 1M upgrade
 * is a property of the account's plan, not of the model. `claude-opus-4-8` is
 * 200k on one plan and 1M on another and the string is byte-identical in both,
 * and the CLI's `[1m]` marker never reaches the transcript. So every
 * denominator derived from a model name is a guess, and this is a place where a
 * guess is not merely imprecise — it is a number the orchestrator will act on.
 *
 * Claude Code already knows the answer and already hands it to us. The
 * statusLine command it spawns on every render receives, on stdin,
 * `context_window.context_window_size` — the real 200000 or 1000000 — along
 * with its own `used_percentage`. `hive statusline` *is* that command
 * (adapters/tools/claude.ts writes it into the agent's settings), so the true
 * window has been arriving continuously all along and being dropped on the
 * floor: the parser read `rate_limits` and nothing else.
 *
 * This module is the seam between the two halves. `hive statusline` writes down
 * what Claude Code told it; the daemon's telemetry sweep reads it back. Neither
 * side infers anything, which is the whole point.
 *
 * An agent with no observation yet reports `null` — never a number. That is the
 * same rule the quota schema states (schemas/quota.ts): a window we have no
 * measurement for is `null`, never `0`, because a plausible wrong number is
 * acted on and a missing one is not.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getHiveHome } from "./db";

export interface ContextObservation {
  /** The window Claude Code reported, in tokens. Measured, never inferred. */
  readonly contextWindow: number;
  /** Claude Code's own occupancy percentage, when the payload carried one. */
  readonly usedPct: number | null;
  readonly observedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One file per worktree, keyed the way Claude keys its own project directory,
 * so the writer (which knows a cwd) and the reader (which knows a worktree)
 * agree without either needing the agent's name. */
export function contextObservationPath(
  worktreePath: string,
  hiveHome: string = getHiveHome(),
): string {
  const slug = resolve(worktreePath).replaceAll(/[^A-Za-z0-9]/g, "-");
  return join(hiveHome, "context", `${slug}.json`);
}

/**
 * Pull the window out of a statusLine payload. Returns null — not a default —
 * when the payload carries no window, so a Claude Code that stops sending one
 * degrades to "unknown" rather than to a confidently wrong denominator.
 */
export function parseContextObservation(
  payload: unknown,
  observedAt: string,
): ContextObservation | null {
  if (!isRecord(payload)) return null;
  const block = payload.context_window;
  if (!isRecord(block)) return null;

  const size = block.context_window_size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const used = block.used_percentage;
  return {
    contextWindow: size,
    usedPct: typeof used === "number" && Number.isFinite(used)
      ? Math.min(100, Math.max(0, used))
      : null,
    observedAt,
  };
}

/** The cwd the payload describes, so the observation lands under the right
 * worktree. Falls back to this process's cwd, which is the session's worktree:
 * Claude Code spawns the statusLine command inside it. */
export function payloadWorktree(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    const workspace = payload.workspace;
    if (isRecord(workspace) && typeof workspace.current_dir === "string") {
      return workspace.current_dir;
    }
    if (typeof payload.cwd === "string") return payload.cwd;
  }
  return fallback;
}

/**
 * Best-effort write. The status line renders on every keystroke and must never
 * throw into the agent's terminal, so a home that cannot be written loses the
 * observation, not the session. The rename keeps a concurrent reader from ever
 * seeing a half-written file.
 */
export function writeContextObservation(
  worktreePath: string,
  observation: ContextObservation,
  hiveHome: string = getHiveHome(),
): void {
  try {
    const path = contextObservationPath(worktreePath, hiveHome);
    mkdirSync(join(hiveHome, "context"), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(observation)}\n`);
    renameSync(temporary, path);
  } catch {
    // A missed observation is a stale one, never a failed render.
  }
}

/** The last window Claude Code reported for this worktree, or null when it has
 * never reported one. Null is the honest answer, and callers must treat it as
 * "unknown", not as empty. */
export function readContextObservation(
  worktreePath: string,
  hiveHome: string = getHiveHome(),
): ContextObservation | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(contextObservationPath(worktreePath, hiveHome), "utf8"),
    );
    if (!isRecord(parsed)) return null;
    const size = parsed.contextWindow;
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      return null;
    }
    const used = parsed.usedPct;
    return {
      contextWindow: size,
      usedPct: typeof used === "number" && Number.isFinite(used) ? used : null,
      observedAt: typeof parsed.observedAt === "string" ? parsed.observedAt : "",
    };
  } catch {
    return null;
  }
}
