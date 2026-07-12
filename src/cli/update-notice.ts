/**
 * The passive update notice, npm/gh/brew shape: one dim line at the END of a
 * user-facing command, never at the start, never in the way.
 *
 * The check starts when the command starts and runs concurrently, so a warm
 * cache costs nothing and a cold one overlaps the command's own work; its
 * network budget is short enough that even `hive status` on an offline
 * machine is not held hostage. Rendering, dismissal, the 24-hour display
 * rate limit, and the security-release bypass all live in
 * src/update/notice.ts — this module only decides *when* to ask and *where*
 * the "last shown" timestamp lives, and prints whatever the renderer says.
 *
 * Session-boundary commands (bare `hive`, init, claude, codex) are excluded:
 * they already print the richer start notice through startSession, and two
 * version lines per command is one too many. Machine-facing commands (hooks,
 * bridges, hidden process boundaries) never speak at all.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHiveHome } from "../daemon/db";
import {
  checkForUpdate,
  fetchLatestFromGitHub,
  readUpdateCache,
  type UpdateCheck,
} from "../update/check";
import { renderUpdateNotice } from "../update/notice";
import { detectInstallMethod } from "../update/paths";

/** How long the end-of-command check may spend on the network. A miss is not
 * an error: the result lands in the on-disk cache and the next command shows
 * it instantly. */
export const NOTICE_NETWORK_BUDGET_MS = 300;

/** Commands that earn the trailing notice. Everything else is either a
 * session boundary (start notice already printed), the updater itself, or a
 * machine-facing surface where a version line would corrupt a protocol. */
const USER_FACING_COMMANDS = new Set([
  "status",
  "quota",
  "autonomy",
  "memory",
  "watch",
  "layout",
  "stop",
  "recover",
]);

/** Where the "last shown" timestamp lives. Deliberately not inside
 * update-check.json: that file records what we know about releases, this one
 * records when we last interrupted the user, and they change on different
 * schedules. */
export const noticeStatePath = (): string =>
  join(getHiveHome(), "update-notice.json");

export function readLastNoticeAt(path = noticeStatePath()): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const at = (parsed as { lastNoticeAt?: unknown } | null)?.lastNoticeAt;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export function writeLastNoticeAt(
  lastNoticeAt: number,
  path = noticeStatePath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ lastNoticeAt })}\n`);
  } catch {
    // A read-only home loses the rate-limit marker, not the command.
  }
}

/** Whether this invocation gets a trailing notice at all: an allowlisted
 * user-facing command, on a real terminal, outside CI. */
export function wantsUpdateNotice(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = process.stdout.isTTY === true,
): boolean {
  if (!stdoutIsTTY) return false;
  if (env.CI !== undefined) return false;
  return USER_FACING_COMMANDS.has(argv[2] ?? "");
}

export interface UpdateNoticeDeps {
  readonly check?: () => Promise<UpdateCheck>;
  readonly now?: () => number;
  readonly statePath?: string;
}

/** The check with its network budget clamped: the same on-disk cache
 * checkForUpdate always maintains, but a cold fetch aborts fast instead of
 * keeping the process alive after the command has finished. */
const budgetedFetch = ((input, init) =>
  fetch(input, {
    ...init,
    signal: AbortSignal.timeout(NOTICE_NETWORK_BUDGET_MS),
  })) as typeof fetch;

const budgetedCheck = (): Promise<UpdateCheck> =>
  checkForUpdate({
    fetchLatest: () => fetchLatestFromGitHub(undefined, budgetedFetch),
    now: () => Date.now(),
  });

/** Resolve the notice line, or null for silence. Never rejects: a failed or
 * timed-out check is indistinguishable from "nothing to say". */
export async function resolveUpdateNotice(
  deps: UpdateNoticeDeps = {},
): Promise<string | null> {
  try {
    const now = (deps.now ?? Date.now)();
    const statePath = deps.statePath ?? noticeStatePath();
    const check = await (deps.check ?? budgetedCheck)();
    const line = renderUpdateNotice({
      check,
      installMethod: detectInstallMethod(process.execPath),
      cache: readUpdateCache(),
      now,
      // TTY and CI were decided in wantsUpdateNotice, before the check began.
      interactive: true,
      lastNoticeAt: readLastNoticeAt(statePath),
    });
    if (line !== null) writeLastNoticeAt(now, statePath);
    return line;
  } catch {
    return null;
  }
}

/** Run a command with the notice check alongside it, printing only after the
 * command finishes — and only when it finishes normally. A failed command's
 * error is the last thing the user reads, not a version advertisement. */
export async function withTrailingUpdateNotice<T>(
  enabled: boolean,
  run: () => Promise<T>,
  deps: UpdateNoticeDeps = {},
  write: (line: string) => void = (line) =>
    process.stderr.write(`${line}\n`),
): Promise<T> {
  if (!enabled) return run();
  const pending = resolveUpdateNotice(deps);
  const result = await run();
  const line = await pending;
  if (line !== null) write(line);
  return result;
}
