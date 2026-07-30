// The live tier of `hive memory self-test` must prove the
// DEPLOYED surface — a running daemon answered over MCP through the same
// daemon.port + operator-credential discovery every CLI command uses. These
// tests stand up a real HiveDaemon on an ephemeral port against a scratch
// HIVE_HOME + scratch project (the daemon writes nothing lifecycle-related;
// the test writes daemon.port and mints the operator credential exactly the
// way a lifecycle-owning daemon would), then run the live probe against it:
//
//   - green flow: a working (mock) embedder passes every live assertion;
//   - degraded flow: a failing embedder load FAILS the run with the state
//     named — the regression that would have caught D1;
//   - no daemon: an honest nonzero failure, never a green run.
//
// The mock embedder keeps `bun test` off the real model (the onnxruntime
// teardown SIGTRAP is documented in test/memory-embedding-live.test.ts; the
// LIVE-model tier stays in the env-gated live test files).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recallMemory, writeMemory } from "../src/cli/mcp";
import {
  memoryLiveSelfTestCli,
  runMemoryLiveSelfTest,
} from "../src/cli/memory-self-test-live";
import { OPERATOR_SUBJECT } from "../src/daemon/credentials";
import { HiveDatabase } from "../src/daemon/db";
import { EpisodicStore } from "../src/daemon/episodic-store";
import type { MemoryEmbedder } from "../src/daemon/memory-embeddings";
import { HiveDaemon } from "../src/daemon/server";
import type { Spawner, SpawnRequest } from "../src/daemon/spawner";
import type { AgentRecord } from "../src/schemas";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";
import { required } from "./required";

const tempRoots: string[] = [];
const daemons: HiveDaemon[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHome;
  for (const daemon of daemons.splice(0)) {
    await daemon.stop().catch(() => undefined);
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, prefix));
  tempRoots.push(dir);
  return dir;
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by live self-test tests");
  }
}

// One shared direction: every text embeds to the same unit vector, so cosine
// top-k ranks whatever is stored — the probe's assertion is presence + the
// hybrid label, not ranking geometry (the fixture tier owns geometry).
function mockEmbedder(): MemoryEmbedder {
  return {
    model: "bge-small-en-v1.5",
    dimensions: 4,
    embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
    embedQuery: () => Promise.resolve([1, 0, 0, 0]),
  };
}

async function makeLiveDaemon(
  options: { failingLoad?: boolean } = {},
): Promise<{
  daemon: HiveDaemon;
  home: string;
  repoRoot: string;
  port: number;
}> {
  const home = await makeTempDir("hive-self-test-live-home-");
  process.env.HIVE_HOME = home;
  const repoRoot = await makeTempDir("hive-self-test-live-repo-");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
    port: 0,
    episodicStore: new EpisodicStore(":memory:"),
    memoryEmbeddings: { provider: "local", model: "bge-small-en-v1.5" },
    memoryEmbeddingLoad: () =>
      options.failingLoad === true
        ? Promise.reject(
            new Error("embedding-runtime-missing: no bundle in the test"),
          )
        : Promise.resolve(mockEmbedder()),
  });
  daemons.push(daemon);
  daemon.start();
  const port = daemon.listeningPort;
  if (port === null) throw new Error("test daemon did not bind a port");
  // The probe's discovery path, exactly as a lifecycle-owning daemon leaves
  // it: daemon.port plus the operator credential under the scratch HIVE_HOME.
  await writeFile(join(home, "daemon.port"), `${port}\n`);
  daemon.issueCredential(OPERATOR_SUBJECT, "operator", 0);
  return { daemon, home, repoRoot, port };
}

function lineFor(lines: string[], name: string): string {
  const line = lines.find((candidate) => candidate.includes(` ${name} —`));
  expect(line, `expected a line for ${name}`).toBeDefined();
  return required(line);
}

describe("hive memory self-test --live (defect D3)", () => {
  test("green flow: a healthy live daemon passes every live assertion", async () => {
    await makeLiveDaemon();
    const report = await runMemoryLiveSelfTest({ settleBudgetMs: 10_000 });
    expect(report.lines.join("\n")).not.toContain("FAIL");
    expect(report.ok).toBe(true);
    for (const line of report.lines) {
      expect(line.startsWith("[live] ")).toBe(true);
    }
    expect(lineFor(report.lines, "daemon-discovery")).toContain("PASS");
    const reported = lineFor(report.lines, "reported-state");
    expect(reported).toContain("PASS");
    expect(reported).toContain("provider=local");
    expect(reported).toContain("runtimeDir=");
    expect(lineFor(report.lines, "write-article-projection")).toMatch(
      /PASS.*embedding: (indexed|queued)/,
    );
    expect(lineFor(report.lines, "write-note-projection")).toMatch(
      /PASS.*embedding: (indexed|queued)/,
    );
    expect(lineFor(report.lines, "semantic-recall")).toMatch(
      /PASS.*semantic: hybrid/,
    );
    expect(lineFor(report.lines, "fts-recall")).toContain("PASS");
    expect(lineFor(report.lines, "article-read-back")).toContain("PASS");
    expect(lineFor(report.lines, "note-read-back")).toContain("PASS");
    expect(lineFor(report.lines, "digest-read")).toContain("PASS");
    const cleanup = lineFor(report.lines, "cleanup");
    expect(cleanup).toContain("PASS");
    expect(cleanup).toContain("self-test canary, safe to delete");
  }, 30_000);

  test("degraded flow: a down semantic leg FAILS the run with the state named " +
    "(the D1 regression)", async () => {
    await makeLiveDaemon({ failingLoad: true });
    const report = await runMemoryLiveSelfTest({ settleBudgetMs: 5_000 });
    expect(report.ok).toBe(false);
    const output = report.lines.join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("embedding-runtime-missing");
    // The semantic-recall assertion is the loud one: the recall envelope
    // itself names the degraded state.
    const semantic = lineFor(report.lines, "semantic-recall");
    expect(semantic).toContain("FAIL");
    expect(semantic).toContain("degraded:embedding-runtime-missing");
  }, 30_000);

  async function plantFiller(
    port: number,
    kind: "pitfall" | "article",
    count: number,
  ): Promise<void> {
    // Ids sort before the probe's `self-test-live-<nonce>` canary, so with the
    // mock embedder's single shared direction these rank ahead of it.
    for (let index = 0; index < count; index += 1) {
      await writeMemory(port, {
        scope: "repo",
        id: `aaa-recall-budget-${kind}-${index}`,
        topic: "pitfalls",
        title:
          `Filler ${kind} ${index} with a deliberately long title so this row ` +
          "costs a realistic share of the recall token ceiling",
        body:
          `Filler ${kind} ${index}. ` +
          "This body is long enough that the recall row carries a full-length " +
          "snippet, which is what makes the row expensive enough to crowd the " +
          "bundle exactly as a real grown memory corpus does.",
        source: "agent",
        evidence: "Planted by the recall-budget regression test",
        status: "unverified",
        kind,
        supersedes: [],
      });
    }
  }

  test("a pitfall-heavy corpus cannot starve the articles partition", async () => {
    const { port } = await makeLiveDaemon();
    // The live degradation: enough pitfall rows to fill the whole recall token
    // ceiling. Under a pitfalls-first priority ordering every article — the
    // probe's canary included — is cut, and semantic recall silently stops
    // returning articles while the embedding leg is perfectly healthy. The
    // reserved article share is what keeps the canary reachable.
    await plantFiller(port, "pitfall", 7);

    const report = await runMemoryLiveSelfTest({ settleBudgetMs: 5_000 });
    expect(lineFor(report.lines, "semantic-recall")).toMatch(
      /PASS.*semantic: hybrid/,
    );

    // The probe deletes its canary, so re-establish the same shape it ran
    // under — a pitfall corpus that overruns the ceiling, plus one article —
    // and assert the invariant directly: the article survives, a pitfall is
    // what gets cut, and the signal names that side.
    await plantFiller(port, "article", 1);
    const envelope = await recallMemory(
      port,
      "what happens when RAM is exhausted and a new worker starts",
    );
    expect(envelope.truncated).toBe(true);
    expect(envelope.articles.length).toBeGreaterThan(0);
    expect(required(envelope.omittedPitfalls)).toBeGreaterThan(0);
    expect(required(envelope.omittedArticles)).toBe(0);
  }, 30_000);

  test("a bundle truncated at the recall token ceiling is not reported as a " +
    "stalled projection", async () => {
    const { port } = await makeLiveDaemon();
    // Crowd the ARTICLES side instead, so the canary is genuinely cut from the
    // bundle while the semantic leg is healthy and the projection settles.
    await plantFiller(port, "article", 9);

    const report = await runMemoryLiveSelfTest({ settleBudgetMs: 2_000 });
    const semantic = lineFor(report.lines, "semantic-recall");
    expect(semantic).toContain("FAIL");
    expect(semantic).toContain("truncated at the token ceiling");
    expect(semantic).toContain("articles");
    // The load-bearing half: the probe must NOT invent a projection stall it
    // never measured.
    expect(semantic).not.toContain("the queued projection never settled");
  }, 30_000);

  test("no daemon: an honest nonzero failure, never a green run", async () => {
    const home = await makeTempDir("hive-self-test-live-empty-home-");
    process.env.HIVE_HOME = home;
    const report = await runMemoryLiveSelfTest();
    expect(report.ok).toBe(false);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toContain("FAIL daemon-discovery");
    expect(report.lines[0]).toContain("no live daemon");
    expect(await memoryLiveSelfTestCli()).toBe(1);
  });
});
