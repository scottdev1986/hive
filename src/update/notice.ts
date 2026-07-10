/**
 * The one line the user reads.
 *
 * Two surfaces, deliberately different. `hive start` is a session boundary and
 * the last moment Hive owns the terminal, so it answers out loud — including
 * "I could not check", which is the whole point of asking. Every other human
 * command gets the passive notice: at most one dim line, only when there is
 * something to do, rate-limited to once a day per version.
 *
 * A "you are N versions behind" counter was considered and rejected. At a
 * patch-per-push cadence the number is noise, and the security flag plus the
 * staged-and-waiting line already say everything the count would imply.
 */
import type { InstallMethod } from "./paths";
import { updateCommand } from "./paths";
import type { UpdateCache, UpdateCheck } from "./check";
import { CHECK_INTERVAL_MS, isDismissed } from "./check";

export interface NoticeContext {
  readonly check: UpdateCheck;
  readonly installMethod: InstallMethod;
  /** Version already downloaded and verified into a version directory. */
  readonly staged?: string | null;
  /** Live agents; a staged update waits for them rather than interrupting. */
  readonly liveAgents?: number;
}

const ESC = "\u001B";
const dim = (text: string): string => `${ESC}[2m${text}${ESC}[0m`;
const yellow = (text: string): string => `${ESC}[33m${text}${ESC}[0m`;

/**
 * The body of an update-available notice, before colour. Split out because
 * `hive start` and the passive notice differ in *when* they speak, not in what
 * they say.
 */
function availableLine(
  latest: string,
  current: string,
  securityCritical: boolean,
  method: InstallMethod,
  staged: string | null,
  liveAgents: number,
): string {
  const command = updateCommand(method);
  if (securityCritical) {
    return `hive ${latest} available — security release, run ${command}`;
  }
  if (staged === latest && method === "native") {
    return liveAgents > 0
      ? `hive ${latest} downloaded — activates when the current team finishes, or run ${command} now`
      : `hive ${latest} downloaded — run ${command} to activate`;
  }
  return `hive ${latest} available (you have ${current}) — run ${command}`;
}

/**
 * The notice for `hive start`: always says something, because the user just
 * asked Hive to start and deserves to know what it knows.
 */
export function renderStartNotice(context: NoticeContext): string {
  const { check, installMethod } = context;
  const staged = context.staged ?? null;
  const liveAgents = context.liveAgents ?? 0;

  switch (check.state) {
    case "dev-build":
      return dim(
        `hive ${check.current} (source checkout) — update checks are disabled`,
      );
    case "disabled":
      return dim(
        `hive ${check.current} — update checks are disabled (${check.reason})`,
      );
    case "unavailable":
      // Honest ignorance. Never "up to date".
      return dim(
        `hive ${check.current} — could not check for updates (${check.reason})`,
      );
    case "up-to-date":
      return dim(`hive ${check.current} is the latest release`);
    case "update-available": {
      const line = availableLine(
        check.latest,
        check.current,
        check.securityCritical,
        installMethod,
        staged,
        liveAgents,
      );
      const suffix = check.stale ? `${line} (checked offline)` : line;
      return check.securityCritical ? yellow(suffix) : dim(suffix);
    }
  }
}

export interface PassiveNoticeContext extends NoticeContext {
  readonly cache: UpdateCache | null;
  readonly now: number;
  /** stderr is a TTY and no CI variable is set. */
  readonly interactive: boolean;
  readonly lastNoticeAt?: number | null;
}

/**
 * The passive notice for every other human command. Null means silence, which
 * is the common case and the correct default.
 */
export function renderUpdateNotice(context: PassiveNoticeContext): string | null {
  const { check, cache, interactive } = context;
  if (!interactive) return null;
  if (check.state !== "update-available") return null;

  // A security release ignores the skip list and the rate limit. Hive is an
  // agent-control daemon; there is no terminal precedent for this, so we set
  // one rather than inherit a wrong default.
  if (!check.securityCritical) {
    if (isDismissed(check.latest, cache)) return null;
    const lastNoticeAt = context.lastNoticeAt ?? null;
    if (lastNoticeAt !== null && context.now - lastNoticeAt < CHECK_INTERVAL_MS) {
      return null;
    }
  }

  const line = availableLine(
    check.latest,
    check.current,
    check.securityCritical,
    context.installMethod,
    context.staged ?? null,
    context.liveAgents ?? 0,
  );
  return check.securityCritical ? yellow(line) : dim(line);
}

/** Strip SGR so tests and non-TTY consumers can assert on words, not escapes. */
export const plain = (text: string): string =>
  text.replace(/\u001B\[[0-9;]*m/g, "");
