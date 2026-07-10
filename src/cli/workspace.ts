/**
 * `hive` — open the project you're in.
 *
 * Run inside a git worktree, bare `hive` resolves the repository root, runs
 * the shared `hive init` session boundary (update notice, stale-daemon
 * restart, daemon bring-up, init-once profile line), and launches the
 * installed release app with everything it needs on argv: `--project <root>`,
 * `--port <port>`, and `--hive <this binary>` — so the app spawns
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
import { startSession, type StartDeps, type StartedSession } from "./start";
import { resolveProjectRoot } from "./project-root";

export class WorkspaceNotInstalledError extends Error {}

/** The release Workspace bundle, or null when no release is installed. */
export function resolveWorkspaceApp(root = installRoot()): string | null {
  const app = workspaceAppPath(currentLink(root));
  return existsSync(app) ? app : null;
}

const INSTALL_HINT =
  "Install a Hive release first:\n" +
  "  curl -fsSL https://raw.githubusercontent.com/scottdev1986/hive/main/install.sh | sh\n" +
  "Then run `hive` again. A source checkout cannot launch the Workspace: " +
  "`hive` opens the installed release build, never a development build.";

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
  };
}

const openApp = (app: string, args: readonly string[]): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    // `open -a` hands off to LaunchServices, which reuses a running instance —
    // the Workspace multiplexes project windows in one process by design.
    const child = spawn("open", ["-a", app, "--args", ...args], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 0));
  });

export async function launchWorkspace(deps: LaunchDeps): Promise<number> {
  const root = deps.root ?? installRoot();
  const app = resolveWorkspaceApp(root);
  if (app === null) {
    throw new WorkspaceNotInstalledError(
      IS_RELEASE_BUILD
        ? `The Hive Workspace application is missing from ${currentLink(root)}. ` +
          "Run `hive update` to repair the installation."
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
        "--hive",
        deps.session.hivePath ?? process.execPath,
      ];
  return (deps.open ?? openApp)(app, args);
}

export interface RunWorkspaceDeps {
  readonly cwd?: string;
  readonly resolveRoot?: (cwd: string) => string | null;
  readonly start?: (deps: StartDeps) => Promise<StartedSession>;
  readonly checkUpdate?: () => Promise<UpdateCheck>;
  readonly write?: (line: string) => void;
  readonly launch?: (deps: LaunchDeps) => Promise<number>;
}

/** Bare `hive`. Inside a git worktree: resolve the repo root, run the shared
 * session boundary, and launch the app against that project and its daemon
 * port. That path must NOT run the forced update check below — `startSession`
 * already prints the start notice, and running both prints it twice. Outside
 * a repo: force a small release-metadata check, offer an update when one
 * exists, then launch the app standalone. A failed check is silent: app
 * launch is useful offline and network trouble is not a project warning. */
export async function runWorkspace(deps: RunWorkspaceDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const root = (deps.resolveRoot ?? resolveProjectRoot)(cwd);
  if (root !== null) {
    const session = await (deps.start ?? startSession)({ cwd: root });
    return (deps.launch ?? launchWorkspace)({
      session: { cwd: session.cwd, port: session.port },
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
