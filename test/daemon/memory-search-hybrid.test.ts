import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { type MemoryEmbedder } from "../../src/memory-service/embeddings";
import { EpisodicStore } from "../../src/memory-service/episodic";
import type { AgentRecord } from "../../src/schemas/agent";
import { actingAs } from "../support/daemon-test-support";

const tempRoots: string[] = [];
let previousHiveHome: string | undefined;

beforeEach(() => {
  previousHiveHome = Bun.env.HIVE_HOME;
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function mockEmbedder(
  vectors: Map<string, number[]>,
  queryVector: number[],
): MemoryEmbedder {
  const fallback = [1, 0, 0, 0];
  return {
    model: "bge-small-en-v1.5",
    dimensions: 4,
    embed: (texts) =>
      Promise.resolve(texts.map((text) => vectors.get(text) ?? fallback)),
    embedQuery: () => Promise.resolve(queryVector),
  };
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by memory_search tests");
  }
}

async function connectedClient(daemon: HiveDaemon): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(daemon, "user", "user") },
  );
  const client = new Client({
    name: "hive-memory-hybrid-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  return client;
}

function parseSearchResult<T>(result: {
  content: Array<{ type: string; text?: string }>;
}): { results: T; semantic: string } {
  const content = result.content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool result");
  }
  // SAFETY: JSON.parse returns unknown; type guard above ensures content.text exists
  const payload = JSON.parse(content.text) as {
    results: T;
    semantic: string;
  };
  return payload;
}

function parseWriteResult<T>(result: {
  content: Array<{ type: string; text?: string }>;
}): T {
  const content = result.content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool result");
  }
  // SAFETY: JSON.parse returns unknown; type guard above ensures content.text exists
  return JSON.parse(content.text) as T;
}

describe("memory_search hybrid recall (HM-6)", () => {
  test("embeddings unavailable: memory_search falls back to FTS-only", async () => {
    const home = await makeTempDir("hive-hm6-home-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-repo-");

    // Daemon with NO embeddings (null service)
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });

    const client = await connectedClient(daemon);
    try {
      // Seed via daemon memory_write so FTS is populated
      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          title: "Database lock contention",
          body: "Two writers on one SQLite database deadlocked the fleet.",
          source: "agent",
          evidence: "hybrid-test",
          status: "unverified",
          kind: "article",
          tags: [],
          supersedes: [],
        },
      });

      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          title: "Token budgets clamp recall",
          body: "The recall bundle clamps pitfalls first when the token budget is exceeded.",
          source: "agent",
          evidence: "hybrid-test",
          status: "unverified",
          kind: "article",
          tags: [],
          supersedes: [],
        },
      });

      const payload = parseSearchResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "database" },
        }),
      );

      // FTS-only should still find the "database" article
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]?.title).toBe("Database lock contention");

      // Assert semantic status is disabled (no embeddings)
      expect(payload.semantic).toBe("disabled");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("embeddings available: memory_search uses hybrid recall (RRF blend)", async () => {
    const home = await makeTempDir("hive-hm6-home-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-repo-");

    // Mock embedder vectors (will be populated after daemon creates articles)
    const vectors = new Map<string, number[]>([
      [
        "Database lock contention\nTwo writers on one SQLite database deadlocked the fleet.",
        [0.9, 0.1, 0, 0], // close to query
      ],
      [
        "Token budgets clamp recall\nThe recall bundle clamps pitfalls first when the token budget is exceeded.",
        [0, 1, 0, 0], // far from query
      ],
    ]);
    const queryVector = [1, 0, 0, 0];

    const episodic = new EpisodicStore(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
      episodicStore: episodic,
      memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
      memoryEmbeddingLoad: () =>
        Promise.resolve(mockEmbedder(vectors, queryVector)),
    });

    const client = await connectedClient(daemon);
    try {
      // Seed via daemon memory_write so FTS is populated
      const article1 = parseWriteResult<{ id: string; title: string }>(
        await client.callTool({
          name: "memory_write",
          arguments: {
            scope: "repo",
            topic: "testing",
            title: "Database lock contention",
            body: "Two writers on one SQLite database deadlocked the fleet.",
            source: "agent",
            evidence: "hybrid-test",
            status: "unverified",
            kind: "article",
            tags: [],
            supersedes: [],
          },
        }),
      );

      const article2 = parseWriteResult<{ id: string; title: string }>(
        await client.callTool({
          name: "memory_write",
          arguments: {
            scope: "repo",
            topic: "testing",
            title: "Token budgets clamp recall",
            body: "The recall bundle clamps pitfalls first when the token budget is exceeded.",
            source: "agent",
            evidence: "hybrid-test",
            status: "unverified",
            kind: "article",
            tags: [],
            supersedes: [],
          },
        }),
      );

      // Wait for embeddings to index
      const index = daemon.embeddingIndex;
      if (index === null) throw new Error("embeddingIndex should not be null");
      await index.settle();

      // Query that FTS matches both articles, but semantic ranks article1 higher
      const payload = parseSearchResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "database token", limit: 10 },
        }),
      );

      // Assert semantic status is hybrid
      expect(payload.semantic).toBe("hybrid");

      const results = payload.results;

      // RRF blend: article1 has high FTS + high semantic, article2 has low FTS + low semantic
      // article1 should rank higher due to better combined score
      expect(results.length).toBeGreaterThanOrEqual(2);

      const article1Index = results.findIndex((r) => r.id === article1.id);
      const article2Index = results.findIndex((r) => r.id === article2.id);

      expect(article1Index).toBeGreaterThanOrEqual(0);
      expect(article2Index).toBeGreaterThanOrEqual(0);

      // Verify RRF rank: article1 (high semantic + FTS match) ranks before article2
      expect(article1Index).toBeLessThan(article2Index);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
      episodic.close();
    }
  });

  test("semantic-only hit surfaces via RRF (paraphrase that FTS misses)", async () => {
    const home = await makeTempDir("hive-hm6-home-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-repo-");

    const vectors = new Map<string, number[]>([
      [
        "Lease renewal blocks overlapping agents\nThe composer lease must be renewed every fifteen seconds or the workspace hides the agent.",
        [0.95, 0.05, 0, 0], // very close to query
      ],
    ]);
    const queryVector = [1, 0, 0, 0];

    const episodic = new EpisodicStore(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
      episodicStore: episodic,
      memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
      memoryEmbeddingLoad: () =>
        Promise.resolve(mockEmbedder(vectors, queryVector)),
    });

    const client = await connectedClient(daemon);
    try {
      // Seed via daemon memory_write so FTS is populated
      const article = parseWriteResult<{ id: string; title: string }>(
        await client.callTool({
          name: "memory_write",
          arguments: {
            scope: "repo",
            topic: "testing",
            title: "Lease renewal blocks overlapping agents",
            body: "The composer lease must be renewed every fifteen seconds or the workspace hides the agent.",
            source: "agent",
            evidence: "hybrid-test",
            status: "unverified",
            kind: "article",
            tags: [],
            supersedes: [],
          },
        }),
      );

      const index = daemon.embeddingIndex;
      if (index === null) throw new Error("embeddingIndex should not be null");
      await index.settle();

      // Query with terms that won't FTS-match but will semantic-match
      const payload = parseSearchResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "zzz nonexistent query", limit: 10 },
        }),
      );

      // Assert semantic status is hybrid
      expect(payload.semantic).toBe("hybrid");

      // FTS-only would find nothing, but hybrid with semantic should surface it
      const found = payload.results.find((r) => r.id === article.id);
      expect(found).toBeDefined();
      expect(found?.title).toBe("Lease renewal blocks overlapping agents");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
      episodic.close();
    }
  });

  test("kind=pitfall filter works with hybrid recall", async () => {
    const home = await makeTempDir("hive-hm6-home-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-repo-");

    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });

    const client = await connectedClient(daemon);
    try {
      // Seed via daemon memory_write so FTS is populated
      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          title: "Pitfall: null check missing",
          body: "The parser crashes on null input.",
          source: "agent",
          evidence: "hybrid-test",
          status: "unverified",
          kind: "pitfall",
          tags: [],
          supersedes: [],
        },
      });

      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          title: "Parser test coverage",
          body: "The parser has tests in test/parser.test.ts.",
          source: "agent",
          evidence: "hybrid-test",
          status: "unverified",
          kind: "article",
          tags: [],
          supersedes: [],
        },
      });

      const payload = parseSearchResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "parser", kind: "pitfall" },
        }),
      );

      // Assert semantic status is disabled (no embeddings)
      expect(payload.semantic).toBe("disabled");

      // Should only return the pitfall, not the article
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]?.title).toContain("Pitfall");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });
});
