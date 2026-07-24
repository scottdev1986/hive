// HiveMemory HM-2 WP5 (board #72): the mistake-harvest pipeline. Unit-level
// coverage of harvestPitfalls (clustering, dedup contract, advisory links,
// clean sessions) plus MCP-level coverage of the memory_pitfall tool and the
// cross-agent shared-knowledge loop: agent A's harvested pitfall, once
// verified, surfaces for agent B via pitfall-check and ranks first in the
// spawn-injected memory index.
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryIndex,
  discoverMemoryFacts,
  writeMemoryFact,
} from "../../src/adapters/memory";
import type { AgentRecord } from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import { compileDigest } from "../../src/daemon/episodic-digest";
import { EpisodicStore } from "../../src/daemon/episodic-store";
import { MemoryIndex } from "../../src/daemon/memory-index";
import { harvestPitfalls } from "../../src/daemon/pitfall-harvest";
import { HiveDaemon } from "../../src/daemon/server";
import type { SpawnRequest, Spawner } from "../../src/daemon/spawner";
import { actingAs, type AuthorizedFetch } from "../../src/daemon/testing";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T10:05:00.000Z";
const T2 = "2026-07-22T11:00:00.000Z";
const TODAY = "2026-07-22";

const tempRoots: string[] = [];
const daemons: HiveDaemon[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  for (const daemon of daemons.splice(0)) {
    await daemon.stop().catch(() => undefined);
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-pitfall-harvest-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  return home;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-pitfall-harvest-repo-"));
  tempRoots.push(root);
  return root;
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by pitfall harvest tests");
  }
}

const agent = (name: string): AgentRecord => ({
  id: `agent-${name}`,
  name,
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "working",
  taskDescription: "pitfall harvest fixture",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  contextPct: null,
  createdAt: T0,
  lastEventAt: T0,
  recoveryAttempts: 0,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

// --- Unit level: harvestPitfalls over a real store + real wiki files --------

describe("harvestPitfalls", () => {
  test("two distinct failures plus a repeat harvest two candidates", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "Implementing the harvest pipeline",
    });
    const first = store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.tool-failed",
      summary:
        "TypeError: cannot read properties of undefined reading config in src/config/loader.ts",
    });
    const repeat = store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.tool-failed",
      summary:
        "TypeError: cannot read properties of undefined reading config in src/config/loader.ts",
    });
    const second = store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.command-failed",
      summary: "bun test exited with code 1",
    });
    const digest = compileDigest(store, {
      agent: "agent-ada",
      sessionId: "session-1",
      compiledAt: T2,
    })!;

    const report = await harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
    });

    // The repeat clusters into the first failure: two candidates, no errors.
    expect(report.errors).toEqual([]);
    expect(report.candidates).toHaveLength(2);
    const typeError = report.candidates.find((candidate) =>
      candidate.title.includes("TypeError")
    )!;
    expect(typeError.action).toBe("created");
    expect(typeError.eventIds).toEqual([first.id, repeat.id]);
    const exitCode = report.candidates.find((candidate) =>
      candidate.title.includes("exit code 1")
    )!;
    expect(exitCode.eventIds).toEqual([second.id]);

    // Both candidates are unverified, provenance-bearing pitfall articles in
    // the REPO wiki — and nothing landed in global scope.
    const articles = await discoverMemoryFacts(repoRoot, "repo");
    expect(articles).toHaveLength(2);
    expect(await discoverMemoryFacts(repoRoot, "global")).toHaveLength(0);
    for (const article of articles) {
      expect(article.kind).toBe("pitfall");
      expect(article.status).toBe("unverified");
      expect(article.source).toBe("orchestrator");
      expect(article.title.startsWith("Pitfall: ")).toBe(true);
      expect(article.body).toContain("## Provenance");
      expect(article.body).toContain(`Digest: #${digest.id}`);
      expect(article.body).toContain("Session: session-1");
      expect(article.body).toContain("UNVERIFIED");
    }
    const typeErrorArticle = articles.find((article) =>
      article.title.includes("TypeError")
    )!;
    expect(typeErrorArticle.body).toContain(`[e${first.id}]`);
    expect(typeErrorArticle.body).toContain(`[e${repeat.id}]`);
    // The exact-values side table rides along.
    expect(typeErrorArticle.body).toContain("src/config/loader.ts");
    const exitArticle = articles.find((article) =>
      article.title.includes("exit code 1")
    )!;
    expect(exitArticle.body).toContain("| exit-code | `1` |");
    store.close();
  });

  test("re-harvest of the same failure signature updates the existing article", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.tool-failed",
      summary: "TimeoutError: quota request timed out after 30s",
    });
    compileDigest(store, {
      agent: "agent-ada",
      sessionId: "session-1",
      compiledAt: T1,
    });
    const firstHarvest = await harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(firstHarvest.errors).toEqual([]);
    expect(firstHarvest.candidates).toHaveLength(1);
    expect(firstHarvest.candidates[0]!.action).toBe("created");
    const articleId = firstHarvest.candidates[0]!.id;

    // A later session burns itself on the same signature.
    const later = store.appendEvent({
      ts: T2,
      agent: "agent-ada",
      type: "agent.tool-failed",
      summary: "TimeoutError: quota request timed out after 30s",
    });
    compileDigest(store, {
      agent: "agent-ada",
      sessionId: "session-2",
      compiledAt: T2,
    });
    const secondHarvest = await harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-2",
    });

    // An UPDATE of the existing id (supersedes), not a duplicate, not an error.
    expect(secondHarvest.errors).toEqual([]);
    expect(secondHarvest.candidates).toHaveLength(1);
    expect(secondHarvest.candidates[0]!.action).toBe("updated");
    expect(secondHarvest.candidates[0]!.id).toBe(articleId);
    const articles = await discoverMemoryFacts(repoRoot, "repo");
    expect(articles).toHaveLength(1);
    expect(articles[0]!.id).toBe(articleId);
    // The refreshed body carries the later session's provenance.
    expect(articles[0]!.body).toContain(`[e${later.id}]`);
    expect(articles[0]!.body).toContain("Session: session-2");
    expect(articles[0]!.status).toBe("unverified");
    store.close();
  });

  test("a similar-but-distinct failure appends 'Possibly related:', never merges", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const seeded = await writeMemoryFact(repoRoot, {
      scope: "repo",
      topic: "pitfalls",
      title: "Pitfall: git rebase drops commits when retried",
      body: "A rebase retried mid-conflict silently drops commits.",
      source: "agent",
      evidence: "Incident replay in the harvest test",
      status: "verified",
      verified: TODAY,
      date: TODAY,
      kind: "pitfall",
      supersedes: [],
    });
    const index = new MemoryIndex(new Database(":memory:"));
    index.upsertFact(seeded);

    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.command-failed",
      summary: "Rebase failed: merge conflict while picking commits",
    });
    const report = await harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      search: (query) => index.search(query, { limit: 5 }),
    });

    expect(report.errors).toEqual([]);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.action).toBe("created");
    expect(report.candidates[0]!.related).toEqual([
      { scope: "repo", id: seeded.id, title: seeded.title },
    ]);
    // Appended and linked — the seeded article is untouched, both exist.
    const articles = await discoverMemoryFacts(repoRoot, "repo");
    expect(articles).toHaveLength(2);
    const candidate = articles.find((article) => article.id !== seeded.id)!;
    expect(candidate.body).toContain(
      `Possibly related: [repo] ${seeded.id} — ${seeded.title}`,
    );
    const untouched = articles.find((article) => article.id === seeded.id)!;
    expect(untouched.body).toBe("A rebase retried mid-conflict silently drops commits.");
    store.close();
  });

  test("a clean session harvests zero candidates and no errors", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "Everything worked first try",
    });
    store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.branch-landed",
      summary: "Landed cleanly",
    });
    const report = await harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(report.errors).toEqual([]);
    expect(report.candidates).toEqual([]);
    expect(await discoverMemoryFacts(repoRoot, "repo")).toHaveLength(0);
    store.close();
  });
});

// --- MCP level: memory_pitfall + the cross-agent shared-knowledge loop ------

interface PitfallSearchEnvelope {
  state: "ok" | "empty";
  pitfalls: Array<{
    scope: string;
    id: string;
    topic: string;
    title: string;
    status: string;
    date: string;
    snippet?: string;
  }>;
}

function parseToolJson<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as T;
}

async function connectedClient(fetch: AuthorizedFetch): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch },
  );
  const client = new Client({ name: "hive-pitfall-harvest-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function daemonFixture(options: {
  repoRoot: string;
  episodic: EpisodicStore;
  agents?: AgentRecord[];
}): { daemon: HiveDaemon; db: HiveDatabase } {
  const db = new HiveDatabase(":memory:");
  for (const record of options.agents ?? []) db.insertAgent(record);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db,
    repoRoot: options.repoRoot,
    episodicStore: options.episodic,
  });
  daemons.push(daemon);
  return { daemon, db };
}

describe("memory_pitfall MCP tool", () => {
  test("search and get return only pitfall-kind articles", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("ada")],
    });
    const client = await connectedClient(actingAs(daemon, "ada", "writer"));
    try {
      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "pitfalls",
          kind: "pitfall",
          title: "Pitfall: rebase retries drop commits",
          body: "Retrying a rebase mid-conflict drops commits.",
          source: "agent",
          evidence: "memory_pitfall fixture",
          status: "verified",
          verified: TODAY,
          date: TODAY,
          supersedes: [],
        },
      });
      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          title: "Rebase test coverage lives in scripts/",
          body: "The rebase retry path is covered by b23-acceptance-matrix.",
          source: "agent",
          evidence: "memory_pitfall fixture",
          status: "verified",
          verified: TODAY,
          date: TODAY,
          supersedes: [],
        },
      });

      // Query search: both articles match "rebase", only the pitfall returns.
      const searched = parseToolJson<PitfallSearchEnvelope>(
        await client.callTool({
          name: "memory_pitfall",
          arguments: { action: "search", query: "rebase" },
        }),
      );
      expect(searched.state).toBe("ok");
      expect(searched.pitfalls).toHaveLength(1);
      expect(searched.pitfalls[0]).toMatchObject({
        title: "Pitfall: rebase retries drop commits",
        status: "verified",
      });

      // List mode (no query): the article-kind write stays invisible too.
      const listed = parseToolJson<PitfallSearchEnvelope>(
        await client.callTool({
          name: "memory_pitfall",
          arguments: { action: "search" },
        }),
      );
      expect(listed.pitfalls).toHaveLength(1);

      // get returns the pitfall...
      const got = parseToolJson<{ id: string; kind: string }>(
        await client.callTool({
          name: "memory_pitfall",
          arguments: {
            action: "get",
            scope: "repo",
            id: searched.pitfalls[0]!.id,
          },
        }),
      );
      expect(got.kind).toBe("pitfall");

      // ...and refuses a non-pitfall id.
      const refused = await client.callTool({
        name: "memory_pitfall",
        arguments: {
          action: "get",
          scope: "repo",
          id: "rebase-test-coverage-lives-in-scripts",
        },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("agent A's harvested pitfall, once verified, surfaces for agent B", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("ada"), agent("beth")],
    });

    // Agent A's session burns itself and ends: the daemon-side harvest runs
    // through the same serialized write path the server wires in.
    episodic.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.tool-failed",
      summary: "RangeError: protolog sequence overflow in native/sessiond broker",
    });
    compileDigest(episodic, {
      agent: "agent-ada",
      sessionId: "session-a",
      compiledAt: T1,
    });
    const harvest = await harvestPitfalls({
      store: episodic,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-a",
      write: (input) => daemon.writeMemoryFact(input),
    });
    expect(harvest.errors).toEqual([]);
    expect(harvest.candidates).toHaveLength(1);
    const candidateId = harvest.candidates[0]!.id;

    const beth = await connectedClient(actingAs(daemon, "beth", "writer"));
    try {
      // Agent B can already see A's candidate — labeled unverified everywhere
      // it appears (hint-not-authority).
      const unverified = parseToolJson<PitfallSearchEnvelope>(
        await beth.callTool({
          name: "memory_pitfall",
          arguments: { action: "search", query: "protolog" },
        }),
      );
      expect(unverified.state).toBe("ok");
      expect(unverified.pitfalls).toHaveLength(1);
      expect(unverified.pitfalls[0]!.status).toBe("unverified");

      // The queen/human verification promotion: an ordinary memory_write
      // self-supersede on the same id.
      const promoted = parseToolJson<{ id: string; status: string }>(
        await beth.callTool({
          name: "memory_write",
          arguments: {
            scope: "repo",
            id: candidateId,
            topic: "pitfalls",
            kind: "pitfall",
            title: harvest.candidates[0]!.title,
            body:
              "VERIFIED against the cited events: the sessiond broker dies on protolog sequence overflow; restart the broker before reattaching.",
            source: "human",
            evidence: `Verified against ${harvest.candidates[0]!.title} provenance events`,
            status: "verified",
            verified: TODAY,
            date: TODAY,
            supersedes: [candidateId],
          },
        }),
      );
      expect(promoted).toMatchObject({ id: candidateId, status: "verified" });

      // Agent B's pitfall-check now returns A's verified lesson.
      const check = parseToolJson<{
        state: string;
        results: Array<{ id: string; status: string; title: string }>;
      }>(
        await beth.callTool({
          name: "memory_query",
          arguments: { class: "pitfall-check", query: "protolog" },
        }),
      );
      expect(check.state).toBe("ok");
      expect(check.results).toHaveLength(1);
      expect(check.results[0]).toMatchObject({
        id: candidateId,
        status: "verified",
      });
    } finally {
      await beth.close().catch(() => undefined);
    }

    // And the spawn-injected memory index ranks the pitfall class first.
    const injected = await buildMemoryIndex(repoRoot);
    const firstRow = injected.split("\n").find((line) => line.startsWith("- ["))!;
    expect(firstRow).toContain("[pitfall]");
    expect(firstRow).toContain(candidateId);
  });
});
