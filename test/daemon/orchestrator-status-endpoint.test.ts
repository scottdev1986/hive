import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { OrchestratorHostStatusSchema } from "../../src/daemon/orchestrator-host/orchestrator-host-contract";
import { HiveDaemon } from "../../src/daemon/server";

const observedAt = "2026-08-18T12:00:00.000Z";

function harness() {
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    db,
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-orchestrator-status-test",
  });
  const token = daemon.capabilities.mint("user", "user").token;
  const fetchStatus = () =>
    daemon.fetch(
      new Request("http://hive/orchestrator-status", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  return { daemon, db, fetchStatus };
}

describe("GET /orchestrator-status provider identity", () => {
  test("publishes the active root ProviderRun's exact provider and model", async () => {
    const { daemon, db, fetchStatus } = harness();
    const locator = {
      schemaVersion: 1 as const,
      instanceId: daemon.status.instanceId,
      subject: { kind: "root" as const },
      generation: 1,
      sessionId: "ses_01a014f0-0003-7000-8000-000000000629",
      hostKind: "sessiond" as const,
      engineBuildId: "orchestrator-status-test",
    };
    db.bindTerminalHostSession({
      locator,
      visibility: {
        workspaceSessionId: "workspace-orchestrator-status-test",
        workspacePid: 4_321,
        workspaceStartToken: "4321:1",
        openTerminalRevision: "1",
      },
    });
    db.insertProviderRun({
      runId: "01a014f0-0003-7000-8000-000000000630",
      agentId: null,
      terminal: locator,
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: null,
      conversationId: null,
      adapterChild: null,
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "orchestrator-status-test",
      startedAt: observedAt,
      endedAt: null,
      state: "running",
      exitReason: null,
    });

    const response = await fetchStatus();
    expect(response.status).toBe(200);
    const status = OrchestratorHostStatusSchema.parse(await response.json());
    expect(status.name).toBe("queen");
    expect(status.tool).toBe("codex");
    expect(status.model).toBe("gpt-5.6-sol");
    expect(status).not.toHaveProperty("taskDescription");
    await daemon.stop();
  });

  test("publishes null identity when no active root ProviderRun exists", async () => {
    const { daemon, fetchStatus } = harness();

    const response = await fetchStatus();
    expect(response.status).toBe(200);
    const status = OrchestratorHostStatusSchema.parse(await response.json());
    expect(status.name).toBe("queen");
    expect(status.tool).toBeNull();
    expect(status.model).toBeNull();
    expect(status).not.toHaveProperty("taskDescription");
    await daemon.stop();
  });
});
