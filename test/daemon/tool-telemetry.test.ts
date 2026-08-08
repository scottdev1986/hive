import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  countGraphifyFromProviderEvents,
  isGraphifyToolName,
  lastCodexTurnCompleted,
  lastGrokTurnCompleted,
  readNativeTurnCompleted,
} from "../../src/daemon/observability/tool-telemetry";
import { readGrokContextOccupancy } from "../../src/usage-service/context-occupancy";
import type { AgentRecord } from "../../src/schemas/agent";
import type { ProviderRun } from "../../src/schemas/provider-run";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tempRoot } from "../temp-root";

const at = "2026-08-02T12:00:00.000Z";

const locator = {
  schemaVersion: 1 as const,
  instanceId: "instance-1",
  subject: { kind: "agent" as const, agentId: "worker" },
  generation: 1,
  sessionId: "ses_018f4f5e-0000-7000-8000-000000000001",
  hostKind: "sessiond" as const,
  engineBuildId: "build-1",
};

describe("isGraphifyToolName", () => {
  test("accepts every vendor's graphify and graph_locate names", () => {
    expect(isGraphifyToolName("graphify__query_graph")).toBe(true);
    expect(isGraphifyToolName("graphify_query_graph")).toBe(true);
    expect(isGraphifyToolName("mcp__graphify__query_graph")).toBe(true);
    expect(isGraphifyToolName("hive__graph_locate")).toBe(true);
    expect(isGraphifyToolName("mcp__hive__graph_locate")).toBe(true);
    expect(isGraphifyToolName("hive_graph_locate")).toBe(true);
    expect(isGraphifyToolName("hive__hive_mail_publish")).toBe(false);
    expect(isGraphifyToolName("Read")).toBe(false);
  });
});

describe("countGraphifyFromProviderEvents", () => {
  test("counts tool-started events on the active run; null without a run", () => {
    const db = new HiveDatabase(":memory:");
    const agent: AgentRecord = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "worker",
      tool: "claude",
      model: "claude-haiku",
      category: "simple_coding",
      status: "working",
      taskDescription: "count tools",
      worktreePath: "/tmp/wt",
      branch: "hive/worker",
      sessionLocator: locator,
      contextPct: null,
      createdAt: at,
      lastEventAt: at,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    };
    db.insertAgent(agent);
    expect(countGraphifyFromProviderEvents(db, agent)).toBe(null);

    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const run: ProviderRun = {
      runId,
      agentId: agent.id,
      terminal: locator,
      provider: "claude",
      model: agent.model,
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
    db.insertProviderEvent({
      eventId: "e2",
      providerRunId: runId,
      provider: "claude",
      capabilityEpoch: 0,
      conversationId: "sess-1",
      kind: "tool-started",
      occurredAt: "2026-08-02T12:00:02.000Z",
      toolName: "Read",
      inputDigest: null,
    });
    db.insertProviderEvent({
      eventId: "e3",
      providerRunId: runId,
      provider: "claude",
      capabilityEpoch: 0,
      conversationId: "sess-1",
      kind: "tool-started",
      occurredAt: "2026-08-02T12:00:03.000Z",
      toolName: "hive__graph_locate",
      inputDigest: null,
    });
    expect(countGraphifyFromProviderEvents(db, agent)).toBe(2);
  });
});

describe("readGrokContextOccupancy", () => {
  test("reads the vendor's own occupancy percent; unknown without signals", async () => {
    const home = tempRoot("hive-grok-occupancy-");
    const worktree = join(home, "wt");
    mkdirSync(worktree);
    const sessionId = "session-1";
    const directory = join(
      home,
      ".grok",
      "sessions",
      encodeURIComponent(resolve(worktree)),
      sessionId,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "signals.json"),
      JSON.stringify({ contextWindowUsage: 42.6 }),
    );
    writeFileSync(
      join(directory, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: resolve(worktree) },
        current_model_id: "grok-4.5-build",
      }),
    );
    const grokHome = join(home, ".grok");
    expect(await readGrokContextOccupancy(worktree, sessionId, grokHome)).toBe(
      43,
    );
    expect(await readGrokContextOccupancy(worktree, undefined, grokHome)).toBe(
      null,
    );
  });
});

describe("native turn boundary readers", () => {
  test("malformed JSONL records are skipped", () => {
    const tail = [
      "not JSON",
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n");
    expect(lastCodexTurnCompleted(tail)).toBe(true);
  });

  test("codex task boundaries are newest-first", () => {
    const tail = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started" },
      }),
    ].join("\n");
    expect(lastCodexTurnCompleted(tail)).toBe(false);
  });

  test("grok turn_completed is idle", () => {
    const tail = JSON.stringify({
      params: { update: { sessionUpdate: "turn_completed" } },
    });
    expect(lastGrokTurnCompleted(tail)).toBe(true);
  });

  test("readNativeTurnCompleted reads a resolved path", async () => {
    const dir = tempRoot("hive-native-turn-");
    const path = join(dir, "updates.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        params: { update: { sessionUpdate: "agent_message_chunk" } },
      })}\n`,
    );
    expect(await readNativeTurnCompleted(path, "grok")).toBe(false);
    writeFileSync(
      path,
      `${JSON.stringify({
        params: { update: { sessionUpdate: "turn_completed" } },
      })}\n`,
    );
    expect(await readNativeTurnCompleted(path, "grok")).toBe(true);
  });
});
