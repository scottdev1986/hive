import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { markBranchPreserved } from "../../src/adapters/worktrees";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { SettlementCaseStore } from "../../src/daemon/worktree-lifecycle-service/settlement-case-store";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import type { AgentRecord } from "../../src/schemas/agent";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

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
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-steward-"));
  repoRoot = join(tempRoot, "repo");
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
  await mkdir(repoRoot, { recursive: true });
  const init = Bun.spawn(["git", "init", "-b", "main", repoRoot], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await init.exited;
  await git("config", "user.name", "Hive Test");
  await git("config", "user.email", "hive@example.test");
  await writeFile(join(repoRoot, "README.md"), "# steward\n");
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

function agentRow(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-teardown",
    name: "teardown",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "salvage me",
    worktreePath: null,
    branch: null,
    contextPct: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    lastEventAt: "2026-08-10T12:00:00.000Z",
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

describe("worktree stewardship", () => {
  test("settleTeardownWorktree captures salvage and names it on settlement", async () => {
    const branch = "hive/teardown-salvage";
    const worktree = join(repoRoot, ".hive", "worktrees", "teardown");
    await mkdir(join(repoRoot, ".hive", "worktrees"), { recursive: true });
    await git("worktree", "add", "-b", branch, worktree);
    await writeFile(join(worktree, "wip.ts"), "export const wip = 1;\n");
    await writeFile(join(worktree, "untracked.md"), "scratch\n");

    const db = new HiveDatabase(":memory:");
    const agent = db.insertAgent(
      agentRow({
        worktreePath: worktree,
        branch,
      }),
    );
    const lifecycle = new WorktreeLifecycleService({
      db,
      repoRoot,
      clock: () => new Date("2026-08-10T12:00:00.000Z"),
      publish: async () => {},
      assessStrandedWork: async () => ({
        dirtyFiles: ["wip.ts", "untracked.md"],
        unmergedCommits: 0,
      }),
      listSettlementBranches: async () => [],
      reconcileOrphanedWorktrees: async () => ({
        worktrees: [],
        preservedRefs: { releasable: [], kept: [] },
      }),
    });

    const capture = await lifecycle.captureFinalWorkManifest(agent);
    const forced = {
      ...capture,
      work: {
        dirtyFiles: ["wip.ts", "untracked.md"],
        unmergedCommits: 0,
      },
      checkError: null as string | null,
    };
    const settled = await lifecycle.settleTeardownWorktree({
      agent,
      updated: agent,
      capture: forced,
      at: "2026-08-10T12:00:00.000Z",
      removeWorktree: false,
    });
    expect(settled.preserved?.ref).toBe(`refs/hive-preserved/${branch}`);
    expect(settled.preserved?.salvageRef).toBe(`refs/hive-salvage/${branch}`);
    expect(
      await git("show-ref", "--verify", `refs/hive-salvage/${branch}`),
    ).not.toBe("");

    await expect(
      lifecycle.releaseSalvageableRef(`refs/hive-salvage/${branch}`),
    ).rejects.toThrow("not provably settled");
    await git("update-ref", "-d", `refs/hive-salvage/${branch}`);
    await git("update-ref", "-d", `refs/hive-preserved/${branch}`);
    await git("worktree", "remove", "--force", worktree).catch(() => undefined);
    await git("branch", "-D", branch).catch(() => undefined);
    const cases = new SettlementCaseStore(repoRoot);
    const remaining = (await cases.list("main")).find(
      ({ record }) => record.branch === branch,
    );
    if (remaining !== undefined) await cases.close(remaining);
  });

  test("releasing one stewardship ref does not close a case whose worktree remains", async () => {
    const branch = "hive/partial-bundle";
    const worktree = join(repoRoot, ".hive", "worktrees", "partial-bundle");
    await mkdir(join(repoRoot, ".hive", "worktrees"), { recursive: true });
    await git("worktree", "add", "-b", branch, worktree);
    const db = new HiveDatabase(":memory:");
    const agent = db.insertAgent(
      agentRow({
        id: "agent-partial-bundle",
        name: "partial-bundle",
        status: "dead",
        worktreePath: worktree,
        branch,
      }),
    );
    const lifecycle = new WorktreeLifecycleService({
      db,
      repoRoot,
      clock: () => new Date("2026-08-10T12:00:00.000Z"),
      publish: async () => {},
      assessStrandedWork: async () => ({
        dirtyFiles: [],
        unmergedCommits: 0,
      }),
      listSettlementBranches: async () => [],
      reconcileOrphanedWorktrees: async () => ({
        worktrees: [],
        preservedRefs: { releasable: [], kept: [] },
      }),
      processLiveness: async () => "dead",
    });
    await lifecycle.openSettlementCase(
      agent,
      { path: worktree, branch },
      await git("rev-parse", "main"),
    );
    await markBranchPreserved(repoRoot, branch);

    const ref = `refs/hive-preserved/${branch}`;
    expect(await lifecycle.releaseSalvageableRef(ref)).toEqual({
      released: ref,
    });
    await expect(git("show-ref", "--verify", ref)).rejects.toThrow();
    expect(existsSync(worktree)).toBe(true);
    expect(await git("branch", "--list", branch)).toContain(branch);
    const cases = new SettlementCaseStore(repoRoot);
    const listed = await cases.list("main");
    const forBranch = listed.filter(({ record }) => record.branch === branch);
    expect(forBranch).toHaveLength(1);
    const stored = forBranch[0];
    expect(stored?.record.state).toBe("needs-integration");
    expect(stored?.record.evidenceDigest).not.toBeNull();

    db.close();
    if (stored !== undefined) await cases.close(stored);
    await git("worktree", "remove", "--force", worktree).catch(() => undefined);
    await git("branch", "-D", branch).catch(() => undefined);
  });

  test("opening a second case for the same branch returns the existing case", async () => {
    const store = new SettlementCaseStore(repoRoot);
    const tip = await git("rev-parse", "main");
    const first = await store.open({
      agentId: "agent-identity",
      agentName: "identity",
      generation: 1,
      worktreePath: join(repoRoot, "identity-wt"),
      branch: "hive/identity-branch",
      baseOid: tip,
      now: "2026-08-10T12:00:00.000Z",
      reason: "agent generation owns an active worktree bundle",
    });
    const second = await store.open({
      agentId: null,
      agentName: "identity",
      generation: null,
      worktreePath: null,
      branch: "hive/identity-branch",
      baseOid: tip,
      now: "2026-08-10T12:00:00.000Z",
      reason: "discovered stewardship ref is awaiting settlement",
    });
    expect(second.record.caseId).toBe(first.record.caseId);
    expect(
      (await store.list("main")).filter(
        ({ record }) => record.branch === "hive/identity-branch",
      ),
    ).toHaveLength(1);
    await store.close(first);
  });
});
