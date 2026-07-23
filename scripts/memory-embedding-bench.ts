// Floor measurement for the HiveMemory HM-5 semantic leg (board #122, plan
// D4 acceptance criterion): the REAL local embedding model (fastembed,
// bge-small-en-v1.5 by default) on this machine —
//
//   1. model load time and RSS delta (the ~100–300 MB warm budget),
//   2. per-embed latency for short memory records,
//   3. brute-force cosine search latency over a 5k-record synthetic corpus
//      (the vector store's full-scan design point).
//
// Runnable script, NOT a bun test: `bun scripts/memory-embedding-bench.ts`.
// The model downloads (~90 MB, once) into the Hive-owned models dir. Override
// the model with BENCH_MODEL=all-MiniLM-L6-v2.
import { EpisodicStore } from "../src/daemon/episodic-store";
import {
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
  memoryModelsDir,
} from "../src/daemon/memory-embeddings";
import type { MemoryEmbeddingModel } from "../src/schemas";

const model = (Bun.env.BENCH_MODEL ?? "bge-small-en-v1.5") as MemoryEmbeddingModel;

const rssMb = (): number => process.memoryUsage.rss() / 1e6;

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

function summarize(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `${label}: mean ${mean.toFixed(2)} ms, p50 ${percentile(sorted, 50).toFixed(2)} ms, ` +
      `p95 ${percentile(sorted, 95).toFixed(2)} ms, max ${sorted[sorted.length - 1]!.toFixed(2)} ms ` +
      `(${samples.length} samples)`,
  );
}

// Deterministic pseudo-random unit vectors — content is irrelevant to scan
// latency, only the width and the row count matter.
function syntheticVector(dimensions: number, seed: number): Float32Array {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31 - 0.5;
  };
  const vector = new Float32Array(dimensions);
  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    vector[i] = next();
    norm += vector[i]! * vector[i]!;
  }
  const scale = Math.sqrt(norm);
  for (let i = 0; i < dimensions; i += 1) vector[i] = vector[i]! / scale;
  return vector;
}

const CORPUS_SIZE = 5_000;
const EMBED_SAMPLES = 50;
const SEARCH_SAMPLES = 20;

const texts = Array.from(
  { length: EMBED_SAMPLES },
  (_, i) =>
    `memory record ${i}: the daemon serializes wiki writes through one ` +
    `promise chain so concurrent MCP calls never race on slug generation`,
);

console.log(`HM-5 embedding floor bench — model ${model}`);
console.log(`models dir: ${memoryModelsDir()}`);
console.log(`RSS before load: ${rssMb().toFixed(0)} MB`);

const service = new MemoryEmbeddingService({ provider: "local", model });
const loadStart = performance.now();
const embedder = await service.embedder();
const loadMs = performance.now() - loadStart;
if (embedder === null) {
  console.error(`FAIL: ${JSON.stringify(service.status())}`);
  process.exit(1);
}
console.log(`model load: ${loadMs.toFixed(0)} ms (includes any first-run download)`);
console.log(`RSS after load: ${rssMb().toFixed(0)} MB`);
console.log(`dimensions: ${embedder.dimensions}`);

// Per-embed latency, one short record at a time (the write-path shape).
const embedLatencies: number[] = [];
for (const text of texts) {
  const start = performance.now();
  await embedder.embed([text]);
  embedLatencies.push(performance.now() - start);
}
summarize("embed, single short record", embedLatencies);

// Batch latency for contrast (the rebuild/backfill shape).
const batchStart = performance.now();
await embedder.embed(texts);
console.log(
  `embed, batch of ${texts.length}: ${(performance.now() - batchStart).toFixed(0)} ms total`,
);

// 5k-record synthetic corpus in the vector store.
const store = new EpisodicStore(":memory:");
const insertStart = performance.now();
for (let i = 0; i < CORPUS_SIZE; i += 1) {
  store.upsertMemoryEmbedding({
    kind: "article",
    scope: "repo",
    sourceId: `bench-${i}`,
    model,
    vector: syntheticVector(embedder.dimensions, i + 1),
  });
}
console.log(
  `inserted ${CORPUS_SIZE} synthetic vectors in ${(performance.now() - insertStart).toFixed(0)} ms`,
);

const index = new MemoryEmbeddingIndex({ store, service });
const query = "how does the daemon keep concurrent memory writes from racing?";
const searchLatencies: number[] = [];
for (let i = 0; i < SEARCH_SAMPLES; i += 1) {
  const start = performance.now();
  const hits = await index.searchArticles(query, 10);
  searchLatencies.push(performance.now() - start);
  if (hits === null || hits.length === 0) {
    console.error("FAIL: search returned no hits over a non-empty corpus");
    process.exit(1);
  }
}
summarize(
  `brute-force cosine top-10 over ${CORPUS_SIZE} records (incl. query embed)`,
  searchLatencies,
);

console.log(`RSS after bench: ${rssMb().toFixed(0)} MB`);
// Settled warm RSS: force GC so transient embed allocations don't inflate
// the number the D4 budget is judged against.
Bun.gc(true);
console.log(`RSS after GC (settled warm): ${rssMb().toFixed(0)} MB`);
store.close();
