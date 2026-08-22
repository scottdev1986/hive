import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DetachedCheckoutError,
  diagnoseLand,
  landBranch,
  NothingToLandError,
  readLandReadiness,
  resolveLandingTargetBranch,
} from "../../src/daemon/landing/landing-service";

// Every case here is built on a real git repo and driven through the real
// landBranch. A landing diagnostic tested only against a mocked git proves
// nothing: the failure mode is a message that disagrees with what git actually
// did, and a mock reports whatever message the test expects and passes.

function gitRun(root: string, args: string[]) {
  return Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function git(root: string, args: string[]): string {
  return gitRun(root, args).stdout.toString().trim();
}

/** `main`, plus a writer branch one commit ahead that touches `app.ts` and adds
 * `feature.ts` and `assets/logo.png` — the latter inside a directory that does
 * not exist on main, so an untracked copy of it collides as a whole directory
 * rather than as a path. */
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-land-"));
  git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "app.ts"), "export const v = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "base", "--no-gpg-sign"]);
  git(root, ["checkout", "-q", "-b", "hive/writer"]);
  await writeFile(join(root, "app.ts"), "export const v = 2;\n");
  await writeFile(join(root, "feature.ts"), "export const f = 1;\n");
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "logo.png"), "logo-bytes-v1\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "writer work", "--no-gpg-sign"]);
  git(root, ["checkout", "-q", "main"]);
  return root;
}

const landFails = async (
  root: string,
  branch = "hive/writer",
): Promise<string> => {
  try {
    await landBranch(root, branch);
  } catch (error) {
    // SAFETY: The test owns this value and its fields.
    return (error as Error).message;
  }
  throw new Error("expected the land to fail, but it succeeded");
};

describe("the repository landing lease", () => {
  test("malformed ownership evidence is preserved and blocks landing", async () => {
    const root = await repo();
    const lock = join(root, ".git", "hive-landing.lock");
    try {
      await writeFile(lock, "not-json\n");
      const message = await landFails(root);
      expect(message).toContain("landing lease ownership is unknown");
      expect(await Bun.file(lock).text()).toBe("not-json\n");
      expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      expect(await Bun.file(join(root, "feature.ts")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a positively dead lease owner can be reclaimed", async () => {
    const root = await repo();
    const lock = join(root, ".git", "hive-landing.lock");
    const ownerPid = 424_242;
    const kill = spyOn(process, "kill").mockImplementation(() => {
      // SAFETY: The test owns this value and its fields.
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    try {
      await writeFile(
        lock,
        `${JSON.stringify({
          pid: ownerPid,
          token: crypto.randomUUID(),
        })}\n`,
      );
      const { commit } = await landBranch(root, "hive/writer");
      expect(commit).toBe(git(root, ["rev-parse", "HEAD"]));
      expect(await Bun.file(lock).exists()).toBe(false);
    } finally {
      kill.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a blocked land says which file blocked it", () => {
  test("a modified file the merge would overwrite is named", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "app.ts"), "export const v = 99; // mine\n");

      const message = await landFails(root);
      expect(message).toContain("app.ts");
      expect(message).toContain(
        "uncommitted changes the merge would overwrite",
      );
      expect(message).toContain("Fix:");
      // The promise the message makes, which the code has to keep.
      expect(message).toContain(
        "will not discard uncommitted changes it did not write",
      );
      // And it kept it: the edit is still there, unmerged and intact.
      expect(await Bun.file(join(root, "app.ts")).text()).toContain("// mine");
      expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an untracked file with different content is named, and the message explains the collision", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "feature.ts"), "my scratch notes\n");
      const message = await landFails(root);
      // Not git's "untracked working tree files would be overwritten by
      // merge" — the user's file and the agent's committed file collide, and
      // the message says whose is whose and what to do next.
      expect(message).toContain("feature.ts");
      expect(message).toContain("differs");
      expect(message).toContain("hive/writer committed");
      expect(message).toContain("Fix:");
      expect(message).toContain("mv feature.ts feature.ts.mine");
      expect(message).not.toContain("untracked working tree files");
      expect(await Bun.file(join(root, "feature.ts")).text()).toBe(
        "my scratch notes\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a dirty tree the merge does not touch is not a blocker at all", async () => {
    const root = await repo();
    try {
      // "The tree is dirty" is not a diagnosis and must not be a refusal: this
      // file has nothing to do with the merge.
      await writeFile(join(root, "scratch.ts"), "export const s = 1;\n");
      const { commit } = await landBranch(root, "hive/writer");
      expect(commit).toHaveLength(40);
      expect(await Bun.file(join(root, "scratch.ts")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("untracked files the branch also adds — the drop-a-file-in incident", () => {
  test("byte-identical: the land proceeds on its own and the content survives, tracked", async () => {
    const root = await repo();
    try {
      // The user's original, byte-for-byte what the agent copied and committed.
      // git would refuse to fast-forward over it; proving identity by hash
      // makes removing it lossless, so this must land with no user involved.
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets", "logo.png"), "logo-bytes-v1\n");
      await writeFile(join(root, "feature.ts"), "export const f = 1;\n");

      const { commit } = await landBranch(root, "hive/writer");
      expect(commit).toHaveLength(40);
      expect(await Bun.file(join(root, "assets", "logo.png")).text()).toBe(
        "logo-bytes-v1\n",
      );
      expect(await Bun.file(join(root, "feature.ts")).text()).toBe(
        "export const f = 1;\n",
      );
      // Not just present: tracked, exactly as the branch committed them.
      expect(git(root, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an untracked directory is seen file-by-file, not skipped as one `dir/` line", async () => {
    const root = await repo();
    try {
      // The whole directory is untracked, so plain `status --porcelain`
      // collapses it to `?? assets/` — which matches no file path. Diagnosis
      // that only compares paths misses the collision entirely and hands the
      // agent git's raw "untracked working tree files would be overwritten".
      await mkdir(join(root, "assets"));
      await writeFile(
        join(root, "assets", "logo.png"),
        "logo-bytes-v2 EDITED BY USER\n",
      );

      const message = await landFails(root);
      expect(message).toContain("assets/logo.png");
      expect(message).toContain("differs");
      expect(message).toContain("Fix:");
      expect(message).not.toContain("untracked working tree files");
      // The user's copy is exactly where they left it, byte for byte.
      expect(await Bun.file(join(root, "assets", "logo.png")).text()).toBe(
        "logo-bytes-v2 EDITED BY USER\n",
      );
      expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("mixed collisions: the differing file blocks, and the identical one is not touched", async () => {
    const root = await repo();
    try {
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets", "logo.png"), "logo-bytes-v1\n"); // identical
      await writeFile(
        join(root, "feature.ts"),
        "not what the agent committed\n",
      ); // differs

      const message = await landFails(root);
      expect(message).toContain("feature.ts");
      expect(message).not.toContain("assets/logo.png");
      // A refused land removes NOTHING — the identical copy is only ever
      // removed on the way into a merge that immediately restores it.
      expect(await Bun.file(join(root, "assets", "logo.png")).text()).toBe(
        "logo-bytes-v1\n",
      );
      expect(await Bun.file(join(root, "feature.ts")).text()).toBe(
        "not what the agent committed\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a land that is not a fast-forward says so, and says which way", () => {
  test("main moved: the agent is told to rebase and retest", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "other.ts"), "export const o = 1;\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "someone landed first", "--no-gpg-sign"]);

      const message = await landFails(root);
      expect(message).toContain("not a fast-forward");
      expect(message).toContain("main has moved on by 1 commit");
      // Rebasing invalidates the green test run the agent just did, so Hive
      // cannot do it for them — this is a genuine Fix:, not a chore Hive dodged.
      expect(message).toContain("git rebase main");
      expect(message).toContain("re-run the tests");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a branch already contained in main is refused instead of reporting current main as landed", async () => {
    const root = await repo();
    try {
      await landBranch(root, "hive/writer");
      const mainBefore = git(root, ["rev-parse", "HEAD"]);

      const refusal = await landBranch(root, "hive/writer").catch(
        (error) => error,
      );
      expect(refusal).toBeInstanceOf(NothingToLandError);
      expect(git(root, ["rev-parse", "HEAD"])).toBe(mainBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the remaining ways a land dies", () => {
  test("a missing branch is named", async () => {
    const root = await repo();
    try {
      const message = await landFails(root, "hive/ghost");
      expect(message).toContain("hive/ghost");
      expect(message).toContain("does not exist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a held index.lock is named, with its path", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, ".git", "index.lock"), "");
      const message = await landFails(root);
      // The one condition that would genuinely make git *wait*, so it is caught
      // before a 30-second deadline starts running rather than after.
      expect(message).toContain("index lock");
      expect(message).toContain(join(root, ".git", "index.lock"));
      expect(message).toContain("Fix:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no failure anywhere reports a timeout that did not happen", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "app.ts"), "export const v = 99;\n");
      const dirty = await landFails(root);
      git(root, ["checkout", "--", "app.ts"]);
      const missing = await landFails(root, "hive/ghost");

      for (const message of [dirty, missing]) {
        expect(message).not.toContain("timed out");
        expect(message).not.toContain("30000ms");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a clean fast-forward still just works", async () => {
    const root = await repo();
    try {
      expect(await diagnoseLand(root, "hive/writer")).toBeNull();
      const { commit } = await landBranch(root, "hive/writer");
      expect(commit).toBe(git(root, ["rev-parse", "HEAD"]));
      expect(await Bun.file(join(root, "feature.ts")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a detached primary is a refusal, never a fabricated target", () => {
  test("the target resolver throws the typed detachment instead of returning 'HEAD'", async () => {
    const root = await repo();
    try {
      const tip = git(root, ["rev-parse", "HEAD"]);
      git(root, ["checkout", "-q", "--detach", "HEAD"]);

      await expect(resolveLandingTargetBranch(root)).rejects.toBeInstanceOf(
        DetachedCheckoutError,
      );
      // Readiness measures the position honestly: a HEAD sha, and NO branch
      // name — a detached checkout has no "current branch" to report.
      const readiness = await readLandReadiness(root, "hive/writer");
      expect(readiness.targetBranch).toBeNull();
      expect(readiness.targetHead).toBe(tip);

      const message = await landFails(root);
      expect(message).toContain("detached");
      expect(message).toContain(tip);
      expect(message).not.toContain("git rebase HEAD");
      // Nothing moved: the writer branch is still unlanded.
      expect(
        gitRun(root, ["merge-base", "--is-ancestor", "hive/writer", "main"])
          .exitCode,
      ).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a landing never carries another ref's unlanded commits", () => {
  /** `main` plus two writers with independent work: hive/writer one commit, hive/other two. */
  async function sharedRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "hive-land-"));
    git(root, ["init", "-b", "main"]);
    await writeFile(join(root, "app.ts"), "export const v = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "base", "--no-gpg-sign"]);
    git(root, ["checkout", "-q", "-b", "hive/other"]);
    await writeFile(join(root, "o1.ts"), "export const o1 = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "other one", "--no-gpg-sign"]);
    await writeFile(join(root, "o2.ts"), "export const o2 = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "other two", "--no-gpg-sign"]);
    git(root, ["checkout", "-q", "main"]);
    git(root, ["checkout", "-q", "-b", "hive/writer"]);
    await writeFile(join(root, "feature.ts"), "export const f = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "writer work", "--no-gpg-sign"]);
    git(root, ["checkout", "-q", "main"]);
    return root;
  }

  test("the 2026-08-13 absorption, replayed: detached primary, remedy followed, second land — now refused", async () => {
    const root = await sharedRepo();
    try {
      const mainTip = git(root, ["rev-parse", "main"]);
      const otherTip = git(root, ["rev-parse", "hive/other"]);

      // The primary sits detached at the other writer's unlanded tip, exactly
      // as it did for six minutes that day.
      git(root, ["checkout", "-q", otherTip]);
      const first = await landFails(root);
      expect(first).toContain("detached");
      expect(first).toContain(otherTip);
      expect(first).not.toContain("git rebase HEAD");

      // The agent does exactly what the old refusal's Fix line said: rebase
      // onto HEAD — the other branch's tip.
      git(root, ["checkout", "-q", "hive/writer"]);
      git(root, ["rebase", "-q", otherTip]);
      expect(
        gitRun(root, ["merge-base", "--is-ancestor", otherTip, "hive/writer"])
          .exitCode,
      ).toBe(0);
      git(root, ["checkout", "-q", "main"]);

      // The second land — the one that carried the other writer's commits onto
      // main — is now refused, and names their owner.
      const second = await landFails(root);
      expect(second).toContain(
        "would also land work it was not authorized to carry",
      );
      expect(second).toContain("refs/heads/hive/other");
      expect(second).toContain(otherTip);
      expect(second).toContain("git rebase --onto main");
      expect(second).not.toContain("git rebase HEAD");
      // Nothing moved: main is untouched and the other branch is still unlanded.
      expect(git(root, ["rev-parse", "main"])).toBe(mainTip);
      expect(
        gitRun(root, ["merge-base", "--is-ancestor", "hive/other", "main"])
          .exitCode,
      ).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an independent branch is not blocked by another writer's unlanded branch", async () => {
    const root = await sharedRepo();
    try {
      const writerTip = git(root, ["rev-parse", "hive/writer"]);
      const landed = await landBranch(root, "hive/writer");
      expect(landed.commit).toBe(writerTip);
      expect(landed.landedCommits).toEqual([writerTip]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("following the refusal's remedy lands, and the receipt names exactly the branch's own commits", async () => {
    const root = await sharedRepo();
    try {
      const otherTip = git(root, ["rev-parse", "hive/other"]);
      git(root, ["checkout", "-q", "hive/writer"]);
      git(root, ["rebase", "-q", otherTip]);
      // The remedy the refusal names: replay only the branch's own commits
      // onto the target, dropping the foreign prefix.
      git(root, ["rebase", "-q", "--onto", "main", otherTip]);
      git(root, ["checkout", "-q", "main"]);

      const writerTip = git(root, ["rev-parse", "hive/writer"]);
      const landed = await landBranch(root, "hive/writer");
      expect(landed.commit).toBe(writerTip);
      expect(landed.landedCommits).toEqual([writerTip]);
      // The other branch's commits never touched main.
      expect(
        gitRun(root, ["merge-base", "--is-ancestor", "hive/other", "main"])
          .exitCode,
      ).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abandoned claimant stops blocking once its ref is gone, and the receipt names what landed", async () => {
    const root = await sharedRepo();
    try {
      const otherFirst = git(root, ["rev-parse", "hive/other~1"]);
      const otherTip = git(root, ["rev-parse", "hive/other"]);
      git(root, ["checkout", "-q", "hive/writer"]);
      git(root, ["rebase", "-q", otherTip]);
      git(root, ["checkout", "-q", "main"]);
      // The deliberate act the Fix line names: the owning branch is deleted,
      // so its commits no longer have a claimant.
      git(root, ["branch", "-q", "-D", "hive/other"]);

      const writerTip = git(root, ["rev-parse", "hive/writer"]);
      const landed = await landBranch(root, "hive/writer");
      expect(landed.commit).toBe(writerTip);
      // All three commits landed — the two adopted ones included — and the
      // receipt names every one, oldest first.
      expect(landed.landedCommits).toEqual([otherFirst, otherTip, writerTip]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The measurement the re-arm decision rests on. Driven through real git for the
// same reason as everything above: a mocked git would answer whatever the
// decision wanted to hear.
describe("readLandReadiness", () => {
  test("a branch with work, rebased on main, measures as landable", async () => {
    const root = await repo();
    try {
      expect(await readLandReadiness(root, "hive/writer")).toEqual({
        pending: 1,
        rebased: true,
        targetBranch: "main",
        targetHead: git(root, ["rev-parse", "HEAD"]),
        baseSha: git(root, ["merge-base", "HEAD", "hive/writer"]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a branch that already landed has nothing pending", async () => {
    const root = await repo();
    try {
      await landBranch(root, "hive/writer");
      expect(await readLandReadiness(root, "hive/writer")).toEqual({
        pending: 0,
        rebased: true,
        targetBranch: "main",
        targetHead: git(root, ["rev-parse", "HEAD"]),
        baseSha: git(root, ["merge-base", "HEAD", "hive/writer"]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a branch main has moved past is not rebased", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "other.ts"), "export const o = 1;\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "main moves", "--no-gpg-sign"]);
      expect(await readLandReadiness(root, "hive/writer")).toEqual({
        pending: 1,
        rebased: false,
        targetBranch: "main",
        targetHead: git(root, ["rev-parse", "HEAD"]),
        baseSha: git(root, ["merge-base", "HEAD", "hive/writer"]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a branch git cannot read measures unknown, never zero and never false", async () => {
    const root = await repo();
    try {
      expect(await readLandReadiness(root, "hive/no-such-branch")).toEqual({
        pending: null,
        rebased: null,
        targetBranch: "main",
        targetHead: git(root, ["rev-parse", "HEAD"]),
        baseSha: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
