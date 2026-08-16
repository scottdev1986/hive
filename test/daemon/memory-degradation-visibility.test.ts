// Embedding degradation is LOUD at every surface a user or agent sees.
// These tests pin the recall envelope's semantic discriminator
// (hybrid / degraded:<state> / disabled) with its unclamplable warning line,
// the write responses' embedding outcome field, the CLI printer's quiet-
// unless-degraded line, and the memory.embeddings status section.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { memoryEmbeddingNotice } from "../../src/cli/control";
import type { Role } from "../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { recallMemory } from "../../src/cli/mcp";
import { actingAs } from "../support/daemon-test-support";
import type { MemoryEmbedder } from "../../src/memory-service/embeddings";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import {
  buildMemoryRecallBundle,
  executeMemoryTrigger,
  memoryRecallDegradedWarning,
} from "../../src/memory-service/recall";
import { writeMemoryFact } from "../../src/memory-service/memory-store";
import type { AgentRecord } from "../../src/schemas/agent";

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

const writeInput = (title: string, body: string, kind = "article") => ({
  scope: "repo" as const,
  topic: "testing",
  title,
  body,
  source: "agent" as const,
  evidence: "memory-degradation-visibility.test.ts",
  status: "unverified" as const,
  kind: kind as "article" | "pitfall",
  tags: [],
  supersedes: [],
});

async function makeWiki(
  articles: Array<{ title: string; body: string }>,
): Promise<{
  repo: string;
  index: MemoryIndex;
}> {
  const home = await makeTempDir("hive-d2-home-");
  Bun.env.HIVE_HOME = home;
  const repo = await makeTempDir("hive-d2-repo-");
  const index = new MemoryIndex(new Database(":memory:"));
  for (const article of articles) {
    const written = await writeMemoryFact(
      repo,
      writeInput(article.title, article.body),
    );
    index.upsertFact(written);
  }
  return { repo, index };
}

const WIKI = [
  {
    title: "Lease renewal blocks overlapping agents",
    body: "The composer lease must be renewed every fifteen seconds or the workspace hides the agent.",
  },
];

// ---------------------------------------------------------------------------
// The recall envelope discriminator (unit level).
// ---------------------------------------------------------------------------

describe("recall envelope semantic discriminator (defect D2)", () => {
  test("an unwired leg is disabled; an answering leg is hybrid", async () => {
    const { repo, index } = await makeWiki(WIKI);
    const disabled = await buildMemoryRecallBundle("lease renewal", {
      memory: index,
      repoRoot: () => repo,
    });
    expect(disabled.semantic).toBe("disabled");
    const hybrid = await buildMemoryRecallBundle("lease renewal", {
      memory: index,
      repoRoot: () => repo,
      semantic: () => Promise.resolve([]),
    });
    expect(hybrid.semantic).toBe("hybrid");
  });

  test("a null answer degrades with the named state label", async () => {
    const { repo, index } = await makeWiki(WIKI);
    for (const state of [
      "embedding-runtime-missing",
      "embedding-runtime-broken",
      "embedding-native-unloadable",
      "unavailable",
    ]) {
      const bundle = await buildMemoryRecallBundle("lease renewal", {
        memory: index,
        repoRoot: () => repo,
        semantic: () => Promise.resolve(null),
        semanticStatus: () => state,
      });
      expect(bundle.semantic).toBe(`degraded:${state}`);
      expect(bundle.state).toBe("ok");
    }
  });

  test("a null answer with the leg configured off is disabled, not degraded", async () => {
    const { repo, index } = await makeWiki(WIKI);
    const bundle = await buildMemoryRecallBundle("lease renewal", {
      memory: index,
      repoRoot: () => repo,
      semantic: () => Promise.resolve(null),
      semanticStatus: () => "disabled",
    });
    expect(bundle.semantic).toBe("disabled");
  });

  test("the trigger lane carries the loud warning line when degraded — even on an empty result", async () => {
    const { repo, index } = await makeWiki(WIKI);
    const deps = {
      repoRoot: () => repo,
      memory: index,
      semantic: () => Promise.resolve(null),
      semanticStatus: () => "embedding-runtime-missing",
      write: () => {
        throw new Error("not exercised");
      },
      episodic: null,
    };
    const context = {
      authority: "user" as const,
      from: "user",
      target: "some-agent",
    };
    const warning = memoryRecallDegradedWarning("embedding-runtime-missing");
    expect(warning).toBe(
      "⚠ semantic search unavailable (embedding-runtime-missing) — results are keyword-only",
    );
    const found = await executeMemoryTrigger(
      { kind: "recall", payload: "lease renewal" },
      context,
      deps,
    );
    expect(found.body).toContain(warning);
    const empty = await executeMemoryTrigger(
      { kind: "recall", payload: "zzz-no-such-token" },
      context,
      deps,
    );
    expect(empty.body).toContain(warning);
  });

  test("the trigger lane is quiet when hybrid", async () => {
    const { repo, index } = await makeWiki(WIKI);
    const found = await executeMemoryTrigger(
      { kind: "recall", payload: "lease renewal" },
      { authority: "user", from: "user", target: "some-agent" },
      {
        repoRoot: () => repo,
        memory: index,
        semantic: () =>
          Promise.resolve([
            {
              scope: "repo",
              id: "lease-renewal-blocks-overlapping-agents",
              score: 0.9,
            },
          ]),
        semanticStatus: () => "ready",
        write: () => {
          throw new Error("not exercised");
        },
        episodic: null,
      },
    );
    expect(found.body).not.toContain("semantic search unavailable");
  });
});

// ---------------------------------------------------------------------------
// MCP-level surfaces: write responses, the recall envelope + clamping, and
// the status section. Real daemon, real MCP client, mocked embedder factory.
// ---------------------------------------------------------------------------

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by D2 visibility tests");
  }
}

function mockEmbedder(): MemoryEmbedder {
  return {
    model: "bge-small-en-v1.5",
    dimensions: 4,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
    embedQuery: () => Promise.resolve([1, 0, 0, 0]),
  };
}

async function makeDaemon(
  options: { episodic?: EpisodicStore; failingLoad?: boolean } = {},
) {
  const home = await makeTempDir("hive-d2-home-");
  Bun.env.HIVE_HOME = home;
  const repoRoot = await makeTempDir("hive-d2-repo-");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
    ...(options.episodic === undefined
      ? {}
      : { episodicStore: options.episodic }),
    ...(options.episodic === undefined
      ? {}
      : {
          memoryEmbeddings: {
            provider: "local" as const,
            model: "bge-small-en-v1.5" as const,
          },
          memoryEmbeddingLoad: () =>
            options.failingLoad === true
              ? Promise.reject(
                  new Error("embedding-runtime-missing: no bundle in the test"),
                )
              : Promise.resolve(mockEmbedder()),
        }),
  });
  return { daemon, repoRoot };
}

// biome-ignore lint/suspicious/noExplicitAny: MCP JSON is intentionally decoded loosely in this test.
type ToolValue = any;

async function connectedClient(
  daemon: HiveDaemon,
  subject = "user",
  role: Role = "user",
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(daemon, subject, role) },
  );
  const client = new Client({ name: "hive-d2-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

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

async function seedArticle(client: Client, title: string): Promise<ToolValue> {
  return textValue(
    await client.callTool({
      name: "memory_write",
      arguments: {
        scope: "repo",
        topic: "testing",
        title,
        body: `${title} body.`,
        source: "agent",
        evidence: "memory-degradation-visibility.test.ts",
        status: "unverified",
        supersedes: [],
      },
    }),
  );
}

describe("write responses (defect D2)", () => {
  test("memory_write reports queued on the cold write, indexed once warm", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic });
    const client = await connectedClient(daemon);
    const cold = await seedArticle(client, "Cold write projection");
    expect(cold.embedding).toBe("queued");
    await required(daemon.embeddingIndex).settle();
    const warm = await seedArticle(client, "Warm write projection");
    expect(warm.embedding).toBe("indexed");
    expect(episodic.memoryEmbeddings({ kind: "article" })).toHaveLength(2);
    episodic.close();
  });

  test("memory_write reports unavailable:<state> when the leg is down", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic, failingLoad: true });
    const client = await connectedClient(daemon);
    // Trip the lazy load once so the failure is memoized.
    await seedArticle(client, "First write trips the load");
    await required(daemon.embeddingIndex).settle();
    const second = await seedArticle(client, "Second write sees the state");
    expect(second.embedding).toBe("unavailable:embedding-runtime-missing");
    expect(episodic.memoryEmbeddings({ kind: "article" })).toHaveLength(0);
    episodic.close();
  });

  test("memory_write on a daemon without the leg reports unavailable:disabled", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    const written = await seedArticle(client, "No semantic leg at all");
    expect(written.embedding).toBe("unavailable:disabled");
  });
});

describe("memory recall-preview envelope (defect D2)", () => {
  test("hybrid when the leg answers; no warning block", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic });
    const client = await connectedClient(daemon);
    await seedArticle(client, "Database fixtures layout");
    await required(daemon.embeddingIndex).settle();
    const value = await recallMemory(
      0,
      "database",
      undefined,
      actingAs(daemon, "user", "user"),
    );
    expect(value.semantic).toBe("hybrid");
    expect(value.warning).toBeNull();
    episodic.close();
  });

  test("degraded:<state> with the warning, surviving budget clamping", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic, failingLoad: true });
    const client = await connectedClient(daemon);
    await seedArticle(client, "Database fixtures layout");
    await required(daemon.embeddingIndex).settle();
    const value = await recallMemory(
      0,
      "database",
      { budget: 1 },
      actingAs(daemon, "user", "user"),
    );
    expect(value.semantic).toBe("degraded:embedding-runtime-missing");
    expect(value.warning).toBe(
      "⚠ semantic search unavailable (embedding-runtime-missing) — results are keyword-only",
    );
    expect(value.truncated).toBe(true);
    episodic.close();
  });

  test("disabled when the leg is not wired", async () => {
    const { daemon } = await makeDaemon();
    const client = await connectedClient(daemon);
    await seedArticle(client, "Database fixtures layout");
    const value = await recallMemory(
      0,
      "database",
      undefined,
      actingAs(daemon, "user", "user"),
    );
    expect(value.semantic).toBe("disabled");
    expect(value.warning).toBeNull();
  });
});

describe("hive_status memory.embeddings section (defect D2)", () => {
  test("a healthy leg shows provider, model, ready state, counts, runtime dir", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic });
    const client = await connectedClient(daemon);
    await seedArticle(client, "Status surface check");
    await required(daemon.embeddingIndex).settle();
    const result = await client.callTool({
      name: "hive_status",
      arguments: {},
    });
    const structured = (
      result as unknown as {
        structuredContent: { memory: { embeddings: ToolValue } };
      }
    ).structuredContent;
    const embeddings = structured.memory.embeddings;
    expect(embeddings.provider).toBe("local");
    expect(embeddings.model).toBe("bge-small-en-v1.5");
    expect(embeddings.state).toBe("ready");
    expect(embeddings.vectors).toEqual({ articles: 1, facts: 0, total: 1 });
    expect(typeof embeddings.runtimeDir).toBe("string");
    episodic.close();
  });

  test("a down leg shows the named state; an unwired daemon shows disabled", async () => {
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = await makeDaemon({ episodic, failingLoad: true });
    const client = await connectedClient(daemon);
    await seedArticle(client, "Trips the load");
    await required(daemon.embeddingIndex).settle();
    const down = (await client.callTool({
      name: "hive_status",
      arguments: {},
    })) as unknown as {
      structuredContent: { memory: { embeddings: ToolValue } };
    };
    expect(down.structuredContent.memory.embeddings.state).toBe(
      "embedding-runtime-missing",
    );
    expect(down.structuredContent.memory.embeddings.detail).toContain(
      "embedding-runtime-missing",
    );
    expect(down.structuredContent.memory.embeddings.vectors.total).toBe(0);
    episodic.close();

    const bare = await makeDaemon();
    const bareClient = await connectedClient(bare.daemon);
    const disabled = (await bareClient.callTool({
      name: "hive_status",
      arguments: {},
    })) as unknown as {
      structuredContent: { memory: { embeddings: ToolValue } };
    };
    expect(disabled.structuredContent.memory.embeddings.state).toBe("disabled");
  });
});

describe("CLI printer (defect D2)", () => {
  test("quiet on indexed/absent, one loud line otherwise", () => {
    expect(memoryEmbeddingNotice(undefined)).toBeNull();
    expect(memoryEmbeddingNotice("indexed")).toBeNull();
    expect(memoryEmbeddingNotice("queued")).toContain("queued");
    const unavailable = memoryEmbeddingNotice(
      "unavailable:embedding-runtime-missing",
    );
    expect(unavailable).toContain("⚠");
    expect(unavailable).toContain("embedding-runtime-missing");
    expect(unavailable).toContain("keyword-searchable only");
  });
});

import { required } from "../required";
