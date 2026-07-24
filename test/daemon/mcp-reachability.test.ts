import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import { HiveDaemon } from "../../src/daemon/server";
import { actingAs } from "../../src/daemon/testing";
import type { SpawnRequest, Spawner } from "../../src/daemon/spawner";

/**
 * #57: the daemon-side half of the reachability signal. A vendor MCP client
 * proves its reporting channel by initializing against /mcp with the agent's
 * own credential; the daemon records exactly that, per subject, so the
 * launch path can refuse an agent that is alive but permanently mute.
 */

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
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
  });
}

describe("hive MCP reachability (#57)", () => {
  test("an authenticated MCP handshake marks the subject as reporting, scoped by baseline", async () => {
    const daemon = await makeDaemon();
    try {
      const before = new Date().toISOString();
      expect(daemon.mcpClientSeen("maya", before)).toBe(false);

      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: actingAs(daemon, "maya", "writer") },
      );
      const client = new Client({ name: "hive-reachability-test", version: "1.0.0" });
      await client.connect(transport);
      await client.close().catch(() => undefined);

      // The handshake itself is the proof: no tool call was ever made.
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
      expect(daemon.mcpClientSeen("maya", "1970-01-01T00:00:00.000Z")).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});
