import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { OrchestratorHostStatusSchema } from "../../src/daemon/orchestrator-host/orchestrator-host-contract";
import { HiveDaemon } from "../../src/daemon/server";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";

const observedAt = "2026-08-18T12:00:00.000Z";
const questionAt = "2026-08-18T12:01:00.000Z";

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
    expect(status.status).toBe("connecting");
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
    expect(status.status).toBe("disconnected");
    expect(status.tool).toBeNull();
    expect(status.model).toBeNull();
    expect(status).not.toHaveProperty("taskDescription");
    await daemon.stop();
  });

  test("preserves provider-native idle, done, and question states despite duplicate boundaries", async () => {
    const { daemon, db, fetchStatus } = harness();
    const runId = "01a014f0-0003-7000-8000-000000000631";
    const locator = {
      schemaVersion: 1 as const,
      instanceId: daemon.status.instanceId,
      subject: { kind: "root" as const },
      generation: 1,
      sessionId: "ses_01a014f0-0003-7000-8000-000000000632",
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
      runId,
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
    const rootToken = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
      { epoch: 0 },
    ).token;
    const report = (
      providerSequence: number,
      projection:
        | { runtime: "ready" | "disconnected" }
        | { turn: "idle" | "done" | "awaiting_answer" },
      at: string,
    ) =>
      daemon.fetch(
        new Request("http://hive/agent-status", {
          method: "POST",
          headers: {
            authorization: `Bearer ${rootToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schemaVersion: 1,
            agent: ORCHESTRATOR_NAME,
            providerRunId: runId,
            vendorSessionId: "queen-provider-session",
            providerSequence,
            observedAt: at,
            projection,
          }),
        }),
      );

    expect((await report(1, { runtime: "ready" }, observedAt)).status).toBe(
      200,
    );
    let status = OrchestratorHostStatusSchema.parse(
      await (await fetchStatus()).json(),
    );
    expect(status.status).toBe("ready");

    expect((await report(2, { turn: "idle" }, observedAt)).status).toBe(200);
    status = OrchestratorHostStatusSchema.parse(
      await (await fetchStatus()).json(),
    );
    expect(status.status).toBe("idle");

    expect((await report(3, { turn: "done" }, observedAt)).status).toBe(200);
    db.insertEvent({
      kind: "turn-end",
      agentName: ORCHESTRATOR_NAME,
      timestamp: questionAt,
      providerRunId: runId,
      toolSessionId: "queen-provider-session",
    });
    status = OrchestratorHostStatusSchema.parse(
      await (await fetchStatus()).json(),
    );
    expect(status.status).toBe("done");
    expect(status.statusObservedAt).toBe(observedAt);

    expect(
      (await report(4, { runtime: "disconnected" }, questionAt)).status,
    ).toBe(200);
    status = OrchestratorHostStatusSchema.parse(
      await (await fetchStatus()).json(),
    );
    expect(status.status).toBe("done");

    expect((await report(5, { runtime: "ready" }, questionAt)).status).toBe(
      200,
    );
    expect(
      (await report(6, { turn: "awaiting_answer" }, questionAt)).status,
    ).toBe(200);
    status = OrchestratorHostStatusSchema.parse(
      await (await fetchStatus()).json(),
    );
    expect(status.status).toBe("awaiting_answer");
    expect(status.statusObservedAt).toBe(questionAt);
    await daemon.stop();
  });
});
