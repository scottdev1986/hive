import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMemoryFact,
  writeMemoryFact,
} from "../../src/adapters/memory";
import { loadHiveConfig } from "../../src/config/load";
import {
  HiveConfigSchema,
  type AgentRecord,
  type MemoryRetentionConfig,
} from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import type { SessionSender } from "../../src/daemon/delivery";
import { EpisodicStore } from "../../src/daemon/episodic-store";
import { runRetentionSweep } from "../../src/daemon/memory-retention";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawner";
import { submitPaste } from "../../src/daemon/testing";

// One fixed clock for every sweep assertion below.
const NOW = new Date("2026-07-22T00:00:00.000Z");
const OLD_TS = "2026-05-01T00:00:00.000Z"; // 82 days before NOW
const FRESH_TS = "2026-07-20T00:00:00.000Z"; // 2 days before NOW

function retentionConfig(
  overrides: Partial<MemoryRetentionConfig> = {},
): MemoryRetentionConfig {
  return {
    events_hot_days: 30,
    facts_retention: "forever",
    digests_retention: "forever",
    stale_after_days: 90,
    sweep_interval_hours: 24,
    ...overrides,
  };
}

// Global-scope memory lives under HIVE_HOME, so the whole file runs against a
// disposable home (same posture as server.test.ts).
let tempRoot = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-retention-test-"));
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
  await mkdir(Bun.env.HIVE_HOME, { recursive: true });
});

afterAll(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await rm(tempRoot, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  return await mkdtemp(join(tempRoot, "repo-"));
}

function openStore(path: string): EpisodicStore {
  return new EpisodicStore(path);
}

/** Seeds a digest row directly (bypassing WP4's compiler) so the sweep is
 * tested against provenance shapes it must recognize, not compiler output. */
function seedDigest(
  storePath: string,
  provenance: string,
): void {
  const seed = new Database(storePath);
  seed.query(`
    INSERT INTO digests (agent, session_id, compiled_at, body, provenance)
    VALUES (?, ?, ?, ?, ?)
  `).run("agent-a", "session-1", NOW.toISOString(), "digest body", provenance);
  seed.close();
}

function digestCount(storePath: string): number {
  const reader = new Database(storePath, { readonly: true });
  const row = reader.query("SELECT COUNT(*) AS count FROM digests").get() as {
    count: number;
  };
  reader.close();
  return row.count;
}

describe("runRetentionSweep — episodic hot tier", () => {
  test("deletes aged events, keeps fresh ones, and spares digest-referenced rows", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    try {
      const referenced = store.appendEvent({
        ts: OLD_TS,
        type: "status",
        summary: "old but referenced by a digest",
      });
      store.appendEvent({ ts: OLD_TS, type: "status", summary: "old and free" });
      store.appendEvent({ ts: FRESH_TS, type: "status", summary: "fresh" });
      seedDigest(
        storePath,
        JSON.stringify({ eventIds: [referenced.id], journalRange: "1-9" }),
      );

      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig(),
        now: NOW,
      });

      expect(report.eventsDeleted).toBe(1);
      const remaining = store.eventsFor().map((event) => event.id);
      expect(remaining).toHaveLength(2);
      expect(remaining).toContain(referenced.id);
    } finally {
      store.close();
    }
  });

  test("an unparseable digest provenance fails closed: no event is deleted", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    try {
      store.appendEvent({ ts: OLD_TS, type: "status", summary: "old and free" });
      seedDigest(storePath, "this is not json");

      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig(),
        now: NOW,
      });

      expect(report.eventsDeleted).toBe(0);
      expect(store.rowCounts().events).toBe(1);
    } finally {
      store.close();
    }
  });

  test("never touches facts or digests, however ancient", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    try {
      const first = store.recordFact({
        topic: "routing",
        title: "old belief",
        body: "superseded long ago",
        source: "test",
        validAt: "2025-01-01T00:00:00.000Z",
      });
      store.recordFact({
        topic: "routing",
        title: "old belief",
        body: "its replacement, also ancient",
        source: "test",
        validAt: "2025-06-01T00:00:00.000Z",
        supersedesId: first.id,
      });
      store.appendEvent({ ts: "2025-01-02T00:00:00.000Z", type: "x", summary: "ancient" });
      seedDigest(storePath, JSON.stringify({}));

      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig({ events_hot_days: 1 }),
        now: NOW,
      });

      // The ancient unreferenced event goes; facts and digests stay whole.
      expect(report.eventsDeleted).toBe(1);
      expect(store.rowCounts().facts).toBe(2);
      expect(store.factsAsOf("2025-03-01T00:00:00.000Z")).toHaveLength(1);
      expect(digestCount(storePath)).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("runRetentionSweep — wiki stale demotion", () => {
  async function seedWiki(repo: string): Promise<void> {
    // Verified long enough ago to age out (verified == article date satisfies
    // the write contract's stale guard).
    await writeMemoryFact(repo, {
      scope: "repo",
      id: "old-verified",
      topic: "routing",
      title: "Old verified article",
      body: "A belief verified many months ago.",
      date: "2026-03-01",
      verified: "2026-03-01",
      source: "human",
      evidence: "seeded",
      status: "verified",
      supersedes: [],
    });
    await writeMemoryFact(repo, {
      scope: "repo",
      id: "recent-verified",
      topic: "routing",
      title: "Recently verified article",
      body: "Verified this month.",
      date: "2026-07-10",
      verified: "2026-07-10",
      source: "human",
      evidence: "seeded",
      status: "verified",
      supersedes: [],
    });
    await writeMemoryFact(repo, {
      scope: "repo",
      id: "never-verified",
      topic: "routing",
      title: "Unverified article",
      body: "Never verified at all.",
      date: "2026-03-01",
      source: "agent",
      evidence: "seeded",
      status: "unverified",
      supersedes: [],
    });
    await writeMemoryFact(repo, {
      scope: "repo",
      id: "already-stale",
      topic: "routing",
      title: "Already stale article",
      body: "Demoted by an earlier sweep.",
      date: "2026-07-01",
      verified: "2026-03-01",
      source: "human",
      evidence: "seeded",
      status: "stale",
      supersedes: [],
    });
    await writeMemoryFact(repo, {
      scope: "repo",
      id: "in-conflict",
      topic: "routing",
      title: "Conflicted article",
      body: "Two sources conflict here and must be reconciled.",
      date: "2026-03-01",
      source: "agent",
      evidence: "seeded",
      status: "conflicted",
      supersedes: [],
    });
    await writeMemoryFact(repo, {
      scope: "global",
      id: "global-old-verified",
      topic: "routing",
      title: "Global old verified article",
      body: "A global belief verified many months ago.",
      date: "2026-03-01",
      verified: "2026-03-01",
      source: "human",
      evidence: "seeded",
      status: "verified",
      supersedes: [],
    });
  }

  test("demotes aged verified articles in repo and global scope; leaves the rest", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    await seedWiki(repo);
    try {
      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig(),
        now: NOW,
      });

      expect(report.articlesDemoted).toEqual([
        { scope: "repo", id: "old-verified" },
        { scope: "global", id: "global-old-verified" },
      ]);

      // Demoted, still readable, verification provenance preserved.
      const demoted = await readMemoryFact(repo, "repo", "old-verified");
      expect(demoted?.status).toBe("stale");
      expect(demoted?.verified).toBe("2026-03-01");
      expect(demoted?.body).toContain("verified many months ago");
      const globalDemoted = await readMemoryFact(repo, "global", "global-old-verified");
      expect(globalDemoted?.status).toBe("stale");

      // Untouched: recently verified, unverified, already stale, conflicted.
      expect((await readMemoryFact(repo, "repo", "recent-verified"))?.status)
        .toBe("verified");
      expect((await readMemoryFact(repo, "repo", "never-verified"))?.status)
        .toBe("unverified");
      expect((await readMemoryFact(repo, "repo", "already-stale"))?.status)
        .toBe("stale");
      expect((await readMemoryFact(repo, "repo", "in-conflict"))?.status)
        .toBe("conflicted");

      // The scope index shows the demotion and the log records it.
      const index = await readFile(
        join(repo, ".hive", "memory", "wiki", "index.md"),
        "utf8",
      );
      expect(index).toContain("old-verified");
      expect(index).toMatch(/old-verified \([^)]*\) \[stale\]/);
      const log = await readFile(
        join(repo, ".hive", "memory", "wiki", "log.md"),
        "utf8",
      );
      expect(log).toContain("stale-demote | Old verified article");
    } finally {
      store.close();
    }
  });
});

describe("[memory.retention] config", () => {
  test("defaults apply when the section is absent", () => {
    const parsed = HiveConfigSchema.parse({});
    expect(parsed.memory.retention).toEqual(retentionConfig());
  });

  test("explicit values parse; absent keys keep their defaults", () => {
    const parsed = HiveConfigSchema.parse({
      memory: { retention: { events_hot_days: 7, sweep_interval_hours: 12 } },
    });
    expect(parsed.memory.retention.events_hot_days).toBe(7);
    expect(parsed.memory.retention.sweep_interval_hours).toBe(12);
    expect(parsed.memory.retention.stale_after_days).toBe(90);
  });

  test("invalid values are rejected by the schema", () => {
    expect(() =>
      HiveConfigSchema.parse({ memory: { retention: { events_hot_days: 0 } } })
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({ memory: { retention: { stale_after_days: -1 } } })
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({ memory: { retention: { sweep_interval_hours: 0 } } })
    ).toThrow();
    // facts/digests retention is "forever" by invariant, never a knob.
    expect(() =>
      HiveConfigSchema.parse({
        memory: { retention: { facts_retention: "30d" } },
      })
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({
        memory: { retention: { digests_retention: "30d" } },
      })
    ).toThrow();
    // Strict: an unknown key is a typo, and a typo must not parse.
    expect(() =>
      HiveConfigSchema.parse({ memory: { retention: { events_hot_day: 30 } } })
    ).toThrow();
  });

  test("a bad section fails the loader loudly", async () => {
    const home = Bun.env.HIVE_HOME!;
    await writeFile(
      join(home, "config.toml"),
      "[memory.retention]\nevents_hot_days = -5\n",
    );
    try {
      await expect(loadHiveConfig()).rejects.toThrow("Invalid hive config");
    } finally {
      await rm(join(home, "config.toml"), { force: true });
    }
    // A valid section round-trips through the file.
    await writeFile(
      join(home, "config.toml"),
      "[memory.retention]\nstale_after_days = 45\n",
    );
    try {
      const config = await loadHiveConfig();
      expect(config.memory.retention.stale_after_days).toBe(45);
      expect(config.memory.retention.events_hot_days).toBe(30);
    } finally {
      await rm(join(home, "config.toml"), { force: true });
    }
  });
});

// --- Daemon wiring -----------------------------------------------------------

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

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for the retention sweep");
    }
    await Bun.sleep(10);
  }
}

describe("daemon retention wiring", () => {
  test("off without a retention config: the sweep is a no-op", async () => {
    const repo = await makeRepo();
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
    });
    try {
      expect(await daemon.runMemoryRetentionSweep()).toBeNull();
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("the periodic timer fires on sweep_interval_hours and stop clears it", async () => {
    jest.useFakeTimers();
    const repo = await makeRepo();
    const db = new HiveDatabase(":memory:");
    const episodic = openStore(join(repo, "episodic.db"));
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      repoRoot: repo,
      port: 0,
      episodicStore: episodic,
      retention: retentionConfig({ sweep_interval_hours: 1 }),
    });
    const sweep = jest.spyOn(daemon, "runMemoryRetentionSweep")
      .mockResolvedValue(null);
    jest.spyOn(daemon, "runMaintenance").mockResolvedValue(undefined);
    jest.spyOn(daemon, "checkWakePaths").mockResolvedValue([]);
    jest.spyOn(daemon, "renewWorkspaceVisibility").mockResolvedValue(0);
    // start() kicks a real reindex; under fake timers its lock retry would
    // resolve after stop() and log a spurious closed-database error.
    jest.spyOn(daemon, "rebuildMemoryIndex").mockResolvedValue({
      count: 0,
      migration: { scanned: 0, migrated: 0, flagged: [], backups: [], alreadyMigrated: [] },
    });
    try {
      daemon.start();
      // The startup sweep runs immediately so a daemon down past its cadence
      // does not wait a full interval.
      expect(sweep).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(3_600_000 - 1);
      expect(sweep).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(sweep).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(3_600_000);
      expect(sweep).toHaveBeenCalledTimes(3);

      await daemon.stop();
      jest.advanceTimersByTime(7_200_000);
      expect(sweep).toHaveBeenCalledTimes(3);
    } finally {
      await daemon.stop().catch(() => undefined);
      db.close();
      jest.useRealTimers();
    }
  });

  test("an agent session end triggers the sweep (event-driven)", async () => {
    const repo = await makeRepo();
    const episodic = openStore(join(repo, "episodic.db"));
    const aged = episodic.appendEvent({
      ts: OLD_TS,
      type: "test",
      summary: "aged event awaiting the sweep",
    });
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: new StubSpawner(),
      sessionSender: new SilentSessionSender(db),
      rootProtocol: offlineRootProtocol,
      repoRoot: repo,
      episodicStore: episodic,
      lifecycle: { idleReap: true, idleReapMinutes: 10 },
      retention: retentionConfig(),
      removeWorktree: async () => {},
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    db.insertAgent(agent({
      lastEventAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    }));
    try {
      // The idle-reap two-step drives killAgentTeardown, which is the session
      // end the sweep rides (hive_kill's own path).
      await daemon.reapIdleAgents();
      const warning = db.listMessages().find((message) => message.to === "maya");
      db.transitionMessage(warning!.id, "applied", new Date().toISOString());
      await daemon.reapIdleAgents();
      expect(db.getAgentByName("maya")?.status).toBe("dead");

      // The kill's fire-and-forget sweep deletes the aged event; any events
      // the daemon itself projected during the kill are fresh and stay.
      await waitFor(() =>
        !episodic.eventsFor().some((event) => event.id === aged.id)
      );
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
