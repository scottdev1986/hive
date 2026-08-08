import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import {
  HIVE_MCP_PROTOCOL_VERSION,
  HIVE_MCP_VERSION_NEGOTIATION,
} from "../../src/shared/mcp-protocol";

/**
 * The daemon-side half of the reachability signal. A vendor MCP client
 * proves its reporting channel by initializing against /mcp with the agent's
 * own credential; the daemon records exactly that, per subject, so the
 * launch path can refuse an agent that is alive but permanently mute.
 */

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by reachability tests");
  }
}

async function makeDaemon(): Promise<HiveDaemon> {
  const home = await mkdtemp(join(tmpdir(), "hive-mcp-seen-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-mcp-seen-repo-"));
  tempRoots.push(repoRoot);
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
    daemonLog: () => {},
  });
}

describe("hive MCP reachability (#57)", () => {
  test("the first-party client uses the complete 2026-07-28 request envelope", async () => {
    const daemon = await makeDaemon();
    try {
      const before = new Date().toISOString();
      expect(daemon.mcpClientSeen("maya", before)).toBe(false);

      const { token } = daemon.capabilities.mint("maya", "writer");
      const malformed = await daemon.fetch(
        new Request("http://hive/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            host: "127.0.0.1",
            "mcp-method": "server/discover",
            "mcp-protocol-version": HIVE_MCP_PROTOCOL_VERSION,
          },
          // Modern requests must bind the protocol version and client info in
          // params._meta. Authentication without that envelope is not ready.
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "server/discover",
            params: {},
          }),
        }),
      );
      expect(malformed.ok).toBe(false);
      expect(daemon.mcpClientSeen("maya", before)).toBe(false);

      const exchanges: Array<{
        body: Record<string, unknown>;
        headers: Headers;
        response: unknown;
      }> = [];
      const fetcher = async (
        input: string | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        if (typeof init?.body !== "string") {
          throw new Error("MCP request body was not JSON text");
        }
        const headers = new Headers(init.headers);
        headers.set("Host", "127.0.0.1");
        headers.set("Authorization", `Bearer ${token}`);
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const response = await daemon.fetch(
          new Request(input, { ...init, headers }),
        );
        const responseBody = response.headers
          .get("content-type")
          ?.includes("application/json")
          ? await response.clone().json()
          : undefined;
        exchanges.push({ body, headers, response: responseBody });
        return response;
      };

      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: fetcher },
      );
      const client = new Client(
        { name: "hive-reachability-test", version: "1.0.0" },
        { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
      );
      await client.connect(transport);
      const result = await client.callTool({
        name: "hive_status",
        arguments: { detail: "active" },
      });
      expect(result.isError).not.toBe(true);
      const denied = await client.callTool({
        name: "hive_spawn",
        arguments: { task: "probe", category: "simple_coding" },
      });
      expect(denied.isError).toBe(true);
      const recorded = daemon.observability.list({
        source: "mcp-tool",
        subject: "maya",
        tool: "hive_spawn",
        limit: 10,
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.reason).toBe("Role writer may not agent:spawn");
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe(
        HIVE_MCP_PROTOCOL_VERSION,
      );
      await client.close().catch(() => undefined);

      const methods = exchanges.map((exchange) => exchange.body.method);
      expect(methods).toEqual(["server/discover", "tools/call", "tools/call"]);
      const discovery = exchanges.find(
        (exchange) => exchange.body.method === "server/discover",
      );
      expect(
        (
          discovery?.response as {
            result?: { capabilities?: { tools?: { listChanged?: boolean } } };
          }
        )?.result?.capabilities?.tools?.listChanged,
      ).toBe(false);
      for (const exchange of exchanges) {
        const method = exchange.body.method;
        if (typeof method !== "string") {
          throw new Error("MCP exchange is missing its method");
        }
        expect(exchange.headers.get("MCP-Protocol-Version")).toBe(
          HIVE_MCP_PROTOCOL_VERSION,
        );
        expect(exchange.headers.get("Mcp-Method")).toBe(method);
        const params = exchange.body.params as Record<string, unknown>;
        const meta = params._meta as Record<string, unknown>;
        expect(meta[PROTOCOL_VERSION_META_KEY]).toBe(HIVE_MCP_PROTOCOL_VERSION);
        expect(meta[CLIENT_INFO_META_KEY]).toEqual({
          name: "hive-reachability-test",
          version: "1.0.0",
        });
      }
      const toolCall = exchanges.find(
        (exchange) => exchange.body.method === "tools/call",
      );
      expect(toolCall?.headers.get("Mcp-Name")).toBe("hive_status");
      expect(
        (toolCall?.response as { result?: { resultType?: string } })?.result
          ?.resultType,
      ).toBe("complete");

      const mismatchedHeaders = new Headers(toolCall?.headers);
      mismatchedHeaders.set("MCP-Protocol-Version", "2025-11-25");
      const mismatch = await daemon.fetch(
        new Request("http://hive/mcp", {
          method: "POST",
          headers: mismatchedHeaders,
          body: JSON.stringify(toolCall?.body),
        }),
      );
      expect(await mismatch.json()).toMatchObject({
        error: { code: -32020 },
      });

      expect(daemon.mcpClientSeen("maya", before)).toBe(true);
      // A dead predecessor's handshake never counts for the next incarnation:
      // a baseline after this launch has not been reported against.
      const after = new Date(Date.now() + 60_000).toISOString();
      expect(daemon.mcpClientSeen("maya", after)).toBe(false);
      // And no other subject is credited by maya's reporting.
      expect(daemon.mcpClientSeen("nobody", before)).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  test("authenticated legacy clients retain stateless compatibility", async () => {
    const daemon = await makeDaemon();
    try {
      const { token } = daemon.capabilities.mint("maya", "writer");
      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        {
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set("Host", "127.0.0.1");
            headers.set("Authorization", `Bearer ${token}`);
            return daemon.fetch(new Request(input, { ...init, headers }));
          },
        },
      );
      const client = new Client({
        name: "hive-legacy-reachability-test",
        version: "1.0.0",
      });
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("legacy");
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close().catch(() => undefined);
    } finally {
      await daemon.stop();
    }
  });

  test("a request without a working credential never marks a subject", async () => {
    const daemon = await makeDaemon();
    try {
      const response = await daemon.fetch(
        new Request("http://hive/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer not-a-real-token",
            host: "127.0.0.1",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "intruder", version: "0" },
            },
          }),
        }),
      );
      expect(response.ok).toBe(false);
      expect(daemon.mcpClientSeen("maya", "1970-01-01T00:00:00.000Z")).toBe(
        false,
      );
    } finally {
      await daemon.stop();
    }
  });

  test("untrusted Host and Origin headers are rejected before dispatch", async () => {
    const daemon = await makeDaemon();
    try {
      const { token } = daemon.capabilities.mint("maya", "writer");
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "host-validation-test", version: "1" },
        },
      });
      const rejectedHost = await daemon.fetch(
        new Request("http://hive/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            host: "attacker.invalid",
          },
          body,
        }),
      );
      expect(rejectedHost.status).toBe(403);

      const rejectedOrigin = await daemon.fetch(
        new Request("http://hive/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            host: "127.0.0.1",
            origin: "https://attacker.invalid",
          },
          body,
        }),
      );
      expect(rejectedOrigin.status).toBe(403);
      expect(daemon.mcpClientSeen("maya", "1970-01-01T00:00:00.000Z")).toBe(
        false,
      );
    } finally {
      await daemon.stop();
    }
  });
});
