// memory_recall: the trigger protocol's ranked bundle as a tool.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Role } from "../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { actingAs } from "../support/daemon-test-support";
import type { EpisodicStore } from "../../src/memory-service/episodic";
import { estimateTokens } from "../../src/memory-service/query";
import {
  buildMemoryRecallBundle,
  MEMORY_RECALL_HINT_NOTE,
} from "../../src/memory-service/recall";
import { MEMORY_RECALL_DEFAULT_BUDGET } from "../../src/memory-service/memory-tools";
import type { AgentRecord } from "../../src/schemas/agent";

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

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-memory-wp8-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  return home;
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by memory tests");
  }
}

// The MCP text payload is JSON; tests index into it loosely by design.
// biome-ignore lint/suspicious/noExplicitAny: MCP JSON is intentionally decoded loosely in this test.
type ToolValue = any;

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): ToolValue {
  const content = (
    result as {
      content: Array<{ type: string; text?: string }>;
    }
  ).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as ToolValue;
}

async function connectedClient(
  daemon: HiveDaemon,
  subject = "user",
  role: Role = "user",
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(daemon, subject, role) },
  );
  const client = new Client({ name: "hive-memory-wp8-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function makeDaemon(options: { episodic?: EpisodicStore } = {}) {
  await makeHome();
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-wp8-repo-"));
  tempRoots.push(repoRoot);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
    ...(options.episodic === undefined
      ? {}
      : { episodicStore: options.episodic }),
  });
  return { daemon, repoRoot };
}

function validWrite(overrides: Record<string, unknown> = {}) {
  return {
    scope: "repo",
    topic: "testing",
    title: "Test article",
    body: "Test body.",
    source: "agent",
    evidence: "Measured by the MCP integration test",
    status: "unverified",
    supersedes: [],
    ...overrides,
  };
}

describe("memory_recall", () => {
  async function seedWiki(client: Client) {
    const pitfall = textValue(
      await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          topic: "incidents",
          kind: "pitfall",
          title: "Database lock contention burned the fleet",
          body: "Two writers on one SQLite database deadlocked the fleet.",
        }),
      }),
    );
    const article = textValue(
      await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          title: "Database test fixtures layout",
          body: "The database fixtures live under test/fixtures.",
        }),
      }),
    );
    return { pitfall, article };
  }

  test("returns the labeled bundle with pitfalls partitioned", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    const { pitfall, article } = await seedWiki(client);
    const result = textValue(
      await client.callTool({
        name: "memory_recall",
        arguments: { query: "database" },
      }),
    );
    expect(result.state).toBe("ok");
    expect(result.note).toBe(MEMORY_RECALL_HINT_NOTE);
    expect(result.budget).toBe(MEMORY_RECALL_DEFAULT_BUDGET);
    expect(result.truncated).toBe(false);
    expect(result.pitfalls).toHaveLength(1);
    expect(result.pitfalls[0].id).toBe(pitfall.id);
    expect(result.pitfalls[0].pitfall).toBe(true);
    expect(result.pitfalls[0].flag).toBe("unverified");
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].id).toBe(article.id);
    expect(result.articles[0].pitfall).toBe(false);
  });

  test("budget clamps pitfalls-first with a loud truncation marker", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    await seedWiki(client);
    const full = textValue(
      await client.callTool({
        name: "memory_recall",
        arguments: { query: "database" },
      }),
    );
    const pitfallCost = estimateTokens(full.pitfalls[0]);
    const clamped = textValue(
      await client.callTool({
        name: "memory_recall",
        arguments: { query: "database", budget: pitfallCost },
      }),
    );
    expect(clamped.budget).toBe(pitfallCost);
    expect(clamped.pitfalls).toHaveLength(1);
    expect(clamped.articles).toHaveLength(0);
    expect(clamped.truncated).toBe(true);
    expect(clamped.omitted).toBe(1);
    // A budget may only lower the ceiling, never raise it.
    const raised = textValue(
      await client.callTool({
        name: "memory_recall",
        arguments: { query: "database", budget: 999_999 },
      }),
    );
    expect(raised.budget).toBe(MEMORY_RECALL_DEFAULT_BUDGET);
  });

  test("a built index with no match is empty", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    await seedWiki(client);
    const empty = textValue(
      await client.callTool({
        name: "memory_recall",
        arguments: { query: "zzz-no-such-token-anywhere" },
      }),
    );
    expect(empty.state).toBe("empty");
    expect(empty.pitfalls).toEqual([]);
    expect(empty.articles).toEqual([]);
  });

  test("no wiki search index is absent", async () => {
    const absent = await buildMemoryRecallBundle("database", {
      memory: null,
      repoRoot: () => "/unused",
    });
    expect(absent.state).toBe("absent");
    expect(absent.pitfalls).toEqual([]);
    expect(absent.articles).toEqual([]);
  });
});
