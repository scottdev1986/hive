import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { Action, Capability } from "./capabilities";
import type { HiveDatabase } from "./db";
import { MemoryDigestInputSchema, runMemoryDigest } from "./episodic-digest";
import {
  estimateTokens,
  MemoryQueryInputSchema,
  runMemoryQuery,
} from "./episodic-projections";
import type { EpisodicStore } from "./episodic-store";
import {
  MemoryEmbeddingIndex,
  type MemoryEmbeddingWriteOutcome,
} from "./memory-embeddings";
import { findSimilarMemoryCandidates, type MemoryIndex } from "./memory-index";
import {
  promotionProvenanceBlock,
  promotionSource,
  scanPromotionRedaction,
} from "./memory-promote";
import {
  buildMemoryRecallBundle,
  MEMORY_RECALL_HINT_NOTE,
  memoryRecallDegradedWarning,
} from "./memory-triggers";
import { projectHiveUuid } from "./project-state";
import type { StatusStore } from "./status-store";
import { toolResult } from "./tool-result";
import type { TokenUsageStore } from "./token-usage";
import {
  listMemoryFacts,
  type MemoryWriteFileResult,
  normalizeTitle,
  readMemoryFact,
} from "../adapters/memory";
import {
  compactMemoryWriteResult,
  type MemoryFact,
  type MemoryScope,
  MemoryScopeSchema,
  type MemoryWriteInput,
  MemoryWriteInputSchema,
} from "../schemas";

export const MemoryIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "memory id must be a filename stem: alphanumeric start, then [a-z0-9._-]",
  );

export const MemorySearchRequestSchema = z.object({
  query: z.string().min(1),
  scope: MemoryScopeSchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export const MemoryFactRequestSchema = z.object({
  scope: MemoryScopeSchema,
  id: MemoryIdSchema,
});

export const MemoryWriteRequestSchema = MemoryWriteInputSchema.safeExtend({
  id: MemoryIdSchema.optional(),
});

export const MemoryPitfallRequestSchema = z.object({
  action: z.enum(["search", "get"]),
  query: z.string().min(1).optional(),
  scope: MemoryScopeSchema.optional(),
  id: MemoryIdSchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export const MemoryNoteRequestSchema = z.object({
  topic: z.string().min(1).max(120),
  title: z.string().min(1),
  body: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  validAt: z.iso.datetime({ offset: true }).optional(),
});

export const MemoryRecallRequestSchema = z.object({
  query: z.string().min(1),
  budget: z.number().int().positive().optional(),
});

export const MEMORY_RECALL_DEFAULT_BUDGET = 800;

export const MemoryPromoteRequestSchema = z.object({
  id: MemoryIdSchema,
});

/**
 * What the memory tool surface reaches for, named explicitly.
 *
 * First tool-group extraction out of `createMcpServer` (audit §11). The group
 * boundary is the right one: these eleven tools share a store, an index and a
 * repo root, and nothing else in the 34-tool surface touches them.
 *
 * `rebuildMemoryIndex` is typed as returning `unknown` because its result is
 * only ever handed to `toolResult`, which takes `unknown` — importing the
 * daemon's inferred shape would buy nothing and create a cycle.
 */
export interface MemoryToolDeps {
  db: HiveDatabase;
  repoRoot: string;
  memory: MemoryIndex;
  embeddingIndex: MemoryEmbeddingIndex | null;
  episodic: EpisodicStore | null;
  status: StatusStore;
  tokenUsage: TokenUsageStore;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  writeMemoryFact: (
    input: MemoryWriteInput,
  ) => Promise<
    MemoryWriteFileResult & { embedding: MemoryEmbeddingWriteOutcome }
  >;
  deleteMemoryFact: (scope: MemoryScope, id: string) => Promise<boolean>;
  rebuildMemoryIndex: () => Promise<unknown>;
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
}

export function registerMemoryTools(
  server: McpServer,
  capability: Capability,
  deps: MemoryToolDeps,
): void {
  server.registerTool(
    "memory_search",
    {
      title: "Search Hive memory",
      description:
        'Full-text search compiled memory articles across repo (".hive/memory/wiki/") and global ("~/.hive/memory/wiki/") scope. Raw observations are immutable evidence and are not search results. Returns short snippets only; pull a full article with memory_read before relying on it.',
      inputSchema: MemorySearchRequestSchema,
    },
    async ({ query, scope, limit }) => {
      deps.authorizeTool(
        capability,
        "memory_search",
        "memory:read",
        undefined,
        false,
      );
      return toolResult(deps.memory.search(query, { scope, limit }), "results");
    },
  );

  server.registerTool(
    "memory_write",
    {
      title: "Write a Hive memory observation and article",
      description:
        "Record one immutable raw observation and create or update its compiled memory article. The schema is enforced here: topic, source provenance, evidence, verification status, and supersedes relationships are required. Search first; update a matching id instead of adding a duplicate. A normalized-title duplicate under a different id is rejected — re-issue as an update to the id named in the error (id set, supersedes including it). A successful write may return similarCandidates: near-duplicate articles to resolve with a follow-up update or merge. The response's embedding field reports what happened to this write's vector projection: indexed, queued (projection running in the background), or unavailable:<state> (keyword-searchable only). For a correction, pass the corrected article id in supersedes, make body state current truth, and preserve prior reasoning through the raw history. status=verified requires verified=YYYY-MM-DD; conflicted means the article must describe the unresolved disagreement. Repo scope lives under .hive/memory/{raw,wiki}; global under ~/.hive/memory/{raw,wiki}. Writes are serialized, rebuild wiki/index.md, append wiki/log.md, and immediately update compiled-article search.",
      inputSchema: MemoryWriteRequestSchema,
    },
    async (input) => {
      deps.authorizeTool(capability, "memory_write", "memory:write");
      const written = await deps.writeMemoryFact(input);
      // Dedup layer 2 (HiveMemory plan D1): advisory candidates over the
      // index writeMemoryFact just upserted.
      const similarCandidates = findSimilarMemoryCandidates(
        deps.memory,
        written,
      );
      const [reportedPath, reportedRawPath] = await Promise.all([
        realpath(written.path),
        realpath(written.rawPath),
      ]);
      return toolResult(
        {
          ...compactMemoryWriteResult(
            { ...written, path: reportedPath },
            reportedRawPath,
            similarCandidates,
          ),
          // Defect D2: what actually happened to this write's vector
          // projection — "indexed", "queued", or "unavailable:<state>".
          embedding: written.embedding,
        },
        "fact",
      );
    },
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a compiled Hive memory article",
      description:
        "Read one compiled memory article by scope and id, as referenced by the injected wiki index or memory_search. The result includes topic, evidence, verification status, supersedes relationships, and links to immutable raw observations. Reconcile unverified, stale, or conflicted knowledge before acting.",
      inputSchema: MemoryFactRequestSchema,
    },
    async ({ scope, id }) => {
      deps.authorizeTool(
        capability,
        "memory_read",
        "memory:read",
        undefined,
        false,
      );
      const fact = await readMemoryFact(deps.repoRoot, scope, id);
      if (fact === null) {
        throw new Error(`Memory fact not found: [${scope}] ${id}`);
      }
      return toolResult(fact, "fact");
    },
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete a compiled Hive memory article",
      description:
        "Delete one compiled article and remove it from the index. Refused while another article still lists this id in supersedes — update or delete the referencing article first. Immutable raw observations remain as audit evidence.",
      inputSchema: MemoryFactRequestSchema,
    },
    async ({ scope, id }) => {
      deps.authorizeTool(capability, "memory_delete", "memory:delete");
      return toolResult(
        { deleted: await deps.deleteMemoryFact(scope, id) },
        "result",
      );
    },
  );

  server.registerTool(
    "memory_reindex",
    {
      title: "Rebuild the Hive memory search index",
      description:
        "Non-destructively migrate legacy flat facts, rebuild each scope's wiki/index.md, and rebuild disposable SQLite FTS from compiled wiki articles. The first migration backs up the complete scope before writing, preserves every flat source, and returns the backup path; later rebuilds detect the completion marker and do not migrate again.",
      inputSchema: z.object({}),
    },
    async () => {
      deps.authorizeTool(capability, "memory_reindex", "memory:write");
      return toolResult(await deps.rebuildMemoryIndex(), "result");
    },
  );

  // The L0/L1 read side of the episodic store (HiveMemory HM-1 WP2). One
  // tool, declared classes, server-enforced per-class token ceilings with
  // loud in-band truncation, and scoping derived from the caller's
  // capability identity and the daemon's own project — there is no project
  // parameter at all.
  server.registerTool(
    "memory_query",
    {
      title: "Query Hive episodic memory",
      description:
        "Answer bounded questions against this project's episodic memory: agent-now / agent-history (agent name), fleet-summary, what-landed (optional since), who-blocked, token-spend (optional agent/since), point-search (query: FTS over episodic events and facts, bounded snippets), my-history (your own event history — scoped to your identity, any agent field is ignored), pitfall-check (query: search pitfall-class wiki articles relevant to your current task). Every class has a server-enforced token ceiling; budget may only lower it. Over-budget results come back truncated with truncated:true and an omitted count. The envelope state distinguishes ok, empty (surface built, no matches), and absent (surface not built). Rows carry their own source and asOf freshness labels — treat them as leads to verify, not authority.",
      inputSchema: MemoryQueryInputSchema,
    },
    async (input) => {
      deps.authorizeTool(
        capability,
        "memory_query",
        "memory:read",
        undefined,
        false,
      );
      const result = await runMemoryQuery(
        {
          episodic: deps.episodic,
          status: deps.status,
          tokenUsage: deps.tokenUsage,
          memory: deps.memory,
          repoRoot: deps.repoRoot,
          resolveAgentId: (name) => deps.db.getAgentByName(name)?.id ?? null,
        },
        { subject: capability.subject },
        input,
      );
      return toolResult(result, "result");
    },
  );

  // The L2 read side of the episodic store (HiveMemory HM-2 WP4): session
  // digests with drill-down. The digest is a hint-not-authority navigation
  // aid compiled deterministically from the typed record; the eventId
  // drill-down is the hint-to-authority path to the exact source rows.
  server.registerTool(
    "memory_digest",
    {
      title: "Read a Hive session digest",
      description:
        "Read a compiled session digest from this project's episodic memory: by digestId, or by agent name (optionally pinned to a sessionId; the newest digest wins). The digest is a navigation aid labeled hint-not-authority — every load-bearing line carries an [eN] event-id pointer, and exact values (SHAs, paths, error strings, exit codes) sit in a typed side table. Pass eventId to drill down to the exact source event row(s) behind a pointer before acting on any claim. The envelope state distinguishes ok, empty (store open, no match), and absent (episodic store not open). Server-enforced token ceiling: budget may only lower it; an over-budget body is cut with a loud truncation marker.",
      inputSchema: MemoryDigestInputSchema,
    },
    async (input) => {
      deps.authorizeTool(
        capability,
        "memory_digest",
        "memory:read",
        undefined,
        false,
      );
      const result = runMemoryDigest(
        {
          episodic: deps.episodic,
          resolveAgentId: (name) => deps.db.getAgentByName(name)?.id ?? null,
        },
        input,
      );
      return toolResult(result, "result");
    },
  );

  // The focused pitfall surface (HiveMemory HM-2 WP5): the mistake-harvest
  // read path. Pitfall-kind articles only — an agent checking "has anyone
  // burned themselves here before" never wades through the whole wiki.
  // search with no query lists every pitfall (optionally scope-filtered);
  // search with a query runs the same FTS memory_search uses, filtered to
  // pitfalls; get reads one article and refuses a non-pitfall id. Every
  // row carries its verification status — unverified is a hint, not
  // authority, everywhere it appears.
  server.registerTool(
    "memory_pitfall",
    {
      title: "Search and read Hive pitfall memory",
      description:
        "List, search, or read pitfall-kind memory articles — the 'we burned ourselves before' class, including unverified harvest candidates from session boundaries. action=search with a query runs full-text search filtered to pitfalls; with no query it lists every pitfall article (optionally scope-filtered). action=get reads one article by scope+id and refuses non-pitfall ids. Every result carries its verification status: unverified is a harvested claim to reconcile before acting, never authority.",
      inputSchema: MemoryPitfallRequestSchema,
    },
    async ({ action, query, scope, id, limit }) => {
      deps.authorizeTool(
        capability,
        "memory_pitfall",
        "memory:read",
        undefined,
        false,
      );
      if (action === "get") {
        if (scope === undefined || id === undefined) {
          throw new Error("memory_pitfall action=get requires scope and id");
        }
        const fact = await readMemoryFact(deps.repoRoot, scope, id);
        if (fact === null) {
          throw new Error(`Memory pitfall not found: [${scope}] ${id}`);
        }
        if (fact.kind !== "pitfall") {
          throw new Error(
            `Memory article [${scope}] ${id} is kind "${fact.kind}", not a pitfall`,
          );
        }
        return toolResult(fact, "fact");
      }
      const facts = await listMemoryFacts(deps.repoRoot);
      const pitfalls = facts.filter(
        (fact) =>
          fact.kind === "pitfall" &&
          (scope === undefined || fact.scope === scope),
      );
      if (query === undefined) {
        return toolResult(
          {
            state: pitfalls.length === 0 ? "empty" : "ok",
            pitfalls: pitfalls.map((fact) => ({
              scope: fact.scope,
              id: fact.id,
              topic: fact.topic,
              title: fact.title,
              status: fact.status,
              date: fact.date,
            })),
          },
          "results",
        );
      }
      const ids = new Set(pitfalls.map((fact) => `${fact.scope}:${fact.id}`));
      const hits = deps.memory
        .search(query, {
          ...(scope === undefined ? {} : { scope }),
          limit: limit ?? 10,
        })
        .filter((hit) => ids.has(`${hit.scope}:${hit.id}`));
      return toolResult(
        {
          state: hits.length === 0 ? "empty" : "ok",
          pitfalls: hits.map((hit) => ({
            scope: hit.scope,
            id: hit.id,
            topic: hit.topic,
            title: hit.title,
            status: hit.status,
            date: hit.date,
            snippet: hit.snippet,
          })),
        },
        "results",
      );
    },
  );

  // The remaining HiveMemory plan §5 surface: episodic note writes, the
  // trigger protocol's recall bundle as a tool, and D3 cross-scope pitfall
  // promotion.
  server.registerTool(
    "memory_note",
    {
      title: "Record a Hive episodic memory note",
      description:
        "Record a lightweight fact in this project's episodic memory — the bi-temporal store agents and the queen share, not the curated wiki. Source is your own identity. Dedup is enforced: if a currently-believed fact with the same normalized title exists, the write is REFUSED and the existing fact's id and body are returned — to correct a belief, invalidate the named fact and record its replacement (the store is bi-temporal: never delete, supersede). The response's embedding field reports what happened to this note's vector projection: indexed, queued, or unavailable:<state> (keyword-searchable only). For durable curated knowledge use memory_write instead.",
      inputSchema: MemoryNoteRequestSchema,
    },
    async (input) => {
      deps.authorizeTool(capability, "memory_note", "memory:write");
      if (deps.episodic === null) {
        return toolResult(
          {
            state: "absent",
            detail: "episodic store is not open on this daemon",
          },
          "result",
        );
      }
      // Dedup layer 1 for the episodic layer (HiveMemory plan D1): the same
      // normalized-title contract the wiki write path enforces. A duplicate
      // is refused with the existing row, because the contradiction path is
      // invalidate-and-supersede, never a silent second current belief.
      const duplicate = deps.episodic
        .currentFacts()
        .find(
          (fact) => normalizeTitle(fact.title) === normalizeTitle(input.title),
        );
      if (duplicate !== undefined) {
        return toolResult(
          {
            state: "duplicate",
            detail:
              "a currently-believed fact with this normalized title already " +
              "exists — nothing was recorded. To correct it, invalidate the " +
              "existing fact and record the replacement as its superseder.",
            existing: {
              id: duplicate.id,
              title: duplicate.title,
              body: duplicate.body,
              validAt: duplicate.validAt,
            },
          },
          "result",
        );
      }
      const fact = deps.episodic.recordFact({
        kind: "fact",
        topic: input.topic,
        title: input.title,
        body: input.body,
        source: capability.subject,
        ...(input.confidence === undefined
          ? {}
          : { confidence: input.confidence }),
        ...(input.validAt === undefined ? {} : { validAt: input.validAt }),
      });
      // Semantic-leg index maintenance (HM-5): failure-isolated, and a later
      // invalidate is covered by the prune pass on the rebuild boundary —
      // only currently-believed facts stay indexed. The outcome rides the
      // response (defect D2).
      const embedding: MemoryEmbeddingWriteOutcome =
        deps.embeddingIndex === null
          ? "unavailable:disabled"
          : await deps.embeddingIndex.upsertFact(
              fact.id,
              MemoryEmbeddingIndex.factText(fact),
            );
      return toolResult(
        {
          state: "recorded",
          embedding,
          fact: {
            id: fact.id,
            kind: fact.kind,
            topic: fact.topic,
            title: fact.title,
            source: fact.source,
            confidence: fact.confidence,
            validAt: fact.validAt,
          },
        },
        "fact",
      );
    },
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Recall ranked Hive memory for a query",
      description:
        "The ranked recall bundle the trigger protocol produces, as a tool: wiki search partitioned into pitfalls (the highest-priority class) and articles, every row carrying its verification label. Retrieval is hybrid: full-text search blended (reciprocal-rank) with local embedding similarity when the daemon's semantic leg is available, FTS-only otherwise. The envelope state distinguishes ok, empty (searched, no matches), and absent (no wiki search index wired). Server-enforced token ceiling: budget may only lower it. The ceiling is partitioned so neither class can starve the other — each is bounded to a reserved share and unused capacity is reallocated to the other side. Over-budget bundles come back with truncated:true, an omitted count, and omittedPitfalls/omittedArticles naming which side was cut. Rows are leads to reconcile, not authority — pull the full article with memory_read(scope, id) before relying on one.",
      inputSchema: MemoryRecallRequestSchema,
    },
    async ({ query, budget }) => {
      deps.authorizeTool(
        capability,
        "memory_recall",
        "memory:read",
        undefined,
        false,
      );
      const bundle = await buildMemoryRecallBundle(query, {
        memory: deps.memory,
        repoRoot: () => deps.repoRoot,
        semantic: deps.semanticRecall(),
        semanticStatus: deps.semanticRecallState(),
      });
      const ceiling = MEMORY_RECALL_DEFAULT_BUDGET;
      const effective = Math.min(budget ?? ceiling, ceiling);
      // The bundle is PARTITIONED, not merely prioritized (plan §3). Taking
      // pitfalls first and giving articles the remainder is a priority
      // ordering, and it starves: a corpus that is mostly pitfalls fills the
      // whole ceiling with them and a rank-1 semantic-only article becomes
      // unreachable. Each class is bounded to a reserved share instead, and
      // whatever one side leaves unused is reallocated to the other so a
      // corpus with few pitfalls wastes none of its budget.
      const fill = (
        rows: readonly (typeof bundle.pitfalls)[number][],
        budget: number,
      ): { kept: (typeof bundle.pitfalls)[number][]; tokens: number } => {
        const kept: (typeof bundle.pitfalls)[number][] = [];
        let used = 0;
        for (const row of rows) {
          const cost = estimateTokens(row);
          if (used + cost > budget) continue;
          used += cost;
          kept.push(row);
        }
        return { kept, tokens: used };
      };
      // Articles claim their reserved share first — that claim is the whole
      // anti-starvation guarantee. Pitfalls then take everything else, so
      // the mistake class keeps its priority over the unreserved remainder
      // (and wins outright when the budget is too small for both). Finally
      // articles reclaim whatever pitfalls could not use.
      const articleReserve = Math.floor(effective / 2);
      const reservedArticles = fill(bundle.articles, articleReserve);
      const pitfallFill = fill(
        bundle.pitfalls,
        effective - reservedArticles.tokens,
      );
      const articleFill = fill(bundle.articles, effective - pitfallFill.tokens);
      const keptPitfalls = pitfallFill.kept;
      const keptArticles = articleFill.kept;
      const tokens = pitfallFill.tokens + articleFill.tokens;
      const omittedPitfalls = bundle.pitfalls.length - keptPitfalls.length;
      const omittedArticles = bundle.articles.length - keptArticles.length;
      const omitted = omittedPitfalls + omittedArticles;
      // Defect D2: the envelope discriminates hybrid / degraded:<state> /
      // disabled so FTS-only-because-embeddings-are-down is never
      // indistinguishable from a genuine keyword-only result. The warning is
      // envelope-level (field + note block), never a row — budget clamping
      // cannot cut it.
      const degraded = bundle.semantic.startsWith("degraded:");
      const warning = degraded
        ? memoryRecallDegradedWarning(bundle.semantic.slice("degraded:".length))
        : null;
      return toolResult(
        {
          state: bundle.state,
          semantic: bundle.semantic,
          ...(warning === null ? {} : { warning }),
          detail:
            bundle.state === "absent"
              ? "this daemon has no wiki search index wired"
              : bundle.state === "empty"
                ? `the wiki was searched and nothing matched "${query}"`
                : null,
          note: MEMORY_RECALL_HINT_NOTE,
          budget: effective,
          tokens,
          truncated: omitted > 0,
          omitted,
          omittedPitfalls,
          omittedArticles,
          pitfalls: keptPitfalls,
          articles: keptArticles,
        },
        "results",
        warning,
      );
    },
  );

  server.registerTool(
    "memory_promote",
    {
      title: "Promote a repo pitfall to global Hive memory",
      description:
        "Copy one REPO-scope pitfall article into the global wiki as a new article — the only way memory crosses a project boundary (HiveMemory plan D3). Queen/operator only. The copy keeps kind and status and gains an origin_project provenance block (project uuid, original id, date). A redaction check runs BEFORE anything is written: absolute paths, this repo's own path, home directories, private hostnames, and token-like strings in the body refuse the promotion and name every finding — edit the repo article to generalize it first, then re-run. Facts and events are never promotable; kind=pitfall only.",
      inputSchema: MemoryPromoteRequestSchema,
    },
    async ({ id }) => {
      // A cross-scope write rides the delete tier (operator/orchestrator),
      // not memory:write — plan §5.
      deps.authorizeTool(capability, "memory_promote", "memory:delete");
      const fact = await readMemoryFact(deps.repoRoot, "repo", id);
      if (fact === null) {
        throw new Error(`Memory pitfall not found: [repo] ${id}`);
      }
      if (fact.kind !== "pitfall") {
        throw new Error(
          `Only pitfall-kind articles are promotable; [repo] ${id} is kind "${fact.kind}"`,
        );
      }
      const findings = scanPromotionRedaction(fact.body, {
        repoRoot: deps.repoRoot,
        home: homedir(),
      });
      if (findings.length > 0) {
        throw new Error(
          `memory_promote redaction check refused [repo] ${id}: the body ` +
            "carries content that must not cross into global scope. Edit the " +
            "repo article to generalize it, then re-run. Findings:\n" +
            findings
              .map((finding) => `- ${finding.kind}: ${finding.match}`)
              .join("\n"),
        );
      }
      const written = await deps.writeMemoryFact({
        scope: "global",
        topic: fact.topic,
        title: fact.title,
        body:
          fact.body +
          promotionProvenanceBlock({
            hiveUuid: projectHiveUuid(deps.repoRoot),
            id: fact.id,
            date: new Date().toISOString().slice(0, 10),
          }),
        tags: [...fact.tags, "promoted"],
        source: promotionSource(fact),
        evidence: `Promoted from repo-scope pitfall "${fact.id}" by ${capability.subject} via memory_promote`,
        status: fact.status,
        kind: "pitfall",
        supersedes: [],
        ...(fact.verified === undefined ? {} : { verified: fact.verified }),
      });
      return toolResult(
        {
          promoted: {
            scope: written.scope,
            topic: written.topic,
            id: written.id,
            title: written.title,
            status: written.status,
          },
          origin: { scope: "repo", id: fact.id },
        },
        "fact",
      );
    },
  );
}
