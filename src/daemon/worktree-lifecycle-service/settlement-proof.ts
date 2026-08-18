import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { runGit } from "../../adapters/git";
import { probeProcessLiveness } from "../../adapters/process-liveness";
import { provisionedSkillLinks } from "../../adapters/skills";
import {
  branchOwner,
  isHiveWorktreeWiring,
  listCommitsNotOnMain,
  listWorktrees,
  readRefOid,
} from "../../adapters/worktrees";
import { hiveInstanceSuffix } from "../../hive-home/home";
import type { AgentRecord } from "../../schemas/agent";
import type { SettlementCase } from "./settlement-case-store";

export type SettlementProcessLiveness = "live" | "dead" | "unknown";

export interface SettlementProofDependencies {
  readonly repoRoot: string;
  readonly processLiveness: (
    agent: AgentRecord,
  ) => Promise<SettlementProcessLiveness>;
}

export interface SettlementSnapshot {
  readonly digest: string;
  readonly targetBranch: string;
  readonly targetRef: string;
  readonly targetOid: string;
  readonly mergeBaseOid: string | null;
  readonly headOid: string | null;
  readonly branchOid: string | null;
  readonly branchOwnerInstanceId: string | null;
  /** The canonical worktree the proof found, or null when nothing is left to remove. */
  readonly worktreePath: string | null;
  readonly residue: readonly string[];
  /**
   * Every path the worktree's own `.gitignore` declares reproducible, named in full. Release
   * destroys these, so the digest carries them: the evidence records what was there before any
   * mutation is authorized, and a proof that cannot list them cannot release.
   */
  readonly regenerable: readonly string[];
  readonly unaccountedCommitOids: readonly string[];
  readonly stewardshipRefs: readonly {
    readonly ref: string;
    readonly oid: string | null;
  }[];
  readonly missing: readonly (
    | "branch"
    | "worktree"
    | "preserved-ref"
    | "salvage-ref"
  )[];
  readonly accountedBy:
    | "unlanded-count"
    | "tree-equality"
    | "landing-receipt"
    /** The worktree and the branch are both provably gone: there is no content left to account for. */
    | "nothing-remains"
    | null;
}

export type SettlementProofResult =
  | { readonly kind: "safe"; readonly snapshot: SettlementSnapshot }
  | {
      readonly kind: "kept";
      readonly reason: string;
      readonly snapshot: SettlementSnapshot | null;
      readonly state:
        | "active"
        | "settling"
        | "needs-integration"
        | "measurement-blocked"
        | "owner-decision";
    };

/** Render the sentence from one target ref and the count measured against that ref. */
export function renderUnaccountedCommitReason(
  targetRef: string,
  unaccountedCommitCount: number,
): string {
  const prefix = "refs/heads/";
  const target = targetRef.startsWith(prefix)
    ? targetRef.slice(prefix.length)
    : targetRef;
  return `${unaccountedCommitCount} commit(s) are not accounted for on ${target}`;
}

class SettlementInstrumentError extends Error {}

function assertGitSuccess(
  result: Awaited<ReturnType<typeof runGit>>,
  operation: string,
): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`);
  throw new SettlementInstrumentError(`git ${operation} failed: ${detail}`);
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    return parent === path
      ? resolve(path)
      : join(await canonicalizePotentialPath(parent), basename(path));
  }
}

async function oid(repoRoot: string, revision: string): Promise<string> {
  const result = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  assertGitSuccess(result, `rev-parse ${revision}`);
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new SettlementInstrumentError(
      `git rev-parse returned an invalid oid for ${revision}`,
    );
  }
  return value;
}

async function treeOid(repoRoot: string, revision: string): Promise<string> {
  const result = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    `${revision}^{tree}`,
  ]);
  assertGitSuccess(result, `rev-parse ${revision}^{tree}`);
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new SettlementInstrumentError(
      `git rev-parse returned an invalid tree oid for ${revision}`,
    );
  }
  return value;
}

function statusPath(record: string, fields: number): string | null {
  let cursor = 2;
  for (let index = 0; index < fields; index += 1) {
    const next = record.indexOf(" ", cursor);
    if (next === -1) return null;
    cursor = next + 1;
  }
  const path = record.slice(cursor);
  return path === "" ? null : path;
}

interface StatusInventory {
  readonly branchOid: string;
  readonly candidates: readonly string[];
  readonly ignoredMarkers: readonly string[];
}

async function statusInventory(worktreePath: string): Promise<StatusInventory> {
  const status = await runGit(worktreePath, [
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  assertGitSuccess(status, "status --porcelain=v2");
  const records = status.stdout.split("\0");
  let branchOid: string | null = null;
  const candidates: string[] = [];
  const ignoredMarkers: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    if (record.startsWith("# branch.oid ")) {
      if (branchOid !== null) {
        throw new SettlementInstrumentError("status returned branch.oid twice");
      }
      branchOid = record.slice("# branch.oid ".length);
      continue;
    }
    if (record.startsWith("# ")) continue;
    if (record.startsWith("1 ")) {
      const path = statusPath(record, 7);
      if (path === null)
        throw new SettlementInstrumentError("invalid status v2 row");
      candidates.push(path);
      continue;
    }
    if (record.startsWith("2 ")) {
      const path = statusPath(record, 8);
      const source = records[index + 1];
      if (path === null || source === undefined || source === "") {
        throw new SettlementInstrumentError("invalid status v2 rename row");
      }
      candidates.push(path, source);
      index += 1;
      continue;
    }
    if (record.startsWith("u ")) {
      const path = statusPath(record, 9);
      if (path === null)
        throw new SettlementInstrumentError("invalid status v2 row");
      candidates.push(path);
      continue;
    }
    if (record.startsWith("? ")) {
      candidates.push(record.slice(2));
      continue;
    }
    if (record.startsWith("! ")) {
      ignoredMarkers.push(record.slice(2));
      continue;
    }
    throw new SettlementInstrumentError(`unknown status v2 record: ${record}`);
  }
  if (branchOid === null || !/^[0-9a-f]{40,64}$/.test(branchOid)) {
    throw new SettlementInstrumentError(
      "status positive control failed: branch.oid is absent or invalid",
    );
  }
  const head = await oid(worktreePath, "HEAD");
  if (head !== branchOid) {
    throw new SettlementInstrumentError(
      "status positive control failed: branch.oid disagrees with rev-parse HEAD",
    );
  }
  return { branchOid, candidates, ignoredMarkers };
}

/**
 * `git status --ignored=matching` reports an ignored directory as a marker even when the tree
 * beneath it holds only empty directories, while `git ls-files --others` lists files only — so a
 * file-free tree legitimately expands to nothing. Files the disk holds but git failed to list
 * still mean the two listings disagree.
 */
async function treeHoldsNoFiles(path: string): Promise<boolean> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!(await treeHoldsNoFiles(join(path, entry.name)))) return false;
    } else {
      return false;
    }
  }
  return true;
}

async function ignoredFiles(
  worktreePath: string,
  markers: readonly string[],
): Promise<string[]> {
  const control = await runGit(worktreePath, [
    "--no-optional-locks",
    "ls-files",
    "--cached",
    "-z",
  ]);
  assertGitSuccess(control, "ls-files ignored-inventory control");
  if (control.stdout.split("\0").filter((path) => path !== "").length === 0) {
    throw new SettlementInstrumentError(
      "ignored inventory positive control did not observe a tracked file",
    );
  }
  const result = await runGit(worktreePath, [
    "--no-optional-locks",
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  assertGitSuccess(result, "ls-files --ignored");
  const files = result.stdout.split("\0").filter((path) => path !== "");
  for (const marker of markers) {
    const prefix = marker.endsWith("/") ? marker : `${marker}/`;
    if (files.some((path) => path === marker || path.startsWith(prefix))) {
      continue;
    }
    if (
      marker.endsWith("/") &&
      (await treeHoldsNoFiles(join(worktreePath, marker)).catch(() => false))
    ) {
      continue;
    }
    throw new SettlementInstrumentError(
      `ignored-directory expansion failed for ${marker}`,
    );
  }
  for (const path of files) {
    const entry = await lstat(join(worktreePath, path)).catch(() => null);
    // git does not descend into a nested repository: it lists the repository root as a
    // directory, and that directory is itself the inventory entry.
    if (entry === null) {
      throw new SettlementInstrumentError(
        `ignored inventory did not resolve to a file: ${path}`,
      );
    }
  }
  return files;
}

/**
 * What the worktree holds, split by who is answerable for it.
 *
 * Residue is unaccounted CONTENT: tracked, staged, unmerged, and untracked-but-not-ignored paths
 * that `isHiveWorktreeWiring` cannot prove Hive itself laid down. It blocks release, because only
 * a person can decide what to do with work nobody landed.
 *
 * Regenerable is everything the worktree's own ignore rules declare reproducible. It is measured
 * and recorded in full but never blocks: git will not accept an ignored file, so a state that
 * waits for one to be integrated can never be left. The same rule already decides stranded work in
 * `assessStrandedWork`, and one question gets one answer.
 */
async function worktreeInventory(worktreePath: string): Promise<{
  headOid: string;
  residue: string[];
  regenerable: string[];
}> {
  const status = await statusInventory(worktreePath);
  const regenerable = await ignoredFiles(worktreePath, status.ignoredMarkers);
  const skillLinks = await provisionedSkillLinks(worktreePath);
  const residue: string[] = [];
  for (const path of [...new Set(status.candidates)].sort()) {
    if (await isHiveWorktreeWiring(path, worktreePath, skillLinks)) continue;
    residue.push(path);
  }
  return {
    headOid: status.branchOid,
    residue,
    regenerable: regenerable.sort(),
  };
}

async function operationInProgress(worktreePath: string): Promise<boolean> {
  const result = await runGit(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  assertGitSuccess(result, "rev-parse --git-dir");
  const gitDir = result.stdout.trim();
  if (gitDir === "") {
    throw new SettlementInstrumentError("git-dir positive control was empty");
  }
  return [
    "index.lock",
    "rebase-apply",
    "rebase-merge",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ].some((path) => existsSync(join(gitDir, path)));
}

function snapshotDigest(value: Omit<SettlementSnapshot, "digest">): string {
  // The target tip feeds the accounting verdict below, but its raw oid is ambient repository
  // movement. The exact unaccounted set records whether that movement changed this disposition.
  const {
    targetOid: _targetOid,
    accountedBy: _accountingProof,
    ...disposition
  } = value;
  return createHash("sha256").update(JSON.stringify(disposition)).digest("hex");
}

function snapshot(
  value: Omit<SettlementSnapshot, "digest">,
): SettlementSnapshot {
  return { ...value, digest: snapshotDigest(value) };
}

async function stewardshipRefs(
  repoRoot: string,
  record: SettlementCase,
): Promise<Array<{ ref: string; oid: string | null }>> {
  return Promise.all(
    [record.preservedRef, record.salvageRef].flatMap((ref) =>
      ref === null
        ? []
        : [
            readRefOid(repoRoot, ref).then((oid) => ({
              ref,
              oid,
            })),
          ],
    ),
  );
}

async function mergeBaseOid(
  repoRoot: string,
  targetRef: string,
  candidateOid: string,
): Promise<string> {
  const result = await runGit(repoRoot, [
    "merge-base",
    targetRef,
    candidateOid,
  ]);
  assertGitSuccess(result, `merge-base ${targetRef} ${candidateOid}`);
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new SettlementInstrumentError(
      "git merge-base returned an invalid oid",
    );
  }
  return value;
}

async function proveAccounted(
  repoRoot: string,
  targetBranch: string,
  targetOid: string,
  candidateOid: string,
  record: SettlementCase,
  unaccountedCommitOids: readonly string[],
): Promise<SettlementSnapshot["accountedBy"]> {
  if (
    (await treeOid(repoRoot, targetOid)) ===
    (await treeOid(repoRoot, candidateOid))
  ) {
    return "tree-equality";
  }
  if (unaccountedCommitOids.length === 0) {
    return "unlanded-count";
  }
  // PROVABLY UNREACHABLE as a positive result: this leg can only return null.
  //
  // It requires `receipt.sourceOid === candidateOid`, so `sourceStillAccounted` below is the
  // identical call to the unlanded count above. Whenever that count is 0 the branch above has
  // already returned `unlanded-count`, so by the time control arrives here it cannot be 0, and
  // `landing-receipt` is never returned. A receipt re-verified against live git — which is the
  // only safe way to admit one — can therefore decide nothing that ancestry has not already
  // decided.
  //
  // Left in place deliberately rather than deleted: whether receipts should exist at all is a
  // question for whoever makes landing facts durable, and the write side is being changed
  // separately. Do not read this as a live accounting path, and do not "fix" it by relaxing the
  // source check — that check is what refuses a receipt vouching for another branch's commit.
  const receipt = record.landingReceipt;
  if (
    receipt === null ||
    receipt.sourceOid !== candidateOid ||
    receipt.targetBranch !== targetBranch
  ) {
    return null;
  }
  const targetStillAccounted =
    (await listCommitsNotOnMain(repoRoot, targetBranch, receipt.targetOid))
      .length === 0;
  const sourceStillAccounted =
    (await listCommitsNotOnMain(repoRoot, targetBranch, receipt.sourceOid))
      .length === 0;
  return targetStillAccounted && sourceStillAccounted
    ? "landing-receipt"
    : null;
}

/**
 * The oid and owner this case's branch still holds. Missing ownership is a measured verdict:
 * automatic release remains blocked, while a user can decide what to do with the exact bundle.
 * A missing branch returns null for both because there is no branch left to release.
 */
async function proveBranchIdentity(
  repoRoot: string,
  branch: string | null,
): Promise<{ oid: string | null; ownerInstanceId: string | null }> {
  if (branch === null) return { oid: null, ownerInstanceId: null };
  if ((await readRefOid(repoRoot, `refs/heads/${branch}`)) === null)
    return { oid: null, ownerInstanceId: null };
  const owner = await branchOwner(repoRoot, branch);
  return {
    oid: await oid(repoRoot, `refs/heads/${branch}`),
    ownerInstanceId: owner ?? null,
  };
}

/**
 * Names exactly what this case still owns.
 *
 * `path` is null when nothing is left to remove — either the case never had a worktree, or the
 * registration and the directory are both gone. That is a measurement with a result, not a
 * measurement that failed, and the two are only distinguishable because the primary-checkout
 * control proves the registration reader can see a worktree that is there. An unregistered
 * directory, a duplicate registration, or a registration naming another branch stays an
 * instrument failure: those are contradictions, and a contradiction is never a clean read.
 */
async function proveIdentity(
  repoRoot: string,
  record: SettlementCase,
): Promise<{
  path: string | null;
  branchOid: string | null;
  branchOwnerInstanceId: string | null;
}> {
  const canonicalRepo = await realpath(repoRoot);
  const registrations = await listWorktrees(repoRoot);
  const primaryMatches = registrations.filter(
    ({ path }) => path === canonicalRepo,
  );
  if (primaryMatches.length !== 1) {
    throw new SettlementInstrumentError(
      "worktree-list positive control failed for the primary checkout",
    );
  }
  const branch = await proveBranchIdentity(repoRoot, record.branch);
  if (record.worktreePath === null) {
    const checkedOut = registrations.filter(
      ({ path, branch }) => branch === record.branch && path !== canonicalRepo,
    );
    if (record.branch !== null && checkedOut.length > 0) {
      throw new SettlementInstrumentError(
        `settlement case holds no worktree but ${record.branch} is checked out in one`,
      );
    }
    return {
      path: null,
      branchOid: branch.oid,
      branchOwnerInstanceId: branch.ownerInstanceId,
    };
  }
  const canonicalPath = await canonicalizePotentialPath(record.worktreePath);
  const worktreesRoot = join(canonicalRepo, ".hive", "worktrees");
  const inside = relative(worktreesRoot, canonicalPath);
  if (inside.startsWith(`..${sep}`) || inside === ".." || inside === "") {
    throw new SettlementInstrumentError(
      `worktree is outside the canonical Hive worktree root: ${canonicalPath}`,
    );
  }
  const matches = registrations.filter(({ path }) => path === canonicalPath);
  if (matches.length > 1) {
    throw new SettlementInstrumentError(
      `expected at most one worktree registration for ${canonicalPath}`,
    );
  }
  const registration = matches[0];
  if (registration === undefined) {
    if (existsSync(canonicalPath)) {
      throw new SettlementInstrumentError(
        `worktree directory has no registration to prove it: ${canonicalPath}`,
      );
    }
    return {
      path: null,
      branchOid: branch.oid,
      branchOwnerInstanceId: branch.ownerInstanceId,
    };
  }
  if (registration.branch !== record.branch) {
    throw new SettlementInstrumentError(
      `worktree branch disagrees with settlement case: ${canonicalPath}`,
    );
  }
  return {
    path: canonicalPath,
    branchOid: branch.oid,
    branchOwnerInstanceId: branch.ownerInstanceId,
  };
}

export async function measureAutomaticRelease(
  deps: SettlementProofDependencies,
  record: SettlementCase,
  agent: AgentRecord | null,
  targetBranch: string,
): Promise<SettlementProofResult> {
  try {
    if (probeProcessLiveness(process.pid) !== "live") {
      throw new SettlementInstrumentError(
        "liveness positive control failed for the daemon pid",
      );
    }
    const agentRowAbsent = record.agentId !== null && agent === null;
    if (
      agent !== null &&
      (agent.id !== record.agentId ||
        (agent.sessionLocator?.generation ?? null) !== record.generation)
    ) {
      throw new SettlementInstrumentError(
        "agent generation disagrees with the settlement case",
      );
    }
    const liveness = agent === null ? null : await deps.processLiveness(agent);
    const identity = await proveIdentity(deps.repoRoot, record);
    const measurable = identity.path !== null && existsSync(identity.path);
    if (
      identity.path !== null &&
      measurable &&
      (await operationInProgress(identity.path))
    ) {
      return {
        kind: "kept",
        state: "settling",
        reason: "git operation is in progress",
        snapshot: null,
      };
    }
    const targetRef = `refs/heads/${targetBranch}`;
    const targetOid = await oid(deps.repoRoot, targetRef);
    const inventory =
      identity.path !== null && measurable
        ? await worktreeInventory(identity.path)
        : { headOid: identity.branchOid, residue: [], regenerable: [] };
    if (
      identity.branchOid !== null &&
      inventory.headOid !== identity.branchOid
    ) {
      throw new SettlementInstrumentError(
        "worktree HEAD disagrees with its branch ref",
      );
    }
    if (
      record.state === "safe-release" &&
      record.headOid !== null &&
      inventory.headOid !== record.headOid
    ) {
      throw new SettlementInstrumentError(
        "settlement case HEAD changed since its recorded revision",
      );
    }
    const unaccountedCommitOids =
      inventory.headOid === null
        ? []
        : await listCommitsNotOnMain(
            deps.repoRoot,
            targetBranch,
            inventory.headOid,
          );
    const measuredStewardshipRefs = await stewardshipRefs(
      deps.repoRoot,
      record,
    );
    const missing: SettlementSnapshot["missing"][number][] = [];
    if (record.branch !== null && identity.branchOid === null) {
      missing.push("branch");
    }
    if (record.worktreePath !== null && identity.path === null) {
      missing.push("worktree");
    }
    if (
      record.preservedRef !== null &&
      measuredStewardshipRefs.some(
        ({ ref, oid }) => ref === record.preservedRef && oid === null,
      )
    ) {
      missing.push("preserved-ref");
    }
    if (
      record.salvageRef !== null &&
      measuredStewardshipRefs.some(
        ({ ref, oid }) => ref === record.salvageRef && oid === null,
      )
    ) {
      missing.push("salvage-ref");
    }
    const accountedBy =
      inventory.headOid === null
        ? // Nothing is left to measure only when nothing is left at all. A case still holding any
          // part of its bundle — the other half, or a stewardship ref that keeps the commits
          // reachable after the branch is gone — has content this proof did not read, and an
          // unread part is never clean. The stewardship sweep owns the refs it names.
          identity.path === null &&
          identity.branchOid === null &&
          measuredStewardshipRefs.every(({ oid }) => oid === null)
          ? "nothing-remains"
          : null
        : await proveAccounted(
            deps.repoRoot,
            targetBranch,
            targetOid,
            inventory.headOid,
            record,
            unaccountedCommitOids,
          );
    const measured = snapshot({
      targetBranch,
      targetRef,
      targetOid,
      mergeBaseOid:
        inventory.headOid === null
          ? null
          : await mergeBaseOid(deps.repoRoot, targetRef, inventory.headOid),
      headOid: inventory.headOid,
      branchOid: identity.branchOid,
      branchOwnerInstanceId: identity.branchOwnerInstanceId,
      worktreePath: identity.path,
      residue: inventory.residue,
      regenerable: inventory.regenerable,
      unaccountedCommitOids,
      stewardshipRefs: measuredStewardshipRefs,
      missing,
      accountedBy,
    });
    if (liveness === "live" && accountedBy !== "nothing-remains") {
      return {
        kind: "kept",
        state: "active",
        reason: "agent process tree is live; Git evidence is measured",
        snapshot: measured,
      };
    }
    if (liveness === "unknown" && accountedBy !== "nothing-remains") {
      return {
        kind: "kept",
        state: "measurement-blocked",
        reason: "agent process liveness is unknown; Git evidence is measured",
        snapshot: measured,
      };
    }
    // Agent ids are never reissued, so a missing exact row cannot become measurable later.
    // Git can still describe the subject for a user decision, but cannot prove it safe to release.
    if (agentRowAbsent && accountedBy !== "nothing-remains") {
      return {
        kind: "kept",
        state: "owner-decision",
        reason:
          "the agent row is absent; Git evidence is measured and only a user may discard it",
        snapshot: measured,
      };
    }
    if (
      identity.branchOid !== null &&
      identity.branchOwnerInstanceId !== hiveInstanceSuffix()
    ) {
      return {
        kind: "kept",
        state: "needs-integration",
        reason:
          identity.branchOwnerInstanceId === null
            ? `branch ownership is unprovable: ${record.branch ?? "unknown"}`
            : `branch is owned by another Hive instance: ${record.branch ?? "unknown"}`,
        snapshot: measured,
      };
    }
    if (inventory.residue.length > 0) {
      return {
        kind: "kept",
        state: "needs-integration",
        reason: `worktree holds ${inventory.residue.length} residue path(s)`,
        snapshot: measured,
      };
    }
    if (accountedBy === null) {
      return {
        kind: "kept",
        state: "needs-integration",
        reason: renderUnaccountedCommitReason(
          measured.targetRef,
          measured.unaccountedCommitOids.length,
        ),
        snapshot: measured,
      };
    }
    return { kind: "safe", snapshot: measured };
  } catch (error) {
    if (error instanceof SettlementInstrumentError) {
      return {
        kind: "kept",
        state: "measurement-blocked",
        reason: error.message,
        snapshot: null,
      };
    }
    return {
      kind: "kept",
      state: "measurement-blocked",
      reason:
        error instanceof Error ? error.message : "unknown measurement failure",
      snapshot: null,
    };
  }
}
