import { dirname, join } from "node:path";
import { getHiveHome } from "../../hive-home/home";
import { resolveHandshakeProject } from "./project-identity-daemon";
import { runGitSync } from "../../adapters/git";

/** The main working tree of `root`'s repo. `--git-common-dir` is the one question whose answer is shared by every worktree of a repo: it names the main `.git`, whose parent is the checkout the project state belongs to. A directory that is not a Git checkout is simply its own project. */
function primaryWorktree(root: string): string {
  try {
    const result = runGitSync(
      root,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeoutMs: 5_000, killSignal: "SIGKILL" },
    );
    if (result.exitCode !== 0) return root;
    return dirname(result.stdout.trim());
  } catch {
    return root;
  }
}

/** The uuid this project is known by. Resolved through the primary worktree so every linked agent worktree of a repo shares one durable project identity, and minted by the project registry so it survives the repo being moved or renamed. */
export function projectKey(root: string): string {
  return resolveHandshakeProject(primaryWorktree(root)).hiveUuid;
}

/** The directory Hive keeps this project's derived state in. */
export function projectStateDir(root: string): string {
  return join(getHiveHome(), "projects", projectKey(root));
}
