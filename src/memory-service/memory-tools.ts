import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { Action, Capability } from "../schemas/authority";
import type { HiveToolRegistrar } from "../daemon/authorization/mcp-tool-policy";
import { toolResult } from "../shared/mcp-tool-result";
import {
  compactMemoryWriteResult,
  type MemoryFact,
  type MemoryScope,
  MemoryKindSchema,
  MemoryScopeSchema,
  type MemoryWriteInput,
  MemoryWriteRequestFieldsSchema,
} from "../schemas/memory";
import type { MemoryEmbeddingWriteOutcome } from "./embeddings";
import { findSimilarMemoryCandidates, type MemoryIndex } from "./fts-index";
import { readMemoryFact } from "./memory-store";
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
  kind: MemoryKindSchema.optional(),
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

export const MEMORY_RECALL_DEFAULT_BUDGET = 800;

export interface MemoryToolDeps {
  repoRoot: string;
  memory: MemoryIndex;
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
  rebuildMemoryIndex: (signal?: AbortSignal) => Promise<{ count: number }>;
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
        'Full-text search compiled memory articles across repo (".hive/memory/wiki/") and global ("~/.hive/memory/wiki/") scope. Optional kind=pitfall limits results to pitfall articles, including unverified harvest candidates. Raw observations are not search results. Returns snippets; pull a full article with memory_read before relying on it.',
      inputSchema: MemorySearchRequestSchema,
    },
    async ({ query, scope, kind, limit }) => {
      deps.authorizeTool(
        capability,
        "memory_search",
        "memory:read",
        undefined,
        false,
      );
      return toolResult(
        deps.memory.search(query, { scope, kind, limit }),
        "results",
      );
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
}
