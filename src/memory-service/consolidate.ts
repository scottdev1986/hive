import type { MemoryFact, MemoryWriteInput } from "../schemas/memory";
import { definedFields } from "../shared/defined-fields";
import {
  cosineSimilarity,
  MemoryEmbeddingIndex,
  type MemoryEmbeddingService,
} from "./embeddings";
import type { EpisodicStore, MemoryEmbeddingRow } from "./episodic";
import { discoverMemoryFacts, writeMemoryFact } from "./memory-store";

export const CONSOLIDATION_IDENTICAL_THRESHOLD = 0.95;
export const CONSOLIDATION_SIMILAR_THRESHOLD = 0.85;

export interface ConsolidationCandidate {
  kind: "article";
  scope: string;
  olderId: string;
  newerId: string;
  olderTitle: string;
  newerTitle: string;
  score: number;
}

export interface ConsolidationReport {
  /** Rows embedded in apply mode this run (missing or model-stale vectors). */
  embedded: number;
  scanned: number;
  identical: ConsolidationCandidate[];
  similar: ConsolidationCandidate[];
  applied: ConsolidationCandidate[];
  skipped: ConsolidationCandidate[];
  failures: string[];
}

interface ScannedSource {
  row: MemoryEmbeddingRow;
  title: string;
  recency: string;
}

// Pairwise within one kind+scope group only: a repo article and a global article are different scopes of authority and the write path cannot supersede across them, and an article never merges with an episodic fact. Rows of mixed vector width never compare (a model change mid-corpus would otherwise score nonsense cosine).
function candidatePairs(rows: ScannedSource[]): ConsolidationCandidate[] {
  const pairs: ConsolidationCandidate[] = [];
  for (const [i, a] of rows.entries()) {
    for (const b of rows.slice(i + 1)) {
      if (a.row.dimensions !== b.row.dimensions) continue;
      const score = cosineSimilarity(a.row.vector, Array.from(b.row.vector));
      if (score < CONSOLIDATION_SIMILAR_THRESHOLD) continue;
      const [older, newer] = a.recency <= b.recency ? [a, b] : [b, a];
      pairs.push({
        kind: "article",
        scope: a.row.scope,
        olderId: older.row.sourceId,
        newerId: newer.row.sourceId,
        olderTitle: older.title,
        newerTitle: newer.title,
        score,
      });
    }
  }
  pairs.sort(
    (x, y) =>
      y.score - x.score ||
      x.olderId.localeCompare(y.olderId) ||
      x.newerId.localeCompare(y.newerId),
  );
  return pairs;
}

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
    for (const [i, a] of group.entries()) {
      for (const b of group.slice(i + 1)) {
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

async function applyArticlePair(
  candidate: ConsolidationCandidate,
  newer: MemoryFact,
  writeArticle: (
    input: MemoryWriteInput,
  ) => Promise<{ scope: MemoryFact["scope"]; id: string }>,
): Promise<void> {
  await writeArticle({
    scope: newer.scope,
    id: newer.id,
    topic: newer.topic,
    title: newer.title,
    body: newer.body,
    tags: newer.tags,
    // Keep the article's own date: a consolidation is not a new observation of the fact, and a verified article's verified date must not predate the write's date.
    date: newer.date,
    source: newer.source === "legacy" ? "orchestrator" : newer.source,
    evidence:
      `Memory consolidation: identical ` +
      `duplicate ${candidate.olderId} superseded into this article ` +
      `(cosine ${candidate.score.toFixed(3)}).`,
    status: newer.status,
    kind: newer.kind,
    supersedes: [candidate.olderId],
    ...definedFields({ verified: newer.verified }),
  });
}

export async function runMemoryConsolidation(options: {
  repoRoot: string;
  episodic: EpisodicStore;
  service: MemoryEmbeddingService;
  apply?: boolean;
  /** A live daemon supplies its MemoryWriteService here so file, FTS and vector projections change together. With no daemon, the maintenance CLI has no in-process index and uses the file writer directly. */
  writeMemoryFact?: (
    input: MemoryWriteInput,
  ) => Promise<{ scope: MemoryFact["scope"]; id: string }>;
}): Promise<ConsolidationReport> {
  const { repoRoot, episodic, service } = options;
  const offline = options.writeMemoryFact === undefined;
  const writeArticle =
    options.writeMemoryFact ??
    ((input: MemoryWriteInput) => writeMemoryFact(repoRoot, input));
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

  // Apply mode embeds missing or model-stale rows before acting. Report mode only discovers sources and scans vectors already in the store.
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
  const existing = new Map(
    episodic
      .memoryEmbeddings()
      .map((row) => [`${row.kind}${row.scope}${row.sourceId}`, row]),
  );
  const embedMissing = async (
    kind: "article",
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
      if (options.apply === true) {
        await embedMissing(
          "article",
          scope,
          fact.id,
          MemoryEmbeddingIndex.articleText(fact),
        );
      }
    }
  }

  // Scan the rows whose source still exists (stale rows are prune's job, not this pass's) grouped by kind+scope.
  const groups = new Map<string, ScannedSource[]>();
  for (const row of episodic.memoryEmbeddings()) {
    if (row.kind !== "article") continue;
    const source = articles.get(`${row.scope}${row.sourceId}`);
    if (source === undefined || row.model !== embedder.model) continue;
    const key = `${row.kind}${row.scope}`;
    const scanned: ScannedSource = {
      row,
      title: source.title,
      recency: source.date,
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

  // Apply: identical bucket only, one supersession per endpoint (a pair whose older or newer was already consumed this run is skipped — chains resolve one step per pass, never by guessing a merge order).
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
      const newer = articles.get(`${candidate.scope}${candidate.newerId}`);
      if (newer === undefined) {
        throw new Error(`newer article ${candidate.newerId} not found`);
      }
      await applyArticlePair(candidate, newer, writeArticle);
      if (offline) {
        // The offline file writer has no projection service. The live daemon's writer already removed this row along with its FTS row.
        episodic.removeMemoryEmbedding(
          candidate.kind,
          candidate.scope,
          candidate.olderId,
        );
      }
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
