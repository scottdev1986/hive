// The three-way write invariant, asserted directly against the service that
// owns it: one write must leave an article in all three stores — the Markdown
// file, the FTS row keyword search reads, and the vector the semantic leg
// reads. A test that only checks the file cannot tell a healthy write from one
// that is invisible to search.
//
// The embedder is mocked; `bun test` never downloads a model.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  type MemoryEmbedder,
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
} from "../../src/memory-service/embeddings";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { harvestPitfalls } from "../../src/memory-service/harvest";
import { listMemoryFacts } from "../../src/memory-service/memory-store";
import { MemoryWriteService } from "../../src/memory-service/write-service";
import type { MemoryWriteInput } from "../../src/schemas/memory";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const embedder: MemoryEmbedder = {
  model: "bge-small-en-v1.5",
  dimensions: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0, 0])),
  embedQuery: () => Promise.resolve([1, 0, 0, 0]),
};

async function makeService(): Promise<{
  service: MemoryWriteService;
  repoRoot: string;
  index: MemoryIndex;
  episodic: EpisodicStore;
  embeddingIndex: MemoryEmbeddingIndex;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-write-service-"));
  tempRoots.push(repoRoot);
  const index = new MemoryIndex(new Database(":memory:"));
  const episodic = new EpisodicStore(":memory:");
  const embeddingIndex = new MemoryEmbeddingIndex({
    store: episodic,
    service: new MemoryEmbeddingService(
      { provider: "local", model: "bge-small-en-v1.5" },
      { load: () => Promise.resolve(embedder) },
    ),
    log: () => {},
  });
  return {
    service: new MemoryWriteService({ repoRoot, index, embeddingIndex }),
    repoRoot,
    index,
    episodic,
    embeddingIndex,
  };
}

const input: MemoryWriteInput = {
  scope: "repo",
  topic: "testing",
  title: "One write reaches all three stores",
  body: "The file is the truth; the FTS row and the vector are projections.",
  source: "user",
  evidence: "write-service.test.ts",
  status: "unverified",
  supersedes: [],
};

test("a deliberate one-shot write bypasses admission and lands all three stores", async () => {
  const { service, index, episodic, embeddingIndex } = await makeService();

  const written = await service.write(input);
  await embeddingIndex.settle();

  // 1. The file on disk, read back rather than inferred from the result.
  const contents = await readFile(written.path, "utf8");
  expect(contents).toContain(input.title);

  // 2. The keyword index — searched, not counted, so this fails if the row
  //    exists but does not match the article it was built from.
  const hits = index.search("projections", { limit: 5 });
  expect(hits.map((hit) => hit.id)).toContain(written.id);

  // 3. The vector.
  const vectors = episodic
    .memoryEmbeddings()
    .filter((row) => row.kind === "article" && row.sourceId === written.id);
  expect(vectors).toHaveLength(1);
  // The first write of a cold leg reports "queued" because the model load must
  // not block it; either way the caller is told what happened to its vector
  // rather than left to assume.
  expect(["indexed", "queued"]).toContain(written.embedding);
  expect(episodic.memoryAdmissionStats()).toEqual({
    seenCandidates: 0,
    rejectedTotal: 0,
    lastRejectedAt: null,
  });

  episodic.close();
});

test("the harvester's writes reach all three stores too", async () => {
  // The path that used to fall back to a file-only writer. The harvester is
  // live, and a break here is silent until somebody searches, so an admitted
  // candidate is asserted against all three stores rather than only the file.
  const { service, repoRoot, index, episodic, embeddingIndex } =
    await makeService();
  const store = new EpisodicStore(":memory:");
  store.appendEvent({
    ts: "2026-07-22T10:00:00.000Z",
    agent: "agent-ada",
    type: "agent.status-reported",
    summary: "bun test exited with code 1",
    provenance: { data: { command: "bun test", exitCode: 1 } },
  });
  expect(
    store.observeMemoryCandidate({
      signature: "exit:1:bun test",
      observedAt: "2026-07-22T09:00:00.000Z",
      firstObservationReceipt: { key: "test.primer", value: "1" },
    }),
  ).toBe("rejected");

  const report = await harvestPitfalls({
    store,
    repoRoot,
    agent: "agent-ada",
    sessionId: "session-1",
    write: (harvested) => service.write(harvested),
  });
  await embeddingIndex.settle();

  expect(report.errors).toEqual([]);
  const candidateId = report.candidates[0]?.id ?? "";
  expect(candidateId).not.toBe("");

  const facts = await listMemoryFacts(repoRoot);
  expect(facts.map((fact) => fact.id)).toContain(candidateId);
  expect(index.search("bun test", { limit: 5 }).map((hit) => hit.id)).toContain(
    candidateId,
  );
  expect(
    episodic
      .memoryEmbeddings()
      .filter((row) => row.kind === "article" && row.sourceId === candidateId),
  ).toHaveLength(1);

  store.close();
  episodic.close();
});

test("a delete removes the article from all three stores", async () => {
  const { service, index, episodic, embeddingIndex } = await makeService();
  const written = await service.write(input);
  await embeddingIndex.settle();

  expect(await service.delete("repo", written.id)).toBe(true);

  expect(await readFile(written.path, "utf8").catch(() => null)).toBeNull();
  expect(index.search("projections", { limit: 5 })).toHaveLength(0);
  expect(
    episodic
      .memoryEmbeddings()
      .filter((row) => row.kind === "article" && row.sourceId === written.id),
  ).toHaveLength(0);

  episodic.close();
});

test("the critical section serializes concurrent writes rather than racing", async () => {
  const { service, index, episodic } = await makeService();

  // Two writes of the same title, launched together. Serialized, the second
  // runs after the first has landed, sees it on disk and is refused as a
  // duplicate. Interleaved, both would pass the duplicate check against an
  // empty directory and race for one id and one raw path.
  const settled = await Promise.allSettled([
    service.write({ ...input, body: "First body, long enough to be a claim." }),
    service.write({
      ...input,
      body: "Second body, long enough to be a claim.",
    }),
  ]);

  expect(
    settled.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = settled.find((result) => result.status === "rejected");
  expect(String(rejected?.reason)).toContain("Duplicate memory article title");
  expect(index.search("claim", { limit: 5 })).toHaveLength(1);

  episodic.close();
});
