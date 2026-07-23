// Unit tests for the HiveMemory HM-5 semantic leg (board #122, plan D4):
// vector-store CRUD + prune, cosine ranking, the hybrid RRF recall blend,
// the unavailable-degradation contract, and config validation. The embedder
// is ALWAYS mocked here — `bun test` never downloads a model. The real-model
// paraphrase-recall gate lives in test/memory-embedding-live.test.ts behind
// HIVE_LIVE_MEMORY_EMBEDDINGS=1.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryFact } from "../adapters/memory";
import { HiveConfigSchema } from "../schemas";
import { HiveDatabase } from "./db";
import { EpisodicStore } from "./episodic-store";
import {
  cosineSimilarity,
  EMBEDDINGS_RUNTIME_BUNDLE,
  EMBEDDINGS_RUNTIME_HOME_ENV,
  embeddingsRuntimeDir,
  MEMORY_EMBEDDING_API_KEY_ENV,
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
  probeExternalRuntime,
  type MemoryEmbedder,
} from "./memory-embeddings";
import { MemoryIndex } from "./memory-index";
import { buildMemoryRecallBundle } from "./memory-triggers";
import { HiveDaemon } from "./server";
import type { SpawnRequest, Spawner } from "./spawner";
import type { AgentRecord } from "../schemas";

const tempRoots: string[] = [];
let previousHiveHome: string | undefined;
let previousApiKey: string | undefined;
let previousEmbeddingsHome: string | undefined;

beforeEach(() => {
  previousHiveHome = Bun.env.HIVE_HOME;
  previousApiKey = Bun.env[MEMORY_EMBEDDING_API_KEY_ENV];
  previousEmbeddingsHome = Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV];
});

afterEach(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  if (previousApiKey === undefined) delete Bun.env[MEMORY_EMBEDDING_API_KEY_ENV];
  else Bun.env[MEMORY_EMBEDDING_API_KEY_ENV] = previousApiKey;
  if (previousEmbeddingsHome === undefined) delete Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV];
  else Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV] = previousEmbeddingsHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** A deterministic mock embedder: 4-dim vectors from a text lookup, with a
 * fixed query vector. Tests control the geometry exactly. */
function mockEmbedder(overrides: {
  vectors?: Map<string, number[]>;
  queryVector?: number[];
  model?: string;
  failOnEmbed?: boolean;
} = {}): MemoryEmbedder {
  const vectors = overrides.vectors ?? new Map<string, number[]>();
  const fallback = [1, 0, 0, 0];
  return {
    model: overrides.model ?? "bge-small-en-v1.5",
    dimensions: 4,
    embed: (texts) => {
      if (overrides.failOnEmbed === true) {
        return Promise.reject(new Error("mock embed failure"));
      }
      return Promise.resolve(
        texts.map((text) => vectors.get(text) ?? fallback),
      );
    },
    embedQuery: () => Promise.resolve(overrides.queryVector ?? [1, 0, 0, 0]),
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

describe("config schema ([memory] embedding knobs, D4)", () => {
  test("defaults are local + bge-small-en-v1.5", () => {
    const memory = HiveConfigSchema.parse({}).memory;
    expect(memory.embedding_provider).toBe("local");
    expect(memory.embedding_model).toBe("bge-small-en-v1.5");
  });

  test("api provider and all-MiniLM-L6-v2 parse", () => {
    const memory = HiveConfigSchema.parse({
      memory: {
        embedding_provider: "api",
        embedding_model: "all-MiniLM-L6-v2",
      },
    }).memory;
    expect(memory.embedding_provider).toBe("api");
    expect(memory.embedding_model).toBe("all-MiniLM-L6-v2");
  });

  test("unknown provider or model is rejected", () => {
    expect(() =>
      HiveConfigSchema.parse({ memory: { embedding_provider: "auto" } })
    ).toThrow();
    expect(() =>
      HiveConfigSchema.parse({ memory: { embedding_model: "text-embedding-3" } })
    ).toThrow();
  });

  test("unknown keys are rejected (strict)", () => {
    expect(() =>
      HiveConfigSchema.parse({ memory: { embedding_fallback: "api" } })
    ).toThrow();
  });
});

describe("EpisodicStore vector store", () => {
  test("upsert + read round-trips the Float32 vector", () => {
    const store = new EpisodicStore(":memory:");
    const vector = Float32Array.from([0.5, -0.25, 1, 0]);
    store.upsertMemoryEmbedding({
      kind: "article",
      scope: "repo",
      sourceId: "a1",
      model: "bge-small-en-v1.5",
      vector,
    });
    const rows = store.memoryEmbeddings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "article",
      scope: "repo",
      sourceId: "a1",
      model: "bge-small-en-v1.5",
      dimensions: 4,
    });
    expect([...rows[0]!.vector]).toEqual([0.5, -0.25, 1, 0]);
    store.close();
  });

  test("upsert overwrites the same key; remove deletes it", () => {
    const store = new EpisodicStore(":memory:");
    const base = {
      kind: "fact" as const,
      scope: "",
      sourceId: "f1",
      model: "bge-small-en-v1.5",
    };
    store.upsertMemoryEmbedding({ ...base, vector: Float32Array.from([1, 0]) });
    store.upsertMemoryEmbedding({ ...base, vector: Float32Array.from([0, 1]) });
    expect(store.memoryEmbeddings()).toHaveLength(1);
    expect([...store.memoryEmbeddings()[0]!.vector]).toEqual([0, 1]);
    store.removeMemoryEmbedding("fact", "", "f1");
    expect(store.memoryEmbeddings()).toHaveLength(0);
    store.close();
  });

  test("prune drops rows whose source disappeared, keeps the rest", () => {
    const store = new EpisodicStore(":memory:");
    store.upsertMemoryEmbedding({
      kind: "article",
      scope: "repo",
      sourceId: "keep-me",
      model: "m",
      vector: Float32Array.from([1]),
    });
    store.upsertMemoryEmbedding({
      kind: "article",
      scope: "repo",
      sourceId: "deleted",
      model: "m",
      vector: Float32Array.from([1]),
    });
    store.upsertMemoryEmbedding({
      kind: "fact",
      scope: "",
      sourceId: "current",
      model: "m",
      vector: Float32Array.from([1]),
    });
    store.upsertMemoryEmbedding({
      kind: "fact",
      scope: "",
      sourceId: "invalidated",
      model: "m",
      vector: Float32Array.from([1]),
    });
    const pruned = store.pruneMemoryEmbeddings({
      articles: new Set(["repo:keep-me"]),
      facts: new Set(["current"]),
    });
    expect(pruned).toBe(2);
    expect(store.memoryEmbeddings().map((row) => row.sourceId).sort())
      .toEqual(["current", "keep-me"]);
    store.close();
  });

  test("a v1 store migrates to v2 on open", () => {
    // v1 had no memory_embeddings table; opening any store now must have it
    // and the bumped schema version.
    const store = new EpisodicStore(":memory:");
    expect(store.memoryEmbeddings()).toEqual([]);
    store.upsertMemoryEmbedding({
      kind: "article",
      scope: "global",
      sourceId: "x",
      model: "m",
      vector: Float32Array.from([1]),
    });
    expect(store.memoryEmbeddings()).toHaveLength(1);
    store.close();
  });
});

describe("cosineSimilarity", () => {
  test("identical / orthogonal / opposite / zero", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity(Float32Array.from([1, 0]), [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity(Float32Array.from([1, 0]), [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity(Float32Array.from([0, 0]), [1, 0])).toBe(0);
  });
});

describe("MemoryEmbeddingService", () => {
  test("loads lazily and memoizes the embedder", async () => {
    let loads = 0;
    const service = new MemoryEmbeddingService(
      { provider: "local", model: "bge-small-en-v1.5" },
      {
        load: () => {
          loads += 1;
          return Promise.resolve(mockEmbedder());
        },
      },
    );
    expect(service.status()).toEqual({ state: "pending" });
    expect(loads).toBe(0);
    const first = await service.embedder();
    const second = await service.embedder();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(loads).toBe(1);
  });

  test("a load failure degrades to a labeled unavailable state, never throws", async () => {
    let loads = 0;
    const service = new MemoryEmbeddingService(
      { provider: "local", model: "bge-small-en-v1.5" },
      {
        load: () => {
          loads += 1;
          return Promise.reject(new Error("onnx exploded"));
        },
      },
    );
    expect(await service.embedder()).toBeNull();
    const status = service.status();
    expect(status.state).toBe("unavailable");
    expect((status as { detail: string }).detail).toContain("onnx exploded");
    // The failure is memoized — no crash-loop retry.
    expect(await service.embedder()).toBeNull();
    expect(loads).toBe(1);
  });

  test("api provider without the key env reports not-configured, loads nothing", async () => {
    delete Bun.env[MEMORY_EMBEDDING_API_KEY_ENV];
    let loads = 0;
    const service = new MemoryEmbeddingService(
      { provider: "api", model: "bge-small-en-v1.5" },
      {
        load: () => {
          loads += 1;
          return Promise.resolve(mockEmbedder());
        },
      },
    );
    const status = service.status();
    expect(status.state).toBe("unavailable");
    expect((status as { detail: string }).detail)
      .toContain(MEMORY_EMBEDDING_API_KEY_ENV);
    expect(await service.embedder()).toBeNull();
    expect(loads).toBe(0);
  });

  test("api provider with the key env still reports honestly: no API provider ships", async () => {
    Bun.env[MEMORY_EMBEDDING_API_KEY_ENV] = "test-key";
    const service = new MemoryEmbeddingService({
      provider: "api",
      model: "bge-small-en-v1.5",
    });
    const status = service.status();
    expect(status.state).toBe("unavailable");
    expect((status as { detail: string }).detail).toContain("local-only");
    expect(await service.embedder()).toBeNull();
  });
});

describe("external embedding runtime resolution (defect D1)", () => {
  async function plantBundle(body: string): Promise<string> {
    const runtimeDir = await makeTempDir("hive-hm5-runtime-");
    await mkdir(join(runtimeDir, "dist"), { recursive: true });
    await writeFile(join(runtimeDir, EMBEDDINGS_RUNTIME_BUNDLE), body);
    Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV] = runtimeDir;
    return runtimeDir;
  }

  test("runtime dir: HIVE_EMBEDDINGS_HOME wins, then HIVE_HOME's tools dir", async () => {
    Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV] = "/override/runtime";
    expect(embeddingsRuntimeDir()).toBe("/override/runtime");
    delete Bun.env[EMBEDDINGS_RUNTIME_HOME_ENV];
    Bun.env.HIVE_HOME = "/tmp/hive-test-home";
    expect(embeddingsRuntimeDir())
      .toBe(join("/tmp/hive-test-home", "tools", "embeddings"));
  });

  test("a broken bundle is a DISTINCT labeled state, never a generic failure", async () => {
    await plantBundle('throw new Error("bundle syntax exploded");\n');
    const service = new MemoryEmbeddingService({
      provider: "local",
      model: "bge-small-en-v1.5",
    });
    expect(await service.embedder()).toBeNull();
    const status = service.status();
    expect(status.state).toBe("unavailable");
    const detail = (status as { detail: string }).detail;
    expect(detail).toContain("embedding-runtime-broken");
    expect(detail).toContain("bundle syntax exploded");
  });

  test("a native load failure is labeled embedding-native-unloadable", async () => {
    await plantBundle(
      'throw new Error("Cannot find module onnxruntime_binding.node");\n',
    );
    const service = new MemoryEmbeddingService({
      provider: "local",
      model: "bge-small-en-v1.5",
    });
    expect(await service.embedder()).toBeNull();
    const detail = (service.status() as { detail: string }).detail;
    expect(detail).toContain("embedding-native-unloadable");
  });

  test("the install probe refuses a runtime dir with no bundle", async () => {
    const runtimeDir = await makeTempDir("hive-hm5-runtime-");
    await expect(probeExternalRuntime(runtimeDir, "bge-small-en-v1.5", "/tmp"))
      .rejects.toThrow("embedding-runtime-missing");
  });
});

describe("MemoryEmbeddingIndex", () => {
  function makeIndex(embedder: MemoryEmbedder | null): {
    store: EpisodicStore;
    index: MemoryEmbeddingIndex;
    logged: string[];
  } {
    const store = new EpisodicStore(":memory:");
    const service = mockService(embedder);
    const logged: string[] = [];
    const index = new MemoryEmbeddingIndex({
      store,
      service,
      log: (message) => logged.push(message),
    });
    return { store, index, logged };
  }

  test("upsertArticle stores the embedded vector; search ranks by cosine", async () => {
    const near = [0.9, 0.1, 0, 0];
    const far = [0, 1, 0, 0];
    const { store, index } = makeIndex(mockEmbedder({
      vectors: new Map([
        ["near text", near],
        ["far text", far],
      ]),
      queryVector: [1, 0, 0, 0],
    }));
    await index.upsertArticle("repo", "near", "near text");
    await index.upsertArticle("repo", "far", "far text");
    expect(store.memoryEmbeddings({ kind: "article" })).toHaveLength(2);
    const hits = await index.searchArticles("anything", 10);
    expect(hits).not.toBeNull();
    expect(hits!.map((hit) => hit.id)).toEqual(["near", "far"]);
    expect(hits![0]!.score).toBeGreaterThan(hits![1]!.score);
    store.close();
  });

  test("search honors the limit and orders ties deterministically", async () => {
    const { store, index } = makeIndex(mockEmbedder());
    for (const id of ["b", "a", "c"]) {
      await index.upsertArticle("repo", id, `${id} text`);
    }
    const hits = await index.searchArticles("q", 2);
    // All vectors identical (mock fallback) → score ties break on scope/id.
    expect(hits!.map((hit) => hit.id)).toEqual(["a", "b"]);
    store.close();
  });

  test("searchArticles returns null when the surface is unavailable", async () => {
    const { store, index } = makeIndex(null);
    expect(await index.searchArticles("q", 10)).toBeNull();
    store.close();
  });

  test("upsert is failure-isolated: an embed error logs and stores nothing", async () => {
    const { store, index, logged } = makeIndex(
      mockEmbedder({ failOnEmbed: true }),
    );
    await index.upsertArticle("repo", "x", "x text");
    expect(store.memoryEmbeddings()).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("mock embed failure");
    store.close();
  });

  test("rows from another model width never mix into a search", async () => {
    const { store, index } = makeIndex(mockEmbedder());
    store.upsertMemoryEmbedding({
      kind: "article",
      scope: "repo",
      sourceId: "wrong-width",
      model: "all-MiniLM-L6-v2",
      vector: Float32Array.from([1, 0]),
    });
    await index.upsertArticle("repo", "right-width", "right text");
    const hits = await index.searchArticles("q", 10);
    expect(hits!.map((hit) => hit.id)).toEqual(["right-width"]);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// The hybrid recall bundle (memory-triggers.buildMemoryRecallBundle). Real
// wiki articles on disk + a real FTS index; the semantic leg is a stub.
// ---------------------------------------------------------------------------

const writeInput = (title: string, body: string, kind = "article") => ({
  scope: "repo" as const,
  topic: "testing",
  title,
  body,
  source: "agent" as const,
  evidence: "memory-embeddings.test.ts",
  status: "unverified" as const,
  kind: kind as "article" | "pitfall",
  tags: [],
  supersedes: [],
});

async function makeWiki(articles: Array<{ title: string; body: string; kind?: string }>): Promise<{
  repo: string;
  index: MemoryIndex;
}> {
  const home = await makeTempDir("hive-hm5-home-");
  Bun.env.HIVE_HOME = home;
  const repo = await makeTempDir("hive-hm5-repo-");
  const index = new MemoryIndex(new Database(":memory:"));
  for (const article of articles) {
    const written = await writeMemoryFact(
      repo,
      writeInput(article.title, article.body, article.kind ?? "article"),
    );
    index.upsertFact(written);
  }
  return { repo, index };
}

describe("buildMemoryRecallBundle, hybrid (HM-5)", () => {
  const articles = [
    {
      title: "Lease renewal blocks overlapping agents",
      body: "The composer lease must be renewed every fifteen seconds or the workspace hides the agent.",
    },
    {
      title: "Token budgets clamp recall bundles",
      body: "The recall bundle clamps pitfalls first when the token budget is exceeded.",
    },
    {
      title: "Unrelated pitfall about ports",
      body: "A stale daemon.lock from a crashed process blocks the port; remove it before restarting.",
      kind: "pitfall",
    },
  ];

  test("semantic unavailable (null) is BYTE-IDENTICAL to no semantic leg", async () => {
    const { repo, index } = await makeWiki(articles);
    const query = "lease renewal overlapping";
    const without = await buildMemoryRecallBundle(query, {
      memory: index,
      repoRoot: () => repo,
    });
    const unavailable = await buildMemoryRecallBundle(query, {
      memory: index,
      repoRoot: () => repo,
      semantic: () => Promise.resolve(null),
    });
    expect(JSON.stringify(unavailable)).toBe(JSON.stringify(without));
    expect(without.state).toBe("ok");
  });

  test("a semantic hit FTS misses ranks in the bundle, hydrated from disk", async () => {
    const { repo, index } = await makeWiki(articles);
    // The query matches only the token-budget article via FTS; the semantic
    // leg surfaces the lease article (a paraphrase hit) and the pitfall.
    const bundle = await buildMemoryRecallBundle("token budget clamping", {
      memory: index,
      repoRoot: () => repo,
      semantic: () =>
        Promise.resolve([
          { scope: "repo", id: "lease-renewal-blocks-overlapping-agents", score: 0.9 },
          { scope: "repo", id: "unrelated-pitfall-about-ports", score: 0.5 },
        ]),
    });
    expect(bundle.state).toBe("ok");
    const all = [...bundle.pitfalls, ...bundle.articles];
    const lease = all.find((row) =>
      row.id === "lease-renewal-blocks-overlapping-agents"
    );
    expect(lease).toBeDefined();
    expect(lease!.title).toBe("Lease renewal blocks overlapping agents");
    expect(lease!.snippet.length).toBeGreaterThan(0);
    // The pitfall semantic hit lands in the pitfall partition.
    expect(bundle.pitfalls.map((row) => row.id))
      .toContain("unrelated-pitfall-about-ports");
  });

  test("RRF blend: a hit on both legs outranks a hit on one", async () => {
    const { repo, index } = await makeWiki(articles);
    // FTS ranks token-budgets #1; the semantic leg ranks lease #1 and
    // token-budgets #2. Token-budgets (both legs) must outrank lease
    // (semantic only): 1/61 + 1/62 > 1/61.
    const bundle = await buildMemoryRecallBundle("token budgets clamp", {
      memory: index,
      repoRoot: () => repo,
      semantic: () =>
        Promise.resolve([
          { scope: "repo", id: "lease-renewal-blocks-overlapping-agents", score: 0.9 },
          { scope: "repo", id: "token-budgets-clamp-recall-bundles", score: 0.8 },
        ]),
    });
    expect(bundle.articles.map((row) => row.id)).toEqual([
      "token-budgets-clamp-recall-bundles",
      "lease-renewal-blocks-overlapping-agents",
    ]);
  });

  test("both legs empty is the honest empty state", async () => {
    const { repo, index } = await makeWiki(articles);
    const bundle = await buildMemoryRecallBundle("zzz qqq nonexistent", {
      memory: index,
      repoRoot: () => repo,
      semantic: () => Promise.resolve([]),
    });
    expect(bundle.state).toBe("empty");
  });

  test("a semantic hit whose article vanished from disk drops out", async () => {
    const { repo, index } = await makeWiki(articles);
    const bundle = await buildMemoryRecallBundle("token budgets clamp", {
      memory: index,
      repoRoot: () => repo,
      semantic: () =>
        Promise.resolve([
          { scope: "repo", id: "ghost-article", score: 0.99 },
        ]),
    });
    const all = [...bundle.pitfalls, ...bundle.articles];
    expect(all.find((row) => row.id === "ghost-article")).toBeUndefined();
    expect(bundle.state).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Daemon wiring: writes/deletes maintain the vector index (mocked embedder
// through the memoryEmbeddingLoad seam — no model download).
// ---------------------------------------------------------------------------

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by embedding tests");
  }
}

class NoopTmux {
  async hasSession(_session: string): Promise<boolean> {
    return false;
  }
  async capturePane(_session: string): Promise<string> {
    return "";
  }
  async killSession(_session: string): Promise<void> {}
  async newSession(
    _name: string,
    _cwd: string,
    _command: string,
  ): Promise<void> {}
}

describe("HiveDaemon embedding index maintenance (HM-5)", () => {
  async function makeDaemon(): Promise<{
    daemon: HiveDaemon;
    episodic: EpisodicStore;
    repoRoot: string;
  }> {
    const home = await makeTempDir("hive-hm5-home-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm5-repo-");
    const episodic = new EpisodicStore(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      tmux: new NoopTmux(),
      repoRoot,
      episodicStore: episodic,
      memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
      memoryEmbeddingLoad: () => Promise.resolve(mockEmbedder()),
    });
    return { daemon, episodic, repoRoot };
  }

  test("writeMemoryFact embeds the article; deleteMemoryFact removes it", async () => {
    const { daemon, episodic } = await makeDaemon();
    const written = await daemon.writeMemoryFact(
      writeInput("Embeddings maintain the vector index", "Body text."),
    );
    const rows = episodic.memoryEmbeddings({ kind: "article" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "repo",
      sourceId: written.id,
      model: "bge-small-en-v1.5",
    });
    await daemon.deleteMemoryFact("repo", written.id);
    expect(episodic.memoryEmbeddings({ kind: "article" })).toHaveLength(0);
  });

  test("superseded articles drop out of the vector index on rewrite", async () => {
    const { daemon, episodic } = await makeDaemon();
    const first = await daemon.writeMemoryFact(
      writeInput("Vector index supersede check", "Old body."),
    );
    await daemon.writeMemoryFact({
      ...writeInput("Vector index supersede check", "New body."),
      id: first.id,
      supersedes: [first.id],
    });
    // Same id re-embedded once — exactly one row, newest write wins.
    const rows = episodic.memoryEmbeddings({ kind: "article" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceId).toBe(first.id);
  });

  test("rebuildMemoryIndex prunes vector rows whose source disappeared", async () => {
    const { daemon, episodic } = await makeDaemon();
    const written = await daemon.writeMemoryFact(
      writeInput("Prune boundary check", "Body."),
    );
    // A stale row no source owns (simulating an article removed out of band)
    // plus an invalidated fact's row: the rebuild prune drops both.
    episodic.upsertMemoryEmbedding({
      kind: "article",
      scope: "repo",
      sourceId: "stale-row",
      model: "bge-small-en-v1.5",
      vector: Float32Array.from([1, 0, 0, 0]),
    });
    const fact = episodic.recordFact({
      topic: "testing",
      title: "A fact soon invalidated",
      body: "body",
      source: "test",
    });
    episodic.upsertMemoryEmbedding({
      kind: "fact",
      scope: "",
      sourceId: fact.id,
      model: "bge-small-en-v1.5",
      vector: Float32Array.from([1, 0, 0, 0]),
    });
    episodic.invalidateFact(fact.id);
    await daemon.rebuildMemoryIndex();
    const rows = episodic.memoryEmbeddings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceId).toBe(written.id);
  });
});
