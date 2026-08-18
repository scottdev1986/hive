import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { daemonMcpUrl } from "../adapters/providers/shared/mcp-scope";
import { HIVE_MCP_VERSION_NEGOTIATION } from "../shared/mcp-protocol";
import {
  type AgentRecord,
  AgentRecordSchema,
  ORCHESTRATOR_NAME,
} from "../schemas/agent";
import {
  type MemoryFact,
  MemoryFactSchema,
  type MemoryScope,
  MemoryScopeSchema,
  type MemorySearchResult,
  MemorySearchResultSchema,
  type MemoryWriteInput,
  type MemoryWriteResult,
  MemoryWriteResultSchema,
} from "../schemas/memory";
import {
  type MemoryRecallPreview,
  MemoryRecallPreviewSchema,
} from "../schemas/memory-projections";
import {
  type QuotaObservation,
  type QuotaObservationInput,
  QuotaObservationSchema,
  type QuotaStatus,
} from "../schemas/quota";
import { HIVE_VERSION } from "../shared/version";
import { userFetch } from "./credential";

export type McpFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function textToolContent(content: unknown, toolName: string): string {
  const items = z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    )
    .parse(content);
  const item = items.find(
    (candidate) => candidate.type === "text" && candidate.text !== undefined,
  );
  if (item?.text === undefined) {
    throw new Error(`${toolName} returned no text content`);
  }
  return item.text;
}

function textToolValue(content: unknown, toolName: string): unknown {
  return JSON.parse(textToolContent(content, toolName)) as unknown;
}

export function toolErrorReason(content: unknown, toolName: string): string {
  const text = textToolContent(content, toolName);
  try {
    const value = JSON.parse(text) as unknown;
    const parsed = z.object({ reason: z.string() }).safeParse(value);
    return parsed.success ? parsed.data.reason : text;
  } catch {
    return text;
  }
}

/** One MCP client session, held open across as many tool calls as the caller makes. Connecting is the expensive half of a call — a transport, a client, a handshake round trip and a teardown — so a caller that reads the daemon repeatedly pays it once instead of per read. A call on a session that was already open may fail because that session is gone (the daemon restarted, or the transport was closed under it); that reconnects once and retries, so a held session outlives a daemon restart. A session's first call never retries: a fresh session's failure is the daemon's answer, not a stale connection.
 *
 * One caller, one call at a time. Connecting is not guarded against concurrent entry: two calls that both find no client would each build a transport, and the second would overwrite the first, orphaning a live connection. Every caller today is sequential — hold a session per concurrent reader, or serialize the calls. */
export class HiveMcpSession {
  private client: Client | null = null;

  constructor(
    private readonly port: number,
    private readonly fetcher?: McpFetcher,
  ) {}

  async call(
    name: string,
    args: Record<string, unknown>,
    key: string,
    errorLabel = name,
  ): Promise<unknown> {
    const reused = this.client !== null;
    const client = await this.connected();
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (error) {
      if (!reused) throw error;
      await this.close();
      result = await (await this.connected()).callTool({
        name,
        arguments: args,
      });
    }
    if (result.isError === true) {
      const structured = z
        .object({ error: z.object({ reason: z.string() }) })
        .safeParse(result.structuredContent);
      const reason = structured.success
        ? structured.data.error.reason
        : toolErrorReason(result.content, name);
      throw new Error(`${errorLabel} failed: ${reason}`);
    }
    const structured = z
      .record(z.string(), z.unknown())
      .optional()
      .parse(result.structuredContent);
    return structured?.[key] ?? textToolValue(result.content, name);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => undefined);
  }

  private async connected(): Promise<Client> {
    if (this.client !== null) return this.client;
    const transport = new StreamableHTTPClientTransport(
      new URL(daemonMcpUrl(this.port)),
      { fetch: this.fetcher ?? userFetch },
    );
    const client = new Client(
      { name: "hive-cli", version: HIVE_VERSION },
      { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
    );
    await client.connect(transport);
    this.client = client;
    return client;
  }
}

/** One tool call on a session of its own. For a caller that speaks to the daemon once; a caller that polls holds a `HiveMcpSession` instead. */
export async function callHiveTool(
  port: number,
  name: string,
  args: Record<string, unknown>,
  key: string,
  fetcher?: McpFetcher,
  errorLabel = name,
): Promise<unknown> {
  const session = new HiveMcpSession(port, fetcher);
  try {
    return await session.call(name, args, key, errorLabel);
  } finally {
    await session.close();
  }
}

/** The full agent roster over a caller-held session. */
export async function readAgentStatus(
  session: HiveMcpSession,
): Promise<AgentRecord[]> {
  return AgentRecordSchema.array().parse(
    await session.call("hive_status", { detail: "full" }, "agents"),
  );
}

export async function fetchAgentStatus(
  port: number,
  fetcher?: McpFetcher,
): Promise<AgentRecord[]> {
  const session = new HiveMcpSession(port, fetcher);
  try {
    return await readAgentStatus(session);
  } finally {
    await session.close();
  }
}

async function postDaemonJson(
  port: number,
  path: string,
  body: unknown,
  fetcher?: McpFetcher,
): Promise<unknown> {
  const { UserDaemonClient } = await import("./user-daemon-client");
  const authorizedFetch =
    fetcher === undefined
      ? undefined
      : (input: string | URL | Request, init?: RequestInit) =>
          fetcher(input instanceof Request ? input.url : input, init);
  const response = await new UserDaemonClient({
    port: fetcher === undefined ? port : 1,
    fetch: authorizedFetch,
    ...(fetcher === undefined ? {} : { verifyIdentity: false }),
  }).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = z.object({ error: z.string() }).safeParse(payload);
    throw new Error(
      reason.success
        ? reason.data.error
        : `${path} failed (HTTP ${response.status})`,
    );
  }
  return payload;
}

export async function requestSettlementSweep(
  port: number,
  fetcher?: McpFetcher,
): Promise<unknown> {
  const payload = z
    .object({ settlement: z.unknown() })
    .parse(await postDaemonJson(port, "/settlement/sweep", {}, fetcher));
  return payload.settlement;
}

export async function sendOrchestratorMessage(
  port: number,
  to: string,
  body: string,
  fetcher?: McpFetcher,
): Promise<void> {
  await callHiveTool(
    port,
    "hive_mail_publish",
    {
      from: ORCHESTRATOR_NAME,
      to,
      body,
      // A recovery ping is an instruction to act on, so it takes the lane where each message is handled once rather than merging into the next ping.
      lane: "control",
      topic: "supervisor",
      idempotencyKey: `supervisor-ping:${to}:${Bun.randomUUIDv7()}`,
    },
    "mail",
    fetcher,
    `hive_mail_publish to ${to}`,
  );
}

export async function markAgentDead(
  port: number,
  agentName: string,
  fetcher?: McpFetcher,
): Promise<AgentRecord> {
  return AgentRecordSchema.parse(
    await callHiveTool(
      port,
      "hive_mark_dead",
      { agent: agentName },
      "agent",
      fetcher,
      `hive_mark_dead for ${agentName}`,
    ),
  );
}

export async function fetchQuotaStatus(
  port: number,
  fetcher?: McpFetcher,
): Promise<QuotaStatus[]> {
  return z
    .array(z.unknown())
    .parse(
      await callHiveTool(port, "hive_quota_status", {}, "quotas", fetcher),
    ) as QuotaStatus[];
}

export async function reconcileQuota(
  port: number,
  observation: QuotaObservationInput,
  fetcher?: McpFetcher,
): Promise<QuotaObservation> {
  const payload = z
    .object({ observation: QuotaObservationSchema })
    .parse(await postDaemonJson(port, "/quota/observe", observation, fetcher));
  return payload.observation;
}

export async function searchMemory(
  port: number,
  query: string,
  options?: { scope?: MemoryScope; limit?: number },
  fetcher?: McpFetcher,
): Promise<MemorySearchResult[]> {
  return MemorySearchResultSchema.array().parse(
    await callHiveTool(
      port,
      "memory_search",
      { query, ...options },
      "results",
      fetcher,
    ),
  );
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
  const result = z
    .object({ deleted: z.boolean() })
    .parse(
      await callHiveTool(
        port,
        "memory_delete",
        { scope, id },
        "result",
        fetcher,
      ),
    );
  return result.deleted;
}

const MemoryEmbeddingsStatusSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  state: z.string(),
  detail: z.string().optional(),
  runtimeDir: z.string().optional(),
  vectors: z
    .object({
      articles: z.number(),
      facts: z.number(),
      total: z.number(),
    })
    .optional(),
});
export type MemoryEmbeddingsStatus = z.infer<
  typeof MemoryEmbeddingsStatusSchema
>;

export async function fetchMemoryEmbeddingsStatus(
  port: number,
  fetcher?: McpFetcher,
): Promise<MemoryEmbeddingsStatus> {
  const memory = z
    .object({ embeddings: MemoryEmbeddingsStatusSchema })
    .parse(await callHiveTool(port, "hive_status", {}, "memory", fetcher));
  return memory.embeddings;
}

export async function recallMemory(
  port: number,
  query: string,
  options?: { budget?: number },
  fetcher?: McpFetcher,
): Promise<MemoryRecallPreview> {
  return MemoryRecallPreviewSchema.parse(
    await postDaemonJson(
      port,
      "/memory/recall-preview",
      { query, purpose: "explicit-recall", ...options },
      fetcher,
    ),
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
  return z
    .object({
      count: z.number(),
      migration: z.object({
        scanned: z.number(),
        migrated: z.number(),
        flagged: z.array(
          z.object({
            scope: MemoryScopeSchema,
            id: z.string(),
            status: z.string(),
          }),
        ),
        backups: z.array(
          z.object({ scope: MemoryScopeSchema, path: z.string() }),
        ),
        alreadyMigrated: z.array(MemoryScopeSchema),
      }),
    })
    .parse(await callHiveTool(port, "memory_reindex", {}, "result", fetcher));
}
