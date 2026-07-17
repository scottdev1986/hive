import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../schemas";
import type { CaptureResult, SessionLocator } from "./session-host/contract";
import { HiveDatabase } from "./db";
import { HiveDaemon } from "./server";
import {
  agentRecordStatusIncarnationGenerationSource,
  type StatusIncarnationGenerationSource,
} from "./status-generation";
import {
  emptyStatusProjection,
  reconcileStatusSnapshot,
  reduceStatusEvent,
} from "./status-events";
import { StatusStore } from "./status-store";

const AT = "2026-07-16T12:00:00.000Z";
const SESSION_ID = "ses_018f1e90-7b5a-7cc0-8000-000000000001";
const REQUEST_ID = "req_018f1e90-7b5a-7cc0-8000-000000000002";

const agent = (name = "maya"): AgentRecord => ({
  id: `agent-${name}`,
  name,
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "working",
  taskDescription: "WP7",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  tmuxSession: `hive-${name}`,
  contextPct: null,
  createdAt: AT,
  lastEventAt: AT,
  recoveryAttempts: 0,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

const locator: SessionLocator = {
  schemaVersion: 1,
  instanceId: "instance-fixture",
  subject: { kind: "agent", agentId: "agent-maya" },
  generation: 1,
  sessionId: SESSION_ID,
  hostKind: "sessiond",
  engineBuildId: "engine-fixture",
};

const capture: CaptureResult = {
  locator,
  outputSeq: "4",
  columns: 80,
  rows: 24,
  screen: "primary",
  cursor: { row: 2, column: 3, visible: true },
  text: "terminal secret\nsecond row",
  truncated: false,
  sha256: "0".repeat(64),
};

const authorized = (daemon: HiveDaemon, token: string) =>
  (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

async function callTool(
  daemon: HiveDaemon,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const client = new Client({ name: "status-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
}

const fakeGenerationSource: StatusIncarnationGenerationSource = {
  async currentForAgent(agentId) {
    return agentId === "agent-maya"
      ? { kind: "available", generation: 1 }
      : { kind: "unavailable", reason: "SESSION_LOCATOR_UNAVAILABLE" };
  },
};

const harness = (
  generationSource: StatusIncarnationGenerationSource | null = fakeGenerationSource,
) => {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent());
  let captureCalls = 0;
  let daemon!: HiveDaemon;
  daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: { async spawn() { return agent("spawned"); } },
    repoRoot: "/tmp/hive-status-test",
    sessionHost: {
      async capture(currentLocator) {
        captureCalls += 1;
        return { ...capture, locator: currentLocator };
      },
    },
    resolveSessionLocator: async (sessionId, generation) =>
      sessionId === SESSION_ID && generation === 1
        ? { ...locator, instanceId: daemon.status.instanceId }
        : null,
    ...(generationSource === null
      ? {}
      : { statusIncarnationGenerationSource: generationSource }),
    resourceRunners: { orphans: null },
  });
  return { daemon, db, captureCalls: () => captureCalls };
};

describe("WP7 MCP status tools", () => {
  test("reads incarnation generation from the persisted agent locator", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertAgent(agent());
    const source = agentRecordStatusIncarnationGenerationSource((agentId) =>
      db.getAgentById(agentId)
    );

    expect(await source.currentForAgent("agent-maya")).toEqual({
      kind: "available",
      generation: 1,
    });
    expect(
      await agentRecordStatusIncarnationGenerationSource(() => ({}))
        .currentForAgent("agent-maya"),
    ).toEqual({
      kind: "unavailable",
      reason: "SESSION_LOCATOR_UNAVAILABLE",
    });
    db.close();
  });

  test("does not resurrect a closed failed-admission Assignment on restart", () => {
    const db = new HiveDatabase(":memory:");
    const failed = { ...agent(), status: "stuck" as const };
    db.insertAgent(failed);
    const statusStore = new StatusStore(db, "instance-fixture");
    statusStore.openAssignment(failed.id, failed.createdAt);
    statusStore.closeAssignment(failed.id, AT);
    new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      statusStore,
      spawner: { async spawn() { return agent("spawned"); } },
      repoRoot: "/tmp/hive-status-restart-test",
      resourceRunners: { orphans: null },
    });
    expect(statusStore.currentAssignment(failed.id)).toBeNull();
  });

  test("projects landed provider hooks into the typed status spine", async () => {
    const { daemon } = harness();
    await daemon.processEvent({
      kind: "turn-start",
      agentName: "maya",
      timestamp: AT,
      toolSessionId: "tool-fixture",
    });
    expect(daemon.status.listEvents()).toContainEqual(expect.objectContaining({
      kind: "status.turn",
      source: expect.objectContaining({ kind: "provider-hook" }),
      data: { value: "working" },
    }));
  });

  test("keeps one agent entity across live, snapshot, and resumed reduction", async () => {
    const { daemon } = harness();
    await daemon.processEvent({
      kind: "turn-start",
      agentName: "maya",
      timestamp: AT,
      toolSessionId: "tool-fixture",
    });
    let state = reconcileStatusSnapshot(
      emptyStatusProjection(),
      await daemon.status.fetchSnapshot(),
    );
    await daemon.processEvent({
      kind: "turn-end",
      agentName: "maya",
      timestamp: "2026-07-16T12:00:01.000Z",
      toolSessionId: "tool-fixture",
    });
    state = reduceStatusEvent(state, daemon.status.listEvents().at(-1)!);
    expect(Object.keys(state.entities)).toEqual(["agent:agent-maya"]);
  });

  test("binds status to the authenticated subject and rejects generation spoofing", async () => {
    const { daemon, db } = harness();
    const token = daemon.capabilities.mint("maya", "reader", { epoch: 0 }).token;
    const assignment = daemon.status.currentAssignment("agent-maya")!;
    const valid = {
      requestId: REQUEST_ID,
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "complete",
      progress: 100,
      summary: "Descriptive only",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 120,
    };
    const accepted = await callTool(daemon, token, "hive_update_status", valid);
    expect(accepted.isError).not.toBeTrue();
    expect(daemon.status.listEvents().at(-1)?.data.binding).toEqual({
      agentId: "agent-maya",
      incarnationGeneration: 1,
      role: "reader",
      instanceId: daemon.status.instanceId,
      capabilityEpoch: 0,
      issuer: "hive-daemon",
      session: null,
    });
    expect(db.getAgentByName("maya")?.status).toBe("working");
    expect(db.listApprovals()).toHaveLength(0);

    const spoofed = await callTool(daemon, token, "hive_update_status", {
      ...valid,
      requestId: "req_018f1e90-7b5a-7cc0-8000-000000000003",
      assignmentGeneration: "2",
    });
    expect(spoofed.isError).toBeTrue();
    expect(JSON.stringify(spoofed.content)).toContain("STATUS_ASSIGNMENT_MISMATCH");
  });

  test("fails closed with a typed error while the persisted locator source is unavailable", async () => {
    const { daemon } = harness(null);
    const token = daemon.capabilities.mint("maya", "reader", { epoch: 0 }).token;
    const assignment = daemon.status.currentAssignment("agent-maya")!;
    const result = await callTool(daemon, token, "hive_update_status", {
      requestId: "req_018f1e90-7b5a-7cc0-8000-000000000099",
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "testing",
      summary: "Must not report without an incarnation binding",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 120,
    });
    expect(result.isError).toBeTrue();
    expect(JSON.stringify(result.content)).toContain("STATUS_INCARNATION_UNAVAILABLE");
    expect(daemon.status.listEvents()).toHaveLength(0);
  });

  test("fails closed without content=true and audits authorized text without content", async () => {
    const { daemon, captureCalls } = harness();
    const metadataToken = daemon.capabilities.mint("maya", "writer", { epoch: 0 }).token;
    const metadata = await callTool(daemon, metadataToken, "hive_terminal_observe", {
      sessionId: SESSION_ID,
      generation: 1,
      include: "metadata",
      maxRows: 20,
    });
    expect(metadata.isError).not.toBeTrue();
    expect(JSON.stringify(metadata.content)).not.toContain("terminal secret");

    const refused = await callTool(daemon, metadataToken, "hive_terminal_observe", {
      sessionId: SESSION_ID,
      generation: 1,
      include: "visible-text",
      maxRows: 20,
    });
    expect(refused.isError).toBeTrue();
    expect(captureCalls()).toBe(1);

    const contentToken = daemon.capabilities.mint("maya", "writer", {
      epoch: 0,
      constraints: { content: true },
    }).token;
    const observed = await callTool(daemon, contentToken, "hive_terminal_observe", {
      sessionId: SESSION_ID,
      generation: 1,
      include: "visible-text",
      maxRows: 20,
    });
    expect(observed.isError).not.toBeTrue();
    const audit = daemon.status.listEvents().find((event) =>
      event.kind === "terminal.content-observed"
    );
    expect(audit?.data).toMatchObject({
      reader: "maya",
      subject: "agent-maya",
      rowCount: 2,
    });
    expect(JSON.stringify(audit)).not.toContain("terminal secret");
  });

  test("requires operator scope and an explicit subject allowlist for cross-agent text", async () => {
    const { daemon, db } = harness();
    db.insertAgent(agent("zara"));
    let scoped!: HiveDaemon;
    const crossLocator = (): SessionLocator => ({
      ...locator,
      instanceId: scoped.status.instanceId,
      subject: { kind: "agent", agentId: "agent-zara" },
    });
    scoped = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: { async spawn() { return agent("spawned"); } },
      repoRoot: "/tmp/hive-status-operator-test",
      sessionHost: {
        async capture(currentLocator) {
          return { ...capture, locator: currentLocator };
        },
      },
      resolveSessionLocator: async () => crossLocator(),
      resourceRunners: { orphans: null },
    });
    const unscoped = scoped.capabilities.mint("operator", "operator").token;
    const args = {
      sessionId: SESSION_ID,
      generation: 1,
      include: "visible-text",
      maxRows: 20,
    };
    expect((await callTool(scoped, unscoped, "hive_terminal_observe", args)).isError)
      .toBeTrue();

    const scopedToken = scoped.capabilities.mint("operator", "operator", {
      constraints: { scope: "operator" },
      subjects: ["agent-zara"],
    }).token;
    expect((await callTool(scoped, scopedToken, "hive_terminal_observe", args)).isError)
      .not.toBeTrue();
  });
});
