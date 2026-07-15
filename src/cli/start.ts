/**
 * Workspace launch — the session boundary.
 *
 * Each public Workspace launch owns the terminal long enough to print the
 * update notice and prepare the repository before selecting a new runtime.
 * Initialization is a separate repo-only command and never calls this module.
 *
 * The check is best-effort and never blocks. A machine with no network prints
 * "could not check for updates" and starts anyway. It never prints "up to date"
 * on a failed check, because that sentence is a claim about the world and we
 * would not have looked.
 */
import { basename, join } from "node:path";
import { cp, mkdir } from "node:fs/promises";
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
import type { UpdateCheck } from "../update/check";
import { repairLeakedProjectConfig } from "./project-config-cleanup";
import { selectFreshInstance } from "../daemon/instances";
import { isDefaultHiveHome } from "../daemon/tmux-sessions";
import { getHiveHome } from "../daemon/db";
import { projectStateDir } from "../daemon/project-state";

export interface StartDeps {
  readonly checkUpdate?: () => Promise<UpdateCheck>;
  readonly write?: (line: string) => void;
  readonly cwd?: string;
  /** Test seams for the daemon bring-up; production always uses the real
   * `ensureDaemonForBuild` and `ensureStarted`. */
  readonly ensureDaemon?: (cwd: string) => Promise<void>;
  readonly ensurePort?: () => Promise<number>;
  readonly repairProjectConfig?: (cwd: string) => Promise<unknown>;
  /** Select the runtime after repo-only preparation and before daemon lookup. */
  readonly prepareInstance?: (cwd: string) => void | Promise<void>;
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

/** Copy repo setup into a new runtime before switching HIVE_HOME. Init writes
 * under the default home; the fresh daemon needs the same project UUID and
 * Graphify decision without sharing mutable runtime state with another
 * instance. */
async function prepareFreshWorkspaceInstance(cwd: string): Promise<void> {
  if (!isDefaultHiveHome()) return;
  const sourceHome = getHiveHome();
  const sourceProjectState = projectStateDir(cwd);
  const targetHome = selectFreshInstance();
  await mkdir(join(targetHome, "projects"), { recursive: true });
  await cp(
    join(sourceHome, "project-registry.json"),
    join(targetHome, "project-registry.json"),
  );
  await cp(
    sourceProjectState,
    join(targetHome, "projects", basename(sourceProjectState)),
    { recursive: true },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/**
 * The Workspace session boundary: update notice (best-effort), repo-only
 * preparation, fresh-instance selection, and daemon bring-up. `hive init`
 * deliberately does not cross this boundary.
 */
export async function startSession(deps: StartDeps = {}): Promise<StartedSession> {
  await printStartNotice(deps).catch(() => {
    // A broken update check must never stop a project from starting.
  });
  const cwd = deps.cwd ?? process.cwd();
  await (deps.repairProjectConfig ?? repairLeakedProjectConfig)(cwd);
  await (deps.prepareInstance ?? prepareFreshWorkspaceInstance)(cwd);
  await (deps.ensureDaemon ?? ensureDaemonForBuild)(cwd);
  const port = await (deps.ensurePort ?? ensureStarted)();
  return { port, cwd };
}
