/**
 * `hive` — open the installed release Workspace application.
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
  readonly open?: (app: string, projectDir: string) => Promise<number>;
  readonly cwd?: string;
}

const openApp = (app: string, projectDir: string): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    // `open -a` hands off to LaunchServices, which reuses a running instance —
    // the Workspace multiplexes project windows in one process by design.
    const child = spawn("open", ["-a", app, "--args", "--project", projectDir], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 0));
  });

export async function launchWorkspace(deps: LaunchDeps = {}): Promise<number> {
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
  return (deps.open ?? openApp)(app, cwd);
}
