/** Point a CLI process at the Hive home the daemon for this repository actually uses. */

import { selectRepoInstance } from "../daemon/lifecycle/instances";
import { resolveProjectRoot } from "../daemon/project-identity-core/project-root";
import { projectKey } from "../daemon/project-identity-core/state";
import { getHiveHome, isDefaultHiveHome } from "../hive-home/home";

/**
 * `hive` start already does this via selectRepoInstance; every other command
 * that reads daemon.port or the user credential must agree, or a repo with its
 * own instance talks to the machine home instead. An explicit HIVE_HOME or
 * --instance is left alone.
 */
export function bindCliHiveHome(cwd = process.cwd()): string {
  if (!isDefaultHiveHome()) return getHiveHome();
  const root = resolveProjectRoot(cwd);
  if (root === null) return getHiveHome();
  return selectRepoInstance(projectKey(root));
}

/**
 * Machine-scoped verbs, plus commands that select the instance themselves,
 * keep the install/default home even inside a repo. Bare `hive` runs
 * prepareRepoWorkspaceInstance while still on the default home so it can copy
 * board state into a new instance. `hive init` provisions embeddings under
 * the machine home. uninstall and update mutate the install, not one repo.
 */
export function cliCommandKeepsMachineHome(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--instance") {
      index += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith("-")) continue;
    return arg === "uninstall" || arg === "update" || arg === "init";
  }
  return true;
}
