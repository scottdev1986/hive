/**
 * `hive` — open the project you're in.
 *
 * Run inside a git worktree, bare `hive` resolves the repository root, runs
 * the shared `hive init` session boundary (update notice, stale-daemon
 * restart, daemon bring-up, init-once profile line), and launches the
 * installed release app with everything it needs on argv: `--project <root>`,
 * `--port <port>`, `--hive <this binary>`, the instance-scoped
 * `--orchestrator-session`, and, for an explicit orchestrator entry,
 * `--orchestrator <claude|codex|grok>` — so the app spawns
 * `workspace-feed` from the same build as the daemon, never whatever `hive`
 * happens to be on the app's PATH. Run outside a git repo, it stays a
 * project-neutral launcher: a forced release-metadata check, then an argless
 * launch that shows the app's placeholder window — the same home a Dock
 * click gets.
 *
 * There is deliberately no development fallback. Not a symlink into
 * `workspace/.build`, not a `swift run`, not an environment variable that
 * quietly prefers a debug bundle. A `hive` that sometimes launches a debug
 * build is a `hive` whose bug reports cannot be trusted, and the one thing
 * worse than "Workspace is not installed" is "Workspace launched, and nobody
 * can say which one".
 *
 * The app lives inside the active version directory, so the symlink that
 * activates a CLI release activates its Workspace in the same atomic rename.
 * They cannot skew.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  checkForUpdate,
  fetchLatestFromGitHub,
  isDismissed,
  readUpdateCache,
  type UpdateCheck,
} from "../update/check";
import {
  currentLink,
  detectInstallMethod,
  installRoot,
  workspaceAppPath,
} from "../update/paths";
import { renderStartNotice } from "../update/notice";
import { IS_RELEASE_BUILD } from "../version";
import { orchestratorTmuxSession } from "../daemon/tmux-sessions";
import {
  hiveInstanceSuffix,
  hiveTmuxSocketName,
  isDefaultHiveHome,
} from "../daemon/tmux-sessions";
import { getHiveHome } from "../daemon/db";
import { isRepoInitialized, runInitCli } from "./init";
import { startSession, type StartDeps, type StartedSession } from "./start";
import { resolveProjectRoot } from "./project-root";
import type { OrchestratorTool } from "./orchestrator";

export class WorkspaceNotInstalledError extends Error {}

/** The release Workspace bundle, or null when no release is installed. */
export function resolveWorkspaceApp(root = installRoot()): string | null {
  const app = workspaceAppPath(currentLink(root));
  return existsSync(app) ? app : null;
}

// Both of the messages below name a command, and both have earned it. Hive
// cannot install itself from a source checkout, and it will not silently pull a
// release over the network because someone typed `hive` — that is the user's
// call. So each states the fact, then the remedy on one labelled `Fix:` line.
const INSTALL_HINT =
  "no Hive release is installed; a source checkout cannot launch the Workspace " +
  "(`hive` opens the installed release build, never a development build)\n" +
  "Fix: curl -fsSL https://raw.githubusercontent.com/scottdev1986/hive/main/install.sh | sh";

export interface LaunchDeps {
  readonly root?: string;
  readonly open?: (app: string, args: readonly string[]) => Promise<number>;
  /** Present when a session is up: the app opens this project against this
   * daemon. Absent, the app launches standalone (placeholder window). */
  readonly session?: {
    readonly cwd: string;
    readonly port: number;
    /** The CLI binary forwarded as `--hive`; defaults to this very process. */
    readonly hivePath?: string;
    /** The orchestrator hosted in the Workspace master pane. */
    readonly orchestrator?: OrchestratorTool;
  };
}

const WORKSPACE_PROCESS_MARKER =
  "HiveWorkspace.app/Contents/MacOS/HiveWorkspace";

export function workspaceLaunchNeedsNewProcess(
  processTable: string,
  instanceId = hiveInstanceSuffix(),
): boolean {
  for (const line of processTable.split("\n")) {
    const executable = line.indexOf(WORKSPACE_PROCESS_MARKER);
    if (executable < 0) continue;
    const command = line.slice(executable + WORKSPACE_PROCESS_MARKER.length);
    const running = /(?:^|\s)--instance-id\s+([^\s]+)/.exec(command)?.[1];
    // A project-neutral window has no instance id and cannot safely absorb a
    // project launch either: LaunchServices would activate it and discard the
    // new argv just as it does for a different named instance.
    if (running !== instanceId) return true;
  }
  return false;
}

export function workspaceOpenArguments(
  app: string,
  args: readonly string[],
  newProcess: boolean,
  path = process.env.PATH,
  temporaryDirectory = process.env.TMPDIR,
): string[] {
  return [
    ...(newProcess ? ["-n"] : []),
    "-a",
    app,
    // LaunchServices creates `open -n` processes from launchd's environment,
    // which can omit package-manager tools and user-installed provider CLIs. Pass the
    // caller's resolved command path across that process boundary explicitly.
    ...(path === undefined ? [] : ["--env", `PATH=${path}`]),
    // SwiftTerm starts the root from an explicit environment rather than the
    // app's full inherited environment. Preserve macOS's private per-user temp
    // directory across both LaunchServices and that terminal boundary; without
    // it Node falls back to the /tmp symlink and Codex app-server refuses the
    // socket parent as "not a directory".
    ...(temporaryDirectory === undefined
      ? []
      : ["--env", `TMPDIR=${temporaryDirectory}`]),
    "--args",
    ...args,
  ];
}

const readWorkspaceProcessTable = (): Promise<string | null> =>
  new Promise((resolvePromise) => {
    const child = spawn("ps", ["-axo", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => resolvePromise(code === 0 ? stdout : null));
  });

const openApp = async (
  app: string,
  args: readonly string[],
): Promise<number> => {
  // A named instance always owns a separate process. The default instance may
  // reuse only a Workspace already carrying its own instance id; macOS cannot
  // pass new --args to a running process owned by another Hive instance.
  const table = isDefaultHiveHome() ? await readWorkspaceProcessTable() : null;
  const newProcess = !isDefaultHiveHome() || table === null ||
    workspaceLaunchNeedsNewProcess(table);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("open", workspaceOpenArguments(app, args, newProcess), {
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
  const args = deps.session === undefined
    ? []
    : [
        "--project",
        deps.session.cwd,
        "--port",
        String(deps.session.port),
        "--instance-id",
        hiveInstanceSuffix(),
        "--instance-home",
        getHiveHome(),
        "--hive",
        deps.session.hivePath ?? process.execPath,
        "--orchestrator-session",
        orchestratorTmuxSession(),
        "--tmux-socket",
        hiveTmuxSocketName(),
        ...(deps.session.orchestrator === undefined
          ? []
          : ["--orchestrator", deps.session.orchestrator]),
      ];
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
  /** Test seams for the first-run init handoff below. */
  readonly isInitialized?: (root: string) => boolean;
  readonly init?: (root: string) => Promise<void>;
}

/** Bare `hive`. Inside a git worktree: resolve the repo root, run the shared
 * session boundary, and launch the app against that project and its daemon
 * port. That path must NOT run the forced update check below — `startSession`
 * already prints the start notice, and running both prints it twice. Outside
 * a repo: force a small release-metadata check, offer an update when one
 * exists, then launch the app standalone. A failed check is silent: app
 * launch is useful offline and network trouble is not a project warning.
 *
 * A repo that never completed `hive init` gets the same init flow first,
 * announced before anything is written: bare `hive` must never leave a repo
 * half-initialized or mutate it by surprise, and the graphify question is the
 * same question init asks (TTY-gated; without a terminal it declines for the
 * run with one line). Init failing does not stop the launch — the session
 * boundary below still brings the daemon up, and init can be re-run. */
export async function runWorkspace(deps: RunWorkspaceDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const root = (deps.resolveRoot ?? resolveProjectRoot)(cwd);
  if (root !== null) {
    if (!(deps.isInitialized ?? isRepoInitialized)(root)) {
      (deps.write ?? ((text: string) => process.stderr.write(`${text}\n`)))(
        `No Hive here yet — initializing ${root} first (\`hive init\`: skills, repo profile, memory):`,
      );
      await (deps.init ?? ((r: string) => runInitCli({ cwd: r })))(root)
        .catch((error: unknown) => {
          (deps.write ?? ((text: string) => process.stderr.write(`${text}\n`)))(
            `init did not complete (${error instanceof Error ? error.message : String(error)}); starting anyway — re-run \`hive init\` to finish.`,
          );
        });
    }
    const session = await (deps.start ?? startSession)({ cwd: root });
    return (deps.launch ?? launchWorkspace)({
      session: {
        cwd: session.cwd,
        port: session.port,
        ...(deps.orchestrator === undefined
          ? {}
          : { orchestrator: deps.orchestrator }),
      },
    });
  }
  try {
    const check = await (deps.checkUpdate ?? (() => checkForUpdate({
      fetchLatest: () => fetchLatestFromGitHub(),
      now: () => Date.now(),
      force: true,
    })))();
    if (check.state === "update-available" &&
      (check.securityCritical || !isDismissed(check.latest, readUpdateCache()))) {
      const line = renderStartNotice({
        check,
        installMethod: detectInstallMethod(process.execPath),
      });
      (deps.write ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
    }
  } catch {
    // Update discovery must never turn a standalone app launch into an error.
  }
  return (deps.launch ?? launchWorkspace)({});
}
