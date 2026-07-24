import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../../src/schemas";
import { getDatabasePath, HiveDatabase } from "../../src/daemon/db";
import { HiveDaemon } from "../../src/daemon/server";
import { actingAs } from "../../src/daemon/testing";
import type { SpawnRequest, Spawner } from "../../src/daemon/spawner";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-memory-mcp-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  return home;
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by memory tests");
  }
}

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as unknown;
}

async function connectedClient(daemon: HiveDaemon): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(daemon, "operator", "operator") },
  );
  const client = new Client({ name: "hive-memory-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function validWrite(overrides: Record<string, unknown> = {}) {
  return {
    scope: "repo",
    topic: "testing",
    title: "Test article",
    body: "Test body.",
    source: "agent",
    evidence: "Measured by the MCP integration test",
    status: "verified",
    supersedes: [],
    date: "2026-07-12",
    verified: "2026-07-12",
    ...overrides,
  };
}

async function discoverMemoryFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, ".hive", "memory"), {
    recursive: true,
  }).catch(() => [])).filter((path) => path.endsWith(".md"));
}

describe("memory MCP tools", () => {
  test("memory_write rejects writes missing load-bearing wiki fields", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      const missing = await client.callTool({
        name: "memory_write",
        arguments: { scope: "repo", title: "Flat fact", body: "Old shape." },
      });
      expect(missing.isError).toBe(true);
      expect(await discoverMemoryFiles(repoRoot)).toEqual([]);

      const unannotatedConflict = await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          status: "conflicted",
          verified: undefined,
          body: "Two claims exist.",
        }),
      });
      expect(unannotatedConflict.isError).toBe(true);
      expect(await discoverMemoryFiles(repoRoot)).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("create, search, update, and delete a fact through the daemon's real MCP interface", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      const written = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          scope: "repo",
          title: "The login test is flaky",
          body: "Race condition in session setup.",
          tags: ["testing"],
        }),
      })) as { id: string; scope: string; path: string };
      expect(written.id).toEqual("the-login-test-is-flaky");
      expect(written.scope).toEqual("repo");
      expect(await readFile(written.path, "utf8")).toContain(
        "Race condition in session setup.",
      );

      const found = textValue(await client.callTool({
        name: "memory_search",
        arguments: { query: "flaky" },
      })) as Array<{ id: string; scope: string }>;
      expect(found.map((result) => result.id)).toEqual([written.id]);

      const read = textValue(await client.callTool({
        name: "memory_read",
        arguments: { scope: "repo", id: written.id },
      })) as { body: string };
      expect(read.body).toEqual("Race condition in session setup.");

      // Update in place: same scope+id, new body.
      await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          scope: "repo",
          id: written.id,
          title: "The login test is flaky",
          body: "Root cause: an unawaited promise in session setup.",
          supersedes: [written.id],
        }),
      });
      const afterUpdate = textValue(await client.callTool({
        name: "memory_search",
        arguments: { query: "unawaited" },
      })) as Array<{ id: string }>;
      expect(afterUpdate.map((result) => result.id)).toEqual([written.id]);
      const staleSearch = textValue(await client.callTool({
        name: "memory_search",
        arguments: { query: "Race condition" },
      })) as Array<{ id: string }>;
      expect(staleSearch).toEqual([]);

      await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          id: "duplicate-login-note",
          title: "Duplicate login note",
          body: "Redundant login account.",
        }),
      });
      await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          id: written.id,
          title: "The login test is flaky",
          body: "Canonical account after duplicate merge.",
          supersedes: [written.id, "duplicate-login-note"],
        }),
      });
      expect(textValue(await client.callTool({
        name: "memory_search",
        arguments: { query: "redundant" },
      }))).toEqual([]);
      expect((await client.callTool({
        name: "memory_read",
        arguments: { scope: "repo", id: "duplicate-login-note" },
      })).isError).toBe(true);

      const deletion = textValue(await client.callTool({
        name: "memory_delete",
        arguments: { scope: "repo", id: written.id },
      })) as { deleted: boolean };
      expect(deletion.deleted).toEqual(true);

      const afterDelete = textValue(await client.callTool({
        name: "memory_search",
        arguments: { query: "unawaited" },
      })) as Array<{ id: string }>;
      expect(afterDelete).toEqual([]);

      const missingRead = await client.callTool({
        name: "memory_read",
        arguments: { scope: "repo", id: written.id },
      });
      expect(missingRead.isError).toEqual(true);

      const secondDelete = textValue(await client.callTool({
        name: "memory_delete",
        arguments: { scope: "repo", id: written.id },
      })) as { deleted: boolean };
      expect(secondDelete.deleted).toEqual(false);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("memory_write echoes id/scope/title/path/verified, not the body just written", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      const longBody = "Root cause: an unawaited promise in session setup. "
        .repeat(20);
      const written = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          scope: "repo",
          title: "The login test is flaky",
          body: longBody,
          source: "agent",
          date: "2026-07-10",
          verified: "2026-07-10",
        }),
      })) as Record<string, unknown>;
      expect(written).toEqual({
        id: "the-login-test-is-flaky",
        scope: "repo",
        topic: "testing",
        title: "The login test is flaky",
        path: expect.any(String),
        rawPath: expect.any(String),
        source: "agent",
        status: "verified",
        verified: "2026-07-10",
        // Defect D2: the vector projection's outcome — this daemon has no
        // semantic leg wired, so the write is keyword-searchable only.
        embedding: "unavailable:disabled",
      });
      expect(written.body).toBeUndefined();

      // The full body the caller just wrote is still reachable through
      // memory_read (and the Markdown file at `path`), just not echoed back.
      const read = textValue(await client.callTool({
        name: "memory_read",
        arguments: { scope: "repo", id: "the-login-test-is-flaky" },
      })) as { body: string };
      expect(read.body.trim()).toEqual(longBody.trim());
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("path-shaped memory ids are rejected at the daemon boundary", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      // The adapter interpolates the id into `join(root, `${id}.md`)`, so an
      // id carrying path components must never get past the tool schema:
      // memory_read/memory_delete would escape the memory root, and
      // memory_write would create files anywhere the daemon can write.
      const hostile = [
        "../../../outside",
        "..",
        "nested/child",
        ".hidden",
        "/absolute",
      ];
      for (const id of hostile) {
        const read = await client.callTool({
          name: "memory_read",
          arguments: { scope: "repo", id },
        });
        expect(read.isError).toEqual(true);
        const deletion = await client.callTool({
          name: "memory_delete",
          arguments: { scope: "repo", id },
        });
        expect(deletion.isError).toEqual(true);
        const write = await client.callTool({
          name: "memory_write",
          arguments: validWrite({ id, title: "t", body: "b" }),
        });
        expect(write.isError).toEqual(true);
      }
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("source and verified provenance flow through memory_write and back on memory_read", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      const written = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          scope: "repo",
          id: "seeded-fact",
          title: "Seeded by init",
          body: "A derived, re-derivable lesson.",
          source: "init",
          date: "2026-06-01",
          verified: "2026-06-01",
        }),
      })) as { source: string; verified: string; path: string };
      expect(written.source).toEqual("init");
      expect(written.verified).toEqual("2026-06-01");
      // The provenance is persisted to the Markdown file, not just the response.
      const onDisk = await readFile(written.path, "utf8");
      expect(onDisk).toContain("source: init");
      expect(onDisk).toContain("verified: 2026-06-01");

      const read = textValue(await client.callTool({
        name: "memory_read",
        arguments: { scope: "repo", id: "seeded-fact" },
      })) as { source: string; verified: string };
      expect(read.source).toEqual("init");
      expect(read.verified).toEqual("2026-06-01");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("pitfall articles persist kind in frontmatter and the scope index", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      const written = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          id: "flaky-login-pitfall",
          kind: "pitfall",
          title: "A green login test run proves nothing",
          body: "The test passes even while the session setup race is live.",
        }),
      })) as { id: string; path: string };
      expect(await readFile(written.path, "utf8")).toContain("kind: pitfall");

      const read = textValue(await client.callTool({
        name: "memory_read",
        arguments: { scope: "repo", id: written.id },
      })) as { kind: string };
      expect(read.kind).toEqual("pitfall");

      const index = await readFile(
        join(repoRoot, ".hive", "memory", "wiki", "index.md"),
        "utf8",
      );
      expect(index).toContain(
        "- [repo/testing] flaky-login-pitfall (2026-07-12) [verified] [pitfall]: " +
          "A green login test run proves nothing",
      );

      // A plain write stays an article: no kind line on disk, article on read.
      const plain = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({ id: "plain-article", title: "A plain article" }),
      })) as { path: string };
      expect(await readFile(plain.path, "utf8")).not.toContain("kind:");
      const plainRead = textValue(await client.callTool({
        name: "memory_read",
        arguments: { scope: "repo", id: "plain-article" },
      })) as { kind: string };
      expect(plainRead.kind).toEqual("article");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("memory_write returns advisory FTS similar-candidates for near-duplicates", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      // The first write has nothing to collide with: no candidates key.
      const first = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          id: "quota-token-spend-limits",
          title: "Quota token spend limits",
          body: "Provider caps reset at midnight UTC.",
        }),
      })) as Record<string, unknown>;
      expect(first.similarCandidates).toBeUndefined();

      // A near-duplicate: different normalized title (layer 1 lets it
      // through), overlapping terms — the write succeeds and the lookalike
      // comes back as an advisory candidate.
      const second = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          title: "Quota token spend",
          body: "How much each provider lets us burn.",
        }),
      })) as {
        id: string;
        similarCandidates?: Array<{ scope: string; id: string; title: string }>;
      };
      expect(second.id).toBe("quota-token-spend");
      expect(second.similarCandidates).toContainEqual({
        scope: "repo",
        id: "quota-token-spend-limits",
        title: "Quota token spend limits",
      });
      // The article itself is never its own candidate.
      expect(second.similarCandidates!.map((candidate) => candidate.id))
        .not.toContain("quota-token-spend");

      // A write with no lookalikes carries no candidates.
      const clean = textValue(await client.callTool({
        name: "memory_write",
        arguments: validWrite({
          title: "Zebra delivery protocol",
          body: "Entirely unrelated to quotas.",
        }),
      })) as Record<string, unknown>;
      expect(clean.similarCandidates).toBeUndefined();
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("memory_reindex rebuilds the search index from files edited outside the daemon", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      // Write a Markdown fact directly to disk, bypassing memory_write
      // entirely — this is what a committed .hive/memory/ file looks like
      // after a `git pull`.
      const memoryDir = join(repoRoot, ".hive", "memory");
      await mkdir(memoryDir, { recursive: true });
      await writeFile(
        join(memoryDir, "externally-added.md"),
        "---\ntitle: Added outside the daemon\ndate: 2026-06-01\ntags: []\n---\n\nDiscovered by reindex, not by memory_write.\n",
      );

      const beforeReindex = textValue(await client.callTool({
        name: "memory_search",
        arguments: { query: "discovered" },
      })) as unknown[];
      expect(beforeReindex).toEqual([]);

      const reindexed = textValue(await client.callTool({
        name: "memory_reindex",
        arguments: {},
      })) as {
        count: number;
        migration: {
          scanned: number;
          migrated: number;
          backups: Array<{ scope: string; path: string }>;
          alreadyMigrated: string[];
        };
      };
      expect(reindexed.count).toEqual(1);
      expect(reindexed.migration.scanned).toBe(1);
      expect(reindexed.migration.migrated).toBe(1);
      expect(reindexed.migration.backups).toEqual([
        { scope: "repo", path: expect.stringContaining("memory-backups/legacy-v1-") },
      ]);
      expect(await readFile(join(memoryDir, "externally-added.md"), "utf8"))
        .toContain("Discovered by reindex");

      const again = textValue(await client.callTool({
        name: "memory_reindex",
        arguments: {},
      })) as typeof reindexed;
      expect(again.count).toBe(1);
      expect(again.migration).toMatchObject({
        scanned: 1,
        migrated: 0,
        backups: [],
        alreadyMigrated: ["repo"],
      });

      const afterReindex = textValue(await client.callTool({
        name: "memory_search",
        arguments: { query: "discovered" },
      })) as Array<{ id: string }>;
      expect(afterReindex.map((result) => result.id)).toEqual([
        "externally-added",
      ]);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("restarting the daemon rebuilds the FTS index from Markdown files that outlive the process", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);

    // No explicit db path: the daemon owns and closes the default
    // ~/.hive/hive.db (here, under the temp HIVE_HOME), matching what a
    // real process restart looks like.
    const daemonA = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      repoRoot,
    });
    const clientA = await connectedClient(daemonA);
    let dbPath: string;
    try {
      dbPath = daemonA.db.path;
      const written = textValue(await clientA.callTool({
        name: "memory_write",
        arguments: validWrite({
          scope: "global",
          id: "survives-restart",
          title: "Durable across a daemon restart",
          body: "The Markdown file is what persists, not the SQLite index.",
        }),
      })) as { id: string };
      expect(written.id).toEqual("survives-restart");

      const foundBeforeStop = textValue(await clientA.callTool({
        name: "memory_search",
        arguments: { query: "persists" },
      })) as unknown[];
      expect(foundBeforeStop.length).toEqual(1);
    } finally {
      await clientA.close().catch(() => undefined);
      await daemonA.stop();
    }

    // Simulate a stale/blown-away index: the daemon file persisted, but the
    // FTS table itself is gone. Only the Markdown file on disk is real.
    const rawDb = new Database(dbPath);
    rawDb.exec("DROP TABLE IF EXISTS memory_fts");
    rawDb.close();

    const daemonB = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      repoRoot,
    });
    expect(daemonB.db.path).toEqual(dbPath);
    try {
      const foundBeforeRebuild = daemonB.memory.search("persists");
      expect(foundBeforeRebuild).toEqual([]);

      const rebuilt = await daemonB.rebuildMemoryIndex();
      expect(rebuilt.count).toEqual(1);

      const clientB = await connectedClient(daemonB);
      try {
        const foundAfterRebuild = textValue(await clientB.callTool({
          name: "memory_search",
          arguments: { query: "persists" },
        })) as unknown[];
        expect(foundAfterRebuild).toEqual([
          {
            id: "survives-restart",
            scope: "global",
            topic: "testing",
            title: "Durable across a daemon restart",
            date: expect.any(String),
            status: "verified",
            tags: [],
            path: expect.any(String),
            snippet: expect.any(String),
          },
        ]);
      } finally {
        await clientB.close().catch(() => undefined);
      }
    } finally {
      await daemonB.stop();
    }
  });
});
