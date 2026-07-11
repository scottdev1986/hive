/**
 * `hive init` — the session boundary.
 *
 * Per the Workspace blueprint, `hive init` is an idempotent request to resolve,
 * create, attach, and focus a project. It is also the one moment Hive reliably
 * owns the terminal, so it is where the update notice belongs: printed before
 * any work, on stderr, dim, one line. Claude Code's contract exactly — you learn
 * a new version exists at the start of a session, not in the middle of one.
 *
 * The check is best-effort and never blocks. A machine with no network prints
 * "could not check for updates" and starts anyway. It never prints "up to date"
 * on a failed check, because that sentence is a claim about the world and we
 * would not have looked.
 */
import { expectedDaemonHandshake } from "../daemon/handshake";
import { ensureStarted } from "../daemon/lifecycle";
import { checkForUpdate, fetchLatestFromGitHub, readUpdateCache, isDismissed } from "../update/check";
import {
  explainRefusal,
  inspectDaemonForUpdate,
  restartStaleDaemon,
} from "../update/daemon";
import { detectInstallMethod, installRoot } from "../update/paths";
import { isStaged, readInstallState } from "../update/install";
import { renderStartNotice } from "../update/notice";
import { isRunning } from "../daemon/lifecycle";
import { liveAgentNames } from "./update";
import { ensureProfile } from "../adapters/profile";
import type { UpdateCheck } from "../update/check";
import { repairLeakedProjectConfig } from "./project-config-cleanup";

export interface StartDeps {
  readonly checkUpdate?: () => Promise<UpdateCheck>;
  readonly write?: (line: string) => void;
  readonly cwd?: string;
  /** Test seams for the daemon bring-up; production always uses the real
   * `ensureDaemonForBuild` and `ensureStarted`. */
  readonly ensureDaemon?: (cwd: string) => Promise<void>;
  readonly ensurePort?: () => Promise<number>;
  readonly repairProjectConfig?: (cwd: string) => Promise<unknown>;
}

/** Resolve the staged-but-not-active version, so the notice can say so. */
function stagedVersion(latest: string | null): string | null {
  if (latest === null) return null;
  const root = installRoot();
  const state = readInstallState(root);
  return state.active !== latest && isStaged(latest, root) ? latest : null;
}

export async function printStartNotice(deps: StartDeps = {}): Promise<void> {
  const write = deps.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const check = await (deps.checkUpdate ?? (() =>
    checkForUpdate({
      fetchLatest: () => fetchLatestFromGitHub(),
      now: () => Date.now(),
    })))();

  // `hive update skip` silences a version everywhere except a security release.
  if (check.state === "update-available" && !check.securityCritical &&
    isDismissed(check.latest, readUpdateCache())) {
    return;
  }

  const latest = check.state === "update-available" ? check.latest : null;
  write(renderStartNotice({
    check,
    installMethod: detectInstallMethod(process.execPath),
    staged: stagedVersion(latest),
  }));
}

/**
 * Bring this project's daemon up, restarting one left behind by an update.
 *
 * `ensureStarted` refuses to adopt a daemon whose build hash differs, which is
 * correct and, on its own, a dead end: after `hive update` the old daemon may
 * still hold the port. Restarting it here is not "reusing" it — the refusal
 * stands — it is the other half of the same contract. We only ever stop a
 * daemon that is provably ours (same HiveUUID) and provably idle (no live
 * agents); anything else is reported and left alone.
 */
export async function ensureDaemonForBuild(cwd = process.cwd()): Promise<void> {
  if (!(await isRunning())) return;
  const expected = await expectedDaemonHandshake(cwd);
  const state = await inspectDaemonForUpdate({ expected, liveAgents: liveAgentNames });
  if (state.state === "current" || state.state === "absent") return;

  const refusal = explainRefusal(state);
  if (refusal !== null) throw new Error(refusal);

  const outcome = await restartStaleDaemon(state, { isRunning: () => isRunning() });
  if (!outcome.stopped) {
    throw new Error(`cannot start: ${outcome.reason}`);
  }
  process.stderr.write(
    "Stopped a daemon running a previous Hive build; starting the current one.\n",
  );
}

export interface StartedSession {
  readonly port: number;
  readonly cwd: string;
}

/**
 * The session boundary itself, shared by `hive init` and bare `hive`: update
 * notice (best-effort), stale-daemon restart, and daemon bring-up. Everything a
 * session needs before anything attaches to it — and nothing about *what*
 * attaches, which is why bare `hive` can run this and then hand the port to the
 * Workspace app while `hive init` just prints where the daemon is.
 *
 * The repo profile is ensured here too, before the daemon, and says nothing on
 * any path (SPEC §14). The daemon ensures it as well; both are deterministic and
 * idempotent, and neither announces itself, so racing them costs nothing.
 */
export async function startSession(deps: StartDeps = {}): Promise<StartedSession> {
  await printStartNotice(deps).catch(() => {
    // A broken update check must never stop a project from starting.
  });
  const cwd = deps.cwd ?? process.cwd();
  await (deps.repairProjectConfig ?? repairLeakedProjectConfig)(cwd);
  await ensureProfile(cwd).catch(() => {
    // Profiling is best-effort: a repo starts even if its profile cannot be
    // written or read, just with poorer briefs.
  });
  await (deps.ensureDaemon ?? ensureDaemonForBuild)(cwd);
  const port = await (deps.ensurePort ?? ensureStarted)();
  return { port, cwd };
}

export async function runStart(deps: StartDeps = {}): Promise<void> {
  const { port, cwd } = await startSession(deps);
  // State the state. Neither Claude Code nor Codex makes its own name the
  // subject of a status line ("Claude Code is running for /path"), and neither
  // puts a full stop at the end of one. The second line is what is now
  // possible, not a chore being handed back.
  console.log(`ready — ${cwd} (daemon port ${port})`);
  console.log("`hive` opens the Workspace; `hive claude` starts an orchestrator");
}
