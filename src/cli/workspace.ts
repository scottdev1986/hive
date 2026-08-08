/** `hive` — open a fresh instance for the project you're in. Run inside a git worktree, bare `hive` resolves the repository root, runs the Workspace session boundary (update notice, fresh runtime selection, daemon bring-up, init-once onboarding line), starts the Queen supervisor, and launches the installed release app with only the project and daemon coordinates it needs to render. Run outside a git repo, it stays a project-neutral launcher: a forced release-metadata check, then an argless launch that shows the app's placeholder window — the same home a Dock click gets. There is deliberately no development fallback. Not a symlink into `workspace/.build`, not a `swift run`, not an environment variable that quietly prefers a debug bundle. A `hive` that sometimes launches a debug build is a `hive` whose bug reports cannot be trusted, and the one thing worse than "Workspace is not installed" is "Workspace launched, and nobody can say which one". The app lives inside the active version directory, so the symlink that activates a CLI release activates its Workspace in the same atomic rename. They cannot skew. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveProjectRoot } from "../daemon/project-identity-core/project-root";
import { projectKey } from "../daemon/project-identity-core/state";
import { getHiveHome } from "../hive-home/home";
import { hiveInstanceSuffix } from "../hive-home/instance-identity";
import { errorMessage } from "../shared/error-message";
import { IS_RELEASE_BUILD } from "../shared/version";
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
): string[] {
  return [
    "-n",
    "-a",
    app,
    ...(path === undefined ? [] : ["--env", `PATH=${path}`]),
    // Preserve macOS's private per-user temp directory across LaunchServices and the app's terminal helpers; without it runtime sockets can land under a different temp root from the daemon.
    ...(temporaryDirectory === undefined
      ? []
      : ["--env", `TMPDIR=${temporaryDirectory}`]),
    // `open` wires the app's stderr to /dev/null unless told otherwise, and the app's NSLog diagnostics are the ONLY record of why a pane's renderer gave up — every attach failure, every recovery tick, and the bounded give-up itself are written there. Keyed to the instance home already in `args`, so a Dock launch with no instance keeps the default.
    ...(instanceHome(args) === undefined
      ? []
      : ["--stderr", join(instanceHome(args) as string, "workspace.log")]),
    "--args",
    ...args,
  ];
}

function instanceHome(args: readonly string[]): string | undefined {
  const index = args.indexOf("--instance-home");
  return index === -1 ? undefined : args[index + 1];
}

const openApp = async (
  app: string,
  args: readonly string[],
): Promise<number> => {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("open", workspaceOpenArguments(app, args), {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 0));
  });
};

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
    await (deps.startOrchestrator ?? startWorkspaceOrchestrator)(deps.session);
  }
  return (deps.open ?? openApp)(app, args);
}

export interface RunWorkspaceDeps {
  readonly orchestrator?: OrchestratorTool;
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
        (error: unknown) => {
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
        ...(deps.orchestrator === undefined
          ? {}
          : { orchestrator: deps.orchestrator }),
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
