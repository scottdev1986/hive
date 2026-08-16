import { appendFileSync } from "node:fs";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { agentFetch, userFetch } from "../../src/cli/credential";
import { HIVE_MCP_VERSION_NEGOTIATION } from "../../src/shared/mcp-protocol";
import { z } from "zod";

const ErrorContentSchema = z
  .array(z.object({ type: z.string(), text: z.string().optional() }))
  .catch([]);

export interface QaCoordinates {
  home: string;
  project: string;
  port: number;
  artifacts: string;
  sourceRoot: string;
}

type AuthenticatedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class McpToolRefusal extends Error {
  constructor(
    readonly toolName: string,
    readonly detail: string,
  ) {
    super(`${toolName} failed${detail ? `: ${detail}` : ""}`);
    this.name = "McpToolRefusal";
  }
}

export function requiredQaCoordinates(): QaCoordinates {
  const home = requiredEnv("HIVE_QA_HOME");
  const project = requiredEnv("HIVE_QA_PROJECT");
  const artifacts = process.env.HIVE_QA_ARTIFACTS || `${home}/artifacts`;
  const sourceRoot = requiredEnv("HIVE_QA_SRC_ROOT");
  const port = z.coerce
    .number()
    .int()
    .positive()
    .parse(requiredEnv("HIVE_QA_PORT"));
  return { home, project, port, artifacts, sourceRoot };
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function callMcpTool<T>(
  port: number,
  authenticatedFetch: AuthenticatedFetch,
  name: string,
  args: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { fetch: authenticatedFetch as typeof fetch },
  );
  const client = new Client(
    { name: "hive-qa", version: "1" },
    { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError === true) {
      const detail = ErrorContentSchema.parse(result.content)
        .filter((item) => item.type === "text")
        .flatMap((item) => (item.text === undefined ? [] : [item.text]))
        .join("\n");
      throw new McpToolRefusal(name, detail);
    }
    return schema.parse(
      z.record(z.string(), z.unknown()).parse(result.structuredContent)[key],
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listMcpTools(
  port: number,
  authenticatedFetch: AuthenticatedFetch,
): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { fetch: authenticatedFetch as typeof fetch },
  );
  const client = new Client(
    { name: "hive-qa", version: "1" },
    { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
  );
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function listUserMcpTools(port: number): Promise<string[]> {
  return listMcpTools(port, userFetch);
}

export function userMcpCall<T>(
  port: number,
  name: string,
  args: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return callMcpTool(port, userFetch, name, args, key, schema);
}

export function agentMcpCall<T>(
  port: number,
  agent: string,
  name: string,
  args: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return callMcpTool(port, agentFetch(agent), name, args, key, schema);
}

export interface QaRowRecord {
  id: string;
  mode: "fixture" | "live";
  verdict: "working" | "broken" | "NEEDS-FIXTURE";
  /** Matrix determinism label; suite validates against the catalog. */
  determinism: "yes" | "bounded" | "calibrated";
  bugs: { present: string[]; absent: string[] };
  evidence: string[];
  sourceSha: string;
  fixtureNeed?: {
    state: string;
    reason: string;
    attempted: boolean;
    productDoor: "unavailable" | "partial";
  };
}

export function writeRowRecord(path: string, record: QaRowRecord): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
