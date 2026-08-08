// hive_recover's tool description is a contract every agent and operator
// reads to decide what the tool will do. This pins that description against
// CrashRecovery's actual, deliberate report-only behavior (recovery-service.ts:
// "Do not relaunch the conversation: replacing its generation can kill a
// healthy agent") so the two cannot silently drift apart again — which is
// exactly how this file's defect shipped: the description advertised
// provider-native session resume, and the server only ever inspected and
// reported.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { HIVE_MCP_VERSION_NEGOTIATION } from "../../src/shared/mcp-protocol";

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by a description test");
  }
}

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

async function makeDaemon(): Promise<HiveDaemon> {
  const home = await mkdtemp(join(tmpdir(), "hive-recover-desc-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  const repoRoot = await mkdtemp(join(tmpdir(), "hive-recover-desc-repo-"));
  tempRoots.push(repoRoot);
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db: new HiveDatabase(":memory:"),
    repoRoot,
  });
}

async function hiveRecoverDescription(daemon: HiveDaemon): Promise<string> {
  const { token } = daemon.capabilities.mint("queen", "orchestrator");
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
  const client = new Client(
    { name: "hive-recover-description-test", version: "1.0.0" },
    { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
  );
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const hiveRecover = tools.find((tool) => tool.name === "hive_recover");
    if (hiveRecover === undefined) {
      throw new Error(
        "hive_recover was not advertised to the orchestrator role",
      );
    }
    if (hiveRecover.description === undefined) {
      throw new Error("hive_recover was advertised without a description");
    }
    return hiveRecover.description;
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe("hive_recover's advertised description", () => {
  test("names itself report-only and makes no resume/relaunch claim", async () => {
    const daemon = await makeDaemon();
    try {
      const description = await hiveRecoverDescription(daemon);

      // Positive control: the description says something, so an empty read
      // is a wiring bug in this test, not a defect-free tool.
      expect(description.length).toBeGreaterThan(0);

      // The defect this pins: the description used to claim "native tool
      // resume" and "conversation context restored" — affirmative claims
      // that CrashRecovery's recoverOneExclusive deliberately does not do
      // ("Do not relaunch the conversation: replacing its generation can
      // kill a healthy agent", recovery-service.ts). It must not claim
      // either again.
      expect(description).not.toContain("native tool resume");
      expect(description).not.toContain("conversation context restored");

      // What the tool actually does: inspect and report evidence, changing
      // nothing — stated plainly enough that a reader can't mistake it for a
      // relaunch.
      expect(description).toContain("report-only");
      expect(description).toContain("never relaunches the conversation");
    } finally {
      await daemon.stop();
    }
  });
});
