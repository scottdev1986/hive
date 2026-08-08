// A read-only preview of the exact bounded recall bundle Hive would produce. Two properties make this safe to point at a live daemon, and both are enforced here rather than promised in a comment: 1. It never touches the episodic store — it has no reference to one — so it cannot persist a per-agent mark. 2. It never treats an agent-authored trigger phrase as authority. Text like "note this: …" pasted into the query box is reported and then run as an ordinary search string. Executing it would hand the write path to whoever authored the text, which is precisely what the trigger protocol's authority check exists to prevent. The bundle itself and its budget arithmetic come from the same functions `memory_recall` calls, so the preview shows what an agent would actually receive rather than a second implementation that can drift.

import type { MemoryIndex } from "../memory-service/fts-index";
import { withMemoryEnvelope } from "../memory-service/projections";
import {
  buildMemoryRecallBundle,
  detectMemoryTrigger,
  MEMORY_RECALL_HINT_NOTE,
  type MemoryRecallRow,
  memoryRecallDegradedWarning,
  partitionMemoryRecall,
} from "../memory-service/recall";
import { MEMORY_RECALL_DEFAULT_BUDGET } from "./memory-tools";
import {
  type MemoryRecallPreview,
  MemoryRecallPreviewRequestSchema,
  MemoryRecallPreviewSchema,
  type MemoryRecallPurpose,
} from "../schemas/memory-projections";

export interface MemoryRecallPreviewDeps {
  repoRoot: string;
  index: MemoryIndex | null;
  semanticRecall: () =>
    | ((
        query: string,
        limit: number,
      ) => Promise<Array<{
        scope: string;
        id: string;
        score: number;
      }> | null>)
    | undefined;
  semanticRecallState: () => (() => string) | undefined;
  /** The daemon's configured wake budget, so a wake preview is bounded the way a real wake would be. */
  wakeBudgetTokens: number;
}

/** The ceiling the previewed purpose would really have run under. A wake bundle shown against the explicit-recall ceiling is a preview of something no agent will ever receive: the same corpus fits very differently into 300 tokens than into 800, and which rows fall off is the whole question being asked. Spawn and wake share the ceiling because they share the injection budget. */
function ceilingFor(
  purpose: MemoryRecallPurpose,
  wakeBudgetTokens: number,
): number {
  return purpose === "explicit-recall"
    ? MEMORY_RECALL_DEFAULT_BUDGET
    : wakeBudgetTokens;
}

export async function buildMemoryRecallPreview(
  deps: MemoryRecallPreviewDeps,
  request: { query: string; purpose?: MemoryRecallPurpose; budget?: number },
): Promise<MemoryRecallPreview> {
  const input = MemoryRecallPreviewRequestSchema.parse(request);
  const ceiling = ceilingFor(input.purpose, deps.wakeBudgetTokens);
  const budget = Math.min(input.budget ?? ceiling, ceiling);

  const bundle = await buildMemoryRecallBundle(input.query, {
    memory: deps.index,
    repoRoot: () => deps.repoRoot,
    semantic: deps.semanticRecall(),
    semanticStatus: deps.semanticRecallState(),
  });
  const fitted = partitionMemoryRecall(bundle, budget);

  const rows = [
    ...fitted.pitfalls.map((row) => ({ row, class: "pitfall" as const })),
    ...fitted.articles.map((row) => ({ row, class: "article" as const })),
  ].map(({ row, class: rowClass }, index) => previewRow(row, rowClass, index));

  const degraded = bundle.semantic.startsWith("degraded:");
  const trigger = detectMemoryTrigger(input.query);

  return MemoryRecallPreviewSchema.parse(
    withMemoryEnvelope({
      purpose: input.purpose,
      query: input.query,
      state: bundle.state,
      semantic: bundle.semantic,
      warning: degraded
        ? memoryRecallDegradedWarning(bundle.semantic.slice("degraded:".length))
        : null,
      note: MEMORY_RECALL_HINT_NOTE,
      budget,
      tokens: fitted.tokens,
      truncated: fitted.truncated,
      omitted: fitted.omitted,
      omittedPitfalls: fitted.omittedPitfalls,
      omittedArticles: fitted.omittedArticles,
      partitions: [
        {
          class: "pitfall",
          reservedTokens: fitted.pitfallReserve,
          usedTokens: fitted.pitfallTokens,
          kept: fitted.pitfalls.length,
          omitted: fitted.omittedPitfalls,
        },
        {
          class: "article",
          reservedTokens: fitted.articleReserve,
          usedTokens: fitted.articleTokens,
          kept: fitted.articles.length,
          omitted: fitted.omittedArticles,
        },
      ],
      rows,
      triggerPhrase:
        trigger === null
          ? null
          : { detected: trigger.kind, treatedAs: "literal-query" },
      mutation: "none",
      highWaterAdvanced: false,
    }),
  );
}

function previewRow(
  row: MemoryRecallRow,
  rowClass: "pitfall" | "article",
  index: number,
): MemoryRecallPreview["rows"][number] {
  return {
    rank: index + 1,
    class: rowClass,
    scope: row.scope,
    topic: row.topic,
    id: row.id,
    date: row.date,
    title: row.title,
    snippet: row.snippet,
    status: row.status,
    flag: row.flag,
  };
}
