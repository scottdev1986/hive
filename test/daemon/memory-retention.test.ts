import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHiveConfig } from "../../src/config/load";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { MemoryRetentionService } from "../../src/daemon/memory-retention-service/memory-retention-service";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawn/spawn-service";
import { EpisodicStore } from "../../src/memory-service/episodic";
import {
  readMemoryFact,
  verifyMemoryFact,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import { runRetentionSweep } from "../../src/memory-service/retention";
import type { AgentRecord } from "../../src/schemas/agent";
import {
  HiveConfigSchema,
  type MemoryRetentionConfig,
} from "../../src/schemas/config-schema";
import type { MemoryScope } from "../../src/schemas/memory";
import { killAgentTeardown } from "../kill-teardown";
import { required } from "../required";

// One fixed clock for every sweep assertion below.
const NOW = new Date("2026-07-22T00:00:00.000Z");
const OLD_TS = "2026-05-01T00:00:00.000Z"; // 82 days before NOW
const FRESH_TS = "2026-07-20T00:00:00.000Z"; // 2 days before NOW

function retentionConfig(
  overrides: Partial<MemoryRetentionConfig> = {},
): MemoryRetentionConfig {
  return {
    events_hot_days: 30,
    stale_after_days: 90,
    sweep_interval_hours: 24,
    ...overrides,
  };
}

// Global-scope memory lives under HIVE_HOME, so the whole file runs against a
// disposable home.
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

describe("runRetentionSweep — episodic hot tier", () => {
  test("deletes aged events and keeps fresh ones", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    try {
      store.appendEvent({ ts: OLD_TS, type: "status", summary: "old" });
      store.appendEvent({ ts: OLD_TS, type: "status", summary: "also old" });
      const fresh = store.appendEvent({
        ts: FRESH_TS,
        type: "status",
        summary: "fresh",
      });

      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig(),
        now: NOW,
      });

      expect(report.eventsDeleted).toBe(2);
      expect(store.eventsFor().map((event) => event.id)).toEqual([fresh.id]);
    } finally {
      store.close();
    }
  });

  test("a kill-time sweep can skip the pairwise candidate scan", async () => {
    const repo = await makeRepo();
    const store = openStore(join(repo, "episodic.db"));
    try {
      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig(),
        now: NOW,
        countCandidates: false,
      });
      expect(report.consolidationCandidates).toBe(0);
    } finally {
      store.close();
    }
  });

  test("keeps aged events cited by structured eventIds provenance", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    try {
      const aged = store.appendEvent({
        ts: OLD_TS,
        type: "test.failure",
        summary: "test suite failed",
      });
      const alsoAged = store.appendEvent({
        ts: OLD_TS,
        type: "test.error",
        summary: "another test error",
      });
      store.appendEvent({
        ts: OLD_TS,
        type: "status",
        summary: "uncited old event",
      });

      await writeMemoryFact(repo, {
        scope: "repo",
        id: "test-failure-cluster",
        topic: "pitfalls",
        title: "Pitfall: test suite failures",
        body: `## What failed\n\n- Test suite failed with exit code 1`,
        tags: ["pitfall"],
        date: NOW.toISOString().slice(0, 10),
        source: "orchestrator",
        evidence: "Structured provenance via eventIds",
        status: "unverified",
        kind: "pitfall",
        supersedes: [],
        author: "agent-maya",
        eventIds: [aged.id, alsoAged.id],
      });

      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig({ events_hot_days: 0 }),
        now: NOW,
      });

      expect(report.eventsDeleted).toBe(1);
      const remaining = store
        .eventsFor()
        .map((event) => event.id)
        .sort();
      expect(remaining).toEqual([aged.id, alsoAged.id].sort());
    } finally {
      store.close();
    }
  });

  test("deletes aged events with prose-only mentions (no structured eventIds)", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    try {
      const aged = store.appendEvent({
        ts: OLD_TS,
        type: "test.failure",
        summary: "test suite failed",
      });

      await writeMemoryFact(repo, {
        scope: "repo",
        id: "prose-only-mention",
        topic: "pitfalls",
        title: "Pitfall: mentioned in prose only",
        body: `This mentions event E${aged.id} in prose but has no structured eventIds`,
        tags: ["pitfall"],
        date: NOW.toISOString().slice(0, 10),
        source: "orchestrator",
        evidence: `Also mentions e${aged.id} in evidence but without structured provenance`,
        status: "unverified",
        kind: "pitfall",
        supersedes: [],
        author: "agent-maya",
      });

      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig({ events_hot_days: 0 }),
        now: NOW,
      });

      expect(report.eventsDeleted).toBe(1);
      expect(store.eventsFor()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("harvest citations with structured eventIds keep events", async () => {
    const repo = await makeRepo();
    const storePath = join(repo, "episodic.db");
    const store = openStore(storePath);
    try {
      const aged = store.appendEvent({
        ts: OLD_TS,
        type: "test.failure",
        summary: "test suite failed",
      });
      store.appendEvent({
        ts: OLD_TS,
        type: "status",
        summary: "uncited old event",
      });

      await writeMemoryFact(repo, {
        scope: "repo",
        id: "harvest-structured",
        topic: "pitfalls",
        title: "Pitfall: harvest writes structured eventIds",
        body: "Harvest-written facts cite events via structured eventIds",
        tags: ["pitfall"],
        date: NOW.toISOString().slice(0, 10),
        source: "orchestrator",
        evidence: `Harvest writes e${aged.id} in evidence AND structured eventIds`,
        status: "unverified",
        kind: "pitfall",
        supersedes: [],
        author: "agent-maya",
        eventIds: [aged.id],
      });

      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config: retentionConfig({ events_hot_days: 0 }),
        now: NOW,
      });

      expect(report.eventsDeleted).toBe(1);
      expect(store.eventsFor().map((event) => event.id)).toEqual([aged.id]);
    } finally {
      store.close();
    }
  });
});

describe("runRetentionSweep — wiki stale demotion", () => {
  /** Seed an article the way a verified one now comes about: written by one
   * session, checked by a later one. Nothing else can produce `verified`. */
  async function seedVerified(
    repo: string,
    scope: MemoryScope,
    id: string,
    fields: { title: string; body: string; written: string; checked: string },
  ): Promise<void> {
    await writeMemoryFact(repo, {
      scope,
      id,
      topic: "routing",
      title: fields.title,
      body: fields.body,
      date: fields.written,
      source: "user",
      evidence: "seeded",
      status: "unverified",
      supersedes: [],
      author: "the-author",
    });
    await verifyMemoryFact(repo, scope, id, {
      verifier: "a-later-session",
      date: fields.checked,
    });
  }

  async function seedWiki(repo: string): Promise<void> {
    // Checked long enough ago to age out.
    await seedVerified(repo, "repo", "old-verified", {
      title: "Old verified article",
      body: "A belief verified many months ago.",
      written: "2026-02-28",
      checked: "2026-03-01",
    });
    await seedVerified(repo, "repo", "recent-verified", {
      title: "Recently verified article",
      body: "Verified this month.",
      written: "2026-07-09",
      checked: "2026-07-10",
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
      source: "user",
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
    await seedVerified(repo, "global", "global-old-verified", {
      title: "Global old verified article",
      body: "A global belief verified many months ago.",
      written: "2026-02-28",
      checked: "2026-03-01",
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
      const globalDemoted = await readMemoryFact(
        repo,
        "global",
        "global-old-verified",
      );
      expect(globalDemoted?.status).toBe("stale");

      // Untouched: recently verified, unverified, already stale, conflicted.
      expect(
        (await readMemoryFact(repo, "repo", "recent-verified"))?.status,
      ).toBe("verified");
      expect(
        (await readMemoryFact(repo, "repo", "never-verified"))?.status,
      ).toBe("unverified");
      expect(
        (await readMemoryFact(repo, "repo", "already-stale"))?.status,
      ).toBe("stale");
      expect((await readMemoryFact(repo, "repo", "in-conflict"))?.status).toBe(
        "conflicted",
      );

      // The scope index shows the demotion and the log records it.
      const index = await readFile(
        join(repo, ".hive", "memory", "wiki", "index.md"),
        "utf8",
      );
      expect(index).toContain("old-verified");
      expect(index).toMatch(/old-verified \([^)]*\) \[stale]/);
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
      HiveConfigSchema.parse({ memory: { retention: { events_hot_days: 0 } } }),
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({
        memory: { retention: { stale_after_days: -1 } },
      }),
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({
        memory: { retention: { sweep_interval_hours: 0 } },
      }),
    ).toThrow();
    // Strict: an unknown key is a typo, and a typo must not parse.
    expect(() =>
      HiveConfigSchema.parse({ memory: { retention: { events_hot_day: 30 } } }),
    ).toThrow();
  });

  test("a bad section fails the loader loudly", async () => {
    const home = required(Bun.env.HIVE_HOME);
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
    const episodic = openStore(join(repo, "episodic.db"));
    let sweeps = 0;
    const service = new MemoryRetentionService({
      repoRoot: repo,
      config: retentionConfig({ sweep_interval_hours: 1 }),
      episodic,
      serializeMemory: (operation) => operation(),
      rebuildMemoryIndex: async () => ({ count: 0 }),
      runSweep: async () => {
        sweeps += 1;
        return null;
      },
      sweepArtifacts: () => 0,
      artifactRetentionDays: 30,
      log: () => {},
    });
    try {
      service.start();
      // The startup sweep runs immediately so a daemon down past its cadence
      // does not wait a full interval.
      expect(sweeps).toBe(1);
      jest.advanceTimersByTime(3_600_000 - 1);
      expect(sweeps).toBe(1);
      jest.advanceTimersByTime(1);
      expect(sweeps).toBe(2);
      jest.advanceTimersByTime(3_600_000);
      expect(sweeps).toBe(3);

      service.close();
      jest.advanceTimersByTime(7_200_000);
      expect(sweeps).toBe(3);
    } finally {
      service.close();
      episodic.close();
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
      repoRoot: repo,
      episodicStore: episodic,
      retention: retentionConfig(),
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    db.insertAgent(
      agent({
        lastEventAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      }),
    );
    try {
      // killAgentTeardown is the session end this sweep rides (hive_kill's
      // own path).
      await killAgentTeardown(daemon, required(db.getAgentByName("maya")));
      expect(db.getAgentByName("maya")?.status).toBe("dead");

      // The kill's fire-and-forget sweep deletes the aged event; any events
      // the daemon itself projected during the kill are fresh and stay.
      await waitFor(
        () => !episodic.eventsFor().some((event) => event.id === aged.id),
      );
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
