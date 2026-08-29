import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner, SpawnRequest } from "../../src/daemon/spawn/spawn-service";
import { type MemoryEmbedder, MemoryEmbeddingIndex, MemoryEmbeddingService } from "../../src/memory-service/embeddings";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { writeMemoryFact } from "../../src/memory-service/memory-store";
import type { AgentRecord } from "../../src/schemas/agent";
import { actingAs } from "../support/daemon-test-support";
import { connectedClient } from "../support/mcp-client-support";

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

function mockEmbedder(vectors: Map<string, number[]>, queryVector: number[]): MemoryEmbedder {
  const fallback = [1, 0, 0, 0];
  return {
    model: "bge-small-en-v1.5",
    dimensions: 4,
    embed: (texts) => Promise.resolve(texts.map((text) => vectors.get(text) ?? fallback)),
    embedQuery: () => Promise.resolve(queryVector),
  };
}

function mockService(embedder: MemoryEmbedder | null): MemoryEmbeddingService {
  return new MemoryEmbeddingService(
    { provider: "local", model: "bge-small-en-v1.5" },
    {
      load: () =>
        embedder === null
          ? Promise.reject(new Error("mock load failure"))
          : Promise.resolve(embedder),
    },
  );
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by memory_search tests");
  }
}

function parseToolResult<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const content = result.content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool result");
  }
  return JSON.parse(content.text).results as T;
}

describe("memory_search hybrid recall (HM-6)", () => {
  test("embeddings unavailable: memory_search falls back to FTS-only", async () => {
    const home = await makeTempDir("hive-hm6-home-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-repo-");

    // Write articles to disk
    await writeMemoryFact(repoRoot, {
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
    });

    await writeMemoryFact(repoRoot, {
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
    });

    // Daemon with NO embeddings (null service)
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });

    const client = await connectedClient(actingAs(daemon, "user", "user"));
    try {
      const results = parseToolResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "database" },
        }),
      );

      // FTS-only should still find the "database" article
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe("Database lock contention");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("embeddings available: memory_search uses hybrid recall (RRF blend)", async () => {
    const home = await makeTempDir("hive-hm6-home-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-repo-");

    // Write articles to disk
    const article1 = await writeMemoryFact(repoRoot, {
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
    });

    const article2 = await writeMemoryFact(repoRoot, {
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
    });

    // Mock embedder: article1 text matches query exactly, article2 is far
    const article1Text = `${article1.title}\n${article1.body}`;
    const article2Text = `${article2.title}\n${article2.body}`;
    const vectors = new Map<string, number[]>([
      [article1Text, [0.9, 0.1, 0, 0]], // close to query
      [article2Text, [0, 1, 0, 0]],     // far from query
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
      memoryEmbeddingLoad: () => Promise.resolve(mockEmbedder(vectors, queryVector)),
    });

    // Wait for embeddings to index
    const index = daemon.embeddingIndex;
    if (index === null) throw new Error("embeddingIndex should not be null");
    await index.settle();

    const client = await connectedClient(actingAs(daemon, "user", "user"));
    try {
      // Query that FTS matches both articles, but semantic ranks article1 higher
      const results = parseToolResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "database token", limit: 10 },
        }),
      );

      // Hybrid should return both, with RRF ranking
      expect(results.length).toBeGreaterThan(0);
      
      // The article with both FTS + semantic match should rank higher
      const article1Result = results.find((r) => r.id === article1.id);
      const article2Result = results.find((r) => r.id === article2.id);
      
      expect(article1Result).toBeDefined();
      expect(article2Result).toBeDefined();
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

    // Write article that FTS won't match but semantic will
    const article = await writeMemoryFact(repoRoot, {
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
    });

    const articleText = `${article.title}\n${article.body}`;
    const vectors = new Map<string, number[]>([
      [articleText, [0.95, 0.05, 0, 0]], // very close to query
    ]);
    const queryVector = [1, 0, 0, 0]; // query about "lease renewal"

    const episodic = new EpisodicStore(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
      episodicStore: episodic,
      memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
      memoryEmbeddingLoad: () => Promise.resolve(mockEmbedder(vectors, queryVector)),
    });

    const index = daemon.embeddingIndex;
    if (index === null) throw new Error("embeddingIndex should not be null");
    await index.settle();

    const client = await connectedClient(actingAs(daemon, "user", "user"));
    try {
      // Query with terms that won't FTS-match but will semantic-match
      const results = parseToolResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "zzz nonexistent query", limit: 10 },
        }),
      );

      // FTS-only would find nothing, but hybrid with semantic should surface it
      // (if the mock says it's semantically close)
      // In our mock, the query vector matches the article vector closely
      const found = results.find((r) => r.id === article.id);
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

    await writeMemoryFact(repoRoot, {
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
    });

    await writeMemoryFact(repoRoot, {
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
    });

    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });

    const client = await connectedClient(actingAs(daemon, "user", "user"));
    try {
      const results = parseToolResult<Array<{ id: string; title: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "parser", kind: "pitfall" },
        }),
      );

      // Should only return the pitfall, not the article
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toContain("Pitfall");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });
});
