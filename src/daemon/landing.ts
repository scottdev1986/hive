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
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export type LandBranch = (
  repoRoot: string,
  branch: string,
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

/** `git status --porcelain` split into the paths that could block a merge. A
 * rename's `XY orig -> new` form is reduced to the destination, which is the
 * path a merge would collide with. */
function dirtyPaths(porcelain: string): Set<string> {
  const paths = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    paths.add(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return paths;
}

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
): Promise<LandBlocker | null> {
  // A lock is the one thing that would genuinely make git *wait*, so it is the
  // one worth catching before we start a 30-second deadline running.
  const lock = join(repoRoot, ".git", "index.lock");
  if (existsSync(lock)) {
    return blocked(
      `another git process holds the index lock in the primary checkout (${lock})`,
      `Fix: wait for that git to finish, or delete ${lock} if no git is running.`,
    );
  }

  const target = await runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  const targetBranch = target.exitCode === 0 ? trimmed(target) : "HEAD";

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

  // Is this actually a fast-forward? Two distinct non-ff cases, and an agent
  // does something different about each, so they must not share a message.
  const canFastForward = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    branch,
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
      branch,
      "HEAD",
    ]);
    if (alreadyIn.exitCode === 0) return null;

    const behind = await runGit(repoRoot, [
      "rev-list",
      "--count",
      `${branch}..HEAD`,
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
      branch,
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

export const landBranch: LandBranch = async (repoRoot, branch) => {
  const blocker = await diagnoseLand(repoRoot, branch);
  if (blocker !== null) throw landError(branch, blocker);

  const merge = await runGit(repoRoot, ["merge", "--ff-only", branch]);
  if (merge.timedOut) {
    throw new Error(
      `Cannot land ${branch}: git merge did not finish within ${
        LAND_GIT_TIMEOUT_MS / 1_000
      }s in ${repoRoot} and was killed. A merge git refuses comes back instantly, so this is a stuck git — a stale lock or a stalled filesystem — not a rejected merge.\n` +
        `Fix: check for a hung git process in ${repoRoot}, then land again.`,
    );
  }
  if (merge.exitCode !== 0) {
    // Between the diagnosis and the merge, someone else's commit can land. We
    // re-diagnose rather than paraphrase, so the agent is told the *current*
    // reason and not a guess — and if we still cannot explain it, git's own
    // stderr goes through verbatim. It is never discarded.
    const blockerNow = await diagnoseLand(repoRoot, branch);
    if (blockerNow !== null) throw landError(branch, blockerNow);
    const detail = merge.stderr.trim() || merge.stdout.trim() ||
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
  return { commit: trimmed(revision) };
};
