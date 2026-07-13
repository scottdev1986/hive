import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import { writeGrokAgentConfig } from "./tools/grok";
import {
  assessStrandedWork,
  createWorktree,
  listUnmergedHiveBranches,
  listWorktrees,
  markBranchPreserved,
  observedWorktreeFiles,
  removeWorktree,
  slugify,
} from "./worktrees";

let tempRoot = "";
let repoRoot = "";
let previousHiveHome: string | undefined;

async function git(...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim());
  }
  return stdout.trim();
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-worktrees-"));
  repoRoot = join(tempRoot, "repo");
  await writeFile(join(tempRoot, ".keep"), "");

  const mkdirProcess = Bun.spawn(["mkdir", "-p", repoRoot], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await mkdirProcess.exited;

  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");

  await git("init", "-b", "main");
  await git("config", "user.name", "Hive Test");
  await git("config", "user.email", "hive@example.test");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git("add", "README.md");
  await git("commit", "-m", "initial");
});

afterAll(async () => {
  if (previousHiveHome === undefined) {
    delete Bun.env.HIVE_HOME;
  } else {
    Bun.env.HIVE_HOME = previousHiveHome;
  }
  if (tempRoot !== "") {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("git worktree manager", () => {
  test("slugifies task names into bounded, non-empty branch components", () => {
    expect(slugify("  Fix OAuth / Callback!  ")).toEqual("fix-oauth-callback");
    expect(slugify("---")).toEqual("task");
    expect(slugify("ABCDEFGHIJKLMNOPQRSTUVWXYZ 1234567890")).toEqual(
      "abcdefghijklmnopqrstuvwxyz-123",
    );
    expect(slugify("Ends----------------After Limit").length <= 30).toEqual(true);
  });

  test("creates, lists, and force-removes a worktree with untracked config", async () => {
    const created = await createWorktree(repoRoot, "agent-3", "auth-api");

    expect(created).toEqual({
      path: join(repoRoot, ".hive", "worktrees", "agent-3"),
      branch: "hive/agent-3-auth-api",
    });
    expect(await git("branch", "--show-current")).toEqual("main");

    const listed = await listWorktrees(repoRoot);
    expect(
      listed.some(
        (worktree) =>
          worktree.path.endsWith("/.hive/worktrees/agent-3") &&
          worktree.branch === created.branch,
      ),
    ).toEqual(true);

    await mkdir(join(created.path, ".claude"), { recursive: true });
    await writeFile(join(created.path, ".claude", "settings.local.json"), "{}\n");

    await removeWorktree(repoRoot, created.path, { deleteBranch: true });
    expect(
      (await listWorktrees(repoRoot)).some(
        (worktree) => worktree.branch === created.branch,
      ),
    ).toEqual(false);
    expect((await git("branch", "--list", created.branch)).trim()).toEqual("");
  });

  test("refuses tracked changes unless discardTracked explicitly overrides", async () => {
    const created = await createWorktree(repoRoot, "agent-5", "tracked-safety");
    await writeFile(join(created.path, "README.md"), "changed tracked file\n");

    let message = "";
    try {
      await removeWorktree(repoRoot, created.path, { deleteBranch: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes("uncommitted changes to tracked files")).toEqual(true);
    expect(message.includes("README.md")).toEqual(true);
    expect(
      (await listWorktrees(repoRoot)).some(
        (worktree) => worktree.branch === created.branch,
      ),
    ).toEqual(true);

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
      force: false,
    });
    expect((await git("branch", "--list", created.branch)).trim()).toEqual("");
  });

  test("unregisters and cleans up a branch after manual directory deletion", async () => {
    const created = await createWorktree(repoRoot, "agent-6", "manual-delete");
    await rm(created.path, { recursive: true, force: true });

    await removeWorktree(repoRoot, created.path, { deleteBranch: true });

    expect(
      (await listWorktrees(repoRoot)).some(
        (worktree) => worktree.path === created.path,
      ),
    ).toEqual(false);
    expect((await git("branch", "--list", created.branch)).trim()).toEqual("");
  });

  test("missing-worktree cleanup never unregisters a different missing worktree", async () => {
    const target = await createWorktree(repoRoot, "agent-target", "missing");
    const sibling = await createWorktree(repoRoot, "agent-other", "missing");
    const siblingPath = await realpath(sibling.path);
    await rm(target.path, { recursive: true, force: true });
    await rm(sibling.path, { recursive: true, force: true });

    try {
      await removeWorktree(repoRoot, target.path, { deleteBranch: true });
      expect(await listWorktrees(repoRoot)).toContainEqual({
        path: siblingPath,
        branch: sibling.branch,
      });
    } finally {
      await removeWorktree(repoRoot, sibling.path, {
        deleteBranch: true,
        branch: sibling.branch,
      });
    }
  });

  test("reports no stranded work for a clean, fully merged branch", async () => {
    const created = await createWorktree(repoRoot, "agent-7", "clean-landing");

    expect(await assessStrandedWork(repoRoot, created.path, created.branch))
      .toEqual({ dirtyFiles: [], unmergedCommits: 0 });

    await removeWorktree(repoRoot, created.path, { deleteBranch: true });
  });

  // Measured on the real agent bridget: `dirtyFiles: [".grok/"]`,
  // `unmergedCommits: 0`. Dirty files mean "this agent still holds work", so
  // Hive refused to reap her -- and since Hive writes that file into EVERY
  // grok worktree at spawn, every grok agent was born permanently unfinished
  // and could never be auto-reaped. They pile up forever.
  test("hive's own grok wiring is not the agent's work, and never blocks a reap", async () => {
    const created = await createWorktree(repoRoot, "agent-grok", "grok-wiring");
    await writeGrokAgentConfig(created.path, { daemonPort: 4711 });

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded).toEqual({ dirtyFiles: [], unmergedCommits: 0 });

    // And the exclusion is exactly that one file -- it does not blind the
    // check to anything else under .grok/, which would be a way to lose work.
    await writeFile(join(created.path, ".grok", "notes.md"), "real work\n");
    const withWork = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(withWork.dirtyFiles).toEqual([".grok/notes.md"]);

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
    });
  });

  test("counts unmerged commits and lists dirty files as stranded work", async () => {
    const created = await createWorktree(repoRoot, "agent-8", "stranded");
    const worktreeGit = async (...args: string[]) => {
      const process = Bun.spawn(["git", "-C", created.path, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(stderr.trim());
      }
    };
    await writeFile(join(created.path, "committed.txt"), "landed nowhere\n");
    await worktreeGit("add", "committed.txt");
    await worktreeGit("commit", "-m", "stranded commit");
    await writeFile(join(created.path, "uncommitted.txt"), "dirty\n");
    await writeFile(join(created.path, "README.md"), "tracked edit\n");

    const stranded = await assessStrandedWork(
      repoRoot,
      created.path,
      created.branch,
    );
    expect(stranded.unmergedCommits).toEqual(1);
    expect(stranded.dirtyFiles.sort()).toEqual([
      "README.md",
      "uncommitted.txt",
    ]);
    expect(await observedWorktreeFiles(repoRoot, created.path, created.branch))
      .toEqual(["README.md", "committed.txt", "uncommitted.txt"]);

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
    });
  });

  test("marks an unmerged branch as intentionally preserved", async () => {
    const created = await createWorktree(repoRoot, "agent-preserved", "design");
    await writeFile(join(created.path, "design.md"), "kept deliberately\n");
    await git("-C", created.path, "add", "design.md");
    await git("-C", created.path, "commit", "-m", "preserved design");
    await markBranchPreserved(repoRoot, created.branch, true);
    expect((await listUnmergedHiveBranches(repoRoot)).find((entry) =>
      entry.branch === created.branch
    )?.preserved).toEqual(true);
    await markBranchPreserved(repoRoot, created.branch, false);
    await removeWorktree(repoRoot, created.path, { deleteBranch: true, discardTracked: true });
  });

  // Measured on the real agent dominic: its worktree directory was already
  // gone and its registration already pruned when the kill arrived, so
  // `git worktree list` had nothing to look up -- and a branch delete that can
  // only see that list deleted nothing, returned success, and left the branch
  // (1 unmerged commit) sitting in the repo while the caller recorded it as
  // removed. The branch the caller passes is the authority.
  test("deletes the branch even when the worktree registration is already gone", async () => {
    const created = await createWorktree(repoRoot, "agent-vanished", "gone");
    await writeFile(join(created.path, "wip.txt"), "unmerged\n");
    await git("-C", created.path, "add", "wip.txt");
    await git("-C", created.path, "commit", "-m", "unmerged wip");

    // The directory disappears and git forgets the worktree ever existed.
    await rm(created.path, { recursive: true, force: true });
    await git("worktree", "prune");
    expect(await listWorktrees(repoRoot)).not.toContainEqual(
      expect.objectContaining({ branch: created.branch }),
    );

    await removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      discardTracked: true,
      branch: created.branch,
    });

    expect((await git("branch", "--list", created.branch)).trim()).toEqual("");
  });

  test("refuses to remove a worktree owned by another Hive instance", async () => {
    const created = await createWorktree(repoRoot, "agent-sibling", "owned");
    const ownRef = `refs/hive-owner/${hiveInstanceSuffix()}/${created.branch}`;
    const siblingRef = `refs/hive-owner/sibling-instance/${created.branch}`;
    await git("update-ref", "-d", ownRef);
    await git("update-ref", siblingRef, created.branch);

    try {
      expect(removeWorktree(repoRoot, created.path, {
        deleteBranch: true,
        branch: created.branch,
      })).rejects.toThrow("another Hive instance");
      expect((await git("branch", "--list", created.branch)).trim())
        .toContain(created.branch);
    } finally {
      await git("update-ref", "-d", siblingRef);
      if ((await git("branch", "--list", created.branch)).trim() !== "") {
        await git("update-ref", ownRef, created.branch);
        await removeWorktree(repoRoot, created.path, {
          deleteBranch: true,
          discardTracked: true,
          branch: created.branch,
        });
      }
    }
  });

  test("only the default instance may clean up ownerless legacy worktrees", async () => {
    const created = await createWorktree(repoRoot, "agent-legacy", "ownerless");
    const ownRef = `refs/hive-owner/${hiveInstanceSuffix()}/${created.branch}`;
    await git("update-ref", "-d", ownRef);

    expect(removeWorktree(repoRoot, created.path, {
      deleteBranch: true,
      branch: created.branch,
    })).rejects.toThrow("ownerless legacy branch outside the default");

    const namedHome = Bun.env.HIVE_HOME;
    Bun.env.HIVE_HOME = join(homedir(), ".hive");
    try {
      await removeWorktree(repoRoot, created.path, {
        deleteBranch: true,
        branch: created.branch,
      });
      expect((await git("branch", "--list", created.branch)).trim()).toBe("");
    } finally {
      if (namedHome === undefined) delete Bun.env.HIVE_HOME;
      else Bun.env.HIVE_HOME = namedHome;
    }
  });

  test("treats a deleted worktree directory and missing branch as nothing stranded", async () => {
    expect(await assessStrandedWork(
      repoRoot,
      join(repoRoot, ".hive", "worktrees", "gone"),
      "hive/gone-task",
    )).toEqual({ dirtyFiles: [], unmergedCommits: 0 });
  });

  test("surfaces git stderr", async () => {
    let message = "";
    try {
      await createWorktree(join(tempRoot, "not-a-repo"), "agent-4", "task");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.includes("not a git repository")).toEqual(true);
  });
});

describe("unmerged hive branch inventory", () => {
  test("finds a branch holding commits that never reached main", async () => {
    // Built the way david's branch was: a hive/* branch with a commit on it,
    // whose worktree is long gone. The ref is the only surviving trace.
    await git("branch", "hive/david-channels", "main");
    const worktree = join(tempRoot, "david-wt");
    await git("worktree", "add", worktree, "hive/david-channels");
    await writeFile(join(worktree, "channels.ts"), "export const x = 1;\n");
    const inWorktree = async (...args: string[]) => {
      const process = Bun.spawn(["git", "-C", worktree, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await process.exited;
    };
    await inWorktree("add", "channels.ts");
    await inWorktree("commit", "-m", "rescue david's channels work");
    await git("worktree", "remove", "--force", worktree);

    const stranded = await listUnmergedHiveBranches(repoRoot);

    expect(stranded).toEqual([
      {
        branch: "hive/david-channels",
        tip: await git("rev-parse", "hive/david-channels"),
        unmergedCommits: 1,
      },
    ]);
  });

  test("ignores a hive branch whose commits are already on main", async () => {
    await git("branch", "hive/landed-work", "main");

    const stranded = await listUnmergedHiveBranches(repoRoot);

    expect(stranded.map((entry) => entry.branch)).not.toContain(
      "hive/landed-work",
    );
  });

  test("reports nothing rather than throwing when main does not exist", async () => {
    const bare = await mkdtemp(join(tmpdir(), "hive-no-main-"));
    const init = Bun.spawn(["git", "-C", bare, "init", "-b", "trunk"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await init.exited;
    try {
      expect(await listUnmergedHiveBranches(bare)).toEqual([]);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
