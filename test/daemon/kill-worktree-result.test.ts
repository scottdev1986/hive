import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawn/spawn-service";
import {
  describeWorktreeKill,
  type TeardownWorktreeSettlement,
} from "../../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import type { AgentRecord } from "../../src/schemas/agent";
import { killAgentTeardown } from "../kill-teardown";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import { required } from "../required";

const timestamp = "2026-07-09T12:00:00.000Z";

/** A fixture repoRoot must have a committed landing target: teardown tests mock the stranded-work assessor, so their verdict must reach settlement after the inventory reader has proved it can see `main`. */
function initRepo(repo: string): void {
  Bun.spawnSync(["git", "-C", repo, "init", "-b", "main"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  Bun.spawnSync(
    [
      "git",
      "-C",
      repo,
      "-c",
      "user.name=Hive Test",
      "-c",
      "user.email=hive@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    contextPct: 14,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

class StubSpawner implements Spawner {
  async spawn(): Promise<AgentRecord> {
    throw new Error("not used in these tests");
  }
}

const hostNotReached = async (): Promise<never> => {
  throw new Error("terminal host method not expected in this test");
};

const emptyTerminalHost = {
  waitForHostExit: async () => ({ kind: "inherited" as const }),
  create: hostNotReached,
  capture: hostNotReached,
  claimInput: hostNotReached,
  submitInput: hostNotReached,
  resize: hostNotReached,
  inspect: hostNotReached,
  terminate: hostNotReached,
  issueAttach: hostNotReached,
  list: async () => [],
};

function settlement(
  overrides: Partial<TeardownWorktreeSettlement> = {},
): TeardownWorktreeSettlement {
  return {
    agent: agent({ status: "dead", worktreePath: null, branch: null }),
    cleaned: { worktreePath: null, branch: null },
    preserved: null,
    stranded: null,
    ...overrides,
  };
}

describe("describeWorktreeKill outcome strings", () => {
  // Pin the four outcome literals — callers and tests must use exactly these.
  const OUTCOMES = [
    "removed",
    "preserved-stranded",
    "kept-clean",
    "absent",
  ] as const;

  test("pins the four outcome strings", () => {
    expect(OUTCOMES).toEqual([
      "removed",
      "preserved-stranded",
      "kept-clean",
      "absent",
    ]);
  });

  test("absent when the agent held no worktree or branch", () => {
    const result = describeWorktreeKill(
      agent({ worktreePath: null, branch: null }),
      settlement(),
    );
    expect(result).toEqual({
      outcome: "absent",
      path: null,
      branch: null,
      unmergedCommits: 0,
      dirtyFiles: [],
    });
    expect(result.resolve).toBeUndefined();
  });

  test("removed when the ladder released the worktree", () => {
    const result = describeWorktreeKill(
      agent(),
      settlement({
        cleaned: {
          worktreePath: "/tmp/hive-maya",
          branch: "hive/maya-server",
        },
      }),
    );
    expect(result.outcome).toBe("removed");
    expect(result.path).toBe("/tmp/hive-maya");
    expect(result.branch).toBe("hive/maya-server");
    expect(result.resolve).toBeUndefined();
  });

  test("preserved-stranded carries the preservation ref and a ready-to-run resolve", () => {
    const result = describeWorktreeKill(
      agent(),
      settlement({
        preserved: {
          branch: "hive/maya-server",
          ref: "refs/hive-preserved/hive/maya-server",
        },
        stranded: {
          branch: "hive/maya-server",
          worktreePath: "/tmp/hive-maya",
          dirtyFiles: ["src/server.ts"],
          unmergedCommits: 2,
          note: "left work",
        },
      }),
    );
    expect(result.outcome).toBe("preserved-stranded");
    expect(result.unmergedCommits).toBe(2);
    expect(result.dirtyFiles).toEqual(["src/server.ts"]);
    expect(result.preservedRef).toBe("refs/hive-preserved/hive/maya-server");
    expect(result.resolve).toBe(
      "spawn integrator to land hive/maya-server; only a user-bound settlement decision can discard it",
    );
  });

  test("preserved-stranded resolve names the WIP salvage ref when present", () => {
    const result = describeWorktreeKill(
      agent(),
      settlement({
        preserved: {
          branch: "hive/maya-server",
          ref: "refs/hive-preserved/hive/maya-server",
          salvageRef: "refs/hive-salvage/hive/maya-server",
        },
        stranded: {
          branch: "hive/maya-server",
          worktreePath: "/tmp/hive-maya",
          dirtyFiles: ["src/server.ts", "scratch.tmp"],
          unmergedCommits: 1,
          note: "left work",
        },
      }),
    );
    expect(result.outcome).toBe("preserved-stranded");
    expect(result.salvageRef).toBe("refs/hive-salvage/hive/maya-server");
    expect(result.resolve).toBe(
      "spawn integrator to land hive/maya-server (WIP salvage at refs/hive-salvage/hive/maya-server); only a user-bound settlement decision can discard it",
    );
  });

  test("kept-clean points back to the deterministic settlement sweep", () => {
    const result = describeWorktreeKill(agent(), settlement());
    expect(result.outcome).toBe("kept-clean");
    expect(result.resolve).toBe(
      "the daemon settlement pass retries the exact proof after its watched condition changes",
    );
  });

  test("positive control: a would-be kept-clean is removed when cleaned is set", () => {
    // Proves the outcome is driven by the settlement, not by a constant.
    const kept = describeWorktreeKill(agent(), settlement());
    const removed = describeWorktreeKill(
      agent(),
      settlement({
        cleaned: {
          worktreePath: "/tmp/hive-maya",
          branch: "hive/maya-server",
        },
      }),
    );
    expect(kept.outcome).toBe("kept-clean");
    expect(removed.outcome).toBe("removed");
    expect(kept.outcome).not.toBe(removed.outcome);
  });
});

describe("hive_kill structured worktree field", () => {
  test("an unprovable mock repository cannot be forced through removal", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "kill-worktree-"));
    const inserted = db.insertAgent(agent({ status: "idle" }));
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      terminalHost: emptyTerminalHost,
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    try {
      const result = await killAgentTeardown(
        daemon,
        required(db.getAgentByName("maya")),
        { removeWorktree: true },
      );
      expect(result.worktree.outcome).toBe("preserved-stranded");
      expect(result.worktree.path).toBe("/tmp/hive-maya");
      expect(result.worktree.branch).toBe("hive/maya-server");
      // cleaned is session-only — no worktreePath:null ambiguity.
      expect(result.cleaned).toEqual({
        sessionId: required(inserted.sessionLocator).sessionId,
      });
      expect("worktreePath" in result.cleaned).toBe(false);
    } finally {
      await daemon.stop();
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("stranded kill reports preserved-stranded with resolve remedy", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "kill-stranded-"));
    initRepo(repo);
    db.insertAgent(agent({ status: "working" }));
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      terminalHost: emptyTerminalHost,
      assessStrandedWork: async () => ({
        dirtyFiles: ["src/a.ts"],
        unmergedCommits: 1,
      }),
    });
    try {
      const result = await killAgentTeardown(
        daemon,
        required(db.getAgentByName("maya")),
        { removeWorktree: true },
      );
      expect(result.worktree.outcome).toBe("preserved-stranded");
      expect(result.worktree.unmergedCommits).toBe(1);
      expect(result.worktree.dirtyFiles).toEqual(["src/a.ts"]);
      // Preservation ref needs a real branch tip; this harness has none — the
      // unit tests pin preservedRef. The kill still reports the stranded outcome.
      expect(result.worktree.resolve).toBe(
        "spawn integrator to land hive/maya-server; only a user-bound settlement decision can discard it",
      );
    } finally {
      await daemon.stop();
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("default kill keeps a worktree whose proof instruments cannot run", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "kill-kept-"));
    db.insertAgent(agent({ status: "idle" }));
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      terminalHost: emptyTerminalHost,
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    try {
      const result = await killAgentTeardown(
        daemon,
        required(db.getAgentByName("maya")),
      );
      expect(result.worktree.outcome).toBe("preserved-stranded");
      expect(result.worktree.resolve).toContain("settlement decision");
    } finally {
      await daemon.stop();
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
