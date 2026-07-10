import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { getDatabasePath, HiveDatabase } from "./db";
import { HiveDaemon } from "./server";
import { actingAs } from "./testing";
import type { SpawnRequest, Spawner } from "./spawner";

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

describe("memory MCP tools", () => {
  test("create, search, update, and delete a fact through the daemon's real MCP interface", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      tmux: new NoopTmux(),
      repoRoot,
    });
    const client = await connectedClient(daemon);
    try {
      const written = textValue(await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          title: "The login test is flaky",
          body: "Race condition in session setup.",
          tags: ["testing"],
        },
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
        arguments: {
          scope: "repo",
          id: written.id,
          title: "The login test is flaky",
          body: "Root cause: an unawaited promise in session setup.",
        },
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

  test("memory_reindex rebuilds the search index from files edited outside the daemon", async () => {
    await makeHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-memory-mcp-repo-"));
    tempRoots.push(repoRoot);
    const daemon = new HiveDaemon({
      spawner: new UnusedSpawner(),
      db: new HiveDatabase(":memory:"),
      tmux: new NoopTmux(),
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
      })) as { count: number };
      expect(reindexed.count).toEqual(1);

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
      spawner: new UnusedSpawner(),
      tmux: new NoopTmux(),
      repoRoot,
    });
    const clientA = await connectedClient(daemonA);
    let dbPath: string;
    try {
      dbPath = daemonA.db.path;
      const written = textValue(await clientA.callTool({
        name: "memory_write",
        arguments: {
          scope: "global",
          id: "survives-restart",
          title: "Durable across a daemon restart",
          body: "The Markdown file is what persists, not the SQLite index.",
        },
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
      spawner: new UnusedSpawner(),
      tmux: new NoopTmux(),
      repoRoot,
    });
    expect(daemonB.db.path).toEqual(dbPath);
    try {
      const foundBeforeRebuild = daemonB.memory.search("persists");
      expect(foundBeforeRebuild).toEqual([]);

      const count = await daemonB.rebuildMemoryIndex();
      expect(count).toEqual(1);

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
            title: "Durable across a daemon restart",
            date: expect.any(String),
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
