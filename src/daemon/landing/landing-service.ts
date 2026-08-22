import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type GitResult, runGit } from "../../adapters/git";
import { probeProcessLiveness } from "../../adapters/process-liveness";
import type { AuditEntry } from "../authorization/authorization-service";
import type { AgentRecord } from "../../schemas/agent";
import type { MainHealthMonitorHandle } from "./main-health-monitor";

export type LandBranch = (
  repoRoot: string,
  branch: string,
) => Promise<{ commit: string; landedCommits: string[] }>;

/** A stuck git — a stale `index.lock`, a stalled filesystem — must fail the land rather than wedge the handler forever. A ff-only merge on a local repo that has not finished in 30s is not going to. This is a deadline for a *hang*, and nothing else: a merge git refuses outright comes back in milliseconds. */
export const LAND_GIT_TIMEOUT_MS = 30_000;

const trimmed = (result: GitResult): string => result.stdout.trim();

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

async function gitPath(repoRoot: string, name: string): Promise<string> {
  const result = await runGit(repoRoot, ["rev-parse", "--git-path", name]);
  if (result.exitCode !== 0 || trimmed(result) === "")
    return join(repoRoot, ".git", name);
  const path = trimmed(result);
  return path.startsWith("/") ? path : resolve(repoRoot, path);
}

interface LandingLease {
  readonly pid: number;
  readonly token: string;
}

type LandingLeaseEvidence =
  | { readonly state: "absent" }
  | { readonly state: "valid"; readonly lease: LandingLease }
  | { readonly state: "unknown" };

function readLandingLease(path: string): LandingLeaseEvidence {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unknown" };
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (typeof value !== "object" || value === null)
      return { state: "unknown" };
    const lease = value as Record<string, unknown>;
    if (
      typeof lease.pid !== "number" ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      typeof lease.token !== "string" ||
      lease.token === ""
    )
      return { state: "unknown" };
    return {
      state: "valid",
      lease: { pid: lease.pid, token: lease.token },
    };
  } catch {
    return { state: "unknown" };
  }
}

function sameLandingLease(left: LandingLease, right: LandingLease): boolean {
  return left.pid === right.pid && left.token === right.token;
}

function removeLandingLease(path: string, lease: LandingLease): boolean {
  const current = readLandingLease(path);
  if (current.state !== "valid" || !sameLandingLease(current.lease, lease)) {
    return false;
  }
  rmSync(path, { force: true });
  const remaining = readLandingLease(path);
  return (
    remaining.state === "absent" ||
    (remaining.state === "valid" && !sameLandingLease(remaining.lease, lease))
  );
}

function processLiveness(pid: number): "live" | "dead" | "unknown" {
  // A lease holder owned by another uid is still its lock's owner: the lease is never broken on a uid mismatch, so other-uid reads as live here.
  const liveness = probeProcessLiveness(pid);
  return liveness === "other-uid" ? "live" : liveness;
}

async function acquireLandingLease(repoRoot: string): Promise<() => void> {
  const common = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (common.exitCode !== 0 || trimmed(common) === "") {
    throw new Error(
      `Cannot land: could not resolve git common directory for ${repoRoot}`,
    );
  }
  const commonPath = trimmed(common).startsWith("/")
    ? trimmed(common)
    : resolve(repoRoot, trimmed(common));
  const path = join(commonPath, "hive-landing.lock");
  const lease: LandingLease = { pid: process.pid, token: crypto.randomUUID() };
  const encoded = `${JSON.stringify(lease)}\n`;
  const deadline = Date.now() + LAND_GIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      writeFileSync(path, encoded, { flag: "wx", mode: 0o600 });
      return () => {
        removeLandingLease(path, lease);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const evidence = readLandingLease(path);
    if (evidence.state === "absent") continue;
    if (evidence.state === "unknown") {
      throw new Error(
        `Cannot land: landing lease ownership is unknown at ${path}; refusing to replace it`,
      );
    }
    const liveness = processLiveness(evidence.lease.pid);
    if (liveness === "unknown") {
      throw new Error(
        `Cannot land: process liveness for landing lease pid ${evidence.lease.pid} is unknown; refusing to replace ${path}`,
      );
    }
    if (liveness === "dead") {
      removeLandingLease(path, evidence.lease);
      continue;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Cannot land: timed out waiting for the repository landing lease at ${path}`,
  );
}

/** `git status --porcelain` split into the tracked-but-modified paths that could block a merge. A rename's `XY orig -> new` form is reduced to the destination, which is the path a merge would collide with. Untracked (`??`) lines are deliberately excluded: they are a different collision with a different remedy, handled by `untrackedCollisions` below. */
function dirtyPaths(porcelain: string): Set<string> {
  const paths = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.length < 4 || line.startsWith("??")) continue;
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    paths.add(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return paths;
}

export interface UntrackedCollision {
  path: string;
  identical: boolean;
}

/** Untracked files in the primary checkout sitting at paths the branch adds — the files `git merge` refuses to overwrite. `-uall` is load-bearing: plain porcelain collapses a fully-untracked directory to one `dir/` line, which can never match a file path the branch adds, so the most ordinary shape of this collision (a user drops `assets/*.png` into the repo, an agent commits them) otherwise sail straight past diagnosis into git's raw refusal. Identity is by content hash, never name or size: `git hash-object` on the working-tree file against the branch's blob at the same path. */
export async function untrackedCollisions(
  repoRoot: string,
  branch: string,
): Promise<UntrackedCollision[]> {
  const status = await runGit(repoRoot, ["status", "--porcelain", "-uall"]);
  if (status.exitCode !== 0) return [];
  const untracked = new Set(
    status.stdout
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3)),
  );
  if (untracked.size === 0) return [];

  const added = await runGit(repoRoot, [
    "diff",
    "--name-only",
    "--diff-filter=A",
    "HEAD",
    branch,
  ]);
  if (added.exitCode !== 0) return [];

  const collisions: UntrackedCollision[] = [];
  for (const path of lines(added.stdout)) {
    if (!untracked.has(path)) continue;
    const ours = await runGit(repoRoot, ["hash-object", "--", path]);
    const theirs = await runGit(repoRoot, ["rev-parse", `${branch}:${path}`]);
    collisions.push({
      path,
      identical:
        ours.exitCode === 0 &&
        theirs.exitCode === 0 &&
        trimmed(ours) === trimmed(theirs),
    });
  }
  return collisions;
}

/** What the primary checkout can prove about a branch before anyone is asked to approve anything. Both fields are three-valued on purpose: `null` is "we could not read it", which is evidence of nothing and must never be read as a yes. Treating a classifier's null as permission disarms refusal guards. Committed history only: `rev-list` and `merge-base` see the branch's commits, never the working tree, so this reader cannot repeat the `git status` untracked-directory trap that `untrackedCollisions` above exists to dodge. */
export interface LandReadiness {
  /** Commits on the branch that the primary's HEAD does not have — `main..branch`. 0 means there is nothing to merge; null means we could not tell. */
  pending: number | null;
  rebased: boolean | null;
  /** The branch the primary checkout is on — the landing target's NAME. Null when the checkout is detached or unreadable: a detached HEAD is a position, not a target, and no readiness claim may name it as "the current branch". */
  targetBranch: string | null;
  /** The primary checkout's HEAD — the main the branch would be rebased onto. Null when we could not tell. Carried so a refusal can name the SHA it found, not just the fact of movement. */
  targetHead: string | null;
  baseSha: string | null;
}

export type ReadLandReadiness = (
  repoRoot: string,
  branch: string,
) => Promise<LandReadiness>;

export const readLandReadiness: ReadLandReadiness = async (
  repoRoot,
  branch,
) => {
  const pendingResult = await runGit(repoRoot, [
    "rev-list",
    "--count",
    `HEAD..${branch}`,
  ]);
  const raw = trimmed(pendingResult);
  const count = Number(raw);
  const pending =
    pendingResult.exitCode === 0 &&
    raw !== "" &&
    Number.isSafeInteger(count) &&
    count >= 0
      ? count
      : null;

  const ancestor = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    branch,
  ]);
  const rebased =
    ancestor.exitCode === 0 ? true : ancestor.exitCode === 1 ? false : null;

  const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const targetHead = head.exitCode === 0 ? trimmed(head) : null;

  let targetBranch: string | null = null;
  try {
    targetBranch = await resolveLandingTargetBranch(repoRoot);
  } catch (error) {
    if (!(error instanceof DetachedCheckoutError)) throw error;
  }

  const base = await runGit(repoRoot, ["merge-base", "HEAD", branch]);
  const baseSha = base.exitCode === 0 ? trimmed(base) : null;

  return { pending, rebased, targetBranch, targetHead, baseSha };
};

/** Why a spent land grant was not re-armed on Hive's own evidence. Each reason composes into the refusal the agent sees, so the message names the actual blocker — a moved target sends the agent to rebase, an unreadable measurement sends it to a user, and only a bare spent grant waits on the orchestrator's approval alone. */
export type SpentLandGrantAskReason =
  | "branch-unknown"
  | "rearm-not-permitted"
  | "readiness-unreadable"
  | "target-detached"
  | "target-moved"
  | "rearm-budget-exhausted";

export type SpentLandGrantDecision =
  | { kind: "nothing-to-land" }
  | { kind: "rearmed" }
  | {
      kind: "ask";
      reason: SpentLandGrantAskReason;
      readiness: LandReadiness | null;
    };

export type LandBlocker =
  | { reason: string; fix?: string; code?: undefined }
  | {
      reason: string;
      fix: string;
      code: "nothing-to-land";
      sourceOid: string;
    };

const blocked = (reason: string, fix?: string): LandBlocker =>
  fix === undefined ? { reason } : { reason, fix };

const noPendingCommits = (
  branch: string,
  targetBranch: string,
  sourceOid: string,
): LandBlocker => ({
  code: "nothing-to-land",
  sourceOid,
  reason: `every commit on ${branch} is already on ${targetBranch}, so there is no diff to merge`,
  fix: "Fix: commit new work on the branch and land again; otherwise you are done.",
});

export type NothingToLandKind = "already-landed" | "no-commits" | "unknown";

export interface NothingToLandEvidence {
  sourceOid: string | null;
  baseOid: string | null;
}

export const classifyNothingToLand = ({
  sourceOid,
  baseOid,
}: NothingToLandEvidence): NothingToLandKind => {
  if (sourceOid === null || baseOid === null) return "unknown";
  return sourceOid === baseOid ? "no-commits" : "already-landed";
};

/** Refuses a valid branch contained in the target. The MCP boundary classifies unknown cases against the settlement record's spawn base before rendering them. */
export class NothingToLandError extends Error {
  constructor(
    readonly branch: string,
    readonly kind: NothingToLandKind,
    readonly sourceOid: string | null,
    message = `Cannot land ${branch}: there is no diff to merge.`,
  ) {
    super(message);
    this.name = "NothingToLandError";
  }
}

/** The landing target is a branch, and a detached checkout has none. Thrown by `resolveLandingTargetBranch` so no caller ever receives a plausible-looking value — the literal string "HEAD" — that is not a branch. Carries the commit HEAD actually sits at, so a refusal can name it. */
export class DetachedCheckoutError extends Error {
  constructor(readonly head: string | null) {
    super(
      head === null
        ? "the primary checkout's HEAD cannot be resolved to a commit"
        : `the primary checkout is detached at ${head} — it is not on any branch`,
    );
    this.name = "DetachedCheckoutError";
  }
}

/** The branch the primary checkout is on — the one a fast-forward would move. `git symbolic-ref` is the whole measurement: it succeeds exactly when HEAD is attached. Anything else is a refusal, never a fabricated branch name. */
export async function resolveLandingTargetBranch(
  repoRoot: string,
): Promise<string> {
  const target = await runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (target.exitCode === 0) return trimmed(target);
  const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  throw new DetachedCheckoutError(head.exitCode === 0 ? trimmed(head) : null);
}

/** One ref's claim on commits a landing would carry: the ref still holds unlanded work of its own, and the newest commit it shares with the landing branch is not on the target — so that shared prefix would ride along with someone else's grant. */
interface ForeignClaim {
  readonly ref: string;
  /** The newest commit the landing branch shares with the claiming ref. */
  readonly shared: string;
  /** How many commits the shared prefix carries beyond the target: `HEAD..shared`. */
  readonly count: number;
}

/** A landing grant authorizes a branch's OWN commits; a fast-forward delivers the tip's whole ancestry. The measured line between them: any commit in the landing range that another ref still claims as unlanded work belongs to that ref's owner, whoever wrote it — authorship is no evidence here, because every agent commits under one identity. The check is structural: a ref with unlanded commits whose merge-base with the branch is not on the target shares exactly the off-target prefix that would be absorbed. Returns null when any git read fails — an unreadable claim check is unknown, never an all-clear. */
const foreignClaims = async (
  repoRoot: string,
  branch: string,
): Promise<ForeignClaim[] | null> => {
  const listed = await runGit(repoRoot, [
    "for-each-ref",
    "--no-merged",
    "HEAD",
    "--format=%(refname)",
  ]);
  if (listed.exitCode !== 0) return null;
  const self = `refs/heads/${branch}`;
  const claims: ForeignClaim[] = [];
  for (const ref of lines(listed.stdout)) {
    if (ref === self) continue;
    const bases = await runGit(repoRoot, ["merge-base", "--all", ref, branch]);
    if (bases.exitCode > 1) return null;
    for (const shared of lines(bases.stdout)) {
      const onTarget = await runGit(repoRoot, [
        "merge-base",
        "--is-ancestor",
        shared,
        "HEAD",
      ]);
      if (onTarget.exitCode > 1) return null;
      if (onTarget.exitCode !== 0) {
        const counted = await runGit(repoRoot, [
          "rev-list",
          "--count",
          `HEAD..${shared}`,
        ]);
        const count = Number(trimmed(counted));
        if (counted.exitCode !== 0 || !Number.isSafeInteger(count)) return null;
        claims.push({ ref, shared, count });
      }
    }
  }
  return claims;
};

/** Everything that can stop a fast-forward, checked before we attempt one, with cheap read-only git. The merge itself would also refuse — quickly and with a good message — but git's message is about *git*, and the caller is an agent that needs to know which of its own next steps to take. Returns null when the land should proceed. */
export async function diagnoseLand(
  repoRoot: string,
  branch: string,
): Promise<LandBlocker | null> {
  // A lock is the one thing that would genuinely make git *wait*, so it is the one worth catching before we start a 30-second deadline running.
  const lock = await gitPath(repoRoot, "index.lock");
  if (existsSync(lock)) {
    return blocked(
      `another git process holds the index lock in the primary checkout (${lock})`,
      `Fix: wait for that git to finish, or delete ${lock} if no git is running.`,
    );
  }

  let targetBranch: string;
  try {
    targetBranch = await resolveLandingTargetBranch(repoRoot);
  } catch (error) {
    if (!(error instanceof DetachedCheckoutError)) throw error;
    return blocked(
      error.head === null
        ? "the primary checkout's HEAD cannot be resolved to a commit"
        : `the primary checkout is detached at ${error.head} — it is not on any branch, so there is no landing target to fast-forward, and a merge here would move nothing but the detached position`,
      "Fix: the primary checkout must be back on its branch before anything can land. It was left detached — report the detachment to the orchestrator (naming the commit above) instead of moving the checkout yourself, then land again.",
    );
  }

  const exists = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${branch}^{commit}`,
  ]);
  if (exists.exitCode !== 0) {
    return blocked(
      `the branch ${branch} does not exist in ${repoRoot}`,
      `Fix: push or create ${branch}, then land again.`,
    );
  }

  const alreadyIn = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    branch,
    "HEAD",
  ]);
  if (alreadyIn.exitCode === 0) {
    return noPendingCommits(branch, targetBranch, trimmed(exists));
  }

  // Is this actually a fast-forward? A diverged branch needs a rebase, which is different from the no-work refusal above.
  const canFastForward = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    branch,
  ]);
  if (canFastForward.exitCode !== 0) {
    const behind = await runGit(repoRoot, [
      "rev-list",
      "--count",
      `${branch}..HEAD`,
    ]);
    const count = Number(trimmed(behind));
    const moved =
      Number.isSafeInteger(count) && count > 0
        ? `${targetBranch} has moved on by ${count} ${plural(count, "commit", "commits")} that ${branch} does not have`
        : `${branch} has diverged from ${targetBranch}`;
    return blocked(
      `not a fast-forward: ${moved}`,
      `Fix: run \`git rebase ${targetBranch}\` in your worktree, re-run the tests, then land again.`,
    );
  }

  // The authorization check. Everything above asks whether the merge CAN happen; this asks whether it may: the grant covers this branch's own commits, and any commit another ref still claims as unlanded work is not this branch's to land. This is the check whose absence let a `git rebase HEAD` remedy carry four of another agent's commits onto main as passengers.
  const claims = await foreignClaims(repoRoot, branch);
  if (claims === null) {
    return blocked(
      `git could not enumerate the refs that might already claim ${branch}'s commits, so whether this landing would carry another branch's unlanded work is unknown — and unknown is never a yes`,
      "Fix: retry hive_land; if the read keeps failing, the repository needs a user before anything can land safely.",
    );
  }
  if (claims.length > 0) {
    const described = claims
      .slice(0, 3)
      .map(
        (claim) =>
          `${claim.count} ${plural(claim.count, "commit", "commits")} claimed by ${claim.ref} (newest: ${claim.shared})`,
      )
      .join("; ");
    const remainder =
      claims.length > 3 ? `; and ${claims.length - 3} more refs` : "";
    const deepest = claims.reduce((a, b) => (b.count > a.count ? b : a));
    return blocked(
      `landing ${branch} would also land work it was not authorized to carry: ${described}${remainder}. A landing grant covers only the branch's own commits — another ref's unlanded work must never reach ${targetBranch} as a side effect of this branch's landing`,
      `Fix: rebase ${branch} so it carries only your own commits — \`git rebase --onto ${targetBranch} ${deepest.shared}\` in your worktree drops everything up to the foreign commit, then re-run the tests and land again. If the shared work is meant to land, its own branch lands first (or is deleted if abandoned); do not carry it.`,
    );
  }

  const status = await runGit(repoRoot, ["status", "--porcelain"]);
  if (status.exitCode === 0 && status.stdout.trim() !== "") {
    const touched = await runGit(repoRoot, [
      "diff",
      "--name-only",
      "HEAD",
      branch,
    ]);
    if (touched.exitCode === 0) {
      const dirty = dirtyPaths(status.stdout);
      const collisions = lines(touched.stdout).filter((path) =>
        dirty.has(path),
      );
      if (collisions.length > 0) {
        const list = collisions.join(", ");
        return blocked(
          `${collisions.length} ${plural(collisions.length, "file", "files")} in the primary checkout ${plural(
            collisions.length,
            "has",
            "have",
          )} uncommitted changes the merge would overwrite: ${list}`,
          // Never offered as something Hive will do for them. Hive did not write these changes and cannot prove they are disposable — the one time it could prove it, the file was a generated cache, and that is exactly the file that no longer exists. Discarding a user's uncommitted work to save them a keystroke is not a trade Hive gets to make.
          `Fix: in ${repoRoot}, commit or stash ${list}, then land again. Hive will not discard uncommitted changes it did not write.`,
        );
      }
    }
  }

  const differing = (await untrackedCollisions(repoRoot, branch)).filter(
    (collision) => !collision.identical,
  );
  if (differing.length > 0) {
    const list = differing.map((collision) => collision.path).join(", ");
    const first = differing[0]?.path as string;
    return blocked(
      `your ${plural(differing.length, "copy", "copies")} of ${list} in the primary checkout ${plural(
        differing.length,
        "differs",
        "differ",
      )} from the ${plural(differing.length, "version", "versions")} ${branch} committed — the branch lands ${plural(
        differing.length,
        "a file",
        "files",
      )} you also have untracked there, with different content`,
      `Fix: in ${repoRoot}, move your ${plural(differing.length, "copy", "copies")} aside (e.g. \`mv ${first} ${first}.mine\`), land again, then compare and keep what you meant. Hive will not choose between two different versions of your file.`,
    );
  }

  return null;
}

export function landError(branch: string, blocker: LandBlocker): Error {
  const message = `Cannot land ${branch}: ${blocker.reason}.${
    blocker.fix === undefined ? "" : `\n${blocker.fix}`
  }`;
  return blocker.code === "nothing-to-land"
    ? new NothingToLandError(branch, "unknown", blocker.sourceOid, message)
    : new Error(message);
}

const landBranchUnlocked: LandBranch = async (repoRoot, branch) => {
  const blocker = await diagnoseLand(repoRoot, branch);
  if (blocker !== null) throw landError(branch, blocker);

  const before = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (before.exitCode !== 0) {
    throw new Error(
      `Cannot land ${branch}: could not read the target commit before merging: ${
        before.stderr.trim() || `git rev-parse exited ${before.exitCode}`
      }`,
    );
  }

  // The one provably lossless resolution (module doc): an untracked file whose bytes are identical to what the branch commits at the same path. git would still refuse to fast-forward over it, so remove it — the merge immediately restores the same content, tracked. Diagnosis above already turned any content MISMATCH into a refusal, so nothing differing is touched here; a removal that fails falls through to the merge's own refusal and re-diagnosis.
  for (const collision of await untrackedCollisions(repoRoot, branch)) {
    if (collision.identical) {
      await unlink(join(repoRoot, collision.path)).catch(() => {});
    }
  }

  const merge = await runGit(repoRoot, ["merge", "--ff-only", branch], {
    timeoutMs: LAND_GIT_TIMEOUT_MS,
  });
  if (merge.timedOut) {
    throw new Error(
      `Cannot land ${branch}: git merge did not finish within ${
        LAND_GIT_TIMEOUT_MS / 1_000
      }s in ${repoRoot} and was killed. A merge git refuses comes back instantly, so this is a stuck git — a stale lock or a stalled filesystem — not a rejected merge.\n` +
        `Fix: check for a hung git process in ${repoRoot}, then land again.`,
    );
  }
  if (merge.exitCode !== 0) {
    // Between the diagnosis and the merge, someone else's commit can land. We re-diagnose rather than paraphrase, so the agent is told the *current* reason and not a guess — and if we still cannot explain it, git's own stderr goes through verbatim. It is never discarded.
    const blockerNow = await diagnoseLand(repoRoot, branch);
    if (blockerNow !== null) throw landError(branch, blockerNow);
    const detail =
      merge.stderr.trim() ||
      merge.stdout.trim() ||
      `git merge exited ${merge.exitCode}`;
    throw new Error(`Cannot land ${branch}: ${detail}`);
  }

  const revision = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (revision.exitCode !== 0) {
    throw new Error(
      `Landed ${branch}, but could not read the resulting commit: ${
        revision.stderr.trim() || `git rev-parse exited ${revision.exitCode}`
      }`,
    );
  }
  if (trimmed(revision) === trimmed(before)) {
    const sourceOid = trimmed(revision);
    throw new NothingToLandError(branch, "unknown", sourceOid);
  }
  // The receipt: every commit the fast-forward actually carried, named. A land that cannot name what it landed is how four of another agent's commits once reached main with no record.
  const range = await runGit(repoRoot, [
    "rev-list",
    "--reverse",
    `${trimmed(before)}..HEAD`,
  ]);
  if (range.exitCode !== 0) {
    throw new Error(
      `Landed ${branch} as ${trimmed(revision)}, but could not read the landed commit range for the receipt: ${
        range.stderr.trim() || `git rev-list exited ${range.exitCode}`
      }`,
    );
  }
  return { commit: trimmed(revision), landedCommits: lines(range.stdout) };
};

export const landBranch: LandBranch = async (repoRoot, branch) => {
  const release = await acquireLandingLease(repoRoot);
  try {
    return await landBranchUnlocked(repoRoot, branch);
  } finally {
    release();
  }
};

export interface LandAgentDependencies {
  readonly db: { getAgentByName(name: string): AgentRecord | null };
  readonly machineMutations: {
    beginOperation(kind: string): Promise<{ release(): void }>;
  } | null;
  readonly repoRoot: string;
  readonly land: LandBranch;
  readonly capabilities: { audit(entry: Omit<AuditEntry, "at">): void };
  readonly worktrees: {
    onLanded(agent: AgentRecord, landedCommit: string): Promise<void>;
  };
  readonly mainHealthMonitor: MainHealthMonitorHandle | null;
  readonly graphify: { scheduleRebuild(): void } | undefined;
  readonly succession: () => {
    writeBoundaryCheckpoint(event: "promotion-boundary", run: null): void;
  };
}

export async function landAgent(
  deps: LandAgentDependencies,
  name: string,
  capabilityEpoch: number,
): Promise<{ commit: string; landedCommits: string[] }> {
  // Name one failure per refusal because stale epochs and revoked authority require opposite actions: re-read the former and stop for the latter.
  const agent = deps.db.getAgentByName(name);
  if (agent === null) {
    throw new Error(
      `Cannot land ${name}: no agent by that name is registered with this daemon.`,
    );
  }
  if (agent.branch === null) {
    throw new Error(
      `Cannot land ${name}: it has no branch — it was spawned without a worktree, so there is nothing to merge.`,
    );
  }
  if (agent.readOnly) {
    throw new Error(
      `Cannot land ${name}: it was launched read-only and has no landing authority.`,
    );
  }
  if (agent.writeRevoked) {
    throw new Error(
      `Cannot land ${name}: its write authority was revoked by a critical control message, so it may not merge.\n` +
        `Fix: the orchestrator must restore ${name}'s authority (or land the work through an integrator) before this can proceed.`,
    );
  }
  if (agent.capabilityEpoch !== capabilityEpoch) {
    throw new Error(
      `Cannot land ${name}: the capabilityEpoch passed (${capabilityEpoch}) is not ${name}'s current epoch (${agent.capabilityEpoch}) — a control message re-issued its capability since this one was minted.\n` +
        `Fix: call hive_land again with capabilityEpoch ${agent.capabilityEpoch}.`,
    );
  }
  const operation = await deps.machineMutations?.beginOperation("landing");
  try {
    const landed = await deps.land(deps.repoRoot, agent.branch);
    // The landing receipt, written at the point the merge becomes durable — before anything that can still throw. It names every commit that actually landed, so no commit reaches main anonymous again.
    deps.capabilities.audit({
      route: "/mcp:hive_land",
      action: "branch:land",
      callerSubject: name,
      callerRole: null,
      capabilityId: null,
      requestedSubject: name,
      epoch: capabilityEpoch,
      decision: "allow",
      reason:
        `receipt: landed ${landed.landedCommits.length} ` +
        `${landed.landedCommits.length === 1 ? "commit" : "commits"} ` +
        `from ${agent.branch}: ${landed.landedCommits.join(" ")}`,
    });
    await deps.worktrees.onLanded(agent, landed.commit);
    void deps.mainHealthMonitor?.checkNow();
    // The graph tracks main, and this is the one choke point every landing passes through. Fire-and-forget: the merge result is already decided and a graph rebuild must never appear in landing latency.
    deps.graphify?.scheduleRebuild();
    // A landed branch is a promotion boundary: the daemon writes the checkpoint at the event. The merge is already durable, so a failed checkpoint is logged loudly, never charged against the land.
    try {
      deps.succession().writeBoundaryCheckpoint("promotion-boundary", null);
    } catch (error) {
      console.error(
        `[hive] could not write the promotion-boundary checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return landed;
  } finally {
    operation?.release();
  }
}

/** One agent's resolved hierarchy landing. The authority the hierarchy derived from the authenticated session is already bound into `land`, and nothing else is exposed: the flat tool epoch cannot ride along, because there is no argument for it to ride on. Holding this object is the whole right to land hierarchy work; holding none means the hierarchy path does not exist for this caller. */
export type HierarchyLanding = {
  readonly land: () => Promise<{ commit: string }>;
};
