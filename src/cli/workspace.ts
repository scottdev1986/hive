/**
 * `hive` — check for a release, then open the standalone Workspace app.
 *
 * The current directory is deliberately irrelevant. A bare launch passes no
 * project path or daemon port to the app; `hive init` is the explicit command
 * that initializes a project and starts its daemon.
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
  return (deps.open ?? openApp)(app, []);
}

export interface RunWorkspaceDeps {
  readonly checkUpdate?: () => Promise<UpdateCheck>;
  readonly write?: (line: string) => void;
  readonly launch?: (deps: LaunchDeps) => Promise<number>;
}

/** Bare `hive`: force a small release-metadata check, offer an update when one
 * exists, then launch the app without consulting the current repo. A failed
 * check is silent: app launch is useful offline and network trouble is not a
 * project warning. */
export async function runWorkspace(deps: RunWorkspaceDeps = {}): Promise<number> {
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
