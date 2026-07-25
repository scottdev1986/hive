import {
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  hiveInstanceSuffix,
  isDefaultHiveHome,
} from "../daemon/instance-identity";
import {
  type AgentRecord,
  CAPABILITY_PROVIDERS,
  isLiveAgent,
} from "../schemas";
import { shippedSkillsFor } from "../skills/shipped";
import { nativeSkillDirectory, stagedSkillLinks } from "./skills";
import { grokHookFilename, ownsGrokHook } from "./tools/grok";

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
  /** The caller-owned branch identity. A removed worktree registration cannot
   * recover it reliably. */
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
  if (branch !== null && (await branchExists(repoRoot, branch))) {
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
  const observed: string[] = [];
  const skillLinks = await stagedSkillLinks(repoRoot);
  for (const path of paths) {
    if (!(await isHiveWorktreeWiring(path, worktreePath, skillLinks))) {
      observed.push(path);
    }
  }
  return observed.sort();
}

export interface UnmergedBranch {
  branch: string;
  tip: string;
  unmergedCommits: number;
  preserved?: boolean;
  ownerInstanceId?: string;
}

export interface WorktreeReconciliationOutcome {
  path: string;
  branch: string | null;
  action: "kept" | "removed";
  rule:
    | "live-agent"
    | "preserved-agent"
    | "stranded-work"
    | "assessment-failed"
    | "cleanup-failed"
    | "foreign-instance"
    | "unregistered-path"
    | "clean-orphan";
  dirtyFiles: string[];
  unmergedCommits: number;
  note?: string;
}

export interface PreservedRefReconciliation {
  removed: Array<{ branch: string; tip: string }>;
  kept: Array<{ branch: string; tip: string; unmergedCommits: number }>;
}

export interface WorktreeReconciliationReport {
  worktrees: WorktreeReconciliationOutcome[];
  preservedRefs: PreservedRefReconciliation;
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

export async function branchOwner(
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
  const owners: string[] = [];
  for (const ref of result.stdout.split("\n")) {
    if (!ref.endsWith(suffix)) continue;
    const owner = ref.slice("refs/hive-owner/".length, -suffix.length);
    if (owner !== "") owners.push(owner);
  }
  if (owners.length > 1) {
    throw new Error(`Branch ${branch} has multiple Hive instance owners`);
  }
  return owners[0];
}

async function assertBranchMutationAllowed(
  repoRoot: string,
  branch: string | null,
): Promise<void> {
  if (branch === null) return;
  const owner = await branchOwner(repoRoot, branch);
  if (owner === hiveInstanceSuffix()) return;
  if (owner === undefined && isDefaultHiveHome()) return;
  const reason =
    owner === undefined
      ? "ownerless legacy branch outside the default Hive instance"
      : "branch owned by another Hive instance";
  throw new Error(`refusing to modify ${reason}: ${branch}`);
}

export async function clearBranchOwnership(
  repoRoot: string,
  branch: string,
): Promise<void> {
  await markBranchOwned(repoRoot, branch, false);
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

async function reconcilePreservedRefs(
  repoRoot: string,
  mainBranch: string,
): Promise<PreservedRefReconciliation> {
  const result = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/hive-preserved",
  ]);
  assertGitSuccess(result, "for-each-ref");
  const report: PreservedRefReconciliation = { removed: [], kept: [] };
  for (const line of result.stdout.split("\n")) {
    const [ref, tip] = line.trim().split(" ");
    if (
      ref === undefined ||
      tip === undefined ||
      !ref.startsWith("refs/hive-preserved/")
    ) {
      continue;
    }
    const branch = ref.slice("refs/hive-preserved/".length);
    const countResult = await runGit(repoRoot, [
      "rev-list",
      "--count",
      `${mainBranch}..${tip}`,
    ]);
    assertGitSuccess(countResult, "rev-list");
    const unmergedCommits = Number(countResult.stdout.trim());
    if (!Number.isSafeInteger(unmergedCommits) || unmergedCommits < 0) {
      throw new Error("git rev-list failed: invalid preserved-ref count");
    }
    if (unmergedCommits > 0) {
      report.kept.push({ branch, tip, unmergedCommits });
      continue;
    }
    // Compare-and-delete: a concurrent preservation update must not be erased
    // because the tip measured above happened to be merged.
    const remove = await runGit(repoRoot, ["update-ref", "-d", ref, tip]);
    assertGitSuccess(remove, "update-ref");
    report.removed.push({ branch, tip });
  }
  return report;
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

/** Remove one proven registration. Global `git worktree prune` can also erase
 * a sibling instance's temporarily unavailable worktree. */
async function removeMissingWorktreeRegistration(
  repoRoot: string,
  worktreePath: string,
): Promise<boolean> {
  const commonDirResult = await runGit(repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  assertGitSuccess(commonDirResult, "rev-parse --git-common-dir");
  const commonDirValue = commonDirResult.stdout.trim();
  const commonDir = isAbsolute(commonDirValue)
    ? commonDirValue
    : resolve(repoRoot, commonDirValue);
  const registrationsDir = join(commonDir, "worktrees");
  const entries = await readdir(registrationsDir, {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (isMissingFileError(error)) return [];
    throw error;
  });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const registration = join(registrationsDir, entry.name);
    const gitdir = await readFile(join(registration, "gitdir"), "utf8").catch(
      (error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      },
    );
    if (gitdir === null) continue;
    const gitFile = gitdir.trim();
    const linkedGitFile = isAbsolute(gitFile)
      ? gitFile
      : resolve(registration, gitFile);
    if (
      (await canonicalizePotentialPath(dirname(linkedGitFile))) === worktreePath
    ) {
      matches.push(registration);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple git registrations point at worktree: ${worktreePath}`,
    );
  }
  const registration = matches[0];
  if (registration === undefined) return false;
  const locked = await readFile(join(registration, "locked"), "utf8")
    .then(() => true)
    .catch((error: unknown) => {
      if (isMissingFileError(error)) return false;
      throw error;
    });
  if (locked) {
    throw new Error(
      `refusing to remove locked worktree registration: ${worktreePath}`,
    );
  }
  await rm(registration, { recursive: true, force: true });
  const remains: string[] = await readdir(registrationsDir).catch(
    (error: unknown) => {
      if (isMissingFileError(error)) return [];
      throw error;
    },
  );
  if (remains.includes(basename(registration))) {
    throw new Error(
      `git worktree registration still exists after removal: ${worktreePath}`,
    );
  }
  return true;
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
    const pathTaken = (await listWorktrees(repoRoot).catch(() => [])).some(
      (worktree) => worktree.path === resolve(path),
    );
    if (branchTaken || pathTaken) {
      throw new WorktreeNameCollisionError(
        `Agent name ${agentName} is already claimed in ${repoRoot}`,
      );
    }
  }
  assertGitSuccess(result, "worktree add");
  await markBranchOwned(repoRoot, branch, true);

  const createdPath = await realpath(path);
  const created = (await listWorktrees(repoRoot)).find(
    (worktree) => worktree.path === createdPath,
  );
  if (
    created?.branch !== branch ||
    (await branchOwner(repoRoot, branch)) !== hiveInstanceSuffix()
  ) {
    throw new Error(
      `git worktree add did not create the requested owned worktree: ${path}`,
    );
  }

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
  await assertBranchMutationAllowed(repoRoot, branch);
  if (await branchExists(repoRoot, branch)) {
    const result = await runGit(repoRoot, ["branch", "-D", branch]);
    assertGitSuccess(result, "branch delete");
    if (await branchExists(repoRoot, branch)) {
      throw new Error(
        `git branch delete succeeded but the branch still exists: ${branch}`,
      );
    }
  }
  await markBranchOwned(repoRoot, branch, false);
  if ((await branchOwner(repoRoot, branch)) === hiveInstanceSuffix()) {
    throw new Error(
      `git update-ref succeeded but branch ownership still exists: ${branch}`,
    );
  }
}

export async function unavailableAgentNames(
  repoRoot: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  const worktreesDir = join(repoRoot, ".hive", "worktrees");
  const [worktrees, branchResult, diskEntries] = await Promise.all([
    listWorktrees(repoRoot),
    runGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/hive",
    ]),
    readdir(worktreesDir).catch((error: unknown) => {
      if (isMissingFileError(error)) return [] as string[];
      throw error;
    }),
  ]);
  const marker = `${join(".hive", "worktrees")}/`;
  const worktreeNames = new Set(
    worktrees
      .filter((worktree) => worktree.path.includes(marker))
      .map((worktree) => basename(worktree.path)),
  );
  const branches =
    branchResult.exitCode === 0 ? branchResult.stdout.split("\n") : [];
  return new Set(
    candidates.filter(
      (name) =>
        diskEntries.includes(name) ||
        worktreeNames.has(name) ||
        branches.some((branch) => branch.startsWith(`hive/${name}-`)),
    ),
  );
}

async function branchExists(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const result = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.exitCode === 0;
}

/**
 * Exact Hive-owned wiring paths: every file Hive's own `write*AgentConfig`
 * writers put into a worktree. They are excluded from stranded-work checks —
 * Hive's wiring is not the agent's work, and must never make an idle agent look
 * like it holds something worth preserving.
 *
 * Directory patterns are forbidden because an exclusion can authorize worktree
 * deletion; any other file under `.grok/` or `.kimi-code/` must remain visible
 * as agent work.
 */
const HIVE_WORKTREE_CONFIG: readonly string[] = [
  ".claude/settings.local.json",
  ".claude/hive-graphify-hook.sh",
  ".mcp.json",
  ".codex/config.toml",
  ".codex/hive-notify.sh",
  ".codex/hive-graphify-hook.sh",
  ".grok/config.toml",
  ".kimi-code/mcp.json",
  ".kimi-code/AGENTS.md",
  "opencode.json",
];

/**
 * The shipped `SKILL.md` files `provisionSkills` lays down at every spawn, one
 * exact path per skill per vendor — derived from the same two functions that
 * choose the write destinations, so the two cannot drift apart.
 *
 * The *user's* own skills, symlinked in from `~/.hive/skills` and
 * `<repo>/.hive/skills` under the same parents, are covered too — but by
 * `isStagedSkillLink` below rather than this constant, because their names are
 * whatever the user wrote. They were once described as permanently unsweepable
 * for that reason; they are not. Hive knows which links it created, so the
 * exact paths are derivable from the same sources the staging reads.
 */
const HIVE_WORKTREE_SKILLS: readonly string[] = CAPABILITY_PROVIDERS.flatMap(
  (provider) =>
    shippedSkillsFor(provider).map((skill) =>
      join(nativeSkillDirectory(provider), skill.name, "SKILL.md"),
    ),
);

const HIVE_WORKTREE_WIRING: readonly string[] = [
  ...new Set([...HIVE_WORKTREE_CONFIG, ...HIVE_WORKTREE_SKILLS]),
];

/**
 * One of the symlinks `provisionSkills` staged, still pointing where Hive
 * pointed it. Both halves are required: a path Hive would have staged is not
 * Hive's unless the thing at that path is that link, so an agent's own
 * directory or file of the same name stays visible as work.
 */
const isStagedSkillLink = async (
  path: string,
  worktreePath: string,
  skillLinks: Map<string, string>,
): Promise<boolean> => {
  const source = skillLinks.get(path);
  if (source === undefined) return false;
  const absolute = join(worktreePath, path);
  const target = await readlink(absolute).catch(() => null);
  return target !== null && resolve(dirname(absolute), target) === source;
};

const isHiveWorktreeWiring = async (
  path: string,
  worktreePath: string | null,
  skillLinks: Map<string, string>,
): Promise<boolean> => {
  if (HIVE_WORKTREE_WIRING.includes(path)) return true;
  if (
    worktreePath !== null &&
    (await isStagedSkillLink(path, worktreePath, skillLinks))
  ) {
    return true;
  }
  if (
    worktreePath === null ||
    path !== join(".grok", "hooks", grokHookFilename())
  ) {
    return false;
  }
  const source = await readFile(join(worktreePath, path), "utf8").catch(
    () => null,
  );
  return source !== null && ownsGrokHook(source);
};

/** Commits reachable from `revision` but not from the main branch. Throws
 * rather than returning 0 when git cannot answer, so a caller that deletes on
 * zero cannot be told "nothing here" by a failed measurement. */
async function countCommitsNotOnMain(
  repoRoot: string,
  mainBranch: string,
  revision: string,
): Promise<number> {
  const result = await runGit(repoRoot, [
    "rev-list",
    "--count",
    `${mainBranch}..${revision}`,
  ]);
  assertGitSuccess(result, "rev-list");
  const count = result.stdout.trim();
  if (!/^[0-9]+$/.test(count)) {
    throw new Error(`git rev-list failed: invalid count "${count}"`);
  }
  const parsed = Number(count);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("git rev-list failed: count exceeds safe integer range");
  }
  return parsed;
}

export async function assessStrandedWork(
  repoRoot: string,
  worktreePath: string | null,
  branch: string | null,
  mainBranch = "main",
): Promise<StrandedWork> {
  const dirtyFiles: string[] = [];
  const skillLinks = await stagedSkillLinks(repoRoot);
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
      const candidates = statusResult.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.slice(3));
      for (const path of candidates) {
        if (!(await isHiveWorktreeWiring(path, worktreePath, skillLinks))) {
          dirtyFiles.push(path);
        }
      }
    }
    // A missing or already-pruned worktree has no dirty files by definition;
    // any commits it made still show up in the unmerged count below.
  }

  // Commits are counted against a REVISION, not a branch name. A detached
  // worktree has no branch, and `git rebase` is exactly what leaves a worktree
  // detached — the landing protocol tells every agent to run `git rebase main`,
  // so an agent interrupted mid-rebase is the ordinary case, not an exotic one.
  // Keying this off `branch` alone left `unmergedCommits` at 0 unconditionally
  // for those worktrees, so the sweep's unmerged guard could not fire and it
  // deleted the commits. A revision that cannot be resolved or counted THROWS,
  // which the reconciler already treats as keep-and-report ("assessment-failed")
  // — undeterminable state must never read as "nothing here".
  let unmergedCommits = 0;
  if (branch !== null && (await branchExists(repoRoot, branch))) {
    unmergedCommits = await countCommitsNotOnMain(repoRoot, mainBranch, branch);
  } else if (branch === null && worktreePath !== null) {
    const headResult = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    assertGitSuccess(headResult, "rev-parse HEAD");
    unmergedCommits = await countCommitsNotOnMain(
      repoRoot,
      mainBranch,
      headResult.stdout.trim(),
    );
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

export async function reconcileOrphanedWorktrees(
  repoRoot: string,
  agents: readonly AgentRecord[],
  mainBranch = "main",
  operations: {
    assess?: typeof assessStrandedWork;
    remove?: typeof removeWorktree;
  } = {},
): Promise<WorktreeReconciliationReport> {
  const assess = operations.assess ?? assessStrandedWork;
  const remove = operations.remove ?? removeWorktree;
  const worktreesRoot = resolve(repoRoot, ".hive", "worktrees");
  const registered = (await listWorktrees(repoRoot)).filter(
    (worktree) => dirname(resolve(worktree.path)) === worktreesRoot,
  );
  const outcomes: WorktreeReconciliationOutcome[] = [];
  const registeredPaths = new Set(
    registered.map((worktree) => resolve(worktree.path)),
  );

  for (const worktree of registered) {
    const path = resolve(worktree.path);
    const agent = agents.find(
      (candidate) =>
        (candidate.worktreePath !== null &&
          resolve(candidate.worktreePath) === path) ||
        (worktree.branch !== null && candidate.branch === worktree.branch),
    );
    const base = {
      path,
      branch: worktree.branch,
      dirtyFiles: [] as string[],
      unmergedCommits: 0,
    };
    if (agent !== undefined && isLiveAgent(agent)) {
      outcomes.push({ ...base, action: "kept", rule: "live-agent" });
      continue;
    }
    if (
      agent !== undefined &&
      agent.failureReason !== undefined &&
      agent.failureReason.trim() !== ""
    ) {
      outcomes.push({ ...base, action: "kept", rule: "preserved-agent" });
      continue;
    }
    if (worktree.branch !== null) {
      const owner = await branchOwner(repoRoot, worktree.branch);
      if (owner !== undefined && owner !== hiveInstanceSuffix()) {
        outcomes.push({ ...base, action: "kept", rule: "foreign-instance" });
        continue;
      }
    }

    let stranded: StrandedWork;
    try {
      stranded = await assess(repoRoot, path, worktree.branch, mainBranch);
    } catch (error) {
      outcomes.push({
        ...base,
        action: "kept",
        rule: "assessment-failed",
        note: error instanceof Error ? error.message : "unknown error",
      });
      continue;
    }
    if (stranded.dirtyFiles.length > 0 || stranded.unmergedCommits > 0) {
      outcomes.push({
        ...base,
        ...stranded,
        action: "kept",
        rule: "stranded-work",
      });
      continue;
    }
    try {
      await remove(repoRoot, path, {
        deleteBranch: true,
        ...(worktree.branch === null ? {} : { branch: worktree.branch }),
      });
      outcomes.push({
        ...base,
        action: "removed",
        rule: "clean-orphan",
      });
    } catch (error) {
      outcomes.push({
        ...base,
        action: "kept",
        rule: "cleanup-failed",
        note: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  const entries = await readdir(worktreesRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isMissingFileError(error)) return [];
      throw error;
    },
  );
  for (const entry of entries) {
    const path = resolve(worktreesRoot, entry.name);
    if (registeredPaths.has(path)) continue;
    const agent = agents.find(
      (candidate) =>
        candidate.worktreePath !== null &&
        resolve(candidate.worktreePath) === path,
    );
    outcomes.push({
      path,
      branch: agent?.branch ?? null,
      action: "kept",
      rule:
        agent !== undefined && isLiveAgent(agent)
          ? "live-agent"
          : agent?.failureReason !== undefined &&
              agent.failureReason.trim() !== ""
            ? "preserved-agent"
            : "unregistered-path",
      dirtyFiles: [],
      unmergedCommits: 0,
    });
  }

  return {
    worktrees: outcomes,
    preservedRefs: await reconcilePreservedRefs(repoRoot, mainBranch),
  };
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
    await assertBranchMutationAllowed(repoRoot, staleWorktree?.branch ?? null);
    await assertBranchMutationAllowed(
      repoRoot,
      normalizedOptions.branch ?? null,
    );
    const removedRegistration = await removeMissingWorktreeRegistration(
      repoRoot,
      requestedPath,
    );
    if (staleWorktree !== undefined && !removedRegistration) {
      throw new Error(
        `could not find git metadata for missing worktree: ${requestedPath}`,
      );
    }
    if (
      (await listWorktrees(repoRoot)).some(
        (candidate) => candidate.path === requestedPath,
      )
    ) {
      throw new Error(
        `git worktree registration still exists after removal: ${requestedPath}`,
      );
    }

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
  await assertBranchMutationAllowed(repoRoot, worktree?.branch ?? null);
  await assertBranchMutationAllowed(repoRoot, branch);

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
  if (
    (await listWorktrees(repoRoot)).some(
      (candidate) =>
        candidate.path === canonicalPath || candidate.path === requestedPath,
    )
  ) {
    throw new Error(
      `git worktree remove succeeded but the worktree still exists: ${canonicalPath}`,
    );
  }

  if (shouldDeleteBranch) {
    await deleteBranch(repoRoot, branch);
  }
}
