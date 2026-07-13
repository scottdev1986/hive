import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const GIT_TIMEOUT_MS = 30_000;

export interface Worktree {
  path: string;
  branch: string | null;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

export interface RemoveWorktreeOptions {
  deleteBranch?: boolean;
  discardTracked?: boolean;
  force?: boolean;
  /**
   * The branch to delete, from the caller that knows it.
   *
   * Without it, deleteBranch can only delete what `git worktree list` still
   * reports — and once the worktree directory is gone and its registration
   * pruned, that list is empty, so the delete silently deletes nothing and
   * still returns success. The caller then records the branch as removed while
   * it is still sitting in the repo. Git's worktree list is not the authority
   * on which branch an agent held; the caller is.
   */
  branch?: string;
}

export interface StrandedWork {
  dirtyFiles: string[];
  unmergedCommits: number;
}

/** Paths an agent is observably changing, from its worktree and unmerged branch. */
export async function observedWorktreeFiles(
  repoRoot: string,
  worktreePath: string | null,
  branch: string | null,
  mainBranch = "main",
): Promise<string[]> {
  const paths = new Set<string>();
  if (worktreePath !== null) {
    const status = await runGit(worktreePath, [
      "status",
      "--porcelain",
      "-uall",
    ]);
    if (status.exitCode === 0) {
      for (const line of status.stdout.split("\n")) {
        if (line !== "") paths.add(line.slice(3));
      }
    }
  }
  if (branch !== null && await branchExists(repoRoot, branch)) {
    const diff = await runGit(repoRoot, [
      "diff",
      "--name-only",
      `${mainBranch}...${branch}`,
    ]);
    if (diff.exitCode === 0) {
      for (const path of diff.stdout.split("\n")) {
        if (path !== "") paths.add(path);
      }
    }
  }
  return [...paths].filter((path) => !HIVE_WORKTREE_WIRING.includes(path)).sort();
}

export interface UnmergedBranch {
  branch: string;
  tip: string;
  unmergedCommits: number;
  preserved?: boolean;
  ownerInstanceId?: string;
}

export class WorktreeNameCollisionError extends Error {}

const preservedRef = (branch: string): string =>
  `refs/hive-preserved/${branch}`;

const ownerRef = (branch: string, instanceId = hiveInstanceSuffix()): string =>
  `refs/hive-owner/${instanceId}/${branch}`;

async function markBranchOwned(
  repoRoot: string,
  branch: string,
  owned: boolean,
): Promise<void> {
  const result = owned
    ? await runGit(repoRoot, ["update-ref", ownerRef(branch), branch])
    : await runGit(repoRoot, ["update-ref", "-d", ownerRef(branch)]);
  assertGitSuccess(result, "update-ref");
}

async function branchOwner(
  repoRoot: string,
  branch: string,
): Promise<string | undefined> {
  const result = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/hive-owner",
  ]);
  if (result.exitCode !== 0) return undefined;
  const suffix = `/${branch}`;
  for (const ref of result.stdout.split("\n")) {
    if (!ref.endsWith(suffix)) continue;
    const owner = ref.slice("refs/hive-owner/".length, -suffix.length);
    if (owner !== "") return owner;
  }
  return undefined;
}

export async function markBranchPreserved(
  repoRoot: string,
  branch: string,
  preserved: boolean,
): Promise<void> {
  assertName(branch.replaceAll("/", "-"), "branch");
  const result = preserved
    ? await runGit(repoRoot, ["update-ref", preservedRef(branch), branch])
    : await runGit(repoRoot, ["update-ref", "-d", preservedRef(branch)]);
  assertGitSuccess(result, "update-ref");
}

async function isBranchPreserved(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const result = await runGit(repoRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    preservedRef(branch),
  ]);
  return result.exitCode === 0;
}

async function runGit(repoRoot: string, args: string[]): Promise<GitResult> {
  const process = Bun.spawn(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { stdout, stderr, exitCode };
}

function assertGitSuccess(result: GitResult, operation: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    throw new Error(`git ${operation} failed: ${detail}`);
  }
}

function assertName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a single safe path component`);
  }
}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

export function slugify(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return slug || "task";
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      return resolve(path);
    }
    return join(await canonicalizePotentialPath(parent), basename(path));
  }
}

export async function createWorktree(
  repoRoot: string,
  agentName: string,
  taskSlug: string,
): Promise<CreatedWorktree> {
  assertName(agentName, "agent name");
  const safeTaskSlug = slugify(taskSlug);

  const branch = `hive/${agentName}-${safeTaskSlug}`;
  const path = join(repoRoot, ".hive", "worktrees", agentName);
  await mkdir(join(repoRoot, ".hive", "worktrees"), { recursive: true });

  const result = await runGit(repoRoot, [
    "worktree",
    "add",
    "-b",
    branch,
    path,
  ]);
  if (result.exitCode !== 0) {
    const branchTaken = await branchExists(repoRoot, branch);
    const pathTaken = (await listWorktrees(repoRoot).catch(() => []))
      .some((worktree) => worktree.path === resolve(path));
    if (branchTaken || pathTaken) {
      throw new WorktreeNameCollisionError(
        `Agent name ${agentName} is already claimed in ${repoRoot}`,
      );
    }
  }
  assertGitSuccess(result, "worktree add");
  await markBranchOwned(repoRoot, branch, true);

  return { path, branch };
}

export async function listWorktrees(repoRoot: string): Promise<Worktree[]> {
  const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  assertGitSuccess(result, "worktree list");

  return result.stdout
    .trim()
    .split(/\n\n+/)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      let path = "";
      let branch: string | null = null;

      for (const line of record.split("\n")) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        } else if (line.startsWith("branch refs/heads/")) {
          branch = line.slice("branch refs/heads/".length);
        }
      }

      return { path, branch };
    })
    .filter((worktree) => worktree.path.length > 0);
}

/** Delete a branch, tolerating one that is already gone. */
async function deleteBranch(
  repoRoot: string,
  branch: string | null,
): Promise<void> {
  if (branch === null) return;
  if (await branchExists(repoRoot, branch)) {
    const result = await runGit(repoRoot, ["branch", "-D", branch]);
    assertGitSuccess(result, "branch delete");
  }
  await markBranchOwned(repoRoot, branch, false);
}

export async function unavailableAgentNames(
  repoRoot: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  const [worktrees, branchResult] = await Promise.all([
    listWorktrees(repoRoot),
    runGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/hive",
    ]),
  ]);
  const marker = `${join(".hive", "worktrees")}/`;
  const worktreeNames = new Set(
    worktrees
      .filter((worktree) => worktree.path.includes(marker))
      .map((worktree) => basename(worktree.path)),
  );
  const branches = branchResult.exitCode === 0
    ? branchResult.stdout.split("\n")
    : [];
  return new Set(candidates.filter((name) =>
    worktreeNames.has(name) ||
    branches.some((branch) => branch.startsWith(`hive/${name}-`))
  ));
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.exitCode === 0;
}

/**
 * Files Hive itself writes into an agent's worktree. They are wiring, never
 * work: Hive generates them at spawn and strips them at cleanup, and no agent
 * authors them.
 *
 * This exists because dirty files mean "this agent still holds work", so Hive
 * refuses to reap an agent that has any. `.grok/config.toml` is Hive's own
 * Grok MCP wiring (writeGrokAgentConfig), written into every Grok worktree at
 * spawn — which made every Grok agent permanently dirty, permanently
 * "unfinished", and impossible to auto-reap. They piled up forever.
 *
 * A repo's own .gitignore cannot fix this, because Hive runs in repos that
 * have never heard of it. The exclusion belongs here, in the check that
 * decides whether work exists at all.
 *
 * Named exactly, never by directory: excluding a path here means Hive may
 * delete the worktree holding it, so this must not be able to swallow a file
 * someone actually wrote. The Grok CLI itself writes nothing into its cwd
 * (measured — its session artifacts live in ~/.grok/sessions), so if anything
 * else ever appears under `.grok/` it shows up as dirty and blocks the reap.
 * That is the safe direction to fail.
 */
const HIVE_WORKTREE_WIRING: readonly string[] = [".grok/config.toml"];

export async function assessStrandedWork(
  repoRoot: string,
  worktreePath: string | null,
  branch: string | null,
  mainBranch = "main",
): Promise<StrandedWork> {
  let dirtyFiles: string[] = [];
  if (worktreePath !== null) {
    const statusResult = await runGit(worktreePath, [
      "status",
      "--porcelain",
      // Untracked directories are collapsed by default -- git prints
      // "?? .grok/" and never the files inside it -- so a path-level exclusion
      // would never match, and a caller counting entries cannot see what it is
      // actually holding. -uall names every file.
      "-uall",
    ]);
    if (statusResult.exitCode === 0) {
      dirtyFiles = statusResult.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.slice(3))
        .filter((path) => !HIVE_WORKTREE_WIRING.includes(path));
    }
    // A missing or already-pruned worktree has no dirty files by definition;
    // any commits it made still show up in the unmerged count below.
  }

  let unmergedCommits = 0;
  if (branch !== null && await branchExists(repoRoot, branch)) {
    const revListResult = await runGit(repoRoot, [
      "rev-list",
      "--count",
      `${mainBranch}..${branch}`,
    ]);
    assertGitSuccess(revListResult, "rev-list");
    const count = revListResult.stdout.trim();
    if (!/^[0-9]+$/.test(count)) {
      throw new Error(`git rev-list failed: invalid count "${count}"`);
    }
    unmergedCommits = Number(count);
    if (!Number.isSafeInteger(unmergedCommits)) {
      throw new Error(`git rev-list failed: count exceeds safe integer range`);
    }
  }

  return { dirtyFiles, unmergedCommits };
}

/**
 * Every hive/* branch holding commits that are not on main.
 *
 * This is the one inventory of unlanded work that is not anchored to the
 * agents table. Reaping, recovery, and reconciliation all iterate agent rows,
 * so work whose row is gone — a reset database, a lost row — is invisible to
 * every one of them. Branch refs outlive the database, so re-deriving this
 * list from git each boot is what makes orphaned work findable at all.
 */
export async function listUnmergedHiveBranches(
  repoRoot: string,
  mainBranch = "main",
): Promise<UnmergedBranch[]> {
  const result = await runGit(repoRoot, [
    "branch",
    "--list",
    "hive/*",
    "--no-merged",
    mainBranch,
    "--format=%(refname:short) %(objectname)",
  ]);
  // A repository with no main branch yet has nothing to be unmerged from.
  if (result.exitCode !== 0) return [];

  const branches: UnmergedBranch[] = [];
  for (const line of result.stdout.split("\n")) {
    const [branch, tip] = line.trim().split(" ");
    if (branch === undefined || branch === "" || tip === undefined) continue;
    const { unmergedCommits } = await assessStrandedWork(
      repoRoot,
      null,
      branch,
      mainBranch,
    );
    const preserved = await isBranchPreserved(repoRoot, branch);
    const ownerInstanceId = await branchOwner(repoRoot, branch);
    branches.push({
      branch,
      tip,
      unmergedCommits,
      ...(preserved ? { preserved } : {}),
      ...(ownerInstanceId === undefined ? {} : { ownerInstanceId }),
    });
  }
  return branches;
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options: RemoveWorktreeOptions | boolean = {},
): Promise<void> {
  const normalizedOptions: RemoveWorktreeOptions =
    typeof options === "boolean" ? { deleteBranch: options } : options;
  const shouldDeleteBranch = normalizedOptions.deleteBranch ?? false;
  const discardTracked = normalizedOptions.discardTracked ?? false;
  const force = discardTracked || (normalizedOptions.force ?? true);
  const requestedPath = await canonicalizePotentialPath(worktreePath);
  const worktrees = await listWorktrees(repoRoot);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(worktreePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    const staleWorktree = worktrees.find(
      (candidate) => candidate.path === requestedPath,
    );
    const pruneResult = await runGit(repoRoot, ["worktree", "prune"]);
    assertGitSuccess(pruneResult, "worktree prune");

    if (shouldDeleteBranch) {
      await deleteBranch(
        repoRoot,
        normalizedOptions.branch ?? staleWorktree?.branch ?? null,
      );
    }
    return;
  }

  const worktree = worktrees.find(
    (candidate) =>
      candidate.path === canonicalPath || candidate.path === requestedPath,
  );
  const branch = normalizedOptions.branch ?? worktree?.branch ?? null;

  if (!discardTracked) {
    const statusResult = await runGit(canonicalPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    assertGitSuccess(statusResult, "status");
    const trackedChanges = statusResult.stdout
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("?? "));
    if (trackedChanges.length > 0) {
      throw new Error(
        `refusing to remove worktree with uncommitted changes to tracked files; pass { discardTracked: true } to override:\n${trackedChanges.join("\n")}`,
      );
    }
  }

  const removeArgs = ["worktree", "remove"];
  if (force) {
    removeArgs.push("--force");
  }
  removeArgs.push(canonicalPath);

  const removeResult = await runGit(repoRoot, removeArgs);
  assertGitSuccess(removeResult, "worktree remove");

  if (shouldDeleteBranch) {
    await deleteBranch(repoRoot, branch);
  }
}
