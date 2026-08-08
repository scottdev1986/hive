import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  branchOwner,
  createWorktree,
  markBranchPreserved,
  reconcileOrphanedWorktrees,
  WORKTREE_SETTLING_INTERVAL_MS,
} from "../../src/adapters/worktrees";
import type { AgentRecord } from "../../src/schemas/agent";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import { releaseTestWorktree as removeWorktree } from "../support/worktree-cleanup";

let tempRoot = "";
let repoRoot = "";
let previousHiveHome: string | undefined;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
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

beforeAll(async () => {
  tempRoot = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-worktree-reconcile-"),
  );
  repoRoot = join(tempRoot, "repo");
  await mkdir(repoRoot);
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
  await git(repoRoot, "init", "-b", "main");
  await writeFile(join(repoRoot, "README.md"), "# test\n");
  await git(repoRoot, "add", "README.md");
  await git(repoRoot, "commit", "-m", "initial");
});

afterAll(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("orphaned worktree reconciliation", () => {
  test("defers phantom dirt on a young worktree, then runs the normal ladder after 30 seconds", async () => {
    const partial = await createWorktree(repoRoot, "partial", "checkout");
    const observedAt = Date.now();
    let assessments = 0;
    const assess = async () => {
      assessments += 1;
      return { dirtyFiles: ["phantom-checkout.tmp"], unmergedCommits: 0 };
    };

    try {
      const young = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
        assess,
        now: () => observedAt,
      });
      expect(
        young.worktrees.find((entry) => entry.path === partial.path),
      ).toMatchObject({ action: "kept", rule: "settling" });
      expect(assessments).toBe(0);

      const aged = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
        assess,
        now: () => observedAt + WORKTREE_SETTLING_INTERVAL_MS + 1,
        probeOwnerLiveness: () => "dead",
      });
      expect(
        aged.worktrees.find((entry) => entry.path === partial.path),
      ).toMatchObject({
        action: "kept",
        rule: "stranded-work",
        dirtyFiles: ["phantom-checkout.tmp"],
      });
      expect(assessments).toBe(1);
    } finally {
      await removeWorktree(repoRoot, partial.path, {
        deleteBranch: true,
        branch: partial.branch,
      });
    }
  });

  test("a young owning row defers an otherwise aged worktree", async () => {
    const owned = await createWorktree(repoRoot, "owned-young", "row");
    const observedAt = Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1;
    const row = {
      id: "agent-owned-young",
      name: "owned-young",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "default",
      status: "dead",
      taskDescription: "row transition",
      worktreePath: owned.path,
      branch: owned.branch,
      contextPct: null,
      createdAt: new Date(observedAt).toISOString(),
      lastEventAt: new Date(observedAt).toISOString(),
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    let assessments = 0;
    try {
      const report = await reconcileOrphanedWorktrees(repoRoot, [row], "main", {
        assess: async () => {
          assessments += 1;
          return { dirtyFiles: [], unmergedCommits: 0 };
        },
        now: () => observedAt,
      });
      expect(
        report.worktrees.find((entry) => entry.path === owned.path),
      ).toMatchObject({ action: "kept", rule: "settling" });
      expect(assessments).toBe(0);
    } finally {
      await removeWorktree(repoRoot, owned.path, {
        deleteBranch: true,
        branch: owned.branch,
      });
    }
  });

  test("reports a clean ownerless worktree without mutating it", async () => {
    const clean = await createWorktree(repoRoot, "clean", "orphan");
    expect(await branchOwner(repoRoot, clean.branch)).toBeDefined();

    // No agent row owns this fixture, so the reconciliation ladder reaches
    // the Git assessment that this test is about.
    const report = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
      now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
      probeOwnerLiveness: () => "dead",
    });
    const outcome = report.worktrees.find((entry) => entry.path === clean.path);

    expect(outcome).toMatchObject({
      action: "eligible",
      rule: "clean-orphan",
      dirtyFiles: [],
      unmergedCommits: 0,
    });
    expect(existsSync(clean.path)).toBe(true);
    expect(await git(repoRoot, "branch", "--list", clean.branch)).not.toBe("");
    expect(await branchOwner(repoRoot, clean.branch)).toBeDefined();
    await removeWorktree(repoRoot, clean.path, {
      deleteBranch: true,
      branch: clean.branch,
    });
  });

  test("a missing agent row with a live process holding the worktree is not removed", async () => {
    const owned = await createWorktree(repoRoot, "missing-row", "live-cwd");
    try {
      const report = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
        now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
        probeOwnerLiveness: () => "live",
      });
      expect(
        report.worktrees.find((entry) => entry.path === owned.path),
      ).toMatchObject({
        action: "kept",
        rule: "live-agent",
      });
      expect(existsSync(owned.path)).toBe(true);
    } finally {
      await removeWorktree(repoRoot, owned.path, {
        deleteBranch: true,
        branch: owned.branch,
      }).catch(() => undefined);
    }
  });

  test("a missing agent row with an unanswerable process probe is not removed", async () => {
    const owned = await createWorktree(repoRoot, "unknown-live", "probe-fail");
    try {
      const report = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
        now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
        probeOwnerLiveness: () => "unknown",
      });
      expect(
        report.worktrees.find((entry) => entry.path === owned.path),
      ).toMatchObject({
        action: "kept",
        rule: "assessment-failed",
        note: "owner liveness unknown (missing agent row; process probe unanswerable)",
      });
      expect(existsSync(owned.path)).toBe(true);
    } finally {
      await removeWorktree(repoRoot, owned.path, {
        deleteBranch: true,
        branch: owned.branch,
      });
    }
  });

  test("keeps an ownerless worktree with untracked content", async () => {
    const dirty = await createWorktree(repoRoot, "dirty", "untracked");
    await writeFile(join(dirty.path, "precious.txt"), "do not delete\n");

    const report = await reconcileOrphanedWorktrees(repoRoot, [], "main", {
      now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
      probeOwnerLiveness: () => "dead",
    });
    const outcome = report.worktrees.find((entry) => entry.path === dirty.path);

    expect(outcome).toMatchObject({
      action: "kept",
      rule: "stranded-work",
      dirtyFiles: ["precious.txt"],
      unmergedCommits: 0,
    });
    expect(await Bun.file(join(dirty.path, "precious.txt")).text()).toBe(
      "do not delete\n",
    );
    expect(await git(repoRoot, "branch", "--list", dirty.branch)).toContain(
      dirty.branch,
    );
    expect(await branchOwner(repoRoot, dirty.branch)).toBeDefined();
  });

  test("releases a clean terminal row that never wrote anything as nothing-to-preserve, not merged", async () => {
    // This row is terminal, its worktree is clean, and it has zero
    // patch-distinct commits — the same state a genuinely landed agent
    // reaches. Nothing here proves a landing occurred, so the rule must say
    // "nothing to preserve", never "merged".
    const terminal = await createWorktree(repoRoot, "terminal", "no-work");
    const row = {
      id: "agent-terminal",
      name: "terminal",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "default",
      status: "dead",
      taskDescription: "died before writing anything",
      worktreePath: terminal.path,
      branch: terminal.branch,
      contextPct: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      lastEventAt: "2026-08-10T12:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;

    const report = await reconcileOrphanedWorktrees(repoRoot, [row], "main", {
      now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
    });
    expect(
      report.worktrees.find((entry) => entry.path === terminal.path),
    ).toMatchObject({
      action: "eligible",
      rule: "nothing-to-preserve",
      dirtyFiles: [],
      unmergedCommits: 0,
    });
    expect(existsSync(terminal.path)).toBe(true);
    expect(await git(repoRoot, "branch", "--list", terminal.branch)).not.toBe(
      "",
    );
    expect(await branchOwner(repoRoot, terminal.branch)).toBeDefined();
    await removeWorktree(repoRoot, terminal.path, {
      deleteBranch: true,
      branch: terminal.branch,
    });
  });

  test("reports a clean terminal read-only row as expected-no-work", async () => {
    // A read-only agent's assignment forbids writing, so an empty worktree
    // here is routine — but it must still say why, and it must still never
    // claim a merge that never happened.
    const readOnly = await createWorktree(repoRoot, "reviewer", "read-only");
    const row = {
      id: "agent-reviewer",
      name: "reviewer",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "default",
      status: "dead",
      taskDescription: "read-only verification",
      worktreePath: readOnly.path,
      branch: readOnly.branch,
      contextPct: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      lastEventAt: "2026-08-10T12:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: true,
      writeRevoked: false,
    } satisfies AgentRecord;

    const report = await reconcileOrphanedWorktrees(repoRoot, [row], "main", {
      now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
    });
    expect(
      report.worktrees.find((entry) => entry.path === readOnly.path),
    ).toMatchObject({
      action: "eligible",
      rule: "expected-no-work",
      dirtyFiles: [],
      unmergedCommits: 0,
    });
    expect(existsSync(readOnly.path)).toBe(true);
    expect(await git(repoRoot, "branch", "--list", readOnly.branch)).not.toBe(
      "",
    );
    expect(await branchOwner(repoRoot, readOnly.branch)).toBeDefined();
    await removeWorktree(repoRoot, readOnly.path, {
      deleteBranch: true,
      branch: readOnly.branch,
    });
  });

  test("reports a recorded landing as confirmed after its branch resets", async () => {
    const terminal = await createWorktree(repoRoot, "confirmed", "landing");
    await writeFile(join(terminal.path, "confirmed.ts"), "export {};\n");
    await git(terminal.path, "add", "confirmed.ts");
    await git(terminal.path, "commit", "-m", "confirmed landing");
    await git(repoRoot, "merge", "--ff-only", terminal.branch);
    const landedCommit = await git(repoRoot, "rev-parse", "main");
    await git(
      repoRoot,
      "update-ref",
      `refs/heads/${terminal.branch}`,
      landedCommit,
    );
    const row = {
      id: "agent-confirmed",
      name: "confirmed",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "default",
      status: "dead",
      taskDescription: "landed work",
      worktreePath: terminal.path,
      branch: terminal.branch,
      contextPct: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      lastEventAt: "2026-08-10T12:00:00.000Z",
      landedCommit,
      landedAt: "2026-08-10T12:01:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;

    const report = await reconcileOrphanedWorktrees(repoRoot, [row], "main", {
      now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
    });
    expect(
      report.worktrees.find((entry) => entry.path === terminal.path),
    ).toMatchObject({
      action: "eligible",
      rule: "confirmed-merged",
      landing: { commit: landedCommit, at: row.landedAt },
    });
    await removeWorktree(repoRoot, terminal.path, {
      deleteBranch: true,
      branch: terminal.branch,
    });
  });

  test("reports a rewritten landing as patch equivalent, not confirmed merged", async () => {
    const source = await createWorktree(
      repoRoot,
      "equivalent-source",
      "landing",
    );
    const replacement = await createWorktree(
      repoRoot,
      "equivalent-replacement",
      "landing",
    );
    await writeFile(join(source.path, "equivalent.ts"), "export {};\n");
    await git(source.path, "add", "equivalent.ts");
    await git(source.path, "commit", "-m", "source landing");
    const landedCommit = await git(source.path, "rev-parse", "HEAD");
    await writeFile(join(replacement.path, "equivalent.ts"), "export {};\n");
    await git(replacement.path, "add", "equivalent.ts");
    await git(replacement.path, "commit", "-m", "replacement landing");
    const replacementCommit = await git(replacement.path, "rev-parse", "HEAD");
    await git(repoRoot, "merge", "--ff-only", source.branch);
    await git(
      repoRoot,
      "update-ref",
      "refs/heads/main",
      replacementCommit,
      landedCommit,
    );
    const row = {
      id: "agent-equivalent",
      name: "equivalent-source",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "default",
      status: "dead",
      taskDescription: "rewritten landing",
      worktreePath: source.path,
      branch: source.branch,
      contextPct: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      lastEventAt: "2026-08-10T12:00:00.000Z",
      landedCommit,
      landedAt: "2026-08-10T12:01:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;

    const report = await reconcileOrphanedWorktrees(repoRoot, [row], "main", {
      now: () => Date.now() + WORKTREE_SETTLING_INTERVAL_MS + 1,
    });
    expect(
      report.worktrees.find((entry) => entry.path === source.path),
    ).toMatchObject({
      action: "eligible",
      rule: "patch-equivalent",
      landing: { commit: landedCommit, at: row.landedAt },
    });
    await removeWorktree(repoRoot, source.path, {
      deleteBranch: true,
      branch: source.branch,
    });
    await removeWorktree(repoRoot, replacement.path, {
      deleteBranch: true,
      branch: replacement.branch,
    });
  });

  test("classifies merged preserved refs as releasable without deleting them", async () => {
    const merged = await createWorktree(repoRoot, "merged-ref", "preserved");
    const unmerged = await createWorktree(
      repoRoot,
      "unmerged-ref",
      "preserved",
    );
    await writeFile(join(unmerged.path, "work.ts"), "export const work = 1;\n");
    await git(unmerged.path, "add", "work.ts");
    await git(unmerged.path, "commit", "-m", "unmerged preserved work");
    await markBranchPreserved(repoRoot, merged.branch);
    await markBranchPreserved(repoRoot, unmerged.branch);

    const report = await reconcileOrphanedWorktrees(repoRoot, [
      {
        id: "agent-merged-ref",
        name: "merged-ref",
        tool: "codex",
        model: "gpt-5.6-sol",
        category: "default",
        status: "working",
        taskDescription: "positive control",
        worktreePath: merged.path,
        branch: merged.branch,
        contextPct: null,
        createdAt: "2026-08-10T12:00:00.000Z",
        lastEventAt: "2026-08-10T12:00:00.000Z",
        capabilityEpoch: 0,
        readOnly: false,
        writeRevoked: false,
      },
      {
        id: "agent-unmerged-ref",
        name: "unmerged-ref",
        tool: "codex",
        model: "gpt-5.6-sol",
        category: "default",
        status: "working",
        taskDescription: "positive control",
        worktreePath: unmerged.path,
        branch: unmerged.branch,
        contextPct: null,
        createdAt: "2026-08-10T12:00:00.000Z",
        lastEventAt: "2026-08-10T12:00:00.000Z",
        capabilityEpoch: 0,
        readOnly: false,
        writeRevoked: false,
      },
    ]);

    expect(report.preservedRefs.releasable).toEqual([
      { branch: merged.branch, tip: await git(repoRoot, "rev-parse", "main") },
    ]);
    expect(report.preservedRefs.kept).toEqual([
      {
        branch: unmerged.branch,
        tip: await git(repoRoot, "rev-parse", unmerged.branch),
        unmergedCommits: 1,
      },
    ]);
    // Explicit stewardship: the sweep classifies but never deletes.
    expect(
      await git(
        repoRoot,
        "show-ref",
        "--verify",
        `refs/hive-preserved/${unmerged.branch}`,
      ),
    ).not.toBe("");
    expect(
      await git(
        repoRoot,
        "show-ref",
        "--verify",
        `refs/hive-preserved/${merged.branch}`,
      ),
    ).not.toBe("");
  });
});
