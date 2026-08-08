import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unavailableAgentNames } from "../../src/adapters/worktrees";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hive Test",
      GIT_AUTHOR_EMAIL: "hive@example.test",
      GIT_COMMITTER_NAME: "Hive Test",
      GIT_COMMITTER_EMAIL: "hive@example.test",
    },
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
}

/**
 * A repository holding one branch and nothing else that could reserve a name:
 * no `.hive/worktrees` directory and no registered worktree. The branch is
 * therefore the only thing that can make a name unavailable, so these tests
 * measure the branch-name rule and not one of the other two reasons.
 */
async function repoHoldingBranch(branch: string): Promise<string> {
  const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "name-reuse-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "# name reuse\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "branch", branch);
  return repo;
}

describe("an agent name is unavailable while branches minted under it exist", () => {
  test("the name that minted the branch cannot be reissued", async () => {
    const repo = await repoHoldingBranch("hive/maya-proof");

    // Reissuing "maya" here would mint hive/maya-<slug> a second time and
    // collide with work that still exists; settlement also reads this name to
    // attribute a branch its agent's row no longer points at.
    expect(await unavailableAgentNames(repo, ["maya"])).toEqual(
      new Set(["maya"]),
    );
  });

  test("an unrelated name stays free", async () => {
    const repo = await repoHoldingBranch("hive/maya-proof");

    // Without this the pool would report every name taken and spawning would
    // starve as soon as any branch existed.
    expect(await unavailableAgentNames(repo, ["nadia"])).toEqual(new Set());
  });

  test("a shorter name is not claimed by a longer name's branch", async () => {
    const repo = await repoHoldingBranch("hive/maya-proof");

    // The separator after the name is what distinguishes them: "may" never
    // minted hive/maya-proof, so retiring maya must not strand may.
    expect(await unavailableAgentNames(repo, ["may"])).toEqual(new Set());
  });

  test("the three answers come from one query over the same repository", async () => {
    const repo = await repoHoldingBranch("hive/maya-proof");

    // Asked together, so a candidate list is partitioned rather than each name
    // being decided by a separate call that could disagree.
    expect(await unavailableAgentNames(repo, ["maya", "may", "nadia"])).toEqual(
      new Set(["maya"]),
    );
  });
});
