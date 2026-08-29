import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { Action, Capability } from "../schemas/authority";
import type { HiveToolServer } from "../daemon/authorization/mcp-tool-policy";
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
import { readMemoryFact, pathExists, commandExists } from "./memory-store";
import { buildMemoryRecallBundle, memoryRecallDegradedWarning, type MemoryRecallRow } from "./recall";
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

/**
 * P0: Citation path-exists check (minimum viable).
 * Validates that paths and commands mentioned in a memory fact still exist.
 * Throws if any cited path/command is not found, treating the fact as stale/unverified.
 */
async function validateFactCitations(
  fact: MemoryFact,
  repoRoot: string,
): Promise<void> {
  const { resolve, isAbsolute } = await import("node:path");
  const textToCheck = [fact.title, fact.body, fact.evidence].join("\n");

  // Extract potential file paths (simple heuristic: words that look like paths)
  const pathPattern =
    /(?:^|\s)([.~]?\/[^\s]+|[a-zA-Z0-9_-]+\/[^\s]+\.[a-zA-Z0-9]+)/g;
  const paths = Array.from(
    textToCheck.matchAll(pathPattern),
    (m) => m[1],
  ).filter((path): path is string => path !== undefined);

  // Extract potential commands (simple heuristic: backtick-wrapped words or common commands)
  const commandPattern = /`([a-zA-Z0-9_-]+)`/g;
  const commands = Array.from(
    textToCheck.matchAll(commandPattern),
    (m) => m[1],
  ).filter((cmd): cmd is string => cmd !== undefined);

  // Check paths relative to repoRoot
  for (const path of paths) {
    const resolved = isAbsolute(path) ? path : resolve(repoRoot, path);
    const exists = await pathExists(resolved);
    if (!exists) {
      throw new Error(
        `Citation validation failed: path '${path}' not found (fact: ${fact.id})`,
      );
    }
  }

  // Check commands (only common binaries, not all backticked words)
  const commonCommands = new Set([
    "git",
    "npm",
    "bun",
    "node",
    "cargo",
    "make",
    "docker",
    "kubectl",
    "python",
    "ruby",
    "go",
    "rustc",
    "gcc",
    "clang",
    "tsc",
    "eslint",
  ]);
  for (const cmd of commands) {
    if (commonCommands.has(cmd)) {
      const exists = await commandExists(cmd);
      if (!exists) {
        throw new Error(
          `Citation validation failed: command '${cmd}' not found (fact: ${fact.id})`,
        );
      }
    }
  }
}

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
  /** Semantic recall function for hybrid search; undefined means FTS-only. */
  semanticRecall?: (
    query: string,
    limit: number,
  ) => Promise<Array<{
    scope: string;
    id: string;
    score: number;
  }> | null>;
  /** Semantic status for degraded state labeling. */
  semanticStatus?: () => string;
}

export function registerMemoryTools(
  server: HiveToolServer,
  capability: Capability,
  deps: MemoryToolDeps,
): void {
  server.registerTool(
    "memory_search",
    {
      title: "Search Hive memory",
      description:
        'Hybrid search (lexical + semantic when embeddings available) compiled memory articles across repo (".hive/memory/wiki/") and global ("~/.hive/memory/wiki/") scope. Optional kind=pitfall limits results to pitfall articles, including unverified harvest candidates. Raw observations are not search results. Returns snippets; pull a full article with memory_read before relying on it. When embeddings unavailable, falls back to lexical-only.',
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

      // Use hybrid recall when semantic is available, otherwise FTS-only
      // Fetch more results than needed to allow filtering without dropping results
      const fetchLimit = limit ?? 10;
      const bundle = await buildMemoryRecallBundle(
        query,
        {
          repoRoot: () => deps.repoRoot,
          memory: deps.memory,
          semantic: deps.semanticRecall,
          semanticStatus: deps.semanticStatus,
        },
        fetchLimit * 3,
      );

      // Flatten bundle back to search results array for backward compatibility
      const rows = [...bundle.pitfalls, ...bundle.articles];

      // Filter by scope and kind BEFORE limiting to avoid dropping results
      const filtered = rows
        .filter((row) => {
          if (scope !== undefined && row.scope !== scope) return false;
          if (kind !== undefined && kind === "pitfall" && !row.pitfall)
            return false;
          if (kind !== undefined && kind === "article" && row.pitfall)
            return false;
          return true;
        })
        .slice(0, fetchLimit);

      // Convert MemoryRecallRow to MemorySearchResult format
      const results = filtered.map((row) => ({
        id: row.id,
        scope: row.scope,
        topic: row.topic,
        title: row.title,
        snippet: row.snippet,
        date: row.date,
        status: row.status,
        tags: [],
        path:
          row.scope === "repo"
            ? `.hive/memory/wiki/${row.topic}/${row.id}.md`
            : `~/.hive/memory/wiki/${row.topic}/${row.id}.md`,
      }));

      // Include degraded warning if applicable
      if (bundle.semantic.startsWith("degraded:")) {
        const state = bundle.semantic.slice("degraded:".length);
        const warning = memoryRecallDegradedWarning(state);
        return toolResult(results, "results", warning);
      }

      return toolResult(results, "results");
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
        "Read one compiled memory article by scope and id, as referenced by the injected wiki index or memory_search. The result includes topic, evidence, verification status, supersedes relationships, and links to immutable raw observations. Reconcile unverified, stale, or conflicted knowledge before acting. P0: Citation check validates paths exist before load-bearing use.",
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

      // P0: Citation path-exists check on load-bearing facts (verified/stale)
      if (fact.status === "verified" || fact.status === "stale") {
        await validateFactCitations(fact, deps.repoRoot);
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
