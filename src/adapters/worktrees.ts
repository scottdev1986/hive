import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hiveInstanceSuffix, isDefaultHiveHome } from "../hive-home/home";
import { type AgentRecord, isLiveAgent } from "../schemas/agent";
import { CAPABILITY_PROVIDERS } from "../schemas/provider";
import { SHIPPED_SKILLS } from "../skills/shipped";
import { definedFields } from "../shared/defined-fields";
import { withFileLock } from "./file-lock";
import { type GitResult, runGit as runGitCommand } from "./git";
import { type ProcessLiveness, probeProcessLiveness } from "./process-liveness";
import { ownsGrokHook } from "./providers/grok-cli";
import {
  OPENCODE_GRAPHIFY_PLUGIN_PATH,
  OPENCODE_TURN_PLUGIN_PATH,
} from "./providers/opencode-cli";
import {
  nativeSkillDirectory,
  provisionedSkillLinks,
  SKILL_LINK_MANIFEST,
} from "./skills";
import {
  agentRowOwnershipLiveness,
  type OwnershipLiveness,
  probeWorktreeOwnerProcessLiveness,
} from "./worktree-owner-liveness";

// Worktree maintenance has always killed a deadline-hung git with SIGKILL; the
// canonical runner's SIGTERM default exists for the landing path, where git's
// own lock-file cleanup must still run.
const runGit = (
  repoRoot: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> =>
  runGitCommand(repoRoot, args, {
    killSignal: "SIGKILL",
    ...definedFields({ env: options.env }),
  });

export const WORKTREE_SETTLING_INTERVAL_MS = 30_000;

export interface Worktree {
  path: string;
  branch: string | null;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

interface RemoveWorktreeOptions {
  discardTracked?: boolean;
  /** The caller-owned branch identity. A removed worktree registration cannot recover it reliably. */
  branch?: string;
  /** A destructive decision revalidates the measured ownership verdict instead of requiring automatic ownership proof. */
  branchOwnership?: "required" | "decision-bound";
}

/** A one-use capability with no inspectable fields. Only the settlement service receives an issuer. */
export interface SettlementMutationAuthority {
  readonly __settlementMutationAuthority: unique symbol;
}

export type SettlementMutationResult =
  | { readonly kind: "worktree-released"; readonly path: string | null }
  | { readonly kind: "refs-released"; readonly refs: readonly string[] }
  | { readonly kind: "branch-reset"; readonly branch: string }
  | { readonly kind: "bundle-discarded"; readonly decisionId: string };

/**
 * The branch a settlement mutation is authorized to delete, carried as one value so a name
 * can never arrive without the oid that proves the branch has not moved since it was measured.
 */
export interface SettlementBranchTarget {
  readonly name: string;
  readonly oid: string;
}

/**
 * Pairs a branch name with the oid a proof measured for it.
 *
 * Null means there is no branch left to delete, and it is a measured result rather than a gap:
 * a proof that cannot read the ref fails instead of reporting a null oid. Every mutation builds
 * its target through here, so no caller can hand the mutator a name whose oid it must guess at.
 */
export function settlementBranchTarget(
  branch: string | null,
  measuredOid: string | null,
): SettlementBranchTarget | null {
  return branch === null || measuredOid === null
    ? null
    : { name: branch, oid: measuredOid };
}

type SettlementMutation =
  | {
      readonly kind: "release-worktree";
      readonly repoRoot: string;
      /** Null when the proof found nothing to remove: a case that never held a worktree, or one whose registration and directory are both already gone. The branch below is then all that is left to release. */
      readonly worktreePath: string | null;
      readonly branch: SettlementBranchTarget | null;
      readonly expectedDigest: string;
      readonly revalidate: () => Promise<string>;
    }
  | {
      readonly kind: "release-refs";
      readonly repoRoot: string;
      readonly refs: ReadonlyArray<{ ref: string; oid: string }>;
      readonly expectedDigest: string;
      readonly revalidate: () => Promise<string>;
    }
  | {
      readonly kind: "reset-branch";
      readonly repoRoot: string;
      readonly branch: string;
      readonly sourceOid: string;
      readonly targetOid: string;
      readonly expectedDigest: string;
      readonly revalidate: () => Promise<string>;
    }
  | {
      readonly kind: "discard-bundle";
      readonly decisionId: string;
      readonly repoRoot: string;
      readonly worktreePath: string | null;
      readonly branch: SettlementBranchTarget | null;
      readonly refs: ReadonlyArray<{ ref: string; oid: string }>;
      readonly expectedDigest: string;
      readonly revalidate: () => Promise<string>;
    };

export interface SettlementMutationIssuer {
  issue(input: SettlementMutation): SettlementMutationAuthority;
}

export interface WorktreeSettlementMutator {
  apply(
    authority: SettlementMutationAuthority,
  ): Promise<SettlementMutationResult>;
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
      // This runs inside a live agent's worktree on every status query, in parallel across all agents; taking the index.lock here collides with the agent's own git commands.
      "--no-optional-locks",
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
  const skillLinks =
    worktreePath === null
      ? new Map<string, string>()
      : await provisionedSkillLinks(worktreePath);
  for (const path of paths) {
    if (!(await isHiveWorktreeWiring(path, worktreePath, skillLinks))) {
      observed.push(path);
    }
  }
  return observed.sort();
}

export interface SettlementBranch {
  branch: string;
  tip: string;
  unmergedCommits: number;
  preserved?: boolean;
  ownerInstanceId?: string;
}

export interface WorktreeReconciliationOutcome {
  path: string;
  branch: string | null;
  action: "kept" | "eligible" | "released";
  rule:
    | "settling"
    | "live-agent"
    | "preserved-agent"
    | "stranded-work"
    | "assessment-failed"
    | "foreign-instance"
    | "unregistered-path"
    | "clean-orphan"
    // A terminal agent row owned this worktree, its assignment forbade writing
    // (readOnly), and it correctly wrote nothing. Distinct from
    // "nothing-to-preserve" because a read-only agent's empty worktree is
    // routine, not a signal anything went wrong.
    | "expected-no-work"
    | "confirmed-merged"
    | "patch-equivalent"
    // A terminal agent row owned this worktree, was NOT read-only, and the
    // worktree was clean with zero patch-distinct commits. This is exactly
    // what the removal predicate measures and nothing more: it does not mean
    // the agent's work landed, only that there is nothing left to preserve.
    // The same state also arises for an agent that died before writing a
    // line, which is why this must never be worded as a successful merge.
    | "nothing-to-preserve";
  dirtyFiles: string[];
  unmergedCommits: number;
  note?: string;
  landing?: {
    commit: string;
    at: string;
  };
}

async function verifiedLanding(
  repoRoot: string,
  targetBranch: string,
  agent: AgentRecord | undefined,
): Promise<WorktreeReconciliationOutcome["rule"] | null> {
  if (agent?.landedCommit === undefined || agent.landedAt === undefined) {
    return null;
  }
  const exact = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    agent.landedCommit,
    targetBranch,
  ]);
  if (exact.exitCode === 0) return "confirmed-merged";
  if (exact.exitCode !== 1) return null;
  const cherry = await runGit(repoRoot, [
    "cherry",
    targetBranch,
    agent.landedCommit,
  ]);
  if (cherry.exitCode !== 0) return null;
  const lines = cherry.stdout.split("\n").filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => line.startsWith("- "))
    ? "patch-equivalent"
    : null;
}

/**
 * Classification of preserved refs for the reconciler. "releasable" means fully
 * merged into main and therefore safe for an explicit stewardship release —
 * the sweep never deletes either class.
 */
export interface PreservedRefReconciliation {
  releasable: Array<{ branch: string; tip: string }>;
  kept: Array<{ branch: string; tip: string; unmergedCommits: number }>;
}

export interface WorktreeReconciliationReport {
  worktrees: WorktreeReconciliationOutcome[];
  preservedRefs: PreservedRefReconciliation;
}

/** Durable git-adjacent metadata for a preserved or salvage ref. Survives a lost agent row. */
export interface StewardshipMeta {
  kind: "preserved" | "salvage" | "observed";
  agentName: string | null;
  /** ISO timestamp when Hive preserved the work. Null when the ref predates metadata. */
  preservedAt: string | null;
  /** One-time observation time for pre-existing refs that never recorded preservedAt. */
  observedAt?: string;
  /** Explicit keep decision; does not change the ref tip. */
  keptAt?: string;
}

export interface StewardshipRef {
  kind: "preserved" | "salvage";
  branch: string;
  ref: string;
  tip: string;
  agentName: string | null;
  preservedAt: string | null;
  observedAt: string | null;
  keptAt: string | null;
  unmergedCommits: number;
  dirtyFileSummary: string[];
}

export interface SalvageCaptureMeta {
  agentName: string;
  preservedAt: string;
}

export class WorktreeNameCollisionError extends Error {}

const preservedRef = (branch: string): string =>
  `refs/hive-preserved/${branch}`;

const salvageRef = (branch: string): string => `refs/hive-salvage/${branch}`;

const stewardshipMetaRef = (
  kind: "preserved" | "salvage",
  branch: string,
): string => `refs/hive-meta/${kind}/${branch}`;

const ownerRef = (branch: string, instanceId = hiveInstanceSuffix()): string =>
  `refs/hive-owner/${instanceId}/${branch}`;

async function listRefsWithPositiveControl(
  repoRoot: string,
  prefixes: readonly string[],
): Promise<Array<{ ref: string; oid: string }>> {
  const result = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    ...prefixes,
    "refs/heads",
  ]);
  assertGitSuccess(result, "for-each-ref");
  const refs = result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [oid, ref, extra] = line.split(" ");
      if (
        oid === undefined ||
        ref === undefined ||
        extra !== undefined ||
        !/^[0-9a-f]{40,64}$/.test(oid) ||
        !ref.startsWith("refs/")
      ) {
        throw new Error("for-each-ref returned an unsupported record");
      }
      return { ref, oid };
    });
  if (!refs.some(({ ref }) => ref.startsWith("refs/heads/"))) {
    throw new Error("for-each-ref positive control did not observe a branch");
  }
  return refs.filter(({ ref }) =>
    prefixes.some((prefix) => {
      const namespace = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      return ref === namespace || ref.startsWith(`${namespace}/`);
    }),
  );
}

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
  const refs = await listRefsWithPositiveControl(repoRoot, ["refs/hive-owner"]);
  const suffix = `/${branch}`;
  const owners: string[] = [];
  for (const { ref } of refs) {
    if (!ref.endsWith(suffix)) continue;
    const owner = ref.slice("refs/hive-owner/".length, -suffix.length);
    if (owner !== "") owners.push(owner);
  }
  if (owners.length > 1) {
    throw new Error(`Branch ${branch} has multiple Hive instance owners`);
  }
  return owners[0];
}

/** Refuse to touch a branch this Hive did not create. Several Hive instances can share one repository, and branch deletion is not recoverable, so the owner ref is checked before every mutation rather than trusted from the caller. The ownerless case is the interesting one. Branches predating owner refs carry no marking at all, and there is no way to tell them from another instance's. The default instance adopts them — it is the one that would have made them — and every other instance leaves them alone. A non-default instance therefore cannot clean up unmarked branches. The cost is manual cleanup; the alternative is one instance deleting another's unlanded work. */
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

/** Inventory this instance's owner refs whose guarded branch no longer exists. */
export async function listStaleOwnerRefs(
  repoRoot: string,
  instanceId = hiveInstanceSuffix(),
): Promise<{
  stale: Array<{ ref: string; oid: string }>;
  kept: Array<{ ref: string; oid: string }>;
}> {
  const prefix = `refs/hive-owner/${instanceId}/`;
  const refs = await listRefsWithPositiveControl(repoRoot, [prefix]);
  const stale: Array<{ ref: string; oid: string }> = [];
  const kept: Array<{ ref: string; oid: string }> = [];
  for (const entry of refs) {
    const { ref } = entry;
    if (!ref.startsWith(prefix)) continue;
    const branch = ref.slice(prefix.length);
    if (branch === "") continue;
    if (await branchExists(repoRoot, branch)) {
      kept.push(entry);
      continue;
    }
    stale.push(entry);
  }
  return { stale, kept };
}

export async function markBranchPreserved(
  repoRoot: string,
  branch: string,
  meta?: { agentName?: string; preservedAt?: string },
): Promise<void> {
  assertName(branch.replaceAll("/", "-"), "branch");
  const result = await runGit(repoRoot, [
    "update-ref",
    preservedRef(branch),
    branch,
  ]);
  assertGitSuccess(result, "update-ref");
  await writeStewardshipMeta(repoRoot, "preserved", branch, {
    kind: "preserved",
    agentName: meta?.agentName ?? null,
    preservedAt: meta?.preservedAt ?? new Date().toISOString(),
  });
}

/**
 * Capture uncommitted WIP (tracked and untracked) onto refs/hive-salvage/<branch>
 * using an alternate index so the live worktree and index stay byte-identical.
 * Returns null when there is nothing dirty to capture.
 */
export async function captureWipSalvage(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  meta: SalvageCaptureMeta,
): Promise<{ ref: string; tip: string } | null> {
  assertName(branch.replaceAll("/", "-"), "branch");
  if (!existsSync(worktreePath)) return null;
  const status = await runGit(worktreePath, [
    "--no-optional-locks",
    "status",
    "--porcelain",
    "-uall",
  ]);
  assertGitSuccess(status, "status");
  if (status.stdout.trim() === "") return null;

  const indexFile = join(tmpdir(), `hive-salvage-${randomUUID()}.index`);
  const altEnv = { GIT_INDEX_FILE: indexFile };
  try {
    const readTree = await runGit(worktreePath, ["read-tree", "HEAD"], {
      env: altEnv,
    });
    assertGitSuccess(readTree, "read-tree");
    // Stage every tracked change and untracked path into the alternate index
    // only — never the worktree's real index.
    const add = await runGit(worktreePath, ["add", "-A", "--", "."], {
      env: altEnv,
    });
    assertGitSuccess(add, "add");
    const treeResult = await runGit(worktreePath, ["write-tree"], {
      env: altEnv,
    });
    assertGitSuccess(treeResult, "write-tree");
    const tree = treeResult.stdout.trim();
    const headResult = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    assertGitSuccess(headResult, "rev-parse HEAD");
    const head = headResult.stdout.trim();
    const message = JSON.stringify({
      kind: "hive-salvage",
      branch,
      agentName: meta.agentName,
      preservedAt: meta.preservedAt,
    });
    const commitResult = await runGit(repoRoot, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      message,
    ]);
    assertGitSuccess(commitResult, "commit-tree");
    const tip = commitResult.stdout.trim();
    const ref = salvageRef(branch);
    const updated = await runGit(repoRoot, ["update-ref", ref, tip]);
    assertGitSuccess(updated, "update-ref");
    await writeStewardshipMeta(repoRoot, "salvage", branch, {
      kind: "salvage",
      agentName: meta.agentName,
      preservedAt: meta.preservedAt,
    });
    return { ref, tip };
  } finally {
    await rm(indexFile, { force: true });
  }
}

/** List every preserved and salvage ref with durable metadata. Row-independent. */
export async function listStewardshipRefs(
  repoRoot: string,
  mainBranch = "main",
  options: { now?: () => number } = {},
): Promise<StewardshipRef[]> {
  const nowIso = new Date(options.now?.() ?? Date.now()).toISOString();
  const entries: StewardshipRef[] = [];
  for (const kind of ["preserved", "salvage"] as const) {
    const prefix =
      kind === "preserved" ? "refs/hive-preserved" : "refs/hive-salvage";
    const refs = await listRefsWithPositiveControl(repoRoot, [prefix]);
    for (const { ref, oid: tip } of refs) {
      if (!ref.startsWith(`${prefix}/`)) continue;
      const branch = ref.slice(`${prefix}/`.length);
      if (branch === "") continue;
      let meta = await readStewardshipMeta(repoRoot, kind, branch);
      if (meta === null) {
        // Pre-existing residue: never invent a historical preservedAt. Record a
        // one-time observation so later lists stay stable without pretending
        // we know when the ref was created.
        meta = {
          kind: "observed",
          agentName: null,
          preservedAt: null,
          observedAt: nowIso,
        };
        await writeStewardshipMeta(repoRoot, kind, branch, meta);
      } else if (meta.preservedAt === null && meta.observedAt === undefined) {
        meta = { ...meta, observedAt: nowIso };
        await writeStewardshipMeta(repoRoot, kind, branch, meta);
      }
      const unmergedCommits = await countCommitsNotOnMain(
        repoRoot,
        mainBranch,
        tip,
      );
      const dirtyFileSummary =
        kind === "salvage" ? await salvageDirtySummary(repoRoot, tip) : [];
      entries.push({
        kind,
        branch,
        ref,
        tip,
        agentName: meta.agentName,
        preservedAt: meta.preservedAt,
        observedAt: meta.observedAt ?? null,
        keptAt: meta.keptAt ?? null,
        unmergedCommits,
        dirtyFileSummary,
      });
    }
  }
  return entries.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Record an explicit keep decision without changing the ref tip. */
export async function keepStewardshipRef(
  repoRoot: string,
  ref: string,
  keptAt: string,
): Promise<{ kept: string; tip: string }> {
  const parsed = parseStewardshipRef(ref);
  if (parsed === null) {
    throw new Error(
      `not a hive stewardship ref (expected refs/hive-preserved/* or refs/hive-salvage/*): ${ref}`,
    );
  }
  const tipResult = await runGit(repoRoot, ["show-ref", "--verify", ref]);
  assertGitSuccess(tipResult, "show-ref");
  const tip = tipResult.stdout.trim().split(/\s+/)[0];
  if (tip === undefined || tip === "") {
    throw new Error(`stewardship ref not found: ${ref}`);
  }
  const existing = (await readStewardshipMeta(
    repoRoot,
    parsed.kind,
    parsed.branch,
  )) ?? {
    kind: parsed.kind,
    agentName: null,
    preservedAt: null,
  };
  await writeStewardshipMeta(repoRoot, parsed.kind, parsed.branch, {
    ...existing,
    kind: existing.kind === "observed" ? "observed" : parsed.kind,
    keptAt,
  });
  return { kept: ref, tip };
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

/**
 * Classify preserved refs as fully-merged (releasable by explicit tool call) or
 * still-unmerged. Never deletes: release is stewardship-only via hive_salvage.
 */
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
  const report: PreservedRefReconciliation = { releasable: [], kept: [] };
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
    const unmergedCommits = await countCommitsNotOnMain(
      repoRoot,
      mainBranch,
      tip,
    );
    if (unmergedCommits > 0) {
      report.kept.push({ branch, tip, unmergedCommits });
      continue;
    }
    // Fully merged: eligible for explicit release, but the sweep never deletes.
    report.releasable.push({ branch, tip });
  }
  return report;
}

function parseStewardshipRef(
  ref: string,
): { kind: "preserved" | "salvage"; branch: string } | null {
  if (ref.startsWith("refs/hive-preserved/")) {
    const branch = ref.slice("refs/hive-preserved/".length);
    return branch === "" ? null : { kind: "preserved", branch };
  }
  if (ref.startsWith("refs/hive-salvage/")) {
    const branch = ref.slice("refs/hive-salvage/".length);
    return branch === "" ? null : { kind: "salvage", branch };
  }
  return null;
}

export function stewardshipBundleRefs(ref: string): string[] {
  const parsed = parseStewardshipRef(ref);
  if (parsed === null) {
    throw new Error(`not a hive stewardship ref: ${ref}`);
  }
  return [ref, stewardshipMetaRef(parsed.kind, parsed.branch)];
}

async function writeStewardshipMeta(
  repoRoot: string,
  kind: "preserved" | "salvage",
  branch: string,
  meta: StewardshipMeta,
): Promise<void> {
  const tmp = join(tmpdir(), `hive-meta-${randomUUID()}.json`);
  try {
    await writeFile(tmp, `${JSON.stringify(meta)}\n`, "utf8");
    const hashed = await runGit(repoRoot, ["hash-object", "-w", tmp]);
    assertGitSuccess(hashed, "hash-object");
    const blob = hashed.stdout.trim();
    const updated = await runGit(repoRoot, [
      "update-ref",
      stewardshipMetaRef(kind, branch),
      blob,
    ]);
    assertGitSuccess(updated, "update-ref");
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readStewardshipMeta(
  repoRoot: string,
  kind: "preserved" | "salvage",
  branch: string,
): Promise<StewardshipMeta | null> {
  const ref = stewardshipMetaRef(kind, branch);
  const result = await runGit(repoRoot, ["cat-file", "-p", ref]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as StewardshipMeta;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      kind:
        parsed.kind === "preserved" ||
        parsed.kind === "salvage" ||
        parsed.kind === "observed"
          ? parsed.kind
          : "observed",
      agentName: typeof parsed.agentName === "string" ? parsed.agentName : null,
      preservedAt:
        typeof parsed.preservedAt === "string" ? parsed.preservedAt : null,
      ...definedFields({
        observedAt:
          typeof parsed.observedAt === "string" ? parsed.observedAt : undefined,
        keptAt: typeof parsed.keptAt === "string" ? parsed.keptAt : undefined,
      }),
    };
  } catch {
    return null;
  }
}

async function salvageDirtySummary(
  repoRoot: string,
  tip: string,
): Promise<string[]> {
  // Salvage commits are always parented on the branch tip at capture time.
  const parents = await runGit(repoRoot, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    tip,
  ]);
  if (parents.exitCode !== 0) return [];
  const parts = parents.stdout.trim().split(/\s+/);
  const parent = parts[1];
  if (parent === undefined) {
    // Root commit: list the whole tree.
    const tree = await runGit(repoRoot, ["ls-tree", "-r", "--name-only", tip]);
    if (tree.exitCode !== 0) return [];
    return tree.stdout.split("\n").filter((line) => line !== "");
  }
  const diff = await runGit(repoRoot, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    parent,
    tip,
  ]);
  if (diff.exitCode !== 0) return [];
  return diff.stdout.split("\n").filter((line) => line !== "");
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

/** The canonical form of a path that may not exist yet: resolve the deepest ancestor that does, then re-attach the missing tail. `realpath` fails outright on a missing path, but the comparison this feeds — matching a git registration against a worktree location — has to work for a worktree whose directory is already gone. Resolving only the surviving part is enough, because it is the prefix that holds the symlinks: on macOS `/tmp` is a link to `/private/tmp`, so two spellings of the same worktree compare unequal unless one side is canonicalised. */
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

/** Remove one proven registration. Global `git worktree prune` can also erase a sibling instance's temporarily unavailable worktree. */
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

  const { branch, path } = plannedWorktree(repoRoot, agentName, safeTaskSlug);
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

export function plannedWorktree(
  repoRoot: string,
  agentName: string,
  taskSlug: string,
): CreatedWorktree {
  assertName(agentName, "agent name");
  const safeTaskSlug = slugify(taskSlug);
  return {
    branch: `hive/${agentName}-${safeTaskSlug}`,
    path: join(repoRoot, ".hive", "worktrees", agentName),
  };
}

/**
 * Whether a branch was minted for this agent's worktree by the name above.
 * Two callers read that name back: name-pool availability, which must not
 * reissue a name whose branches still exist, and settlement attribution, for
 * which the name is the only tie left once an agent's row and its worktree's
 * live checkout have both moved past a branch. The trailing separator is what
 * keeps `sam` from claiming `sammy`'s branches.
 */
export function isWorktreeBranchFor(
  agentName: string,
  branch: string,
): boolean {
  return branch.startsWith(`hive/${agentName}-`);
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

export async function unavailableAgentNames(
  repoRoot: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  const worktreesDir = join(repoRoot, ".hive", "worktrees");
  const [worktrees, branchRefs, diskEntries] = await Promise.all([
    listWorktrees(repoRoot),
    listRefsWithPositiveControl(repoRoot, ["refs/heads/hive"]),
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
  const branches = branchRefs.map(({ ref }) => ref.slice("refs/heads/".length));
  return new Set(
    candidates.filter(
      (name) =>
        diskEntries.includes(name) ||
        worktreeNames.has(name) ||
        branches.some((branch) => isWorktreeBranchFor(name, branch)),
    ),
  );
}

export async function listHiveBranches(repoRoot: string): Promise<string[]> {
  return (await listRefsWithPositiveControl(repoRoot, ["refs/heads/hive"]))
    .map(({ ref }) => ref.slice("refs/heads/".length))
    .sort();
}

async function branchExists(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  return (await readRefOid(repoRoot, `refs/heads/${branch}`)) !== null;
}

/** Exact Hive-owned wiring paths: every file Hive's own `write*AgentConfig` writers put into a worktree. They are excluded from stranded-work checks — Hive's wiring is not the agent's work, and must never make an idle agent look like it holds something worth preserving. Directory patterns are forbidden because an exclusion can authorize worktree deletion; any other file under `.grok/` or `.kimi-code/` must remain visible as agent work. */
const HIVE_WORKTREE_CONFIG: readonly string[] = [
  ".claude/settings.local.json",
  ".claude/hive-graphify-hook.sh",
  ".claude/hive-graphify-hook.sh.gate",
  ".mcp.json",
  ".codex/config.toml",
  ".codex/hive-notify.sh",
  ".codex/hive-graphify-hook.sh",
  ".grok/config.toml",
  ".grok/hive-graphify-hook.sh",
  ".grok/hive-graphify-hook.sh.gate",
  ".kimi-code/mcp.json",
  ".kimi-code/AGENTS.md",
  ".kimi-code/hive-graphify-hook.sh",
  ".kimi-code/hive-graphify-hook.sh.gate",
  "opencode.json",
  ".opencode/hive-graphify-hook.sh",
  ".opencode/hive-graphify-hook.sh.gate",
  OPENCODE_TURN_PLUGIN_PATH,
  OPENCODE_GRAPHIFY_PLUGIN_PATH,
  SKILL_LINK_MANIFEST,
];

/** The shipped `SKILL.md` files `provisionSkills` lays down at every spawn, one exact path per skill per vendor — derived from the same two functions that choose the write destinations, so the two cannot drift apart. The *user's* own skills, symlinked in from `~/.hive/skills` and `<repo>/.hive/skills` under the same parents, are covered too — but by `isStagedSkillLink` below rather than this constant, because their names are whatever the user wrote. Hive identifies those links through the manifest each worktree records at spawn. The union over every agent audience, not one audience's set: a worktree may have been provisioned for any category, and reconciliation asks "could Hive have put this here", which a category filter would answer wrongly for a worktree spawned under a different one. */
const HIVE_WORKTREE_SKILLS: readonly string[] = CAPABILITY_PROVIDERS.flatMap(
  (provider) =>
    SHIPPED_SKILLS.filter(
      (skill) =>
        skill.tools.includes(provider) && skill.roles.includes("agent"),
    ).map((skill) =>
      join(nativeSkillDirectory(provider), skill.name, "SKILL.md"),
    ),
);

const HIVE_WORKTREE_WIRING: readonly string[] = [
  ...new Set([...HIVE_WORKTREE_CONFIG, ...HIVE_WORKTREE_SKILLS]),
];

/** One of the symlinks `provisionSkills` staged *in this worktree*, still pointing where Hive pointed it. Both halves are required: a path Hive recorded is not Hive's unless the thing at that path is that link, so an agent's own directory or file of the same name stays visible as work. */
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

export const isHiveWorktreeWiring = async (
  path: string,
  worktreePath: string | null,
  knownSkillLinks?: Map<string, string>,
): Promise<boolean> => {
  const skillLinks =
    knownSkillLinks ??
    (worktreePath === null
      ? new Map<string, string>()
      : await provisionedSkillLinks(worktreePath));
  if (HIVE_WORKTREE_WIRING.includes(path)) return true;
  if (
    worktreePath !== null &&
    (await isStagedSkillLink(path, worktreePath, skillLinks))
  ) {
    return true;
  }
  if (
    worktreePath === null ||
    dirname(path) !== join(".grok", "hooks") ||
    !/^hive-[0-9a-f]{12}(?:-[1-9][0-9]*)?\.json$/.test(basename(path))
  ) {
    return false;
  }
  const source = await readFile(join(worktreePath, path), "utf8").catch(
    () => null,
  );
  return source !== null && ownsGrokHook(source);
};

/** Commits on `revision` whose CHANGE is not already on the main branch.
 * Equivalence is by patch id, not by commit id. A cherry-picked commit keeps its
 * change but takes a new sha, so `main..revision` still lists it and a plain count
 * calls a fully-landed branch stranded — forever, since nothing about it will ever change.
 * `--cherry-pick --right-only` over the symmetric difference drops commits with an
 * equivalent on the other side, which is the question actually being asked: is there
 * work here that main does not have? Throws rather than returning 0 when git cannot
 * answer, so a caller that deletes on zero cannot be told "nothing here" by a failed
 * measurement. That is why the output is pattern-matched and not merely passed through
 * `Number`, which turns empty output into a confident 0. */
export async function countCommitsNotOnMain(
  repoRoot: string,
  mainBranch: string,
  revision: string,
): Promise<number> {
  return (await listCommitsNotOnMain(repoRoot, mainBranch, revision)).length;
}

export async function listCommitsNotOnMain(
  repoRoot: string,
  mainBranch: string,
  revision: string,
): Promise<string[]> {
  const result = await runGit(repoRoot, [
    "rev-list",
    "--cherry-pick",
    "--right-only",
    `${mainBranch}...${revision}`,
  ]);
  assertGitSuccess(result, "rev-list");
  const commits = result.stdout
    .split("\n")
    .filter((oid) => oid !== "")
    .sort();
  if (commits.some((oid) => !/^[0-9a-f]{40,64}$/.test(oid))) {
    throw new Error("git rev-list failed: invalid commit oid");
  }
  return commits;
}

export async function assessStrandedWork(
  repoRoot: string,
  worktreePath: string | null,
  branch: string | null,
  mainBranch = "main",
): Promise<StrandedWork> {
  const dirtyFiles: string[] = [];
  // A missing or already-pruned worktree has no dirty files by definition; any commits it made still show up in the unmerged count below.
  if (worktreePath !== null && existsSync(worktreePath)) {
    const skillLinks = await provisionedSkillLinks(worktreePath);
    const statusResult = await runGit(worktreePath, [
      // The status here can authorize worktree deletion, and the agent may be running its own git in this worktree right now: never take its index.lock, and never let a failed status read as "nothing here".
      "--no-optional-locks",
      "status",
      "--porcelain",
      // Untracked directories are collapsed by default -- git prints "?? .grok/" and never the files inside it -- so a path-level exclusion would never match, and a caller counting entries cannot see what it is actually holding. -uall names every file.
      "-uall",
    ]);
    assertGitSuccess(statusResult, "status");
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

  // Commits are counted against a REVISION, not a branch name. A detached worktree has no branch, and `git rebase` is exactly what leaves a worktree detached — the landing protocol tells every agent to run `git rebase main`, so an agent interrupted mid-rebase is the ordinary case, not an exotic one. Keying this off `branch` alone left `unmergedCommits` at 0 unconditionally for those worktrees, so the sweep's unmerged guard could not fire and it deleted the commits. A revision that cannot be resolved or counted THROWS, which the reconciler already treats as keep-and-report ("assessment-failed") — undeterminable state must never read as "nothing here".
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
 * Every Hive branch settlement is answerable for, with the count of commits main does not already
 * have. This is the one inventory of that work not anchored to the agents table: reaping,
 * recovery, and reconciliation all iterate agent rows, so work whose row is gone — a reset
 * database, a lost row — is invisible to every one of them. Branch refs outlive the database, so
 * re-deriving this list from git each boot is what makes orphaned work findable at all.
 *
 * Membership is every branch and `unmergedCommits` says what landed, because that count is the
 * only definition of "landed" this repo acts on. Selecting with `--no-merged` asked a different
 * question — is this branch an ancestor of main — which a rebased or squashed landing fails
 * forever while carrying no unaccounted work; and the branches that *passed* it were left out of
 * the inventory entirely, so a landed branch got no case and was never released.
 *
 * Ancestry still earns its keep as a fast path, in the one direction where it is sound: an
 * ancestor of main has no commit main is missing, so it needs no walk. Only the rest pay for the
 * patch-id comparison, which keeps this off the daemon's startup path — every branch here costs a
 * git read, and the sweep that runs it gates /health.
 */
export async function listSettlementBranches(
  repoRoot: string,
  mainBranch = "main",
): Promise<SettlementBranch[]> {
  const [result, merged] = await Promise.all([
    runGit(repoRoot, [
      "branch",
      "--list",
      "hive/*",
      "--format=%(refname:short) %(objectname)",
    ]),
    runGit(repoRoot, [
      "branch",
      "--list",
      "hive/*",
      "--merged",
      mainBranch,
      "--format=%(refname:short)",
    ]),
  ]);
  assertGitSuccess(result, "branch --list");
  assertGitSuccess(merged, "branch --merged");
  if ((await readRefOid(repoRoot, `refs/heads/${mainBranch}`)) === null) {
    throw new Error(
      `branch inventory positive control cannot resolve ${mainBranch}`,
    );
  }
  const ancestors = new Set(
    merged.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );

  const named = result.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(
      (parts): parts is [string, string] =>
        parts[0] !== undefined && parts[0] !== "" && parts[1] !== undefined,
    );
  return Promise.all(
    named.map(async ([branch, tip]) => {
      const [unmergedCommits, preserved, ownerInstanceId] = await Promise.all([
        ancestors.has(branch)
          ? 0
          : countCommitsNotOnMain(repoRoot, mainBranch, branch),
        isBranchPreserved(repoRoot, branch),
        branchOwner(repoRoot, branch),
      ]);
      return {
        branch,
        tip,
        unmergedCommits,
        ...definedFields({
          preserved: preserved ? true : undefined,
          ownerInstanceId,
        }),
      };
    }),
  );
}

/** Report the agent worktrees nothing is using any more, and say what happened to every one that was looked at. The ladder below is a sequence of reasons a worktree cannot be released. One that clears all of them is reported for its owner to release; this detector never acts on that decision itself. So the order matters, and each rung is cheaper or more certain than the one after it — a live agent is decided from the record alone, a missing record falls through to a three-valued process probe (never treated as dead on probe failure), a foreign instance from a ref, and only then is git asked to measure what is actually in the worktree. `assessment-failed` keeps as well, because a measurement that threw or could not answer is not a measurement of nothing. Every outcome is reported, kept ones included. A worktree that silently survived and one that was never examined look identical from the outside, and the caller has to be able to tell them apart. */
export async function reconcileOrphanedWorktrees(
  repoRoot: string,
  agents: readonly AgentRecord[],
  mainBranch = "main",
  operations: {
    assess?: typeof assessStrandedWork;
    now?: () => number;
    /** Override the missing-row process probe. Defaults to cwd holders via lsof + probeProcessLiveness. */
    probeOwnerLiveness?: (
      worktreePath: string,
    ) => OwnershipLiveness | Promise<OwnershipLiveness>;
    /** Injected kill(pid,0) probe used by the default cwd holder check. */
    probeProcess?: (pid: number) => ProcessLiveness;
  } = {},
): Promise<WorktreeReconciliationReport> {
  const assess = operations.assess ?? assessStrandedWork;
  const observedAt = operations.now?.() ?? Date.now();
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
    if (await worktreeIsSettling(path, agent, observedAt)) {
      outcomes.push({ ...base, action: "kept", rule: "settling" });
      continue;
    }
    const ownership = await resolveOwnerLiveness(agent, path, operations);
    if (ownership === "live") {
      // Row or process: both are confident live ownership. A missing row with
      // a live cwd holder still reports live-agent so the ladder cannot release.
      outcomes.push({ ...base, action: "kept", rule: "live-agent" });
      continue;
    }
    if (ownership === "unknown") {
      // Unanswerable liveness must not collapse into a release. assessment-failed
      // is the existing keep-with-note rule for failed measurements.
      outcomes.push({
        ...base,
        action: "kept",
        rule: "assessment-failed",
        note:
          agent === undefined
            ? "owner liveness unknown (missing agent row; process probe unanswerable)"
            : "owner liveness unknown",
      });
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
    const landing = await verifiedLanding(repoRoot, mainBranch, agent);
    const landedCommit = agent?.landedCommit;
    const landedAt = agent?.landedAt;
    outcomes.push({
      ...base,
      action: "eligible",
      rule:
        landing ??
        (agent === undefined
          ? "clean-orphan"
          : agent.readOnly
            ? "expected-no-work"
            : "nothing-to-preserve"),
      ...definedFields({
        landing:
          landing === null ||
          landedCommit === undefined ||
          landedAt === undefined
            ? undefined
            : {
                commit: landedCommit,
                at: landedAt,
              },
      }),
    });
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
    if (await worktreeIsSettling(path, agent, observedAt)) {
      outcomes.push({
        path,
        branch: agent?.branch ?? null,
        action: "kept",
        rule: "settling",
        dirtyFiles: [],
        unmergedCommits: 0,
      });
      continue;
    }
    const ownership = await resolveOwnerLiveness(agent, path, operations);
    if (ownership === "live") {
      outcomes.push({
        path,
        branch: agent?.branch ?? null,
        action: "kept",
        rule: "live-agent",
        dirtyFiles: [],
        unmergedCommits: 0,
      });
      continue;
    }
    if (ownership === "unknown") {
      outcomes.push({
        path,
        branch: agent?.branch ?? null,
        action: "kept",
        rule: "assessment-failed",
        dirtyFiles: [],
        unmergedCommits: 0,
        note:
          agent === undefined
            ? "owner liveness unknown (missing agent row; process probe unanswerable)"
            : "owner liveness unknown",
      });
      continue;
    }
    outcomes.push({
      path,
      branch: agent?.branch ?? null,
      action: "kept",
      rule: "unregistered-path",
      dirtyFiles: [],
      unmergedCommits: 0,
    });
  }

  return {
    worktrees: outcomes,
    preservedRefs: await reconcilePreservedRefs(repoRoot, mainBranch),
  };
}

/**
 * Owner liveness for the reconciler ladder.
 * A present non-terminal agent row is live; a terminal row is dead.
 * A missing row is never read as dead from the row alone — that was the defect:
 * make-clean / DB loss left live agents without rows, and the ladder released
 * their clean worktrees. Process evidence (three-valued) may still answer.
 */
async function resolveOwnerLiveness(
  agent: AgentRecord | undefined,
  worktreePath: string,
  operations: {
    probeOwnerLiveness?: (
      worktreePath: string,
    ) => OwnershipLiveness | Promise<OwnershipLiveness>;
    probeProcess?: (pid: number) => ProcessLiveness;
  },
): Promise<OwnershipLiveness> {
  const fromRow = agentRowOwnershipLiveness(agent, isLiveAgent);
  if (fromRow !== "unknown") return fromRow;
  if (operations.probeOwnerLiveness !== undefined) {
    return operations.probeOwnerLiveness(worktreePath);
  }
  return probeWorktreeOwnerProcessLiveness(
    worktreePath,
    operations.probeProcess ?? probeProcessLiveness,
  );
}

async function worktreeIsSettling(
  worktreePath: string,
  agent: AgentRecord | undefined,
  observedAt: number,
): Promise<boolean> {
  const rowCreatedAt =
    agent === undefined ? Number.NaN : Date.parse(agent.createdAt);
  if (
    Number.isFinite(rowCreatedAt) &&
    observedAt - rowCreatedAt < WORKTREE_SETTLING_INTERVAL_MS
  ) {
    return true;
  }
  // An ownerless path has no database timestamp. Directory mtime is its only
  // local age signal; later writes can extend this delay but cannot authorize
  // an early release.
  const directoryMtime = await stat(worktreePath)
    .then((entry) => entry.mtimeMs)
    .catch(() => Number.NaN);
  return (
    Number.isFinite(directoryMtime) &&
    observedAt - directoryMtime < WORKTREE_SETTLING_INTERVAL_MS
  );
}

async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {},
): Promise<void> {
  const discardTracked = options.discardTracked ?? false;
  const branchOwnership = options.branchOwnership ?? "required";
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
    if (branchOwnership === "required") {
      await assertBranchMutationAllowed(
        repoRoot,
        staleWorktree?.branch ?? null,
      );
      await assertBranchMutationAllowed(repoRoot, options.branch ?? null);
    }
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
    return;
  }

  const worktree = worktrees.find(
    (candidate) =>
      candidate.path === canonicalPath || candidate.path === requestedPath,
  );
  const branch = options.branch ?? worktree?.branch ?? null;
  if (branchOwnership === "required") {
    await assertBranchMutationAllowed(repoRoot, worktree?.branch ?? null);
    await assertBranchMutationAllowed(repoRoot, branch);
  }

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
  if (discardTracked) {
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
}

export async function readRefOid(
  repoRoot: string,
  ref: string,
): Promise<string | null> {
  const result = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  ]);
  if (result.exitCode !== 0) {
    if (result.timedOut || result.stderr.trim() !== "") {
      throw new Error(
        `git rev-parse could not verify ${ref}: ${result.stderr.trim() || "timed out"}`,
      );
    }
    return null;
  }
  const oid = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new Error(`git rev-parse failed: invalid oid for ${ref}`);
  }
  return oid;
}

async function compareAndDeleteRef(
  repoRoot: string,
  ref: string,
  expectedOid: string,
): Promise<void> {
  const current = await readRefOid(repoRoot, ref);
  if (current !== expectedOid) {
    throw new Error(`ref changed before settlement mutation: ${ref}`);
  }
  const deleted = await runGit(repoRoot, [
    "update-ref",
    "-d",
    ref,
    expectedOid,
  ]);
  assertGitSuccess(deleted, "update-ref -d");
  if ((await readRefOid(repoRoot, ref)) !== null) {
    throw new Error(`ref still exists after settlement mutation: ${ref}`);
  }
}

async function settlementMutationLockPath(
  mutation: SettlementMutation,
): Promise<string> {
  if (mutation.kind === "release-worktree" && mutation.worktreePath !== null) {
    return `${resolve(mutation.worktreePath)}.hive-settlement.lock`;
  }
  if (mutation.kind === "discard-bundle" && mutation.worktreePath !== null) {
    return `${resolve(mutation.worktreePath)}.hive-settlement.lock`;
  }
  const commonDir = await runGit(mutation.repoRoot, [
    "rev-parse",
    "--git-common-dir",
  ]);
  assertGitSuccess(commonDir, "rev-parse --git-common-dir");
  const path = commonDir.stdout.trim();
  if (path === "") throw new Error("git returned an empty common directory");
  return join(resolve(mutation.repoRoot, path), "hive-settlement.lock");
}

/**
 * Creates the sole product boundary allowed to remove a worktree or work ref.
 *
 * An authority is one-use and bound to a stable-read callback. The mutator
 * repeats that callback immediately before the first destructive command, so
 * callers cannot turn an old clean measurement into a current deletion.
 */
export function createWorktreeSettlementBoundary(): {
  readonly issuer: SettlementMutationIssuer;
  readonly mutator: WorktreeSettlementMutator;
} {
  const issued = new WeakMap<object, SettlementMutation>();
  const issuer: SettlementMutationIssuer = {
    issue(input) {
      const authority = Object.freeze({}) as SettlementMutationAuthority;
      issued.set(authority, input);
      return authority;
    },
  };
  const mutator: WorktreeSettlementMutator = {
    async apply(authority) {
      const mutation = issued.get(authority);
      issued.delete(authority);
      if (mutation === undefined) {
        throw new Error(
          "settlement mutation authority is invalid or already spent",
        );
      }
      const lockPath = await settlementMutationLockPath(mutation);
      return withFileLock(lockPath, async () => {
        const observedDigest = await mutation.revalidate();
        if (observedDigest !== mutation.expectedDigest) {
          throw new Error("settlement proof changed before mutation");
        }
        switch (mutation.kind) {
          case "release-worktree": {
            if (mutation.worktreePath !== null) {
              await removeWorktree(mutation.repoRoot, mutation.worktreePath, {
                discardTracked: true,
                ...definedFields({
                  branch:
                    mutation.branch === null ? undefined : mutation.branch.name,
                }),
              });
            }
            if (mutation.branch !== null) {
              await assertBranchMutationAllowed(
                mutation.repoRoot,
                mutation.branch.name,
              );
              await compareAndDeleteRef(
                mutation.repoRoot,
                `refs/heads/${mutation.branch.name}`,
                mutation.branch.oid,
              );
              await markBranchOwned(
                mutation.repoRoot,
                mutation.branch.name,
                false,
              );
            }
            return {
              kind: "worktree-released",
              path: mutation.worktreePath,
            };
          }
          case "release-refs": {
            for (const { ref, oid } of mutation.refs) {
              await compareAndDeleteRef(mutation.repoRoot, ref, oid);
            }
            return {
              kind: "refs-released",
              refs: mutation.refs.map(({ ref }) => ref),
            };
          }
          case "reset-branch": {
            await assertBranchMutationAllowed(
              mutation.repoRoot,
              mutation.branch,
            );
            const current = await readRefOid(
              mutation.repoRoot,
              `refs/heads/${mutation.branch}`,
            );
            if (current !== mutation.sourceOid) {
              throw new Error(
                `branch changed before settlement reset: ${mutation.branch}`,
              );
            }
            const updated = await runGit(mutation.repoRoot, [
              "update-ref",
              `refs/heads/${mutation.branch}`,
              mutation.targetOid,
              mutation.sourceOid,
            ]);
            assertGitSuccess(updated, "update-ref");
            if (
              (await readRefOid(
                mutation.repoRoot,
                `refs/heads/${mutation.branch}`,
              )) !== mutation.targetOid
            ) {
              throw new Error(
                `branch reset did not read back: ${mutation.branch}`,
              );
            }
            return { kind: "branch-reset", branch: mutation.branch };
          }
          case "discard-bundle": {
            if (mutation.worktreePath !== null) {
              await removeWorktree(mutation.repoRoot, mutation.worktreePath, {
                discardTracked: true,
                branchOwnership: "decision-bound",
                ...definedFields({
                  branch:
                    mutation.branch === null ? undefined : mutation.branch.name,
                }),
              });
            }
            if (mutation.branch !== null) {
              await compareAndDeleteRef(
                mutation.repoRoot,
                `refs/heads/${mutation.branch.name}`,
                mutation.branch.oid,
              );
              await markBranchOwned(
                mutation.repoRoot,
                mutation.branch.name,
                false,
              );
            }
            for (const { ref, oid } of mutation.refs) {
              await compareAndDeleteRef(mutation.repoRoot, ref, oid);
            }
            return {
              kind: "bundle-discarded",
              decisionId: mutation.decisionId,
            };
          }
        }
      });
    },
  };
  return { issuer, mutator };
}
