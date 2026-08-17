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
import { SettlementCaseStore } from "../../src/daemon/worktree-lifecycle-service/settlement-case-store";
import { measureAutomaticRelease } from "../../src/daemon/worktree-lifecycle-service/settlement-proof";
import { WorktreeLifecycleService } from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import type { AgentRecord } from "../../src/schemas/agent";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import { deleteAgentRow } from "../support/daemon-test-support";

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
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")}`);
  return stdout.trim();
}

async function fixture(liveness: "dead" | "live" | "unknown" = "dead") {
  const root = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "residue-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "# residue\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  const worktree = await createWorktree(repo, "eugene", "residue-proof");
  const db = new HiveDatabase(":memory:");
  const agent = db.insertAgent({
    id: "agent-eugene",
    name: "eugene",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "complex_coding",
    status: "dead",
    taskDescription: "prove settlement residue",
    worktreePath: worktree.path,
    branch: worktree.branch,
    contextPct: null,
    createdAt: "2026-08-14T12:00:00.000Z",
    lastEventAt: "2026-08-14T12:00:00.000Z",
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: true,
  });
  let now = new Date("2026-08-14T12:05:00.000Z");
  const lifecycle = new WorktreeLifecycleService({
    db,
    repoRoot: repo,
    clock: () => now,
    publish: async () => {},
    assessStrandedWork,
    listSettlementBranches,
    reconcileOrphanedWorktrees,
    processLiveness: async () => liveness,
  });
  await lifecycle.openSettlementCase(
    agent,
    worktree,
    await git(repo, "rev-parse", "main"),
  );
  return {
    repo,
    worktree,
    db,
    agent,
    lifecycle,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

async function settle(lifecycle: WorktreeLifecycleService, agent: AgentRecord) {
  return lifecycle.settleTeardownWorktree({
    agent,
    updated: agent,
    capture: await lifecycle.captureFinalWorkManifest(agent),
    at: "2026-08-14T12:05:00.000Z",
    removeWorktree: false,
  });
}

async function remeasure(
  cases: SettlementCaseStore,
  repo: string,
  agent: AgentRecord,
  at: string,
) {
  const [stored] = await cases.list("main");
  if (stored === undefined) throw new Error("missing case to remeasure");
  const proof = await measureAutomaticRelease(
    { repoRoot: repo, processLiveness: async () => "dead" },
    stored.record,
    agent,
    "main",
  );
  if (proof.snapshot === null) throw new Error("remeasurement has no snapshot");
  await cases.update(stored, {
    ...stored.record,
    lastMeasuredAt: at,
    headOid: proof.snapshot.headOid,
    evidenceDigest: proof.snapshot.digest,
    evidenceFormat: "disposition-v1",
    regenerable: [...proof.snapshot.regenerable],
  });
  return proof.snapshot;
}

describe("Git-backed settlement residue", () => {
  test("D1 lists the branch contents and the disposition that releases them", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "feature.txt"), "branch work\n");
      await git(worktree.path, "add", "feature.txt");
      await git(worktree.path, "commit", "-m", "branch work");
      await writeFile(join(worktree.path, "notes.txt"), "uncommitted work\n");
      await settle(lifecycle, agent);

      const branchOid = await git(worktree.path, "rev-parse", "HEAD");
      const targetOid = await git(repo, "rev-parse", "refs/heads/main");
      const mergeBaseOid = await git(
        repo,
        "merge-base",
        "refs/heads/main",
        branchOid,
      );
      const [listed] = await lifecycle.listSettlementCases();

      expect(listed).toMatchObject({
        branch: worktree.branch,
        worktreePath: worktree.path,
        residue: {
          targetRef: "refs/heads/main",
          targetOid,
          mergeBaseOid,
          branchOid,
          worktreePresent: true,
          dirtyFiles: ["notes.txt"],
          unaccountedCommitOids: [branchOid],
          mainContainsBranchWork: false,
          missing: [],
          releaseDisposition: "integrate-or-user-discard",
        },
      });

      await git(repo, "cherry-pick", branchOid);
      await settle(lifecycle, agent);
      const containedMergeBaseOid = await git(
        repo,
        "merge-base",
        "refs/heads/main",
        branchOid,
      );
      const [contained] = await lifecycle.listSettlementCases();
      expect(contained?.residue).toMatchObject({
        targetRef: "refs/heads/main",
        mergeBaseOid: containedMergeBaseOid,
        branchOid,
        unaccountedCommitOids: [],
        mainContainsBranchWork: true,
      });
    } finally {
      db.close();
    }
  });

  test("D1 an unknown process probe blocks release without hiding Git contents", async () => {
    const { worktree, db, agent, lifecycle } = await fixture("unknown");
    try {
      await writeFile(join(worktree.path, "notes.txt"), "still measurable\n");

      const result = await settle(lifecycle, agent);
      const [listed] = await lifecycle.listSettlementCases();

      expect(result.cleaned.worktreePath).toBeNull();
      expect(listed).toMatchObject({
        state: "measurement-blocked",
        evidenceFormat: "disposition-v1",
        residue: {
          worktreePresent: true,
          dirtyFiles: ["notes.txt"],
          releaseDisposition: "integrate-or-user-discard",
        },
      });
    } finally {
      db.close();
    }
  });

  test("D2 a sweep settles an owner-decision ghost and reports what was absent", async () => {
    const { repo, worktree, db, lifecycle } = await fixture();
    try {
      await git(repo, "worktree", "remove", "--force", worktree.path);
      await git(repo, "branch", "-D", worktree.branch);
      const cases = new SettlementCaseStore(repo);
      const [opened] = await cases.list("main");
      if (opened === undefined) throw new Error("missing settlement case");
      await cases.update(opened, {
        ...opened.record,
        state: "owner-decision",
        owner: "user",
        reason: "owner was asked about a bundle that is now gone",
        due: { nextActionAt: null, watchedTrigger: "owner-decision" },
        evidenceDigest: null,
        evidenceFormat: null,
      });

      const report = (await lifecycle.reconcileOrphanedWorktrees()) as {
        settledCases?: Array<{
          caseId: string;
          branch: string | null;
          worktreePath: string | null;
          evidenceDigest: string;
          accountedBy: string;
          missing: string[];
        }>;
      };

      expect(await cases.list("main")).toEqual([]);
      expect(report.settledCases).toEqual([
        {
          caseId: opened.record.caseId,
          branch: worktree.branch,
          worktreePath: worktree.path,
          evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          accountedBy: "nothing-remains",
          missing: ["branch", "worktree"],
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("D3 owner-decision refreshes legacy evidence before the ownership skip", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "notes.txt"), "review me\n");
      await settle(lifecycle, agent);
      const cases = new SettlementCaseStore(repo);
      const [measured] = await cases.list("main");
      if (measured === undefined) throw new Error("missing settlement case");
      const legacyDigest = "0".repeat(64);
      await cases.update(measured, {
        ...measured.record,
        state: "owner-decision",
        owner: "user",
        reason: "the owner is deciding the measured residue",
        due: { nextActionAt: null, watchedTrigger: "owner-decision" },
        lastMeasuredAt: null,
        evidenceDigest: legacyDigest,
        evidenceFormat: null,
      });

      await lifecycle.reconcileOrphanedWorktrees();

      const [listed] = await lifecycle.listSettlementCases();
      expect(listed?.state).toBe("owner-decision");
      expect(listed?.evidenceFormat).toBe("disposition-v1");
      expect(listed?.evidenceDigest).not.toBe(legacyDigest);
      expect(listed?.lastMeasuredAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("D4 an unchanged digest remains mintable after ten minutes of revision churn", async () => {
    const { repo, worktree, db, agent, lifecycle, setNow } = await fixture();
    try {
      await writeFile(join(worktree.path, "notes.txt"), "reviewed residue\n");
      await settle(lifecycle, agent);
      const cases = new SettlementCaseStore(repo);
      const [quoted] = await cases.list("main");
      if (quoted === undefined || quoted.record.evidenceDigest === null) {
        throw new Error("missing measured settlement evidence");
      }
      const evidenceDigest = quoted.record.evidenceDigest;
      setNow("2026-08-14T12:15:00.000Z");
      await remeasure(cases, repo, agent, "2026-08-14T12:15:00.000Z");
      await remeasure(cases, repo, agent, "2026-08-14T12:16:00.000Z");
      const [beforeMint] = await cases.list("main");
      if (beforeMint === undefined) throw new Error("missing churned case");
      expect(beforeMint.record.revision).toBeGreaterThan(
        quoted.record.revision,
      );
      expect(beforeMint.record.evidenceDigest).toBe(evidenceDigest);

      await expect(
        lifecycle.mintDestructiveDecision({
          caseId: quoted.record.caseId,
          revision: beforeMint.record.revision + 100,
          evidenceDigest,
          reason: "a future revision cannot describe the reviewed case",
          expiresAt: "2026-08-14T12:25:00.000Z",
          decisionOwner: "user",
        }),
      ).rejects.toThrow("revision or evidence digest changed");
      const decision = await lifecycle.mintDestructiveDecision({
        caseId: quoted.record.caseId,
        revision: quoted.record.revision,
        evidenceDigest,
        reason: "the user reviewed and chose to discard notes.txt",
        expiresAt: "2026-08-14T12:25:00.000Z",
        decisionOwner: "user",
      });

      expect(decision.evidenceDigest).toBe(evidenceDigest);
      expect(decision.caseRevision).toBeGreaterThan(quoted.record.revision);

      setNow("2026-08-14T12:18:00.000Z");
      await remeasure(cases, repo, agent, "2026-08-14T12:17:00.000Z");
      await remeasure(cases, repo, agent, "2026-08-14T12:18:00.000Z");
      const [afterMint] = await cases.list("main");
      if (afterMint === undefined) throw new Error("missing remeasured case");
      expect(afterMint.record.revision).toBeGreaterThan(decision.caseRevision);
      expect(afterMint.record.evidenceDigest).toBe(decision.evidenceDigest);

      const executed = await lifecycle.executeDestructiveDecision(
        decision.decisionId,
        "queen",
      );
      expect(executed.executedBy).toBe("queen");
      expect(await cases.list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("D4 changing a branch OID without changing the case revision invalidates the decision", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "notes.txt"), "reviewed residue\n");
      await settle(lifecycle, agent);
      const cases = new SettlementCaseStore(repo);
      const [listed] = await lifecycle.listSettlementCases();
      if (listed?.evidenceDigest === null || listed === undefined) {
        throw new Error("missing measured settlement evidence");
      }
      const decision = await lifecycle.mintDestructiveDecision({
        caseId: listed.caseId,
        revision: listed.revision,
        evidenceDigest: listed.evidenceDigest,
        reason: "the user reviewed and chose to discard notes.txt",
        expiresAt: "2026-08-14T12:15:00.000Z",
        decisionOwner: "user",
      });
      await git(worktree.path, "commit", "--allow-empty", "-m", "OID drift");
      const [unchangedCase] = await cases.list("main");
      expect(unchangedCase?.record.revision).toBe(decision.caseRevision);

      await expect(
        lifecycle.executeDestructiveDecision(decision.decisionId, "queen"),
      ).rejects.toThrow("settlement evidence changed");
      expect(await git(repo, "branch", "--list", worktree.branch)).not.toBe("");
    } finally {
      db.close();
    }
  });

  test("D4 a decision executes on a branch measured absent and refuses one that returns", async () => {
    const { repo, worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "work.txt"), "unlanded work\n");
      await git(worktree.path, "add", "work.txt");
      await git(worktree.path, "commit", "-m", "work that never landed");
      const tip = await git(worktree.path, "rev-parse", "HEAD");
      const preserved = `refs/hive-preserved/${worktree.branch}`;
      await git(repo, "update-ref", preserved, tip);
      // The owner deletes the worktree and the branch by hand. The preserved ref is the only
      // thing still holding the commits, so the case has content and cannot release itself.
      await git(repo, "worktree", "remove", "--force", worktree.path);
      await git(repo, "branch", "-D", worktree.branch);
      const cases = new SettlementCaseStore(repo);
      const [opened] = await cases.list("main");
      if (opened === undefined) throw new Error("missing settlement case");
      await cases.update(opened, {
        ...opened.record,
        preservedRef: preserved,
      });
      const measured = await remeasure(
        cases,
        repo,
        agent,
        "2026-08-14T12:10:00.000Z",
      );
      expect(measured.branchOid).toBeNull();
      expect(measured.missing).toEqual(["branch", "worktree"]);

      const [ready] = await cases.list("main");
      if (ready === undefined || ready.record.evidenceDigest === null) {
        throw new Error("absent-branch case has no measured evidence");
      }
      const decision = await lifecycle.mintDestructiveDecision({
        caseId: ready.record.caseId,
        revision: ready.record.revision,
        evidenceDigest: ready.record.evidenceDigest,
        reason: "the owner deleted the worktree and branch by hand",
        expiresAt: "2026-08-14T12:15:00.000Z",
        decisionOwner: "user",
      });
      expect(decision.branchOid).toBeNull();
      expect(decision.refs).toEqual([{ ref: preserved, oid: tip }]);

      // A branch that comes back is drift, and the decision minted against its absence
      // must refuse rather than delete a ref nobody measured.
      await git(repo, "branch", worktree.branch, tip);
      await expect(
        lifecycle.executeDestructiveDecision(decision.decisionId, "queen"),
      ).rejects.toThrow("settlement evidence changed");
      expect(await git(repo, "rev-parse", preserved)).toBe(tip);

      await git(repo, "branch", "-D", worktree.branch);
      const executed = await lifecycle.executeDestructiveDecision(
        decision.decisionId,
        "queen",
      );

      expect(executed.executedBy).toBe("queen");
      // The receipt names only what execution removed: a branch that was already gone
      // was never this execution's to claim.
      expect(executed.removedRefs).toEqual([preserved]);
      expect(await git(repo, "for-each-ref", preserved)).toBe("");
      expect(await cases.list("main")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("D5 an absent agent row still yields evidence for a user-only decision", async () => {
    const { worktree, db, agent, lifecycle } = await fixture();
    try {
      await writeFile(join(worktree.path, "notes.txt"), "orphaned residue\n");
      deleteAgentRow(db, agent.id);

      await lifecycle.reconcileOrphanedWorktrees();

      const [listed] = await lifecycle.listSettlementCases();
      if (listed?.evidenceDigest === null || listed === undefined) {
        throw new Error("absent-row case has no measured evidence");
      }
      expect(listed.reason).toContain("Git evidence is measured");
      expect(listed.evidenceFormat).toBe("disposition-v1");
      const decision = await lifecycle.mintDestructiveDecision({
        caseId: listed.caseId,
        revision: listed.revision,
        evidenceDigest: listed.evidenceDigest,
        reason: "the user reviewed and chose to discard orphaned residue",
        expiresAt: "2026-08-14T12:15:00.000Z",
        decisionOwner: "user",
      });
      expect(decision.residue).toEqual(["notes.txt"]);
    } finally {
      db.close();
    }
  });
});
