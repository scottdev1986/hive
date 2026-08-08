import { realpathSync } from "node:fs";
import { runGitSync } from "../../adapters/git";

export interface GitProbe {
  isRepository: boolean;
  isBare: boolean;
  isInsideGitDir: boolean;
  topLevel: string | null;
  gitDir: string | null;
  gitCommonDir: string | null;
  superprojectRoot: string | null;
}

const NOT_A_REPOSITORY: GitProbe = {
  isRepository: false,
  isBare: false,
  isInsideGitDir: false,
  topLevel: null,
  gitDir: null,
  gitCommonDir: null,
  superprojectRoot: null,
};

function git(cwd: string, args: string[]): string | null {
  try {
    const result = runGitSync(cwd, args);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Step 3 of the resolver: discover the nearest Git worktree. Two behaviors this function exists to contain: - `--show-toplevel` makes the whole rev-parse invocation fail inside a bare repository ("fatal: this operation must be run in a work tree"), so bareness is queried first, on its own. - `--git-common-dir` is reported *relative to the invocation cwd* by default (measured: `../../.git` from a subdirectory). `--path-format=absolute`, added in Git 2.31, is mandatory; without it the resolver silently mis-keys the repository family whenever it is invoked below the top level. */
export function probeGit(cwd: string): GitProbe {
  const flags = git(cwd, [
    "rev-parse",
    "--is-bare-repository",
    "--is-inside-git-dir",
  ]);
  if (flags === null) return NOT_A_REPOSITORY;

  const [bare, insideGitDir] = flags
    .split("\n")
    .map((line) => line.trim() === "true");

  if (bare === true) {
    const gitDir = git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]);
    return { ...NOT_A_REPOSITORY, isRepository: true, isBare: true, gitDir };
  }
  if (insideGitDir === true) {
    return { ...NOT_A_REPOSITORY, isRepository: true, isInsideGitDir: true };
  }

  const paths = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (paths === null) return NOT_A_REPOSITORY;

  const [topLevel, gitDir, gitCommonDir] = paths
    .split("\n")
    .map((line) => line.trim());
  if (!topLevel || !gitDir || !gitCommonDir) return NOT_A_REPOSITORY;

  const superproject = git(cwd, [
    "rev-parse",
    "--show-superproject-working-tree",
  ]);

  return {
    isRepository: true,
    isBare: false,
    isInsideGitDir: false,
    topLevel,
    gitDir,
    gitCommonDir,
    superprojectRoot: superproject ? superproject : null,
  };
}

/** The landing-lease key. Linked worktrees of one repository share `git-common-dir` and therefore share refs; they must serialize rebase -> retest -> fast-forward. Separate clones and submodules have their own common dir and do not. */
export function repoFamilyKeyOf(gitCommonDir: string): string {
  try {
    return realpathSync.native(gitCommonDir);
  } catch {
    return gitCommonDir;
  }
}

/** A linked worktree is exactly the case where the per-worktree git dir is not the common dir. */
export function isLinkedWorktree(probe: GitProbe): boolean {
  if (!probe.gitDir || !probe.gitCommonDir) return false;
  return repoFamilyKeyOf(probe.gitDir) !== repoFamilyKeyOf(probe.gitCommonDir);
}
