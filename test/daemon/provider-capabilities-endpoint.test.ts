import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { fuseAgentStatus } from "../../src/daemon/status-service/fusion";
import type { AgentRecord } from "../../src/schemas/agent";
import type { MeasuredProviderCapabilities } from "../../src/schemas/capability";

const AT = "2026-08-02T12:00:00.000Z";

const agent = (name: string): AgentRecord => ({
  id: `agent-${name}`,
  name,
  tool: "kimi",
  model: "kimi-k2",
  category: "simple_coding",
  status: "working",
  taskDescription: "provider capability report",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  contextPct: null,
  createdAt: AT,
  lastEventAt: AT,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

const capabilities = (version: string): MeasuredProviderCapabilities => ({
  provider: "kimi",
  runtime: {
    executable: "/usr/local/bin/kimi",
    version,
    transport: "acp",
    workingDirectory: "/tmp/hive-ada",
  },
  measured: {
    newSession: "supported",
    prompt: "supported",
    cancel: "supported",
    permissions: "supported",
    streamingText: "supported",
    toolLifecycle: "supported",
    sessionRecovery: "supported",
  },
  absences: {
    contextUsage: {
      reason: "Kimi does not report context usage",
      citation: "docs/evidence/protocol-terminal/kimi/conformance.json",
    },
  },
  handshake: { protocolVersion: 1 },
});

const harness = () => {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent("ada"));
  db.insertAgent(agent("bo"));
  const daemon = new HiveDaemon({
    db,
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: { spawn: async () => agent("spawned") },
    repoRoot: "/tmp/hive-provider-capabilities-test",
  });
  const token = daemon.capabilities.mint("ada", "writer", { epoch: 0 }).token;
  return { daemon, token };
};

const post = (
  daemon: HiveDaemon,
  token: string,
  subject: string,
  vendorSessionId: string,
  value: MeasuredProviderCapabilities,
) =>
  daemon.fetch(
    new Request("http://hive/provider-capabilities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        subject,
        vendorSessionId,
        capabilities: value,
      }),
    }),
  );

describe("provider-capabilities endpoint and status fusion", () => {
  test("retains one report per subject and replaces it on reconnect", async () => {
    const { daemon, token } = harness();
    expect(
      (await post(daemon, token, "ada", "kimi-session-1", capabilities("1")))
        .status,
    ).toBe(200);
    expect(
      (await post(daemon, token, "ada", "kimi-session-2", capabilities("2")))
        .status,
    ).toBe(200);

    const retained = daemon.status.providerCapabilitiesFor("ada");
    expect(retained?.vendorSessionId).toBe("kimi-session-2");
    expect(retained?.capabilities.runtime.version).toBe("2");
  });

  test("refuses a report for any subject but the authenticated caller", async () => {
    const { daemon, token } = harness();
    expect(
      (await post(daemon, token, "ada", "kimi-session-1", capabilities("1")))
        .status,
    ).toBe(200);

    const foreign = await post(
      daemon,
      token,
      "bo",
      "kimi-session-2",
      capabilities("2"),
    );
    expect(foreign.status).toBe(403);
    expect(daemon.status.providerCapabilitiesFor("bo")).toBeNull();
  });

  test("projects a proven absence with provider-protocol provenance", async () => {
    const { daemon, token } = harness();
    expect(
      (await post(daemon, token, "ada", "kimi-session-3", capabilities("3")))
        .status,
    ).toBe(200);

    const retained = daemon.status.providerCapabilitiesFor("ada");
    if (retained === null)
      throw new Error("capability report was not retained");
    const projection = fuseAgentStatus(
      [],
      { agentId: "agent-ada", incarnationGeneration: 1 },
      new Date(retained.observedAt),
      {},
      retained,
    );
    expect(projection.providerCapabilities?.source).toEqual({
      kind: "provider-protocol",
      id: "kimi-session-3",
    });
    expect(
      projection.providerCapabilities?.value?.absences?.contextUsage,
    ).toEqual({
      reason: "Kimi does not report context usage",
      citation: "docs/evidence/protocol-terminal/kimi/conformance.json",
    });
  });
});
