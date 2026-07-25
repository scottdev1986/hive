import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/db";
import { recordProviderHookEvent } from "../../src/daemon/provider-events";
import type { AgentRecord, ProviderRun } from "../../src/schemas";

const at = "2026-07-24T19:00:00.000Z";

function agent(tool: AgentRecord["tool"]): AgentRecord {
  return {
    id: `agent-${tool}`,
    name: tool,
    tool,
    model: "measured-model",
    category: "standard_coding",
    status: "working",
    taskDescription: "Observe",
    worktreePath: `/tmp/${tool}`,
    branch: `hive/${tool}`,
    contextPct: 0,
    createdAt: at,
    lastEventAt: at,
    recoveryAttempts: 0,
    capabilityEpoch: 4,
    readOnly: false,
    writeRevoked: false,
  };
}

function run(value: AgentRecord): ProviderRun {
  return {
    runId:
      value.tool === "claude"
        ? "018f1e90-7b5a-7cc0-8000-000000000201"
        : value.tool === "codex"
          ? "018f1e90-7b5a-7cc0-8000-000000000202"
          : "018f1e90-7b5a-7cc0-8000-000000000203",
    agentId: value.id,
    terminal: {
      schemaVersion: 1,
      instanceId: "provider-event-test",
      subject: { kind: "agent", agentId: value.id },
      generation: 1,
      sessionId:
        value.tool === "claude"
          ? "ses_018f1e90-7b5a-7cc0-8000-000000000201"
          : "ses_018f1e90-7b5a-7cc0-8000-000000000202",
      hostKind: "sessiond",
      engineBuildId: "test",
    },
    provider: value.tool,
    model: value.model,
    effort: null,
    conversationId: null,
    pid: 4200,
    startToken: "4200:1",
    foregroundProcessGroupId: 4200,
    capabilityEpoch: value.capabilityEpoch,
    launchGrantId: `grant-${value.tool}`,
    startedAt: at,
    endedAt: null,
    state: "running",
    exitReason: null,
  };
}

describe("provider event normalization", () => {
  test("binds Claude and Codex events to the exact active run and conversation", () => {
    const db = new HiveDatabase(":memory:");
    try {
      for (const tool of ["claude", "codex"] as const) {
        const value = agent(tool);
        db.upsertAgent(value);
        const active = run(value);
        db.insertProviderRun(active);

        const first = recordProviderHookEvent(db, value, {
          kind: "turn-start",
          agentName: value.name,
          timestamp: at,
          toolSessionId: `${tool}-conversation`,
        });
        expect(first).toMatchObject({
          providerRunId: active.runId,
          provider: tool,
          capabilityEpoch: 4,
          conversationId: `${tool}-conversation`,
          kind: "turn-started",
        });
        recordProviderHookEvent(db, value, {
          kind: "turn-start",
          agentName: value.name,
          timestamp: at,
          toolSessionId: `${tool}-conversation`,
        });
        expect(db.listProviderEvents(active.runId)).toHaveLength(1);

        expect(
          recordProviderHookEvent(
            db,
            { ...value, capabilityEpoch: 5 },
            {
              kind: "turn-end",
              agentName: value.name,
              timestamp: at,
              toolSessionId: `${tool}-conversation`,
            },
          ),
        ).toBeNull();

        expect(
          recordProviderHookEvent(db, value, {
            kind: "turn-end",
            agentName: value.name,
            timestamp: at,
            toolSessionId: "wrong-conversation",
          }),
        ).toBeNull();
        // A hook left behind by a superseded run fires with a CURRENT
        // timestamp, so the run's startedAt guard cannot catch it. The run id
        // the settings file carries is what rejects it — and the session id
        // matches, which is exactly why a session id alone cannot do this.
        expect(
          recordProviderHookEvent(db, value, {
            kind: "turn-end",
            agentName: value.name,
            providerRunId: "018f1e90-7b5a-7cc0-8000-000000000299",
            timestamp: at,
            toolSessionId: `${tool}-conversation`,
          }),
        ).toBeNull();
        expect(db.listProviderEvents(active.runId)).toHaveLength(1);
      }
    } finally {
      db.close();
    }
  });

  test("retains the measured Claude tool name", () => {
    const db = new HiveDatabase(":memory:");
    try {
      const value = agent("claude");
      db.upsertAgent(value);
      const active = run(value);
      db.insertProviderRun({ ...active, conversationId: "claude-session" });
      expect(
        recordProviderHookEvent(db, value, {
          kind: "tool-boundary",
          agentName: value.name,
          timestamp: at,
          toolSessionId: "claude-session",
          toolName: "Read",
        }),
      ).toMatchObject({ kind: "tool-finished", toolName: "Read" });
    } finally {
      db.close();
    }
  });

  test("normalizes Grok hook metadata and rejects every stale binding", () => {
    const db = new HiveDatabase(":memory:");
    try {
      const value = agent("grok");
      db.upsertAgent(value);
      const active = run(value);
      db.insertProviderRun(active);
      const inputDigest = "a".repeat(64);
      expect(
        recordProviderHookEvent(db, value, {
          kind: "tool-start",
          agentName: value.name,
          providerRunId: active.runId,
          timestamp: at,
          toolSessionId: "grok-session",
          toolName: "read_file",
          inputDigest,
        }),
      ).toMatchObject({
        providerRunId: active.runId,
        provider: "grok",
        conversationId: "grok-session",
        kind: "tool-started",
        toolName: "read_file",
        inputDigest,
      });
      expect(
        recordProviderHookEvent(db, value, {
          kind: "turn-end",
          agentName: value.name,
          providerRunId: "018f1e90-7b5a-7cc0-8000-000000000299",
          timestamp: at,
          toolSessionId: "grok-session",
        }),
      ).toBeNull();
      expect(
        recordProviderHookEvent(db, value, {
          kind: "turn-end",
          agentName: value.name,
          timestamp: at,
          toolSessionId: "grok-session",
        }),
      ).toBeNull();
      expect(
        recordProviderHookEvent(db, value, {
          kind: "turn-end",
          agentName: value.name,
          providerRunId: active.runId,
          timestamp: "2026-07-24T18:59:59.999Z",
          toolSessionId: "grok-session",
        }),
      ).toBeNull();
      expect(
        recordProviderHookEvent(db, value, {
          kind: "turn-end",
          agentName: value.name,
          providerRunId: active.runId,
          timestamp: at,
          toolSessionId: "other-session",
        }),
      ).toBeNull();
      expect(db.listProviderEvents(active.runId)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
