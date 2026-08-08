/** Shared project-root resolution for every entry point that anchors state to a repository. Bare `hive` anchors a session, `hive init` anchors setup, and the daemon anchors its per-project state to the repository root, not to whichever subdirectory the shell happens to be in — the identity resolver canonicalizes to `git rev-parse --show-toplevel`, and a session or per-project state keyed to a subdirectory silently splits identity. `probeGit` is that resolver (env-sanitized, bare-safe, absolute paths), so the CLI and daemon can never disagree about the root. */
import { probeGit } from "./project-identity-git";

/** The canonical worktree root for `cwd`, or null outside a git worktree. */
export function resolveProjectRoot(cwd: string): string | null {
  return probeGit(cwd).topLevel;
}

export function projectRootOrCwd(cwd = process.cwd()): string {
  return resolveProjectRoot(cwd) ?? cwd;
}
