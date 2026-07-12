import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  graphJsonPath,
  graphifyPin,
  servingGraphPath,
  writeGraphifyState,
} from "../adapters/graphify";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import { HiveDaemon } from "./server";
import type { SpawnRequest, Spawner } from "./spawner";
import { actingAs } from "./testing";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeHome(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "hive-graph-locate-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by graph_locate tests");
  }
}

class NoopTmux {
  async hasSession(_session: string): Promise<boolean> {
    return false;
  }
  async capturePane(_session: string): Promise<string> {
    return "";
  }
  async killSession(_session: string): Promise<void> {}
  async newSession(
    _name: string,
    _cwd: string,
    _command: string,
  ): Promise<void> {}
}

async function bootDaemon(): Promise<{ daemon: HiveDaemon; repoRoot: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-graph-locate-repo-"));
  tempRoots.push(repoRoot);
  const daemon = new HiveDaemon({
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    tmux: new NoopTmux(),
    repoRoot,
  });
  return { daemon, repoRoot };
}

async function connectedClient(daemon: HiveDaemon): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(daemon, "operator", "operator") },
  );
  const client = new Client({ name: "hive-graph-locate-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function locate(
  client: Client,
  question: string,
): Promise<{ available: boolean; answer: string }> {
  const result = await client.callTool({
    name: "graph_locate",
    arguments: { question },
  });
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as { available: boolean; answer: string };
}

const SYNTHETIC_GRAPH = JSON.stringify({
  nodes: [
    { id: "auth", label: "auth.ts", source_file: "src/auth.ts", source_location: "L1", community: 1 },
    { id: "auth_login", label: "loginUser()", source_file: "src/auth.ts", source_location: "L9", community: 1 },
    { id: "session", label: "session.ts", source_file: "src/session.ts", source_location: "L1", community: 1 },
    { id: "session_create", label: "createSession()", source_file: "src/session.ts", source_location: "L5", community: 1 },
  ],
  links: [
    { relation: "imports_from", confidence: "EXTRACTED", context: "import", source: "auth", target: "session" },
  ],
});

describe("graph_locate over the daemon's real MCP interface", () => {
  test("answers a locate-question with cited nodes, edges, and the verify footer", async () => {
    await makeHome();
    const { daemon, repoRoot } = await bootDaemon();
    await writeGraphifyState(repoRoot, { enabled: true, pin: graphifyPin() });
    await mkdir(dirname(graphJsonPath(repoRoot)), { recursive: true });
    await writeFile(graphJsonPath(repoRoot), SYNTHETIC_GRAPH);
    const client = await connectedClient(daemon);
    try {
      const result = await locate(client, "where does user login create a session");
      expect(result.available).toBe(true);
      expect(result.answer).toContain("NODE loginUser() [src=src/auth.ts loc=L9");
      expect(result.answer).toContain(
        "EDGE auth.ts --imports_from [EXTRACTED context=import]--> session.ts",
      );
      expect(result.answer).toContain("verify in source");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("prefers the serving snapshot rebuilds never mutate over the live file", async () => {
    await makeHome();
    const { daemon, repoRoot } = await bootDaemon();
    await writeGraphifyState(repoRoot, { enabled: true, pin: graphifyPin() });
    await mkdir(dirname(graphJsonPath(repoRoot)), { recursive: true });
    // The live file is mid-rebuild garbage; only the snapshot is coherent.
    await writeFile(graphJsonPath(repoRoot), "MID-REBUILD GARBAGE");
    await mkdir(dirname(servingGraphPath(repoRoot)), { recursive: true });
    await writeFile(servingGraphPath(repoRoot), SYNTHETIC_GRAPH);
    const client = await connectedClient(daemon);
    try {
      const result = await locate(client, "where does user login create a session");
      expect(result.available).toBe(true);
      expect(result.answer).toContain("NODE loginUser()");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("a vocabulary-mismatch question gets the honest no-leads answer, not noise", async () => {
    await makeHome();
    const { daemon, repoRoot } = await bootDaemon();
    await writeGraphifyState(repoRoot, { enabled: true, pin: graphifyPin() });
    await mkdir(dirname(graphJsonPath(repoRoot)), { recursive: true });
    await writeFile(graphJsonPath(repoRoot), SYNTHETIC_GRAPH);
    const client = await connectedClient(daemon);
    try {
      const result = await locate(client, "kubernetes ingress reconciliation loop");
      expect(result.available).toBe(true);
      expect(result.answer).toContain("No strong leads");
      expect(result.answer).toContain("grep");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });

  test("absent opt-in, absent graph, and corrupt graph all degrade to honest answers", async () => {
    await makeHome();
    const { daemon, repoRoot } = await bootDaemon();
    const client = await connectedClient(daemon);
    try {
      // Never enabled: the tool says so instead of erroring.
      let result = await locate(client, "where is auth handled");
      expect(result.available).toBe(false);
      expect(result.answer).toContain("not enabled");

      // Enabled but never built.
      await writeGraphifyState(repoRoot, { enabled: true, pin: graphifyPin() });
      result = await locate(client, "where is auth handled");
      expect(result.available).toBe(false);
      expect(result.answer).toContain("not built");

      // Built but corrupt (exactly what a reader mid-rewrite would see).
      await mkdir(dirname(graphJsonPath(repoRoot)), { recursive: true });
      await writeFile(graphJsonPath(repoRoot), "{ definitely not json");
      result = await locate(client, "where is auth handled");
      expect(result.available).toBe(false);
      expect(result.answer).toContain("unreadable");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.stop();
    }
  });
});
