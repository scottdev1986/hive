import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { Action, Capability } from "../schemas/authority";
import type { HiveToolRegistrar } from "../daemon/authorization/mcp-tool-policy";
import type { StatusService } from "../daemon/status-service/status-service";
import type { MemoryRecallEnvelope } from "../schemas/memory-projections";
import { toolResult } from "../shared/mcp-tool-result";
import {
  compactMemoryWriteResult,
  type MemoryFact,
  type MemoryScope,
  MemoryScopeSchema,
  type MemoryWriteInput,
  MemoryWriteRequestFieldsSchema,
} from "../schemas/memory";
import type { TokenUsageStore } from "../usage-service/token-usage";
import type {
  MemoryEmbeddingIndex,
  MemoryEmbeddingWriteOutcome,
} from "./embeddings";
import type { EpisodicStore } from "./episodic";
import { findSimilarMemoryCandidates, type MemoryIndex } from "./fts-index";
import { MemoryQueryInputSchema, runMemoryQuery } from "./query";
import {
  buildMemoryRecallBundle,
  MEMORY_RECALL_HINT_NOTE,
  memoryRecallDegradedWarning,
  partitionMemoryRecall,
} from "./recall";
import { listMemoryFacts, readMemoryFact } from "./memory-store";
import type { MemoryWriteFileResult } from "./store-records";

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
  limit: z
    .number()
    .int()
    .max(50)
    .refine((value) => value > 0, "must be positive")
    .optional(),
});

export const MemoryFactRequestSchema = z.object({
  scope: MemoryScopeSchema,
  id: MemoryIdSchema,
});

export const MemoryWriteRequestSchema =
  MemoryWriteRequestFieldsSchema.safeExtend({
    id: MemoryIdSchema.optional(),
  });

export const MemoryPitfallRequestSchema = z.object({
  query: z.string().min(1).optional(),
  scope: MemoryScopeSchema.optional(),
  limit: z
    .number()
    .int()
    .max(50)
    .refine((value) => value > 0, "must be positive")
    .optional(),
});

export const MemoryRecallRequestSchema = z.object({
  query: z.string().min(1),
  budget: z
    .number()
    .int()
    .refine((value) => value > 0, "must be positive")
    .optional(),
});

export const MEMORY_RECALL_DEFAULT_BUDGET = 800;

interface AgentIdentityReader {
  getAgentByName(name: string): { id: string } | null;
}

export interface MemoryToolDeps {
  db: AgentIdentityReader;
  repoRoot: string;
  memory: MemoryIndex;
  embeddingIndex: MemoryEmbeddingIndex | null;
  episodic: EpisodicStore | null;
  status: StatusService;
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
  verifyMemoryFact: (
    scope: MemoryScope,
    id: string,
    verifier: string,
  ) => Promise<MemoryFact>;
  deleteMemoryFact: (scope: MemoryScope, id: string) => Promise<boolean>;
  rebuildMemoryIndex: (signal?: AbortSignal) => Promise<unknown>;
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
  server: HiveToolRegistrar,
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
      const written = await deps.writeMemoryFact({
        ...input,
        author: capability.subject,
      });
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
          embedding: written.embedding,
        },
        "fact",
      );
    },
  );

  server.registerTool(
    "memory_verify",
    {
      title: "Verify a Hive memory article someone else wrote",
      description:
        "Record that you checked an existing article against the current tree and it holds. This is the ONLY way an article becomes status=verified: memory_write always lands unverified, so the badge means a second session confirmed the claim rather than the author asserting it. Refused when the article records no author, when you are its author, or when the article was written today — a verification must be later than the body it checks. Read the article and confirm it against the source before calling this; a verification you did not perform is worse than no verification, because it converts an open question into a settled one for every later reader.",
      inputSchema: MemoryFactRequestSchema,
    },
    async ({ scope, id }) => {
      deps.authorizeTool(capability, "memory_verify", "memory:write");
      const verified = await deps.verifyMemoryFact(
        scope,
        id,
        capability.subject,
      );
      return toolResult(verified, "fact");
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
    async (_input, context) => {
      deps.authorizeTool(capability, "memory_reindex", "memory:write");
      return toolResult(
        await deps.rebuildMemoryIndex(context.mcpReq.signal),
        "result",
      );
    },
  );

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

  // The focused pitfall surface reads pitfall-kind articles only. An agent checking "has anyone burned themselves here before" never wades through the whole wiki. search with no query lists every pitfall (optionally scope-filtered); search with a query runs the same FTS memory_search uses, filtered to pitfalls; get reads one article and refuses a non-pitfall id. Every row carries its verification status — unverified is a hint, not authority, everywhere it appears.
  server.registerTool(
    "memory_pitfall",
    {
      title: "List and search Hive pitfall memory",
      description:
        "List or search pitfall-kind memory articles — the 'we burned ourselves before' class, including the unverified harvest candidates that ordinary ranking quarantines. With a query, runs full-text search filtered to pitfalls; with no query, lists every pitfall article (optionally scope-filtered). This is the review surface for harvest candidates, so it is the one retrieval path that shows them. Read a full article with memory_read(scope, id). Every result carries its verification status: unverified is a harvested claim to reconcile before acting, never authority.",
      inputSchema: MemoryPitfallRequestSchema,
    },
    async ({ query, scope, limit }) => {
      deps.authorizeTool(
        capability,
        "memory_pitfall",
        "memory:read",
        undefined,
        false,
      );
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
      const hits = deps.memory.search(query, {
        ...(scope === undefined ? {} : { scope }),
        limit: limit ?? 10,
        kind: "pitfall",
      });
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
      const fitted = partitionMemoryRecall(bundle, effective);
      // The envelope discriminates hybrid / degraded:<state> / disabled so FTS-only-because-embeddings-are-down is never indistinguishable from a genuine keyword-only result. The warning is envelope-level (field + note block), never a row — budget clamping cannot cut it.
      const degraded = bundle.semantic.startsWith("degraded:");
      const warning = degraded
        ? memoryRecallDegradedWarning(bundle.semantic.slice("degraded:".length))
        : null;
      const envelope: MemoryRecallEnvelope = {
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
        tokens: fitted.tokens,
        truncated: fitted.truncated,
        omitted: fitted.omitted,
        omittedPitfalls: fitted.omittedPitfalls,
        omittedArticles: fitted.omittedArticles,
        pitfalls: fitted.pitfalls,
        articles: fitted.articles,
      };
      return toolResult(envelope, "results", warning);
    },
  );
}
