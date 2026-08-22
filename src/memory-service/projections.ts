import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MEMORY_PROJECTION_SCHEMA_VERSION,
  type MemoryConfigProjection,
  type MemoryIndexHealth,
  type MemoryJobReceipt,
  type MemoryMaintenanceProjection,
  MemoryMaintenanceProjectionSchema,
  type MemoryOverviewProjection,
  MemoryOverviewProjectionSchema,
  type MemoryProjectionEnvelope,
  type MemoryStoreState,
} from "../schemas/memory-projections";
import type { MemoryFact, MemoryScope } from "../schemas/memory";
import type { MemoryEmbeddingIndex } from "./embeddings";
import type { EpisodicStore } from "./episodic";
import type { MemoryIndex } from "./fts-index";
import { discoverMemoryFacts, scopeRoot } from "./memory-store";

/** Every store the memory surface reads, plus the nullability that IS the absent state: a null here means this daemon never wired that store, which is a different answer from a wired store with no rows. */
export interface MemoryProjectionDeps {
  repoRoot: string;
  index: MemoryIndex | null;
  episodic: EpisodicStore | null;
  embeddings: MemoryEmbeddingIndex | null;
  embeddingState: () => string;
  config: MemoryConfigProjection;
}

export function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** rows === 0 on a store that exists is `empty`; the store not existing at all is the caller's `absent` and never reaches here. */
export function presentState(rows: number): MemoryStoreState {
  return rows === 0 ? "empty" : "ok";
}

export function withMemoryEnvelope<T extends object>(
  payload: T,
  now: Date = new Date(),
): T & MemoryProjectionEnvelope {
  return {
    ...payload,
    schemaVersion: MEMORY_PROJECTION_SCHEMA_VERSION,
    observedAt: now.toISOString(),
    sourceRevision: revisionOf(JSON.stringify(payload)),
    freshness: "live",
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// The layout `discoverMemoryFacts` walks. Kept as two joins off the exported scope root rather than a second copy of the traversal.
export const wikiDir = (repoRoot: string, scope: MemoryScope): string =>
  join(scopeRoot(repoRoot, scope), "wiki");
export const rawDir = (repoRoot: string, scope: MemoryScope): string =>
  join(scopeRoot(repoRoot, scope), "raw");

export async function wikiScopeExists(
  repoRoot: string,
  scope: MemoryScope,
): Promise<boolean> {
  return await directoryExists(wikiDir(repoRoot, scope));
}

export interface RawObservationRef {
  scope: MemoryScope;
  topic: string;
  id: string;
  path: string;
  date: string;
  bytes: number;
}

export async function listRawObservations(
  repoRoot: string,
  scope: MemoryScope,
): Promise<RawObservationRef[]> {
  const root = rawDir(repoRoot, scope);
  if (!(await directoryExists(root))) return [];
  const refs: RawObservationRef[] = [];
  for (const topicEntry of await readdir(root, { withFileTypes: true })) {
    if (!topicEntry.isDirectory()) continue;
    const topic = topicEntry.name;
    for (const entry of await readdir(join(root, topic), {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const stem = entry.name.slice(0, -3);
      refs.push({
        scope,
        topic,
        id: `${topic}/${stem}`,
        path: join("raw", topic, entry.name),
        date: stem.slice(0, 10),
        bytes: (await stat(join(root, topic, entry.name))).size,
      });
    }
  }
  return refs;
}

interface ScopeCorpus {
  scope: MemoryScope;
  exists: boolean;
  facts: MemoryFact[];
  rawObservations: number;
}

async function readScopeCorpus(
  repoRoot: string,
  scope: MemoryScope,
): Promise<ScopeCorpus> {
  const exists = await directoryExists(wikiDir(repoRoot, scope));
  return {
    scope,
    exists,
    facts: exists ? await discoverMemoryFacts(repoRoot, scope) : [],
    rawObservations: (await listRawObservations(repoRoot, scope)).length,
  };
}

function indexHealth(deps: MemoryProjectionDeps): MemoryIndexHealth {
  const ftsRows = deps.index === null ? null : deps.index.count();
  const vectorRows =
    deps.episodic === null || deps.embeddings === null
      ? null
      : deps.episodic.memoryEmbeddingCounts();
  return {
    fts: {
      state: ftsRows === null ? "absent" : presentState(ftsRows),
      articles: ftsRows ?? 0,
    },
    vectors: {
      state:
        vectorRows === null
          ? "absent"
          : presentState(vectorRows.articles + vectorRows.facts),
      articles: vectorRows?.articles ?? 0,
      facts: vectorRows?.facts ?? 0,
      provider: deps.config.embeddingProvider,
      model: deps.config.embeddingModel,
      runtime: deps.embeddingState(),
    },
  };
}

export async function buildMemoryOverview(
  deps: MemoryProjectionDeps,
  lastJobs: readonly MemoryJobReceipt[],
): Promise<MemoryOverviewProjection> {
  const corpora = await Promise.all([
    readScopeCorpus(deps.repoRoot, "repo"),
    readScopeCorpus(deps.repoRoot, "global"),
  ]);
  const scopes = corpora.map((corpus) => {
    const pitfalls = corpus.facts.filter((fact) => fact.kind === "pitfall");
    return {
      scope: corpus.scope,
      state: corpus.exists
        ? presentState(corpus.facts.length)
        : ("absent" as const),
      articles: corpus.facts.length,
      pitfalls: pitfalls.length,
      unverifiedPitfalls: pitfalls.filter(
        (fact) => fact.status === "unverified",
      ).length,
      rawObservations: corpus.rawObservations,
    };
  });
  const articles = scopes.reduce((sum, scope) => sum + scope.articles, 0);
  const indexes = indexHealth(deps);
  const episodicCounts =
    deps.episodic === null ? null : deps.episodic.rowCounts();

  const gaps: MemoryOverviewProjection["gaps"] = [];
  if (scopes.every((scope) => scope.state === "absent")) {
    gaps.push({
      code: "wiki-absent",
      detail:
        "no curated wiki exists in either scope on this daemon — nothing has " +
        "been written here, which is not the same as knowing it is empty",
    });
  }
  if (episodicCounts === null) {
    gaps.push({
      code: "episodic-absent",
      detail:
        "this daemon has no episodic store open, so events, facts, digests " +
        "and the wake high-water are unavailable rather than zero",
    });
  }
  const runtime = indexes.vectors.runtime;
  if (runtime !== "ready" && runtime !== "disabled") {
    gaps.push({
      code: "semantic-degraded",
      detail: `the embedding runtime reports "${runtime}" — recall is keyword-only until it recovers`,
    });
  }
  if (indexes.fts.state === "ok" && indexes.vectors.state === "empty") {
    gaps.push({
      code: "vectors-unbuilt",
      detail:
        "articles are keyword-indexed but no vectors are stored; paraphrase " +
        "recall will miss until a reindex embeds them",
    });
  }

  return MemoryOverviewProjectionSchema.parse(
    withMemoryEnvelope({
      wiki: {
        state: scopes.every((scope) => scope.state === "absent")
          ? "absent"
          : presentState(articles),
        articles,
        pitfalls: scopes.reduce((sum, scope) => sum + scope.pitfalls, 0),
        unverifiedPitfalls: scopes.reduce(
          (sum, scope) => sum + scope.unverifiedPitfalls,
          0,
        ),
        scopes,
      },
      episodic: {
        state:
          episodicCounts === null
            ? "absent"
            : presentState(
                episodicCounts.events +
                  episodicCounts.facts +
                  episodicCounts.digests,
              ),
        events: episodicCounts?.events ?? 0,
        facts: episodicCounts?.facts ?? 0,
        digests: episodicCounts?.digests ?? 0,
      },
      indexes,
      config: deps.config,
      lastJobs,
      gaps,
    }),
  );
}

export function buildMemoryMaintenance(
  deps: MemoryProjectionDeps,
  jobs: {
    state: MemoryStoreState;
    recent: readonly MemoryJobReceipt[];
  },
  consolidationCandidates: number | null,
): MemoryMaintenanceProjection {
  return MemoryMaintenanceProjectionSchema.parse(
    withMemoryEnvelope({
      config: deps.config,
      indexes: indexHealth(deps),
      consolidation: {
        state:
          consolidationCandidates === null
            ? "absent"
            : presentState(consolidationCandidates),
        candidates: consolidationCandidates ?? 0,
      },
      jobs: { state: jobs.state, recent: jobs.recent },
    }),
  );
}
