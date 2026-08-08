import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as gitAdapter from "../../src/adapters/git";
import {
  listSettlementBranches,
  reconcileOrphanedWorktrees,
} from "../../src/adapters/worktrees";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { SettlementCaseStore } from "../../src/daemon/worktree-lifecycle-service/settlement-case-store";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const roots: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(async () => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]): Promise<string> {
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")}`);
  return stdout.trim();
}

async function fixtureRepo(): Promise<{ repo: string; tip: string }> {
  const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "case-store-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "# cases\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return { repo, tip: await git(repo, "rev-parse", "HEAD") };
}

function recordGitArgs(): string[][] {
  const calls: string[][] = [];
  const original = gitAdapter.runGit;
  spies.push(
    spyOn(gitAdapter, "runGit").mockImplementation(
      async (cwd, args, options) => {
        calls.push(args);
        return original(cwd, args, options);
      },
    ),
  );
  return calls;
}

function blobOidsRead(calls: string[][]): string[] {
  return calls
    .filter((args) => args[0] === "cat-file" && args[1] === "blob")
    .map((args) => args[2] ?? "");
}

function openInput(
  tip: string,
  branch: string,
  extras: {
    agentId?: string | null;
    worktreePath?: string | null;
  } = {},
) {
  return {
    agentId: extras.agentId === undefined ? null : extras.agentId,
    agentName: "lookup",
    generation: extras.agentId ? 1 : null,
    worktreePath:
      extras.worktreePath === undefined ? null : extras.worktreePath,
    branch,
    baseOid: tip,
    now: "2026-08-13T12:00:00.000Z",
    reason: "discovered unlanded branch is awaiting settlement",
  };
}

describe("settlement case store lookup cost", () => {
  test("ref inventory refuses a missing landing target", async () => {
    const { repo } = await fixtureRepo();
    await git(repo, "update-ref", "-d", "refs/heads/main");

    await expect(new SettlementCaseStore(repo).list("main")).rejects.toThrow(
      "settlement ref inventory positive control failed: refs/heads/main is absent",
    );
  });

  test("list then open a missing branch does not re-read every open case", async () => {
    const { repo, tip } = await fixtureRepo();
    const seed = new SettlementCaseStore(repo);
    const existingOids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const stored = await seed.open(
        openInput(tip, `hive/existing-${String(index).padStart(2, "0")}`),
      );
      existingOids.push(stored.objectOid);
    }

    const store = new SettlementCaseStore(repo);
    const calls = recordGitArgs();
    const listed = await store.list("main");
    expect(listed).toHaveLength(20);
    const listedOids = blobOidsRead(calls);
    for (const oid of existingOids) {
      expect(listedOids).toContain(oid);
    }

    const afterList = calls.length;
    await store.open(openInput(tip, "hive/missing-branch"));
    const afterOpen = calls.slice(afterList);
    expect(
      blobOidsRead(afterOpen).filter((oid) => existingOids.includes(oid)),
    ).toEqual([]);
    expect(afterOpen.filter((args) => args[0] === "for-each-ref")).toEqual([]);
  });

  test("opening many new branches does not re-read cases written earlier in the same store", async () => {
    const { repo, tip } = await fixtureRepo();
    const store = new SettlementCaseStore(repo);
    const calls = recordGitArgs();
    const writtenOids: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const stored = await store.open(
        openInput(tip, `hive/fresh-${String(index).padStart(2, "0")}`),
      );
      writtenOids.push(stored.objectOid);
    }
    const rereads = blobOidsRead(calls).filter((oid, position, all) => {
      const firstWriteBack = all.indexOf(oid);
      return firstWriteBack !== -1 && position > firstWriteBack;
    });
    expect(rereads).toEqual([]);
    expect(blobOidsRead(calls)).toHaveLength(16);
    expect(writtenOids).toHaveLength(16);
  });

  test("a second open for the same branch still returns the existing case after list", async () => {
    const { repo, tip } = await fixtureRepo();
    const store = new SettlementCaseStore(repo);
    const first = await store.open(
      openInput(tip, "hive/shared", {
        agentId: "agent-identity",
        worktreePath: join(repo, "identity-wt"),
      }),
    );
    await store.list("main");
    const second = await store.open(openInput(tip, "hive/shared"));
    expect(second.record.caseId).toBe(first.record.caseId);
    expect(second.record.worktreePath).toBe(join(repo, "identity-wt"));
    expect(
      (await store.list("main")).filter(
        ({ record }) => record.branch === "hive/shared",
      ),
    ).toHaveLength(1);
  });
});

describe("reconciliation case-store reads per sweep", () => {
  test("an unowned-branch miss does not scan every open case", async () => {
    const { repo, tip } = await fixtureRepo();
    const seed = new SettlementCaseStore(repo);
    const existingOids: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const branch = `hive/reconcile-${String(index).padStart(2, "0")}`;
      await git(repo, "branch", branch);
      const stored = await seed.open(openInput(tip, branch));
      existingOids.push(stored.objectOid);
    }
    for (let index = 0; index < 6; index += 1) {
      await git(repo, "branch", `hive/miss-${String(index).padStart(2, "0")}`);
    }

    const db = new HiveDatabase(":memory:");
    const lifecycle = new WorktreeLifecycleService({
      db,
      repoRoot: repo,
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      publish: async () => {},
      assessStrandedWork: async () => ({
        dirtyFiles: [],
        unmergedCommits: 0,
      }),
      listSettlementBranches,
      reconcileOrphanedWorktrees,
    });
    const calls = recordGitArgs();
    await lifecycle.reconcileOrphanedWorktrees();
    const listedThenReread = blobOidsRead(calls).filter(
      (oid, position, all) => {
        return existingOids.includes(oid) && all.indexOf(oid) !== position;
      },
    );
    expect(listedThenReread).toEqual([]);
    db.close();
  });
});
