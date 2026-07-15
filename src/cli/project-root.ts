/**
 * Shared project-root resolution for the CLI entry points.
 *
 * Bare `hive` anchors a session and `hive init` anchors setup to the repository root,
 * not to whichever subdirectory the shell happens to be in — the daemon's
 * identity resolver canonicalizes to `git rev-parse --show-toplevel`, and a
 * session or per-project state keyed to a subdirectory silently splits identity.
 * `probeGit` is the same resolver the daemon uses (env-sanitized, bare-safe,
 * absolute paths), so the CLI and daemon can never disagree about the root.
 */
import { probeGit } from "../daemon/project-identity-core/index";

/** The canonical worktree root for `cwd`, or null outside a git worktree. */
export function resolveProjectRoot(cwd: string): string | null {
  return probeGit(cwd).topLevel;
}

/** The root when inside a repo, the directory itself when not. */
export function projectRootOrCwd(cwd = process.cwd()): string {
  return resolveProjectRoot(cwd) ?? cwd;
}
