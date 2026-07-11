/**
 * The model an agent is *actually* running, as opposed to the one it was
 * spawned with.
 *
 * `agents.model` is a spawn-time string, and a user who types `/model` inside a
 * session invalidates it instantly with nothing to tell Hive so. That is not
 * hypothetical: it happened, and Hive spent the afternoon reserving quota
 * against `claude-fable-5` and `sonnet` for four agents whose transcripts all
 * said `claude-opus-4-8`, while `hive status` reported the same fiction back to
 * the orchestrator. A spawn-time field is a *record of an intention*. It is not
 * an observation, and quota accounting and status display both need an
 * observation.
 *
 * The observation lives in the transcript, which the assistant stamps with its
 * model on every single turn. We deliberately do *not* take it from the
 * statusLine payload, which is the other place it appears: `runStatusline` only
 * POSTs when the payload carries a `rate_limits` block, so on an API-key
 * account, a third-party provider, or any session before its first response,
 * that report never arrives at all. Sourcing the live model there would make it
 * correct only when quota data happened to be present — the exact coupling
 * `daemon/context-window.ts` already had to route around. The transcript is
 * always there, for every Claude agent, on every plan.
 *
 * Codex is not guessed at. Its rollouts do not record a model name, so this
 * returns null and the spawn-time value stands, which is honest: an unknown
 * model is unknown, and decision 6's routing would rather see the intention
 * than a fabrication.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDirectory } from "../adapters/tools/claude";

/** The last few turns are all we need, and a transcript can be hundreds of MB. */
const TAIL_BYTES = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readTail(path: string): Promise<string | null> {
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

/** Newest `<session>.jsonl` in the worktree's Claude project directory — the
 * most-recently-modified rule SPEC decision 2 prescribes. */
async function latestTranscript(
  worktreePath: string,
  home?: string,
): Promise<string | null> {
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
  return newest?.path ?? null;
}

/** The model id on the most recent assistant turn of `tail`, or null. Scanned
 * backwards: a session that switched models mid-run has both ids in the file,
 * and the *last* one is the only one that is true now. */
export function lastAssistantModel(tail: string): string | null {
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
    const message = entry.message;
    if (!isRecord(message)) continue;
    const model = message.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

/**
 * The model this Claude agent is running right now, or null when we cannot see
 * one. Null is never "assume the spawn-time value was right" — it is the caller
 * being told there is no observation, so it can leave what it has alone.
 */
export async function readLiveClaudeModel(
  worktreePath: string,
  home?: string,
): Promise<string | null> {
  const transcript = await latestTranscript(worktreePath, home);
  if (transcript === null) return null;
  const tail = await readTail(transcript);
  if (tail === null) return null;
  return lastAssistantModel(tail);
}
