/**
 * The landing gate's git: a fast-forward-only merge of a writer's branch into
 * the primary checkout, and — the part this module exists for — an honest
 * account of what happened when that does not work.
 *
 * The bug that motivated all of it: `git merge --ff-only` was being run with a
 * 30-second deadline, and a helper reported *any* failure as
 * `git merge timed out after 30000ms`. It had not timed out. Bun sets
 * `Subprocess.killed` to true for a process that exits on its own — including a
 * normal, instant, non-zero exit — so the timeout branch fired on every failing
 * git command, and the real stderr, which said exactly what was wrong, was
 * thrown away and replaced with a fabricated stopwatch reading. A blocked merge
 * fails in about 9ms. Nobody was ever waiting 30 seconds; they were being lied
 * to in 9 milliseconds and then told it took 30 seconds.
 *
 * So: the timeout is tracked by an explicit flag we set ourselves, git's own
 * stderr is never discarded, and every way a landing can fail names its cause
 * and, when a human has to decide, says what to do in one labeled `Fix:` line.
 *
 * What this module will never do is *resolve* a landing failure on its own.
 * Every blocker here is one of two things: work only the writer can redo (a
 * rebase invalidates the tests it just ran green, so Hive cannot rebase for it),
 * or a change in the user's working tree that Hive did not write and cannot
 * prove is disposable. Guessing at either is how you lose someone's work.
 *
 * One exception, precisely because it is provable: an untracked file in the
 * primary whose bytes are identical (by blob hash) to the version the branch
 * commits at the same path. Removing it loses nothing — the fast-forward
 * immediately restores the same content, tracked. This is the most ordinary
 * collision Hive has: a user drops a file in, an agent copies it into its
 * worktree and commits it, and git then refuses to fast-forward the primary
 * over the user's original. When the bytes differ, that proof is gone and the
 * usual rule holds absolutely: name both versions and let the human choose.
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type LandBranchOptions = {
  /** Called immediately before `git merge --ff-only`. Must throw to abort. */
  /** The async half of the merge boundary, run after diagnosis, collision
   * cleanup, and the landing lease's wait — everything before this point
   * happened at an earlier, staler moment. A Codex writer's applied identity
   * has to be re-read from the provider here, and that read is I/O.
   *
   * It is deliberately separate from `preMergeCheck` rather than making that
   * callback async: an `await` between the authority check and the merge spawn
   * would let a queued control message interleave in exactly the window the
   * check exists to close. So the async attestation runs FIRST, and the
   * synchronous check keeps its unbroken adjacency to the spawn below. */
  preMergeAttest?: () => Promise<void>;
  /** Runs immediately before `git merge`, with nothing awaited in between. */
  preMergeCheck?: () => void;
  /** Test seam around the process adapter. Production always uses runGit. */
  spawnMerge?: (repoRoot: string, branch: string) => Promise<GitResult>;
  /** Test seams for deterministic pathname-replacement races. */
  beforeCollisionQuarantine?: (path: string) => void;
  afterCollisionQuarantine?: (path: string, quarantinedPath: string) => void;
};

export type LandBranch = (
  repoRoot: string,
  branch: string,
  options?: LandBranchOptions,
) => Promise<{ commit: string }>;

/** A stuck git — a stale `index.lock`, a stalled filesystem — must fail the
 * land rather than wedge the handler forever. A ff-only merge on a local repo
 * that has not finished in 30s is not going to. This is a deadline for a *hang*,
 * and nothing else: a merge git refuses outright comes back in milliseconds. */
export const LAND_GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set only when *we* killed it at the deadline. Never inferred from
   * `proc.killed`, which Bun sets on any exited process and which therefore
   * cannot distinguish "we killed it" from "it failed instantly". */
  timedOut: boolean;
}

export async function runGit(
  repoRoot: string,
  args: string[],
): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, LAND_GIT_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

const trimmed = (result: GitResult): string =>
  result.stdout.trim();

const lines = (out: string): string[] =>
  out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

async function gitPath(repoRoot: string, name: string): Promise<string> {
  const result = await runGit(repoRoot, ["rev-parse", "--git-path", name]);
  if (result.exitCode !== 0 || trimmed(result) === "") return join(repoRoot, ".git", name);
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
    if (typeof value !== "object" || value === null) return { state: "unknown" };
    const lease = value as Record<string, unknown>;
    if (
      typeof lease.pid !== "number" || !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 || typeof lease.token !== "string" || lease.token === ""
    ) return { state: "unknown" };
    return { state: "valid", lease: lease as unknown as LandingLease };
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
  return remaining.state === "absent" ||
    (remaining.state === "valid" && !sameLandingLease(remaining.lease, lease));
}

function processLiveness(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return code === "EPERM" ? "live" : "unknown";
  }
}

async function acquireLandingLease(repoRoot: string): Promise<() => void> {
  const common = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (common.exitCode !== 0 || trimmed(common) === "") {
    throw new Error(`Cannot land: could not resolve git common directory for ${repoRoot}`);
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
  throw new Error(`Cannot land: timed out waiting for the repository landing lease at ${path}`);
}

/** `git status --porcelain` split into the tracked-but-modified paths that
 * could block a merge. A rename's `XY orig -> new` form is reduced to the
 * destination, which is the path a merge would collide with. Untracked (`??`)
 * lines are deliberately excluded: they are a different collision with a
 * different remedy, handled by `untrackedCollisions` below. */
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
  /** True when the untracked file's blob hash equals the branch's committed
   * blob at the same path — the proof that removing it loses nothing. */
  identical: boolean;
}

/**
 * Untracked files in the primary checkout sitting at paths the branch adds —
 * the files `git merge` refuses to overwrite. `-uall` is load-bearing: plain
 * porcelain collapses a fully-untracked directory to one `dir/` line, which
 * can never match a file path the branch adds, so the most ordinary shape of
 * this collision (a user drops `assets/*.png` into the repo, an agent commits
 * them) used to sail straight past diagnosis into git's raw refusal.
 * Identity is by content hash, never name or size: `git hash-object` on the
 * working-tree file against the branch's blob at the same path.
 */
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
      identical: ours.exitCode === 0 && theirs.exitCode === 0 &&
        trimmed(ours) === trimmed(theirs),
    });
  }
  return collisions;
}

/**
 * What the primary checkout can prove about a branch before anyone is asked to
 * approve anything. Both fields are three-valued on purpose: `null` is "we
 * could not read it", which is evidence of nothing and must never be read as a
 * yes (see the `unknown-read-as-permission` memory — a classifier's null
 * disarmed both guards that existed to refuse).
 *
 * Committed history only: `rev-list` and `merge-base` see the branch's commits,
 * never the working tree, so this reader cannot repeat the `git status`
 * untracked-directory trap that `untrackedCollisions` above exists to dodge.
 */
export interface LandReadiness {
  /** Commits on the branch that the primary's HEAD does not have — `main..branch`.
   * 0 means there is nothing to merge; null means we could not tell. */
  pending: number | null;
  /** True when HEAD is an ancestor of the branch: the branch is rebased on
   * current main and a fast-forward is possible. Null when we could not tell. */
  rebased: boolean | null;
}

export type ReadLandReadiness = (
  repoRoot: string,
  branch: string,
) => Promise<LandReadiness>;

export const readLandReadiness: ReadLandReadiness = async (repoRoot, branch) => {
  const pendingResult = await runGit(repoRoot, [
    "rev-list",
    "--count",
    `HEAD..${branch}`,
  ]);
  const raw = trimmed(pendingResult);
  const count = Number(raw);
  const pending = pendingResult.exitCode === 0 && raw !== "" &&
      Number.isSafeInteger(count) && count >= 0
    ? count
    : null;

  // `--is-ancestor` answers with its exit code: 0 yes, 1 no, anything else
  // (a missing branch, a broken repo) is an error, not a "no".
  const ancestor = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    branch,
  ]);
  const rebased = ancestor.exitCode === 0
    ? true
    : ancestor.exitCode === 1
    ? false
    : null;

  return { pending, rebased };
};

export interface LandBlocker {
  /** What is wrong, in one sentence, naming the specific thing. */
  reason: string;
  /** The one labeled line a human acts on. Present whenever a person must
   * decide; absent only when the blocker is Hive's own to explain. */
  fix?: string;
}

const blocked = (reason: string, fix?: string): LandBlocker =>
  fix === undefined ? { reason } : { reason, fix };

/**
 * Everything that can stop a fast-forward, checked before we attempt one, with
 * cheap read-only git. The merge itself would also refuse — quickly and with a
 * good message — but git's message is about *git*, and the caller is an agent
 * that needs to know which of its own next steps to take. Returns null when the
 * land should proceed.
 */
export async function diagnoseLand(
  repoRoot: string,
  branch: string,
  resolvedCommit?: string,
): Promise<LandBlocker | null> {
  // A lock is the one thing that would genuinely make git *wait*, so it is the
  // one worth catching before we start a 30-second deadline running.
  const lock = await gitPath(repoRoot, "index.lock");
  if (existsSync(lock)) {
    return blocked(
      `another git process holds the index lock in the primary checkout (${lock})`,
      `Fix: wait for that git to finish, or delete ${lock} if no git is running.`,
    );
  }

  const target = await runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  const targetBranch = target.exitCode === 0 ? trimmed(target) : "HEAD";

  let revision = resolvedCommit;
  if (revision === undefined) {
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
    revision = trimmed(exists);
  }

  // Is this actually a fast-forward? Two distinct non-ff cases, and an agent
  // does something different about each, so they must not share a message.
  const canFastForward = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    revision,
  ]);
  if (canFastForward.exitCode !== 0) {
    // Every commit on the branch is already on the target: the work landed, and
    // a second land is a no-op, not a failure. Git agrees — `merge --ff-only`
    // reports "Already up to date" and exits 0 — so we let it through rather
    // than inventing an error. Catching it here matters anyway, because it is
    // *also* not a fast-forward, and the diverged message below would otherwise
    // tell an agent its work was rejected when it is sitting on main.
    const alreadyIn = await runGit(repoRoot, [
      "merge-base",
      "--is-ancestor",
      revision,
      "HEAD",
    ]);
    if (alreadyIn.exitCode === 0) return null;

    const behind = await runGit(repoRoot, [
      "rev-list",
      "--count",
      `${revision}..HEAD`,
    ]);
    const count = Number(trimmed(behind));
    const moved = Number.isSafeInteger(count) && count > 0
      ? `${targetBranch} has moved on by ${count} ${plural(count, "commit", "commits")} that ${branch} does not have`
      : `${branch} has diverged from ${targetBranch}`;
    return blocked(
      `not a fast-forward: ${moved}`,
      `Fix: run \`git rebase ${targetBranch}\` in your worktree, re-run the tests, then land again.`,
    );
  }

  // A dirty primary checkout only blocks the merge if the merge would touch the
  // dirty paths, so name *those* paths — "your tree is dirty" is not a
  // diagnosis, and the file that is actually in the way is the whole answer.
  const status = await runGit(repoRoot, ["status", "--porcelain"]);
  if (status.exitCode === 0 && status.stdout.trim() !== "") {
    const touched = await runGit(repoRoot, [
      "diff",
      "--name-only",
      "HEAD",
      revision,
    ]);
    if (touched.exitCode === 0) {
      const dirty = dirtyPaths(status.stdout);
      const collisions = lines(touched.stdout).filter((path) => dirty.has(path));
      if (collisions.length > 0) {
        const list = collisions.join(", ");
        return blocked(
          `${collisions.length} ${plural(collisions.length, "file", "files")} in the primary checkout ${
            plural(collisions.length, "has", "have")
          } uncommitted changes the merge would overwrite: ${list}`,
          // Never offered as something Hive will do for them. Hive did not write
          // these changes and cannot prove they are disposable — the one time it
          // could prove it, the file was a generated cache, and that is exactly
          // the file that no longer exists. Discarding a human's uncommitted work
          // to save them a keystroke is not a trade Hive gets to make.
          `Fix: in ${repoRoot}, commit or stash ${list}, then land again. Hive will not discard uncommitted changes it did not write.`,
        );
      }
    }
  }

  // Untracked files at paths the branch adds. The identical ones are not
  // blockers — landBranch removes them under the hash proof above — so only a
  // content mismatch is reported: the user's copy and the agent's committed
  // copy genuinely differ, and choosing between them is not Hive's call.
  const differing = (await untrackedCollisions(repoRoot, revision))
    .filter((collision) => !collision.identical);
  if (differing.length > 0) {
    const list = differing.map((collision) => collision.path).join(", ");
    const first = differing[0]?.path as string;
    return blocked(
      `your ${plural(differing.length, "copy", "copies")} of ${list} in the primary checkout ${
        plural(differing.length, "differs", "differ")
      } from the ${plural(differing.length, "version", "versions")} ${branch} committed — the branch lands ${
        plural(differing.length, "a file", "files")
      } you also have untracked there, with different content`,
      `Fix: in ${repoRoot}, move your ${plural(differing.length, "copy", "copies")} aside (e.g. \`mv ${first} ${first}.mine\`), land again, then compare and keep what you meant. Hive will not choose between two different versions of your file.`,
    );
  }

  return null;
}

/** Turn a blocker into the error the agent sees. */
export function landError(branch: string, blocker: LandBlocker): Error {
  return new Error(
    `Cannot land ${branch}: ${blocker.reason}.${
      blocker.fix === undefined ? "" : `\n${blocker.fix}`
    }`,
  );
}

const landBranchUnlocked: LandBranch = async (repoRoot, branch, options) => {
  // Resolve the mutable branch name exactly once. Every tree read, collision
  // proof, and merge below is bound to this immutable object even if another
  // process advances the ref while landing is in flight.
  const resolved = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${branch}^{commit}`,
  ]);
  if (resolved.exitCode !== 0 || trimmed(resolved) === "") {
    throw landError(branch, blocked(
      `the branch ${branch} does not exist in ${repoRoot}`,
      `Fix: push or create ${branch}, then land again.`,
    ));
  }
  const sourceCommit = trimmed(resolved);
  const blocker = await diagnoseLand(repoRoot, branch, sourceCommit);
  if (blocker !== null) throw landError(branch, blocker);
  const alreadyContained = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    sourceCommit,
    "HEAD",
  ]);
  const sourceWasAlreadyContained = alreadyContained.exitCode === 0;

  // The one provably lossless resolution (module doc): atomically move the
  // exact pathname aside first, then hash THAT quarantined object against the
  // branch blob. Reading/hash-proving the path before unlinking it left a
  // replacement window in which a different object could be deleted. A
  // quarantine rename binds the proof to the object Hive actually removed.
  const removed: Array<{
    path: string;
    absolutePath: string;
    quarantinedPath: string;
  }> = [];
  const restoreRemoved = (): string[] => {
    const errors: string[] = [];
    for (const entry of removed.toReversed()) {
      try {
        if (!existsSync(entry.quarantinedPath)) continue;
        if (existsSync(entry.absolutePath)) {
          errors.push(
            `${entry.path} appeared while landing; its quarantined original was preserved at ${entry.quarantinedPath}`,
          );
          continue;
        }
        renameSync(entry.quarantinedPath, entry.absolutePath);
      } catch (error) {
        errors.push(
          `${entry.path}: ${error instanceof Error ? error.message : "restore failed"}`,
        );
      }
    }
    return errors;
  };
  const rethrowAfterRestore = (error: unknown): never => {
    const failures = restoreRemoved();
    if (failures.length === 0) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}\nHive could not restore every collision cleanup: ${failures.join("; ")}`,
      { cause: error },
    );
  };
  for (const collision of await untrackedCollisions(repoRoot, sourceCommit)) {
    if (collision.identical) {
      const absolutePath = join(repoRoot, collision.path);
      const quarantinedPath = `${absolutePath}.hive-landing-quarantine-${crypto.randomUUID()}`;
      try {
        options?.beforeCollisionQuarantine?.(collision.path);
        renameSync(absolutePath, quarantinedPath);
      } catch {
        // A failed atomic rename removed nothing. The merge either finds the
        // path already absent or refuses while preserving whatever remains.
        continue;
      }
      removed.push({ path: collision.path, absolutePath, quarantinedPath });
      try {
        options?.afterCollisionQuarantine?.(collision.path, quarantinedPath);

        const [quarantined, branchBlob] = await Promise.all([
          runGit(repoRoot, ["hash-object", "--no-filters", "--", quarantinedPath]),
          runGit(repoRoot, ["rev-parse", `${sourceCommit}:${collision.path}`]),
        ]);
        if (
          quarantined.exitCode !== 0 || branchBlob.exitCode !== 0 ||
          trimmed(quarantined) !== trimmed(branchBlob)
        ) {
          throw new Error(
            `Cannot land ${branch}: ${collision.path} changed before its atomic quarantine could prove identity; landing refused.`,
          );
        }
      } catch (error) {
        rethrowAfterRestore(error);
      }
    }
  }

  // Authority/incarnation check at the actual merge boundary — after diagnosis
  // and collision cleanup, immediately before git merge.
  let mergePromise!: Promise<GitResult>;
  try {
    // Any I/O the boundary needs happens here, before the synchronous check —
    // never between it and the spawn.
    if (options?.preMergeAttest !== undefined) await options.preMergeAttest();
    options?.preMergeCheck?.();
    mergePromise = options?.spawnMerge?.(repoRoot, sourceCommit) ??
      runGit(repoRoot, ["merge", "--ff-only", sourceCommit]);
  } catch (error) {
    rethrowAfterRestore(error);
  }

  let merge!: GitResult;
  try {
    merge = await mergePromise;
  } catch (error) {
    rethrowAfterRestore(error);
  }
  if (merge.timedOut) {
    const restoreFailures = restoreRemoved();
    throw new Error(
      `Cannot land ${branch}: git merge did not finish within ${
        LAND_GIT_TIMEOUT_MS / 1_000
      }s in ${repoRoot} and was killed. A merge git refuses comes back instantly, so this is a stuck git — a stale lock or a stalled filesystem — not a rejected merge.\n` +
        `Fix: check for a hung git process in ${repoRoot}, then land again.` +
        (restoreFailures.length === 0
          ? ""
          : `\nCollision cleanup restoration failed: ${restoreFailures.join("; ")}`),
    );
  }
  if (merge.exitCode !== 0) {
    const restoreFailures = restoreRemoved();
    // Between the diagnosis and the merge, someone else's commit can land. We
    // re-diagnose rather than paraphrase, so the agent is told the *current*
    // reason and not a guess — and if we still cannot explain it, git's own
    // stderr goes through verbatim. It is never discarded.
    const blockerNow = await diagnoseLand(repoRoot, branch, sourceCommit);
    if (blockerNow !== null) {
      const error = landError(branch, blockerNow);
      if (restoreFailures.length === 0) throw error;
      throw new Error(
        `${error.message}\nCollision cleanup restoration failed: ${restoreFailures.join("; ")}`,
        { cause: error },
      );
    }
    const detail = merge.stderr.trim() || merge.stdout.trim() ||
      `git merge exited ${merge.exitCode}`;
    throw new Error(
      `Cannot land ${branch}: ${detail}` +
        (restoreFailures.length === 0
          ? ""
          : `\nCollision cleanup restoration failed: ${restoreFailures.join("; ")}`),
    );
  }
  const revision = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (revision.exitCode !== 0) {
    rethrowAfterRestore(new Error(
      `Landed ${branch}, but could not read the resulting commit: ${
        revision.stderr.trim() || `git rev-parse exited ${revision.exitCode}`
      }`,
    ));
  }
  const landedCommit = trimmed(revision);
  let sourceStillContained = landedCommit === sourceCommit;
  if (!sourceStillContained && sourceWasAlreadyContained) {
    const contains = await runGit(repoRoot, [
      "merge-base",
      "--is-ancestor",
      sourceCommit,
      landedCommit,
    ]);
    sourceStillContained = contains.exitCode === 0;
  }
  if (!sourceStillContained) {
    rethrowAfterRestore(new Error(
      `Cannot land ${branch}: Git reported success but HEAD ${landedCommit} does not contain the resolved source commit ${sourceCommit}; collision cleanup was preserved.`,
    ));
  }
  for (const entry of removed) rmSync(entry.quarantinedPath, { force: true });
  removed.length = 0;
  return { commit: landedCommit };
};

export const landBranch: LandBranch = async (repoRoot, branch, options) => {
  const release = await acquireLandingLease(repoRoot);
  try {
    return await landBranchUnlocked(repoRoot, branch, options);
  } finally {
    release();
  }
};
