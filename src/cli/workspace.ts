import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveProjectRoot } from "../daemon/project-identity-core/project-root";
import { projectKey } from "../daemon/project-identity-core/state";
import { getHiveHome, hiveInstanceSuffix } from "../hive-home/home";
import { errorMessage } from "../shared/error-message";
import { IS_RELEASE_BUILD } from "../shared/version";
import { isString } from "../shared/is-record";
import {
  checkForUpdate,
  fetchLatestFromGitHub,
  type UpdateCheck,
} from "../update-service/check";
import {
  currentLink,
  installRoot,
  workspaceAppPath,
} from "../update-service/paths";
import { isRepoInitialized, runInitCli } from "./init";
import type { OrchestratorTool } from "./orchestrator";
import {
  printStartNotice,
  type StartDeps,
  type StartedSession,
  startSession,
} from "./start";

export class WorkspaceNotInstalledError extends Error {}

export function resolveWorkspaceApp(root = installRoot()): string | null {
  const app = workspaceAppPath(currentLink(root));
  return existsSync(app) ? app : null;
}

// Both of the messages below name a command, and both have earned it. Hive cannot install itself from a source checkout, and it will not silently pull a release over the network because someone typed `hive` — that is the user's call. So each states the fact, then the remedy on one labelled `Fix:` line.
const INSTALL_HINT =
  "no Hive release is installed; a source checkout cannot launch the Workspace " +
  "(`hive` opens the installed release build, never a development build)\n" +
  "Fix: curl -fsSL https://raw.githubusercontent.com/scottdev1986/hive/main/install.sh | sh";

export interface LaunchDeps {
  readonly root?: string;
  readonly open?: (app: string, args: readonly string[]) => Promise<number>;
  readonly session?: {
    readonly cwd: string;
    readonly port: number;
    readonly projectId: string;
    readonly projectName: string;
    readonly hivePath?: string;
    readonly orchestrator?: OrchestratorTool;
  };
  readonly startOrchestrator?: (
    session: NonNullable<LaunchDeps["session"]>,
  ) => Promise<void>;
  readonly runningWorkspacePid?: (instanceHome: string) => number | null;
  readonly runningOrchestratorPid?: (instanceId: string) => number | null;
  readonly activateWorkspace?: (app: string) => Promise<number>;
}

/** First live process whose command line contains every needle, or null. */
export function runningCommandPid(
  needles: readonly string[],
  listCommands: () => string = listProcessCommands,
): number | null {
  for (const line of listCommands().split("\n")) {
    if (!needles.every((needle) => line.includes(needle))) continue;
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function listProcessCommands(): string {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
  });
  return isString(result.stdout) ? result.stdout : "";
}

export function workspaceProcessPid(instanceHome: string): number | null {
  return runningCommandPid([
    "HiveWorkspace",
    `--instance-home ${instanceHome}`,
  ]);
}

export function orchestratorProcessPid(instanceId: string): number | null {
  return runningCommandPid([
    "workspace-orchestrator",
    `--instance-id`,
    instanceId,
  ]);
}

/** Starts the session's Queen supervisor outside the Workspace process. The
 * app may disappear and reconnect, but it never becomes process-lifecycle
 * authority for the fleet it renders. */
export async function startWorkspaceOrchestrator(
  session: NonNullable<LaunchDeps["session"]>,
  spawnChild: typeof spawn = spawn,
): Promise<void> {
  const hivePath = session.hivePath ?? process.execPath;
  const child = spawnChild(hivePath, workspaceOrchestratorArguments(session), {
    cwd: session.cwd,
    detached: true,
    env: { ...process.env, HIVE_HOME: getHiveHome() },
    stdio: "ignore",
  });
  await new Promise<void>((resolvePromise, reject) => {
    const started = (): void => {
      child.off("error", failed);
      child.unref();
      resolvePromise();
    };
    const failed = (error: Error): void => {
      child.off("spawn", started);
      reject(error);
    };
    child.once("spawn", started);
    child.once("error", failed);
  });
}

export function workspaceOrchestratorArguments(
  session: NonNullable<LaunchDeps["session"]>,
): string[] {
  return [
    "workspace-orchestrator",
    "--tool",
    session.orchestrator ?? "claude",
    "--port",
    String(session.port),
    "--instance-id",
    hiveInstanceSuffix(),
  ];
}

export function workspaceOpenArguments(
  app: string,
  args: readonly string[],
  path = process.env.PATH,
  temporaryDirectory = process.env.TMPDIR,
  qa = process.env.HIVE_QA,
  defaultHiveHome = process.env.HIVE_DEFAULT_HOME,
  hiveHome = process.env.HIVE_HOME,
): string[] {
  const home = instanceHome(args);
  return [
    "-n",
    "-a",
    app,
    ...(path === undefined ? [] : ["--env", `PATH=${path}`]),
    // Preserve macOS's private per-user temp directory across LaunchServices and the app's terminal helpers; without it runtime sockets can land under a different temp root from the daemon.
    ...(temporaryDirectory === undefined
      ? []
      : ["--env", `TMPDIR=${temporaryDirectory}`]),
    ...(qa === "1" ? ["--env", "HIVE_QA=1"] : []),
    ...(defaultHiveHome === undefined || defaultHiveHome.length === 0
      ? []
      : ["--env", `HIVE_DEFAULT_HOME=${defaultHiveHome}`]),
    ...(hiveHome === undefined || hiveHome.length === 0
      ? []
      : ["--env", `HIVE_HOME=${hiveHome}`]),
    // `open` wires the app's stderr to /dev/null unless told otherwise, and the app's NSLog diagnostics are the ONLY record of why a pane's renderer gave up — every attach failure, every recovery tick, and the bounded give-up itself are written there. Keyed to the instance home already in `args`, so a Dock launch with no instance keeps the default.
    ...(home === undefined ? [] : ["--stderr", join(home, "workspace.log")]),
    "--args",
    ...args,
  ];
}

function instanceHome(args: readonly string[]): string | undefined {
  const index = args.indexOf("--instance-home");
  return index === -1 ? undefined : args[index + 1];
}

const runOpen = async (args: readonly string[]): Promise<number> => {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("open", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 0));
  });
};

const openApp = async (app: string, args: readonly string[]): Promise<number> =>
  runOpen(workspaceOpenArguments(app, args));

/** Activating carries no `-n`: that flag is what makes `open` mint a second app,
 * and minting a second one is the thing the caller already decided against. */
export function workspaceActivateArguments(app: string): string[] {
  return ["-a", app];
}

/** Bring this repository's already-running Workspace forward. `open -a` without
 * `-n` activates the running app instead of minting a second one, which is the
 * same request a Dock click makes: it needs no automation permission and drives
 * no process outside the app. Activation is therefore bundle-wide — it raises a
 * running Workspace, not a chosen pid — so with two repositories open at once it
 * can raise the other repository's window. Targeting one instance needs an entry
 * point in the app, which it does not have yet. */
const activateWorkspaceApp = async (app: string): Promise<number> =>
  runOpen(workspaceActivateArguments(app));

export async function launchWorkspace(deps: LaunchDeps): Promise<number> {
  const root = deps.root ?? installRoot();
  const app = resolveWorkspaceApp(root);
  if (app === null) {
    throw new WorkspaceNotInstalledError(
      IS_RELEASE_BUILD
        ? `the Workspace app is missing from ${currentLink(root)}\n` +
            "Fix: run `hive update` to repair the installation"
        : INSTALL_HINT,
    );
  }
  const args =
    deps.session === undefined
      ? []
      : [
          "--project",
          deps.session.cwd,
          "--project-id",
          deps.session.projectId,
          "--project-name",
          deps.session.projectName,
          "--port",
          String(deps.session.port),
          "--instance-id",
          hiveInstanceSuffix(),
          "--instance-home",
          getHiveHome(),
          "--hive",
          deps.session.hivePath ?? process.execPath,
        ];
  if (deps.session !== undefined) {
    const instanceHome = getHiveHome();
    const existingWorkspace = (deps.runningWorkspacePid ?? workspaceProcessPid)(
      instanceHome,
    );
    if (existingWorkspace !== null) {
      return await (deps.activateWorkspace ?? activateWorkspaceApp)(app);
    }
    const instanceId = hiveInstanceSuffix();
    const existingOrchestrator = (
      deps.runningOrchestratorPid ?? orchestratorProcessPid
    )(instanceId);
    if (existingOrchestrator === null) {
      await (deps.startOrchestrator ?? startWorkspaceOrchestrator)(
        deps.session,
      );
    }
  }
  return (deps.open ?? openApp)(app, args);
}

export interface RunWorkspaceDeps {
  readonly cwd?: string;
  readonly resolveRoot?: (cwd: string) => string | null;
  readonly start?: (deps: StartDeps) => Promise<StartedSession>;
  readonly checkUpdate?: () => Promise<UpdateCheck>;
  readonly write?: (line: string) => void;
  readonly launch?: (deps: LaunchDeps) => Promise<number>;
  readonly isInitialized?: (root: string) => boolean;
  readonly init?: (root: string) => Promise<void>;
  readonly projectIdentity?: (
    root: string,
  ) => Readonly<{ id: string; name: string }>;
}

/** Bare `hive`. Inside a git worktree: resolve the repo root, run the session boundary, and launch the app against that project and its daemon port. That path must NOT print the start notice below — `startSession` already does, and running both prints it twice. Outside a repo: force a small release-metadata check, print the same start notice `startSession` prints for a project (the one that knows about a staged, already-downloaded version), then launch the app standalone. A notice failure never blocks the launch: app launch is useful offline and network trouble is not a project warning. A repo that never completed `hive init` gets the same init flow first, announced before anything is written: bare `hive` must never leave a repo half-initialized or mutate it by surprise, and the graphify question is the same question init asks (TTY-gated; without a terminal it declines for the run with one line). Init failing does not stop the launch — the session boundary below still brings a fresh daemon up, and init can be re-run. */
export async function runWorkspace(
  deps: RunWorkspaceDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const root = (deps.resolveRoot ?? resolveProjectRoot)(cwd);
  if (root !== null) {
    if (!(deps.isInitialized ?? isRepoInitialized)(root)) {
      (deps.write ?? ((text: string) => process.stderr.write(`${text}\n`)))(
        `No Hive here yet — initializing ${root} first (\`hive init\`: skills, memory):`,
      );
      await (deps.init ?? ((r: string) => runInitCli({ cwd: r })))(root).catch(
        (error) => {
          (deps.write ?? ((text: string) => process.stderr.write(`${text}\n`)))(
            `init did not complete (${errorMessage(error)}); starting anyway — re-run \`hive init\` to finish.`,
          );
        },
      );
    }
    const session = await (deps.start ?? startSession)({ cwd: root });
    const identity = (
      deps.projectIdentity ??
      ((projectRoot: string) => ({
        id: projectKey(projectRoot),
        name: basename(projectRoot),
      }))
    )(session.cwd);
    return (deps.launch ?? launchWorkspace)({
      session: {
        cwd: session.cwd,
        port: session.port,
        projectId: identity.id,
        projectName: identity.name,
      },
    });
  }
  await printStartNotice({
    checkUpdate:
      deps.checkUpdate ??
      (() =>
        checkForUpdate({
          fetchLatest: () => fetchLatestFromGitHub(),
          now: () => Date.now(),
          force: true,
        })),
    write: deps.write,
  }).catch(() => {
    // Update discovery must never turn a standalone app launch into an error.
  });
  return (deps.launch ?? launchWorkspace)({});
}
