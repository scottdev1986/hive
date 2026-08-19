/** Workspace launch — the session boundary. Each public Workspace launch owns the terminal long enough to print the update notice and prepare the repository before selecting this repo's instance. Initialization is a separate repo-only command and never calls this module. The check is best-effort and never blocks. A machine with no network prints "could not check for updates" and starts anyway. It never prints "up to date" on a failed check, because that sentence is a claim about the world and we would not have looked. */

import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { installGraphify } from "../adapters/graphify";
import {
  ensureStarted,
  expectedDaemonHandshake,
  isRunning,
} from "../daemon/lifecycle/daemon-lifecycle";
import { selectRepoInstance } from "../daemon/lifecycle/instances";
import {
  projectKey,
  projectStateDir,
} from "../daemon/project-identity-core/state";
import { getHiveHome, isDefaultHiveHome } from "../hive-home/home";
import { errorMessage } from "../shared/error-message";
import type { UpdateCheck } from "../update-service/check";
import {
  checkForUpdate,
  fetchLatestFromGitHub,
  isDismissed,
  readUpdateCache,
} from "../update-service/check";
import { isStaged, readInstallState } from "../update-service/install";
import { renderStartNotice } from "../update-service/notice";
import { detectInstallMethod, installRoot } from "../update-service/paths";
import {
  explainRefusal,
  inspectDaemonForUpdate,
  restartStaleDaemon,
} from "../update-service/update-daemon";
import { repairLeakedProjectConfig } from "./project-config-cleanup";
import { liveAgentNames } from "./update";

export interface StartDeps {
  readonly checkUpdate?: () => Promise<UpdateCheck>;
  readonly write?: (line: string) => void;
  readonly cwd?: string;
  readonly ensureDaemon?: (cwd: string) => Promise<void>;
  readonly ensurePort?: () => Promise<number>;
  readonly repairProjectConfig?: (cwd: string) => Promise<unknown>;
  readonly refreshGraphify?: () => Promise<void>;
  readonly prepareInstance?: (cwd: string) => void | Promise<void>;
}

function stagedVersion(latest: string | null): string | null {
  if (latest === null) return null;
  const root = installRoot();
  const state = readInstallState(root);
  return state.active !== latest && isStaged(latest, root) ? latest : null;
}

export async function printStartNotice(deps: StartDeps = {}): Promise<void> {
  const write =
    deps.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const check = await (
    deps.checkUpdate ??
    (() =>
      checkForUpdate({
        fetchLatest: () => fetchLatestFromGitHub(),
        now: () => Date.now(),
      }))
  )();

  if (
    check.state === "update-available" &&
    !check.securityCritical &&
    isDismissed(check.latest, readUpdateCache())
  ) {
    return;
  }

  const latest = check.state === "update-available" ? check.latest : null;
  write(
    renderStartNotice({
      check,
      installMethod: detectInstallMethod(process.execPath),
      staged: stagedVersion(latest),
    }),
  );
}

/** Bring this project's daemon up, restarting one left behind by an update. `ensureStarted` refuses to adopt a daemon whose build hash differs, which is correct and, on its own, a dead end: after `hive update` the old daemon may still hold the port. Restarting it here is not "reusing" it — the refusal stands — it is the other half of the same contract. We only ever stop a daemon that is provably ours (same HiveUUID) and provably idle (no live agents); anything else is reported and left alone. */
export async function ensureDaemonForBuild(cwd = process.cwd()): Promise<void> {
  if (!(await isRunning())) return;
  const expected = await expectedDaemonHandshake(cwd);
  const state = await inspectDaemonForUpdate({
    expected,
    liveAgents: liveAgentNames,
  });
  if (
    state.state === "current" ||
    state.state === "absent" ||
    state.state === "unknown"
  )
    return;

  const refusal = explainRefusal(state);
  if (refusal !== null) throw new Error(refusal);

  const outcome = await restartStaleDaemon(state, {
    isRunning: () => isRunning(),
  });
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

/** Bind this process to the one instance that owns `cwd`'s repository. A second launch of the same repo reuses that home and its hive.db. An explicit HIVE_HOME (dev, --instance, a test) is left alone. */
export async function prepareRepoWorkspaceInstance(cwd: string): Promise<void> {
  if (!isDefaultHiveHome()) return;
  const sourceHome = getHiveHome();
  const sourceProjectState = projectStateDir(cwd);
  const targetHome = selectRepoInstance(projectKey(cwd));
  await mkdir(join(targetHome, "projects"), { recursive: true });
  if (existsSync(join(targetHome, "hive.db"))) return;
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

/** The Workspace session boundary: update notice (best-effort), repo-only preparation, one instance per repository, and daemon bring-up. `hive init` deliberately does not cross this boundary. */
export async function startSession(
  deps: StartDeps = {},
): Promise<StartedSession> {
  await printStartNotice(deps).catch(() => {
    // A broken update check must never stop a project from starting.
  });
  const cwd = deps.cwd ?? process.cwd();
  await (deps.repairProjectConfig ?? repairLeakedProjectConfig)(cwd);
  try {
    await (
      deps.refreshGraphify ??
      (async () => {
        const result = await installGraphify();
        if (result.ok && result.changed === true) {
          process.stderr.write(`Graphify updated: ${result.detail}\n`);
        } else if (!result.ok) {
          process.stderr.write(
            `Graphify update unavailable; keeping the current runtime: ${result.reason}\n`,
          );
        }
      })
    )();
  } catch (error) {
    // Runtime delivery is advisory; an update outage never blocks Hive.
    process.stderr.write(
      `Graphify update unavailable; keeping the current runtime: ${errorMessage(
        error,
      )}\n`,
    );
  }
  await (deps.prepareInstance ?? prepareRepoWorkspaceInstance)(cwd);
  await (deps.ensureDaemon ?? ensureDaemonForBuild)(cwd);
  const port = await (deps.ensurePort ?? ensureStarted)();
  return { port, cwd };
}
