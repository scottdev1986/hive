import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "bun:test";
import { ORCHESTRATOR_NAME, type AgentRecord } from "../schemas";
import { HiveUpdateStatusAdvertisedSchema } from "../schemas/status-envelope";
import type { CaptureResult, SessionLocator } from "./session-host/contract";
import { HiveDatabase } from "./db";
import { HiveDaemon } from "./server";
import type { RootSessiondLocator } from "./orchestrator-host";
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

async function listTools(daemon: HiveDaemon, token: string) {
  const client = new Client({ name: "status-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
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

  // A schema-respecting client can only send a real array or a real null if the
  // advertised schema says so; an empty `properties` makes it stringify both.
  test("advertises the real hive_update_status parameters to schema-respecting clients", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", { epoch: 0 }).token;
    const tools = await listTools(daemon, token);
    const schema = tools.find((tool) => tool.name === "hive_update_status")?.inputSchema;
    const properties = (schema?.properties ?? {}) as Record<string, unknown>;

    expect(Object.keys(properties).sort()).toEqual([
      "assignmentGeneration",
      "assignmentId",
      "blocker",
      "evidenceRefs",
      "freshForSeconds",
      "nextCheckpoint",
      "phase",
      "progress",
      "requestId",
      "summary",
    ]);
    expect(properties.evidenceRefs).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    // blocker is `string | null`, so a client must be told null is a legal value.
    expect(JSON.stringify(properties.blocker)).toContain('"null"');
    expect(JSON.stringify(properties.phase)).toContain("blocked");
    // requestId stays declared but optional: it is caller-minted and no agent
    // can discover one, so the daemon fills it in.
    expect(schema?.required).toEqual([
      "assignmentId",
      "assignmentGeneration",
      "summary",
      "evidenceRefs",
      "phase",
      "blocker",
    ]);
  });

  test("rejects the stringified argument shapes an empty schema produced", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", { epoch: 0 }).token;
    const assignment = daemon.status.currentAssignment("agent-maya")!;
    const stringified = await callTool(daemon, token, "hive_update_status", {
      requestId: REQUEST_ID,
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "complete",
      summary: "Stringified by a client that was told nothing",
      blocker: "null",
      evidenceRefs: "[]",
      freshForSeconds: 120,
    });
    expect(stringified.isError).toBeTrue();
    expect(daemon.status.listEvents()).toHaveLength(0);
  });

  // The acceptance bar: an agent knows its assignment id and generation from its
  // spawn prompt and can read them back from hive_status. Nothing anywhere hands
  // it a req_ value, so requiring one made the tool uncallable.
  test("accepts a report carrying only values the caller can discover", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", { epoch: 0 }).token;
    const assignment = daemon.status.currentAssignment("agent-maya")!;
    const accepted = await callTool(daemon, token, "hive_update_status", {
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "complete",
      summary: "Reported without minting an idempotency key",
      blocker: null,
      evidenceRefs: ["commit:fcc06d68"],
    });
    expect(accepted.isError).not.toBeTrue();
    const reported = daemon.status.listEvents().at(-1)!;
    expect(reported.kind).toBe("agent.status-reported");
    expect(reported.data.requestId).toMatch(
      /^req_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  // The advertised object schema cannot express the phase/blocker correlation
  // the validating union does, so the store has to keep rejecting it.
  test("still rejects a blocked report with no blocker the advertised schema permits", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", { epoch: 0 }).token;
    const assignment = daemon.status.currentAssignment("agent-maya")!;
    const args = {
      requestId: REQUEST_ID,
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      summary: "Blocked with nothing blocking",
      evidenceRefs: [],
      freshForSeconds: 120,
    };
    expect(HiveUpdateStatusAdvertisedSchema.safeParse({
      ...args,
      phase: "blocked",
      blocker: null,
    }).success).toBeTrue();

    const accepted = await callTool(daemon, token, "hive_update_status", {
      ...args,
      phase: "blocked",
      blocker: null,
    });
    expect(accepted.isError).toBeTrue();
    expect(daemon.status.listEvents()).toHaveLength(0);
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

  test("observes the exact bound root generation without inventing an agent row", async () => {
    const db = new HiveDatabase(":memory:");
    let daemon!: HiveDaemon;
    const rootLocator = (): RootSessiondLocator => ({
      schemaVersion: 1,
      instanceId: daemon.status.instanceId,
      subject: { kind: "root" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000010",
      hostKind: "sessiond",
      engineBuildId: "engine-root-fixture",
    });
    daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: { async spawn() { return agent("spawned"); } },
      repoRoot: "/tmp/hive-status-root-test",
      sessionHost: {
        async capture(currentLocator) {
          return { ...capture, locator: currentLocator };
        },
      },
      resolveSessionLocator: async (sessionId, generation) =>
        sessionId === rootLocator().sessionId && generation === 1
          ? rootLocator()
          : null,
      resourceRunners: { orphans: null },
    });
    const current = rootLocator();
    db.bindTerminalHostSession({
      locator: current,
      visibility: {
        workspaceSessionId: "workspace-root",
        workspacePid: 42,
        workspaceStartToken: "42:1",
        openTerminalRevision: "1",
      },
    });
    db.completeTerminalHostSession(current, {
      expectedExecutable: "codex",
      executableVerified: true,
      verifiedProviderRoot: null,
      geometry: {
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20,
      },
      visibility: {
        state: "visible",
        workspaceSessionId: "workspace-root",
        openTerminalRevision: "1",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });
    const token = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator", {
      epoch: 0,
      constraints: { content: true },
    }).token;

    const observed = await callTool(daemon, token, "hive_terminal_observe", {
      sessionId: current.sessionId,
      generation: current.generation,
      include: "visible-text",
      maxRows: 20,
    });

    expect(observed.isError).not.toBeTrue();
    expect(daemon.db.listAgents()).toEqual([]);
    expect(daemon.status.listEvents().find((event) =>
      event.kind === "terminal.content-observed"
    )?.data).toMatchObject({
      reader: ORCHESTRATOR_NAME,
      subject: "root",
      sessionGeneration: 1,
    });
    db.close();
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
