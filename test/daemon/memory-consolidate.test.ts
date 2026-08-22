import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countConsolidationCandidates,
  runMemoryConsolidation,
} from "../../src/memory-service/consolidate";
import {
  type MemoryEmbedder,
  MemoryEmbeddingService,
} from "../../src/memory-service/embeddings";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { runRetentionSweep } from "../../src/memory-service/retention";
import {
  readMemoryFact,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import type { MemoryRetentionConfig } from "../../src/schemas/config-schema";

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

async function makeFixture(): Promise<{ repo: string; store: EpisodicStore }> {
  const base = await mkdtemp(join(tmpdir(), "hive-consolidate-test-"));
  tempRoots.push(base);
  Bun.env.HIVE_HOME = join(base, "hive-home");
  const repo = join(base, "repo");
  return { repo, store: new EpisodicStore(":memory:") };
}

// Geometry the tests control exactly: the IDENTICAL pair shares a vector,
// the SIMILAR pair sits at cosine 0.9, and every group is orthogonal to the
// others so no accidental cross-pairs form.
const V_IDENTICAL = [1, 0, 0, 0];
const V_SIMILAR_OLDER = [0, 1, 0, 0];
const V_SIMILAR_NEWER = [0, 0.9, Math.sqrt(0.19), 0];
const V_LONER = [0, 0, 0, 1];

function mockEmbedder(vectors: Map<string, number[]>): MemoryEmbedder {
  return {
    model: "mock-consolidation",
    dimensions: 4,
    embed: (texts) =>
      Promise.resolve(
        texts.map((text) => {
          const vector = vectors.get(text);
          if (vector === undefined) throw new Error(`unmocked text: ${text}`);
          return vector;
        }),
      ),
    embedQuery: () => Promise.resolve([1, 0, 0, 0]),
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

const articleText = (article: { title: string; body: string }): string =>
  `${article.title}\n${article.body}`;

const IDENTICAL_OLDER = {
  id: "consolidate-identical-older",
  title: "Routing falls back to the secondary provider",
  body: "When the primary provider errors, routing falls back to the secondary.",
  date: "2026-07-20",
};
const IDENTICAL_NEWER = {
  id: "consolidate-identical-newer",
  title: "Routing fallback to the secondary provider",
  body: "When the primary provider errors, routing falls back to the secondary.",
  date: "2026-07-22",
};
const SIMILAR_OLDER = {
  id: "consolidate-similar-older",
  title: "Quota resets weekly on Monday",
  body: "The weekly quota pool resets at the start of Monday UTC.",
  date: "2026-07-20",
};
const SIMILAR_NEWER = {
  id: "consolidate-similar-newer",
  title: "Weekly quota reset timing",
  body: "Weekly quota pools reset when Monday begins in UTC.",
  date: "2026-07-22",
};
const LONER = {
  id: "consolidate-loner",
  title: "Pane focus restores on workspace attach",
  body: "The workspace restores pane focus from the saved geometry snapshot.",
  date: "2026-07-21",
};

async function plantArticles(repo: string): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>([
    [articleText(IDENTICAL_OLDER), V_IDENTICAL],
    [articleText(IDENTICAL_NEWER), V_IDENTICAL],
    [articleText(SIMILAR_OLDER), V_SIMILAR_OLDER],
    [articleText(SIMILAR_NEWER), V_SIMILAR_NEWER],
    [articleText(LONER), V_LONER],
  ]);
  for (const article of [
    IDENTICAL_OLDER,
    IDENTICAL_NEWER,
    SIMILAR_OLDER,
    SIMILAR_NEWER,
    LONER,
  ]) {
    await writeMemoryFact(repo, {
      scope: "repo",
      id: article.id,
      topic: "testing",
      title: article.title,
      body: article.body,
      date: article.date,
      source: "agent",
      evidence: "planted by memory-consolidate.test.ts",
      status: "unverified",
      supersedes: [],
    });
  }
  return vectors;
}

function seedStoredArticleVectors(store: EpisodicStore): void {
  for (const [article, vector] of [
    [IDENTICAL_OLDER, V_IDENTICAL],
    [IDENTICAL_NEWER, V_IDENTICAL],
    [SIMILAR_OLDER, V_SIMILAR_OLDER],
    [SIMILAR_NEWER, V_SIMILAR_NEWER],
    [LONER, V_LONER],
  ] as const) {
    store.upsertMemoryEmbedding({
      kind: "article",
      scope: "repo",
      sourceId: article.id,
      model: "mock-consolidation",
      vector: Float32Array.from(vector),
    });
  }
}

describe("runMemoryConsolidation — report mode", () => {
  test("leaves missing vectors untouched while apply fills them", async () => {
    const { repo, store } = await makeFixture();
    try {
      const vectors = await plantArticles(repo);
      const service = mockService(mockEmbedder(vectors));
      const before = store.memoryEmbeddings({ kind: "article" }).length;

      const report = await runMemoryConsolidation({
        repoRoot: repo,
        episodic: store,
        service,
      });

      expect(report.embedded).toBe(0);
      expect(store.memoryEmbeddings({ kind: "article" })).toHaveLength(before);

      const applied = await runMemoryConsolidation({
        repoRoot: repo,
        episodic: store,
        service,
        apply: true,
      });

      expect(applied.embedded).toBe(5);
      expect(
        store.memoryEmbeddings({ kind: "article" }).length,
      ).toBeGreaterThan(before);
    } finally {
      store.close();
    }
  });

  test("buckets pairs at the D1 thresholds and modifies nothing", async () => {
    const { repo, store } = await makeFixture();
    try {
      const vectors = await plantArticles(repo);
      seedStoredArticleVectors(store);
      const before = await readMemoryFact(repo, "repo", IDENTICAL_OLDER.id);

      const report = await runMemoryConsolidation({
        repoRoot: repo,
        episodic: store,
        service: mockService(mockEmbedder(vectors)),
      });

      expect(report.embedded).toBe(0);
      expect(report.scanned).toBe(5);
      expect(report.identical).toHaveLength(1);
      expect(report.identical[0]?.olderId).toBe(IDENTICAL_OLDER.id);
      expect(report.identical[0]?.newerId).toBe(IDENTICAL_NEWER.id);
      expect(report.identical[0]?.score).toBeCloseTo(1, 5);
      expect(report.similar).toHaveLength(1);
      expect(report.similar[0]?.olderId).toBe(SIMILAR_OLDER.id);
      expect(report.similar[0]?.newerId).toBe(SIMILAR_NEWER.id);
      expect(report.similar[0]?.score).toBeCloseTo(0.9, 5);
      // Report mode: nothing applied, every identical pair skipped.
      expect(report.applied).toHaveLength(0);
      expect(report.skipped.map((pair) => pair.olderId)).toEqual([
        IDENTICAL_OLDER.id,
      ]);
      expect(report.failures).toHaveLength(0);
      const after = await readMemoryFact(repo, "repo", IDENTICAL_OLDER.id);
      expect(after).not.toBeNull();
      expect(after?.body).toBe(before?.body);
    } finally {
      store.close();
    }
  });

  test("fails honestly when the semantic surface is unavailable", async () => {
    const { repo, store } = await makeFixture();
    try {
      await plantArticles(repo);
      await expect(
        runMemoryConsolidation({
          repoRoot: repo,
          episodic: store,
          service: mockService(null),
        }),
      ).rejects.toThrow(/unavailable/);
    } finally {
      store.close();
    }
  });
});

describe("runMemoryConsolidation — apply mode", () => {
  test("supersedes the identical older into the newer through the write path", async () => {
    const { repo, store } = await makeFixture();
    try {
      const vectors = await plantArticles(repo);
      const olderBefore = await readMemoryFact(
        repo,
        "repo",
        IDENTICAL_OLDER.id,
      );
      const newerBefore = await readMemoryFact(
        repo,
        "repo",
        IDENTICAL_NEWER.id,
      );

      const report = await runMemoryConsolidation({
        repoRoot: repo,
        episodic: store,
        service: mockService(mockEmbedder(vectors)),
        apply: true,
      });

      expect(report.failures).toHaveLength(0);
      expect(report.applied.map((pair) => pair.olderId)).toEqual([
        IDENTICAL_OLDER.id,
      ]);
      // The similar pair is NEVER auto-applied.
      expect(report.applied).toHaveLength(1);

      // The older article is superseded away; the newer stands verbatim with
      // the chain and the older's raw observations inherited.
      expect(await readMemoryFact(repo, "repo", IDENTICAL_OLDER.id)).toBeNull();
      const newer = await readMemoryFact(repo, "repo", IDENTICAL_NEWER.id);
      expect(newer).not.toBeNull();
      expect(newer?.body).toBe(newerBefore?.body);
      expect(newer?.supersedes).toContain(IDENTICAL_OLDER.id);
      for (const raw of required(olderBefore?.raw)) {
        expect(newer?.raw).toContain(raw);
      }
      // The scope log records the consolidation write.
      const log = await readFile(
        join(repo, ".hive", "memory", "wiki", "log.md"),
        "utf8",
      );
      expect(log).toContain(`ingest | ${IDENTICAL_NEWER.title}`);
      // The superseded article's vector row is stale from this moment.
      expect(
        store.memoryEmbeddings({ kind: "article" }).map((row) => row.sourceId),
      ).not.toContain(IDENTICAL_OLDER.id);
      // The similar pair's articles are untouched.
      expect(
        await readMemoryFact(repo, "repo", SIMILAR_OLDER.id),
      ).not.toBeNull();
      expect(
        (await readMemoryFact(repo, "repo", SIMILAR_NEWER.id))?.supersedes,
      ).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("consolidation candidate counting (retention sweep wiring)", () => {
  test("counts stored-vector pairs at or above the similar threshold", async () => {
    const { repo, store } = await makeFixture();
    try {
      store.upsertMemoryEmbedding({
        kind: "article",
        scope: "repo",
        sourceId: "a",
        model: "mock",
        vector: Float32Array.from([1, 0, 0, 0]),
      });
      store.upsertMemoryEmbedding({
        kind: "article",
        scope: "repo",
        sourceId: "b",
        model: "mock",
        vector: Float32Array.from([0.9, Math.sqrt(0.19), 0, 0]),
      });
      store.upsertMemoryEmbedding({
        kind: "article",
        scope: "repo",
        sourceId: "c",
        model: "mock",
        vector: Float32Array.from([0, 0, 1, 0]),
      });
      // a-b sit at 0.9 (counted), a-c and b-c are orthogonal (not counted).
      expect(countConsolidationCandidates(store)).toBe(1);

      const config: MemoryRetentionConfig = {
        events_hot_days: 30,
        stale_after_days: 90,
        sweep_interval_hours: 24,
      };
      const report = await runRetentionSweep({
        episodic: store,
        repoRoot: repo,
        config,
        now: new Date("2026-07-22T00:00:00.000Z"),
      });
      expect(report.consolidationCandidates).toBe(1);
    } finally {
      store.close();
    }
  });
});

import { required } from "../required";
