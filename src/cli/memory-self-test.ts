import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteMemoryFact,
  discoverMemoryFacts,
  readMemoryFact,
  writeMemoryFact,
} from "../adapters/memory";
import { runMemoryConsolidation } from "../daemon/memory-consolidate";
import { EpisodicStore } from "../daemon/episodic-store";
import {
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
  memoryModelsDir,
} from "../daemon/memory-embeddings";
import {
  findSimilarMemoryCandidates,
  MemoryIndex,
} from "../daemon/memory-index";
import type {
  MemoryKind,
  MemoryVerificationStatus,
  MemoryWriteInput,
} from "../schemas";

// HiveMemory HM-6 (plan D2): golden-canary recall probe. The friendly health
// check lies (plan A5), so this plants real articles in a throwaway fixture
// and performs actual recalls against the same adapter + FTS index layers the
// daemon uses. Deterministic, no LLM, no daemon, no network. It NEVER touches
// the real .hive/memory or ~/.hive/memory: runMemorySelfTest points HIVE_HOME
// at its own temp dir for the duration and restores it afterwards.
//
// HM-5 (board #122) added two degradation-honest semantic assertions —
// semantic-recall (a paraphrase canary only the embedding leg can find) and
// consolidation-dry-run (a reworded-fact pair the offline consolidation pass
// must bucket without modifying anything). They run only with a real
// embedder (HIVE_MEMORY_SELF_TEST_EMBEDDINGS=1 or an injected service) and
// SKIP otherwise: SKIP is not failure, because the exit code may only
// reflect what was provable in the environment the probe ran in.

interface Canary {
  id: string;
  topic: string;
  title: string;
  body: string;
  status: MemoryVerificationStatus;
  verified?: string;
  kind: MemoryKind;
  query: string;
}

const CANARY_DATE = "2026-07-22";
const CANARY_STALE_VERIFIED = "2026-07-01";

// Unique tokens guarantee each recorded query ANDs down to exactly its
// canary, so recall@5 = 100% is the planted ground truth — anything less is
// a real recall defect, not a ranking nit.
const CANARY_TOKENS = [
  "quokka",
  "narwhal",
  "axolotl",
  "pangolin",
  "tapir",
  "wombat",
  "cassowary",
  "fossa",
  "okapi",
  "saiga",
  "gerenuk",
  "markhor",
  "numbat",
  "potoo",
  "hoatzin",
  "kakapo",
  "vaquita",
  "ayeaye",
  "binturong",
  "caracal",
  "dikdik",
  "echidna",
  "fennec",
  "gharial",
  "hutia",
  "ibex",
  "jerboa",
  "kiwi",
  "lemur",
  "marmot",
];

const CANARY_TOPICS: Array<{ topic: string; phrase: string }> = [
  { topic: "routing", phrase: "provider routing fallback order" },
  { topic: "quota", phrase: "weekly quota reset window" },
  { topic: "memory", phrase: "memory index rebuild trigger" },
  { topic: "spawn", phrase: "agent spawn prompt assembly" },
  { topic: "release", phrase: "release signing key rotation" },
  { topic: "testing", phrase: "flake quarantine retry policy" },
  { topic: "delivery", phrase: "message delivery wake budget" },
  { topic: "telemetry", phrase: "usage telemetry sampling rate" },
  { topic: "workspace-ui", phrase: "pane focus restore behavior" },
  { topic: "skills", phrase: "skill lint cascade rules" },
];

const CANARY_STATUSES: MemoryVerificationStatus[] = [
  "verified",
  "unverified",
  "stale",
];

const PITFALL_INDICES = new Set([4, 14, 24]);
const CONFLICTED_INDEX = 7;

function buildCanaries(): Canary[] {
  return CANARY_TOKENS.map((token, index) => {
    const { topic, phrase } = CANARY_TOPICS[index % CANARY_TOPICS.length]!;
    const capitalized = token[0]!.toUpperCase() + token.slice(1);
    const status: MemoryVerificationStatus = index === CONFLICTED_INDEX
      ? "conflicted"
      : CANARY_STATUSES[index % CANARY_STATUSES.length]!;
    const kind: MemoryKind = PITFALL_INDICES.has(index) ? "pitfall" : "article";
    let body =
      `Self-test canary ${token} covering ${phrase}. ` +
      "Planted by the HiveMemory golden-canary recall probe.";
    if (status === "conflicted") {
      body += " Two conflicting accounts exist; reconcile before acting.";
    }
    return {
      id: `self-test-canary-${token}`,
      topic,
      title: `${capitalized} ${phrase}`,
      body,
      status,
      ...(status === "verified" ? { verified: CANARY_DATE } : {}),
      ...(status === "stale" ? { verified: CANARY_STALE_VERIFIED } : {}),
      kind,
      query: `${token} ${phrase.split(" ")[0]}`,
    };
  });
}

const CANARIES = buildCanaries();
export const MEMORY_SELF_TEST_CANARY_COUNT = CANARIES.length;

// A nonce string that is never planted: the negative control proving "no
// results" is distinguishable from "index broken" when recall@5 passes.
const NEGATIVE_CONTROL_QUERY = "zzqxvnonce916382047";

const DELETE_GUARD_TARGET = "self-test-delete-guard-target";
const DELETE_GUARD_REFERENCER = "self-test-delete-guard-referencer";

// HM-5 semantic canary (D2 meets embeddings): the body and its query share
// no content tokens ("RAM", "exhausted", "worker", "starts" appear nowhere
// in the article), so porter-tokenizer FTS cannot answer it — only the
// semantic leg can. Same construction as test/memory-embedding-live.test.ts.
const SEMANTIC_CANARY_ID = "self-test-semantic-canary";
const SEMANTIC_CANARY = {
  title: "Daemon rejects spawns below the free-memory floor",
  body:
    "When available system memory drops under the configured floor, hive " +
    "refuses to launch another agent and reports resource pressure instead.",
};
const SEMANTIC_PARAPHRASE_QUERY =
  "what happens when RAM is exhausted and a new worker starts";

// HM-5 consolidation canary pair: the same fact reworded (near-identical
// bodies, differently-normalized titles so write-path dedup layer 1 lets
// both plant), which a working consolidation pass must surface as a
// duplicate pair in report mode without touching either article.
const CONSOLIDATION_OLDER_ID = "self-test-consolidation-older";
const CONSOLIDATION_NEWER_ID = "self-test-consolidation-newer";
const CONSOLIDATION_OLDER_DATE = "2026-07-20";
const CONSOLIDATION_PAIR = [
  {
    id: CONSOLIDATION_OLDER_ID,
    date: CONSOLIDATION_OLDER_DATE,
    title: "Wake budget defaults to three hundred tokens",
    body:
      "The wake-delta injection budget defaults to 300 tokens; the daemon " +
      "clamps the recall bundle at that ceiling and reports the omitted count.",
  },
  {
    id: CONSOLIDATION_NEWER_ID,
    date: CANARY_DATE,
    title: "Wake injection budget default is 300 tokens",
    body:
      "The daemon's wake-delta injection budget defaults to 300 tokens, " +
      "clamping the recall bundle at that ceiling and reporting the omitted count.",
  },
] as const;

// Set to run the semantic assertions against the real local embedding model
// (downloads/caches it under the real Hive models dir). Unset — the default
// for CI and `bun test` — the semantic assertions SKIP honestly instead of
// loading onnxruntime into a context that cannot host it (the live-model
// proof lives in test/memory-embedding-live.test.ts).
export const MEMORY_SELF_TEST_EMBEDDINGS_ENV = "HIVE_MEMORY_SELF_TEST_EMBEDDINGS";

function canaryWriteInput(canary: Canary): MemoryWriteInput {
  return {
    scope: "repo",
    id: canary.id,
    topic: canary.topic,
    title: canary.title,
    body: canary.body,
    tags: ["self-test", canary.id],
    date: CANARY_DATE,
    source: "agent",
    evidence: "Planted by hive memory self-test",
    status: canary.status,
    kind: canary.kind,
    supersedes: [],
    ...(canary.verified === undefined ? {} : { verified: canary.verified }),
  };
}

// Plants the canary corpus plus the delete-guard arrangement under
// `<root>/.hive/memory`. Callers must point HIVE_HOME at a throwaway dir
// first (the global scope root derives from it).
export async function plantMemorySelfTestFixture(root: string): Promise<void> {
  for (const canary of CANARIES) {
    await writeMemoryFact(root, canaryWriteInput(canary));
  }
  // Delete-guard arrangement: an article that exists on disk while another
  // article's supersedes still points at it. Superseding deletes the target,
  // so re-plant it afterwards to recreate the dangling-reference situation
  // deleteMemoryFact must refuse.
  await writeMemoryFact(root, {
    scope: "repo",
    id: DELETE_GUARD_TARGET,
    topic: "testing",
    title: "Self-test delete guard target",
    body: "Original account of the delete guard fixture.",
    date: CANARY_DATE,
    source: "agent",
    evidence: "Planted by hive memory self-test",
    status: "unverified",
    supersedes: [],
  });
  await writeMemoryFact(root, {
    scope: "repo",
    id: DELETE_GUARD_REFERENCER,
    topic: "testing",
    title: "Self-test delete guard referencer",
    body: "Corrected account that supersedes the delete guard target.",
    date: CANARY_DATE,
    source: "agent",
    evidence: "Planted by hive memory self-test",
    status: "unverified",
    supersedes: [DELETE_GUARD_TARGET],
  });
  await writeMemoryFact(root, {
    scope: "repo",
    id: DELETE_GUARD_TARGET,
    topic: "testing",
    title: "Self-test delete guard target",
    body: "Re-observed after supersession; still referenced by the referencer.",
    date: CANARY_DATE,
    source: "agent",
    evidence: "Planted by hive memory self-test",
    status: "unverified",
    supersedes: [],
  });
  // Semantic canary: only the embedding leg can recall it from its
  // paraphrase query.
  await writeMemoryFact(root, {
    scope: "repo",
    id: SEMANTIC_CANARY_ID,
    topic: "memory",
    title: SEMANTIC_CANARY.title,
    body: SEMANTIC_CANARY.body,
    date: CANARY_DATE,
    source: "agent",
    evidence: "Planted by hive memory self-test",
    status: "unverified",
    supersedes: [],
  });
  // Consolidation pair: the same fact reworded, for the dry-run assertion.
  for (const member of CONSOLIDATION_PAIR) {
    await writeMemoryFact(root, {
      scope: "repo",
      id: member.id,
      topic: "memory",
      title: member.title,
      body: member.body,
      date: member.date,
      source: "agent",
      evidence: "Planted by hive memory self-test",
      status: "unverified",
      supersedes: [],
    });
  }
}

export interface SelfTestAssertion {
  name: string;
  passed: boolean;
  /** True when the assertion could not run because the semantic surface is
   * unavailable — reported as SKIP, never counted as a failure (liveness
   * honesty: the exit code reflects only what was provable). */
  skipped?: boolean;
  detail: string;
}

async function attempt(
  name: string,
  check: () => Promise<string>,
): Promise<SelfTestAssertion> {
  try {
    return { name, passed: true, detail: await check() };
  } catch (error) {
    return {
      name,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Runs the probe assertions against an already-planted fixture at `root`.
// Each assertion is independent: one failure never hides the others. The
// semantic assertions run only when `options.service` resolves to a real
// embedder; otherwise they SKIP honestly.
export async function probeMemorySelfTest(
  root: string,
  options: { service?: MemoryEmbeddingService } = {},
): Promise<SelfTestAssertion[]> {
  const index = new MemoryIndex(new Database(":memory:"));
  await index.rebuild(root);

  const recall = await attempt("recall@5", async () => {
    const missing: string[] = [];
    for (const canary of CANARIES) {
      const hits = index.search(canary.query, { limit: 5 });
      if (!hits.some((hit) => hit.scope === "repo" && hit.id === canary.id)) {
        missing.push(canary.id);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${CANARIES.length - missing.length}/${CANARIES.length} canaries ` +
          `recalled in top 5; missing: ${missing.join(", ")}`,
      );
    }
    return `${CANARIES.length}/${CANARIES.length} canaries recalled in top 5`;
  });

  const readBack = await attempt("read-back", async () => {
    const mismatched: string[] = [];
    for (const canary of CANARIES) {
      const fact = await readMemoryFact(root, "repo", canary.id);
      if (
        fact === null || fact.title !== canary.title ||
        fact.status !== canary.status || fact.kind !== canary.kind
      ) {
        mismatched.push(canary.id);
      }
    }
    if (mismatched.length > 0) {
      throw new Error(
        `${mismatched.length} canaries failed to round-trip: ` +
          mismatched.join(", "),
      );
    }
    return "every canary round-trips with status/kind/title intact";
  });

  const negativeControl = await attempt("negative-control", async () => {
    const hits = index.search(NEGATIVE_CONTROL_QUERY, { limit: 5 });
    if (hits.length > 0) {
      throw new Error(
        `nonce query returned ${hits.length} unexpected hit(s): ` +
          hits.map((hit) => hit.id).join(", "),
      );
    }
    return "nonce query returns zero hits";
  });

  const dedupLayer1 = await attempt("dedup-layer-1", async () => {
    const canary = CANARIES[0]!;
    const { id: _plantedId, ...planted } = canaryWriteInput(canary);
    try {
      await writeMemoryFact(root, {
        ...planted,
        // Same normalized title (case changes only) under a new id: layer 1
        // must hard-reject this as a duplicate.
        title: canary.title.toUpperCase(),
      });
    } catch (error) {
      if (error instanceof Error && /duplicate memory article title/i.test(error.message)) {
        return "normalized-title duplicate rejected with the colliding id named";
      }
      throw error;
    }
    throw new Error("normalized-title duplicate write was accepted");
  });

  const dedupLayer2 = await attempt("dedup-layer-2", async () => {
    const canary = CANARIES[0]!;
    // Different normalized title (layer 1 lets it through), overlapping
    // terms: the write succeeds and the lookalike comes back as an advisory
    // candidate — the exact query the daemon's memory_write runs.
    const written = await writeMemoryFact(root, {
      scope: "repo",
      id: "self-test-near-duplicate",
      topic: canary.topic,
      title: `${canary.title.split(" ")[0]} routing fallback`,
      body: `Near-duplicate of the ${canary.id} canary, planted to exercise dedup layer 2.`,
      date: CANARY_DATE,
      source: "agent",
      evidence: "Planted by hive memory self-test",
      status: "unverified",
      supersedes: [],
    });
    index.upsertFact(written);
    const candidates = findSimilarMemoryCandidates(index, written);
    if (!candidates.some((candidate) => candidate.id === canary.id)) {
      throw new Error(
        `near-duplicate write returned no similarCandidates pointing at ${canary.id}`,
      );
    }
    return `near-duplicate write flags ${canary.id} as a similar candidate`;
  });

  const deleteGuard = await attempt("delete-guard", async () => {
    try {
      await deleteMemoryFact(root, "repo", DELETE_GUARD_TARGET);
    } catch (error) {
      if (error instanceof Error && /still referenced/.test(error.message)) {
        return `delete of ${DELETE_GUARD_TARGET} refused while ` +
          `${DELETE_GUARD_REFERENCER} supersedes it`;
      }
      throw error;
    }
    throw new Error(
      `delete of ${DELETE_GUARD_TARGET} succeeded despite a live supersedes reference`,
    );
  });

  // HM-5 semantic assertions. Degradation-honest (plan A5/D2): when the
  // embedding service is unavailable both print SKIP and do not fail the run
  // — the exit code reflects only what was provable here, and the real-model
  // proof lives in test/memory-embedding-live.test.ts.
  const embedder = options.service === undefined
    ? null
    : await options.service.embedder();
  const skippedDetail = "embeddings unavailable";
  let semanticRecall: SelfTestAssertion;
  let consolidationDryRun: SelfTestAssertion;
  if (embedder === null) {
    semanticRecall = {
      name: "semantic-recall",
      passed: false,
      skipped: true,
      detail: skippedDetail,
    };
    consolidationDryRun = {
      name: "consolidation-dry-run",
      passed: false,
      skipped: true,
      detail: skippedDetail,
    };
  } else {
    // One in-memory vector store over the whole planted fixture serves both
    // assertions (the consolidation pass reuses the rows instead of
    // re-embedding).
    const vectorStore = new EpisodicStore(":memory:");
    try {
      const semanticIndex = new MemoryEmbeddingIndex({
        store: vectorStore,
        service: options.service!,
      });
      for (const scope of ["repo", "global"] as const) {
        for (const fact of await discoverMemoryFacts(root, scope)) {
          await semanticIndex.upsertArticle(
            scope,
            fact.id,
            MemoryEmbeddingIndex.articleText(fact),
          );
        }
      }
      // The first upserts ride the queued path (the model load must not block
      // a write); drain the background projections before searching.
      await semanticIndex.settle();

      semanticRecall = await attempt("semantic-recall", async () => {
        const hits = await semanticIndex.searchArticles(
          SEMANTIC_PARAPHRASE_QUERY,
          5,
        );
        if (hits === null) throw new Error("semantic surface went unavailable mid-run");
        if (!hits.some((hit) => hit.scope === "repo" && hit.id === SEMANTIC_CANARY_ID)) {
          throw new Error(
            `paraphrase query did not rank ${SEMANTIC_CANARY_ID} in the ` +
              `semantic top 5 (got: ${hits.map((hit) => hit.id).join(", ") || "no hits"})`,
          );
        }
        return `paraphrase query ranks ${SEMANTIC_CANARY_ID} in the semantic top 5`;
      });

      consolidationDryRun = await attempt("consolidation-dry-run", async () => {
        const before = new Map<string, string>();
        for (const id of [CONSOLIDATION_OLDER_ID, CONSOLIDATION_NEWER_ID]) {
          const fact = await readMemoryFact(root, "repo", id);
          if (fact === null) throw new Error(`planted pair member ${id} missing`);
          before.set(id, await readFile(fact.path, "utf8"));
        }
        const report = await runMemoryConsolidation({
          repoRoot: root,
          episodic: vectorStore,
          service: options.service!,
        });
        const pair = [...report.identical, ...report.similar].find(
          (candidate) =>
            candidate.scope === "repo" &&
            [candidate.olderId, candidate.newerId].sort().join("") ===
              [CONSOLIDATION_OLDER_ID, CONSOLIDATION_NEWER_ID].sort().join(""),
        );
        if (pair === undefined) {
          throw new Error(
            `report mode found no duplicate pair between ` +
              `${CONSOLIDATION_OLDER_ID} and ${CONSOLIDATION_NEWER_ID} ` +
              `(identical: ${report.identical.length}, similar: ${report.similar.length})`,
          );
        }
        const bucket = report.identical.includes(pair) ? "identical" : "similar";
        for (const [id, contents] of before) {
          const fact = await readMemoryFact(root, "repo", id);
          if (fact === null || await readFile(fact.path, "utf8") !== contents) {
            throw new Error(`report mode modified ${id} — consolidation must be read-only without --apply`);
          }
        }
        return (
          `pair ${CONSOLIDATION_OLDER_ID} ↔ ${CONSOLIDATION_NEWER_ID} found ` +
          `in the ${bucket} bucket (cosine ${pair.score.toFixed(3)}); ` +
          "nothing modified without --apply"
        );
      });
    } finally {
      vectorStore.close();
    }
  }

  return [
    recall,
    readBack,
    negativeControl,
    dedupLayer1,
    dedupLayer2,
    deleteGuard,
    semanticRecall,
    consolidationDryRun,
  ];
}

export interface MemorySelfTestReport {
  ok: boolean;
  lines: string[];
}

// Full standalone run: throwaway HIVE_HOME + repo root, plant, probe, clean
// up. Safe to run in any checkout — nothing outside the temp dir is touched.
// Without an explicit `options.service`, the semantic assertions get the
// real local model only when HIVE_MEMORY_SELF_TEST_EMBEDDINGS=1 (its cache
// dir is captured BEFORE the HIVE_HOME redirect so the model cache is
// reused, not re-downloaded into the throwaway home); otherwise they SKIP.
export async function runMemorySelfTest(
  options: { service?: MemoryEmbeddingService } = {},
): Promise<MemorySelfTestReport> {
  const base = await mkdtemp(join(tmpdir(), "hive-memory-self-test-"));
  const previousHome = process.env.HIVE_HOME;
  const service = options.service ??
    (process.env[MEMORY_SELF_TEST_EMBEDDINGS_ENV] === "1"
      ? new MemoryEmbeddingService(
        { provider: "local", model: "bge-small-en-v1.5" },
        { cacheDir: memoryModelsDir() },
      )
      : undefined);
  process.env.HIVE_HOME = join(base, "hive-home");
  try {
    const repoRoot = join(base, "repo");
    await plantMemorySelfTestFixture(repoRoot);
    const assertions = await probeMemorySelfTest(
      repoRoot,
      service === undefined ? {} : { service },
    );
    return {
      ok: assertions.every((assertion) =>
        assertion.passed || assertion.skipped === true
      ),
      lines: assertions.map((assertion) =>
        `${
          assertion.skipped === true ? "SKIP" : assertion.passed ? "PASS" : "FAIL"
        } ${assertion.name} — ` + assertion.detail
      ),
    };
  } finally {
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
}

export async function memorySelfTestCli(): Promise<number> {
  const report = await runMemorySelfTest();
  for (const line of report.lines) console.log(line);
  const passed = report.lines.filter((line) => line.startsWith("PASS ")).length;
  const skipped = report.lines.filter((line) => line.startsWith("SKIP "));
  console.log(
    report.ok
      ? `memory self-test: all ${passed} assertions passed` +
        (skipped.length > 0
          ? ` (${skipped.length} skipped — embeddings unavailable; set ` +
            `${MEMORY_SELF_TEST_EMBEDDINGS_ENV}=1 to prove the semantic leg)`
          : "")
      : "memory self-test: FAILED — the memory system is not recalling correctly",
  );
  return report.ok ? 0 : 1;
}
