/**
 * `hive` — bring the session up, then open the installed release Workspace.
 *
 * Bare `hive` is not a shortcut around `hive start`; it *is* `hive start`
 * followed by attaching the app. It runs the same session boundary (update
 * notice, stale-daemon restart, daemon bring-up, init-once profile line) and
 * only then launches the app, handing it everything it needs on argv:
 *
 *   --project <cwd>   the project directory this window serves
 *   --port <port>     the live daemon port the launcher just brought up
 *   --hive <path>     the exact CLI binary that did it (`process.execPath`),
 *                     so the app spawns `workspace-feed` and other helpers
 *                     from the same build as the daemon — never whatever
 *                     `hive` happens to be on the app's PATH.
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
import { currentLink, installRoot, workspaceAppPath } from "../update/paths";
import { IS_RELEASE_BUILD } from "../version";
import { startSession, type StartedSession } from "./start";

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
  /** The daemon port the launcher already brought up; the app never guesses. */
  readonly port: number;
  readonly root?: string;
  readonly open?: (app: string, args: readonly string[]) => Promise<number>;
  readonly cwd?: string;
  /** The CLI binary forwarded as `--hive`; defaults to this very process. */
  readonly hivePath?: string;
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
  const cwd = deps.cwd ?? process.cwd();
  return (deps.open ?? openApp)(app, [
    "--project",
    cwd,
    "--port",
    String(deps.port),
    "--hive",
    deps.hivePath ?? process.execPath,
  ]);
}

export interface RunWorkspaceDeps {
  readonly start?: () => Promise<StartedSession>;
  readonly launch?: (deps: LaunchDeps) => Promise<number>;
}

/** Bare `hive`: the `hive start` session boundary, then the app attached to
 * exactly the port that boundary produced. */
export async function runWorkspace(deps: RunWorkspaceDeps = {}): Promise<number> {
  const session = await (deps.start ?? startSession)();
  return (deps.launch ?? launchWorkspace)({
    cwd: session.cwd,
    port: session.port,
  });
}
