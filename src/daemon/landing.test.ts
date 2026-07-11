import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseLand, landBranch, runGit } from "./landing";

// Every case here is built on a real git repo and driven through the real
// landBranch. A landing diagnostic that is only ever tested against a mocked git
// proves nothing: the whole bug was that the message and the reality disagreed,
// and a mock would have happily reported the wrong message and passed.

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
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
  return result.stdout.toString().trim();
}

/** `main`, plus a writer branch one commit ahead that touches `app.ts` and adds
 * `feature.ts`. */
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-land-"));
  git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "app.ts"), "export const v = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "base", "--no-gpg-sign"]);
  git(root, ["checkout", "-q", "-b", "hive/writer"]);
  await writeFile(join(root, "app.ts"), "export const v = 2;\n");
  await writeFile(join(root, "feature.ts"), "export const f = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "writer work", "--no-gpg-sign"]);
  git(root, ["checkout", "-q", "main"]);
  return root;
}

const landFails = async (root: string, branch = "hive/writer"): Promise<string> => {
  try {
    await landBranch(root, branch);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the land to fail, but it succeeded");
};

describe("runGit", () => {
  test("a fast failure is not a timeout — the bug the landing path shipped", async () => {
    const root = await repo();
    try {
      const result = await runGit(root, ["merge", "--ff-only", "no-such-branch"]);
      // Bun sets `Subprocess.killed` on *any* exited process, so the old code's
      // `if (proc.killed && exitCode !== 0)` fired here and reported "git merge
      // timed out after 30000ms" — for a command that failed in milliseconds and
      // had already said precisely what was wrong. The flag must come from our
      // own deadline firing, and nowhere else.
      expect(result.exitCode).not.toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain("not something we can merge");
    } finally {
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
      expect(message).toContain("uncommitted changes the merge would overwrite");
      expect(message).toContain("Fix:");
      // The promise the message makes, which the code has to keep.
      expect(message).toContain("will not discard uncommitted changes it did not write");
      // And it kept it: the edit is still there, unmerged and intact.
      expect(await Bun.file(join(root, "app.ts")).text()).toContain("// mine");
      expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an untracked file standing where the merge would write one is named", async () => {
    const root = await repo();
    try {
      await writeFile(join(root, "feature.ts"), "my scratch notes\n");
      const message = await landFails(root);
      expect(message).toContain("feature.ts");
      expect(await Bun.file(join(root, "feature.ts")).text()).toBe("my scratch notes\n");
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

  test("a branch already contained in main lands as the no-op it is", async () => {
    const root = await repo();
    try {
      const { commit: first } = await landBranch(root, "hive/writer");
      // Landing twice is idempotent, not an error: every commit on the branch is
      // already on main. It is *also* not a fast-forward, so the diverged path
      // above would have told the agent its work was rejected while it sat on main.
      const { commit: again } = await landBranch(root, "hive/writer");
      expect(again).toBe(first);
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
