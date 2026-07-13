import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../schemas";
import type { UnmergedBranch } from "../adapters/worktrees";
import { HiveDatabase } from "./db";
import type { TmuxSender } from "./delivery";
import { HiveDaemon } from "./server";
import type { Spawner } from "./spawner";
import { submitPaste } from "./testing";

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-david",
    name: "david",
    tool: "codex",
    model: "gpt-5-codex",
    category: "complex_coding",
    status: "dead",
    taskDescription: "Implement the Claude channels",
    worktreePath: null,
    branch: "hive/david-channels",
    tmuxSession: "hive-david",
    contextPct: null,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    channelsEnabled: false,
    ...overrides,
  };
}

class StubSpawner implements Spawner {
  async spawn(): Promise<AgentRecord> {
    throw new Error("not used in these tests");
  }
}

class SilentTmuxSender implements TmuxSender {
  constructor(private readonly db: HiveDatabase) {}

  async sendMessage(session: string): Promise<void> {
    submitPaste(this.db, session);
  }
}

class FakeDaemonTmux {
  readonly killed: string[] = [];

  async hasSession(): Promise<boolean> {
    return true;
  }

  async capturePane(): Promise<string> {
    return "";
  }

  async killSession(session: string): Promise<void> {
    this.killed.push(session);
  }

  async newSession(): Promise<void> {}
}

const DAVID_BRANCH: UnmergedBranch = {
  branch: "hive/david-channels",
  tip: "3f77e58",
  unmergedCommits: 1,
};

function strandedDaemon(branches: UnmergedBranch[] = [DAVID_BRANCH]) {
  const db = new HiveDatabase(":memory:");
  const removedWorktrees: string[] = [];
  const tmux = new FakeDaemonTmux();
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    tmuxSender: new SilentTmuxSender(db),
    tmux,
    repoRoot: "/tmp/repo",
    removeWorktree: async (_repoRoot, worktreePath) => {
      removedWorktrees.push(worktreePath);
    },
    listUnmergedHiveBranches: async () => branches,
  });
  return { db, daemon, tmux, removedWorktrees };
}

describe("stranded-branch reconciliation", () => {
  test("reports a branch with unlanded commits that no agent row owns at all", async () => {
    // This is david, exactly: the branch ref survived, its worktree and tmux
    // session are gone, and the agents table has no row for it — the database
    // was reset out from under it. Every other sweep in the daemon iterates
    // agent rows, so this branch is invisible to all of them. The agents table
    // is deliberately left EMPTY here; that is the whole point of the test.
    const { db, daemon, removedWorktrees } = strandedDaemon();
    try {
      await daemon.reconcileStrandedBranches();

      const notice = (await daemon.delivery.orchestratorInbox())[0];
      expect(notice?.from).toEqual("hive-lifecycle");
      expect(notice?.body).toContain("hive/david-channels");
      expect(notice?.body).toContain("1 commit(s) not on main");
      expect(notice?.body).toContain("no agent row owns it");
      // The reconciler reports; it never destroys.
      expect(notice?.body).toContain("Nothing was deleted");
      expect(removedWorktrees).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("reports a branch whose agent closed without landing it", async () => {
    // A row exists, so this one was never invisible — but a row existing is not
    // a reason to go quiet. Dead agent, unlanded commits, still stranded work.
    const { db, daemon } = strandedDaemon();
    db.insertAgent(agent({ status: "dead" }));
    try {
      await daemon.reconcileStrandedBranches();

      const notice = (await daemon.delivery.orchestratorInbox())[0];
      expect(notice?.body).toContain("hive/david-channels");
      expect(notice?.body).toContain("david");
      expect(notice?.body).toContain("is dead");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("stays quiet about a live agent still working on its own branch", async () => {
    // Work in progress is not stranded work. A writer agent with commits on its
    // own branch — which is every writer agent, including the one that shipped
    // this check — must not be reported as abandoned.
    const { db, daemon } = strandedDaemon();
    db.insertAgent(agent({ status: "working" }));
    try {
      await daemon.reconcileStrandedBranches();

      expect(await daemon.delivery.orchestratorInbox()).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("stays quiet about a branch deliberately marked preserved", async () => {
    const { db, daemon } = strandedDaemon([{ ...DAVID_BRANCH, preserved: true }]);
    try {
      await daemon.reconcileStrandedBranches();
      expect(await daemon.delivery.orchestratorInbox()).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("does not repeat itself while the branch tip is unchanged", async () => {
    const { db, daemon } = strandedDaemon();
    try {
      await daemon.reconcileStrandedBranches();
      await daemon.reconcileStrandedBranches();
      await daemon.reconcileStrandedBranches();

      expect((await daemon.delivery.orchestratorInbox()).length).toEqual(1);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("reports again once the branch has moved", async () => {
    const branches: UnmergedBranch[] = [{ ...DAVID_BRANCH }];
    const { db, daemon } = strandedDaemon(branches);
    try {
      await daemon.reconcileStrandedBranches();
      branches[0] = {
        branch: "hive/david-channels",
        tip: "aaaaaaa",
        unmergedCommits: 2,
      };
      await daemon.reconcileStrandedBranches();

      const inbox = await daemon.delivery.orchestratorInbox();
      expect(inbox.length).toEqual(2);
      expect(inbox[1]?.body).toContain("2 commit(s) not on main");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("says nothing when every hive branch has landed", async () => {
    const { db, daemon } = strandedDaemon([]);
    try {
      await daemon.reconcileStrandedBranches();

      expect(await daemon.delivery.orchestratorInbox()).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
