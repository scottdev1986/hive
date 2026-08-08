// memory_recall through the real client parse: the drift catcher for the
// read-path wire contract. The producer-side tests read the payload as loose
// JSON and the live self-test exercises the client only against a deployed
// daemon, so neither runs the daemon's real output through the schema the
// client actually parses with. This test does — a real daemon, its real wire
// payload, and the real client functions from src/cli/mcp.ts — so a field the
// producer drops or the schema narrows fails here.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallMemory, writeMemory } from "../src/cli/mcp";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { HiveDaemon } from "../src/daemon/server";
import type { Spawner, SpawnRequest } from "../src/daemon/spawn/spawn-service";
import { actingAs, type AuthorizedFetch } from "./support/daemon-test-support";
import { estimateTokens } from "../src/memory-service/query";
import { MEMORY_RECALL_HINT_NOTE } from "../src/memory-service/recall";
import { MEMORY_RECALL_DEFAULT_BUDGET } from "../src/memory-service/memory-tools";
import type { AgentRecord } from "../src/schemas/agent";
import type { MemoryWriteInput } from "../src/schemas/memory";
import { required } from "./required";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by memory client tests");
  }
}

async function makeDaemon(): Promise<{ fetcher: AuthorizedFetch }> {
  const home = await mkdtemp(join(tmpdir(), "hive-memory-client-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-client-repo-"));
  tempRoots.push(repoRoot);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
  });
  return { fetcher: actingAs(daemon, "user", "user") };
}

const validWrite = (
  overrides: Partial<MemoryWriteInput> = {},
): MemoryWriteInput => ({
  scope: "repo",
  topic: "testing",
  title: "Test article",
  body: "Test body.",
  source: "agent",
  evidence: "Planted by the memory client wire test",
  status: "unverified",
  supersedes: [],
  ...overrides,
});

// The port is never dialed: the fetcher routes the request into the daemon
// in-process, so every call below is the real client over the real wire shape.
const PORT = 0;

async function seedWiki(fetcher: AuthorizedFetch) {
  const pitfall = await writeMemory(
    PORT,
    validWrite({
      topic: "incidents",
      kind: "pitfall",
      title: "Database lock contention burned the fleet",
      body: "Two writers on one SQLite database deadlocked the fleet.",
    }),
    fetcher,
  );
  const article = await writeMemory(
    PORT,
    validWrite({
      title: "Database test fixtures layout",
      body: "The database fixtures live under test/fixtures.",
    }),
    fetcher,
  );
  return { pitfall, article };
}

describe("memory_recall client parse", () => {
  test("the parsed envelope carries every field the producer sends", async () => {
    const { fetcher } = await makeDaemon();
    const { pitfall } = await seedWiki(fetcher);
    const envelope = await recallMemory(PORT, "database", undefined, fetcher);
    expect(envelope.state).toBe("ok");
    // No embedding leg is wired in this daemon, so the discriminator says so.
    expect(envelope.semantic).toBe("disabled");
    expect(envelope.warning).toBeUndefined();
    expect(envelope.detail).toBeNull();
    expect(envelope.note).toBe(MEMORY_RECALL_HINT_NOTE);
    expect(envelope.budget).toBe(MEMORY_RECALL_DEFAULT_BUDGET);
    expect(envelope.tokens).toBeGreaterThan(0);
    expect(envelope.truncated).toBe(false);
    expect(envelope.omitted).toBe(0);
    expect(envelope.omittedPitfalls).toBe(0);
    expect(envelope.omittedArticles).toBe(0);
    expect(envelope.pitfalls).toHaveLength(1);
    expect(envelope.articles).toHaveLength(1);
    // Every row field the producer sends, including the five the drifted
    // client-local schema used to drop: topic, date, snippet, status, flag.
    const row = required(envelope.pitfalls[0]);
    expect(row.scope).toBe("repo");
    expect(row.topic).toBe("incidents");
    expect(row.id).toBe(pitfall.id);
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.title).toBe("Database lock contention burned the fleet");
    expect(row.snippet.length).toBeGreaterThan(0);
    expect(row.status).toBe("unverified");
    expect(row.flag).toBe("unverified");
    expect(row.pitfall).toBe(true);
    expect(required(envelope.articles[0]).pitfall).toBe(false);
  });

  test("the truncation accounting survives the parse with real values", async () => {
    const { fetcher } = await makeDaemon();
    await seedWiki(fetcher);
    const full = await recallMemory(PORT, "database", undefined, fetcher);
    const pitfallCost = estimateTokens(required(full.pitfalls[0]));
    const clamped = await recallMemory(
      PORT,
      "database",
      { budget: pitfallCost },
      fetcher,
    );
    expect(clamped.budget).toBe(pitfallCost);
    expect(clamped.pitfalls).toHaveLength(1);
    expect(clamped.articles).toHaveLength(0);
    expect(clamped.truncated).toBe(true);
    expect(clamped.omitted).toBe(1);
    expect(clamped.omittedPitfalls).toBe(0);
    expect(clamped.omittedArticles).toBe(1);
  });
});
