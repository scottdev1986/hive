// The HiveMemory plan §5 MCP surface: memory_note (episodic fact write with
// dedup refusal), memory_recall (the trigger protocol's ranked bundle as a
// tool), memory_promote (D3 queen/operator-only pitfall promotion with a
// redaction gate).
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../../src/schemas";
import { readMemoryFact } from "../../src/adapters/memory";
import type { Role } from "../../src/daemon/capabilities";
import { HiveDatabase } from "../../src/daemon/db";
import { estimateTokens } from "../../src/daemon/episodic-projections";
import { EpisodicStore } from "../../src/daemon/episodic-store";
import {
  buildMemoryRecallBundle,
  MEMORY_RECALL_HINT_NOTE,
} from "../../src/daemon/memory-triggers";
import { projectHiveUuid } from "../../src/daemon/project-state";
import { HiveDaemon, MEMORY_RECALL_DEFAULT_BUDGET } from "../../src/daemon/server";
import type { SpawnRequest, Spawner } from "../../src/daemon/spawner";
import { actingAs } from "../../src/daemon/testing";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
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
type ToolValue = any;

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): ToolValue {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as ToolValue;
}

async function connectedClient(
  daemon: HiveDaemon,
  subject = "operator",
  role: Role = "operator",
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
    ...(options.episodic === undefined ? {} : { episodicStore: options.episodic }),
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

describe("memory_note", () => {
  test("records an episodic fact sourced from the caller's identity", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic });
    const client = await connectedClient(daemon);
    const result = await client.callTool({
      name: "memory_note",
      arguments: {
        topic: "deploy",
        title: "Deploys need a warm cache",
        body: "A cold cache doubles deploy time.",
        confidence: 0.7,
      },
    });
    expect(result.isError).not.toBe(true);
    const value = textValue(result);
    expect(value.state).toBe("recorded");
    expect(value.fact.kind).toBe("fact");
    expect(value.fact.source).toBe("operator");
    expect(value.fact.confidence).toBe(0.7);
    const stored = episodic.currentFacts();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(value.fact.id);
    expect(stored[0]?.title).toBe("Deploys need a warm cache");
    expect(stored[0]?.invalidAt).toBeNull();
    episodic.close();
  });

  test("a duplicate normalized title is refused, naming the existing fact", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic });
    const client = await connectedClient(daemon);
    const first = textValue(await client.callTool({
      name: "memory_note",
      arguments: {
        topic: "deploy",
        title: "Deploys need a warm cache",
        body: "Original body.",
      },
    }));
    expect(first.state).toBe("recorded");
    // Case and whitespace differences collapse under normalizeTitle.
    const duplicate = textValue(await client.callTool({
      name: "memory_note",
      arguments: {
        topic: "deploy",
        title: "deploys  NEED a warm cache",
        body: "Conflicting body.",
      },
    }));
    expect(duplicate.state).toBe("duplicate");
    expect(duplicate.existing.id).toBe(first.fact.id);
    expect(duplicate.existing.body).toBe("Original body.");
    expect(episodic.currentFacts()).toHaveLength(1);
    episodic.close();
  });

  test("the contradiction path invalidates and supersedes, never deletes", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic });
    const client = await connectedClient(daemon);
    const first = textValue(await client.callTool({
      name: "memory_note",
      arguments: { topic: "deploy", title: "Cache belief", body: "Old belief." },
    }));
    // The path the refusal points at: invalidate the existing fact, then the
    // replacement records cleanly because the title is no longer current.
    const invalidated = episodic.invalidateFact(first.fact.id);
    expect(invalidated?.invalidAt).not.toBeNull();
    const replacement = textValue(await client.callTool({
      name: "memory_note",
      arguments: { topic: "deploy", title: "Cache belief", body: "New belief." },
    }));
    expect(replacement.state).toBe("recorded");
    expect(replacement.fact.id).not.toBe(first.fact.id);
    const current = episodic.currentFacts();
    expect(current).toHaveLength(1);
    expect(current[0]?.body).toBe("New belief.");
    // The old row stays, invalid_at-stamped — bi-temporal history.
    const history = episodic.factsAsOf(new Date().toISOString());
    expect(history.some((fact) => fact.id === first.fact.id)).toBe(false);
    episodic.close();
  });

  test("reader role is denied (memory:write gate)", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic });
    const client = await connectedClient(daemon, "some-reader", "reader");
    const result = await client.callTool({
      name: "memory_note",
      arguments: { topic: "deploy", title: "Nope", body: "Nope." },
    });
    expect(result.isError).toBe(true);
    expect(episodic.currentFacts()).toHaveLength(0);
    episodic.close();
  });

  test("a daemon without an episodic store reports absent", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    const result = textValue(await client.callTool({
      name: "memory_note",
      arguments: { topic: "deploy", title: "Note", body: "Body." },
    }));
    expect(result.state).toBe("absent");
  });
});

describe("memory_recall", () => {
  async function seedWiki(client: Client) {
    const pitfall = textValue(await client.callTool({
      name: "memory_write",
      arguments: validWrite({
        topic: "incidents",
        kind: "pitfall",
        title: "Database lock contention burned the fleet",
        body: "Two writers on one SQLite database deadlocked the fleet.",
      }),
    }));
    const article = textValue(await client.callTool({
      name: "memory_write",
      arguments: validWrite({
        title: "Database test fixtures layout",
        body: "The database fixtures live under test/fixtures.",
      }),
    }));
    return { pitfall, article };
  }

  test("returns the labeled bundle with pitfalls partitioned", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    const { pitfall, article } = await seedWiki(client);
    const result = textValue(await client.callTool({
      name: "memory_recall",
      arguments: { query: "database" },
    }));
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
    const full = textValue(await client.callTool({
      name: "memory_recall",
      arguments: { query: "database" },
    }));
    const pitfallCost = estimateTokens(full.pitfalls[0]);
    const clamped = textValue(await client.callTool({
      name: "memory_recall",
      arguments: { query: "database", budget: pitfallCost },
    }));
    expect(clamped.budget).toBe(pitfallCost);
    expect(clamped.pitfalls).toHaveLength(1);
    expect(clamped.articles).toHaveLength(0);
    expect(clamped.truncated).toBe(true);
    expect(clamped.omitted).toBe(1);
    // A budget may only lower the ceiling, never raise it.
    const raised = textValue(await client.callTool({
      name: "memory_recall",
      arguments: { query: "database", budget: 999_999 },
    }));
    expect(raised.budget).toBe(MEMORY_RECALL_DEFAULT_BUDGET);
  });

  test("empty and absent are distinct states", async () => {
    const { daemon, repoRoot } = await makeDaemon();
    const client = await connectedClient(daemon);
    await seedWiki(client);
    const empty = textValue(await client.callTool({
      name: "memory_recall",
      arguments: { query: "zzz-no-such-token-anywhere" },
    }));
    expect(empty.state).toBe("empty");
    expect(empty.pitfalls).toEqual([]);
    expect(empty.articles).toEqual([]);
    // absent: no wiki search index wired at all (unit-level, the daemon's
    // own index is always constructed).
    const absent = await buildMemoryRecallBundle("database", {
      memory: null,
      repoRoot: () => repoRoot,
    });
    expect(absent.state).toBe("absent");
    expect(absent.pitfalls).toEqual([]);
    expect(absent.articles).toEqual([]);
  });
});

describe("memory_promote", () => {
  async function seedPitfall(
    client: Client,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const written = textValue(await client.callTool({
      name: "memory_write",
      arguments: validWrite({
        topic: "incidents",
        kind: "pitfall",
        title: "Unanchored searches OOM the box",
        body: "A repo-wide search with an unanchored pattern allocated 13 GB.",
        ...overrides,
      }),
    }));
    return written.id as string;
  }

  test("promotes a repo pitfall to global with origin_project provenance", async () => {
    const { daemon, repoRoot } = await makeDaemon();
    const client = await connectedClient(daemon);
    const id = await seedPitfall(client);
    const result = textValue(await client.callTool({
      name: "memory_promote",
      arguments: { id },
    }));
    expect(result.promoted.scope).toBe("global");
    expect(result.origin).toEqual({ scope: "repo", id });
    const promoted = await readMemoryFact(repoRoot, "global", result.promoted.id);
    expect(promoted).not.toBeNull();
    expect(promoted?.kind).toBe("pitfall");
    expect(promoted?.status).toBe("unverified");
    expect(promoted?.tags).toContain("promoted");
    expect(promoted?.body).toContain(
      `project ${projectHiveUuid(repoRoot)}`,
    );
    expect(promoted?.body).toContain(`\`${id}\``);
    // The daemon's serialized write path kept the FTS index consistent.
    const search = textValue(await client.callTool({
      name: "memory_search",
      arguments: { query: "unanchored", scope: "global" },
    }));
    expect(search.some((hit: { id: string }) => hit.id === promoted?.id))
      .toBe(true);
  });

  test("non-pitfall articles are refused", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    const written = textValue(await client.callTool({
      name: "memory_write",
      arguments: validWrite({ title: "An ordinary article" }),
    }));
    const result = await client.callTool({
      name: "memory_promote",
      arguments: { id: written.id },
    });
    expect(result.isError).toBe(true);
  });

  test("a body with an absolute path is refused with findings", async () => {
    const { daemon, repoRoot } = await makeDaemon();
    const client = await connectedClient(daemon);
    const id = await seedPitfall(client, {
      title: "Pathful pitfall",
      body: `The fixture lived at ${repoRoot}/secrets and /Users/alice/other.`,
    });
    const result = await client.callTool({
      name: "memory_promote",
      arguments: { id },
    });
    expect(result.isError).toBe(true);
    const message = JSON.stringify(result.content);
    expect(message).toContain("repo-path");
    expect(message).toContain("absolute-path");
    // Nothing crossed the boundary.
    const search = textValue(await client.callTool({
      name: "memory_search",
      arguments: { query: "Pathful", scope: "global" },
    }));
    expect(search).toEqual([]);
  });

  test("a body with a token-like string is refused with findings", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    const id = await seedPitfall(client, {
      title: "Tokenful pitfall",
      body: "The leaked key was sk-abcdef0123456789xyz in the log line.",
    });
    const result = await client.callTool({
      name: "memory_promote",
      arguments: { id },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("token-like");
  });

  test("writer and reader roles are denied; orchestrator is allowed", async () => {
    const { daemon } = await makeDaemon();
    const operator = await connectedClient(daemon);
    const writerId = await seedPitfall(operator, { title: "Writer target" });
    const readerId = await seedPitfall(operator, { title: "Reader target" });
    const queenId = await seedPitfall(operator, { title: "Queen target" });

    const writer = await connectedClient(daemon, "some-writer", "writer");
    expect(
      (await writer.callTool({
        name: "memory_promote",
        arguments: { id: writerId },
      })).isError,
    ).toBe(true);
    const reader = await connectedClient(daemon, "some-reader", "reader");
    expect(
      (await reader.callTool({
        name: "memory_promote",
        arguments: { id: readerId },
      })).isError,
    ).toBe(true);
    const queen = await connectedClient(daemon, "queen", "orchestrator");
    const promoted = textValue(await queen.callTool({
      name: "memory_promote",
      arguments: { id: queenId },
    }));
    expect(promoted.promoted.scope).toBe("global");
  });
});
