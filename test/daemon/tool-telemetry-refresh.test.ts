/**
 * After scanner deletion the refresh pass only keeps graphify call counts
 * current from provider tool events. Context, model, and turn no longer come
 * from vendor artifacts.
 */
import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { GraphifyCallCursor } from "../../src/daemon/observability/tool-telemetry";
import { refreshToolTelemetry } from "../../src/daemon/observability/tool-telemetry-refresh";
import type { AgentRecord } from "../../src/schemas/agent";
import type { ProviderRun } from "../../src/schemas/provider-run";

const at = "2026-08-02T12:00:00.000Z";

const locator = {
  schemaVersion: 1 as const,
  instanceId: "instance-1",
  subject: { kind: "agent" as const, agentId: "maya" },
  generation: 1,
  sessionId: "ses_018f4f5e-0000-7000-8000-000000000001",
  hostKind: "sessiond" as const,
  engineBuildId: "build-1",
};

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "maya",
    tool: "claude",
    model: "claude-haiku",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    sessionLocator: locator,
    toolSessionId: "session-1",
    contextPct: null,
    createdAt: at,
    lastEventAt: at,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

describe("refreshToolTelemetry", () => {
  test("counts graphify tools from the active provider run", async () => {
    const db = new HiveDatabase(":memory:");
    const record = agent();
    db.insertAgent(record);
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const run: ProviderRun = {
      runId,
      agentId: record.id,
      terminal: locator,
      provider: "claude",
      model: record.model,
      effort: null,
      conversationId: "sess-1",
      adapterChild: null,
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "grant-1",
      startedAt: at,
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    db.insertProviderRun(run);
    db.insertProviderEvent({
      eventId: "e1",
      providerRunId: runId,
      provider: "claude",
      capabilityEpoch: 0,
      conversationId: "sess-1",
      kind: "tool-started",
      occurredAt: "2026-08-02T12:00:01.000Z",
      toolName: "graphify__query_graph",
      inputDigest: null,
    });

    const graphifyCalls = new Map<string, GraphifyCallCursor>();
    await refreshToolTelemetry({
      db,
      // SAFETY: The test owns this value and its fields.
      graphify: {} as never,
      graphifyCalls,
    });

    expect(graphifyCalls.get(record.id)?.count).toBe(1);
    expect(graphifyCalls.get(record.id)?.path).toBe("protocol");
  });

  test("clears the count when graphify is not enabled", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertAgent(agent());
    const graphifyCalls = new Map<string, GraphifyCallCursor>([
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { path: "stale", offset: 0, count: 9 },
      ],
    ]);
    await refreshToolTelemetry({
      db,
      graphify: undefined,
      graphifyCalls,
    });
    expect(graphifyCalls.size).toBe(0);
  });

  test("does not invent a zero for a dead agent without a run", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertAgent(agent({ status: "dead" }));
    const graphifyCalls = new Map<string, GraphifyCallCursor>();
    await refreshToolTelemetry({
      db,
      // SAFETY: The test owns this value and its fields.
      graphify: {} as never,
      graphifyCalls,
    });
    expect(graphifyCalls.size).toBe(0);
  });
});
