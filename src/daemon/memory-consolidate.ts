// The offline consolidation dedup pass (HiveMemory HM-5, board #122; plan
// 2026-07-22-hivememory-epic-rework.md decision D1 layer 3): pairwise cosine
// over the vector store, bucketed at the ratified thresholds — ≥0.95 is an
// identical duplicate (recommend: keep newer, supersede older), 0.85–0.95 is
// similar (recommend: human review / Possibly-related link). This runs ONLY
// as an explicit offline pass, never inline in the write path.
//
// Report-first posture: without `apply` the pass changes nothing and exits
// successfully even with findings — it is a report, not a gate. With `apply`,
// ONLY the identical bucket is acted on, through the memory system's own
// write paths: wiki articles supersede the older into the newer via
// writeMemoryFact (supersedes chain, raw observations preserved, scope index
// and log stay consistent — append + superseded_by semantics, never merged
// bodies, per D1's pitfall rule applied to every article), episodic facts
// invalidate with a supersededBy pointer (the row stays; bi-temporal history
// is never destroyed). The similar bucket is NEVER auto-applied: false
// merges destroy information irreversibly, so the bias is toward duplicate
// bloat (D1).
//
// The pass needs the real semantic surface: rows missing from the vector
// store are embedded on demand via the embedding service, and when the
// service is UNAVAILABLE the pass fails with an honest error rather than
// silently reporting an empty scan.
import {
  discoverMemoryFacts,
  writeMemoryFact,
} from "../adapters/memory";
import type { MemoryFact } from "../schemas";
import type { EpisodicFact, EpisodicStore, MemoryEmbeddingRow } from "./episodic-store";
import {
  cosineSimilarity,
  MemoryEmbeddingIndex,
  type MemoryEmbeddingService,
} from "./memory-embeddings";

export const CONSOLIDATION_IDENTICAL_THRESHOLD = 0.95;
export const CONSOLIDATION_SIMILAR_THRESHOLD = 0.85;

export interface ConsolidationCandidate {
  kind: "article" | "fact";
  /** MemoryScope for articles; "" for facts (facts are project-local). */
  scope: string;
  olderId: string;
  newerId: string;
  olderTitle: string;
  newerTitle: string;
  /** Cosine similarity of the pair's stored vectors. */
  score: number;
}

export interface ConsolidationReport {
  /** Rows embedded on demand this run (missing or model-stale vectors). */
  embedded: number;
  /** Vector rows that went into the pairwise scan. */
  scanned: number;
  identical: ConsolidationCandidate[];
  similar: ConsolidationCandidate[];
  /** Identical pairs actually superseded (apply mode only). */
  applied: ConsolidationCandidate[];
  /** Identical pairs apply skipped (an endpoint was already superseded this
   * run) plus, in report mode, every identical pair. */
  skipped: ConsolidationCandidate[];
  /** Apply failures — a consolidation write that the normal write path
   * refused is a real error, surfaced nonzero by the CLI. */
  failures: string[];
}

interface ScannedSource {
  row: MemoryEmbeddingRow;
  title: string;
  /** Article date or fact createdAt — the newer/older ordering key. */
  recency: string;
}

// Pairwise within one kind+scope group only: a repo article and a global
// article are different scopes of authority and the write path cannot
// supersede across them, and an article never merges with an episodic fact.
// Rows of mixed vector width never compare (a model change mid-corpus would
// otherwise score nonsense cosine).
function candidatePairs(rows: ScannedSource[]): ConsolidationCandidate[] {
  const pairs: ConsolidationCandidate[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.row.dimensions !== b.row.dimensions) continue;
      const score = cosineSimilarity(a.row.vector, Array.from(b.row.vector));
      if (score < CONSOLIDATION_SIMILAR_THRESHOLD) continue;
      const [older, newer] = a.recency <= b.recency ? [a, b] : [b, a];
      pairs.push({
        kind: a.row.kind,
        scope: a.row.scope,
        olderId: older.row.sourceId,
        newerId: newer.row.sourceId,
        olderTitle: older.title,
        newerTitle: newer.title,
        score,
      });
    }
  }
  pairs.sort((x, y) =>
    y.score - x.score || x.olderId.localeCompare(y.olderId) ||
    x.newerId.localeCompare(y.newerId)
  );
  return pairs;
}

/** The count-only form the retention sweep surfaces (WP3 wiring): how many
 * stored-vector pairs sit at or above the similar threshold. Cheap by
 * contract — no embedding, no applying, just the drift signal in the sweep
 * report so a growing duplicate pile is visible in daemon logs. */
export function countConsolidationCandidates(episodic: EpisodicStore): number {
  const groups = new Map<string, MemoryEmbeddingRow[]>();
  for (const row of episodic.memoryEmbeddings()) {
    const key = `${row.kind}${row.scope}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  let count = 0;
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.dimensions !== b.dimensions) continue;
        if (
          cosineSimilarity(a.vector, Array.from(b.vector)) >=
            CONSOLIDATION_SIMILAR_THRESHOLD
        ) {
          count += 1;
        }
      }
    }
  }
  return count;
}

// The apply half for one wiki pair: re-issue the newer article through the
// normal write path with the older id in supersedes. Same id, same body, so
// this is not an "update" — the write appends a consolidation raw
// observation, inherits the superseded article's raw references, deletes the
// superseded article file, and rebuilds the scope index and log. Nothing is
// merged: the newer article's body stands verbatim.
async function applyArticlePair(
  repoRoot: string,
  candidate: ConsolidationCandidate,
  newer: MemoryFact,
): Promise<void> {
  await writeMemoryFact(repoRoot, {
    scope: newer.scope,
    id: newer.id,
    topic: newer.topic,
    title: newer.title,
    body: newer.body,
    tags: newer.tags,
    // Keep the article's own date: a consolidation is not a new observation
    // of the fact, and a verified article's verified date must not predate
    // the write's date.
    date: newer.date,
    // "legacy" is a read-side source the writer schema does not accept.
    source: newer.source === "legacy" ? "orchestrator" : newer.source,
    evidence:
      `Offline consolidation (hive memory consolidate --apply): identical ` +
      `duplicate ${candidate.olderId} superseded into this article ` +
      `(cosine ${candidate.score.toFixed(3)}).`,
    status: newer.status,
    kind: newer.kind,
    supersedes: [candidate.olderId],
    ...(newer.verified === undefined ? {} : { verified: newer.verified }),
  });
}

/**
 * The full pass. Throws when the semantic surface is unavailable — an empty
 * report would be indistinguishable from "no duplicates", so the honest
 * outcome is an error (the CLI exits nonzero).
 */
export async function runMemoryConsolidation(options: {
  repoRoot: string;
  episodic: EpisodicStore;
  service: MemoryEmbeddingService;
  apply?: boolean;
}): Promise<ConsolidationReport> {
  const { repoRoot, episodic, service } = options;
  const embedder = await service.embedder();
  if (embedder === null) {
    const status = service.status();
    throw new Error(
      `memory consolidation needs the semantic surface, which is ` +
        `unavailable: ${
          status.state === "unavailable" ? status.detail : "unknown error"
        }`,
    );
  }

  // Embed missing or model-stale rows on demand: every wiki article in both
  // scopes and every currently-believed episodic fact is a consolidation
  // subject. Existing rows from a different model re-embed so the scan never
  // mixes widths or model generations.
  const report: ConsolidationReport = {
    embedded: 0,
    scanned: 0,
    identical: [],
    similar: [],
    applied: [],
    skipped: [],
    failures: [],
  };
  const articles = new Map<string, MemoryFact>();
  const facts = new Map<string, EpisodicFact>();
  const existing = new Map(
    episodic.memoryEmbeddings().map((row) => [
      `${row.kind}${row.scope}${row.sourceId}`,
      row,
    ]),
  );
  const embedMissing = async (
    kind: "article" | "fact",
    scope: string,
    sourceId: string,
    text: string,
  ): Promise<void> => {
    const row = existing.get(`${kind}${scope}${sourceId}`);
    if (row !== undefined && row.model === embedder.model) return;
    const [vector] = await embedder.embed([text]);
    if (vector === undefined) {
      throw new Error(`embedder returned no vector for ${kind} ${sourceId}`);
    }
    episodic.upsertMemoryEmbedding({
      kind,
      scope,
      sourceId,
      model: embedder.model,
      vector: Float32Array.from(vector),
    });
    report.embedded += 1;
  };
  for (const scope of ["repo", "global"] as const) {
    for (const fact of await discoverMemoryFacts(repoRoot, scope)) {
      articles.set(`${scope}${fact.id}`, fact);
      await embedMissing(
        "article",
        scope,
        fact.id,
        MemoryEmbeddingIndex.articleText(fact),
      );
    }
  }
  for (const fact of episodic.currentFacts()) {
    facts.set(fact.id, fact);
    await embedMissing("fact", "", fact.id, MemoryEmbeddingIndex.factText(fact));
  }

  // Scan the rows whose source still exists (stale rows are prune's job, not
  // this pass's) grouped by kind+scope.
  const groups = new Map<string, ScannedSource[]>();
  for (const row of episodic.memoryEmbeddings()) {
    const source = row.kind === "article"
      ? articles.get(`${row.scope}${row.sourceId}`)
      : facts.get(row.sourceId);
    if (source === undefined || row.model !== embedder.model) continue;
    const key = `${row.kind}${row.scope}`;
    const scanned: ScannedSource = {
      row,
      title: source.title,
      recency: row.kind === "article"
        ? (source as MemoryFact).date
        : (source as EpisodicFact).createdAt,
    };
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [scanned]);
    else group.push(scanned);
    report.scanned += 1;
  }
  for (const group of groups.values()) {
    for (const pair of candidatePairs(group)) {
      if (pair.score >= CONSOLIDATION_IDENTICAL_THRESHOLD) {
        report.identical.push(pair);
      } else {
        report.similar.push(pair);
      }
    }
  }

  if (options.apply !== true) {
    report.skipped.push(...report.identical);
    return report;
  }

  // Apply: identical bucket only, one supersession per endpoint (a pair
  // whose older or newer was already consumed this run is skipped — chains
  // resolve one step per pass, never by guessing a merge order).
  const consumed = new Set<string>();
  for (const candidate of report.identical) {
    const key = `${candidate.kind}${candidate.scope}`;
    if (
      consumed.has(`${key}${candidate.olderId}`) ||
      consumed.has(`${key}${candidate.newerId}`)
    ) {
      report.skipped.push(candidate);
      continue;
    }
    try {
      if (candidate.kind === "article") {
        const newer = articles.get(`${candidate.scope}${candidate.newerId}`);
        if (newer === undefined) {
          throw new Error(`newer article ${candidate.newerId} not found`);
        }
        await applyArticlePair(repoRoot, candidate, newer);
      } else {
        const invalidated = episodic.invalidateFact(candidate.olderId, {
          supersededBy: candidate.newerId,
        });
        if (invalidated === null) {
          throw new Error(
            `older fact ${candidate.olderId} is not currently believed`,
          );
        }
      }
      // The superseded source is gone from the current corpus; its vector is
      // stale from this moment (prune would catch it later regardless).
      episodic.removeMemoryEmbedding(
        candidate.kind,
        candidate.scope,
        candidate.olderId,
      );
      consumed.add(`${key}${candidate.olderId}`);
      consumed.add(`${key}${candidate.newerId}`);
      report.applied.push(candidate);
    } catch (error) {
      report.failures.push(
        `${candidate.kind} ${candidate.olderId} → ${candidate.newerId}: ` +
          (error instanceof Error ? error.message : "unknown error"),
      );
      report.skipped.push(candidate);
    }
  }
  return report;
}
