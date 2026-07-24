import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, listWorktrees } from "../../src/adapters/worktrees";
import { loadHiveConfig } from "../../src/config/load";
import type { AgentRecord } from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import type { SessionSender } from "../../src/daemon/delivery";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawner";
import { submitPaste } from "../../src/daemon/testing";

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "idle",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    contextPct: 14,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
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

class SilentSessionSender implements SessionSender {
  constructor(private readonly db: HiveDatabase) {}

  async sendSessionMessage(agent: AgentRecord): Promise<void> {
    submitPaste(this.db, agent.sessionLocator!.sessionId);
  }
}

const offlineRootProtocol = {
  isLive: () => false,
  async deliverMessage(): Promise<boolean> {
    return false;
  },
};

const OLD_ENOUGH = new Date(
  Date.now() - 15 * 60_000,
).toISOString();
const TOO_RECENT = new Date(
  Date.now() - 2 * 60_000,
).toISOString();

async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new StubSpawner(),
    sessionSender: new SilentSessionSender(db),
    rootProtocol: offlineRootProtocol,
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
  return { db, daemon, removedWorktrees };
}

describe("idle-agent reap sweep", () => {
  test("reaps an agent that is idle, clean, and past the timeout", async () => {
    const { db, daemon, removedWorktrees } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      const warning = db.listMessages().find((message) => message.to === "maya");
      expect(warning?.body).toContain("Persist any findings");
      db.transitionMessage(warning!.id, "applied", new Date().toISOString());
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("dead");
      expect(db.getAgentByName("maya")?.worktreePath).toEqual(null);
      expect(removedWorktrees).toEqual([["/tmp/repo", "/tmp/hive-maya"]]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("the reap sweep removes the real worktree and branch, and only those", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-idle-reap-git-"));
    const repoRoot = join(root, "repo");
    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, "init", "-b", "main");
    await git(repoRoot, "config", "user.name", "Hive Test");
    await git(repoRoot, "config", "user.email", "hive@example.test");
    await writeFile(join(repoRoot, "README.md"), "# idle reap\n");
    await git(repoRoot, "add", "README.md");
    await git(repoRoot, "commit", "-m", "initial");
    const target = await createWorktree(repoRoot, "agent-maya", "idle-reap");
    const unrelated = await createWorktree(repoRoot, "agent-zara", "keep");
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      sessionSender: new SilentSessionSender(db),
      rootProtocol: offlineRootProtocol,
      repoRoot,
      lifecycle: { idleReap: true, idleReapMinutes: 10 },
      resourceRunners: { orphans: null },
    });
    db.insertAgent(agent({
      lastEventAt: OLD_ENOUGH,
      worktreePath: target.path,
      branch: target.branch,
    }));
    try {
      await daemon.reapIdleAgents();
      const warning = db.listMessages().find((message) => message.to === "maya");
      db.transitionMessage(warning!.id, "applied", new Date().toISOString());
      await daemon.reapIdleAgents();

      const standing = await listWorktrees(repoRoot);
      expect(standing.some(({ branch }) => branch === target.branch)).toBe(false);
      expect(standing.some(({ branch }) => branch === unrelated.branch)).toBe(true);
      expect(await pathExists(target.path)).toBe(false);
      expect(await pathExists(unrelated.path)).toBe(true);
      expect(await git(repoRoot, "branch", "--list", target.branch)).toEqual("");
      expect(await git(repoRoot, "branch", "--list", unrelated.branch))
        .toContain(unrelated.branch);
      expect(db.getAgentByName("maya")).toMatchObject({
        status: "dead",
        worktreePath: null,
        branch: null,
      });
    } finally {
      await daemon.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sends the orchestrator an envelope naming the agent and why", async () => {
    const { db, daemon } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();
      const warning = db.listMessages().find((message) => message.to === "maya");
      db.transitionMessage(warning!.id, "applied", new Date().toISOString());
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
    const { db, daemon, removedWorktrees } = reapDaemon({
      assessStrandedWork: async () => ({
        dirtyFiles: ["src/wip.ts"],
        unmergedCommits: 1,
      }),
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
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
    const { db, daemon, removedWorktrees } = reapDaemon({
      assessStrandedWork: async () => {
        throw new Error("git index.lock exists");
      },
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
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
    const { db, daemon } = reapDaemon();
    db.insertAgent(agent({ status: "working", lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("working");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("does nothing while lifecycle.idleReap is off", async () => {
    const { db, daemon } = reapDaemon({ idleReap: false });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("leaves an idle agent alone until the timeout has actually elapsed", async () => {
    const { db, daemon } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: TOO_RECENT }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("leaves an idle agent alone while a message is still queued for it", async () => {
    const { db, daemon } = reapDaemon();
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    await daemon.delivery.send("orchestrator", "maya", "One more thing.");
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
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
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      sessionSender: new SilentSessionSender(db),
      rootProtocol: offlineRootProtocol,
      repoRoot: "/tmp/repo",
      lifecycle: config.lifecycle,
      removeWorktree: async () => {},
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();
      const warning = db.listMessages().find((message) => message.to === "maya");
      db.transitionMessage(warning!.id, "applied", new Date().toISOString());
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("dead");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("without a lifecycle option at all, the sweep is a no-op", async () => {
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      sessionSender: new SilentSessionSender(db),
      rootProtocol: offlineRootProtocol,
      repoRoot: "/tmp/repo",
    });
    db.insertAgent(agent({ lastEventAt: OLD_ENOUGH }));
    try {
      await daemon.reapIdleAgents();

      expect(db.getAgentByName("maya")?.status).toEqual("idle");
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
