import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHiveConfig } from "../config/load";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import type { TmuxSender } from "./delivery";
import { HiveDaemon } from "./server";
import type { Spawner } from "./spawner";
import { submitPaste } from "./testing";

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    tier: "standard",
    status: "idle",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    tmuxSession: "hive-maya",
    contextPct: 14,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
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

const OLD_ENOUGH = new Date(
  Date.now() - 15 * 60_000,
).toISOString();
const TOO_RECENT = new Date(
  Date.now() - 2 * 60_000,
).toISOString();

function reapDaemon(overrides: {
  idleReap?: boolean;
  idleReapMinutes?: number;
  assessStrandedWork?: (
    repoRoot: string,
    worktreePath: string | null,
    branch: string | null,
  ) => Promise<{ dirtyFiles: string[]; unmergedCommits: number }>;
} = {}) {
  const db = new HiveDatabase(":memory:");
  const removedWorktrees: Array<[string, string]> = [];
  const tmux = new FakeDaemonTmux();
  const daemon = new HiveDaemon({
    db,
    spawner: new StubSpawner(),
    tmuxSender: new SilentTmuxSender(db),
    tmux,
    repoRoot: "/tmp/repo",
    lifecycle: {
      idleReap: overrides.idleReap ?? true,
      idleReapMinutes: overrides.idleReapMinutes ?? 10,
    },
    removeWorktree: async (repoRoot, worktreePath) => {
      removedWorktrees.push([repoRoot, worktreePath]);
    },
    assessStrandedWork: overrides.assessStrandedWork ??
      (async () => ({ dirtyFiles: [], unmergedCommits: 0 })),
  });
  return { db, daemon, tmux, removedWorktrees };
}

describe("idle-agent reap sweep", () => {
  test("reaps an agent that is idle, clean, and past the timeout", async () => {
    const { db, daemon, tmux, removedWorktrees } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("dead");
      expect(db.getAgentByName("maya")?.worktreePath).toEqual(null);
      expect(tmux.killed).toEqual(["hive-maya"]);
      expect(removedWorktrees).toEqual([["/tmp/repo", "/tmp/hive-maya"]]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("sends the orchestrator an envelope naming the agent and why", async () => {
    const { db, daemon } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      const notice = (await daemon.delivery.orchestratorInbox())[0];
      expect(notice?.from).toEqual("hive-lifecycle");
      expect(notice?.body).toContain("maya");
      expect(notice?.body).toContain("idle");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("refuses to reap dirty or unmerged work, and says so out loud", async () => {
    // The refusal is the safety property and it stays. What changed is that it
    // is no longer silent: this test used to assert an empty inbox, which meant
    // an agent could sit here holding unlanded commits forever with nobody told.
    const { db, daemon, tmux, removedWorktrees } = reapDaemon({
      assessStrandedWork: async () => ({
        dirtyFiles: ["src/wip.ts"],
        unmergedCommits: 1,
      }),
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(tmux.killed).toEqual([]);
      expect(removedWorktrees).toEqual([]);

      const notice = (await daemon.delivery.orchestratorInbox())[0];
      expect(notice?.from).toEqual("hive-lifecycle");
      expect(notice?.body).toContain("maya");
      expect(notice?.body).toContain("NOT reaped");
      expect(notice?.body).toContain("1 unmerged commit(s)");
      expect(notice?.body).toContain("hive/maya-server");
      expect(notice?.body).toContain("Nothing was deleted");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("re-alerts when the stranded work grows, but not on unchanged state", async () => {
    let unmergedCommits = 1;
    const { db, daemon } = reapDaemon({
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits }),
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();
      await daemon.reapIdleAgents();
      // Same state on both ticks: the idempotency key collapses them, so a
      // stranded agent does not flood the orchestrator every 30 seconds.
      // (orchestratorInbox is a consuming read — it drains what it returns.)
      const first = await daemon.delivery.orchestratorInbox();
      expect(first.length).toEqual(1);
      expect(first[0]?.body).toContain("1 unmerged commit(s)");

      unmergedCommits = 2;
      await daemon.reapIdleAgents();

      // The work grew, so the agent is reported again rather than silenced by
      // the alert it already sent.
      const second = await daemon.delivery.orchestratorInbox();
      expect(second.length).toEqual(1);
      expect(second[0]?.body).toContain("2 unmerged commit(s)");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("alerts when it cannot even tell whether the work is clean", async () => {
    // "I could not tell" is not permission to say nothing. The agent is still
    // not reaped, so without this alert it idles here unreported forever.
    const { db, daemon, tmux, removedWorktrees } = reapDaemon({
      assessStrandedWork: async () => {
        throw new Error("git index.lock exists");
      },
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(tmux.killed).toEqual([]);
      expect(removedWorktrees).toEqual([]);

      const notice = (await daemon.delivery.orchestratorInbox())[0];
      expect(notice?.body).toContain("maya");
      expect(notice?.body).toContain("cannot be reaped");
      expect(notice?.body).toContain("git index.lock exists");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("never reaps a busy agent", async () => {
    const { db, daemon, tmux } = reapDaemon();
    db.insertAgent(agent({ status: "working", lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("working");
      expect(tmux.killed).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("does nothing while lifecycle.idleReap is off", async () => {
    const { db, daemon, tmux } = reapDaemon({ idleReap: false });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(tmux.killed).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("leaves an idle agent alone until the timeout has actually elapsed", async () => {
    const { db, daemon, tmux } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: TOO_RECENT }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(tmux.killed).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("leaves an idle agent alone while a message is still queued for it", async () => {
    const { db, daemon, tmux } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    await daemon.delivery.send("orchestrator", "maya", "One more thing.");
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(tmux.killed).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("a fresh install with no [lifecycle] config resolves to an enabled reap sweep with zero setup", async () => {
    // Reproduces exactly what `hive init` leaves behind (no config.toml) and
    // what cli/daemon.ts's runDaemon() does with the result: `const config =
    // await loadHiveConfig(); ... lifecycle: config.lifecycle`. This is the
    // real startup path, not a re-assertion of the schema default in isolation.
    const tempRoot = await mkdtemp(join(tmpdir(), "hive-daemon-default-"));
    const hiveHome = join(tempRoot, "home");
    await mkdir(hiveHome, { recursive: true });
    const previousHiveHome = Bun.env.HIVE_HOME;
    Bun.env.HIVE_HOME = hiveHome;
    let config;
    try {
      config = await loadHiveConfig();
    } finally {
      if (previousHiveHome === undefined) {
        delete Bun.env.HIVE_HOME;
      } else {
        Bun.env.HIVE_HOME = previousHiveHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
    expect(config.lifecycle).toEqual({ idleReap: true, idleReapMinutes: 10 });

    const db = new HiveDatabase(":memory:");
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux,
      repoRoot: "/tmp/repo",
      lifecycle: config.lifecycle,
      removeWorktree: async () => {},
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("dead");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("without a lifecycle option at all, the sweep is a no-op", async () => {
    const db = new HiveDatabase(":memory:");
    const tmux = new FakeDaemonTmux();
    const daemon = new HiveDaemon({
      db,
      spawner: new StubSpawner(),
      tmuxSender: new SilentTmuxSender(db),
      tmux,
      repoRoot: "/tmp/repo",
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(tmux.killed).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
