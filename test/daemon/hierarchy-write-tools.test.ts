import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ZodError, type ZodType } from "zod";
import type { HiveToolRegistrar } from "../../src/daemon/authorization/mcp-tool-policy";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { registerHierarchyNodeTools } from "../../src/daemon/hierarchy-service/node-tools";
import type { AuthorityFences } from "../../src/daemon/hierarchy-service/records";
import { registerHierarchyWriteTools } from "../../src/daemon/hierarchy-service/write-tools";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { HiveDaemon } from "../../src/daemon/server";
import { SpawnAdmission } from "../../src/daemon/spawn/admission";
import { hierarchyStatusContext } from "../../src/daemon/status-service/status-tools";
import { hiveInstanceSuffix } from "../../src/hive-home/home";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type {
  AgentBinding,
  AgentBindingRef,
  DelegationGrant,
  DelegationSpec,
  HierarchyNode,
} from "../../src/schemas/hierarchy-node";
import type { Run } from "../../src/schemas/hierarchy-run";
import type {
  IntegrationStage,
  Review,
} from "../../src/schemas/integration-stage";
import type { OwnershipTransferInput } from "../../src/schemas/ownership-transfer";
import type {
  TaskCreateInput,
  TaskDetail,
} from "../../src/schemas/task-detail";
import { bumpCapabilityEpoch } from "./fence-state";
import {
  realCaller,
  seedBoundAgent,
  type ToolHandler,
  toolService,
} from "./hierarchy-tool-fixture";
import type { JsonObject } from "../../src/shared/json";
import { unsafeCast } from "../../src/shared/unsafe-cast";

const stamp = "2026-08-01T12:00:00.000Z";
const expiresAt = "2099-08-01T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const gitSha = "b".repeat(40);
const candidateSha = "c".repeat(40);

const runId = "run_019fbd11-0000-7000-8000-000000000001";
const taskId = "task_019fbd11-0000-7000-8000-000000000002";
const newTaskId = "task_019fbd11-0000-7000-8000-000000000003";
const missingTaskId = "task_019fbd11-0000-7000-8000-000000000004";
const ownerNodeId = "node_019fbd11-0000-7000-8000-000000000010";
const assigneeNodeId = "node_019fbd11-0000-7000-8000-000000000011";
const reviewerNodeId = "node_019fbd11-0000-7000-8000-000000000012";
const outsiderNodeId = "node_019fbd11-0000-7000-8000-000000000013";
const lostNodeId = "node_019fbd11-0000-7000-8000-000000000014";
const crewNodeId = "node_019fbd11-0000-7000-8000-000000000015";
const successorNodeId = "node_019fbd11-0000-7000-8000-000000000016";
const rootGrantId = "grant_019fbd11-0000-7000-8000-000000000020";
const workerGrantId = "grant_019fbd11-0000-7000-8000-000000000021";
const issuedGrantId = "grant_019fbd11-0000-7000-8000-000000000022";
const lostGrantId = "grant_019fbd11-0000-7000-8000-000000000024";
const successorGrantId = "grant_019fbd11-0000-7000-8000-000000000025";
const stageId = "stage_019fbd11-0000-7000-8000-000000000030";
const reviewId = "review_019fbd11-0000-7000-8000-000000000040";
const transferId = "transfer_019fbd11-0000-7000-8000-000000000060";
const foreignRunId = "run_019fbd11-0000-7000-8000-000000000101";
const foreignNodeId = "node_019fbd11-0000-7000-8000-000000000110";
const rootProviderRunId = "019fbd11-0000-7000-8000-000000000120";
const rootWorkerNodeId = "node_019fbd11-0000-7000-8000-000000000121";
const spawnNodeId = "node_019fbd11-0000-7000-8000-000000000122";
const spawnGrantId = "grant_019fbd11-0000-7000-8000-000000000123";

const ownerRef = {
  nodeId: ownerNodeId,
  agentId: "agent-01",
  generation: 1,
} as const;
const assigneeRef = {
  nodeId: assigneeNodeId,
  agentId: "agent-02",
  generation: 1,
} as const;
const reviewerRef = {
  nodeId: reviewerNodeId,
  agentId: "agent-03",
  generation: 1,
} as const;
const outsiderRef = {
  nodeId: outsiderNodeId,
  agentId: "agent-04",
  generation: 1,
} as const;
const lostRef = {
  nodeId: lostNodeId,
  agentId: "agent-05",
  generation: 1,
} as const;
const crewRef = {
  nodeId: crewNodeId,
  agentId: "agent-06",
  generation: 1,
} as const;
const successorRef = {
  nodeId: successorNodeId,
  agentId: "agent-07",
  generation: 1,
} as const;
const foreignRef = {
  nodeId: foreignNodeId,
  agentId: "agent-08",
  generation: 1,
} as const;
// The stored root principal, matching what putRootBinding records: spawn
// admission's grant chain exempts only a grant this ref issued.
const rootRef = {
  nodeId: ownerNodeId,
  agentId: ORCHESTRATOR_NAME,
  generation: 1,
} as const;
const rootWorkerRef = {
  nodeId: rootWorkerNodeId,
  agentId: "agent-root-worker",
  generation: 1,
} as const;
const spawnRef = {
  nodeId: spawnNodeId,
  agentId: "agent-spawn",
  generation: 1,
} as const;

const names = {
  owner: "owner",
  assignee: "assignee",
  reviewer: "reviewer",
  outsider: "outsider",
  lost: "lost",
  crew: "crew",
  successor: "successor",
} as const;

type ToolDefinition = {
  handler: ToolHandler;
  schema: ZodType;
};

type ToolOptions = {
  role?: "orchestrator" | "writer" | "reader";
  afterAuthorize?: () => void;
};

type ToolCase = {
  tool: string;
  action: string;
  actor: string;
  input: () => object;
  prepare?: () => void;
};

let db: HiveDatabase;
let store: HierarchyStore;

function run(): Run {
  return {
    runId,
    revision: "1",
    repo: "hive",
    instanceId: hiveInstanceSuffix(),
    spec: { revision: "1", digest },
    currentPlan: { revision: "1", digest },
    topology: { revision: "1", digest },
    phase: "P2",
    baseSha: gitSha,
    budget: { revision: "1", digest },
    runEpoch: 0,
    lifecycle: "active",
  };
}

function node(
  nodeId: string,
  parentNodeId: string | null,
  assignmentKind: HierarchyNode["assignmentKind"],
  organizationalRole: HierarchyNode["organizationalRole"] = "worker",
): HierarchyNode {
  return {
    nodeId,
    runId,
    parentNodeId,
    ownerNodeId: parentNodeId,
    organizationalRole,
    assignmentKind,
    taskScope: [taskId, newTaskId],
    capacityCharge: 1,
    lifecycle: "active",
    revision: "1",
  };
}

function delegationSpec(
  owner: AgentBindingRef = ownerRef,
  grantId = rootGrantId,
): DelegationSpec {
  return {
    objective: "Exercise authenticated hierarchy writes",
    parentAcceptanceIds: ["A1"],
    childOutcome: "The typed record is stored",
    terminationCondition: "The focused test passes",
    inputs: {
      specRevision: { revision: "1", digest },
      planRevision: { revision: "1", digest },
      taskRevisions: [],
      interfaceRevisions: [],
      baseSha: gitSha,
      prerequisites: [],
      sourceArtifactRefs: [],
    },
    boundaries: {
      allowedPaths: ["src/daemon"],
    },
    authority: {
      grantId,
      permittedOperations: ["read", "write", "test"],
      environment: "worktree",
      worktree: "/worktrees/assignee",
      branch: "hive/assignee",
      explicitNonAuthority: ["main"],
    },
    allowance: {
      sessions: 1,
      tokens: 5_000,
      costCents: 50,
      wallTimeMs: 600_000,
      retries: 1,
      blockers: [],
      owner,
    },
  };
}

function task(
  overrides: Partial<TaskDetail> = {},
  owner: AgentBindingRef = ownerRef,
): TaskDetail {
  return {
    taskId,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: delegationSpec(owner),
    acceptanceIds: ["A1"],
    ownerNodeId: owner.nodeId,
    assigneeNodeId,
    pathLeases: [{ path: "src/daemon", mode: "write" }],
    branch: "hive/assignee",
    baseSha: gitSha,
    state: "in-progress",
    blockers: [],
    evidence: [],
    artifactRefs: [],
    ...overrides,
  };
}

function taskCreateInput(
  overrides: Partial<TaskDetail> = {},
  owner: AgentBindingRef = ownerRef,
): TaskCreateInput {
  const full = task(overrides, owner);
  const { ownerNodeId: _ownerNodeId, delegationSpec, ...input } = full;
  const { owner: _owner, ...allowance } = delegationSpec.allowance;
  return {
    runId,
    ...input,
    delegationSpec: { ...delegationSpec, allowance },
  };
}

function stage(): IntegrationStage {
  return {
    stageId,
    revision: "1",
    kind: "run",
    runId,
    ownerNodeId: null,
    daemonRef: "refs/hive/write-tool-stage",
    baseSha: gitSha,
    headSha: gitSha,
    acceptedPromotionGrantIds: [],
    validation: { environment: "bun", evidenceArtifactRefs: [] },
    queueHighWater: 0,
    lifecycle: "active",
  };
}

function review(overrides: Partial<Review> = {}): Omit<Review, "reviewer"> {
  const value: Review = {
    reviewId,
    revision: "1",
    reviewer: reviewerRef,
    authors: [assigneeRef],
    candidate: {
      commitSha: candidateSha,
      patchDigest: digest,
      baseSha: gitSha,
    },
    revisions: {
      spec: { revision: "1", digest },
      task: { taskId, revision: "1" },
      contracts: [],
    },
    environment: { toolchain: "bun", environment: "test" },
    findings: [],
    verdict: "accepted",
    evidenceArtifactRefs: [],
    invalidation: { state: "current" },
    ...overrides,
  };
  const { reviewer: _reviewer, ...input } = value;
  return input;
}

function grant(overrides: Partial<DelegationGrant> = {}): DelegationGrant {
  return {
    grantId: rootGrantId,
    parentGrantId: null,
    issuer: ownerRef,
    subject: ownerRef,
    runId,
    taskIds: [taskId, newTaskId],
    descendantNodeIds: [
      ownerNodeId,
      assigneeNodeId,
      reviewerNodeId,
      outsiderNodeId,
      lostNodeId,
      crewNodeId,
      successorNodeId,
    ],
    paths: ["src/daemon"],
    branches: ["hive/assignee"],
    actions: ["read", "write", "test", "spawn", "message", "review"],
    budget: {
      sessions: 8,
      tokens: 50_000,
      costCents: 500,
      wallTimeMs: 3_600_000,
      retries: 4,
    },
    expiresAt,
    hierarchyRevision: "0",
    runEpoch: 0,
    capabilityEpoch: 1,
    status: "active",
    ...overrides,
  };
}

function grantInput(value: DelegationGrant): JsonObject {
  const {
    issuer: _issuer,
    capabilityEpoch: _capabilityEpoch,
    ...input
  } = value;
  return input;
}

function childGrant(
  grantId: string,
  subject: AgentBindingRef,
  overrides: Partial<DelegationGrant> = {},
): DelegationGrant {
  return grant({
    grantId,
    parentGrantId: rootGrantId,
    subject,
    descendantNodeIds: [subject.nodeId],
    actions: ["read", "write"],
    budget: {
      sessions: 1,
      tokens: 5_000,
      costCents: 50,
      wallTimeMs: 600_000,
      retries: 1,
    },
    ...overrides,
  });
}

function transfer(): OwnershipTransferInput {
  return {
    transferId,
    runId,
    lostOwnerNodeId: lostNodeId,
    successorNodeId,
    successorGrantId,
    createdAt: stamp,
  };
}

function bindingFor(name: string): AgentBinding {
  const agent = db.getAgentByName(name);
  if (agent?.sessionLocator === undefined) {
    throw new Error(`fixture agent ${name} has no session locator`);
  }
  const binding = store.findBindingByAgent(
    agent.id,
    agent.sessionLocator.generation,
  );
  if (binding === null) throw new Error(`fixture agent ${name} has no binding`);
  return binding;
}

function statusFences(name: string): {
  runId: string;
  hierarchyRevision: string;
  runEpoch: number;
} {
  const agent = db.getAgentByName(name);
  if (agent === null) throw new Error(`missing ${name} status agent`);
  const fences = hierarchyStatusContext(
    db,
    [agent],
    run().instanceId,
  ).currentRun;
  if (fences.availability !== "present") {
    throw new Error(`missing ${name} hierarchy fences in status`);
  }
  return fences;
}

function advanceHierarchyRevision(expectedHierarchyRevision: string): void {
  const reviewer = store.getNode(reviewerNodeId);
  if (reviewer === null) throw new Error("missing reviewer node");
  store.putNode(
    {
      ...reviewer,
      revision: (BigInt(reviewer.revision) + 1n).toString(),
      parentNodeId: assigneeNodeId,
      ownerNodeId: assigneeNodeId,
    },
    reviewer.revision,
    expectedHierarchyRevision,
  );
}

function rootSpawnInput(runEpoch: number): JsonObject {
  const spec = {
    ...delegationSpec(rootRef, spawnGrantId),
    inputs: {
      ...delegationSpec(rootRef, spawnGrantId).inputs,
      taskRevisions: [{ taskId: newTaskId, revision: "1" }],
    },
  };
  return {
    task: "Spawn the assigned hierarchy worker",
    category: "simple_coding",
    runId,
    runEpoch,
    nodeId: spawnNodeId,
    taskId: newTaskId,
    delegationSpec: spec,
    grantId: spawnGrantId,
    spawnBrief: {
      engineerConstraints: { excerpts: ["Keep the hierarchy fence strict"] },
      written: {
        goal: "Start the assigned worker",
        done: [],
        remaining: "provider launch",
        nextAction: "start",
        decisions: [],
        failures: [],
        uncertainty: "",
      },
    },
  };
}

function seedRootSpawnWorld(): void {
  seedRootAuthority();
  // Spawn admission's authority chain reads the approved SpecRevision and the
  // current PlanRevision from their own stores, not from the run record, so
  // both documents must exist at the run's approved refs.
  store.putSpecRevision({
    runId,
    revision: "1",
    digest,
    createdAt: stamp,
    lifecycle: "proposed",
    objective: "Spawn the assigned hierarchy worker under its fence",
    acceptanceIds: ["A1"],
    scope: "Root spawn admission",
    nonGoals: [],
    constraints: { architecture: [], security: [], outwardEffect: [] },
    gatePolicy: {
      reviewLocGreenMax: 100,
      reviewLocAmberMax: 250,
      reviewFilesMax: 10,
    },
    evidenceArtifactRefs: [],
    proposer: "queen",
    engineerApproval: null,
  });
  store.putPlanRevision(
    {
      runId,
      revision: "1",
      digest,
      createdAt: stamp,
      lifecycle: "proposed",
      parentRevision: null,
      taskDag: [{ taskId: newTaskId, dependsOn: [] }],
      topologyRationale: "One assigned spawn task",
      proposer: "queen",
    },
    0,
  );
  store.putNode(node(spawnNodeId, ownerNodeId, "author"), null);
  // SAFETY: rootSpawnInput builds this field with delegationSpec(), so the erased value has that contract.
  const spec = rootSpawnInput(0).delegationSpec as DelegationSpec;
  store.putTask(
    task({
      taskId: newTaskId,
      assigneeNodeId: spawnNodeId,
      state: "assigned",
      delegationSpec: spec,
    }),
  );
  // The spawn grant is root-issued, as production issues it: through the
  // run-root door, naming the stored root principal at capabilityEpoch 0.
  store.putGrant(
    grant({
      grantId: spawnGrantId,
      issuer: rootRef,
      subject: spawnRef,
      taskIds: [newTaskId],
      descendantNodeIds: [spawnNodeId],
      capabilityEpoch: 0,
    }),
    authorityFences(rootRef, 0),
    "run-root",
  );
}

function refreshGrant(
  grantId: string,
  fences: {
    hierarchyRevision: string;
    runEpoch: number;
  },
): void {
  const current = store.getGrant(grantId);
  if (current === null) throw new Error(`missing grant ${grantId}`);
  // A root-issued grant re-enters through the run-root door, which checks the
  // stored root principal and its epoch-0 record rather than a live binding.
  const rootIssued = store.rootBindingMatches(runId, current.issuer);
  store.putGrant(
    {
      ...current,
      hierarchyRevision: fences.hierarchyRevision,
      runEpoch: fences.runEpoch,
    },
    {
      expectedHierarchyRevision: fences.hierarchyRevision,
      expectedRunEpoch: fences.runEpoch,
      expectedCapabilityEpoch: current.capabilityEpoch,
      binding: current.issuer,
    },
    rootIssued ? "run-root" : "acting-binding",
  );
}

function authorityFences(
  binding: AgentBindingRef,
  capabilityEpoch = 1,
): AuthorityFences {
  return {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: capabilityEpoch,
    binding,
  };
}

function putGrantDirect(value: DelegationGrant): DelegationGrant {
  return store.putGrant(
    value,
    authorityFences(value.issuer, value.capabilityEpoch),
  );
}

function seedBaseWorld(): void {
  store.putRun(run(), null);
  store.putNode(
    node(ownerNodeId, null, "lead-coordination", "lead-worker"),
    null,
  );
  seedBoundAgent(db, store, {
    name: names.owner,
    agentId: ownerRef.agentId,
    nodeId: ownerNodeId,
    runId,
  });

  const conferral = {
    binding: ownerRef,
    expectedCapabilityEpoch: 1,
  };
  const nodes = [
    node(assigneeNodeId, ownerNodeId, "author"),
    node(reviewerNodeId, ownerNodeId, "reviewer"),
    node(outsiderNodeId, ownerNodeId, "author"),
    node(lostNodeId, ownerNodeId, "lead-coordination", "lead-worker"),
    node(crewNodeId, lostNodeId, "author"),
    node(successorNodeId, ownerNodeId, "lead-coordination", "lead-worker"),
  ];
  for (const value of nodes) {
    store.putNode(
      value,
      null,
      undefined,
      value.organizationalRole === "lead-worker" ? conferral : undefined,
    );
  }

  for (const [name, ref] of [
    [names.assignee, assigneeRef],
    [names.reviewer, reviewerRef],
    [names.outsider, outsiderRef],
    [names.lost, lostRef],
    [names.crew, crewRef],
    [names.successor, successorRef],
  ] as const) {
    seedBoundAgent(db, store, {
      name,
      agentId: ref.agentId,
      nodeId: ref.nodeId,
      runId,
    });
  }

  store.putTask(task());
  store.putIntegrationStage(stage(), null);
}

function seedRootAuthority(): void {
  store.putRootBinding(runId, ownerNodeId);
  const terminal = {
    schemaVersion: 1 as const,
    instanceId: run().instanceId,
    subject: { kind: "root" as const },
    generation: 7,
    sessionId: "ses_019fbd11-0000-7000-8000-000000000120",
    hostKind: "sessiond" as const,
    engineBuildId: "test-build",
  };
  db.bindTerminalHostSession({
    locator: terminal,
    visibility: {
      workspaceSessionId: "workspace-root-write-tool-test",
      workspacePid: 1,
      workspaceStartToken: "workspace-root-write-tool-test",
      openTerminalRevision: "1",
    },
  });
  db.insertProviderRun({
    runId: rootProviderRunId,
    agentId: null,
    terminal,
    provider: "codex",
    model: "gpt-5",
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch: 0,
    launchGrantId: "root-write-tool-test",
    startedAt: stamp,
    endedAt: null,
    state: "running",
    exitReason: null,
  });
}

function seedTransferWorld(): void {
  putGrantDirect(grant());
  putGrantDirect(
    childGrant(lostGrantId, lostRef, {
      descendantNodeIds: [lostNodeId, crewNodeId],
      actions: ["read", "write", "spawn"],
      budget: {
        sessions: 2,
        tokens: 15_000,
        costCents: 150,
        wallTimeMs: 1_200_000,
        retries: 2,
      },
    }),
  );
  putGrantDirect(
    childGrant(successorGrantId, successorRef, {
      descendantNodeIds: [successorNodeId, crewNodeId],
      actions: ["read", "write", "spawn"],
      budget: {
        sessions: 2,
        tokens: 15_000,
        costCents: 150,
        wallTimeMs: 1_200_000,
        retries: 2,
      },
    }),
  );
  const lost = bindingFor(names.lost);
  store.putAgentBinding({ ...lost, unboundAt: stamp }, runId);
}

function captureDefinitions() {
  const definitions = new Map<string, ToolDefinition>();
  const server = unsafeCast<HiveToolRegistrar>({
    registerTool: (
      name: string,
      config: { inputSchema: ZodType },
      handler: ToolHandler,
    ) => {
      definitions.set(name, { handler, schema: config.inputSchema });
    },
  });
  return { server, definitions };
}

function definitionFor(
  tool: string,
  actor: string,
  options: ToolOptions & { epoch?: number } = {},
): ToolDefinition {
  const { server, definitions } = captureDefinitions();
  const caller = realCaller(
    db,
    actor,
    options.role ?? "writer",
    options.epoch ?? 1,
  );
  const hierarchy = toolService(db, {
    now: () => new Date(stamp),
    authorizeTool: (capability, name, action, subject, auditAllow) => {
      caller.authorizeTool(capability, name, action, subject, auditAllow);
      options.afterAuthorize?.();
    },
  });
  registerHierarchyNodeTools(server, caller.capability, hierarchy);
  registerHierarchyWriteTools(server, caller.capability, hierarchy);
  const definition = definitions.get(tool);
  if (definition === undefined) throw new Error(`${tool} was not registered`);
  return definition;
}

function hierarchySnapshot() {
  return {
    fences: db.database
      .query(
        "SELECT runId, hierarchyRevision, runEpoch FROM hierarchy_fences ORDER BY runId",
      )
      .all(),
    records: db.database
      .query(
        `SELECT kind, id, runId, revision, capabilityEpoch, document
         FROM hierarchy_records ORDER BY kind, id`,
      )
      .all(),
  };
}

async function expectRefusal(
  work: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await work;
    expect.unreachable("write should have been refused");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    // SAFETY: The preceding runtime assertion establishes Error before its message is read.
    expect((error as Error).message).toBe(message);
  }
}

async function callMcpTool(
  daemon: HiveDaemon,
  token: string,
  name: string,
  args: JsonObject,
) {
  const client = new Client({ name: "hierarchy-write-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Host", "127.0.0.1");
        headers.set("Authorization", `Bearer ${token}`);
        return daemon.fetch(new Request(input, { ...init, headers }));
      },
    },
  );
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function currentRunFromTool(result: {
  content: Array<{ type: string; text?: string }>;
}): { runId: string; hierarchyRevision: string; runEpoch: number } {
  const content = result.content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("hive_status returned no text payload");
  }
  // SAFETY: hive_status owns this JSON payload; the optional fields are validated before use below.
  const value = JSON.parse(content.text) as {
    currentRun?: {
      availability: string;
      runId?: string;
      hierarchyRevision?: string;
      runEpoch?: number;
    };
  };
  const current = value.currentRun;
  if (
    current?.availability !== "present" ||
    current.runId === undefined ||
    current.hierarchyRevision === undefined ||
    current.runEpoch === undefined
  ) {
    throw new Error("hive_status returned no current hierarchy fences");
  }
  // SAFETY: The guard above established every required current-run field.
  return current as {
    runId: string;
    hierarchyRevision: string;
    runEpoch: number;
  };
}

async function expectUnrecognizedKeys(
  work: Promise<unknown>,
  keys: readonly string[],
): Promise<void> {
  try {
    await work;
    expect.unreachable("forged caller facts should have been refused");
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    // SAFETY: The preceding runtime assertion establishes ZodError before its issues are read.
    const unrecognizedKeys = (error as ZodError).issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys : [],
    );
    for (const key of keys) expect(unrecognizedKeys).toContain(key);
  }
}

function toolCases(): ToolCase[] {
  return [
    {
      tool: "hive_grant_issue",
      action: "grant:issue",
      actor: names.owner,
      input: () => grantInput(grant()),
    },
    {
      tool: "hive_task_create",
      action: "task:write",
      actor: names.owner,
      input: () => taskCreateInput({ taskId: newTaskId }),
    },
    {
      tool: "hive_task_update",
      action: "task:write",
      actor: names.assignee,
      input: () => ({ taskId, expectedRevision: "1", state: "blocked" }),
    },
    {
      tool: "hive_review_put",
      action: "review:write",
      actor: names.reviewer,
      input: () => review(),
    },
    {
      tool: "hive_ownership_transfer",
      action: "ownership:transfer",
      actor: names.owner,
      prepare: seedTransferWorld,
      input: () => ({
        transfer: transfer(),
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
      }),
    },
  ];
}

beforeEach(() => {
  db = new HiveDatabase(":memory:");
  store = new HierarchyStore(db);
  seedBaseWorld();
});

afterEach(() => {
  db.close();
});

describe("authenticated hierarchy writer positive paths", () => {
  test("root hive_spawn refuses a stale fence then accepts the status fence", async () => {
    seedRootSpawnWorld();
    const admission = new SpawnAdmission(store, () => new Date(stamp));
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      repoRoot: "/repo",
      spawner: {
        spawn: async (request) => {
          if (!("runId" in request)) {
            throw new Error("expected hierarchy spawn request");
          }
          // Mirror the production call site (hive-spawner.ts): preflight is
          // given exactly the hierarchy fields, never the whole spawn request.
          admission.preflight(
            {
              runId: request.runId,
              runEpoch: request.runEpoch,
              nodeId: request.nodeId,
              taskId: request.taskId,
              delegationSpec: request.delegationSpec,
              grantId: request.grantId,
              spawnBrief: request.spawnBrief,
            },
            "author",
          );
          const owner = db.getAgentByName(names.owner);
          if (owner === null) throw new Error("missing spawn test agent");
          return owner;
        },
      },
    });
    const token = daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator", {
      epoch: 0,
    }).token;
    // The GatedSpawner's succession admission runs before the spawn handler's
    // runEpoch fence and admits the root only with a verified checkpoint on
    // file, so record one through the production tool or the spawn never
    // reaches the fence this test asserts on.
    const checkpoint = await callMcpTool(daemon, token, "hive_run_checkpoint", {
      reason: "task-completion",
      contextUsage: {
        kind: "measured",
        residentTokens: 1_000,
        measuredAt: stamp,
      },
      decision: {
        decision: "compact",
        reason: "stable boundary before the fence proof",
      },
      written: {
        goal: "prove the root spawn runEpoch fence",
        done: ["hierarchy spawn world seeded"],
        failures: [],
        uncertainty: [],
        nextAction: "spawn the assigned hierarchy worker",
        rollback: "reseed the spawn world",
      },
      unresolvedQuestions: [],
      model: null,
    });
    expect(checkpoint.isError).not.toBeTrue();
    const stale = currentRunFromTool(
      await callMcpTool(daemon, token, "hive_status", {}),
    );
    store.advanceRunEpoch(runId, stale.runEpoch);
    const advanced = store.getFences(runId);
    if (advanced === null) throw new Error("missing advanced hierarchy fences");
    refreshGrant(spawnGrantId, advanced);
    const current = currentRunFromTool(
      await callMcpTool(daemon, token, "hive_status", {}),
    );

    const staleSpawn = await callMcpTool(
      daemon,
      token,
      "hive_spawn",
      rootSpawnInput(stale.runEpoch),
    );
    expect(staleSpawn.isError).toBeTrue();
    expect(JSON.stringify(staleSpawn.content)).toContain(
      `hierarchy spawn runEpoch ${String(stale.runEpoch)} is not the live runEpoch`,
    );
    const freshSpawn = await callMcpTool(
      daemon,
      token,
      "hive_spawn",
      rootSpawnInput(current.runEpoch),
    );
    expect(freshSpawn.isError).not.toBeTrue();
    await daemon.stop();
  });

  test("the rootless queen creates and updates a task as the genesis root principal", async () => {
    seedRootAuthority();
    // SAFETY: The named definition is hive_node_create, and node() matches its registered schema.
    await definitionFor("hive_node_create", ORCHESTRATOR_NAME, {
      role: "orchestrator",
      epoch: 0,
    }).handler(node(rootWorkerNodeId, ownerNodeId, "author") as never);
    // SAFETY: The named definition is hive_grant_issue, and grantInput() matches its registered schema.
    await definitionFor("hive_grant_issue", ORCHESTRATOR_NAME, {
      role: "orchestrator",
      epoch: 0,
    }).handler(
      grantInput(
        grant({
          issuer: rootRef,
          subject: rootWorkerRef,
          taskIds: [newTaskId],
          descendantNodeIds: [rootWorkerNodeId],
          capabilityEpoch: 0,
        }),
      ) as never,
    );
    const created = taskCreateInput(
      {
        taskId: newTaskId,
        assigneeNodeId: rootWorkerNodeId,
        state: "planned",
      },
      rootRef,
    );
    // SAFETY: The named definition is hive_task_create, and created came from taskCreateInput().
    await definitionFor("hive_task_create", ORCHESTRATOR_NAME, {
      role: "orchestrator",
      epoch: 0,
    }).handler(created as never);

    expect(store.getTask(newTaskId)?.delegationSpec.allowance.owner).toEqual(
      rootRef,
    );
    expect(store.getGrant(rootGrantId)?.subject).toEqual(rootWorkerRef);

    // SAFETY: The named definition is hive_task_update, and this object matches its registered schema.
    await definitionFor("hive_task_update", ORCHESTRATOR_NAME, {
      role: "orchestrator",
      epoch: 0,
    }).handler({
      taskId: newTaskId,
      expectedRevision: "1",
      state: "assigned",
    } as never);

    expect(store.getTask(newTaskId)).toMatchObject({
      revision: "2",
      state: "assigned",
      ownerNodeId,
    });
  });

  test("the root principal is refused without a live root provider run", async () => {
    store.putRootBinding(runId, ownerNodeId);

    // SAFETY: taskCreateInput() matches hive_task_create's registered schema.
    await expectRefusal(
      definitionFor("hive_task_create", ORCHESTRATOR_NAME, {
        role: "orchestrator",
        epoch: 0,
      }).handler(taskCreateInput({ taskId: newTaskId }, rootRef) as never),
      `root hierarchy authority has no active provider run for ${run().instanceId}`,
    );
    expect(store.getTask(newTaskId)).toBeNull();
  });

  test("the root principal is refused at a stale provider epoch", async () => {
    seedRootAuthority();

    // SAFETY: taskCreateInput() matches hive_task_create's registered schema.
    await expectRefusal(
      definitionFor("hive_task_create", ORCHESTRATOR_NAME, {
        role: "orchestrator",
        epoch: 1,
      }).handler(taskCreateInput({ taskId: newTaskId }, rootRef) as never),
      "root capability does not hold the live provider epoch",
    );
    expect(store.getTask(newTaskId)).toBeNull();
  });

  test("hive_grant_issue lets the run root issue a parentless grant and derives its epoch", async () => {
    // Flat rotation + matching capability: the grant pins the live flat epoch.
    bumpCapabilityEpoch(db, ownerRef);
    // SAFETY: grantInput() matches hive_grant_issue's registered schema.
    await definitionFor("hive_grant_issue", names.owner, { epoch: 2 }).handler(
      grantInput(grant()) as never,
    );

    expect(store.getGrant(rootGrantId)).toMatchObject({
      issuer: ownerRef,
      capabilityEpoch: 2,
    });
  });

  test("hive_grant_issue lets the same issuer update its own grant", async () => {
    const handler = definitionFor("hive_grant_issue", names.owner).handler;
    // SAFETY: grantInput() matches the captured hive_grant_issue schema.
    await handler(grantInput(grant()) as never);
    // SAFETY: grantInput() matches the captured hive_grant_issue schema.
    await handler(grantInput(grant({ status: "revoked" })) as never);

    expect(store.getGrant(rootGrantId)?.status).toBe("revoked");
  });

  test("hive_grant_issue refuses a stale fence then accepts the status fence", async () => {
    const stale = statusFences(names.owner);
    advanceHierarchyRevision(stale.hierarchyRevision);
    const fences = statusFences(names.owner);
    const handler = definitionFor("hive_grant_issue", names.owner).handler;

    // SAFETY: grantInput() matches the captured hive_grant_issue schema.
    await expectRefusal(
      handler(
        grantInput(
          grant({
            hierarchyRevision: stale.hierarchyRevision,
            runEpoch: stale.runEpoch,
          }),
        ) as never,
      ),
      `fence rejected: hierarchyRevision expected ${stale.hierarchyRevision}, current is ${fences.hierarchyRevision}`,
    );
    // SAFETY: grantInput() matches the captured hive_grant_issue schema.
    await handler(
      grantInput(
        grant({
          hierarchyRevision: fences.hierarchyRevision,
          runEpoch: fences.runEpoch,
        }),
      ) as never,
    );

    expect(store.getGrant(rootGrantId)?.grantId).toBe(rootGrantId);
  });

  test("hive_task_create stores a task for its exact allowance owner", async () => {
    bumpCapabilityEpoch(db, ownerRef);
    // SAFETY: The named handler receives taskCreateInput() and returns its registered task result.
    const result = (await definitionFor("hive_task_create", names.owner, {
      epoch: 2,
    }).handler(taskCreateInput({ taskId: newTaskId }) as never)) as {
      structuredContent: { task: JsonObject };
    };

    expect(store.getTask(newTaskId)?.delegationSpec.allowance.owner).toEqual(
      ownerRef,
    );
    expect(result.structuredContent.task).toEqual({
      taskId: newTaskId,
      revision: "1",
      state: "in-progress",
      assigneeNodeId,
      blockerCount: 0,
      evidenceCount: 0,
    });
    expect(result.structuredContent.task).not.toHaveProperty("delegationSpec");
  });

  test("hive_task_create lets a binding assign itself", async () => {
    // SAFETY: taskCreateInput() matches hive_task_create's registered schema.
    await definitionFor("hive_task_create", names.assignee).handler(
      taskCreateInput(
        {
          taskId: newTaskId,
          ownerNodeId: assigneeNodeId,
          assigneeNodeId,
        },
        assigneeRef,
      ) as never,
    );

    expect(store.getTask(newTaskId)?.assigneeNodeId).toBe(assigneeNodeId);
  });

  test("hive_task_update derives the assignee actor and performs the CAS", async () => {
    bumpCapabilityEpoch(db, assigneeRef);
    // SAFETY: This object matches hive_task_update's registered schema.
    await definitionFor("hive_task_update", names.assignee, {
      epoch: 2,
    }).handler({
      taskId,
      expectedRevision: "1",
      state: "blocked",
      blockers: ["waiting for review"],
    } as never);

    expect(store.getTask(taskId)).toMatchObject({
      revision: "2",
      state: "blocked",
      blockers: ["waiting for review"],
    });
  });

  test("only the owner can add a first-class correction", async () => {
    // SAFETY: This object matches hive_task_update's registered schema.
    await expectRefusal(
      definitionFor("hive_task_update", names.assignee).handler({
        taskId,
        expectedRevision: "1",
        correction: "Current truth",
      } as never),
      "only the task owner may correct its story",
    );
    // SAFETY: This object matches hive_task_update's registered schema.
    await definitionFor("hive_task_update", names.owner).handler({
      taskId,
      expectedRevision: "1",
      correction: "Current truth",
    } as never);
    expect(store.getTask(taskId)?.correction).toBe("Current truth");
  });

  test("hive_review_put derives and stores the reviewer binding", async () => {
    bumpCapabilityEpoch(db, reviewerRef);
    // SAFETY: review() matches hive_review_put's registered schema.
    await definitionFor("hive_review_put", names.reviewer, {
      epoch: 2,
    }).handler(review() as never);

    expect(store.getReview(reviewId, "1")?.reviewer).toEqual(reviewerRef);
  });

  test("hive_ownership_transfer records both live bindings at the current capability epoch", async () => {
    seedTransferWorld();
    bumpCapabilityEpoch(db, ownerRef);
    // SAFETY: This object matches hive_ownership_transfer's registered schema.
    await definitionFor("hive_ownership_transfer", names.owner, {
      epoch: 2,
    }).handler({
      transfer: transfer(),
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
    } as never);

    const stored = store.getOwnershipTransfer(transferId);
    expect(stored).toMatchObject({
      reason: "owner-bindings-unbound",
      actingBinding: ownerRef,
      actingCapabilityEpoch: 2,
      successorBinding: successorRef,
      successorCapabilityEpoch: 1,
    });
    expect(store.getNode(crewNodeId)).toMatchObject({
      parentNodeId: successorNodeId,
      ownerNodeId: successorNodeId,
    });
  });

  test("hive_ownership_transfer refuses a stale fence then accepts the status fence", async () => {
    seedTransferWorld();
    const stale = statusFences(names.owner);
    advanceHierarchyRevision(stale.hierarchyRevision);
    const fences = statusFences(names.owner);
    for (const grantId of [rootGrantId, lostGrantId, successorGrantId]) {
      refreshGrant(grantId, fences);
    }
    const handler = definitionFor(
      "hive_ownership_transfer",
      names.owner,
    ).handler;

    // SAFETY: This object matches the captured hive_ownership_transfer schema.
    await expectRefusal(
      handler({
        transfer: transfer(),
        expectedHierarchyRevision: stale.hierarchyRevision,
        expectedRunEpoch: stale.runEpoch,
      } as never),
      `fence rejected: hierarchyRevision expected ${stale.hierarchyRevision}, current is ${fences.hierarchyRevision}`,
    );
    // SAFETY: This object matches the captured hive_ownership_transfer schema.
    await handler({
      transfer: transfer(),
      expectedHierarchyRevision: fences.hierarchyRevision,
      expectedRunEpoch: fences.runEpoch,
    } as never);

    expect(store.getOwnershipTransfer(transferId)?.transferId).toBe(transferId);
  });
});

describe("task terminal state and owner-run guards", () => {
  test.each(["completed", "terminated"] as const)(
    "%s tasks refuse an explicit regression request and bump no revision",
    async (terminalState) => {
      const terminal = store.updateTask({
        taskId,
        expectedRevision: "1",
        actorNodeId: assigneeNodeId,
        state: terminalState,
      });
      expect(terminal.state).toBe(terminalState);

      // SAFETY: This object matches hive_task_update's registered schema.
      await expectRefusal(
        definitionFor("hive_task_update", names.assignee).handler({
          taskId,
          expectedRevision: "2",
          state: "in-progress",
        } as never),
        `task update cannot change state on a ${terminalState} task`,
      );

      // A refusal writes nothing and bumps no revision.
      expect(store.getTask(taskId)).toMatchObject({
        revision: "2",
        state: terminalState,
      });
    },
  );

  test("a terminal task stays terminal when the update omits input.state", async () => {
    store.updateTask({
      taskId,
      expectedRevision: "1",
      actorNodeId: assigneeNodeId,
      state: "completed",
    });

    // SAFETY: This object matches hive_task_update's registered schema.
    await definitionFor("hive_task_update", names.assignee).handler({
      taskId,
      expectedRevision: "2",
      blockers: ["late evidence note"],
    } as never);

    expect(store.getTask(taskId)).toMatchObject({
      revision: "3",
      state: "completed",
      blockers: ["late evidence note"],
    });
  });

  test("task create refuses a run closed after authorization", async () => {
    const before = hierarchySnapshot();
    const definition = definitionFor("hive_task_create", names.owner, {
      afterAuthorize: () => {
        const activeRun = store.getRun(runId);
        if (activeRun === null)
          throw new Error("active run fixture disappeared");
        store.putRun({ ...activeRun, revision: "2", lifecycle: "paused" }, "1");
      },
    });

    // SAFETY: taskCreateInput() matches the captured hive_task_create schema.
    await expectRefusal(
      definition.handler(taskCreateInput({ taskId: newTaskId }) as never),
      `run ${runId} must exist and be active`,
    );
    expect(hierarchySnapshot()).toEqual(before);
    expect(store.getTask(newTaskId)).toBeNull();
  });

  test("task update refuses an owner run removed after authorization", async () => {
    const before = hierarchySnapshot();
    const definition = definitionFor("hive_task_update", names.assignee, {
      afterAuthorize: () => {
        db.database
          .query("DELETE FROM hierarchy_records WHERE kind = 'run' AND id = ?")
          .run(runId);
      },
    });

    // SAFETY: This object matches the captured hive_task_update schema.
    await expectRefusal(
      definition.handler({
        taskId,
        expectedRevision: "1",
        state: "blocked",
      } as never),
      `run ${runId} must exist and be active`,
    );
    expect(hierarchySnapshot()).toEqual(before);
    expect(store.getTask(taskId)?.revision).toBe("1");
  });
});

describe("production capability gates", () => {
  test.each(toolCases())(
    "$tool is unreachable to the reader role",
    async ({ tool, action, actor, input, prepare }) => {
      prepare?.();
      const before = hierarchySnapshot();
      expect(before.records.length).toBeGreaterThan(0);

      // SAFETY: Each toolCases entry pairs its registered tool with a matching input builder.
      await expectRefusal(
        definitionFor(tool, actor, { role: "reader" }).handler(
          input() as never,
        ),
        `Role reader may not ${action}`,
      );
      expect(hierarchySnapshot()).toEqual(before);
    },
  );

  test.each(toolCases())(
    "$tool refuses a write-revoked writer",
    async ({ tool, actor, input, prepare }) => {
      prepare?.();
      const live = db.getAgentByName(actor);
      if (live === null) throw new Error(`missing ${actor} positive control`);
      db.upsertAgent({ ...live, writeRevoked: true });
      const before = hierarchySnapshot();

      // SAFETY: Each toolCases entry pairs its registered tool with a matching input builder.
      await expectRefusal(
        definitionFor(tool, actor).handler(input() as never),
        `Write and landing authority is revoked for ${actor}`,
      );
      expect(hierarchySnapshot()).toEqual(before);
    },
  );
});

describe("actor authorization", () => {
  test("a non-root agent without a stored binding is still refused", async () => {
    expect(db.getLiveAgentByName(names.outsider)?.id).toBe(outsiderRef.agentId);
    db.database
      .query("DELETE FROM hierarchy_records WHERE kind = 'binding' AND id = ?")
      .run(
        `${outsiderRef.nodeId}:${outsiderRef.agentId}:${String(outsiderRef.generation)}`,
      );
    expect(store.findBindingByAgent(outsiderRef.agentId, 1)).toBeNull();

    // SAFETY: This object matches hive_task_update's registered schema.
    await expectRefusal(
      definitionFor("hive_task_update", names.outsider).handler({
        taskId,
        expectedRevision: "1",
        state: "blocked",
      } as never),
      `agent ${names.outsider} holds no live hierarchy binding`,
    );
  });

  const cases: Array<ToolCase & { expected: () => string }> = [
    {
      tool: "hive_grant_issue",
      action: "grant:issue",
      actor: names.assignee,
      input: () =>
        grantInput(
          grant({
            grantId: issuedGrantId,
            issuer: assigneeRef,
            subject: assigneeRef,
            descendantNodeIds: [assigneeNodeId],
            actions: ["promote"],
            budget: {
              sessions: 999,
              tokens: 999_999_999,
              costCents: 999_999,
              wallTimeMs: 999_999_999,
              retries: 999,
            },
          }),
        ),
      expected: () =>
        `only the run root may issue a parentless grant; issuer node ${assigneeNodeId} is not the run root`,
    },
    {
      tool: "hive_grant_issue",
      action: "grant:issue",
      actor: names.assignee,
      prepare: () => {
        putGrantDirect(grant());
        putGrantDirect(childGrant(workerGrantId, assigneeRef));
      },
      input: () =>
        grantInput(
          grant({
            grantId: issuedGrantId,
            parentGrantId: workerGrantId,
            issuer: assigneeRef,
            subject: assigneeRef,
            descendantNodeIds: [assigneeNodeId],
            actions: ["read"],
            budget: {
              sessions: 1,
              tokens: 1_000,
              costCents: 10,
              wallTimeMs: 60_000,
              retries: 0,
            },
          }),
        ),
      expected: () =>
        `issuer node ${assigneeNodeId} is not lead-worker (organizationalRole=worker); only lead-workers and the run root may issue child grants`,
    },
    {
      tool: "hive_task_create",
      action: "task:write",
      actor: names.assignee,
      input: () =>
        taskCreateInput(
          {
            taskId: newTaskId,
            ownerNodeId: assigneeNodeId,
            assigneeNodeId: outsiderNodeId,
          },
          assigneeRef,
        ),
      expected: () =>
        `task assignee node ${outsiderNodeId} is outside owner ${assigneeNodeId}'s node subtree`,
    },
    {
      tool: "hive_task_update",
      action: "task:write",
      actor: names.outsider,
      input: () => ({ taskId, expectedRevision: "1", state: "blocked" }),
      expected: () => "task update requires the assignee or owner binding",
    },
    {
      tool: "hive_review_put",
      action: "review:write",
      actor: names.assignee,
      input: () => review(),
      expected: () =>
        `review caller node ${assigneeNodeId} has assignment kind author, not reviewer`,
    },
    {
      tool: "hive_ownership_transfer",
      action: "ownership:transfer",
      actor: names.outsider,
      prepare: seedTransferWorld,
      input: () => ({
        transfer: transfer(),
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
      }),
      expected: () =>
        `only the current owner of ${lostNodeId} may transfer its subtree`,
    },
  ];

  test.each(cases)(
    "$tool refuses the wrong hierarchy actor",
    async ({ tool, actor, input, prepare, expected }) => {
      prepare?.();
      const before = hierarchySnapshot();
      expect(store.getTask(taskId)?.taskId).toBe(taskId);

      // SAFETY: Each table entry pairs its registered tool with a matching input builder.
      await expectRefusal(
        definitionFor(tool, actor).handler(input() as never),
        expected(),
      );
      expect(hierarchySnapshot()).toEqual(before);
    },
  );

  test("grant subject same-run validation is independent of subtree containment", async () => {
    store.putRun(
      {
        ...run(),
        runId: foreignRunId,
        instanceId: "instance-foreign-run",
      },
      null,
    );
    store.putNode(
      {
        ...node(foreignNodeId, null, "author"),
        runId: foreignRunId,
        ownerNodeId: null,
      },
      null,
    );
    seedBoundAgent(db, store, {
      name: "foreign",
      agentId: foreignRef.agentId,
      nodeId: foreignNodeId,
      runId: foreignRunId,
    });
    expect(store.getNode(foreignNodeId)?.runId).toBe(foreignRunId);
    const before = hierarchySnapshot();

    // SAFETY: grantInput() matches the tool schema; the foreign subject is the domain error under test.
    await expectRefusal(
      definitionFor("hive_grant_issue", names.owner).handler(
        grantInput(
          grant({
            grantId: issuedGrantId,
            subject: foreignRef,
            descendantNodeIds: [foreignNodeId],
          }),
        ) as never,
      ),
      `grant subject ${foreignNodeId} belongs to run ${foreignRunId}, not grant run ${runId}`,
    );
    expect(hierarchySnapshot()).toEqual(before);
  });

  test("grant subject subtree validation is independent of same-run validation", async () => {
    putGrantDirect(grant({ subject: lostRef }));
    expect(store.getNode(outsiderNodeId)?.runId).toBe(runId);
    const before = hierarchySnapshot();

    // SAFETY: grantInput() matches the tool schema; subtree authority is the domain error under test.
    await expectRefusal(
      definitionFor("hive_grant_issue", names.lost).handler(
        grantInput(
          childGrant(issuedGrantId, outsiderRef, {
            issuer: lostRef,
          }),
        ) as never,
      ),
      `grant subject ${outsiderNodeId} is outside issuer ${lostNodeId}'s real node subtree`,
    );
    expect(hierarchySnapshot()).toEqual(before);
  });

  test("task assignee same-run validation is independent of subtree containment", async () => {
    store.putRun(
      {
        ...run(),
        runId: foreignRunId,
        instanceId: "instance-foreign-task-run",
      },
      null,
    );
    store.putNode(
      {
        ...node(foreignNodeId, null, "author"),
        runId: foreignRunId,
        ownerNodeId: null,
      },
      null,
    );
    expect(store.getNode(foreignNodeId)?.runId).toBe(foreignRunId);
    const before = hierarchySnapshot();

    // SAFETY: taskCreateInput() matches the schema; the foreign assignee is the domain error under test.
    await expectRefusal(
      definitionFor("hive_task_create", names.owner).handler(
        taskCreateInput({
          taskId: newTaskId,
          assigneeNodeId: foreignNodeId,
        }) as never,
      ),
      `task assignee node ${foreignNodeId} belongs to run ${foreignRunId}, not owner run ${runId}`,
    );
    expect(hierarchySnapshot()).toEqual(before);
    expect(store.getTask(newTaskId)).toBeNull();
  });
});

describe("final-transaction caller fences", () => {
  test.each(toolCases())(
    "$tool refuses a flat capability rotated after the outer authorization",
    async ({ tool, actor, input, prepare }) => {
      prepare?.();
      const before = hierarchySnapshot();
      const agentBefore = db.getAgentByName(actor);
      if (agentBefore === null)
        throw new Error(`missing ${actor} positive control`);

      const definition = definitionFor(tool, actor, {
        afterAuthorize: () => {
          const live = db.getAgentByName(actor);
          if (live === null)
            throw new Error(`missing ${actor} during mutation`);
          db.upsertAgent({
            ...live,
            capabilityEpoch: live.capabilityEpoch + 1,
          });
        },
      });
      // SAFETY: Each toolCases entry pairs its registered tool with a matching input builder.
      await expectRefusal(
        definition.handler(input() as never),
        `caller ${actor} does not hold the live capability epoch`,
      );

      expect(hierarchySnapshot()).toEqual(before);
      expect(db.getAgentByName(actor)).toEqual(agentBefore);
    },
  );

  test.each(toolCases())(
    "$tool refuses a binding killed after the outer authorization",
    async ({ tool, actor, input, prepare }) => {
      prepare?.();
      const before = hierarchySnapshot();
      const bindingBefore = bindingFor(actor);

      const definition = definitionFor(tool, actor, {
        afterAuthorize: () => {
          const live = bindingFor(actor);
          store.putAgentBinding({ ...live, unboundAt: stamp }, runId);
        },
      });
      // SAFETY: Each toolCases entry pairs its registered tool with a matching input builder.
      await expectRefusal(
        definition.handler(input() as never),
        `agent ${actor} holds no live hierarchy binding`,
      );

      expect(hierarchySnapshot()).toEqual(before);
      expect(bindingFor(actor)).toEqual(bindingBefore);
    },
  );

  test("grant issuance cannot replace another binding's grant id", async () => {
    putGrantDirect(grant());
    putGrantDirect(childGrant(successorGrantId, successorRef));
    const before = hierarchySnapshot();

    // SAFETY: grantInput() matches the schema; issuer ownership is the domain error under test.
    await expectRefusal(
      definitionFor("hive_grant_issue", names.successor).handler(
        grantInput(
          grant({
            grantId: rootGrantId,
            parentGrantId: successorGrantId,
            issuer: successorRef,
            subject: successorRef,
            descendantNodeIds: [successorNodeId],
            actions: ["read"],
            budget: {
              sessions: 1,
              tokens: 1_000,
              costCents: 10,
              wallTimeMs: 60_000,
              retries: 0,
            },
          }),
        ) as never,
      ),
      `grant ${rootGrantId} is already issued by ${ownerRef.agentId}@${ownerRef.nodeId}; ${successorRef.agentId}@${successorRef.nodeId} may not replace it`,
    );

    expect(hierarchySnapshot()).toEqual(before);
    expect(store.getGrant(rootGrantId)?.issuer).toEqual(ownerRef);
  });
});

describe("strict tool inputs reject forged caller facts", () => {
  test.each([
    {
      tool: "hive_grant_issue",
      actor: names.owner,
      valid: () => grantInput(grant()),
      forged: () => ({
        ...grantInput(grant()),
        issuer: outsiderRef,
        capabilityEpoch: 99,
      }),
      forgedKeys: ["issuer", "capabilityEpoch"],
    },
    {
      tool: "hive_task_create",
      actor: names.owner,
      valid: () => taskCreateInput({ taskId: newTaskId }),
      forged: () => {
        const valid = taskCreateInput({ taskId: newTaskId });
        return {
          ...valid,
          ownerNodeId: outsiderNodeId,
          delegationSpec: {
            ...valid.delegationSpec,
            allowance: {
              ...valid.delegationSpec.allowance,
              owner: outsiderRef,
            },
          },
        };
      },
      forgedKeys: ["ownerNodeId", "owner"],
    },
    {
      tool: "hive_task_update",
      actor: names.assignee,
      valid: () => ({ taskId, expectedRevision: "1", state: "blocked" }),
      forged: () => ({
        taskId,
        expectedRevision: "1",
        state: "blocked",
        actorNodeId: ownerNodeId,
      }),
      forgedKeys: ["actorNodeId"],
    },
    {
      tool: "hive_review_put",
      actor: names.reviewer,
      valid: () => review(),
      forged: () => ({ ...review(), reviewer: outsiderRef }),
      forgedKeys: ["reviewer"],
    },
    {
      tool: "hive_ownership_transfer",
      actor: names.owner,
      valid: () => ({
        transfer: transfer(),
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
      }),
      forged: () => ({
        transfer: {
          ...transfer(),
          reason: "caller-authored-loss",
          actingBinding: outsiderRef,
        },
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
      }),
      forgedKeys: ["reason", "actingBinding"],
    },
  ])(
    "$tool rejects caller-supplied identity",
    async ({ tool, actor, valid, forged, forgedKeys }) => {
      const definition = definitionFor(tool, actor);
      expect(definition.schema.safeParse(valid()).success).toBe(true);
      expect(definition.schema.safeParse(forged()).success).toBe(false);
      const before = hierarchySnapshot();

      // SAFETY: This negative-path call deliberately passes the schema-rejected fixture to verify runtime refusal.
      await expectUnrecognizedKeys(
        definition.handler(forged() as never),
        forgedKeys,
      );
      expect(hierarchySnapshot()).toEqual(before);
    },
  );
});

describe("store-backed references fail closed", () => {
  test("review write refuses an author binding that is not a stored task author", async () => {
    expect(store.getAgentBinding(assigneeRef)?.unboundAt).toBeNull();
    const before = hierarchySnapshot();

    // SAFETY: review() matches the schema; the invalid author relation is the domain error under test.
    await expectRefusal(
      definitionFor("hive_review_put", names.reviewer).handler(
        review({ authors: [reviewerRef] }) as never,
      ),
      `review author ${reviewerRef.agentId}@${reviewerNodeId} is not a live author for task ${taskId}`,
    );
    expect(hierarchySnapshot()).toEqual(before);
  });

  test("review write refuses valid coauthors that omit the task's live assignee", async () => {
    expect(store.getAgentBinding(outsiderRef)?.unboundAt).toBeNull();
    const before = hierarchySnapshot();

    // SAFETY: review() matches the schema; the missing assignee relation is the domain error under test.
    await expectRefusal(
      definitionFor("hive_review_put", names.reviewer).handler(
        review({ authors: [outsiderRef] }) as never,
      ),
      `review authors do not include the live assignee for task ${taskId}`,
    );
    expect(hierarchySnapshot()).toEqual(before);
  });

  test("review write refuses a missing task after a stored-task positive control", async () => {
    expect(store.getTask(taskId)?.taskId).toBe(taskId);
    const missing = review({
      revisions: {
        spec: { revision: "1", digest },
        task: { taskId: missingTaskId, revision: "1" },
        contracts: [],
      },
    });
    const before = hierarchySnapshot();

    // SAFETY: missing came from review(), so it matches the schema while naming the absent task under test.
    await expectRefusal(
      definitionFor("hive_review_put", names.reviewer).handler(
        missing as never,
      ),
      `review task ${missingTaskId} is not stored`,
    );
    expect(hierarchySnapshot()).toEqual(before);
  });

  test("ownership transfer refuses a missing successor grant after a stored-grant positive control", async () => {
    putGrantDirect(grant());
    expect(store.getGrant(rootGrantId)?.grantId).toBe(rootGrantId);
    const before = hierarchySnapshot();

    // SAFETY: This object matches the transfer schema; the missing grant is the domain error under test.
    await expectRefusal(
      definitionFor("hive_ownership_transfer", names.owner).handler({
        transfer: transfer(),
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
      } as never),
      `successor grant ${successorGrantId} is not stored`,
    );
    expect(hierarchySnapshot()).toEqual(before);
  });
});
