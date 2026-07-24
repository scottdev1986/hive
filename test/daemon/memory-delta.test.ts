// Wake-delta memory injection (HiveMemory HM-3 WP6, board #120, plan D6):
// the delta composer (wiki-log parsing, pitfall section, token budget), the
// per-agent high-water mark, and the delivery-lane integration that carries
// the delta into a delivered message.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  demoteMemoryFact,
  getRepoMemoryRoot,
  writeMemoryFact,
} from "../../src/adapters/memory";
import { loadHiveConfig } from "../../src/config/load";
import {
  HiveConfigSchema,
  type AgentRecord,
  type MemoryWriteInput,
} from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import { MessageDelivery, type SessionSender } from "../../src/daemon/delivery";
import { EpisodicStore } from "../../src/daemon/episodic-store";
import {
  composeMemoryDelta,
  createWakeDeltaProvider,
  readWikiLog,
  type WakeDeltaProvider,
} from "../../src/daemon/memory-delta";
import { MemoryIndex } from "../../src/daemon/memory-index";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawner";
import { submitPaste } from "../../src/daemon/testing";

// Global-scope memory lives under HIVE_HOME, so the whole file runs against
// a disposable home (same posture as memory-retention.test.ts).
let tempRoot = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-wake-delta-test-"));
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

function input(
  overrides: Partial<MemoryWriteInput> = {},
): MemoryWriteInput {
  return {
    scope: "repo",
    topic: "testing",
    title: "The login test is flaky",
    body: "The current account of the failure.",
    source: "agent",
    evidence: "Measured in the integration suite",
    status: "verified",
    kind: "article",
    supersedes: [],
    verified: "2026-07-22",
    date: "2026-07-22",
    ...overrides,
  };
}

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "idle",
    taskDescription: "Build the wake delta",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-wake",
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

/** A working TUI: takes the paste, submits it, and the turn-start proves it. */
class SubmittingSessionSender implements SessionSender {
  readonly calls: Array<[string, string]> = [];

  constructor(private readonly db: HiveDatabase) {}

  async sendSessionMessage(agent: AgentRecord, text: string): Promise<void> {
    this.calls.push([agent.name, text]);
    submitPaste(this.db, agent.sessionLocator!.sessionId);
  }
}

const unusedSpawner: Spawner = {
  async spawn() {
    throw new Error("not used");
  },
};

function deliveryWith(
  db: HiveDatabase,
  sender: SessionSender,
  wakeDelta?: WakeDeltaProvider,
): MessageDelivery {
  return new MessageDelivery(
    db,
    sender,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    () => false,
    undefined,
    wakeDelta,
  );
}

describe("readWikiLog", () => {
  test("parses defensively: junk lines are skipped, pipes inside titles survive", async () => {
    const repo = await makeRepo();
    const logDir = join(getRepoMemoryRoot(repo), "wiki");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "log.md"), [
      "# Hive Memory Log",
      "",
      "## [2026-07-22] ingest | A title with a | pipe inside",
      "## not-an-entry",
      "## [22-07-2026] bad-date | nope",
      "## [2026-07-22] missing pipe",
      "random junk",
      "## [2026-07-22] stale-demote | Second entry",
      "",
    ].join("\n"));

    const read = await readWikiLog(repo);
    expect(read.totals).toEqual({ repo: 2, global: 0 });
    expect(read.entries).toHaveLength(2);
    expect(read.entries[0]).toEqual({
      scope: "repo",
      ordinal: 1,
      date: "2026-07-22",
      op: "ingest",
      title: "A title with a | pipe inside",
    });
    expect(read.entries[1]).toMatchObject({
      ordinal: 2,
      op: "stale-demote",
      title: "Second entry",
    });
  });

  test("a missing log contributes no entries", async () => {
    const repo = await makeRepo();
    const read = await readWikiLog(repo);
    expect(read.entries).toEqual([]);
    expect(read.totals).toEqual({ repo: 0, global: 0 });
  });
});

describe("composeMemoryDelta", () => {
  test("contains only post-high-water changes; a second delta has only the newer ones", async () => {
    const repo = await makeRepo();
    await writeMemoryFact(repo, input({ id: "alpha", title: "Alpha article" }));
    const afterFirst = await readWikiLog(repo);
    expect(afterFirst.totals).toEqual({ repo: 1, global: 0 });

    await writeMemoryFact(repo, input({ id: "beta", title: "Beta article" }));
    await demoteMemoryFact(repo, "repo", "alpha", { date: "2026-07-22" });

    const delta = await composeMemoryDelta({
      repoRoot: repo,
      highWater: afterFirst.totals,
      budgetTokens: 300,
      memory: null,
    });
    expect(delta).not.toBeNull();
    expect(delta!.block).toContain(
      "Hive memory update since your last turn — 2 changes",
    );
    expect(delta!.block).toContain("system-injected by the Hive daemon");
    expect(delta!.block).toContain("not authority");
    expect(delta!.block).toContain("new/updated: Beta article");
    expect(delta!.block).toContain("demoted to stale: Alpha article");
    // Alpha's original ingest is behind the mark: it is not re-reported.
    expect(delta!.block).not.toContain("new/updated: Alpha article");
    expect(delta!.advanceTo).toEqual({ repo: 3, global: 0 });

    // Advance the mark, write more: the next delta has only the newer change.
    await writeMemoryFact(repo, input({ id: "gamma", title: "Gamma article" }));
    const second = await composeMemoryDelta({
      repoRoot: repo,
      highWater: delta!.advanceTo,
      budgetTokens: 300,
      memory: null,
    });
    expect(second).not.toBeNull();
    expect(second!.block).toContain("— 1 change ");
    expect(second!.block).toContain("Gamma article");
    expect(second!.block).not.toContain("Beta article");
    expect(second!.block).not.toContain("Alpha article");
  });

  test("a task-matching pitfall appears even when older than the mark; non-matching articles do not", async () => {
    const repo = await makeRepo();
    await writeMemoryFact(repo, input({
      id: "sqlite-pitfall",
      topic: "memory",
      title: "sqlite deadlock on the events table",
      kind: "pitfall",
    }));
    await writeMemoryFact(repo, input({
      id: "garden",
      title: "garden watering schedule",
    }));
    // The mark is past everything: by log position alone there is no delta.
    const mark = (await readWikiLog(repo)).totals;
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(repo);

    const delta = await composeMemoryDelta({
      repoRoot: repo,
      brief: "sqlite deadlock",
      highWater: mark,
      budgetTokens: 300,
      memory: index,
    });
    expect(delta).not.toBeNull();
    expect(delta!.block).toContain("— 0 changes");
    expect(delta!.block).toContain("Pitfalls matching your current task:");
    expect(delta!.block).toContain("sqlite-pitfall");
    expect(delta!.block).toContain("[verified]");
    expect(delta!.block).not.toContain("garden");

    // A brief that matches no pitfall and no changes composes to nothing.
    const empty = await composeMemoryDelta({
      repoRoot: repo,
      brief: "zzzz qqqq",
      highWater: mark,
      budgetTokens: 300,
      memory: index,
    });
    expect(empty).toBeNull();
  });

  test("a flood of changes truncates at the budget with a loud marker; pitfalls survive", async () => {
    const repo = await makeRepo();
    await writeMemoryFact(repo, input({
      id: "sqlite-pitfall",
      topic: "memory",
      title: "sqlite deadlock on the events table",
      kind: "pitfall",
    }));
    for (let i = 1; i <= 30; i++) {
      await writeMemoryFact(repo, input({
        id: `flood-${i}`,
        title: `Flood change number ${i} with a fairly long title to spend budget`,
      }));
    }
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(repo);

    const delta = await composeMemoryDelta({
      repoRoot: repo,
      brief: "sqlite deadlock",
      highWater: { repo: 0, global: 0 },
      budgetTokens: 300,
      memory: index,
    });
    expect(delta).not.toBeNull();
    // 31 log entries (the pitfall's own ingest + 30 floods) are all changes.
    expect(delta!.block).toContain("— 31 changes");
    // The pitfall section is composed first and survives the truncation.
    expect(delta!.block).toContain("Pitfalls matching your current task:");
    expect(delta!.block).toContain("sqlite-pitfall");
    // Loud truncation: the marker names how many changes were cut, and
    // shown + omitted accounts for every change.
    const marker = delta!.block.match(/… (\d+) more changes — use memory_search or memory_query/);
    expect(marker).not.toBeNull();
    const shown = delta!.block.split("\n").filter((line) =>
      line.startsWith("- [repo]")
    ).length;
    expect(shown + Number(marker![1])).toBe(31);
    // The ceiling holds (chars/4 estimate; a handful of join newlines of slack).
    expect(Math.ceil(delta!.block.length / 4)).toBeLessThanOrEqual(310);
  });

  test("an empty delta composes to null — inject nothing", async () => {
    const repo = await makeRepo();
    expect(await composeMemoryDelta({
      repoRoot: repo,
      brief: "anything at all",
      highWater: { repo: 0, global: 0 },
      budgetTokens: 300,
      memory: null,
    })).toBeNull();
  });
});

describe("high-water marks", () => {
  test("survive a daemon restart (new store instance, same path)", async () => {
    const storePath = join(await makeRepo(), "episodic.db");
    const store = new EpisodicStore(storePath);
    expect(store.memoryHighWater("maya")).toBeNull();
    store.advanceMemoryHighWater("maya", { repo: 5, global: 2 });
    store.close();

    const reopened = new EpisodicStore(storePath);
    try {
      expect(reopened.memoryHighWater("maya")).toEqual({ repo: 5, global: 2 });
      expect(reopened.memoryHighWater("nobody")).toBeNull();
    } finally {
      reopened.close();
    }
  });
});

describe("wake-delta delivery integration", () => {
  test("a delivered message carries the labeled delta and advances the mark; the next send injects nothing", async () => {
    const repo = await makeRepo();
    await writeMemoryFact(repo, input({ id: "alpha", title: "Alpha article" }));
    const store = new EpisodicStore(join(repo, "episodic.db"));
    const db = new HiveDatabase(":memory:");
    try {
      // Baseline: alpha is already seen, so only what lands next is a delta.
      store.advanceMemoryHighWater("maya", (await readWikiLog(repo)).totals);
      await writeMemoryFact(repo, input({ id: "beta", title: "Beta article" }));

      const sender = new SubmittingSessionSender(db);
      const delivery = deliveryWith(
        db,
        sender,
        createWakeDeltaProvider({
          repoRoot: () => repo,
          store,
          memory: null,
          budgetTokens: 300,
        }),
      );
      db.insertAgent(agent());

      const message = await delivery.send("sam", "maya", "Please review this.");
      expect(message.deliveredAt === null).toBe(false);
      expect(sender.calls).toHaveLength(1);
      const deliveredText = sender.calls[0]![1];
      expect(deliveredText).toContain("📨 message from sam: Please review this.");
      expect(deliveredText).toContain(
        "🧠 Hive memory update since your last turn — 1 change",
      );
      expect(deliveredText).toContain("system-injected by the Hive daemon");
      expect(deliveredText).toContain("Beta article");
      expect(deliveredText).not.toContain("Alpha article");
      // The mark moved past beta only after the delivery landed.
      expect(store.memoryHighWater("maya")).toEqual({ repo: 2, global: 0 });

      // Nothing new since: the outbound message is byte-identical to one
      // sent without any memory machinery — an empty delta injects nothing.
      await delivery.send("sam", "maya", "Second pass.");
      expect(sender.calls).toHaveLength(2);
      expect(sender.calls[1]![1]).toBe("📨 message from sam: Second pass.");
    } finally {
      db.close();
      store.close();
    }
  });

  test("an agent with no mark is baselined silently, not flooded with history", async () => {
    const repo = await makeRepo();
    await writeMemoryFact(repo, input({ id: "alpha", title: "Alpha article" }));
    const store = new EpisodicStore(join(repo, "episodic.db"));
    const db = new HiveDatabase(":memory:");
    try {
      const sender = new SubmittingSessionSender(db);
      const delivery = deliveryWith(
        db,
        sender,
        createWakeDeltaProvider({
          repoRoot: () => repo,
          store,
          memory: null,
          budgetTokens: 300,
        }),
      );
      db.insertAgent(agent());

      await delivery.send("sam", "maya", "First contact.");
      expect(sender.calls[0]![1]).toBe("📨 message from sam: First contact.");
      expect(store.memoryHighWater("maya")).toEqual({ repo: 1, global: 0 });

      // The next change after baselining is a normal delta.
      await writeMemoryFact(repo, input({ id: "beta", title: "Beta article" }));
      await delivery.send("sam", "maya", "Second contact.");
      expect(sender.calls[1]![1]).toContain("— 1 change ");
      expect(sender.calls[1]![1]).toContain("Beta article");
      expect(sender.calls[1]![1]).not.toContain("Alpha article");
    } finally {
      db.close();
      store.close();
    }
  });

  test("a failing delta never blocks delivery: the plain message still goes out", async () => {
    const repo = await makeRepo();
    const db = new HiveDatabase(":memory:");
    try {
      const failing: WakeDeltaProvider = {
        async compose() {
          throw new Error("delta store on fire");
        },
        advance() {
          throw new Error("must not be reached");
        },
      };
      const sender = new SubmittingSessionSender(db);
      const delivery = deliveryWith(db, sender, failing);
      db.insertAgent(agent());

      const message = await delivery.send("sam", "maya", "Still delivered.");
      expect(message.deliveredAt === null).toBe(false);
      expect(sender.calls).toEqual([
        ["maya", "📨 message from sam: Still delivered."],
      ]);
    } finally {
      db.close();
    }
  });

  test("daemon wiring: episodic store + wake budget inject over hive_send; no budget, no delta", async () => {
    const repo = await makeRepo();
    await writeMemoryFact(repo, input({ id: "alpha", title: "Alpha article" }));
    const store = new EpisodicStore(join(repo, "episodic.db"));
    // Baseline at zero so the seeded article is itself the delta.
    store.advanceMemoryHighWater("maya", { repo: 0, global: 0 });
    const db = new HiveDatabase(":memory:");
    const sender = new SubmittingSessionSender(db);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: unusedSpawner,
      sessionSender: sender,
      repoRoot: repo,
      episodicStore: store,
      wakeBudgetTokens: 300,
    });
    try {
      db.insertAgent(agent());
      await daemon.delivery.send("sam", "maya", "Wired through the daemon.");
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]![1]).toContain("🧠 Hive memory update");
      expect(sender.calls[0]![1]).toContain("Alpha article");
      expect(store.memoryHighWater("maya")).toEqual({ repo: 1, global: 0 });
    } finally {
      await daemon.stop();
      db.close();
    }

    // Same seed, no budget configured: delivery is byte-identical to before.
    const repo2 = await makeRepo();
    await writeMemoryFact(repo2, input({ id: "alpha", title: "Alpha article" }));
    const store2 = new EpisodicStore(join(repo2, "episodic.db"));
    const db2 = new HiveDatabase(":memory:");
    const sender2 = new SubmittingSessionSender(db2);
    const daemon2 = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db: db2,
      spawner: unusedSpawner,
      sessionSender: sender2,
      repoRoot: repo2,
      episodicStore: store2,
    });
    try {
      db2.insertAgent(agent());
      await daemon2.delivery.send("sam", "maya", "No budget, no delta.");
      expect(sender2.calls).toEqual([
        ["maya", "📨 message from sam: No budget, no delta."],
      ]);
    } finally {
      await daemon2.stop();
      db2.close();
    }
  });
});

describe("[memory] wake_budget_tokens config", () => {
  test("defaults to 300 when the key is absent", () => {
    expect(HiveConfigSchema.parse({}).memory.wake_budget_tokens).toBe(300);
  });

  test("explicit values parse; invalid ones are rejected", () => {
    expect(
      HiveConfigSchema.parse({ memory: { wake_budget_tokens: 150 } }).memory
        .wake_budget_tokens,
    ).toBe(150);
    expect(() =>
      HiveConfigSchema.parse({ memory: { wake_budget_tokens: 0 } })
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({ memory: { wake_budget_tokens: -1 } })
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({ memory: { wake_budget_tokens: 1.5 } })
    ).toThrow();
    // Strict: an unknown key is a typo, and a typo must not parse.
    expect(() =>
      HiveConfigSchema.parse({ memory: { wake_budget_token: 300 } })
    ).toThrow();
  });

  test("round-trips through config.toml and a bad value fails the loader loudly", async () => {
    const home = Bun.env.HIVE_HOME!;
    await writeFile(join(home, "config.toml"), "[memory]\nwake_budget_tokens = 222\n");
    try {
      const config = await loadHiveConfig();
      expect(config.memory.wake_budget_tokens).toBe(222);
      expect(config.memory.retention.events_hot_days).toBe(30);
    } finally {
      await rm(join(home, "config.toml"), { force: true });
    }
    await writeFile(join(home, "config.toml"), "[memory]\nwake_budget_tokens = -5\n");
    try {
      await expect(loadHiveConfig()).rejects.toThrow("Invalid hive config");
    } finally {
      await rm(join(home, "config.toml"), { force: true });
    }
  });
});
