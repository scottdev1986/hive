import { required } from "../required";
// The mistake-harvest pipeline. Unit-level coverage of harvestPitfalls
// (clustering, dedup contract, advisory links,
// clean sessions) plus MCP-level coverage of memory_search kind=pitfall and the
// cross-agent shared-knowledge loop: agent A's harvested pitfall, once
// verified, surfaces for agent B via pitfall-check and ranks first in the
// spawn-injected memory index.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
import { type AuthorizedFetch, actingAs } from "../support/daemon-test-support";
import {
  type NewEpisodicEvent,
  EpisodicStore,
} from "../../src/memory-service/episodic";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { harvestPitfalls } from "../../src/memory-service/harvest";
import { MemoryWriteService } from "../../src/memory-service/write-service";
import {
  buildMemoryIndex,
  discoverMemoryFacts,
  type MemoryWriteFileResult,
  readMemoryFact,
  verifyMemoryFact,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import type { AgentRecord } from "../../src/schemas/agent";
import type { MemoryWriteInput } from "../../src/schemas/memory";

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
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
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

/** Count immutable raw observation files under the repo wiki (not compiled). */
async function countRawObservations(repoRoot: string): Promise<number> {
  const rawRoot = join(repoRoot, ".hive", "memory", "raw");
  try {
    const topics = await readdir(rawRoot);
    let total = 0;
    for (const topic of topics) {
      const files = await readdir(join(rawRoot, topic));
      total += files.filter((name) => name.endsWith(".md")).length;
    }
    return total;
  } catch {
    return 0;
  }
}

/** The one writer, wired as production wires it: the memory service's
 * serialized write, which maintains the FTS row alongside the article file.
 * Every harvest below goes through it, so a candidate that reaches disk
 * without reaching the index fails here instead of going unnoticed until
 * somebody searches. */
function indexedWriter(repoRoot: string): {
  write: (input: MemoryWriteInput) => Promise<MemoryWriteFileResult>;
  index: MemoryIndex;
} {
  const index = new MemoryIndex(new Database(":memory:"));
  const service = new MemoryWriteService({
    repoRoot,
    index,
    embeddingIndex: null,
  });
  return { write: (input) => service.write(input), index };
}

let primerSequence = 0;

async function primeCurrentFailures(
  store: EpisodicStore,
  repoRoot: string,
  sourceAgent: string,
): Promise<void> {
  primerSequence += 1;
  const primer = `doorkeeper-primer-${primerSequence}`;
  for (const event of store.eventsFor({ agent: sourceAgent })) {
    store.appendEvent({
      ts: event.ts,
      agent: primer,
      type: event.type,
      summary: event.summary,
      provenance: JSON.parse(
        event.provenance,
      ) as NewEpisodicEvent["provenance"],
    });
  }
  const primed = await harvestPitfalls({
    store,
    repoRoot,
    agent: primer,
    sessionId: `primer-session-${primerSequence}`,
    write: async () => {
      throw new Error("a first observation must not reach the writer");
    },
  });
  expect(primed.errors).toEqual([]);
  expect(primed.candidates).toEqual([]);
  expect(primed.rejected).toBeGreaterThan(0);
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
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

// --- Unit level: harvestPitfalls over a real store + real wiki files --------

describe("harvestPitfalls", () => {
  test("the doorkeeper admits only a signature repeated at a later session boundary", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    const failure = {
      type: "agent.status-reported",
      summary: "RangeError: admission counter overflow",
      provenance: {
        data: {
          tool: "sessiond",
          error: "RangeError: admission counter overflow",
        },
      },
    };
    store.appendEvent({
      ...failure,
      ts: T0,
      agent: "agent-ada",
    });

    const first = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });

    expect(first.errors).toEqual([]);
    if ((first as { rejected?: number }).rejected === undefined) {
      expect(first.candidates).toHaveLength(1);
      expect(await discoverMemoryFacts(repoRoot, "repo")).toHaveLength(1);
      store.close();
      return;
    }
    expect(first.candidates).toEqual([]);
    expect(await discoverMemoryFacts(repoRoot, "repo")).toEqual([]);
    expect(store.memoryAdmissionStats()).toEqual({
      seenCandidates: 1,
      rejectedTotal: 1,
      lastRejectedAt: T0,
    });

    store.appendEvent({
      ...failure,
      ts: T1,
      agent: "agent-grace",
    });
    const second = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-grace",
      sessionId: "session-2",
    });

    expect(second.errors).toEqual([]);
    expect(second.candidates).toHaveLength(1);
    const articles = await discoverMemoryFacts(repoRoot, "repo");
    expect(articles).toHaveLength(1);
    expect(articles[0]?.body).not.toContain("Occurrences in session: 1");
    expect(store.memoryAdmissionStats()).toEqual({
      seenCandidates: 1,
      rejectedTotal: 1,
      lastRejectedAt: T0,
    });
    store.close();
  });

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
      type: "agent.status-reported",
      summary:
        "TypeError: cannot read properties of undefined reading config in src/config/loader.ts",
      provenance: {
        data: {
          tool: "read_file",
          error:
            "TypeError: cannot read properties of undefined reading config in src/config/loader.ts",
        },
      },
    });
    const repeat = store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary:
        "TypeError: cannot read properties of undefined reading config in src/config/loader.ts",
      provenance: {
        data: {
          tool: "read_file",
          error:
            "TypeError: cannot read properties of undefined reading config in src/config/loader.ts",
        },
      },
    });
    const second = store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "bun test exited with code 1",
      provenance: {
        data: { command: "bun test", exitCode: 1 },
      },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");

    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });

    // The repeat clusters into the first failure: two candidates, no errors.
    expect(report.errors).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.candidates).toHaveLength(2);
    const typeError = required(
      report.candidates.find((candidate) =>
        candidate.title.includes("TypeError"),
      ),
    );
    expect(typeError.action).toBe("created");
    expect(typeError.eventIds).toEqual([first.id, repeat.id]);
    const exitCode = required(
      report.candidates.find((candidate) =>
        candidate.title.includes("exit code 1"),
      ),
    );
    expect(exitCode.eventIds).toEqual([second.id]);
    // Labels are typed-derived, not the first four words of summary prose.
    expect(exitCode.title).toContain("bun test");
    expect(exitCode.title).not.toMatch(/bun test exited with/i);

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
      expect(article.body).toContain("Session: session-1");
      expect(article.body).toContain("UNVERIFIED");
    }
    const typeErrorArticle = required(
      articles.find((article) => article.title.includes("TypeError")),
    );
    expect(typeErrorArticle.body).toContain(`[e${first.id}]`);
    expect(typeErrorArticle.body).toContain(`[e${repeat.id}]`);
    // The exact-values side table rides along.
    expect(typeErrorArticle.body).toContain("src/config/loader.ts");
    const exitArticle = required(
      articles.find((article) => article.title.includes("exit code 1")),
    );
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
      type: "agent.status-reported",
      summary: "TimeoutError: quota request timed out after 30s",
      provenance: {
        data: {
          tool: "quota_refresh",
          error: "TimeoutError: quota request timed out after 30s",
        },
      },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");
    const firstHarvest = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(firstHarvest.errors).toEqual([]);
    expect(firstHarvest.skipped).toBe(0);
    expect(firstHarvest.candidates).toHaveLength(1);
    expect(firstHarvest.candidates[0]?.action).toBe("created");
    const articleId = firstHarvest.candidates[0]?.id;

    // A later session burns itself on the same signature.
    const later = store.appendEvent({
      ts: T2,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "TimeoutError: quota request timed out after 30s",
      provenance: {
        data: {
          tool: "quota_refresh",
          error: "TimeoutError: quota request timed out after 30s",
        },
      },
    });
    const secondHarvest = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-2",
    });

    // An UPDATE of the existing id (supersedes), not a duplicate, not an error.
    expect(secondHarvest.errors).toEqual([]);
    expect(secondHarvest.skipped).toBe(0);
    expect(secondHarvest.candidates).toHaveLength(1);
    expect(secondHarvest.candidates[0]?.action).toBe("updated");
    expect(secondHarvest.candidates[0]?.id).toBe(articleId);
    const articles = await discoverMemoryFacts(repoRoot, "repo");
    expect(articles).toHaveLength(1);
    expect(articles[0]?.id).toBe(articleId);
    // The refreshed body carries the later session's provenance.
    expect(articles[0]?.body).toContain(`[e${later.id}]`);
    expect(articles[0]?.body).toContain("Session: session-2");
    expect(articles[0]?.status).toBe("unverified");
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
      status: "unverified",
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
      type: "agent.status-reported",
      summary: "Rebase failed: merge conflict while picking commits",
      provenance: {
        data: { command: "git rebase", exitCode: 1 },
      },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");
    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
      search: (query) => index.search(query, { limit: 5 }),
    });

    expect(report.errors).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.action).toBe("created");
    expect(report.candidates[0]?.related).toEqual([
      { scope: "repo", id: seeded.id, title: seeded.title },
    ]);
    // Appended and linked — the seeded article is untouched, both exist.
    const articles = await discoverMemoryFacts(repoRoot, "repo");
    expect(articles).toHaveLength(2);
    const candidate = required(
      articles.find((article) => article.id !== seeded.id),
    );
    expect(candidate.body).toContain(
      `Possibly related: [repo] ${seeded.id} — ${seeded.title}`,
    );
    const untouched = required(
      articles.find((article) => article.id === seeded.id),
    );
    expect(untouched.body).toBe(
      "A rebase retried mid-conflict silently drops commits.",
    );
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
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(report.errors).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.candidates).toEqual([]);
    expect(await discoverMemoryFacts(repoRoot, "repo")).toHaveLength(0);
    store.close();
  });

  // D-01r: green prose with "exit 0" must not produce a candidate or an
  // "(exit code 0)" label. Without the vacuity probe below, a harvester that
  // files nothing would pass this alone — which is close to today's live state.
  test("D-01r: green completion prose with exit 0 produces no candidate", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "Fix complete: 2772 pass / 0 fail (exit code 0)",
      provenance: { data: { phase: "complete", exitCode: 0 } },
    });

    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });

    expect(report.errors).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.candidates).toEqual([]);
    for (const candidate of report.candidates) {
      expect(candidate.title).not.toContain("(exit code 0)");
    }
    expect(await discoverMemoryFacts(repoRoot, "repo")).toHaveLength(0);
    store.close();
  });

  // Vacuity probe for D-01r: a genuine typed failure MUST produce a candidate
  // whose label is typed-derived (not summary prose).
  test("D-01r vacuity: typed failure produces a typed-derived label", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "Both jobs done at exit code 0 — but this prose is a trap",
      provenance: {
        data: {
          command: "bun test test/daemon/pitfall-harvest.test.ts",
          exitCode: 1,
        },
      },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");

    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });

    expect(report.errors).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.candidates).toHaveLength(1);
    const title = required(report.candidates[0]).title;
    expect(title).toContain("exit code 1");
    expect(title).toContain("bun test");
    expect(title).not.toContain("(exit code 0)");
    // Must not take the first four words of summary prose as the command.
    expect(title).not.toMatch(/Both jobs done/i);
    store.close();
  });

  test("D-01r: structural failure without typed label fields is skipped and counted", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    // The blocked phase proves failure, but there is no typed signature label.
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "something went wrong in the adapter",
      provenance: { data: { phase: "blocked" } },
    });

    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });

    expect(report.errors).toEqual([]);
    expect(report.candidates).toEqual([]);
    expect(report.skipped).toBe(1);
    expect(await discoverMemoryFacts(repoRoot, "repo")).toHaveLength(0);
    store.close();
  });

  test("a structurally blocked report is harvested from the typed blocker field", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "Waiting for landing authority",
      provenance: {
        data: {
          phase: "blocked",
          blocker: "Waiting for landing authority",
        },
      },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");

    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });

    expect(report.errors).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.title).toContain(
      "Waiting for landing authority",
    );
    store.close();
  });

  // D-02r: second harvest over the same history must not re-file. Without the
  // vacuity probe, a permanently disabled harvester would pass this alone.
  test("D-02r: re-harvest of the same history produces zero new candidates", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "bun test exited with code 1",
      provenance: { data: { command: "bun test", exitCode: 1 } },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");

    const first = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(first.errors).toEqual([]);
    expect(first.skipped).toBe(0);
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]?.action).toBe("created");
    const articlesAfterFirst = await discoverMemoryFacts(repoRoot, "repo");
    expect(articlesAfterFirst).toHaveLength(1);
    const rawsAfterFirst = await countRawObservations(repoRoot);
    expect(rawsAfterFirst).toBe(1);

    const second = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(second.errors).toEqual([]);
    expect(second.skipped).toBe(0);
    expect(second.candidates).toEqual([]);
    const articlesAfterSecond = await discoverMemoryFacts(repoRoot, "repo");
    expect(articlesAfterSecond).toHaveLength(1);
    // Zero new raw observations — high-water must not re-write the same events.
    expect(await countRawObservations(repoRoot)).toBe(rawsAfterFirst);
    store.close();
  });

  test("D-02r: a failed write leaves the range for exactly one retry candidate", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "bun test exited with code 1",
      provenance: { data: { command: "bun test", exitCode: 1 } },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");

    const failed = await harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      write: async () => {
        throw new Error("injected write failure");
      },
    });
    expect(failed.errors).toHaveLength(1);
    expect(failed.candidates).toEqual([]);
    expect(store.readMeta("pitfall-harvest.high-water.agent-ada")).toBeNull();

    const retried = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(retried.errors).toEqual([]);
    expect(retried.candidates).toHaveLength(1);
    expect(await countRawObservations(repoRoot)).toBe(1);

    const settled = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(settled.errors).toEqual([]);
    expect(settled.candidates).toEqual([]);
    expect(await countRawObservations(repoRoot)).toBe(1);
    store.close();
  });

  test("D-02r: retry writes only the cluster that failed after a partial success", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "first failure",
      provenance: { data: { command: "bun test", exitCode: 1 } },
    });
    store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "second failure",
      provenance: { data: { tool: "memory_write", error: "disk full" } },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");
    let writes = 0;

    const failed = await harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      write: async (input) => {
        writes += 1;
        if (writes === 2) throw new Error("injected second write failure");
        return writeMemoryFact(repoRoot, input);
      },
    });
    expect(failed.candidates).toHaveLength(1);
    expect(failed.errors).toHaveLength(1);
    expect(await countRawObservations(repoRoot)).toBe(1);

    const retried = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(retried.errors).toEqual([]);
    expect(retried.candidates).toHaveLength(1);
    expect(await countRawObservations(repoRoot)).toBe(2);
    store.close();
  });

  test("D-02r: concurrent harvests emit one candidate and one raw", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "bun test exited with code 1",
      provenance: { data: { command: "bun test", exitCode: 1 } },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");
    let releaseFirstWrite!: () => void;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWritePersisted!: () => void;
    const firstWritePersistedSignal = new Promise<void>((resolve) => {
      firstWritePersisted = resolve;
    });
    let writeCalls = 0;
    const write = async (input: Parameters<typeof writeMemoryFact>[1]) => {
      const written = await writeMemoryFact(repoRoot, input);
      writeCalls += 1;
      if (writeCalls === 1) {
        firstWritePersisted();
        await firstWritePaused;
      }
      return written;
    };

    const first = harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      write,
    });
    await firstWritePersistedSignal;
    const second = harvestPitfalls({
      store,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-1",
      write,
    });
    releaseFirstWrite();
    const reports = await Promise.all([first, second]);

    expect(reports.flatMap((report) => report.errors)).toEqual([]);
    expect(reports.flatMap((report) => report.candidates)).toHaveLength(1);
    expect(await countRawObservations(repoRoot)).toBe(1);
    store.close();
  });

  test("D-02r: a settled range prunes its persistence receipts", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "first failure",
      provenance: { data: { command: "bun test", exitCode: 1 } },
    });
    store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "second failure",
      provenance: { data: { tool: "memory_write", error: "disk full" } },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");

    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(report.errors).toEqual([]);
    expect(report.candidates).toHaveLength(2);
    expect(store.metaKeys("pitfall-harvest.persisted.agent-ada.")).toEqual([]);
    store.close();
  });

  test("D-02r: a settled high-water prunes crash-leftover receipts", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.writeMeta("pitfall-harvest.high-water.agent-ada", "4");
    store.writeMeta("pitfall-harvest.persisted.agent-ada.old-signature", "3");

    const report = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(report.errors).toEqual([]);
    expect(report.candidates).toEqual([]);
    expect(store.metaKeys("pitfall-harvest.persisted.agent-ada.")).toEqual([]);
    store.close();
  });

  // Vacuity probe for D-02r: a genuinely new failure after the first harvest
  // must be examined once, then become admissible at a later boundary.
  test("D-02r vacuity: a new failure is rejected once and admitted when it recurs", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const store = new EpisodicStore(":memory:");
    store.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "first failure",
      provenance: { data: { command: "bun test", exitCode: 1 } },
    });
    await primeCurrentFailures(store, repoRoot, "agent-ada");

    const first = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(first.candidates).toHaveLength(1);

    store.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: "second, genuinely new failure",
      provenance: {
        data: {
          tool: "memory_write",
          error: "RangeError: protolog sequence overflow",
        },
      },
    });

    const second = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-ada",
      sessionId: "session-1",
    });
    expect(second.errors).toEqual([]);
    expect(second.skipped).toBe(0);
    expect(second.rejected).toBe(1);
    expect(second.candidates).toEqual([]);

    store.appendEvent({
      ts: T2,
      agent: "agent-grace",
      type: "agent.status-reported",
      summary: "the new failure recurred",
      provenance: {
        data: {
          tool: "memory_write",
          error: "RangeError: protolog sequence overflow",
        },
      },
    });
    const third = await harvestPitfalls({
      store,
      repoRoot,
      write: indexedWriter(repoRoot).write,
      agent: "agent-grace",
      sessionId: "session-2",
    });
    expect(third.errors).toEqual([]);
    expect(third.candidates).toHaveLength(1);
    expect(third.candidates[0]?.action).toBe("created");
    expect(third.candidates[0]?.title).toContain("RangeError");
    store.close();
  });
});

// --- MCP level: memory_search kind=pitfall + the cross-agent shared-knowledge loop ------

function parseToolJson<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const content = (
    result as {
      content: Array<{ type: string; text?: string }>;
    }
  ).content[0];
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
  const client = new Client({
    name: "hive-pitfall-harvest-test",
    version: "1.0.0",
  });
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

describe("memory_search kind=pitfall", () => {
  test("kind=pitfall returns only pitfall-kind articles", async () => {
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
          evidence: "memory_search pitfall fixture",
          status: "unverified",
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
          evidence: "memory_search pitfall fixture",
          status: "unverified",
          date: TODAY,
          supersedes: [],
        },
      });

      const searched = parseToolJson<Array<{ title: string; status: string }>>(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "rebase", kind: "pitfall" },
        }),
      );
      expect(searched).toHaveLength(1);
      expect(searched[0]).toMatchObject({
        title: "Pitfall: rebase retries drop commits",
        status: "unverified",
      });
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
      type: "agent.status-reported",
      summary:
        "RangeError: protolog sequence overflow in native/sessiond broker",
      provenance: {
        data: {
          tool: "sessiond_broker",
          error:
            "RangeError: protolog sequence overflow in native/sessiond broker",
        },
      },
    });
    await primeCurrentFailures(episodic, repoRoot, "agent-ada");
    const harvest = await harvestPitfalls({
      store: episodic,
      repoRoot,
      agent: "agent-ada",
      sessionId: "session-a",
      write: (input) => daemon.writeMemoryFact(input),
    });
    expect(harvest.errors).toEqual([]);
    expect(harvest.skipped).toBe(0);
    expect(harvest.candidates).toHaveLength(1);
    const candidateId = harvest.candidates[0]?.id;

    const beth = await connectedClient(actingAs(daemon, "beth", "writer"));
    try {
      // Agent B can already see A's candidate — labeled unverified everywhere
      // it appears (hint-not-authority).
      const unverified = parseToolJson<Array<{ status: string }>>(
        await beth.callTool({
          name: "memory_search",
          arguments: { query: "protolog", kind: "pitfall" },
        }),
      );
      expect(unverified).toHaveLength(1);
      expect(unverified[0]?.status).toBe("unverified");

      // A write can no longer promote anything, however it is dressed up: the
      // author is ada, and beth restating the body is still a write.
      const byWrite = await beth.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          id: candidateId,
          topic: "pitfalls",
          kind: "pitfall",
          title: harvest.candidates[0]?.title,
          body: "VERIFIED against the cited events: the sessiond broker dies on protolog sequence overflow; restart the broker before reattaching.",
          source: "user",
          evidence: `Verified against ${harvest.candidates[0]?.title} provenance events`,
          status: "verified",
          verified: TODAY,
          date: TODAY,
          supersedes: [candidateId],
        },
      });
      expect(byWrite.isError).toBe(true);

      // Promotion is memory_verify, and beth qualifies: the harvester recorded
      // agent-ada as the author, so this is a genuinely different session. The
      // check is dated after the candidate's own day, which is why it goes
      // through the store here — the tool stamps today, and the candidate was
      // harvested today.
      const harvested = required(
        await readMemoryFact(repoRoot, "repo", required(candidateId)),
      );
      const dayAfter = new Date(`${harvested.date}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      const checkedOn = dayAfter.toISOString().slice(0, 10);
      const promoted = await verifyMemoryFact(
        repoRoot,
        "repo",
        required(candidateId),
        { verifier: "beth", date: checkedOn },
      );
      expect(promoted.status).toBe("verified");
      expect(promoted.verified).toBe(checkedOn);
      expect(promoted.author).toBe("agent-ada");
      await daemon.rebuildMemoryIndex();

      const check = parseToolJson<Array<{ id: string; status: string }>>(
        await beth.callTool({
          name: "memory_search",
          arguments: { query: "protolog", kind: "pitfall" },
        }),
      );
      expect(check).toHaveLength(1);
      expect(check[0]).toMatchObject({
        id: candidateId,
        status: "verified",
      });
    } finally {
      await beth.close().catch(() => undefined);
    }

    // And the spawn-injected memory index ranks the pitfall class first.
    const injected = await buildMemoryIndex(repoRoot);
    const firstRow = required(
      injected.split("\n").find((line) => line.startsWith("- [")),
    );
    expect(firstRow).toContain("[pitfall]");
    expect(firstRow).toContain(required(candidateId));
  });
});
