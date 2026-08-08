import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessStrandedWork,
  createWorktree,
  listSettlementBranches,
  reconcileOrphanedWorktrees,
} from "../../src/adapters/worktrees";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { landAgent } from "../../src/daemon/landing/landing-service";
import { SettlementCaseStore } from "../../src/daemon/worktree-lifecycle-service/settlement-case-store";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import type { AgentRecord } from "../../src/schemas/agent";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const roots: string[] = [];

afterEach(async () => {
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
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

const NOW = "2026-08-15T12:00:00.000Z";

async function repo(): Promise<string> {
  const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "settlement-retask-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "# retask settlement\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return repo;
}

function insertAgent(
  db: HiveDatabase,
  input: {
    name: string;
    status: AgentRecord["status"];
    worktreePath: string;
    branch: string;
  },
): AgentRecord {
  return db.insertAgent({
    id: `agent-${input.name}`,
    name: input.name,
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "complex_coding",
    status: input.status,
    taskDescription: "prove retask attribution",
    worktreePath: input.worktreePath,
    branch: input.branch,
    contextPct: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    lastEventAt: "2026-08-12T12:00:00.000Z",
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  });
}

function lifecycle(
  db: HiveDatabase,
  repoRoot: string,
  liveness: "live" | "dead" | "unknown",
): WorktreeLifecycleService {
  return new WorktreeLifecycleService({
    db,
    repoRoot,
    clock: () => new Date(NOW),
    publish: async () => {},
    assessStrandedWork,
    listSettlementBranches,
    reconcileOrphanedWorktrees,
    processLiveness: async () => liveness,
  });
}

/** The record the defective sweep wrote for a retasked agent's second branch. */
async function openUnownedNeedsIntegrationCase(
  store: SettlementCaseStore,
  input: {
    branch: string;
    baseOid: string;
    worktreePath: string | null;
    unmergedCommits: number;
  },
): Promise<string> {
  const opened = await store.open({
    agentId: null,
    agentName: null,
    generation: null,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseOid: input.baseOid,
    now: NOW,
    reason: "discovered unlanded branch is awaiting settlement",
  });
  const updated = await store.update(opened, {
    ...opened.record,
    state: "needs-integration",
    owner: "resolver",
    reason: `${input.unmergedCommits} commit(s) are not accounted for on main`,
    due: { nextActionAt: NOW, watchedTrigger: null },
    blockedOn: null,
    reviewAt: null,
    proofDigest: null,
  });
  return updated.record.caseId;
}

/** Retask the agent in place: same worktree, a new branch with real commits. */
async function cutSecondBranch(
  worktreePath: string,
  branch: string,
): Promise<string> {
  // Files are named for the branch so an agent can be retasked more than once:
  // repeating a name would stage no change and the commit would fail.
  const slug = branch.replaceAll("/", "-");
  await git(worktreePath, "checkout", "-b", branch);
  for (const commit of ["first", "second"]) {
    const file = `${slug}-${commit}.txt`;
    await writeFile(join(worktreePath, file), `${commit}\n`);
    await git(worktreePath, "add", file);
    await git(worktreePath, "commit", "-m", commit);
  }
  return git(worktreePath, "rev-parse", "HEAD");
}

describe("settlement attribution for a retasked agent", () => {
  test("a live agent's second branch is bound to the agent, not to an unowned resolver case", async () => {
    const repoRoot = await repo();
    const spawnBase = await git(repoRoot, "rev-parse", "main");
    const worktree = await createWorktree(repoRoot, "maya", "proof");
    const db = new HiveDatabase(":memory:");
    try {
      const agent = insertAgent(db, {
        name: "maya",
        status: "working",
        worktreePath: worktree.path,
        branch: worktree.branch,
      });
      const service = lifecycle(db, repoRoot, "live");
      await service.openSettlementCase(agent, worktree, spawnBase);

      // main moves on, then the retasked agent cuts a second branch in the
      // same worktree and commits real work on it.
      await writeFile(join(repoRoot, "main.txt"), "main\n");
      await git(repoRoot, "add", "main.txt");
      await git(repoRoot, "commit", "-m", "main moves");
      const discoveryBase = await git(repoRoot, "rev-parse", "main");
      const secondBranch = "hive/maya-followup";
      const secondTip = await cutSecondBranch(worktree.path, secondBranch);

      // The exact record the defective sweep held: unowned, resolver-owned,
      // needs-integration over a live agent's working branch.
      const store = new SettlementCaseStore(repoRoot);
      const caseId = await openUnownedNeedsIntegrationCase(store, {
        branch: secondBranch,
        baseOid: discoveryBase,
        worktreePath: null,
        unmergedCommits: 2,
      });
      const before = await store.read(caseId);
      expect(before?.record.agentId).toBeNull();
      expect(before?.record.state).toBe("needs-integration");

      await service.reconcileOrphanedWorktrees();

      // The row follows the worktree's live checkout.
      expect(db.getAgentById(agent.id)?.branch).toBe(secondBranch);

      // The case for the second branch is bound to the live agent and read as
      // active agent-owned work, never as residue awaiting a resolver.
      const cases = await store.list("main");
      const second = cases.find(({ record }) => record.branch === secondBranch);
      expect(second?.record.agentId).toBe(agent.id);
      expect(second?.record.agentName).toBe("maya");
      expect(second?.record.generation).toBe(1);
      expect(second?.record.worktreePath).toBe(worktree.path);
      expect(second?.record.state).toBe("active");
      expect(second?.record.owner).toBe("agent");

      // The spawn branch's case keeps its owner and loses the worktree the
      // second branch now hosts; it is not escalated or mismeasured.
      const first = cases.find(
        ({ record }) => record.branch === worktree.branch,
      );
      expect(first?.record.agentId).toBe(agent.id);
      expect(first?.record.worktreePath).toBeNull();
      expect(first?.record.state).toBe("active");
      expect(first?.record.owner).toBe("agent");
      expect(cases).toHaveLength(2);

      // Landing evidence for the retasked agent resolves the current branch's
      // case, not the leftover one.
      const fresh = db.getAgentById(agent.id);
      if (fresh === null) throw new Error("agent row disappeared");
      const evidence = await service.landingEvidence(fresh, secondTip);
      expect(evidence.baseOid).toBe(discoveryBase);

      // The other reader of the same seam: the real landAgent path resolves
      // the same branch the settlement case now names. The merge itself is
      // stubbed to record what the gate would land; on the defect it resolves
      // the spawn branch and refuses a branch main already holds.
      const landedBranches: string[] = [];
      await landAgent(
        {
          db,
          machineMutations: null,
          repoRoot,
          land: async (_repoRoot, branch) => {
            landedBranches.push(branch);
            return { commit: secondTip, landedCommits: [secondTip] };
          },
          capabilities: { audit: () => {} },
          worktrees: { onLanded: async () => {} },
          mainHealthMonitor: null,
          graphify: undefined,
          succession: () => ({ writeBoundaryCheckpoint: () => {} }),
        },
        "maya",
        0,
      );
      expect(landedBranches).toEqual([secondBranch]);
    } finally {
      db.close();
    }
  });

  test("a dead agent's second branch is still attributable to that agent", async () => {
    const repoRoot = await repo();
    const spawnBase = await git(repoRoot, "rev-parse", "main");
    const worktree = await createWorktree(repoRoot, "maya", "proof");
    const db = new HiveDatabase(":memory:");
    try {
      const agent = insertAgent(db, {
        name: "maya",
        status: "dead",
        worktreePath: worktree.path,
        branch: worktree.branch,
      });
      const secondBranch = "hive/maya-followup";
      await cutSecondBranch(worktree.path, secondBranch);
      const store = new SettlementCaseStore(repoRoot);
      const caseId = await openUnownedNeedsIntegrationCase(store, {
        branch: secondBranch,
        baseOid: spawnBase,
        worktreePath: null,
        unmergedCommits: 2,
      });

      await lifecycle(db, repoRoot, "dead").reconcileOrphanedWorktrees();

      expect(db.getAgentById(agent.id)?.branch).toBe(secondBranch);
      const stored = await store.read(caseId);
      expect(stored?.record.agentId).toBe(agent.id);
      expect(stored?.record.agentName).toBe("maya");
      expect(stored?.record.state).toBe("needs-integration");
      expect(stored?.record.reason).toBe(
        "2 commit(s) are not accounted for on main",
      );
    } finally {
      db.close();
    }
  });

  test("a live agent's abandoned branch is bound to the agent even though the worktree has moved past it", async () => {
    const repoRoot = await repo();
    const worktree = await createWorktree(repoRoot, "maya", "proof");
    // Retasked twice. The middle branch is the one the case record cannot
    // reach: the row and the live checkout have both moved on to the third,
    // and no earlier case carries the agent id, so neither the row's branch
    // nor a stored linkage names it.
    const abandoned = "hive/maya-followup";
    const abandonedTip = await cutSecondBranch(worktree.path, abandoned);
    await cutSecondBranch(worktree.path, "hive/maya-third");
    const db = new HiveDatabase(":memory:");
    try {
      const agent = insertAgent(db, {
        name: "maya",
        status: "working",
        worktreePath: worktree.path,
        branch: worktree.branch,
      });
      const store = new SettlementCaseStore(repoRoot);
      const caseId = await openUnownedNeedsIntegrationCase(store, {
        branch: abandoned,
        baseOid: abandonedTip,
        worktreePath: null,
        unmergedCommits: 2,
      });

      await lifecycle(db, repoRoot, "live").reconcileOrphanedWorktrees();

      const stored = await store.read(caseId);
      // The branch belongs to a live agent's worktree, so it is that agent's
      // work in progress — never ownerless residue queued for integration.
      expect(stored?.record.agentId).toBe(agent.id);
      expect(stored?.record.agentName).toBe("maya");
      expect(stored?.record.owner).toBe("agent");
      expect(stored?.record.state).not.toBe("needs-integration");
    } finally {
      db.close();
    }
  });

  test("a dead agent's abandoned branch is attributed to it and still becomes resolver-owned residue", async () => {
    const repoRoot = await repo();
    const worktree = await createWorktree(repoRoot, "maya", "proof");
    const abandoned = "hive/maya-followup";
    const abandonedTip = await cutSecondBranch(worktree.path, abandoned);
    await cutSecondBranch(worktree.path, "hive/maya-third");
    const db = new HiveDatabase(":memory:");
    try {
      const agent = insertAgent(db, {
        name: "maya",
        status: "dead",
        worktreePath: worktree.path,
        branch: worktree.branch,
      });
      const store = new SettlementCaseStore(repoRoot);
      const caseId = await openUnownedNeedsIntegrationCase(store, {
        branch: abandoned,
        baseOid: abandonedTip,
        worktreePath: null,
        unmergedCommits: 2,
      });

      await lifecycle(db, repoRoot, "dead").reconcileOrphanedWorktrees();

      // Naming the owner is not the same as excusing the work: unaccounted
      // commits from a generation that ended still wait on a resolver.
      const stored = await store.read(caseId);
      expect(stored?.record.agentId).toBe(agent.id);
      expect(stored?.record.state).toBe("needs-integration");
      expect(stored?.record.owner).toBe("resolver");
    } finally {
      db.close();
    }
  });

  test("a retired agent's residue defers to the live successor holding its recycled name", async () => {
    const repoRoot = await repo();
    const worktree = await createWorktree(repoRoot, "maya", "proof");
    // The retired generation was itself retasked, so no row names the branch it
    // abandoned; the name pool then reissued "maya" to a live successor. The
    // branch names alone cannot say which generation cut which branch.
    const residue = "hive/maya-retired-work";
    const residueTip = await cutSecondBranch(worktree.path, residue);
    await cutSecondBranch(worktree.path, "hive/maya-retired-last");
    await cutSecondBranch(worktree.path, "hive/maya-successor");
    const db = new HiveDatabase(":memory:");
    try {
      const retired = insertAgent(db, {
        name: "maya",
        status: "dead",
        worktreePath: worktree.path,
        branch: "hive/maya-retired-last",
      });
      db.insertAgent({
        ...retired,
        id: "agent-maya-successor",
        status: "working",
        branch: "hive/maya-successor",
      });
      const store = new SettlementCaseStore(repoRoot);
      const caseId = await openUnownedNeedsIntegrationCase(store, {
        branch: residue,
        baseOid: residueTip,
        worktreePath: null,
        unmergedCommits: 2,
      });

      await lifecycle(db, repoRoot, "live").reconcileOrphanedWorktrees();

      // Accepted deferral, recorded so it is not discovered later: the residue
      // is neither lost nor discarded, but it waits for the successor to end
      // before it can escalate. A delayed interrupt beats a wrong-owner one.
      const stored = await store.read(caseId);
      expect(stored?.record.agentId).toBe("agent-maya-successor");
      expect(stored?.record.owner).toBe("agent");
      expect(stored?.record.state).not.toBe("needs-integration");
    } finally {
      db.close();
    }
  });

  test("a case that cannot progress escalates instead of re-measuring forever", async () => {
    const repoRoot = await repo();
    const base = await git(repoRoot, "rev-parse", "main");
    // A registered worktree whose live checkout disagrees with the case's
    // branch: every measurement of the case fails the same way, so the case
    // rewrites itself every sweep without ever progressing.
    const worktree = await createWorktree(repoRoot, "ruth", "x");
    await git(worktree.path, "checkout", "-b", "hive/orphan-work");
    await writeFile(join(worktree.path, "work.txt"), "work\n");
    await git(worktree.path, "add", "work.txt");
    await git(worktree.path, "commit", "-m", "unaccounted");
    await git(worktree.path, "checkout", worktree.branch);
    const db = new HiveDatabase(":memory:");
    try {
      const store = new SettlementCaseStore(repoRoot);
      const caseId = await openUnownedNeedsIntegrationCase(store, {
        branch: "hive/orphan-work",
        baseOid: base,
        worktreePath: worktree.path,
        unmergedCommits: 1,
      });

      const service = lifecycle(db, repoRoot, "dead");
      let stored = await store.read(caseId);
      for (
        let sweep = 0;
        sweep < 8 && stored?.record.state !== "owner-decision";
        sweep += 1
      ) {
        await service.reconcileOrphanedWorktrees();
        stored = await store.read(caseId);
      }
      expect(stored?.record.state).toBe("owner-decision");
      expect(stored?.record.owner).toBe("user");
      expect(stored?.record.escalationTier).toBeGreaterThan(0);
      expect(stored?.record.reason).toContain(
        "only an owner decision can settle it",
      );

      // Once escalated, the case is owned elsewhere: later sweeps leave its
      // revision alone instead of billing another debt notice each pass.
      const escalatedRevision = stored?.record.revision;
      await service.reconcileOrphanedWorktrees();
      expect((await store.read(caseId))?.record.revision).toBe(
        escalatedRevision,
      );
    } finally {
      db.close();
    }
  });
});
