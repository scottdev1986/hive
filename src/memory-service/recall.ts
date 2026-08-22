import type { z } from "zod";
import type {
  MemoryRecallRowSchema,
  MemoryRecallSemanticSchema,
} from "../schemas/memory-projections";
import type { MemoryIndex } from "./fts-index";
import { estimateTokens } from "./query";
import { factVerificationFlag, listMemoryFacts } from "./memory-store";
import { selectMemoryClasses } from "./ranking";

// P0: detectMemoryTrigger preserved for preview UX only (literal-query detection)
// No daemon delivery execution.

export type MemoryTriggerKind = "recall" | "note" | "document";

export interface MemoryTrigger {
  kind: MemoryTriggerKind;
  payload: string;
}

const TRIGGER_PHRASES: ReadonlyArray<readonly [MemoryTriggerKind, string]> = [
  ["note", "note this"],
  ["document", "document this"],
  ["recall", "recall"],
];

export function detectMemoryTrigger(text: string): MemoryTrigger | null {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  for (const [kind, phrase] of TRIGGER_PHRASES) {
    if (!lower.startsWith(`${phrase}:`)) continue;
    const payload = trimmed.slice(phrase.length + 1).trim();
    if (payload.length === 0) return null;
    return { kind, payload };
  }
  return null;
}


export interface MemoryRecallRow {
  scope: string;
  topic: string;
  id: string;
  date: string;
  title: string;
  snippet: string;
  status: string;
  flag: string | null;
  pitfall: boolean;
}

export const MEMORY_RECALL_HINT_NOTE =
  "[unverified], [stale] and [conflicted] entries are hints to reconcile " +
  "before acting, not authority; pull the full article with " +
  "memory_read(scope, id).";

export interface MemoryRecallBundle {
  state: "ok" | "empty" | "absent";
  semantic: MemoryRecallSemantic;
  pitfalls: MemoryRecallRow[];
  articles: MemoryRecallRow[];
}

export type MemoryRecallSemantic = "hybrid" | "disabled" | `degraded:${string}`;

/** The loud line every degraded recall surface carries. Kept as a function of the state label so the trigger lane and the memory_recall tool render byte-identical wording. */
export function memoryRecallDegradedWarning(state: string): string {
  return `⚠ semantic search unavailable (${state}) — results are keyword-only`;
}

export function formatMemoryRecallRow(row: MemoryRecallRow): string {
  return (
    `- [${row.scope}/${row.topic}] ${row.id} (${row.date})` +
    (row.flag === null ? "" : ` [${row.flag}]`) +
    (row.pitfall ? " [pitfall]" : "") +
    `: ${row.title} — ${oneLine(row.snippet)}`
  );
}

/** Reciprocal-rank fusion blends the FTS and semantic legs. Fixed weights have no tuning knobs because embeddings buy paraphrase recall, not correctness. Both legs weigh equally; k=60 is the standard RRF constant from Cormack et al. 2009, dampening head-of-list dominance so a leg's #1 does not swamp the other leg entirely. */
const RECALL_RRF_K = 60;

/** How deep the rescue pass looks when one class is missing from the base pool. Used ONLY for that pass — never for the base pool, whose depth stays the caller's `limit` so ordinary recall returns exactly the rows it always has. Generous rather than tuned: the FTS index is local SQLite over a compiled wiki of at most a few hundred articles, so a second scan costs nothing worth optimizing. The ceiling exists only so a pathological corpus cannot turn one recall into unbounded work. */
const RECALL_CANDIDATE_CEILING = 200;

export interface MemoryRecallDeps {
  repoRoot: () => string;
  /** The daemon's FTS index over the wiki; null degrades recall to an honest "surface absent" block. */
  memory: Pick<MemoryIndex, "search"> | null;
  /** The semantic leg: cosine top-k over the vector store, or null when embeddings are unavailable. Undefined degrades to the FTS-only bundle. */
  semantic?: (
    query: string,
    limit: number,
  ) => Promise<Array<{
    scope: string;
    id: string;
    score: number;
  }> | null>;
  /** The semantic leg's one-word state, consulted when the leg answered null so the recall envelope can name WHY it is FTS-only (degraded:embedding-runtime-missing, not a silent keyword-only result). */
  semanticStatus?: () => string;
}

/** Search the wiki for `query` and partition the hits into the pitfall class and ordinary articles, each row carrying its verification label. The FTS row carries no kind, so kinds resolve from the on-disk articles (the same pattern as memory_query pitfall-check). When deps.semantic is wired and answers (non-null), its cosine top-k is RRF-blended with the FTS ranking — a paraphrase the porter tokenizer cannot match still ranks. When the semantic leg is absent or unavailable (null), the bundle's ROWS are byte-identical to the FTS-only output — a test pins this — while the envelope's `semantic` field says out loud that the leg did not run, and why. */
export async function buildMemoryRecallBundle(
  query: string,
  deps: MemoryRecallDeps,
  limit = 8,
): Promise<MemoryRecallBundle> {
  // The envelope discriminator names what the semantic leg contributed, so "FTS-only because embeddings are down" is never indistinguishable from a genuine keyword-only result. In the absent state nothing was searched at all; the field then reports the leg's wiring/health, not a search outcome.
  const degradedSemantic = (): MemoryRecallSemantic => {
    if (deps.semantic === undefined) return "disabled";
    const label = deps.semanticStatus?.() ?? "unavailable";
    return label === "disabled" ? "disabled" : `degraded:${label}`;
  };
  if (deps.memory === null) {
    return {
      state: "absent",
      semantic: degradedSemantic(),
      pitfalls: [],
      articles: [],
    };
  }
  const hits = deps.memory.search(query, { limit });
  const semantic =
    deps.semantic === undefined ? null : await deps.semantic(query, limit);
  if (semantic === null && hits.length === 0) {
    return {
      state: "empty",
      semantic: degradedSemantic(),
      pitfalls: [],
      articles: [],
    };
  }
  const facts = await listMemoryFacts(deps.repoRoot());
  const factByKey = new Map<string, (typeof facts)[number]>(
    facts.map((fact) => [`${fact.scope}:${fact.id}`, fact]),
  );
  const statusByKey = new Map<string, string | null>(
    facts.map(
      (fact) =>
        [`${fact.scope}:${fact.id}`, factVerificationFlag(fact)] as const,
    ),
  );
  const pitfallKeys = new Set<string>(
    facts
      .filter((fact) => fact.kind === "pitfall")
      .map((fact) => `${fact.scope}:${fact.id}`),
  );
  const toRow = (hit: {
    scope: string;
    topic: string;
    id: string;
    date: string;
    title: string;
    snippet: string;
    status: string;
  }): MemoryRecallRow => ({
    scope: hit.scope,
    topic: hit.topic,
    id: hit.id,
    date: hit.date,
    title: hit.title,
    snippet: hit.snippet,
    status: hit.status,
    flag:
      statusByKey.get(`${hit.scope}:${hit.id}`) ??
      (hit.status === "verified" ? null : hit.status),
    pitfall: pitfallKeys.has(`${hit.scope}:${hit.id}`),
  });
  const poolRows = async (poolLimit: number): Promise<MemoryRecallRow[]> => {
    const ftsHits =
      poolLimit === limit
        ? hits
        : (deps.memory?.search(query, { limit: poolLimit }) ?? []);
    if (semantic === null) return ftsHits.map(toRow);
    const semanticHits =
      poolLimit === limit
        ? semantic
        : ((await deps.semantic?.(query, poolLimit)) ?? semantic);
    const fused = new Map<string, { score: number; fts: number }>();
    ftsHits.forEach((hit, rank) => {
      fused.set(`${hit.scope}:${hit.id}`, {
        score: 1 / (RECALL_RRF_K + rank + 1),
        fts: rank,
      });
    });
    semanticHits.forEach((hit, rank) => {
      const key = `${hit.scope}:${hit.id}`;
      const entry = fused.get(key);
      if (entry === undefined) {
        fused.set(key, { score: 1 / (RECALL_RRF_K + rank + 1), fts: -1 });
      } else {
        entry.score += 1 / (RECALL_RRF_K + rank + 1);
      }
    });
    const ordered = [...fused.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, poolLimit);
    return ordered.flatMap(([key, entry]): MemoryRecallRow[] => {
      const ftsHit = entry.fts >= 0 ? ftsHits[entry.fts] : undefined;
      if (ftsHit !== undefined) return [toRow(ftsHit)];
      // A semantic-only hit: hydrate the row from the on-disk article. Gone from disk (a stale vector row not yet pruned) means no row at all.
      const fact = factByKey.get(key);
      if (fact === undefined) return [];
      return [
        toRow({
          scope: fact.scope,
          topic: fact.topic,
          id: fact.id,
          date: fact.date,
          title: fact.title,
          snippet: oneLine(fact.body).slice(0, 160),
          status: fact.status,
        }),
      ];
    });
  };

  // The base pool is the ranked top `limit`, unchanged: FTS-only keeps the same hits, order and rows it always did, and the hybrid path fuses and caps exactly as before. Whatever both classes get here is what recall has always returned.
  const base = await poolRows(limit);
  if (base.length === 0 && semantic !== null) {
    // Both legs answered and neither matched — the honest empty result, same as the FTS-only path reports.
    return { state: "empty", semantic: "hybrid", pitfalls: [], articles: [] };
  }
  let selected = selectMemoryClasses(base, base, limit, (row) => row.pitfall);

  // A class missing from the ranked pool cannot claim its reserved budget. The shared selector widens only that absent class and leaves the other one exactly as ranked.
  if (selected.pitfalls.length === 0 || selected.articles.length === 0) {
    const deep = await poolRows(RECALL_CANDIDATE_CEILING);
    selected = selectMemoryClasses(base, deep, limit, (row) => row.pitfall);
  }
  return {
    state: "ok",
    semantic: semantic === null ? degradedSemantic() : "hybrid",
    pitfalls: selected.pitfalls,
    articles: selected.articles,
  };
}

export interface MemoryRecallPartitionResult {
  pitfalls: MemoryRecallRow[];
  articles: MemoryRecallRow[];
  /** Reserve each class was guaranteed before the other could bid for it. */
  pitfallReserve: number;
  articleReserve: number;
  pitfallTokens: number;
  articleTokens: number;
  tokens: number;
  truncated: boolean;
  omitted: number;
  omittedPitfalls: number;
  omittedArticles: number;
}

/** Fit a recall bundle into a token budget. The bundle is PARTITIONED, not merely prioritized. Taking pitfalls first and giving articles the remainder is a priority ordering, and it starves: a corpus that is mostly pitfalls fills the whole ceiling with them and a rank-1 semantic-only article becomes unreachable. Each class is bounded to a reserved share instead, and whatever one side leaves unused is reallocated to the other so a corpus with few pitfalls wastes none of its budget. Articles claim their reserved share first — that claim is the whole anti-starvation guarantee. Pitfalls then take everything else, so the mistake class keeps its priority over the unreserved remainder (and wins outright when the budget is too small for both). Finally articles reclaim whatever pitfalls could not use. The memory_recall tool and the read-only recall preview both call this, so the preview shows the bundle an agent would actually receive rather than a second implementation of the same arithmetic that can drift away from it. */
export function partitionMemoryRecall(
  bundle: Pick<MemoryRecallBundle, "pitfalls" | "articles">,
  budget: number,
): MemoryRecallPartitionResult {
  const fill = (rows: readonly MemoryRecallRow[], ceiling: number) => {
    const kept: MemoryRecallRow[] = [];
    let used = 0;
    for (const row of rows) {
      const cost = estimateTokens(row);
      if (used + cost > ceiling) continue;
      used += cost;
      kept.push(row);
    }
    return { kept, tokens: used };
  };
  const articleReserve = Math.floor(budget / 2);
  const reservedArticles = fill(bundle.articles, articleReserve);
  const pitfallReserve = budget - reservedArticles.tokens;
  const pitfallFill = fill(bundle.pitfalls, pitfallReserve);
  const articleFill = fill(bundle.articles, budget - pitfallFill.tokens);
  const omittedPitfalls = bundle.pitfalls.length - pitfallFill.kept.length;
  const omittedArticles = bundle.articles.length - articleFill.kept.length;
  const omitted = omittedPitfalls + omittedArticles;
  return {
    pitfalls: pitfallFill.kept,
    articles: articleFill.kept,
    pitfallReserve,
    articleReserve,
    pitfallTokens: pitfallFill.tokens,
    articleTokens: articleFill.tokens,
    tokens: pitfallFill.tokens + articleFill.tokens,
    truncated: omitted > 0,
    omitted,
    omittedPitfalls,
    omittedArticles,
  };
}

// P0: Deleted executeRecall, executeWrite, writeTriggerArticle, deriveTopic, SYSTEM_NOTE
// These were only used by the deleted executeMemoryTrigger.

type Assert<T extends true> = T;
type Equals<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;

true satisfies Assert<
  Equals<z.infer<typeof MemoryRecallRowSchema>, MemoryRecallRow>
>;
true satisfies Assert<
  Equals<z.infer<typeof MemoryRecallSemanticSchema>, MemoryRecallSemantic>
>;
