import { describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import type { RootSessiondLocator } from "../../src/daemon/orchestrator-host/orchestrator-host-contract";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  CaptureResult,
  SessionLocator,
} from "../../src/daemon/session-host/session-host-contract";
import { StatusStore } from "../../src/daemon/status/status-store";
import {
  emptyStatusProjection,
  reconcileStatusSnapshot,
  reduceStatusEvent,
} from "../../src/daemon/status-service/events";
import { fuseAgentStatus } from "../../src/daemon/status-service/fusion";
import {
  agentRecordStatusIncarnationGenerationSource,
  type StatusIncarnationGenerationSource,
} from "../../src/daemon/status-service/generation";
import { StatusService } from "../../src/daemon/status-service/status-projection-service";
import { shouldWarnForMissingTerminal } from "../../src/daemon/status-service/status-tools";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import { MAIL_CONTROL_LANE_CAPACITY } from "../../src/schemas/mail";
import { HiveUpdateStatusAdvertisedSchema } from "../../src/schemas/status-envelope";
import { required } from "../required";

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
  contextPct: null,
  createdAt: AT,
  lastEventAt: AT,
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
  rowStart: 0,
  screen: "primary",
  cursor: { row: 2, column: 3, visible: true },
  text: "terminal secret\nsecond row",
  styledText: "terminal secret\nsecond row",
  truncated: false,
  sha256: "0".repeat(64),
  composer: null,
};

test("missing terminal warnings ignore provider runs that already exited", () => {
  expect(shouldWarnForMissingTerminal({ state: "exited" })).toBe(false);
  expect(shouldWarnForMissingTerminal({ state: "running" })).toBe(true);
  expect(shouldWarnForMissingTerminal(null)).toBe(true);
});

const authorized =
  (daemon: HiveDaemon, token: string) =>
  (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Host", "127.0.0.1");
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
  completedBinding = false,
) => {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent());
  let captureCalls = 0;
  let daemon!: HiveDaemon;
  daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      async spawn() {
        return agent("spawned");
      },
    },
    repoRoot: "/tmp/hive-status-test",
    terminalHost: {
      async list() {
        throw new Error("sessiond unavailable in status fixture");
      },
    } as never,
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
  });
  if (completedBinding) {
    const boundLocator = { ...locator, instanceId: daemon.status.instanceId };
    db.upsertAgent({ ...agent(), sessionLocator: boundLocator });
    db.bindTerminalHostSession({
      locator: boundLocator,
      visibility: {
        workspaceSessionId: "workspace-status-fixture",
        workspacePid: 4_200,
        workspaceStartToken: "4200:1",
        openTerminalRevision: "1",
      },
    });
    db.completeTerminalHostSession(boundLocator, {
      expectedExecutable: "codex",
      executableVerified: true,
      verifiedShellRoot: null,
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
        workspaceSessionId: "workspace-status-fixture",
        openTerminalRevision: "1",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    });
  }
  return { daemon, db, captureCalls: () => captureCalls };
};

describe("WP7 MCP status tools", () => {
  test("projected agent identity includes the live capability epoch", async () => {
    const { daemon, db } = harness(fakeGenerationSource, true);
    const current = required(db.getAgentByName("maya"));
    db.upsertAgent({ ...current, capabilityEpoch: 7 });
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 7,
    }).token;

    const result = await callTool(daemon, token, "hive_status", {
      fields: ["name", "capabilityEpoch", "runId", "runIdReason"],
    });

    expect(result.isError).not.toBeTrue();
    expect(result.structuredContent).toMatchObject({
      agents: [
        {
          name: "maya",
          capabilityEpoch: 7,
          runId: null,
          runIdReason: "no-live-binding",
        },
      ],
      currentRun: {
        availability: "absent",
        reason: "no-active-run",
      },
    });
    await daemon.stop();
  });

  test("hive_status projects each live agent's open Assignment identifiers, or a measured null", async () => {
    const { daemon } = harness(fakeGenerationSource, true);
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    // The daemon boot opens an Assignment for every non-terminal agent with no
    // assignment history (server.ts constructor).
    const open = daemon.status.currentAssignment("agent-maya");
    if (open === null) throw new Error("expected an open Assignment for maya");

    const result = await callTool(daemon, token, "hive_status", {});

    expect(result.isError).not.toBeTrue();
    expect(result.structuredContent).toMatchObject({
      openAssignments: {
        maya: {
          assignmentId: open.assignmentId,
          assignmentGeneration: open.assignmentGeneration,
        },
      },
    });

    daemon.status.closeAssignment("agent-maya", new Date().toISOString());
    const closed = await callTool(daemon, token, "hive_status", {});
    expect(closed.structuredContent).toMatchObject({
      openAssignments: { maya: null },
    });
    await daemon.stop();
  });

  // A projection that finds nothing used to answer with a well-formed {} per
  // agent, which reads exactly like a record that has no such field. Every one of
  // these asked for something real and got silence back.
  test("a dotted path is refused by name instead of projecting to nothing", async () => {
    const { daemon } = harness(fakeGenerationSource, true);
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;

    const result = await callTool(daemon, token, "hive_status", {
      fields: ["agents.capabilityEpoch"],
    });

    expect(result.isError).toBeTrue();
    const message = JSON.stringify(result.content);
    expect(message).toContain("agents.capabilityEpoch");
    // The refusal has to hand back the legal set, or the caller's only next move
    // is to guess again.
    expect(message).toContain("capabilityEpoch");
    await daemon.stop();
  });

  test("a sibling section name is refused rather than emptying every agent", async () => {
    const { daemon } = harness(fakeGenerationSource, true);
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;

    const result = await callTool(daemon, token, "hive_status", {
      fields: ["settlementDebt"],
    });

    expect(result.isError).toBeTrue();
    expect(JSON.stringify(result.content)).toContain("settlementDebt");
    await daemon.stop();
  });

  // The legal set moves with `detail`, so the same fields array answers
  // differently at each level. Refusing this as unknown would be a lie: the field
  // exists, the caller just asked at the wrong detail.
  test("a full-detail-only field is refused with the detail hint, not as unknown", async () => {
    const { daemon } = harness(fakeGenerationSource, true);
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;

    const compact = await callTool(daemon, token, "hive_status", {
      fields: ["branch"],
    });

    expect(compact.isError).toBeTrue();
    const message = JSON.stringify(compact.content);
    expect(message).toContain("branch");
    expect(message).toContain('detail:\\"full\\"');
    expect(message).not.toContain("no agent field named");

    const full = await callTool(daemon, token, "hive_status", {
      detail: "full",
      fields: ["name", "branch"],
    });

    expect(full.isError).not.toBeTrue();
    expect(full.structuredContent).toMatchObject({
      agents: [{ name: "maya" }],
    });
    await daemon.stop();
  });

  // Neither detail level's keys contain the other's: the compact projection
  // computes runId, which no full record carries. So the wrong-detail refusal has
  // to point both ways, or asking for a field the compact reply returns happily
  // would be answered "no such field" at detail "full".
  test("a compact-only field is refused at full detail by naming the detail that has it", async () => {
    const { daemon } = harness(fakeGenerationSource, true);
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;

    const full = await callTool(daemon, token, "hive_status", {
      detail: "full",
      fields: ["runId"],
    });

    expect(full.isError).toBeTrue();
    const message = JSON.stringify(full.content);
    expect(message).toContain("runId");
    expect(message).toContain('detail:\\"active\\"');
    expect(message).not.toContain("no agent field named");

    const compact = await callTool(daemon, token, "hive_status", {
      fields: ["name", "runId"],
    });

    expect(compact.isError).not.toBeTrue();
    expect(compact.structuredContent).toMatchObject({
      agents: [{ name: "maya", runId: null }],
    });
    await daemon.stop();
  });

  // Validation must not depend on how many agents happen to be alive. A legal
  // set read off live records would let a typo through whenever nothing was
  // running and refuse the same call later, which is a worse trap than the silent
  // drop: it is the one that only bites once it matters.
  test("an unknown field is refused with no live agent to read a shape from", async () => {
    const { daemon, db } = harness(fakeGenerationSource, true);
    const current = required(db.getAgentByName("maya"));
    db.upsertAgent({ ...current, status: "done" });
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;

    const empty = await callTool(daemon, token, "hive_status", {
      fields: ["name"],
    });
    expect(empty.isError).not.toBeTrue();
    expect(empty.structuredContent).toMatchObject({ agents: [] });

    const refused = await callTool(daemon, token, "hive_status", {
      fields: ["nosuchfield"],
    });
    expect(refused.isError).toBeTrue();
    expect(JSON.stringify(refused.content)).toContain("nosuchfield");
    await daemon.stop();
  });

  test("root hive_status exposes currentRun hierarchy fences in its text payload", async () => {
    const { daemon, db } = harness(fakeGenerationSource, true);
    const hierarchy = new HierarchyStore(db);
    const runId = "run_019fbd11-3000-7000-8000-000000000001";
    const nodeId = "node_019fbd11-3000-7000-8000-000000000002";
    const digest = `sha256:${"a".repeat(64)}`;
    const current = required(db.getAgentByName("maya"));
    const locator = current.sessionLocator;
    if (locator === undefined) throw new Error("maya needs a live locator");
    hierarchy.putRun(
      {
        runId,
        revision: "1",
        repo: "hive",
        instanceId: daemon.status.instanceId,
        approvedSpec: null,
        currentPlan: { revision: "1", digest },
        topology: { revision: "1", digest },
        phase: "P1",
        g1: { state: "pending" },
        g2: { state: "pending" },
        baseSha: "b".repeat(40),
        budget: { revision: "1", digest },
        runEpoch: 0,
        lifecycle: "active",
      },
      null,
    );
    hierarchy.putNode(
      {
        nodeId,
        runId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    hierarchy.putAgentBinding(
      {
        nodeId,
        agentId: current.id,
        generation: locator.generation,
        provider: "codex",
        model: "gpt-5-codex",
        sessionLocator: locator,
        worktree: "/tmp/hive-maya",
        branch: "hive/maya",
        baseSha: "b".repeat(40),
        credentialId: "cred-maya",
        boundAt: AT,
        unboundAt: null,
      },
      runId,
    );
    const token = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator", {
      epoch: 0,
    }).token;

    const result = await callTool(daemon, token, "hive_status", {
      fields: ["name", "capabilityEpoch", "runId"],
    });

    expect(result.isError).not.toBeTrue();
    expect(result.structuredContent).toMatchObject({
      agents: [
        {
          name: "maya",
          capabilityEpoch: 0,
          runId,
        },
      ],
      currentRun: {
        availability: "present",
        runId,
        hierarchyRevision: "0",
        runEpoch: 0,
      },
    });
    const structured = result.structuredContent as {
      agents: Record<string, unknown>[];
      currentRun: Record<string, unknown>;
    };
    const row = structured.agents[0];
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "capabilityEpoch",
      "name",
      "runId",
    ]);
    const content = result.content[0];
    if (content?.type !== "text" || content.text === undefined) {
      throw new Error("expected hive_status text payload");
    }
    expect(JSON.parse(content.text)).toEqual({
      agents: structured.agents,
      currentRun: structured.currentRun,
    });

    const bindings = hierarchy.listAgentBindings();
    const binding = bindings[0];
    if (binding === undefined)
      throw new Error("maya needs a hierarchy binding");
    db.database
      .query(
        `INSERT INTO hierarchy_records
           (kind, id, runId, revision, capabilityEpoch, document)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "binding",
        "agent-maya-duplicate-binding",
        "run_019fbd11-3000-7000-8000-000000000003",
        "1",
        null,
        JSON.stringify({
          ...binding.binding,
          nodeId: "node_019fbd11-3000-7000-8000-000000000004",
        }),
      );
    const ambiguous = await callTool(daemon, token, "hive_status", {
      fields: ["name", "runId", "runIdReason"],
    });
    expect(ambiguous.isError).not.toBeTrue();
    expect(ambiguous.structuredContent).toMatchObject({
      agents: [
        {
          name: "maya",
          runId: null,
          runIdReason: "ambiguous-live-bindings",
        },
      ],
    });
    await daemon.stop();
  });

  test("bounds recent run outcomes newest-first when that section is present", async () => {
    const { daemon, db } = harness();
    for (let index = 0; index < 21; index += 1) {
      db.recordRunOutcome({
        decisionId: `decision-${index}`,
        providerRunId: `019ff121-2222-7000-8000-${String(index).padStart(12, "0")}`,
        provider: "codex",
        model: "gpt-5-codex",
        taskCategory: "simple_coding",
        outcome: "completed",
        handoffId: null,
        startedAt: AT,
        endedAt: new Date(Date.parse(AT) + index * 1_000).toISOString(),
      });
    }
    const token = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;
    const result = await callTool(daemon, token, "hive_status", {});
    const outcomes = (
      result.structuredContent as {
        recentRunOutcomes?: Array<{ decisionId: string }>;
      }
    ).recentRunOutcomes;
    if (outcomes === undefined) return;

    expect(outcomes).toHaveLength(20);
    expect(outcomes[0]?.decisionId).toBe("decision-20");
    expect(outcomes.at(-1)?.decisionId).toBe("decision-1");
  });

  test("hive_status scores the incident ledger it was given", async () => {
    const { daemon, db } = harness();
    db.recordIncidentExposure({
      exposureId: "019ff800-1111-7000-8000-000000000001",
      signature: "bun-env-mutation-never-reaches-spawned-children",
      observedAt: "2026-08-09T10:00:00.000Z",
      citedArticleIds: [],
      outcome: "hit",
      cost: { agentRuns: 2, wallMs: 3_600_000 },
    });
    db.recordIncidentExposure({
      exposureId: "019ff800-1111-7000-8000-000000000002",
      signature: "bun-env-mutation-never-reaches-spawned-children",
      observedAt: "2026-08-10T14:00:00.000Z",
      citedArticleIds: ["repo/testing/bun-env-mutation"],
      outcome: "avoided",
      witness: "recurrence-predicate",
    });
    const token = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;
    const result = await callTool(daemon, token, "hive_status", {});

    // Deliberately not tolerant of an absent section: the whole point of this
    // metric is that it is read in production, and a reader that returns
    // nothing looks identical to a world with no incidents.
    const metric = (
      result.structuredContent as {
        memoryIncidentMetric?: {
          avoidedRepeats: number;
          repeatIncidentRate: number | null;
          avoidedRepeatCost: { agentRuns: number; wallMs: number };
        };
      }
    ).memoryIncidentMetric;

    expect(metric?.avoidedRepeats).toBe(1);
    expect(metric?.repeatIncidentRate).toBe(0);
    expect(metric?.avoidedRepeatCost).toEqual({
      agentRuns: 2,
      wallMs: 3_600_000,
    });
  });

  test("hive_task_list exposes the task projection the status spine already builds", async () => {
    const { daemon, db } = harness();
    const hierarchy = new HierarchyStore(db);
    const runId = "run_019fbd11-2000-7000-8000-000000000001";
    const nodeId = "node_019fbd11-2000-7000-8000-000000000002";
    const taskId = "task_019fbd11-2000-7000-8000-000000000003";
    const grantId = "grant_019fbd11-2000-7000-8000-000000000004";
    const digest = `sha256:${"a".repeat(64)}`;
    const baseSha = "b".repeat(40);
    const root = { nodeId, agentId: ORCHESTRATOR_NAME, generation: 1 };
    hierarchy.putRun(
      {
        runId,
        revision: "1",
        repo: "hive",
        instanceId: daemon.status.instanceId,
        approvedSpec: null,
        currentPlan: { revision: "1", digest },
        topology: { revision: "1", digest },
        phase: "P1",
        g1: { state: "pending" },
        g2: { state: "pending" },
        baseSha,
        budget: { revision: "1", digest },
        runEpoch: 0,
        lifecycle: "active",
      },
      null,
    );
    hierarchy.putNode(
      {
        nodeId,
        runId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 0,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    hierarchy.putRootBinding(runId, nodeId);
    const task = {
      runId,
      taskId,
      revision: "1",
      parentTaskId: null,
      dependsOn: [],
      delegationSpec: {
        objective: "Prove the MCP board reads the status projection",
        parentAcceptanceIds: ["A1"],
        childOutcome: "The projected task is returned",
        terminationCondition: "The focused test passes",
        inputs: {
          specRevision: { revision: "1", digest },
          planRevision: { revision: "1", digest },
          taskRevisions: [],
          interfaceRevisions: [],
          baseSha,
          prerequisites: [],
          sourceArtifactRefs: [],
        },
        boundaries: { allowedPaths: ["src/daemon"] },
        authority: {
          grantId,
          permittedOperations: ["read"],
          environment: "test",
          worktree: "/repo",
          branch: "hive/root",
          explicitNonAuthority: [],
        },
        allowance: {
          sessions: 1,
          tokens: 1_000,
          costCents: 10,
          wallTimeMs: 60_000,
          retries: 0,
          blockers: [],
        },
      },
      acceptanceIds: ["A1"],
      assigneeNodeId: null,
      pathLeases: [{ path: "src/daemon", mode: "read" }],
      branch: "hive/root",
      baseSha,
      state: "planned",
      blockers: [],
      evidence: [],
      artifactRefs: [],
    } as const;
    const terminal = {
      schemaVersion: 1 as const,
      instanceId: daemon.status.instanceId,
      subject: { kind: "root" as const },
      generation: 1,
      sessionId: "ses_019fbd11-2000-7000-8000-000000000005",
      hostKind: "sessiond" as const,
      engineBuildId: "status-board-test",
    };
    db.bindTerminalHostSession({
      locator: terminal,
      visibility: {
        workspaceSessionId: "workspace-status-board-test",
        workspacePid: 1,
        workspaceStartToken: "workspace-status-board-test",
        openTerminalRevision: "1",
      },
    });
    db.insertProviderRun({
      runId: "019fbd11-2000-7000-8000-000000000006",
      agentId: null,
      terminal,
      provider: "codex",
      model: "gpt-5",
      effort: null,
      conversationId: null,
      adapterChild: null,
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "status-board-test",
      startedAt: AT,
      endedAt: null,
      state: "running",
      exitReason: null,
    });
    const token = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator", {
      epoch: 0,
    }).token;

    const created = await callTool(daemon, token, "hive_task_create", task);
    const result = await callTool(daemon, token, "hive_task_list", {});

    expect(created.isError).not.toBe(true);
    expect(hierarchy.getTask(taskId)?.delegationSpec.allowance.owner).toEqual(
      root,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      tasks: [
        {
          runId,
          tasks: {
            availability: "present",
            value: [{ taskId, state: "planned", ownerNodeId: nodeId }],
          },
        },
      ],
    });
    await daemon.stop();
    db.close();
  });

  test("reads incarnation generation from the persisted agent locator", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertAgent(agent());
    const source = agentRecordStatusIncarnationGenerationSource((agentId) =>
      db.getAgentById(agentId),
    );

    expect(await source.currentForAgent("agent-maya")).toEqual({
      kind: "available",
      generation: 1,
    });
    expect(
      await agentRecordStatusIncarnationGenerationSource(
        () => ({}),
      ).currentForAgent("agent-maya"),
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
      statusService: StatusService.fromStore(db, statusStore),
      spawner: {
        async spawn() {
          return agent("spawned");
        },
      },
      repoRoot: "/tmp/hive-status-restart-test",
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
    expect(daemon.status.listEvents()).toContainEqual(
      expect.objectContaining({
        kind: "status.turn",
        source: expect.objectContaining({ kind: "provider-hook" }),
        data: { value: "working" },
      }),
    );
  });

  test("the Agent UI reports done directly to the one status service", async () => {
    const { daemon, db } = harness(fakeGenerationSource, true);
    const boundLocator = { ...locator, instanceId: daemon.status.instanceId };
    const runId = "018f1e90-7b5a-7cc0-8000-000000000230";
    db.insertProviderRun({
      runId,
      agentId: "agent-maya",
      terminal: boundLocator,
      provider: "codex",
      model: "gpt-5-codex",
      effort: "high",
      conversationId: "codex-thread",
      adapterChild: {
        pid: 4_200,
        startToken: "4200:1",
        processGroupId: 4_200,
        observedAt: AT,
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "agent-status-endpoint-test",
      startedAt: AT,
      endedAt: null,
      state: "running",
      exitReason: null,
    });
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const response = await authorized(daemon, token)(
      "http://hive/agent-status",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          agent: "maya",
          providerRunId: runId,
          vendorSessionId: "codex-thread",
          providerSequence: 1,
          observedAt: AT,
          projection: { turn: "done" },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: { turnState: { value: "done" } },
      dimensions: { turn: { kind: "observed", field: { value: "done" } } },
    });
  });

  test("rootless queen reports drive orchestrator status instead of conflicting", async () => {
    const { daemon, db } = harness();
    const runId = "018f1e90-7b5a-7cc0-8000-000000000231";
    db.insertProviderRun({
      runId,
      agentId: null,
      terminal: {
        ...locator,
        subject: { kind: "root" },
        sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000231",
      },
      provider: "codex",
      model: "gpt-5-codex",
      effort: "high",
      conversationId: "queen-codex-thread",
      adapterChild: null,
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "queen-status-endpoint-test",
      startedAt: AT,
      endedAt: null,
      state: "running",
      exitReason: null,
    });
    const token = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator", {
      epoch: 0,
    }).token;
    const report = async (providerSequence: number, turn: "working" | "done") =>
      await authorized(daemon, token)("http://hive/agent-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          agent: ORCHESTRATOR_NAME,
          providerRunId: runId,
          vendorSessionId: "queen-codex-thread",
          providerSequence,
          observedAt: AT,
          projection: { turn },
        }),
      });

    expect((await report(1, "working")).status).toBe(200);
    expect(
      daemon.status.orchestratorStatus(
        db.recentOrchestratorSignals(ORCHESTRATOR_NAME),
      ),
    ).toBe("working");
    expect((await report(2, "done")).status).toBe(200);
    expect(
      daemon.status.orchestratorStatus(
        db.recentOrchestratorSignals(ORCHESTRATOR_NAME),
      ),
    ).toBe("idle");
  });

  test("session lifecycle cannot overwrite measured turn state", async () => {
    const { daemon, db } = harness();
    await daemon.processEvent({
      kind: "turn-start",
      agentName: "maya",
      timestamp: AT,
      toolSessionId: "tool-fixture",
    });
    await daemon.processEvent({
      kind: "session-start",
      agentName: "maya",
      timestamp: "2026-07-16T12:00:01.000Z",
      toolSessionId: "tool-fixture",
    });

    expect(db.getAgentByName("maya")?.status).toBe("working");
    expect(
      daemon.status
        .listEvents()
        .filter((event) => event.kind === "status.turn")
        .map((event) => event.data.value),
    ).toEqual(["working"]);
  });

  test("hive_status derives turn state after completed sessiond binding", async () => {
    const readStatus = async (
      events: ReadonlyArray<{
        source: "provider-hook" | "provider-protocol";
        value: "idle" | "working";
      }>,
    ) => {
      const { daemon } = harness(fakeGenerationSource, true);
      for (const [index, event] of events.entries()) {
        const observedAt = new Date(
          Date.parse(AT) + index * 1_000,
        ).toISOString();
        daemon.status.appendSourceEvent({
          entity: { kind: "agent", id: "agent-maya" },
          occurredAt: observedAt,
          kind: "status.turn",
          source: {
            kind: event.source,
            id: `${event.source}-fixture`,
            observedAt,
            confidence: "authoritative",
          },
          data: { value: event.value },
        });
      }
      const token = daemon.capabilities.mint("maya", "reader", {
        epoch: 0,
      }).token;
      const result = await callTool(daemon, token, "hive_status", {
        detail: "full",
      });
      expect(result.isError).not.toBeTrue();
      const agents = (result.structuredContent as { agents: AgentRecord[] })
        .agents;
      return required(agents.find((record) => record.id === "agent-maya"))
        .status;
    };

    expect(await readStatus([])).toBe("unknown");
    expect(
      await readStatus([{ source: "provider-protocol", value: "working" }]),
    ).toBe("working");
    expect(
      await readStatus([
        { source: "provider-hook", value: "idle" },
        { source: "provider-protocol", value: "working" },
      ]),
    ).toBe("working");
  });

  test("a stale run-bound Grok hook cannot mutate lifecycle status", async () => {
    const { daemon, db } = harness();
    db.upsertAgent({ ...agent(), tool: "grok", model: "grok-4" });
    const runId = "018f1e90-7b5a-7cc0-8000-000000000230";
    db.insertProviderRun({
      runId,
      agentId: "agent-maya",
      terminal: locator,
      provider: "grok",
      model: "grok-4",
      effort: null,
      conversationId: "grok-session",
      adapterChild: {
        pid: 4200,
        startToken: "4200:1",
        processGroupId: 4200,
        observedAt: AT,
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "grok-hook-test",
      startedAt: AT,
      endedAt: null,
      state: "running",
      exitReason: null,
    });

    await daemon.processEvent({
      kind: "turn-end",
      agentName: "maya",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000231",
      timestamp: "2026-07-16T12:00:01.000Z",
      toolSessionId: "grok-session",
    });
    expect(db.getAgentByName("maya")?.status).toBe("working");

    await daemon.processEvent({
      kind: "turn-end",
      agentName: "maya",
      providerRunId: runId,
      timestamp: "2026-07-16T12:00:02.000Z",
      toolSessionId: "grok-session",
    });
    expect(db.getAgentByName("maya")?.status).toBe("idle");
  });

  test("a phantom Grok subagent session proves liveness but rebinds nothing", async () => {
    const { daemon, db } = harness();
    db.upsertAgent({
      ...agent(),
      tool: "grok",
      model: "grok-4",
      status: "idle",
      toolSessionId: "grok-session",
    });
    const runId = "018f1e90-7b5a-7cc0-8000-000000000232";
    db.insertProviderRun({
      runId,
      agentId: "agent-maya",
      terminal: locator,
      provider: "grok",
      model: "grok-4",
      effort: null,
      conversationId: "grok-session",
      adapterChild: {
        pid: 4200,
        startToken: "4200:1",
        processGroupId: 4200,
        observedAt: AT,
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "grok-subagent-test",
      startedAt: AT,
      endedAt: null,
      state: "running",
      exitReason: null,
    });

    // A grok scheduled task spawns a subagent session in the agent's
    // worktree; its hooks carry the agent's run id with the subagent's own
    // session id. It must not mark the idle agent working and must not become
    // the recorded session identity — but it is still proof a process with
    // this name is alive, and the turn dimension has to say it was heard from
    // without saying whose turn it was.
    await daemon.processEvent({
      kind: "turn-start",
      agentName: "maya",
      providerRunId: runId,
      timestamp: "2026-07-16T12:00:01.000Z",
      toolSessionId: "phantom-subagent-session",
    });
    const after = db.getAgentByName("maya");
    expect(after?.status).toBe("idle");
    expect(after?.toolSessionId).toBe("grok-session");
    expect(after?.lastEventAt).toBe("2026-07-16T12:00:01.000Z");
    const phantomTurns = daemon.status
      .listEvents()
      .filter((event) => event.kind === "status.turn");
    // The observation is filed and carries no value, so nothing downstream can
    // read a turn out of it. A row with a value here would be the phantom
    // deciding the agent's status; no row at all would leave the dimension
    // claiming nobody ever reported, which is how an agent working behind an
    // unbindable run became indistinguishable from one that never started.
    expect(phantomTurns.map((event) => event.data.value)).toEqual([undefined]);
    expect(
      fuseAgentStatus(
        daemon.status.listEventsForAgent("agent-maya"),
        { agentId: "agent-maya", incarnationGeneration: null },
        new Date("2026-07-16T12:00:02.000Z"),
      ).turnState,
    ).toBeNull();
    expect(
      fuseAgentStatus(
        daemon.status.listEventsForAgent("agent-maya"),
        { agentId: "agent-maya", incarnationGeneration: null },
        new Date("2026-07-16T12:00:02.000Z"),
      ).absences.turn,
    ).not.toEqual({ kind: "unmeasured" });

    await daemon.processEvent({
      kind: "turn-start",
      agentName: "maya",
      providerRunId: runId,
      timestamp: "2026-07-16T12:00:02.000Z",
      toolSessionId: "grok-session",
    });
    expect(db.getAgentByName("maya")?.status).toBe("working");
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
    state = reduceStatusEvent(
      state,
      required(daemon.status.listEvents().at(-1)),
    );
    // Agent keys only: the snapshot also carries the agent-keyed stranded-work
    // row, which is not an agent entity and is what this test is about.
    expect(
      Object.keys(state.entities).filter((key) => key.startsWith("agent:")),
    ).toEqual(["agent:agent-maya"]);
  });

  // A schema-respecting client can only send a real array or a real null if the
  // advertised schema says so; an empty `properties` makes it stringify both.
  test("advertises the real hive_update_status parameters to schema-respecting clients", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const tools = await listTools(daemon, token);
    const schema = tools.find(
      (tool) => tool.name === "hive_update_status",
    )?.inputSchema;
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
    // The flat MCP object documents the same phase/blocker invariant that its
    // runtime refinement enforces.
    expect(JSON.stringify(properties.blocker)).toContain('"null"');
    expect(JSON.stringify(properties.blocker)).toContain(
      "only when phase is blocked",
    );
    expect(JSON.stringify(properties.phase)).toContain("blocked");
    // requestId stays declared but optional: the daemon mints it when omitted.
    expect(schema?.required).toEqual([
      "assignmentId",
      "assignmentGeneration",
      "summary",
      "evidenceRefs",
      "phase",
    ]);
  });

  test("rejects the stringified argument shapes an empty schema produced", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const assignment = required(daemon.status.currentAssignment("agent-maya"));
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

  // An agent knows its assignment id and generation from its spawn prompt and
  // can read them back from hive_status. Nothing anywhere hands it a req_ value,
  // so requiring one would make the tool uncallable.
  test("accepts an explicit null blocker for a non-blocked report", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const assignment = required(daemon.status.currentAssignment("agent-maya"));
    const accepted = await callTool(daemon, token, "hive_update_status", {
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "complete",
      summary: "Reported without minting an idempotency key",
      blocker: null,
      evidenceRefs: ["commit:fcc06d68"],
    });
    expect(accepted.isError).not.toBeTrue();
    const reported = required(daemon.status.listEvents().at(-1));
    expect(reported.kind).toBe("agent.status-reported");
    expect(reported.data.requestId).toMatch(
      /^req_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("reports how much mail is waiting, as a count and nothing else", async () => {
    const { daemon, db } = harness();
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const assignment = required(daemon.status.currentAssignment("agent-maya"));
    const report = async () =>
      (
        await callTool(daemon, token, "hive_update_status", {
          assignmentId: assignment.assignmentId,
          assignmentGeneration: assignment.assignmentGeneration,
          phase: "implementing",
          summary: "still working",
          evidenceRefs: ["commit:fcc06d68"],
        })
      ).structuredContent as { statusReport: Record<string, unknown> };

    expect((await report()).statusReport.mailBacklog).toBe(0);

    daemon.mail.publish({
      recipient: "maya",
      sender: ORCHESTRATOR_NAME,
      lane: "control",
      topic: "handoff",
      recipientGeneration: null,
      body: "one waiting instruction",
      idempotencyKey: "queen-backlog-1",
      ttlSeconds: null,
      expiresAt: null,
      now: new Date().toISOString(),
      controlLaneCapacity: MAIL_CONTROL_LANE_CAPACITY,
    });

    // A count, and only a count: the agent learns mail is waiting inside an
    // answer it already asked for, and goes and reads it when it chooses to.
    const after = (await report()).statusReport;
    expect(after.mailBacklog).toBe(1);
    expect(JSON.stringify(after)).not.toContain("one waiting instruction");
    void db;
    await daemon.stop();
  });

  test("accepts a non-blocked report without a blocker", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const assignment = required(daemon.status.currentAssignment("agent-maya"));
    const accepted = await callTool(daemon, token, "hive_update_status", {
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "complete",
      summary: "Reported without a blocker",
      evidenceRefs: ["commit:fcc06d68"],
    });
    expect(accepted.isError).not.toBeTrue();
  });

  test("advertised status validation enforces the phase/blocker contract", async () => {
    const { daemon } = harness();
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const assignment = required(daemon.status.currentAssignment("agent-maya"));
    const args = {
      requestId: REQUEST_ID,
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      summary: "Blocked with nothing blocking",
      evidenceRefs: [],
      freshForSeconds: 120,
    };
    expect(
      HiveUpdateStatusAdvertisedSchema.safeParse({
        ...args,
        phase: "blocked",
      }).success,
    ).toBeFalse();
    expect(
      HiveUpdateStatusAdvertisedSchema.safeParse({
        ...args,
        phase: "testing",
        blocker: "not valid outside the blocked phase",
      }).success,
    ).toBeFalse();
    expect(
      HiveUpdateStatusAdvertisedSchema.safeParse({
        ...args,
        phase: "blocked",
        blocker: "waiting on review",
      }).success,
    ).toBeTrue();

    const accepted = await callTool(daemon, token, "hive_update_status", {
      ...args,
      phase: "blocked",
    });
    expect(accepted.isError).toBeTrue();
    expect(daemon.status.listEvents()).toHaveLength(0);
  });

  test("binds status to the authenticated subject and rejects generation spoofing", async () => {
    const { daemon, db } = harness();
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const assignment = required(daemon.status.currentAssignment("agent-maya"));
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
    expect(JSON.stringify(spoofed.content)).toContain(
      "STATUS_ASSIGNMENT_MISMATCH",
    );
  });

  test("fails closed with a typed error while the persisted locator source is unavailable", async () => {
    const { daemon } = harness(null);
    const token = daemon.capabilities.mint("maya", "reader", {
      epoch: 0,
    }).token;
    const assignment = required(daemon.status.currentAssignment("agent-maya"));
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
    expect(JSON.stringify(result.content)).toContain(
      "STATUS_INCARNATION_UNAVAILABLE",
    );
    expect(daemon.status.listEvents()).toHaveLength(0);
  });

  test("fails closed without content=true and audits authorized text without content", async () => {
    const { daemon, captureCalls } = harness();
    const metadataToken = daemon.capabilities.mint("maya", "writer", {
      epoch: 0,
    }).token;
    const metadata = await callTool(
      daemon,
      metadataToken,
      "hive_terminal_observe",
      {
        sessionId: SESSION_ID,
        generation: 1,
        include: "metadata",
        maxRows: 20,
      },
    );
    expect(metadata.isError).not.toBeTrue();
    expect(JSON.stringify(metadata.content)).not.toContain("terminal secret");

    const refused = await callTool(
      daemon,
      metadataToken,
      "hive_terminal_observe",
      {
        sessionId: SESSION_ID,
        generation: 1,
        include: "visible-text",
        maxRows: 20,
      },
    );
    expect(refused.isError).toBeTrue();
    expect(captureCalls()).toBe(1);

    const contentToken = daemon.capabilities.mint("maya", "writer", {
      epoch: 0,
      constraints: { content: true },
    }).token;
    const observed = await callTool(
      daemon,
      contentToken,
      "hive_terminal_observe",
      {
        sessionId: SESSION_ID,
        generation: 1,
        include: "visible-text",
        maxRows: 20,
      },
    );
    expect(observed.isError).not.toBeTrue();
    const audit = daemon.status
      .listEvents()
      .find((event) => event.kind === "terminal.content-observed");
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
      spawner: {
        async spawn() {
          return agent("spawned");
        },
      },
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
      verifiedShellRoot: null,
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
    expect(
      daemon.status
        .listEvents()
        .find((event) => event.kind === "terminal.content-observed")?.data,
    ).toMatchObject({
      reader: ORCHESTRATOR_NAME,
      subject: "root",
      sessionGeneration: 1,
    });
    db.close();
  });

  test("requires user scope and an explicit subject allowlist for cross-agent text", async () => {
    const { db } = harness();
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
      spawner: {
        async spawn() {
          return agent("spawned");
        },
      },
      repoRoot: "/tmp/hive-status-user-test",
      sessionHost: {
        async capture(currentLocator) {
          return { ...capture, locator: currentLocator };
        },
      },
      resolveSessionLocator: async () => crossLocator(),
    });
    const unscoped = scoped.capabilities.mint("user", "user").token;
    const args = {
      sessionId: SESSION_ID,
      generation: 1,
      include: "visible-text",
      maxRows: 20,
    };
    expect(
      (await callTool(scoped, unscoped, "hive_terminal_observe", args)).isError,
    ).toBeTrue();

    const scopedToken = scoped.capabilities.mint("user", "user", {
      constraints: { scope: "user" },
      subjects: ["agent-zara"],
    }).token;
    expect(
      (await callTool(scoped, scopedToken, "hive_terminal_observe", args))
        .isError,
    ).not.toBeTrue();
  });
});
