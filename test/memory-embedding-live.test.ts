// The HM-5 honest gate evidence (board #122, plan D4/A7): the REAL local
// embedding model (fastembed bge-small-en-v1.5, no mocks) recalls a canary
// article from a PARAPHRASE query that the porter-tokenizer FTS cannot
// match. This is the property the whole semantic leg exists for — if it
// fails, the leg is decorative and the card's premise is wrong.
//
// Gated on HIVE_LIVE_MEMORY_EMBEDDINGS=1 (the repo's live-e2e skip pattern):
// it downloads the ~90 MB model on first run and is not part of `bun test`.
// Run TARGETED, not as part of a full-suite flagged run (see liveFailed):
//   HIVE_LIVE_MEMORY_EMBEDDINGS=1 bun test test/memory-embedding-live.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryFact } from "../src/adapters/memory";
import { EpisodicStore } from "../src/daemon/episodic-store";
import {
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
  memoryModelsDir,
} from "../src/daemon/memory-embeddings";
import { MemoryIndex } from "../src/daemon/memory-index";
import { buildMemoryRecallBundle } from "../src/daemon/memory-triggers";

const live = process.env.HIVE_LIVE_MEMORY_EMBEDDINGS === "1";
const liveSuite = live ? describe : describe.skip;

// Bun 1.3.14 + onnxruntime-node: the N-API module crashes the process with a
// SIGTRAP during teardown after the test run finishes (plain `bun` exits
// cleanly; only `bun test` crashes — bench and daemon are unaffected). Tests
// have already reported their own pass/fail by then, so this file tracks
// failure itself and exits explicitly to keep the gate's exit code honest:
// green assertions → 0, any failure → 1, and the crash never gets to run.
let liveFailed = false;

/** Run a live test body, tracking failure for the explicit exit above. */
async function gated(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    liveFailed = true;
    throw error;
  }
}

// The canary and its paraphrase query share almost no surface tokens, so
// FTS (AND over porter-stemmed query tokens) cannot match it — "RAM",
// "exhausted", "worker", "starts" appear nowhere in the canary.
const CANARY = {
  title: "Daemon rejects spawns below the free-memory floor",
  body:
    "When available system memory drops under the configured floor, hive " +
    "refuses to launch another agent and reports resource pressure instead.",
};
const PARAPHRASE_QUERY = "what happens when RAM is exhausted and a new worker starts";

const DISTRACTORS = [
  {
    title: "Composer lease renewal cadence",
    body:
      "The workspace visibility lease renews every fifteen seconds; a " +
      "missed renewal hides the agent from the workspace view.",
  },
  {
    title: "Recall bundle token clamping",
    body:
      "When the recall bundle exceeds its token budget the daemon cuts " +
      "articles before pitfalls and reports the omitted count.",
  },
  {
    title: "Rebase required after main moves",
    body:
      "A writer whose branch falls behind main must rebase before landing; " +
      "the land tool rejects a stale branch tip.",
  },
];

liveSuite("memory embeddings, live (HIVE_LIVE_MEMORY_EMBEDDINGS=1)", () => {
  let tempRoot = "";
  let previousHiveHome: string | undefined;
  let repo = "";
  let fts: MemoryIndex;
  let index: MemoryEmbeddingIndex;
  let service: MemoryEmbeddingService;
  let store: EpisodicStore;
  // The model cache stays in the REAL Hive models dir so repeated live runs
  // reuse the download; only memory state is sandboxed.
  const realModelsDir = memoryModelsDir();
  /** Article ids as the wiki write actually slugged them (slugs truncate). */
  const idByTitle = new Map<string, string>();
  const canaryId = (): string => idByTitle.get(CANARY.title)!;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hive-hm5-live-"));
    previousHiveHome = Bun.env.HIVE_HOME;
    Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
    repo = join(tempRoot, "repo");
    await mkdtemp(repo).catch(() => undefined);

    fts = new MemoryIndex(new Database(":memory:"));
    for (const article of [CANARY, ...DISTRACTORS]) {
      const written = await writeMemoryFact(repo, {
        scope: "repo",
        topic: "testing",
        title: article.title,
        body: article.body,
        source: "agent",
        evidence: "memory-embedding-live.test.ts",
        status: "unverified",
        kind: "article",
        tags: [],
        supersedes: [],
      });
      fts.upsertFact(written);
      idByTitle.set(article.title, written.id);
    }

    service = new MemoryEmbeddingService(
      { provider: "local", model: "bge-small-en-v1.5" },
      { cacheDir: realModelsDir },
    );
    store = new EpisodicStore(":memory:");
    index = new MemoryEmbeddingIndex({ store, service });
    for (const article of [CANARY, ...DISTRACTORS]) {
      await index.upsertArticle(
        "repo",
        idByTitle.get(article.title)!,
        MemoryEmbeddingIndex.articleText(article),
      );
    }
  }, 120_000);

  afterAll(async () => {
    store?.close();
    if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
    else Bun.env.HIVE_HOME = previousHiveHome;
    await rm(tempRoot, { recursive: true, force: true });
    // See the liveFailed comment: exit before onnxruntime's teardown SIGTRAP,
    // with the exit code the assertions earned.
    process.exit(liveFailed ? 1 : 0);
  });

  test("the real model loads and asserts its dimension", async () => {
    await gated(async () => {
      const embedder = await service.embedder();
      expect(embedder).not.toBeNull();
      expect(embedder!.dimensions).toBe(384);
    });
  }, 120_000);

  test("paraphrase recall: FTS misses the canary, semantic ranks it #1", async () => {
    await gated(async () => {
      // The FTS leg honestly cannot answer this query class.
      const ftsHits = fts.search(PARAPHRASE_QUERY, { limit: 8 });
      expect(ftsHits.map((hit) => hit.id)).not.toContain(canaryId());

      // The semantic leg can.
      const semantic = await index.searchArticles(PARAPHRASE_QUERY, 8);
      expect(semantic).not.toBeNull();
      expect(semantic![0]!.id).toBe(canaryId());

      // And the hybrid bundle surfaces what FTS-only recall provably misses.
      const ftsOnly = await buildMemoryRecallBundle(PARAPHRASE_QUERY, {
        memory: fts,
        repoRoot: () => repo,
      });
      const ftsOnlyIds = [...ftsOnly.pitfalls, ...ftsOnly.articles]
        .map((row) => row.id);
      expect(ftsOnlyIds).not.toContain(canaryId());

      const hybrid = await buildMemoryRecallBundle(PARAPHRASE_QUERY, {
        memory: fts,
        repoRoot: () => repo,
        semantic: (query, limit) => index.searchArticles(query, limit),
      });
      const hybridIds = [...hybrid.pitfalls, ...hybrid.articles]
        .map((row) => row.id);
      expect(hybridIds).toContain(canaryId());
    });
  }, 120_000);
});
