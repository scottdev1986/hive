import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { operatorFetch } from "./credential";
import { HIVE_VERSION } from "../version";
import {
  AgentRecordSchema,
  MemoryFactSchema,
  MemoryScopeSchema,
  MemorySearchResultSchema,
  MemoryWriteResultSchema,
  ORCHESTRATOR_NAME,
  QuotaObservationSchema,
  type AgentRecord,
  type MemoryFact,
  type MemoryScope,
  type MemorySearchResult,
  type MemoryWriteInput,
  type MemoryWriteResult,
  type QuotaObservation,
  type QuotaObservationInput,
  type QuotaStatus,
} from "../schemas";

export type McpFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function textToolValue(content: unknown, toolName: string): unknown {
  const items = z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  })).parse(content);
  const item = items.find((candidate) =>
    candidate.type === "text" && candidate.text !== undefined
  );
  if (item?.text === undefined) {
    throw new Error(`${toolName} returned no text content`);
  }
  return JSON.parse(item.text) as unknown;
}

async function callHiveTool(
  port: number,
  name: string,
  args: Record<string, unknown>,
  key: string,
  fetcher?: McpFetcher,
  errorLabel = name,
): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { fetch: fetcher ?? operatorFetch },
  );
  const client = new Client({ name: "hive-cli", version: HIVE_VERSION });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError === true) throw new Error(`${errorLabel} failed`);
    const structured = z.record(z.string(), z.unknown()).optional()
      .parse(result.structuredContent);
    return structured?.[key] ?? textToolValue(result.content, name);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function fetchAgentStatus(
  port: number,
  fetcher?: McpFetcher,
): Promise<AgentRecord[]> {
  return AgentRecordSchema.array().parse(
    await callHiveTool(port, "hive_status", { detail: "full" }, "agents", fetcher),
  );
}

export async function sendOrchestratorMessage(
  port: number,
  to: string,
  body: string,
  fetcher?: McpFetcher,
): Promise<void> {
  await callHiveTool(
    port,
    "hive_send",
    { from: ORCHESTRATOR_NAME, to, body, priority: "steer" },
    "message",
    fetcher,
    `hive_send to ${to}`,
  );
}

export async function markAgentDead(
  port: number,
  agentName: string,
  fetcher?: McpFetcher,
): Promise<AgentRecord> {
  return AgentRecordSchema.parse(await callHiveTool(
    port,
    "hive_mark_dead",
    { agent: agentName },
    "agent",
    fetcher,
    `hive_mark_dead for ${agentName}`,
  ));
}

export async function fetchQuotaStatus(
  port: number,
  fetcher?: McpFetcher,
): Promise<QuotaStatus[]> {
  return z.array(z.unknown()).parse(
    await callHiveTool(port, "hive_quota_status", {}, "quotas", fetcher),
  ) as QuotaStatus[];
}

export async function reconcileQuota(
  port: number,
  observation: QuotaObservationInput,
  fetcher?: McpFetcher,
): Promise<QuotaObservation> {
  return QuotaObservationSchema.parse(await callHiveTool(
    port,
    "hive_quota_reconcile",
    observation,
    "observation",
    fetcher,
  ));
}

export async function searchMemory(
  port: number,
  query: string,
  options?: { scope?: MemoryScope; limit?: number },
  fetcher?: McpFetcher,
): Promise<MemorySearchResult[]> {
  return MemorySearchResultSchema.array().parse(await callHiveTool(
    port,
    "memory_search",
    { query, ...options },
    "results",
    fetcher,
  ));
}

export async function writeMemory(
  port: number,
  input: MemoryWriteInput,
  fetcher?: McpFetcher,
): Promise<MemoryWriteResult> {
  return MemoryWriteResultSchema.parse(
    await callHiveTool(port, "memory_write", input, "fact", fetcher),
  );
}

export async function readMemory(
  port: number,
  scope: MemoryScope,
  id: string,
  fetcher?: McpFetcher,
): Promise<MemoryFact> {
  return MemoryFactSchema.parse(
    await callHiveTool(port, "memory_read", { scope, id }, "fact", fetcher),
  );
}

export async function deleteMemory(
  port: number,
  scope: MemoryScope,
  id: string,
  fetcher?: McpFetcher,
): Promise<boolean> {
  const result = z.object({ deleted: z.boolean() }).parse(
    await callHiveTool(port, "memory_delete", { scope, id }, "result", fetcher),
  );
  return result.deleted;
}

const MemoryEmbeddingsStatusSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  state: z.string(),
  detail: z.string().optional(),
  runtimeDir: z.string().optional(),
  vectors: z.object({
    articles: z.number(),
    facts: z.number(),
    total: z.number(),
  }).optional(),
});
export type MemoryEmbeddingsStatus = z.infer<typeof MemoryEmbeddingsStatusSchema>;

/** The memory.embeddings section of the hive_status structuredContent
 * (defect D2): provider, model, one-word state, vector counts, runtime dir. */
export async function fetchMemoryEmbeddingsStatus(
  port: number,
  fetcher?: McpFetcher,
): Promise<MemoryEmbeddingsStatus> {
  const memory = z.object({ embeddings: MemoryEmbeddingsStatusSchema }).parse(
    await callHiveTool(port, "hive_status", {}, "memory", fetcher),
  );
  return memory.embeddings;
}

const MemoryRecallRowSchema = z.object({
  scope: z.string(),
  id: z.string(),
  title: z.string(),
  pitfall: z.boolean(),
});

const MemoryRecallEnvelopeSchema = z.object({
  state: z.string(),
  /** "hybrid" | "disabled" | "degraded:<state>" (defect D2). */
  semantic: z.string(),
  warning: z.string().optional(),
  pitfalls: z.array(MemoryRecallRowSchema),
  articles: z.array(MemoryRecallRowSchema),
});
export type MemoryRecallEnvelope = z.infer<typeof MemoryRecallEnvelopeSchema>;

export async function recallMemory(
  port: number,
  query: string,
  options?: { budget?: number },
  fetcher?: McpFetcher,
): Promise<MemoryRecallEnvelope> {
  return MemoryRecallEnvelopeSchema.parse(await callHiveTool(
    port,
    "memory_recall",
    { query, ...options },
    "results",
    fetcher,
  ));
}

const MemoryNoteResultSchema = z.object({
  state: z.string(),
  detail: z.string().optional(),
  /** "indexed" | "queued" | "unavailable:<state>" (defect D2). */
  embedding: z.string().optional(),
  fact: z.object({ id: z.string() }).optional(),
});
export type MemoryNoteResult = z.infer<typeof MemoryNoteResultSchema>;

export async function noteMemory(
  port: number,
  input: {
    topic: string;
    title: string;
    body: string;
    confidence?: number;
    validAt?: string;
  },
  fetcher?: McpFetcher,
): Promise<MemoryNoteResult> {
  return MemoryNoteResultSchema.parse(
    await callHiveTool(port, "memory_note", input, "fact", fetcher),
  );
}

const MemoryQueryEnvelopeSchema = z.object({
  state: z.string(),
  detail: z.string().nullable().optional(),
  results: z.array(z.record(z.string(), z.unknown())),
});
export type MemoryQueryEnvelope = z.infer<typeof MemoryQueryEnvelopeSchema>;

export async function queryMemory(
  port: number,
  input: {
    class: string;
    query?: string;
    agent?: string;
    since?: string;
    budget?: number;
  },
  fetcher?: McpFetcher,
): Promise<MemoryQueryEnvelope> {
  return MemoryQueryEnvelopeSchema.parse(
    await callHiveTool(port, "memory_query", input, "result", fetcher),
  );
}

const MemoryDigestEnvelopeSchema = z.object({
  state: z.string(),
  detail: z.string().nullable().optional(),
  digest: z.unknown().nullable().optional(),
  events: z.array(z.unknown()).optional(),
});
export type MemoryDigestEnvelope = z.infer<typeof MemoryDigestEnvelopeSchema>;

export async function digestMemory(
  port: number,
  input: {
    agent?: string;
    sessionId?: string;
    digestId?: number;
    eventId?: number;
    budget?: number },
  fetcher?: McpFetcher,
): Promise<MemoryDigestEnvelope> {
  return MemoryDigestEnvelopeSchema.parse(
    await callHiveTool(port, "memory_digest", input, "result", fetcher),
  );
}

export async function reindexMemory(
  port: number,
  fetcher?: McpFetcher,
): Promise<{
  count: number;
  migration: {
    scanned: number;
    migrated: number;
    backups: Array<{ scope: MemoryScope; path: string }>;
    alreadyMigrated: MemoryScope[];
  };
}> {
  return z.object({
    count: z.number(),
    migration: z.object({
      scanned: z.number(),
      migrated: z.number(),
      flagged: z.array(z.object({
        scope: MemoryScopeSchema,
        id: z.string(),
        status: z.string(),
      })),
      backups: z.array(z.object({ scope: MemoryScopeSchema, path: z.string() })),
      alreadyMigrated: z.array(MemoryScopeSchema),
    }),
  }).parse(
    await callHiveTool(port, "memory_reindex", {}, "result", fetcher),
  );
}
