// Where Hive keeps a project's derived state. Extracted from the legacy
// profiler (`src/adapters/profile.ts`) because it is project *identity*, not
// profiling: graphify, `hive init`, and `hive uninstall` all need this directory
// and none of them care how a profile is produced. The legacy profiler is going
// away; this is not.
import { dirname, join } from "node:path";
import { getHiveHome } from "./db";
import { resolveHandshakeProject } from "./project-identity";

/** The main working tree of `root`'s repo. `--git-common-dir` is the one
 * question whose answer is shared by every worktree of a repo: it names the main
 * `.git`, whose parent is the checkout the project state belongs to. A directory
 * that is not a Git checkout is simply its own project. */
function primaryWorktree(root: string): string {
  try {
    const result = Bun.spawnSync(
      ["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { stdout: "pipe", stderr: "ignore", timeout: 5_000, killSignal: "SIGKILL" },
    );
    if (result.exitCode !== 0) return root;
    return dirname(result.stdout.toString().trim());
  } catch {
    return root;
  }
}

/** The directory Hive keeps this project's derived state in. Resolved through
 * the primary worktree so every linked agent worktree of a repo shares one
 * durable project identity, and keyed by the uuid the project registry mints so
 * it survives the repo being moved or renamed. */
export function projectStateDir(root: string): string {
  const { hiveUuid } = resolveHandshakeProject(primaryWorktree(root));
  return join(getHiveHome(), "projects", hiveUuid);
}

/** The project uuid `projectStateDir` keys on. The profile records it so a
 * payload can be checked against the project it claims to describe. */
export function projectHiveUuid(root: string): string {
  return resolveHandshakeProject(primaryWorktree(root)).hiveUuid;
}
