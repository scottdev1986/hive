import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  listWorktrees,
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

  test("prunes and cleans up a branch after manual directory deletion", async () => {
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
