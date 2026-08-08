// Golden hierarchy-snapshot inputs for the six U4 topology scenarios.
//
// Each builder returns frozen records the pure projector accepts. Tests
// project them and pin root/worker semantics, reviewer-as-assignment, and
// present/absent field coverage. No SessionLocator appears on any node.

import type { HierarchyProjectionInput } from "../../../src/daemon/status-service/status-hierarchy-projection";
import type { HierarchyNode } from "../../../src/schemas/hierarchy-node";
import type { StrandedManifestAttention } from "../../../src/schemas/hierarchy-projection";
import {
  type Run,
  type RunBudget,
  type TopologyDecision,
  BUDGET_DIMENSIONS,
} from "../../../src/schemas/hierarchy-run";
import type { Review } from "../../../src/schemas/integration-stage";
import {
  type OwnershipTransfer,
  OwnershipTransferSchema,
} from "../../../src/schemas/ownership-transfer";
import type { RunControlDecision } from "../../../src/schemas/run-control";
import type { TaskDetail } from "../../../src/schemas/task-detail";

export const FIXTURE_RUN_ID = "run_018f4f5e-0000-7000-8000-000000000001";
export const FIXTURE_DIGEST = `sha256:${"a".repeat(64)}`;
export const FIXTURE_GIT_SHA = "b".repeat(40);
export const FIXTURE_CREATED_AT = "2026-07-30T12:00:00.000Z";

const taskA = "task_018f4f5e-0000-7000-8000-0000000000a1";
const taskB = "task_018f4f5e-0000-7000-8000-0000000000a2";
const taskC = "task_018f4f5e-0000-7000-8000-0000000000a3";

const nodeRootWorker = "node_018f4f5e-0000-7000-8000-000000000101";
const nodeWorker2 = "node_018f4f5e-0000-7000-8000-000000000102";
const nodeReviewer = "node_018f4f5e-0000-7000-8000-000000000103";
const nodeLead = "node_018f4f5e-0000-7000-8000-000000000104";
const nodeLeadChild = "node_018f4f5e-0000-7000-8000-000000000105";
const nodeLeadChild2 = "node_018f4f5e-0000-7000-8000-000000000106";
const nodeReplacementLead = "node_018f4f5e-0000-7000-8000-000000000107";

const reviewId = "review_018f4f5e-0000-7000-8000-000000000201";
const transferId = "transfer_018f4f5e-0000-7000-8000-000000000801";

function budgetLimits(): RunBudget["limits"] {
  const limit = { hard: 10, soft: 8, reserved: 4, used: 2 };
  return Object.fromEntries(
    BUDGET_DIMENSIONS.map((dimension) => [dimension, { ...limit }]),
  ) as RunBudget["limits"];
}

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: FIXTURE_RUN_ID,
    revision: "3",
    repo: "hive",
    instanceId: "instance-fixture",
    approvedSpec: { revision: "1", digest: FIXTURE_DIGEST },
    currentPlan: { revision: "1", digest: FIXTURE_DIGEST },
    topology: { revision: "1", digest: FIXTURE_DIGEST },
    phase: "P2",
    g1: {
      state: "approved",
      decider: "engineer",
      decidedAt: FIXTURE_CREATED_AT,
      spec: { revision: "1", digest: FIXTURE_DIGEST },
      plan: { revision: "1", digest: FIXTURE_DIGEST },
      topology: { revision: "1", digest: FIXTURE_DIGEST },
      budget: { revision: "1", digest: FIXTURE_DIGEST },
    },
    g2: { state: "pending" },
    baseSha: FIXTURE_GIT_SHA,
    budget: { revision: "1", digest: FIXTURE_DIGEST },
    runEpoch: 0,
    lifecycle: "active",
    ...overrides,
  };
}

function topology(shape: TopologyDecision["shape"]): TopologyDecision {
  return {
    runId: FIXTURE_RUN_ID,
    revision: "1",
    digest: FIXTURE_DIGEST,
    createdAt: FIXTURE_CREATED_AT,
    lifecycle: "approved",
    shape,
    decomposition: {
      planRevision: { revision: "1", digest: FIXTURE_DIGEST },
      taskDag: [
        { taskId: taskA, dependsOn: [] },
        { taskId: taskB, dependsOn: [taskA] },
      ],
    },
    coupling: {
      sharedFiles: [],
      sharedInvariants: [],
      interfaceMaturity: "draft",
      dependencyDepth: 1,
      expectedIntegrationConflict: "low",
    },
    parallelValue: {
      independentWorkUnits: 2,
      predictedCriticalPath: "taskA→taskB",
      expectedWallClockBenefit: "modest",
    },
    coordinationCost: {
      leadLoad: "low",
      reviewLoad: "moderate",
      communicationLoad: "low",
      ciLoad: "low",
      promotionQueueLoad: "low",
    },
    budgetEvidence: {
      reservedSessions: 4,
      tokensOrCostEstimate: "bounded",
      wallTimeEstimate: "1h",
      reviewerCapacity: "1",
      perLeadCrewLimit: 3,
    },
    decisionProvenance: {
      proposer: "queen",
      engineerDecision: {
        outcome: "approved",
        decidedBy: "engineer",
        decidedAt: FIXTURE_CREATED_AT,
      },
      specRevision: { revision: "1", digest: FIXTURE_DIGEST },
      rationale: `topology ${shape}`,
    },
  };
}

function budget(): RunBudget {
  return {
    runId: FIXTURE_RUN_ID,
    revision: "1",
    digest: FIXTURE_DIGEST,
    createdAt: FIXTURE_CREATED_AT,
    lifecycle: "approved",
    limits: budgetLimits(),
    anomalyThresholds: {},
  };
}

function node(partial: HierarchyNode): HierarchyNode {
  return partial;
}

function reviewFor(authorNodeId: string, reviewerNodeId: string): Review {
  return {
    reviewId,
    revision: "1",
    reviewer: {
      nodeId: reviewerNodeId,
      agentId: "sarah",
      generation: 1,
    },
    authors: [{ nodeId: authorNodeId, agentId: "david", generation: 1 }],
    candidate: {
      commitSha: FIXTURE_GIT_SHA,
      patchDigest: FIXTURE_DIGEST,
      baseSha: FIXTURE_GIT_SHA,
    },
    revisions: {
      spec: { revision: "1", digest: FIXTURE_DIGEST },
      task: { taskId: taskA, revision: "1" },
      contracts: [],
    },
    environment: { toolchain: "bun", environment: "worktree" },
    findings: [],
    verdict: "accepted",
    evidenceArtifactRefs: [],
    invalidation: { state: "current" },
  };
}

function bindings(
  entries: Array<{ nodeId: string; agentId: string; generation?: number }>,
): Map<string, { nodeId: string; agentId: string; generation: number }> {
  return new Map(
    entries.map((entry) => [
      entry.nodeId,
      {
        nodeId: entry.nodeId,
        agentId: entry.agentId,
        generation: entry.generation ?? 1,
      },
    ]),
  );
}

function runDecisions(): RunControlDecision[] {
  const decision = (
    key: string,
    outcome: RunControlDecision["result"]["outcome"],
  ): RunControlDecision => ({
    idempotencyKey: key,
    intentDigest: FIXTURE_DIGEST,
    result: {
      schemaVersion: 1,
      intentId: `intent-${key}`,
      operationId: `operation-${key}`,
      postStateToken: {
        kind: "revision-and-epoch",
        revision: "3",
        epoch: "0",
      },
      outcome,
      observedPostState: baseRun({ phase: "P3" }),
    },
  });
  return [
    decision("approve-g1-once", { status: "accepted" }),
    decision("approve-g1-again", {
      status: "rejected",
      failure: {
        code: "gate-already-decided",
        message: "G1 is already approved",
      },
    }),
  ];
}

function ownershipTransfer(): OwnershipTransfer {
  return OwnershipTransferSchema.parse({
    transferId,
    runId: FIXTURE_RUN_ID,
    lostOwnerNodeId: nodeLead,
    successorNodeId: nodeReplacementLead,
    successorGrantId: "grant_018f4f5e-0000-7000-8000-000000000b01",
    createdAt: FIXTURE_CREATED_AT,
    reason: "owner-bindings-unbound",
    hierarchyRevision: "5",
    runEpoch: 0,
    actingBinding: {
      nodeId: nodeReplacementLead,
      agentId: "lucas",
      generation: 1,
    },
    actingCapabilityEpoch: 1,
    successorBinding: {
      nodeId: nodeReplacementLead,
      agentId: "lucas",
      generation: 1,
    },
    successorCapabilityEpoch: 1,
  });
}

/**
 * One stored task for the board. The delegation spec only has to parse — the
 * projection reads identity and progress, never the authority half.
 */
function taskDetail(partial: {
  taskId: string;
  revision: string;
  state: TaskDetail["state"];
  ownerNodeId: string;
  assigneeNodeId: string | null;
  dependsOn: string[];
  branch: string;
}): TaskDetail {
  const owner = { nodeId: partial.ownerNodeId, agentId: "zoe", generation: 1 };
  return {
    taskId: partial.taskId,
    revision: partial.revision,
    parentTaskId: null,
    dependsOn: partial.dependsOn,
    delegationSpec: {
      objective: "Board fixture task",
      parentAcceptanceIds: ["assembled"],
      childOutcome: "One stored task",
      terminationCondition: "Review accepted",
      inputs: {
        specRevision: { revision: "1", digest: FIXTURE_DIGEST },
        planRevision: { revision: "1", digest: FIXTURE_DIGEST },
        taskRevisions: [],
        interfaceRevisions: [],
        baseSha: FIXTURE_GIT_SHA,
        prerequisites: [],
        sourceArtifactRefs: [],
      },
      boundaries: { allowedPaths: ["src"] },
      authority: {
        grantId: "grant_018f4f5e-0000-7000-8000-000000000301",
        permittedOperations: ["read", "write"],
        environment: "worktree",
        worktree: "/worktrees/zoe",
        branch: partial.branch,
        explicitNonAuthority: ["land"],
      },
      allowance: {
        sessions: 1,
        tokens: 1_000,
        costCents: 10,
        wallTimeMs: 60_000,
        retries: 0,
        blockers: [],
        owner,
      },
    },
    acceptanceIds: ["assembled"],
    ownerNodeId: partial.ownerNodeId,
    assigneeNodeId: partial.assigneeNodeId,
    pathLeases: [],
    branch: partial.branch,
    baseSha: FIXTURE_GIT_SHA,
    state: partial.state,
    blockers: [],
    evidence: [],
    artifactRefs: [],
  };
}

/**
 * The board story this fixture tells: taskA is done — its accepted review is
 * the review this fixture holds — and taskB is the work that depends on it,
 * matching the topology's taskDag.
 */
function boardTasks(): TaskDetail[] {
  return [
    taskDetail({
      taskId: taskA,
      revision: "2",
      state: "completed",
      ownerNodeId: nodeLead,
      assigneeNodeId: nodeLeadChild,
      dependsOn: [],
      branch: "hive/david",
    }),
    taskDetail({
      taskId: taskB,
      revision: "1",
      state: "in-progress",
      ownerNodeId: nodeLead,
      assigneeNodeId: nodeLeadChild2,
      dependsOn: [taskA],
      branch: "hive/emma",
    }),
  ];
}

/**
 * Stranded work the manifest journal holds. Not part of any projection input:
 * the journal is keyed by agent, so its row is projected on its own.
 */
export const FIXTURE_STRANDED_ITEMS: readonly StrandedManifestAttention[] = [
  {
    nodeId: nodeLeadChild2,
    agentId: "emma",
    branch: "hive/emma",
    workManifestRevision: { revision: "1", digest: FIXTURE_DIGEST },
    unmergedCommits: 2,
    dirtyFileCount: 1,
    disposition: "preserve",
  },
];

/** Direct topology: workers attached to queen; reviewer is an assignment. */
export function directFixture(): HierarchyProjectionInput {
  const nodes: HierarchyNode[] = [
    node({
      nodeId: nodeRootWorker,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
    node({
      nodeId: nodeReviewer,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "worker",
      assignmentKind: "reviewer",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
  ];
  return {
    run: baseRun(),
    topology: topology("direct"),
    budget: budget(),
    nodes,
    bindings: bindings([
      { nodeId: nodeRootWorker, agentId: "david" },
      { nodeId: nodeReviewer, agentId: "sarah" },
    ]),
    reviews: [reviewFor(nodeRootWorker, nodeReviewer)],
  };
}

/** Flat topology: several workers under queen, no lead tier. */
export function flatFixture(): HierarchyProjectionInput {
  const nodes: HierarchyNode[] = [
    node({
      nodeId: nodeRootWorker,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
    node({
      nodeId: nodeWorker2,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskB],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
    node({
      nodeId: nodeReviewer,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "worker",
      assignmentKind: "reviewer",
      taskScope: [taskA, taskB],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
  ];
  return {
    run: baseRun(),
    topology: topology("flat"),
    budget: budget(),
    nodes,
    bindings: bindings([
      { nodeId: nodeRootWorker, agentId: "david" },
      { nodeId: nodeWorker2, agentId: "emma" },
      { nodeId: nodeReviewer, agentId: "sarah" },
    ]),
    reviews: [reviewFor(nodeRootWorker, nodeReviewer)],
    // Measured-empty control: the task source was read and this run holds none,
    // which must not read the same as never having looked.
    tasks: [],
    runDecisions: [],
    transfers: [],
  };
}

/**
 * Full-hive: lead-worker with crew; reviewer still assignment, not a tier.
 * Also the populated case for the read-side sources — tasks, run-control
 * decisions all project from records held here.
 */
export function fullHiveFixture(): HierarchyProjectionInput {
  const nodes: HierarchyNode[] = [
    node({
      nodeId: nodeLead,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskA, taskB, taskC],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "2",
    }),
    node({
      nodeId: nodeLeadChild,
      runId: FIXTURE_RUN_ID,
      parentNodeId: nodeLead,
      ownerNodeId: nodeLead,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
    node({
      nodeId: nodeLeadChild2,
      runId: FIXTURE_RUN_ID,
      parentNodeId: nodeLead,
      ownerNodeId: nodeLead,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskB],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
    node({
      nodeId: nodeReviewer,
      runId: FIXTURE_RUN_ID,
      parentNodeId: nodeLead,
      ownerNodeId: nodeLead,
      organizationalRole: "worker",
      assignmentKind: "reviewer",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
  ];
  const reviews = [reviewFor(nodeLeadChild, nodeReviewer)];
  return {
    run: baseRun({ phase: "P3" }),
    topology: topology("full-hive"),
    budget: budget(),
    nodes,
    bindings: bindings([
      { nodeId: nodeLead, agentId: "zoe" },
      { nodeId: nodeLeadChild, agentId: "david" },
      { nodeId: nodeLeadChild2, agentId: "emma" },
      { nodeId: nodeReviewer, agentId: "sarah" },
    ]),
    reviews,
    tasks: boardTasks(),
    runDecisions: runDecisions(),
  };
}

/**
 * The 19-node target uses five additional leads with two crew each. Starting
 * from the populated full-hive case keeps reviews and incidents in
 * the dense wire while every lead remains inside the three-crew limit.
 */
export function fullHiveDense19Fixture(): HierarchyProjectionInput {
  const populated = fullHiveFixture();
  const extraNodes: HierarchyNode[] = [];
  const denseBindings = new Map(populated.bindings ?? []);
  const denseTaskIds = [taskA, taskB, taskC];

  for (let leadIndex = 0; leadIndex < 5; leadIndex += 1) {
    const suffix = 110 + leadIndex * 3;
    const leadNodeId = `node_018f4f5e-0000-7000-8000-${String(suffix).padStart(12, "0")}`;
    extraNodes.push(
      node({
        nodeId: leadNodeId,
        runId: FIXTURE_RUN_ID,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: denseTaskIds,
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      }),
    );
    denseBindings.set(leadNodeId, {
      nodeId: leadNodeId,
      agentId: `dense-lead-${leadIndex + 1}`,
      generation: 1,
    });

    for (let crewIndex = 0; crewIndex < 2; crewIndex += 1) {
      const crewNodeId = `node_018f4f5e-0000-7000-8000-${String(suffix + crewIndex + 1).padStart(12, "0")}`;
      extraNodes.push(
        node({
          nodeId: crewNodeId,
          runId: FIXTURE_RUN_ID,
          parentNodeId: leadNodeId,
          ownerNodeId: leadNodeId,
          organizationalRole: "worker",
          assignmentKind: crewIndex === 0 ? "author" : "researcher",
          taskScope: [
            denseTaskIds[(leadIndex + crewIndex) % denseTaskIds.length] ??
              taskA,
          ],
          capacityCharge: 1,
          lifecycle: "active",
          revision: "1",
        }),
      );
      denseBindings.set(crewNodeId, {
        nodeId: crewNodeId,
        agentId: `dense-crew-${leadIndex + 1}-${crewIndex + 1}`,
        generation: 1,
      });
    }
  }

  const denseBudget = budget();
  const denseTopology = topology("full-hive");
  return {
    ...populated,
    topology: {
      ...denseTopology,
      budgetEvidence: {
        ...denseTopology.budgetEvidence,
        reservedSessions: 19,
      },
    },
    budget: {
      ...denseBudget,
      limits: {
        ...denseBudget.limits,
        activeSessions: { hard: 32, soft: 24, reserved: 19, used: 19 },
        totalSpawns: { hard: 32, soft: 24, reserved: 19, used: 19 },
        perLeadCrew: { hard: 3, soft: 3, reserved: 3, used: 3 },
      },
    },
    nodes: [...(populated.nodes ?? []), ...extraNodes],
    bindings: denseBindings,
  };
}

/** Lead loss: lead terminated; crew still under the dead lead parent. */
export function leadLossFixture(): HierarchyProjectionInput {
  const nodes: HierarchyNode[] = [
    node({
      nodeId: nodeLead,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskA, taskB],
      capacityCharge: 1,
      lifecycle: "terminated",
      revision: "4",
    }),
    node({
      nodeId: nodeLeadChild,
      runId: FIXTURE_RUN_ID,
      parentNodeId: nodeLead,
      ownerNodeId: nodeLead,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "2",
    }),
    node({
      nodeId: nodeReviewer,
      runId: FIXTURE_RUN_ID,
      parentNodeId: nodeLead,
      ownerNodeId: nodeLead,
      organizationalRole: "worker",
      assignmentKind: "reviewer",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
  ];
  return {
    run: baseRun({ phase: "P3", lifecycle: "active" }),
    topology: topology("full-hive"),
    budget: budget(),
    nodes,
    bindings: bindings([
      { nodeId: nodeLeadChild, agentId: "david", generation: 2 },
      { nodeId: nodeReviewer, agentId: "sarah" },
    ]),
    reviews: [reviewFor(nodeLeadChild, nodeReviewer)],
  };
}

/** Ownership transfer: crew owner moves from lost lead to replacement lead. */
export function ownershipTransferFixture(): HierarchyProjectionInput {
  const nodes: HierarchyNode[] = [
    node({
      nodeId: nodeLead,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "terminated",
      revision: "5",
    }),
    node({
      nodeId: nodeReplacementLead,
      runId: FIXTURE_RUN_ID,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskA, taskB],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    }),
    node({
      nodeId: nodeLeadChild,
      runId: FIXTURE_RUN_ID,
      parentNodeId: nodeReplacementLead,
      ownerNodeId: nodeReplacementLead,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "3",
    }),
    node({
      nodeId: nodeReviewer,
      runId: FIXTURE_RUN_ID,
      parentNodeId: nodeReplacementLead,
      ownerNodeId: nodeReplacementLead,
      organizationalRole: "worker",
      assignmentKind: "reviewer",
      taskScope: [taskA],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "2",
    }),
  ];
  return {
    run: baseRun({ phase: "P3" }),
    topology: topology("full-hive"),
    budget: budget(),
    nodes,
    bindings: bindings([
      { nodeId: nodeReplacementLead, agentId: "lucas" },
      { nodeId: nodeLeadChild, agentId: "david", generation: 3 },
      { nodeId: nodeReviewer, agentId: "sarah", generation: 2 },
    ]),
    reviews: [reviewFor(nodeLeadChild, nodeReviewer)],
    // The transfer record is what makes this a recovery, not a renamed lead.
    transfers: [ownershipTransfer()],
  };
}

/** Every consumed field absent — positive control for the availability surface. */
export function allAbsentFixture(): HierarchyProjectionInput {
  return {};
}

/**
 * Run present, topology/budget/reviews withheld. This is the wiring state when
 * the store has a Run row but not yet the companion records — each mixed-state
 * branch must stay absent, not invent a present value.
 */
export function partialFixture(): HierarchyProjectionInput {
  return {
    run: baseRun(),
    topology: null,
    budget: null,
    reviews: null,
    nodes: [
      node({
        nodeId: nodeRootWorker,
        runId: FIXTURE_RUN_ID,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskA],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      }),
    ],
    bindings: bindings([{ nodeId: nodeRootWorker, agentId: "david" }]),
  };
}

export const SCENARIO_BUILDERS = {
  direct: directFixture,
  flat: flatFixture,
  "full-hive": fullHiveFixture,
  "full-hive-dense-19": fullHiveDense19Fixture,
  "lead-loss": leadLossFixture,
  "ownership-transfer": ownershipTransferFixture,
  "all-absent": allAbsentFixture,
  partial: partialFixture,
} as const;

export type ScenarioName = keyof typeof SCENARIO_BUILDERS;
