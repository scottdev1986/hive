import { describe, expect, spyOn, test } from "bun:test";
import {
  AgentStatusConflictError,
  StatusService,
  statusProjectionForHookEvent,
  statusProjectionForProviderEvent,
} from "../../src/daemon/status-service/status-projection-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { StatusStore } from "../../src/daemon/status/status-store";
import type { AgentRecord } from "../../src/schemas/agent";
import type { ProviderRun } from "../../src/schemas/provider-run";
import { required } from "../required";

const AT = "2026-08-05T12:00:00.000Z";
const RUN_ID = "018f1e90-7b5a-7cc0-8000-000000000301";

function fixture() {
  const db = new HiveDatabase(":memory:");
  const agent: AgentRecord = {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6",
    category: "standard_coding",
    status: "working",
    taskDescription: "Unify status",
    worktreePath: "/tmp/maya",
    branch: "hive/maya",
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "status-service-test",
      subject: { kind: "agent", agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000302",
      hostKind: "sessiond",
      engineBuildId: "test",
    },
    contextPct: null,
    createdAt: AT,
    lastEventAt: AT,
    capabilityEpoch: 2,
    readOnly: false,
    writeRevoked: false,
  };
  const run: ProviderRun = {
    runId: RUN_ID,
    agentId: agent.id,
    terminal: required(agent.sessionLocator),
    provider: "codex",
    model: agent.model,
    effort: "high",
    conversationId: "codex-thread",
    adapterChild: {
      pid: 4_200,
      startToken: "4200:1",
      processGroupId: 4_200,
      observedAt: AT,
    },
    protocolReceipt: null,
    capabilityEpoch: agent.capabilityEpoch,
    launchGrantId: "status-service-grant",
    startedAt: AT,
    endedAt: null,
    state: "running",
    exitReason: null,
  };
  db.insertAgent(agent);
  db.insertProviderRun(run);
  const store = new StatusStore(db, "status-service-test");
  return {
    db,
    store,
    service: StatusService.fromStore(db, store),
  };
}

describe("StatusService", () => {
  test("one provider projection drives both the pane and canonical status", () => {
    expect(
      statusProjectionForProviderEvent({
        kind: "turn-idle",
        turnId: "turn-1",
        sequence: 2,
        occurredAt: AT,
        raw: {},
      }),
    ).toEqual({ turn: "done" });
    expect(
      statusProjectionForHookEvent({
        kind: "turn-failure",
        agentName: "maya",
        timestamp: AT,
      }),
    ).toEqual({ turn: "failed" });
  });

  test("preserves done instead of flattening it to idle", () => {
    const { db, service } = fixture();
    service.observeProvider({
      schemaVersion: 1,
      agent: "maya",
      providerRunId: RUN_ID,
      vendorSessionId: "codex-thread",
      providerSequence: 1,
      observedAt: AT,
      projection: { turn: "working" },
    });
    const status = required(
      service.observeProvider({
        schemaVersion: 1,
        agent: "maya",
        providerRunId: RUN_ID,
        vendorSessionId: "codex-thread",
        providerSequence: 2,
        observedAt: "2026-08-05T12:00:01.000Z",
        projection: { turn: "done" },
      }),
    );

    expect(status.turnState?.value).toBe("done");
    expect(
      service.dimensions(required(db.getAgentById("agent-maya"))).turn,
    ).toMatchObject({ kind: "observed", field: { value: "done" } });
    // The persisted compatibility column says the live session is between
    // turns; it is no longer consulted as turn truth.
    expect(db.getAgentById("agent-maya")?.status).toBe("idle");
    db.close();
  });

  test("deduplicates retries and rejects sequence regression", () => {
    const { db, service, store } = fixture();
    const report = {
      schemaVersion: 1 as const,
      agent: "maya",
      providerRunId: RUN_ID,
      vendorSessionId: "codex-thread",
      providerSequence: 2,
      observedAt: AT,
      projection: { turn: "done" as const },
    };
    service.observeProvider(report);
    service.observeProvider(report);
    expect(store.listEventsForAgent("agent-maya")).toHaveLength(1);
    expect(() =>
      service.observeProvider({
        ...report,
        providerSequence: 1,
        projection: { turn: "working" },
      }),
    ).toThrow(AgentStatusConflictError);
    db.close();
  });

  test("accepts and reads provider status without replaying either history stream", () => {
    const { db, service, store } = fixture();
    const listAll = spyOn(store, "listEvents");
    const listAgent = spyOn(store, "listEventsForAgent");

    service.observeProvider({
      schemaVersion: 1,
      agent: "maya",
      providerRunId: RUN_ID,
      vendorSessionId: "codex-thread",
      providerSequence: 1,
      observedAt: AT,
      projection: { runtime: "ready", turn: "working" },
    });
    expect(
      service.current(required(db.getAgentById("agent-maya"))),
    ).toMatchObject({
      runtimeState: { value: "ready" },
      turnState: { value: "working" },
    });
    expect(listAll).not.toHaveBeenCalled();
    expect(listAgent).not.toHaveBeenCalled();
    db.close();
  });

  test("keeps provider idempotency across status-service reconstruction", () => {
    const { db, service, store } = fixture();
    const report = {
      schemaVersion: 1 as const,
      agent: "maya",
      providerRunId: RUN_ID,
      vendorSessionId: "codex-thread",
      providerSequence: 2,
      observedAt: AT,
      projection: { turn: "done" as const },
    };
    service.observeProvider(report);

    const restarted = StatusService.fromStore(
      db,
      new StatusStore(db, "status-service-test"),
    );
    restarted.observeProvider(report);
    expect(store.listEventsForAgent("agent-maya")).toHaveLength(1);
    expect(() =>
      restarted.observeProvider({
        ...report,
        providerSequence: 1,
        projection: { turn: "working" },
      }),
    ).toThrow(AgentStatusConflictError);
    db.close();
  });

  test("routes hook fallback and rejected hook evidence through the service", () => {
    const { db, service, store } = fixture();
    const agent = required(db.getAgentById("agent-maya"));
    service.observeHook(
      agent,
      {
        kind: "turn-end",
        agentName: "maya",
        timestamp: AT,
        toolSessionId: "claude-session",
      },
      "accepted",
    );
    expect(service.current(agent).turnState?.value).toBe("done");

    service.observeHook(
      agent,
      {
        kind: "turn-start",
        agentName: "maya",
        timestamp: "2026-08-05T12:00:01.000Z",
        providerRunId: RUN_ID,
      },
      "rejected",
    );
    expect(store.listEventsForAgent(agent.id).at(-1)?.data).toEqual({});
    db.close();
  });
});
