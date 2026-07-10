import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { AgentRecordSchema, type AgentRecord } from "../schemas";

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

export async function fetchAgentStatus(
  port: number,
  fetcher?: McpFetcher,
): Promise<AgentRecord[]> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    fetcher === undefined ? undefined : { fetch: fetcher },
  );
  const client = new Client({ name: "hive-cli", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "hive_status",
      arguments: {},
    });
    if (result.isError === true) {
      throw new Error("hive_status failed");
    }
    const structuredContent = z.record(z.string(), z.unknown()).optional()
      .parse(result.structuredContent);
    const value = structuredContent?.agents ??
      textToolValue(result.content, "hive_status");
    return AgentRecordSchema.array().parse(value);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function markAgentDead(
  port: number,
  agentName: string,
  fetcher?: McpFetcher,
): Promise<AgentRecord> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    fetcher === undefined ? undefined : { fetch: fetcher },
  );
  const client = new Client({ name: "hive-cli", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "hive_mark_dead",
      arguments: { agent: agentName },
    });
    if (result.isError === true) {
      throw new Error(`hive_mark_dead failed for ${agentName}`);
    }
    const structuredContent = z.record(z.string(), z.unknown()).optional()
      .parse(result.structuredContent);
    const value = structuredContent?.agent ??
      textToolValue(result.content, "hive_mark_dead");
    return AgentRecordSchema.parse(value);
  } finally {
    await client.close().catch(() => undefined);
  }
}
