import { probeGit } from "./project-identity-git";

/** The canonical worktree root for `cwd`, or null outside a git worktree. */
export function resolveProjectRoot(cwd: string): string | null {
  return probeGit(cwd).topLevel;
}

export function projectRootOrCwd(cwd = process.cwd()): string {
  return resolveProjectRoot(cwd) ?? cwd;
}
