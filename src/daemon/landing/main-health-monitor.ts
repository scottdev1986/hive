import { watch as watchFs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runGit } from "../../adapters/git";
import { readRefOid } from "../../adapters/worktrees";
import { resolveLandingTargetBranch } from "./landing-service";

/**
 * How long to wait before re-offering a report the control lane refused. A
 * timer at this cadence exists only while a report is still owed, so a daemon
 * with nothing outstanding holds no timer and does no work.
 */
const NOTIFY_RETRY_MS = 5_000;
/** Enough dirty paths to identify what was found without pasting a whole tree into a notice. */
const DIRTY_PATHS_SHOWN = 10;

export type MainHealthResult = Readonly<{
  ok: boolean;
  detail: string;
}>;

/**
 * What the probe found in the checkout, once it had waited long enough to know
 * the paths were not a write still in flight. The paths are carried, not just
 * counted: a decline nobody can attribute to a file cannot be acted on.
 */
export type DirtyCheckout = Readonly<{
  paths: readonly string[];
  settleWaitMs: number;
}>;

class PrimaryCheckoutDirtyError extends Error {
  constructor(readonly dirty: DirtyCheckout) {
    super("primary checkout is dirty");
  }
}

/**
 * Stated in every decline, because a reader told only that a revision went
 * unmeasured will assume a retry that never comes. Ordinarily nothing
 * re-measures it: main normally only moves forward, and a check always
 * measures whatever revision is current, so no later check names this one
 * again. That is a statement about the ordinary case, not an absolute
 * guarantee: main moving backward onto a revision it already left — a
 * deliberate reset, never a landing — would be checked again like any other
 * move, and correctly so, since a reset genuinely changes what "current"
 * means. The wording below promises only the ordinary case for exactly that
 * reason.
 */
export const DECLINE_IS_FINAL =
  "This revision will not be re-measured as a matter of course: main normally only moves forward, and a health check always measures whatever revision is current, so the next health result will name a later commit.";

/** Names what the probe found, for the decline notice. */
export const describeDirtyCheckout = (dirty: DirtyCheckout): string => {
  const shown = dirty.paths.slice(0, DIRTY_PATHS_SHOWN);
  const hidden = dirty.paths.length - shown.length;
  return (
    `${dirty.paths.length} uncommitted path${dirty.paths.length === 1 ? "" : "s"}` +
    ` still there after ${dirty.settleWaitMs}ms, so this is work left in the checkout` +
    ` rather than a write still in flight:\n${shown.join("\n")}` +
    (hidden > 0 ? `\n(+${hidden} more)` : "")
  );
};

export interface MainHealthMonitorDeps {
  readRevision: () => Promise<string>;
  runTests: (signal: AbortSignal) => Promise<MainHealthResult>;
  notifyRed: (revision: string, detail: string) => Promise<void>;
  notifyDeclined: (revision: string, dirty: DirtyCheckout) => Promise<void>;
  log: (message: string) => void;
  retryMs?: number;
  /**
   * Starts watching for a move of the primary branch this daemon did not
   * cause itself: the owner committing directly, a merge, a rebase, a reset.
   * Resolves to a disposer once armed, or to null if the watch could not be
   * established — a repository main health cannot make sense of still lets
   * the daemon boot and still checks the landings it does see. Optional so a
   * monitor built without one — most fixtures, and any environment where the
   * primary checkout is not watchable — sees no such event, exactly as
   * before this dependency existed.
   */
  watchExternalMove?: (onChange: () => void) => Promise<(() => void) | null>;
}

export type MainHealthMonitorHandle = Pick<
  MainHealthMonitor,
  "start" | "checkNow" | "stop"
>;

/**
 * Watches the primary branch without adding the test suite to landing latency.
 * One suite runs at a time, and a result is announced only when the branch ref
 * is unchanged across the run. A later revision replaces queued work rather
 * than starting another concurrent suite.
 *
 * Every check is caused by an event: `start()` measures the revision the daemon
 * booted on, a landing calls `checkNow()`, a report the control lane refused
 * re-offers itself on a timer that exists only while that report is owed, and
 * an OS-level watch on the primary branch's ref file calls `checkNow()` when
 * anything else moves it — the owner's own commit, a merge, a rebase, a
 * reset. A daemon with no landing in flight and no foreign move therefore
 * reads no ref and holds no timer.
 */
export class MainHealthMonitor {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private requested = false;
  private stopped = false;
  private checkedRevision: string | null = null;
  private pendingRed: { revision: string; detail: string } | null = null;
  private pendingDeclined: {
    revision: string;
    dirty: DirtyCheckout;
  } | null = null;
  private externalWatch: Promise<(() => void) | null> | null = null;

  constructor(private readonly deps: MainHealthMonitorDeps) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.externalWatch =
      this.deps.watchExternalMove?.(() => void this.checkNow()) ?? null;
    void this.checkNow();
  }

  async checkNow(): Promise<void> {
    if (this.stopped) return;
    this.requested = true;
    if (this.active === null) {
      this.active = this.drain();
    }
    const active = this.active;
    await active;
    if (this.active === active) this.active = null;
    if (this.requested) await this.checkNow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.abort?.abort();
    const watch = this.externalWatch;
    this.externalWatch = null;
    (await watch)?.();
    await this.active;
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      try {
        await this.inspect();
      } catch (error) {
        this.deps.log(
          `Main health check failed to run: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    this.scheduleRetry();
  }

  /** Arms the one timer this monitor owns, and only while a refused report is still owed. It never holds the process open: a daemon that is shutting down must not wait on a report it can re-offer after the next landing. */
  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.stopped) return;
    if (this.pendingRed === null && this.pendingDeclined === null) return;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      void this.checkNow();
    }, this.deps.retryMs ?? NOTIFY_RETRY_MS);
    timer.unref();
    this.retryTimer = timer;
  }

  private async inspect(): Promise<void> {
    const revision = await this.deps.readRevision();
    if (this.pendingRed !== null && this.pendingRed.revision === revision) {
      await this.publishPending();
      return;
    }
    if (
      this.pendingDeclined !== null &&
      this.pendingDeclined.revision === revision
    ) {
      await this.publishPendingDeclined();
      return;
    }
    if (this.checkedRevision === revision) return;

    this.pendingRed = null;
    this.pendingDeclined = null;
    const abort = new AbortController();
    this.abort = abort;
    let result: MainHealthResult;
    try {
      result = await this.deps.runTests(abort.signal);
    } catch (error) {
      if (!(error instanceof PrimaryCheckoutDirtyError)) throw error;
      if (this.stopped) return;

      const revisionAfter = await this.deps.readRevision();
      if (revisionAfter !== revision) {
        this.requested = true;
        return;
      }

      this.checkedRevision = revision;
      this.pendingDeclined = { revision, dirty: error.dirty };
      await this.publishPendingDeclined();
      return;
    } finally {
      this.abort = null;
    }
    if (this.stopped) return;

    const revisionAfter = await this.deps.readRevision();
    if (revisionAfter !== revision) {
      this.requested = true;
      return;
    }

    this.checkedRevision = revision;
    if (result.ok) return;
    this.pendingRed = { revision, detail: result.detail };
    await this.publishPending();
  }

  private async publishPending(): Promise<void> {
    const pending = this.pendingRed;
    if (pending === null) return;
    try {
      await this.deps.notifyRed(pending.revision, pending.detail);
      this.pendingRed = null;
    } catch (error) {
      this.deps.log(
        `Main is red at ${pending.revision}, but its notification was not accepted: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  private async publishPendingDeclined(): Promise<void> {
    const pending = this.pendingDeclined;
    if (pending === null) return;
    try {
      await this.deps.notifyDeclined(pending.revision, pending.dirty);
      this.pendingDeclined = null;
    } catch (error) {
      this.deps.log(
        `Main health did not measure ${pending.revision}, but its decline notification was not accepted: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
}

export const readPrimaryRevision = async (
  repoRoot: string,
): Promise<string> => {
  const branch = await resolveLandingTargetBranch(repoRoot);
  const revision = await readRefOid(repoRoot, `refs/heads/${branch}`);
  if (revision === null) {
    throw new Error(`cannot resolve refs/heads/${branch}`);
  }
  return revision;
};

/**
 * The real `watchExternalMove`: watches the primary branch's ref file for a
 * change this daemon did not make itself. Every other trigger in this file is
 * caused by an event the daemon already knew about — it booted, or a landing
 * just ran — so this is the one source of a check the daemon would otherwise
 * never see: the owner commits directly, or merges, rebases, or resets main
 * outside any landing. `fs.watch` is a native OS notification, not a poll, so
 * a checkout with no move in progress costs this watcher nothing between
 * events. The ref's containing directory is watched rather than the ref file
 * itself, because git never edits the file in place — it writes the new
 * value to `<branch>.lock` and renames that onto `<branch>` — and a rename
 * can silently stop delivering events to a watch held on the old inode. That
 * same rename is also why both names are matched: on macOS, FSEvents reports
 * a rename's create and its disappearance-by-rename-away under the same
 * (pre-rename) name, so the observed event names the lockfile, not the ref,
 * on both sides of an update — confirmed against this filesystem, not
 * assumed from git's documented algorithm. Logs and resolves to null, rather
 * than throwing, when the branch or its ref file cannot be resolved: a
 * repository main health cannot make sense of still lets the daemon boot and
 * still checks the landings it does see.
 */
export const watchPrimaryRefMove = async (
  repoRoot: string,
  onChange: () => void,
  log: (message: string) => void,
): Promise<(() => void) | null> => {
  try {
    const branch = await resolveLandingTargetBranch(repoRoot);
    const commonDir = await runGit(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (commonDir.exitCode !== 0) {
      log(
        `Main health could not watch ${branch} for a direct move: ${
          commonDir.stderr.trim() || "git rev-parse --git-common-dir failed"
        }`,
      );
      return null;
    }
    const commonDirPath = commonDir.stdout.trim();
    const refPath = join(
      isAbsolute(commonDirPath)
        ? commonDirPath
        : resolve(repoRoot, commonDirPath),
      "refs",
      "heads",
      branch,
    );
    const refDir = dirname(refPath);
    const refName = refPath.slice(refDir.length + 1);
    const lockName = `${refName}.lock`;
    const watcher = watchFs(refDir, (_eventType, filename) => {
      if (filename === refName || filename === lockName) onChange();
    });
    watcher.on("error", (error) => {
      log(
        `Main health's watch on ${branch} stopped: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    return () => watcher.close();
  } catch (error) {
    log(
      `Main health could not watch for a direct move of main: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return null;
  }
};
