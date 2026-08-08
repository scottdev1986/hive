import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  HierarchyConflictError,
  HierarchyFenceError,
  HierarchyValidationError,
} from "../../src/daemon/hierarchy-service/records";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import type {
  DelegationGrant,
  GrantAction,
  HierarchyNode,
} from "../../src/schemas/hierarchy-node";
import type {
  SpecRevision,
  TopologyDecision,
} from "../../src/schemas/hierarchy-run";
import type { IntegrationStage } from "../../src/schemas/integration-stage";
import type { OwnershipTransferInput } from "../../src/schemas/ownership-transfer";
import type { TaskDetail } from "../../src/schemas/task-detail";
import { bumpCapabilityEpoch, bumpHierarchyRevision } from "./fence-state";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const ownerNodeId = "node_018f4f5e-0000-7000-8000-000000000001";
const assigneeNodeId = "node_018f4f5e-0000-7000-8000-000000000002";
const grantId = "grant_018f4f5e-0000-7000-8000-000000000001";
const childGrantId = "grant_018f4f5e-0000-7000-8000-000000000002";
const leadChildGrantId = "grant_018f4f5e-0000-7000-8000-000000000003";
const grandchildGrantId = "grant_018f4f5e-0000-7000-8000-000000000004";
const siblingGrantId = "grant_018f4f5e-0000-7000-8000-000000000005";
const midLeadNodeId = "node_018f4f5e-0000-7000-8000-000000000003";
const grandchildNodeId = "node_018f4f5e-0000-7000-8000-000000000004";
const outsideNodeId = "node_018f4f5e-0000-7000-8000-000000000005";
const stageId = "stage_018f4f5e-0000-7000-8000-000000000001";
const leadStageId = "stage_018f4f5e-0000-7000-8000-000000000002";
const artId = "art_018f4f5e-0000-7000-8000-000000000003";
const digest = `sha256:${"a".repeat(64)}`;
const gitSha = "b".repeat(40);
const createdAt = "2026-07-30T12:00:00.000Z";

const ownerBinding = {
  nodeId: ownerNodeId,
  agentId: "lead",
  generation: 1,
};
const assigneeBinding = {
  nodeId: assigneeNodeId,
  agentId: "worker",
  generation: 1,
};
// The run root's binding: the authority every organizationalRole below it
// is conferred by.
const rootConferral = { binding: ownerBinding, expectedCapabilityEpoch: 1 };

const sessionLocator = {
  schemaVersion: 1 as const,
  instanceId: "instance-1",
  subject: { kind: "agent" as const, agentId: "lead" },
  generation: 1,
  sessionId: "ses_018f4f5e-0000-7000-8000-000000000001",
  hostKind: "sessiond" as const,
  engineBuildId: "build-1",
};

const delegationSpec = {
  objective: "Implement hierarchy store",
  parentAcceptanceIds: ["A1"],
  childOutcome: "Store and tests are green",
  terminationCondition: "Checks pass",
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
    permittedOperations: ["read", "write", "test"] as GrantAction[],
    environment: "worktree",
    worktree: "/worktree",
    branch: "hive/worker",
    explicitNonAuthority: ["land"],
  },
  allowance: {
    sessions: 1,
    tokens: 10_000,
    costCents: 100,
    wallTimeMs: 3_600_000,
    retries: 2,
    blockers: [],
    owner: ownerBinding,
  },
};

function validRun() {
  return {
    runId,
    revision: "1",
    repo: "hive",
    instanceId: "instance-1",
    approvedSpec: { revision: "1", digest },
    currentPlan: { revision: "1", digest },
    topology: { revision: "1", digest },
    phase: "P1" as const,
    g1: {
      state: "approved" as const,
      decider: "engineer",
      decidedAt: createdAt,
      spec: { revision: "1", digest },
      plan: { revision: "1", digest },
      topology: { revision: "1", digest },
      budget: { revision: "1", digest },
    },
    g2: { state: "pending" as const },
    baseSha: gitSha,
    budget: { revision: "1", digest },
    runEpoch: 0,
    lifecycle: "active" as const,
  };
}

function validSpec(overrides: Partial<SpecRevision> = {}): SpecRevision {
  return {
    runId,
    revision: "1",
    digest,
    createdAt,
    lifecycle: "proposed",
    objective: "Store substrate",
    acceptanceIds: ["A1"],
    scope: "hierarchy-store only",
    nonGoals: ["ops endpoints"],
    constraints: {
      architecture: ["daemon owns writes"],
      security: ["no ambient authority"],
      outwardEffect: ["store only"],
    },
    gatePolicy: {
      reviewLocGreenMax: 100,
      reviewLocAmberMax: 250,
      reviewFilesMax: 10,
    },
    evidenceArtifactRefs: [artId],
    proposer: "queen",
    engineerApproval: null,
    ...overrides,
  };
}

function validTopology(
  overrides: Partial<TopologyDecision> = {},
): TopologyDecision {
  return {
    runId,
    revision: "1",
    digest,
    createdAt,
    lifecycle: "proposed",
    shape: "direct",
    decomposition: {
      planRevision: { revision: "1", digest },
      taskDag: [{ taskId, dependsOn: [] }],
    },
    coupling: {
      sharedFiles: [],
      sharedInvariants: [],
      interfaceMaturity: "n/a",
      dependencyDepth: 0,
      expectedIntegrationConflict: "none",
    },
    parallelValue: {
      independentWorkUnits: 1,
      predictedCriticalPath: "store",
      expectedWallClockBenefit: "none",
    },
    coordinationCost: {
      leadLoad: "none",
      reviewLoad: "one",
      communicationLoad: "none",
      ciLoad: "bun test",
      promotionQueueLoad: "none",
    },
    budgetEvidence: {
      reservedSessions: 1,
      tokensOrCostEstimate: "small",
      wallTimeEstimate: "hour",
      reviewerCapacity: "one",
      perLeadCrewLimit: 0,
    },
    decisionProvenance: {
      proposer: "queen",
      engineerDecision: null,
      specRevision: { revision: "1", digest },
      rationale: "direct",
    },
    ...overrides,
  };
}

function validTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    taskId,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec,
    acceptanceIds: ["A1"],
    ownerNodeId,
    assigneeNodeId,
    pathLeases: [{ path: "src/daemon", mode: "write" }],
    branch: "hive/worker",
    baseSha: gitSha,
    state: "in-progress",
    blockers: [],
    evidence: [],
    artifactRefs: [],
    ...overrides,
  };
}

function validGrant(overrides: Partial<DelegationGrant> = {}): DelegationGrant {
  return {
    grantId,
    parentGrantId: null,
    issuer: ownerBinding,
    subject: ownerBinding,
    runId,
    taskIds: [taskId],
    descendantNodeIds: [ownerNodeId, assigneeNodeId],
    paths: ["src/daemon"],
    branches: ["hive/worker"],
    actions: ["read", "write", "test"],
    budget: {
      sessions: 1,
      tokens: 10_000,
      costCents: 100,
      wallTimeMs: 3_600_000,
      retries: 2,
    },
    expiresAt: "2026-07-30T13:00:00.000Z",
    hierarchyRevision: "0",
    runEpoch: 0,
    capabilityEpoch: 1,
    status: "active",
    ...overrides,
  };
}

function validRunStage(
  overrides: Partial<IntegrationStage> = {},
): IntegrationStage {
  return {
    stageId,
    revision: "1",
    kind: "run",
    runId,
    ownerNodeId: null,
    daemonRef: "refs/hive/run-stage",
    baseSha: gitSha,
    headSha: gitSha,
    acceptedPromotionGrantIds: [],
    validation: { environment: "bun", evidenceArtifactRefs: [] },
    queueHighWater: 0,
    lifecycle: "active",
    ...overrides,
  } as IntegrationStage;
}

function seedFlatAgent(
  targetDb: HiveDatabase,
  agentId: string,
  name: string,
  locator: typeof sessionLocator,
  worktree: string,
  branch: string,
): void {
  if (targetDb.getAgentById(agentId) !== null) return;
  targetDb.insertAgent({
    id: agentId,
    name,
    tool: "codex",
    model: "gpt-5",
    category: "simple_coding",
    status: "working",
    taskDescription: name,
    worktreePath: worktree,
    branch,
    sessionLocator: locator,
    contextPct: null,
    createdAt,
    lastEventAt: createdAt,
    capabilityEpoch: 1,
    readOnly: false,
    writeRevoked: false,
  });
}

function seedRunWorld(store: HierarchyStore, targetDb: HiveDatabase = db) {
  store.putRun(validRun(), null);
  store.putNode(
    {
      nodeId: ownerNodeId,
      runId,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    },
    null,
  );
  store.putNode(
    {
      nodeId: assigneeNodeId,
      runId,
      parentNodeId: ownerNodeId,
      ownerNodeId: ownerNodeId,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    },
    null,
  );
  // Flat agents carry capabilityEpoch; bindings no longer store a copy.
  seedFlatAgent(
    targetDb,
    ownerBinding.agentId,
    "lead",
    sessionLocator,
    "/worktree-lead",
    "hive/lead",
  );
  const workerLocator = {
    ...sessionLocator,
    subject: { kind: "agent" as const, agentId: "worker" },
    sessionId: "ses_018f4f5e-0000-7000-8000-000000000002",
  };
  seedFlatAgent(
    targetDb,
    assigneeBinding.agentId,
    "worker",
    workerLocator,
    "/worktree-worker",
    "hive/worker",
  );
  store.putAgentBinding(
    {
      ...ownerBinding,
      provider: "codex",
      model: "gpt-5",
      sessionLocator,
      worktree: "/worktree-lead",
      branch: "hive/lead",
      baseSha: gitSha,
      credentialId: "cred-lead",
      boundAt: createdAt,
      unboundAt: null,
    },
    runId,
  );
  store.putAgentBinding(
    {
      ...assigneeBinding,
      provider: "codex",
      model: "gpt-5",
      sessionLocator: workerLocator,
      worktree: "/worktree-worker",
      branch: "hive/worker",
      baseSha: gitSha,
      credentialId: "cred-worker",
      boundAt: createdAt,
      unboundAt: null,
    },
    runId,
  );
  store.putTask(validTask());
}

let db: HiveDatabase;
let store: HierarchyStore;

beforeEach(() => {
  db = new HiveDatabase(":memory:");
  store = new HierarchyStore(db);
});

afterEach(() => {
  db.close();
});

describe("hierarchy tables land without touching flat Assignments", () => {
  test("hierarchy_fences and hierarchy_records exist; status_assignments shape is unchanged", () => {
    const tables = (
      db.database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain("hierarchy_fences");
    expect(tables).toContain("hierarchy_records");

    // Flat Assignment storage is status_assignments — not created by this
    // migration and not altered. Positive control: the table is still absent
    // until StatusStore creates it, proving hierarchy did not redefine it.
    expect(tables).not.toContain("status_assignments");

    const fenceCols = (
      db.database.query("PRAGMA table_info(hierarchy_fences)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(fenceCols).toEqual(
      expect.arrayContaining(["runId", "hierarchyRevision", "runEpoch"]),
    );

    const recordCols = (
      db.database.query("PRAGMA table_info(hierarchy_records)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(recordCols).toEqual(
      expect.arrayContaining(["capabilityEpoch", "revision", "document"]),
    );
  });
});

describe("expected-revision CAS", () => {
  test("stale expected-revision is rejected with a typed conflict carrying the current revision", () => {
    seedRunWorld(store);
    const task = store.getTask(taskId);
    expect(task?.revision).toBe("1");

    try {
      store.updateTask({
        taskId,
        expectedRevision: "0",
        actorNodeId: assigneeNodeId,
        state: "blocked",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyConflictError);
      expect((error as HierarchyConflictError).currentRevision).toBe("1");
      expect((error as HierarchyConflictError).code).toBe("HIERARCHY_CONFLICT");
    }

    // Matching expected revision still lands through the typed op.
    const updated = store.updateTask({
      taskId,
      expectedRevision: "1",
      actorNodeId: assigneeNodeId,
      state: "blocked",
    });
    expect(updated.revision).toBe("2");
    expect(updated.state).toBe("blocked");
  });
});

describe("three independent fences", () => {
  test("stale hierarchyRevision is rejected even when runEpoch and capabilityEpoch match", () => {
    seedRunWorld(store);
    const parent = store.putGrant(validGrant(), {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    });
    expect(parent.grantId).toBe(grantId);

    // Advance only the hierarchy fence.
    bumpHierarchyRevision(db, runId);

    try {
      store.putGrant(
        validGrant({
          grantId: childGrantId,
          parentGrantId: grantId,
          subject: assigneeBinding,
          paths: ["src/daemon/hierarchy-store.ts"],
          actions: ["read", "write"],
          hierarchyRevision: "0",
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: ownerBinding,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      const fence = error as HierarchyFenceError;
      expect(fence.fence).toBe("hierarchyRevision");
      expect(fence.expected).toBe("0");
      expect(fence.current).toBe("1");
    }
  });

  test("stale runEpoch is rejected even when hierarchyRevision and capabilityEpoch match", () => {
    seedRunWorld(store);
    store.putGrant(validGrant(), {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    });
    expect(store.advanceRunEpoch(runId, 0)).toBe(1);

    try {
      store.putGrant(
        validGrant({
          grantId: childGrantId,
          parentGrantId: grantId,
          subject: assigneeBinding,
          paths: ["src/daemon/hierarchy-store.ts"],
          actions: ["read"],
          runEpoch: 0,
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: ownerBinding,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      const fence = error as HierarchyFenceError;
      expect(fence.fence).toBe("runEpoch");
      expect(fence.expected).toBe(0);
      expect(fence.current).toBe(1);
    }
  });

  test("stale capabilityEpoch is rejected even when hierarchyRevision and runEpoch match", () => {
    seedRunWorld(store);
    store.putGrant(validGrant(), {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    });
    bumpCapabilityEpoch(db, ownerBinding);

    try {
      store.putGrant(
        validGrant({
          grantId: childGrantId,
          parentGrantId: grantId,
          subject: assigneeBinding,
          paths: ["src/daemon/hierarchy-store.ts"],
          actions: ["read"],
          capabilityEpoch: 1,
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: ownerBinding,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      const fence = error as HierarchyFenceError;
      expect(fence.fence).toBe("capabilityEpoch");
      expect(fence.expected).toBe(1);
      expect(fence.current).toBe(2);
    }
  });
});

describe("task-update authority", () => {
  test("assignee cannot accept its own result", () => {
    seedRunWorld(store);

    try {
      store.updateTask({
        taskId,
        expectedRevision: "1",
        actorNodeId: assigneeNodeId,
        acceptResult: true,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyValidationError);
      expect((error as Error).message).toMatch(/assignee cannot accept/i);
    }

    // Distinct owner may accept.
    const accepted = store.updateTask({
      taskId,
      expectedRevision: "1",
      actorNodeId: ownerNodeId,
      acceptResult: true,
      state: "completed",
    });
    expect(accepted.state).toBe("completed");
    expect(accepted.revision).toBe("2");
  });

  test("assignee==owner cannot self-accept by resolving as owner", () => {
    seedRunWorld(store);
    // Force assignee and owner to the same node via create of a solo task.
    const soloTaskId = "task_018f4f5e-0000-7000-8000-000000000099";
    store.putTask(
      validTask({
        taskId: soloTaskId,
        ownerNodeId,
        assigneeNodeId: ownerNodeId,
      }),
    );

    try {
      store.updateTask({
        taskId: soloTaskId,
        expectedRevision: "1",
        actorNodeId: ownerNodeId,
        acceptResult: true,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyValidationError);
      expect((error as Error).message).toMatch(/assignee cannot accept/i);
    }
  });

  test("putTask is create-only and cannot bypass actor checks with a raw rewrite", () => {
    seedRunWorld(store);
    try {
      store.putTask({ ...validTask(), revision: "9", state: "completed" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyConflictError);
      expect((error as HierarchyConflictError).currentRevision).toBe("1");
    }
    // State is still the created value — raw put did not rewrite it.
    expect(store.getTask(taskId)?.state).toBe("in-progress");
  });

  test("assignee cannot move gates through task update", () => {
    seedRunWorld(store);
    expect(() =>
      store.updateTask({
        taskId,
        expectedRevision: "1",
        actorNodeId: assigneeNodeId,
        moveGate: true,
      }),
    ).toThrow(/cannot move gates/i);
  });

  test("assignee may report progress under CAS", () => {
    seedRunWorld(store);
    const updated = store.updateTask({
      taskId,
      expectedRevision: "1",
      actorNodeId: assigneeNodeId,
      state: "blocked",
      blockers: ["waiting on review"],
    });
    expect(updated.state).toBe("blocked");
    expect(updated.blockers).toEqual(["waiting on review"]);
    expect(updated.revision).toBe("2");
  });
});

describe("terminal task state", () => {
  test.each(["completed", "terminated"] as const)(
    "a state change on a %s task is refused and writes nothing",
    (terminalState) => {
      seedRunWorld(store);
      store.updateTask({
        taskId,
        expectedRevision: "1",
        actorNodeId: assigneeNodeId,
        state: terminalState,
      });

      try {
        store.updateTask({
          taskId,
          expectedRevision: "2",
          actorNodeId: assigneeNodeId,
          state: "in-progress",
          evidence: [artId],
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(HierarchyValidationError);
        expect((error as Error).message).toBe(
          `task update cannot change state on a ${terminalState} task`,
        );
      }

      // No half-write: the refused call carried evidence too, and none of it
      // landed. The revision did not move, so a retrying caller is not
      // burning one revision per attempt.
      expect(store.getTask(taskId)).toMatchObject({
        revision: "2",
        state: terminalState,
        evidence: [],
      });
    },
  );

  test.each(["completed", "terminated"] as const)(
    "an evidence-only append still lands on a %s task",
    (terminalState) => {
      seedRunWorld(store);
      store.updateTask({
        taskId,
        expectedRevision: "1",
        actorNodeId: assigneeNodeId,
        state: terminalState,
      });

      const updated = store.updateTask({
        taskId,
        expectedRevision: "2",
        actorNodeId: assigneeNodeId,
        blockers: ["late note"],
        evidence: [artId],
      });
      expect(updated).toMatchObject({
        revision: "3",
        state: terminalState,
        blockers: ["late note"],
        evidence: [artId],
      });
    },
  );

  test.each(["completed", "terminated"] as const)(
    "re-sending the current %s state is not a change and is accepted",
    (terminalState) => {
      seedRunWorld(store);
      store.updateTask({
        taskId,
        expectedRevision: "1",
        actorNodeId: assigneeNodeId,
        state: terminalState,
      });

      const updated = store.updateTask({
        taskId,
        expectedRevision: "2",
        actorNodeId: assigneeNodeId,
        state: terminalState,
      });
      expect(updated).toMatchObject({ revision: "3", state: terminalState });
    },
  );
});

describe("store-enforced cross-field rules", () => {
  test("approved SpecRevision with null engineerApproval is rejected", () => {
    seedRunWorld(store);
    expect(() =>
      store.putSpecRevision(
        validSpec({ lifecycle: "approved", engineerApproval: null }),
      ),
    ).toThrow(HierarchyValidationError);

    // Positive control: approved with a decider lands; proposed with null is fine.
    store.putSpecRevision(validSpec({ lifecycle: "proposed" }));
    store.putSpecRevision(
      validSpec({
        revision: "2",
        lifecycle: "approved",
        engineerApproval: { approvedBy: "engineer", approvedAt: createdAt },
      }),
    );
    expect(store.getSpecRevision(runId, "2")?.lifecycle).toBe("approved");
  });

  test("approved TopologyDecision with null engineerDecision is rejected", () => {
    seedRunWorld(store);
    expect(() =>
      store.putTopologyDecision(
        validTopology({
          lifecycle: "approved",
          decisionProvenance: {
            proposer: "queen",
            engineerDecision: null,
            specRevision: { revision: "1", digest },
            rationale: "direct",
          },
        }),
      ),
    ).toThrow(/non-null engineerDecision/i);
  });

  test("grant write rejects a child that is not an attenuation of its parent", () => {
    seedRunWorld(store);
    store.putGrant(validGrant(), {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    });

    expect(() =>
      store.putGrant(
        validGrant({
          grantId: childGrantId,
          parentGrantId: grantId,
          subject: assigneeBinding,
          // Widening paths beyond the parent.
          paths: ["src"],
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: ownerBinding,
        },
      ),
    ).toThrow(/not a valid attenuation/i);

    // Positive control: a narrowed child lands.
    const child = store.putGrant(
      validGrant({
        grantId: childGrantId,
        parentGrantId: grantId,
        subject: assigneeBinding,
        paths: ["src/daemon/hierarchy-store.ts"],
        actions: ["read", "write"],
        budget: {
          sessions: 1,
          tokens: 8_000,
          costCents: 50,
          wallTimeMs: 1_000_000,
          retries: 1,
        },
      }),
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: ownerBinding,
      },
    );
    expect(child.parentGrantId).toBe(grantId);
  });

  test("integration-stage write rejects a second run-kind stage for the same run", () => {
    seedRunWorld(store);
    store.putIntegrationStage(validRunStage(), null);

    // A lead stage alongside the one run stage is fine.
    store.putIntegrationStage(
      validRunStage({
        stageId: leadStageId,
        kind: "lead",
        ownerNodeId: ownerNodeId,
        daemonRef: "refs/hive/lead-stage",
      }),
      null,
    );

    expect(() =>
      store.putIntegrationStage(
        validRunStage({
          stageId: "stage_018f4f5e-0000-7000-8000-000000000099",
          kind: "run",
        }),
        null,
      ),
    ).toThrow();
  });
});

describe("grant document fences and binding run match", () => {
  test("stale fence fields on the grant document are rejected even when operation tokens are current", () => {
    seedRunWorld(store);
    bumpHierarchyRevision(db, runId);
    // Operation tokens match live state (hierarchyRevision is now 1), but the
    // document still names hierarchyRevision 0 — that must not land.
    try {
      store.putGrant(validGrant({ hierarchyRevision: "0" }), {
        expectedHierarchyRevision: "1",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: ownerBinding,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      expect((error as HierarchyFenceError).fence).toBe("hierarchyRevision");
      expect((error as HierarchyFenceError).expected).toBe("0");
      expect((error as HierarchyFenceError).current).toBe("1");
    }

    store.advanceRunEpoch(runId, 0);
    try {
      store.putGrant(validGrant({ hierarchyRevision: "1", runEpoch: 0 }), {
        expectedHierarchyRevision: "1",
        expectedRunEpoch: 1,
        expectedCapabilityEpoch: 1,
        binding: ownerBinding,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      expect((error as HierarchyFenceError).fence).toBe("runEpoch");
    }

    // Restore a clean epoch path for capabilityEpoch document check.
    const db2 = new HiveDatabase(":memory:");
    const store2 = new HierarchyStore(db2);
    seedRunWorld(store2, db2);
    bumpCapabilityEpoch(db2, ownerBinding);
    try {
      store2.putGrant(validGrant({ capabilityEpoch: 1 }), {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 2,
        binding: ownerBinding,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      expect((error as HierarchyFenceError).fence).toBe("capabilityEpoch");
    }
    db2.close();
  });

  test("acting binding runId must match the grant runId", () => {
    seedRunWorld(store);
    const otherRunId = "run_018f4f5e-0000-7000-8000-0000000000bb";
    store.putRun({ ...validRun(), runId: otherRunId }, null);

    try {
      store.putGrant(validGrant({ runId: otherRunId }), {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: ownerBinding,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyValidationError);
      expect((error as Error).message).toMatch(/belongs to run/);
    }
  });
});

describe("epoch rollback is closed", () => {
  test("putRun cannot roll runEpoch back after advanceRunEpoch", () => {
    seedRunWorld(store);
    expect(store.advanceRunEpoch(runId, 0)).toBe(1);
    expect(store.getFences(runId)?.runEpoch).toBe(1);

    try {
      store.putRun({ ...validRun(), revision: "2", runEpoch: 0 }, "1");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      expect((error as HierarchyFenceError).fence).toBe("runEpoch");
      expect((error as HierarchyFenceError).current).toBe(1);
    }
    expect(store.getFences(runId)?.runEpoch).toBe(1);
    expect(store.getRun(runId)?.runEpoch).toBe(1);
  });

  test("putAgentBinding does not store capabilityEpoch; fences read the flat agent", () => {
    seedRunWorld(store);
    expect(store.getAgentBinding(ownerBinding)).not.toBeNull();
    expect(store.liveCapabilityEpoch(ownerBinding)).toBe(1);
    bumpCapabilityEpoch(db, ownerBinding);
    expect(store.liveCapabilityEpoch(ownerBinding)).toBe(2);
    // Binding document is unchanged; the flat row moved.
    expect(store.getAgentBinding(ownerBinding)).toMatchObject({
      agentId: ownerBinding.agentId,
      generation: ownerBinding.generation,
    });
    expect(
      "capabilityEpoch" in (store.getAgentBinding(ownerBinding) as object),
    ).toBe(false);
  });
});

describe("hierarchyRevision advances on tree mutations", () => {
  test("parentNodeId/ownerNodeId change requires and advances hierarchyRevision", () => {
    seedRunWorld(store);
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");

    // Missing expectedHierarchyRevision is refused.
    expect(() =>
      store.putNode(
        {
          nodeId: assigneeNodeId,
          runId,
          parentNodeId: ownerNodeId,
          ownerNodeId: null,
          organizationalRole: "worker",
          assignmentKind: "author",
          taskScope: [taskId],
          capacityCharge: 1,
          lifecycle: "active",
          revision: "2",
        },
        "1",
      ),
    ).toThrow(/expectedHierarchyRevision/);

    // Stale hierarchy token is refused and fence stays put.
    try {
      store.putNode(
        {
          nodeId: assigneeNodeId,
          runId,
          parentNodeId: ownerNodeId,
          ownerNodeId: null,
          organizationalRole: "worker",
          assignmentKind: "author",
          taskScope: [taskId],
          capacityCharge: 1,
          lifecycle: "active",
          revision: "2",
        },
        "1",
        "9",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      expect((error as HierarchyFenceError).fence).toBe("hierarchyRevision");
    }
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");

    // Matching token advances the fence atomically with the edge write.
    store.putNode(
      {
        nodeId: assigneeNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId: null,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "2",
      },
      "1",
      "0",
    );
    expect(store.getFences(runId)?.hierarchyRevision).toBe("1");
    expect(store.getNode(assigneeNodeId)?.ownerNodeId).toBeNull();

    // A parentNodeId move is the other half of "tree mutation", and it
    // advances the same fence on this same general path.
    store.putNode(
      {
        nodeId: midLeadNodeId,
        runId,
        parentNodeId: assigneeNodeId,
        ownerNodeId: assigneeNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    store.putNode(
      {
        nodeId: midLeadNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId: assigneeNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "2",
      },
      "1",
      "1",
    );
    expect(store.getFences(runId)?.hierarchyRevision).toBe("2");
    expect(store.getNode(midLeadNodeId)?.parentNodeId).toBe(ownerNodeId);
  });
});

describe("provenance at creation and immutability after", () => {
  test("binding create requires node.runId === supplied runId (no run forgery)", () => {
    seedRunWorld(store);
    const otherRunId = "run_018f4f5e-0000-7000-8000-0000000000cc";
    store.putRun({ ...validRun(), runId: otherRunId }, null);

    // Fabricated: bind ownerNode (run A) under run B's id.
    try {
      store.putAgentBinding(
        {
          nodeId: ownerNodeId,
          agentId: "forged",
          generation: 1,
          provider: "codex",
          model: "gpt-5",
          sessionLocator: {
            ...sessionLocator,
            subject: { kind: "agent", agentId: "forged" },
            sessionId: "ses_018f4f5e-0000-7000-8000-0000000000ff",
          },
          worktree: "/worktree-forged",
          branch: "hive/forged",
          baseSha: gitSha,
          credentialId: "cred-forged",
          boundAt: createdAt,
          unboundAt: null,
        },
        otherRunId,
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyValidationError);
      expect((error as Error).message).toMatch(/does not match node/);
    }
    expect(
      store.getAgentBinding({
        nodeId: ownerNodeId,
        agentId: "forged",
        generation: 1,
      }),
    ).toBeNull();

    // Missing node is also refused at create.
    expect(() =>
      store.putAgentBinding(
        {
          nodeId: "node_018f4f5e-0000-7000-8000-0000000000ee",
          agentId: "ghost",
          generation: 1,
          provider: "codex",
          model: "gpt-5",
          sessionLocator,
          worktree: "/w",
          branch: "hive/ghost",
          baseSha: gitSha,
          credentialId: "cred-ghost",
          boundAt: createdAt,
          unboundAt: null,
        },
        runId,
      ),
    ).toThrow(/must exist before binding/);
  });

  test("grant issuer must equal the acting binding, root grants included", () => {
    seedRunWorld(store);
    // Acting as assignee while claiming the lead as issuer — forgery.
    try {
      store.putGrant(
        validGrant({
          issuer: ownerBinding,
          subject: assigneeBinding,
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: assigneeBinding,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyValidationError);
      expect((error as Error).message).toMatch(/must equal the grant issuer/);
    }
    expect(store.getGrant(grantId)).toBeNull();

    // Positive control: acting binding is the issuer.
    const landed = store.putGrant(validGrant(), {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    });
    expect(landed.issuer).toEqual(ownerBinding);
  });

  test("node runId is immutable after create", () => {
    seedRunWorld(store);
    const otherRunId = "run_018f4f5e-0000-7000-8000-0000000000dd";
    store.putRun({ ...validRun(), runId: otherRunId }, null);

    try {
      store.putNode(
        {
          nodeId: assigneeNodeId,
          runId: otherRunId,
          parentNodeId: ownerNodeId,
          ownerNodeId: ownerNodeId,
          organizationalRole: "worker",
          assignmentKind: "author",
          taskScope: [taskId],
          capacityCharge: 1,
          lifecycle: "active",
          revision: "2",
        },
        "1",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyValidationError);
      expect((error as Error).message).toMatch(/runId is immutable/);
    }
    expect(store.getNode(assigneeNodeId)?.runId).toBe(runId);
    // hierarchyRevision must not have moved for a refused write.
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");
  });
});

describe("lead-tier standing and real subtree containment", () => {
  const ownerFences = {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: 1,
    binding: ownerBinding,
  };

  const midLeadBinding = {
    nodeId: midLeadNodeId,
    agentId: "mid-lead",
    generation: 1,
  };

  function seedMidLeadWorld() {
    seedRunWorld(store);
    store.putNode(
      {
        nodeId: midLeadNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
      undefined,
      rootConferral,
    );
    store.putNode(
      {
        nodeId: grandchildNodeId,
        runId,
        parentNodeId: midLeadNodeId,
        ownerNodeId: midLeadNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    // Sibling of the mid-lead: inside the root tree, outside the mid-lead tree.
    store.putNode(
      {
        nodeId: outsideNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    const midLeadLocator = {
      ...sessionLocator,
      subject: { kind: "agent" as const, agentId: "mid-lead" },
      sessionId: "ses_018f4f5e-0000-7000-8000-000000000003",
    };
    seedFlatAgent(
      db,
      "mid-lead",
      "mid-lead",
      midLeadLocator,
      "/worktree-mid-lead",
      "hive/mid-lead",
    );
    store.putAgentBinding(
      {
        ...midLeadBinding,
        provider: "codex",
        model: "gpt-5",
        sessionLocator: midLeadLocator,
        worktree: "/worktree-mid-lead",
        branch: "hive/mid-lead",
        baseSha: gitSha,
        credentialId: "cred-mid-lead",
        boundAt: createdAt,
        unboundAt: null,
      },
      runId,
    );
    store.putGrant(
      validGrant({
        descendantNodeIds: [
          ownerNodeId,
          assigneeNodeId,
          midLeadNodeId,
          grandchildNodeId,
          outsideNodeId,
        ],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 4,
          tokens: 20_000,
          costCents: 200,
          wallTimeMs: 3_600_000,
          retries: 2,
        },
      }),
      ownerFences,
    );
  }

  test("non-lead issuer is refused; lead-issuer and run-root exception are positive controls", () => {
    seedMidLeadWorld();

    // Mid-tier lead receives a parent grant, then a plain worker tries to issue.
    store.putGrant(
      validGrant({
        grantId: leadChildGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: midLeadBinding,
        descendantNodeIds: [midLeadNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 10_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
      }),
      ownerFences,
    );

    // Promote the assignee binding's node remains worker; give it a parent
    // grant so attenuation would otherwise pass.
    store.putGrant(
      validGrant({
        grantId: childGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: assigneeBinding,
        descendantNodeIds: [assigneeNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 1,
          tokens: 4_000,
          costCents: 40,
          wallTimeMs: 1_000_000,
          retries: 0,
        },
      }),
      ownerFences,
    );

    expect(() =>
      store.putGrant(
        validGrant({
          grantId: grandchildGrantId,
          parentGrantId: childGrantId,
          issuer: assigneeBinding,
          subject: assigneeBinding,
          descendantNodeIds: [assigneeNodeId],
          actions: ["read"],
          budget: {
            sessions: 1,
            tokens: 1_000,
            costCents: 10,
            wallTimeMs: 500_000,
            retries: 0,
          },
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: assigneeBinding,
        },
      ),
    ).toThrow(/not lead-worker/);
    expect(store.getGrant(grandchildGrantId)).toBeNull();

    // Lead-issuer positive control: mid-tier lead-worker may issue under itself.
    const fromLead = store.putGrant(
      validGrant({
        grantId: grandchildGrantId,
        parentGrantId: leadChildGrantId,
        issuer: midLeadBinding,
        subject: {
          nodeId: grandchildNodeId,
          agentId: "grandchild",
          generation: 1,
        },
        descendantNodeIds: [grandchildNodeId],
        actions: ["read", "write"],
        budget: {
          sessions: 1,
          tokens: 4_000,
          costCents: 40,
          wallTimeMs: 1_000_000,
          retries: 0,
        },
      }),
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: midLeadBinding,
      },
    );
    expect(fromLead.issuer).toEqual(midLeadBinding);

    // Run-root exception: root node labeled worker may still issue children.
    store.putNode(
      {
        nodeId: ownerNodeId,
        runId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "2",
      },
      "1",
    );
    const fromRootWorker = store.putGrant(
      validGrant({
        grantId: siblingGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: {
          nodeId: outsideNodeId,
          agentId: "outside-worker",
          generation: 1,
        },
        descendantNodeIds: [outsideNodeId],
        actions: ["read"],
        budget: {
          sessions: 1,
          tokens: 1_000,
          costCents: 10,
          wallTimeMs: 500_000,
          retries: 0,
        },
      }),
      ownerFences,
    );
    expect(fromRootWorker.issuer).toEqual(ownerBinding);
  });

  test("lead issuing outside its actual subtree is refused, including a self-declared descendant list that disagrees with the tree", () => {
    seedMidLeadWorld();
    store.putGrant(
      validGrant({
        grantId: leadChildGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: midLeadBinding,
        // Parent grant names the outside node so attenuation would pass if
        // the store only trusted the self-declared list.
        descendantNodeIds: [midLeadNodeId, grandchildNodeId, outsideNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 10_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
      }),
      ownerFences,
    );

    // Subject outside the mid-lead's real tree.
    expect(() =>
      store.putGrant(
        validGrant({
          grantId: grandchildGrantId,
          parentGrantId: leadChildGrantId,
          issuer: midLeadBinding,
          subject: {
            nodeId: outsideNodeId,
            agentId: "outside-worker",
            generation: 1,
          },
          descendantNodeIds: [outsideNodeId],
          actions: ["read"],
          budget: {
            sessions: 1,
            tokens: 1_000,
            costCents: 10,
            wallTimeMs: 500_000,
            retries: 0,
          },
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: midLeadBinding,
        },
      ),
    ).toThrow(/outside issuer .* real node subtree/);
    expect(store.getGrant(grandchildGrantId)).toBeNull();

    // Subject inside the tree, but descendantNodeIds claims a node that is not.
    expect(() =>
      store.putGrant(
        validGrant({
          grantId: grandchildGrantId,
          parentGrantId: leadChildGrantId,
          issuer: midLeadBinding,
          subject: {
            nodeId: grandchildNodeId,
            agentId: "grandchild",
            generation: 1,
          },
          descendantNodeIds: [grandchildNodeId, outsideNodeId],
          actions: ["read"],
          budget: {
            sessions: 1,
            tokens: 1_000,
            costCents: 10,
            wallTimeMs: 500_000,
            retries: 0,
          },
        }),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: midLeadBinding,
        },
      ),
    ).toThrow(/outside issuer .* real node subtree/);
    expect(store.getGrant(grandchildGrantId)).toBeNull();

    // Positive control: real containment under the mid-lead lands.
    const ok = store.putGrant(
      validGrant({
        grantId: grandchildGrantId,
        parentGrantId: leadChildGrantId,
        issuer: midLeadBinding,
        subject: {
          nodeId: grandchildNodeId,
          agentId: "grandchild",
          generation: 1,
        },
        descendantNodeIds: [grandchildNodeId],
        actions: ["read"],
        budget: {
          sessions: 1,
          tokens: 1_000,
          costCents: 10,
          wallTimeMs: 500_000,
          retries: 0,
        },
      }),
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: midLeadBinding,
      },
    );
    expect(ok.subject.nodeId).toBe(grandchildNodeId);
  });
});

describe("proposal records carry provenance at creation", () => {
  const plan = {
    runId,
    revision: "1",
    digest,
    createdAt,
    lifecycle: "proposed" as const,
    parentRevision: null,
    taskDag: [{ taskId, dependsOn: [] }],
    topologyRationale: "one task",
    proposer: "queen",
  };
  const limit = { hard: 4, soft: 2, reserved: 2, used: 1 };
  const budget = {
    runId,
    revision: "1",
    digest,
    createdAt,
    lifecycle: "proposed" as const,
    limits: {
      activeSessions: limit,
      totalSpawns: limit,
      perLeadCrew: limit,
      reviewerPool: limit,
      vendorQuota: limit,
      tokens: limit,
      costCents: limit,
      wallTimeMs: limit,
      ci: limit,
      wakeBudget: limit,
      messageBudget: limit,
    },
    anomalyThresholds: { spendPerHour: 100 },
  };

  test("a plan or budget for a run that does not exist is refused", () => {
    expect(() => store.putPlanRevision(plan, 0)).toThrow(
      HierarchyValidationError,
    );
    expect(() => store.putRunBudget(budget, 0)).toThrow(
      HierarchyValidationError,
    );
    expect(store.getPlanRevision(runId, "1")).toBeNull();
    expect(store.getRunBudget(runId, "1")).toBeNull();

    // Positive control: the same writes land once the run exists.
    store.putRun(validRun(), null);
    expect(store.putPlanRevision(plan, 0).revision).toBe("1");
    expect(store.putRunBudget(budget, 0).revision).toBe("1");
  });

  test("a plan or budget written under a retired epoch is refused", () => {
    store.putRun(validRun(), null);
    store.advanceRunEpoch(runId, 0);

    for (const write of [
      () => store.putPlanRevision(plan, 0),
      () => store.putRunBudget(budget, 0),
    ]) {
      try {
        write();
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(HierarchyFenceError);
        expect((error as HierarchyFenceError).fence).toBe("runEpoch");
      }
    }
    expect(store.getPlanRevision(runId, "1")).toBeNull();
    expect(store.getRunBudget(runId, "1")).toBeNull();

    // Positive control: the live epoch admits the same records.
    expect(store.putPlanRevision(plan, 1).revision).toBe("1");
    expect(store.putRunBudget(budget, 1).revision).toBe("1");
  });
});

describe("ownership transfer", () => {
  const successorNodeId = "node_018f4f5e-0000-7000-8000-000000000006";
  const bindinglessNodeId = "node_018f4f5e-0000-7000-8000-000000000007";
  const successorGrantId = "grant_018f4f5e-0000-7000-8000-000000000006";
  const expiredGrantId = "grant_018f4f5e-0000-7000-8000-000000000007";
  const intermediateGrantId = "grant_018f4f5e-0000-7000-8000-000000000008";
  const transferId = "transfer_018f4f5e-0000-7000-8000-000000000001";
  const parentExpiry = "2026-07-30T13:00:00.000Z";
  const childExpiry = "2026-07-30T12:50:00.000Z";
  const fenceNow = new Date("2026-07-30T12:30:00.000Z");

  const lostBinding = {
    nodeId: midLeadNodeId,
    agentId: "lost-lead",
    generation: 1,
  };
  const crewBinding = {
    nodeId: grandchildNodeId,
    agentId: "crew-worker",
    generation: 1,
  };
  const successorBinding = {
    nodeId: successorNodeId,
    agentId: "successor-lead",
    generation: 1,
  };

  const ownerFences = {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: 1,
    binding: ownerBinding,
  };
  const successorFences = {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: 1,
    binding: successorBinding,
  };

  function bindingFor(
    ref: typeof successorBinding,
    agentId: string,
    sessionSuffix: string,
    unboundAt: string | null = null,
  ) {
    const locator = {
      ...sessionLocator,
      subject: { kind: "agent" as const, agentId },
      sessionId: `ses_018f4f5e-0000-7000-8000-0000000000${sessionSuffix}`,
    };
    seedFlatAgent(
      db,
      agentId,
      agentId,
      locator,
      `/worktree-${agentId}`,
      `hive/${agentId}`,
    );
    return {
      ...ref,
      provider: "codex" as const,
      model: "gpt-5",
      sessionLocator: locator,
      worktree: `/worktree-${agentId}`,
      branch: `hive/${agentId}`,
      baseSha: gitSha,
      credentialId: `cred-${agentId}`,
      boundAt: createdAt,
      unboundAt,
    };
  }

  function seedTransferWorld(successorGrantTokens = 6_000) {
    store.putRun(validRun(), null);
    store.putNode(
      {
        nodeId: ownerNodeId,
        runId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    store.putAgentBinding(bindingFor(ownerBinding, "lead", "01"), runId);
    store.putNode(
      {
        nodeId: midLeadNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
      undefined,
      rootConferral,
    );
    store.putNode(
      {
        nodeId: grandchildNodeId,
        runId,
        parentNodeId: midLeadNodeId,
        ownerNodeId: midLeadNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    store.putNode(
      {
        nodeId: successorNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
      undefined,
      rootConferral,
    );
    store.putAgentBinding(bindingFor(lostBinding, "lost-lead", "02"), runId);
    store.putAgentBinding(bindingFor(crewBinding, "crew-worker", "03"), runId);
    store.putAgentBinding(
      bindingFor(successorBinding, "successor-lead", "04"),
      runId,
    );
    // Root self-grant declares every node so grants below it attenuate.
    store.putGrant(
      validGrant({
        descendantNodeIds: [
          ownerNodeId,
          midLeadNodeId,
          grandchildNodeId,
          successorNodeId,
        ],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 4,
          tokens: 20_000,
          costCents: 200,
          wallTimeMs: 3_600_000,
          retries: 2,
        },
        expiresAt: parentExpiry,
      }),
      ownerFences,
    );
    // The soon-to-be-lost lead's own grant, issued by the root.
    store.putGrant(
      validGrant({
        grantId: leadChildGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: lostBinding,
        descendantNodeIds: [midLeadNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 10_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
        expiresAt: parentExpiry,
      }),
      ownerFences,
    );
    // The crew grant the lost lead issued to its worker.
    store.putGrant(
      validGrant({
        grantId: grandchildGrantId,
        parentGrantId: leadChildGrantId,
        issuer: lostBinding,
        subject: crewBinding,
        descendantNodeIds: [grandchildNodeId],
        actions: ["read", "write"],
        budget: {
          sessions: 1,
          tokens: 4_000,
          costCents: 40,
          wallTimeMs: 1_000_000,
          retries: 0,
        },
        expiresAt: childExpiry,
      }),
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: lostBinding,
      },
    );
    // The successor's own grant, already held when the transfer arrives.
    store.putGrant(
      validGrant({
        grantId: successorGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: successorBinding,
        descendantNodeIds: [successorNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: successorGrantTokens,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
        expiresAt: parentExpiry,
      }),
      ownerFences,
    );
  }

  function unbindLostLead() {
    store.putAgentBinding(
      bindingFor(lostBinding, "lost-lead", "02", "2026-07-30T12:20:00.000Z"),
      runId,
    );
  }

  function transferInput(overrides: Record<string, unknown> = {}) {
    return {
      transferId,
      runId,
      lostOwnerNodeId: midLeadNodeId,
      successorNodeId,
      successorGrantId,
      createdAt,
      ...overrides,
    };
  }

  test("transfer moves the subtree to the successor and records the daemon-derived reason", () => {
    seedTransferWorld();
    unbindLostLead();

    const record = store.transferOwnership(
      transferInput(),
      ownerFences,
      successorFences,
      fenceNow,
    );

    expect(record.reason).toBe("owner-bindings-unbound");
    expect(record.hierarchyRevision).toBe("1");
    expect(record.actingBinding).toEqual(ownerBinding);
    expect(record.successorBinding).toEqual(successorBinding);
    expect(store.getOwnershipTransfer(transferId)).toEqual(record);

    // The crew node re-parents and re-owns to the successor; the dead node
    // keeps its own place under the root.
    const crew = store.getNode(grandchildNodeId);
    expect(crew?.parentNodeId).toBe(successorNodeId);
    expect(crew?.ownerNodeId).toBe(successorNodeId);
    expect(crew?.revision).toBe("2");
    expect(store.getNode(midLeadNodeId)?.parentNodeId).toBe(ownerNodeId);

    // The lost owner's own grant is revoked; the crew grant is re-issued in
    // place under the successor at the new hierarchy revision.
    expect(store.getGrant(leadChildGrantId)?.status).toBe("revoked");
    const crewGrant = store.getGrant(grandchildGrantId);
    expect(crewGrant?.issuer).toEqual(successorBinding);
    expect(crewGrant?.parentGrantId).toBe(successorGrantId);
    expect(crewGrant?.hierarchyRevision).toBe("1");
    expect(crewGrant?.status).toBe("active");

    // One transfer is one fence advance, however many nodes moved.
    expect(store.getFences(runId)?.hierarchyRevision).toBe("1");

    // The record is append-only: a replay under current fences conflicts and
    // rolls its own fence advance back.
    expect(() =>
      store.transferOwnership(
        transferInput(),
        { ...ownerFences, expectedHierarchyRevision: "1" },
        { ...successorFences, expectedHierarchyRevision: "1" },
        fenceNow,
      ),
    ).toThrow(HierarchyConflictError);
    expect(store.getFences(runId)?.hierarchyRevision).toBe("1");
  });

  test("a caller-authored death fact is refused; the reason is daemon-derived only", () => {
    seedTransferWorld();
    unbindLostLead();
    const authored = {
      ...transferInput(),
      reason: "died",
    } as OwnershipTransferInput;
    expect(() =>
      store.transferOwnership(authored, ownerFences, successorFences, fenceNow),
    ).toThrow(/[Uu]nrecognized key/);
    expect(store.getOwnershipTransfer(transferId)).toBeNull();
  });

  test("transfer over a node the store does not record as lost is refused", () => {
    seedTransferWorld();
    // The lost lead's binding is still bound: no death evidence.
    expect(() =>
      store.transferOwnership(
        transferInput(),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/still has a live binding/);
    expect(store.getOwnershipTransfer(transferId)).toBeNull();
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");

    // A node with no bindings at all is the same refusal: nothing records it.
    store.putNode(
      {
        nodeId: bindinglessNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    expect(() =>
      store.transferOwnership(
        transferInput({ lostOwnerNodeId: bindinglessNodeId }),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/still has a live binding/);
  });

  test("transfer to a successor outside the run is refused", () => {
    seedTransferWorld();
    unbindLostLead();
    const foreignRunId = "run_018f4f5e-0000-7000-8000-000000000002";
    const foreignNodeId = "node_018f4f5e-0000-7000-8000-000000000099";
    store.putRun({ ...validRun(), runId: foreignRunId }, null);
    store.putNode(
      {
        nodeId: foreignNodeId,
        runId: foreignRunId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );

    expect(() =>
      store.transferOwnership(
        transferInput({ successorNodeId: foreignNodeId }),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/belongs to run/);
    expect(store.getOwnershipTransfer(transferId)).toBeNull();
    expect(store.getNode(grandchildNodeId)?.parentNodeId).toBe(midLeadNodeId);
  });

  test("the run root cannot be transferred; that loss is queen succession", () => {
    seedTransferWorld();
    expect(() =>
      store.transferOwnership(
        transferInput({ lostOwnerNodeId: ownerNodeId }),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/run root/);
    expect(store.getOwnershipTransfer(transferId)).toBeNull();
  });

  test("only the lost node's current owner may authorize the transfer", () => {
    seedTransferWorld();
    unbindLostLead();
    expect(() =>
      store.transferOwnership(
        transferInput(),
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: crewBinding,
        },
        successorFences,
        fenceNow,
      ),
    ).toThrow(/only the current owner/);
    expect(store.getOwnershipTransfer(transferId)).toBeNull();
  });

  test("a successor inside the lost subtree, or an unbound one, is refused", () => {
    seedTransferWorld();
    unbindLostLead();
    // The crew node sits under the lost lead: re-parenting it under itself
    // would cycle the tree.
    expect(() =>
      store.transferOwnership(
        transferInput({ successorNodeId: grandchildNodeId }),
        ownerFences,
        {
          expectedHierarchyRevision: "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: crewBinding,
        },
        fenceNow,
      ),
    ).toThrow(/inside the lost subtree/);

    // A dead successor is no owner at all.
    store.putAgentBinding(
      bindingFor(
        successorBinding,
        "successor-lead",
        "04",
        "2026-07-30T12:25:00.000Z",
      ),
      runId,
    );
    expect(() =>
      store.transferOwnership(
        transferInput(),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/unbound/);
    expect(store.getOwnershipTransfer(transferId)).toBeNull();
  });

  test("a successor without lead standing cannot take the crew grants", () => {
    seedTransferWorld();
    unbindLostLead();
    store.putNode(
      {
        nodeId: successorNodeId,
        runId,
        parentNodeId: ownerNodeId,
        ownerNodeId,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "2",
      },
      "1",
      undefined,
      rootConferral,
    );
    expect(() =>
      store.transferOwnership(
        transferInput(),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/not lead-worker/);
    expect(store.getOwnershipTransfer(transferId)).toBeNull();
    expect(store.getNode(grandchildNodeId)?.parentNodeId).toBe(midLeadNodeId);
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");
  });

  test("a lost owner's expired grant is deliberately left behind, not re-issued", () => {
    seedTransferWorld();
    // Status is still active but the expiry has passed: nothing sweeps the
    // status, the clock has already revoked it, and the transfer leaves it
    // where it lies rather than moving dead authority under the successor.
    store.putGrant(
      validGrant({
        grantId: expiredGrantId,
        parentGrantId: leadChildGrantId,
        issuer: lostBinding,
        subject: crewBinding,
        descendantNodeIds: [grandchildNodeId],
        actions: ["read"],
        budget: {
          sessions: 1,
          tokens: 1_000,
          costCents: 10,
          wallTimeMs: 500_000,
          retries: 0,
        },
        expiresAt: "2026-07-30T12:10:00.000Z",
      }),
      {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding: lostBinding,
      },
    );
    unbindLostLead();

    store.transferOwnership(
      transferInput(),
      ownerFences,
      successorFences,
      fenceNow,
    );

    const leftBehind = store.getGrant(expiredGrantId);
    expect(leftBehind?.issuer).toEqual(lostBinding);
    expect(leftBehind?.parentGrantId).toBe(leadChildGrantId);
    expect(leftBehind?.hierarchyRevision).toBe("0");
    expect(leftBehind?.status).toBe("active");
    // The live crew grant moved; only the expired one stayed.
    expect(store.getGrant(grandchildGrantId)?.issuer).toEqual(successorBinding);
  });

  test("a successor grant that is revoked, expired, or not the successor's own is refused", () => {
    seedTransferWorld();
    unbindLostLead();

    // Held by the lost lead, not the successor binding.
    expect(() =>
      store.transferOwnership(
        transferInput({ successorGrantId: leadChildGrantId }),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/not held by the successor binding/);

    // Expired: re-stamped into the past while its status stays active.
    store.putGrant(
      validGrant({
        grantId: successorGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: successorBinding,
        descendantNodeIds: [successorNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 6_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
        expiresAt: "2026-07-30T12:10:00.000Z",
      }),
      ownerFences,
    );
    expect(() =>
      store.transferOwnership(
        transferInput(),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/not live/);

    // Revoked outright.
    store.putGrant(
      validGrant({
        grantId: successorGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: successorBinding,
        descendantNodeIds: [successorNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 6_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
        expiresAt: parentExpiry,
        status: "revoked",
      }),
      ownerFences,
    );
    expect(() =>
      store.transferOwnership(
        transferInput(),
        ownerFences,
        successorFences,
        fenceNow,
      ),
    ).toThrow(/not live/);

    expect(store.getOwnershipTransfer(transferId)).toBeNull();
    expect(store.getNode(grandchildNodeId)?.parentNodeId).toBe(midLeadNodeId);
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");
  });

  test("a grant chain deeper than one link refreshes root-down through the transfer", () => {
    seedTransferWorld();
    // Widen the root grant, then interpose a root-held intermediate grant
    // between it and the successor grant: the successor's parent chain is now
    // two links, and every link must ride the fence advance before the next
    // one revalidates against it.
    store.putGrant(
      validGrant({
        descendantNodeIds: [
          ownerNodeId,
          midLeadNodeId,
          grandchildNodeId,
          successorNodeId,
        ],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 5,
          tokens: 40_000,
          costCents: 400,
          wallTimeMs: 3_600_000,
          retries: 2,
        },
        expiresAt: parentExpiry,
      }),
      ownerFences,
    );
    store.putGrant(
      validGrant({
        grantId: intermediateGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: ownerBinding,
        descendantNodeIds: [
          ownerNodeId,
          midLeadNodeId,
          grandchildNodeId,
          successorNodeId,
        ],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 3,
          tokens: 15_000,
          costCents: 150,
          wallTimeMs: 3_000_000,
          retries: 2,
        },
        expiresAt: parentExpiry,
      }),
      ownerFences,
    );
    store.putGrant(
      validGrant({
        grantId: successorGrantId,
        parentGrantId: intermediateGrantId,
        issuer: ownerBinding,
        subject: successorBinding,
        descendantNodeIds: [successorNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 6_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
        expiresAt: parentExpiry,
      }),
      ownerFences,
    );
    unbindLostLead();

    store.transferOwnership(
      transferInput(),
      ownerFences,
      successorFences,
      fenceNow,
    );

    // Attenuation pins parent and child fence fields equal, so a child at the
    // new revision proves its parent was refreshed first.
    expect(store.getGrant(grantId)?.hierarchyRevision).toBe("1");
    expect(store.getGrant(intermediateGrantId)?.hierarchyRevision).toBe("1");
    expect(store.getGrant(successorGrantId)?.hierarchyRevision).toBe("1");
    expect(store.getGrant(grandchildGrantId)?.issuer).toEqual(successorBinding);
    expect(store.getOwnershipTransfer(transferId)?.hierarchyRevision).toBe("1");
  });
});

function testNode(
  nodeId: string,
  parentNodeId: string | null,
  overrides: Partial<HierarchyNode> = {},
): HierarchyNode {
  return {
    nodeId,
    runId,
    parentNodeId,
    ownerNodeId: parentNodeId,
    organizationalRole: "worker",
    assignmentKind: "author",
    taskScope: [taskId],
    capacityCharge: 1,
    lifecycle: "active",
    revision: "1",
    ...overrides,
  };
}

describe("putNode topology invariants", () => {
  test("the run's first root writes; a second null-parent node is refused", () => {
    store.putRun(validRun(), null);
    const root = store.putNode(
      testNode(ownerNodeId, null, { organizationalRole: "lead-worker" }),
      null,
    );
    expect(root.parentNodeId).toBeNull();

    expect(() => store.putNode(testNode(assigneeNodeId, null), null)).toThrow(
      /already has root/,
    );
    expect(store.getNode(assigneeNodeId)).toBeNull();
    expect(
      store
        .listNodes(runId)
        .filter((node) => node.parentNodeId === null)
        .map((node) => node.nodeId),
    ).toEqual([ownerNodeId]);
  });

  test("a parent that does not exist is refused on the general path", () => {
    seedRunWorld(store);
    expect(() =>
      store.putNode(
        testNode(midLeadNodeId, "node_018f4f5e-0000-7000-8000-000000000099"),
        null,
      ),
    ).toThrow(/does not exist/);
    expect(store.getNode(midLeadNodeId)).toBeNull();
  });

  test("a parent in another run is refused on the general path", () => {
    seedRunWorld(store);
    const foreignRunId = "run_018f4f5e-0000-7000-8000-000000000002";
    const foreignNodeId = "node_018f4f5e-0000-7000-8000-000000000099";
    store.putRun({ ...validRun(), runId: foreignRunId }, null);
    store.putNode(
      {
        ...testNode(foreignNodeId, null, {
          organizationalRole: "lead-worker",
        }),
        runId: foreignRunId,
      },
      null,
    );
    expect(() =>
      store.putNode(testNode(midLeadNodeId, foreignNodeId), null),
    ).toThrow(/belongs to run/);
    expect(store.getNode(midLeadNodeId)).toBeNull();
  });

  test("a cycle is refused, including the two-node cycle", () => {
    seedRunWorld(store);
    store.putNode(testNode(grandchildNodeId, assigneeNodeId), null);

    // The two-node cycle: the root points at its own child, which still
    // points back at the root.
    expect(() =>
      store.putNode(
        testNode(ownerNodeId, assigneeNodeId, {
          organizationalRole: "lead-worker",
          revision: "2",
        }),
        "1",
        "0",
      ),
    ).toThrow(/own subtree/);
    expect(store.getNode(ownerNodeId)?.parentNodeId).toBeNull();

    // A longer chain closes the same way: root -> assignee -> grandchild.
    expect(() =>
      store.putNode(
        testNode(assigneeNodeId, grandchildNodeId, { revision: "2" }),
        "1",
        "0",
      ),
    ).toThrow(/own subtree/);
    expect(() =>
      store.putNode(
        testNode(assigneeNodeId, assigneeNodeId, { revision: "2" }),
        "1",
        "0",
      ),
    ).toThrow(/cannot parent itself/);
    expect(store.getNode(assigneeNodeId)?.parentNodeId).toBe(ownerNodeId);
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");
  });

  test("re-rooting an existing node to null is refused on the general path", () => {
    seedRunWorld(store);
    expect(() =>
      store.putNode(
        testNode(assigneeNodeId, null, { revision: "2" }),
        "1",
        "0",
      ),
    ).toThrow(/never re-roots to null/);
    expect(store.getNode(assigneeNodeId)?.parentNodeId).toBe(ownerNodeId);
    expect(store.getFences(runId)?.hierarchyRevision).toBe("0");
  });
});

describe("organizationalRole conferral provenance", () => {
  const assigneeConferral = {
    binding: assigneeBinding,
    expectedCapabilityEpoch: 1,
  };

  function promoteAssignee() {
    return testNode(assigneeNodeId, ownerNodeId, {
      organizationalRole: "lead-worker",
      revision: "2",
    });
  }

  test("an unauthorized actor cannot confer lead-worker; the run root can", () => {
    seedRunWorld(store);
    expect(() => store.putNode(promoteAssignee(), "1")).toThrow(
      /requires an acting binding authorized to confer it/,
    );
    // The worker signing its own promotion is the escalation itself.
    expect(() =>
      store.putNode(promoteAssignee(), "1", undefined, assigneeConferral),
    ).toThrow(/is not lead-worker/);
    expect(store.getNode(assigneeNodeId)?.organizationalRole).toBe("worker");

    const promoted = store.putNode(
      promoteAssignee(),
      "1",
      undefined,
      rootConferral,
    );
    expect(promoted.organizationalRole).toBe("lead-worker");
  });

  test("an unbound acting binding cannot confer", () => {
    seedRunWorld(store);
    const live = store.getAgentBinding(ownerBinding);
    if (live === null) throw new Error("root binding fixture disappeared");
    store.putAgentBinding({ ...live, unboundAt: createdAt }, runId);

    expect(() =>
      store.putNode(promoteAssignee(), "1", undefined, rootConferral),
    ).toThrow(/is unbound and cannot confer/);
    expect(store.getNode(assigneeNodeId)?.organizationalRole).toBe("worker");
  });

  test("a lead confers inside its own subtree only", () => {
    seedRunWorld(store);
    store.putNode(promoteAssignee(), "1", undefined, rootConferral);
    store.putNode(testNode(outsideNodeId, ownerNodeId), null);

    expect(() =>
      store.putNode(
        testNode(midLeadNodeId, outsideNodeId, {
          ownerNodeId: assigneeNodeId,
          organizationalRole: "lead-worker",
        }),
        null,
        undefined,
        assigneeConferral,
      ),
    ).toThrow(/outside acting lead/);
    expect(store.getNode(midLeadNodeId)).toBeNull();

    const underLead = store.putNode(
      testNode(midLeadNodeId, assigneeNodeId, {
        organizationalRole: "lead-worker",
      }),
      null,
      undefined,
      assigneeConferral,
    );
    expect(underLead.organizationalRole).toBe("lead-worker");
  });

  test("conferral binds the acting binding's live capabilityEpoch", () => {
    seedRunWorld(store);
    bumpCapabilityEpoch(db, ownerBinding);
    try {
      store.putNode(promoteAssignee(), "1", undefined, rootConferral);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HierarchyFenceError);
      expect((error as HierarchyFenceError).fence).toBe("capabilityEpoch");
    }
    expect(store.getNode(assigneeNodeId)?.organizationalRole).toBe("worker");

    const promoted = store.putNode(promoteAssignee(), "1", undefined, {
      binding: ownerBinding,
      expectedCapabilityEpoch: 2,
    });
    expect(promoted.organizationalRole).toBe("lead-worker");
  });

  test("a self-labeled lead cannot issue child grants; conferral opens the door", () => {
    seedRunWorld(store);
    store.putNode(testNode(grandchildNodeId, assigneeNodeId), null);
    const ownerFences = {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: ownerBinding,
    };
    store.putGrant(
      validGrant({
        descendantNodeIds: [ownerNodeId, assigneeNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 4,
          tokens: 20_000,
          costCents: 200,
          wallTimeMs: 3_600_000,
          retries: 2,
        },
      }),
      ownerFences,
    );
    store.putGrant(
      validGrant({
        grantId: childGrantId,
        parentGrantId: grantId,
        issuer: ownerBinding,
        subject: assigneeBinding,
        descendantNodeIds: [assigneeNodeId, grandchildNodeId],
        actions: ["read", "write", "test", "spawn"],
        budget: {
          sessions: 2,
          tokens: 10_000,
          costCents: 100,
          wallTimeMs: 2_000_000,
          retries: 1,
        },
      }),
      ownerFences,
    );

    // Step one of the escalation: label itself lead-worker.
    expect(() =>
      store.putNode(promoteAssignee(), "1", undefined, assigneeConferral),
    ).toThrow(/is not lead-worker/);

    // Step two, which the label was for, stays shut behind the same standing.
    const childGrant = validGrant({
      grantId: grandchildGrantId,
      parentGrantId: childGrantId,
      issuer: assigneeBinding,
      subject: {
        nodeId: grandchildNodeId,
        agentId: "grandchild",
        generation: 1,
      },
      descendantNodeIds: [grandchildNodeId],
      actions: ["read"],
      budget: {
        sessions: 1,
        tokens: 1_000,
        costCents: 10,
        wallTimeMs: 500_000,
        retries: 0,
      },
    });
    const assigneeFences = {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: assigneeBinding,
    };
    expect(() => store.putGrant(childGrant, assigneeFences)).toThrow(
      /not lead-worker/,
    );
    expect(store.getGrant(grandchildGrantId)).toBeNull();

    // Positive control: conferred by the run root, the same grant lands.
    store.putNode(promoteAssignee(), "1", undefined, rootConferral);
    const landed = store.putGrant(childGrant, assigneeFences);
    expect(landed.issuer).toEqual(assigneeBinding);
  });
});

// The genesis seam. A run's root holds a stable principal, not an AgentBinding
// or an agents-table row.
describe("run-root grant issuance", () => {
  const rootIssuer = {
    nodeId: ownerNodeId,
    agentId: ORCHESTRATOR_NAME,
    generation: 1,
  };
  const rootFences = {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: 0,
    binding: rootIssuer,
  };

  function seedRootGrantWorld(): void {
    seedRunWorld(store);
    store.putRootBinding(runId, ownerNodeId);
  }

  test("the run root issues the first grant without an AgentBinding", () => {
    seedRootGrantWorld();
    expect(store.getAgentBinding(rootIssuer)).toBeNull();
    expect(store.getRootBinding(runId)).toEqual(rootIssuer);

    const grant = store.putGrant(
      validGrant({
        issuer: rootIssuer,
        subject: assigneeBinding,
        capabilityEpoch: 0,
      }),
      rootFences,
      "run-root",
    );

    expect(grant.issuer).toEqual(rootIssuer);
    expect(store.getGrant(grantId)?.issuer.nodeId).toBe(ownerNodeId);
  });

  test("the ordinary agent path still refuses the root principal", () => {
    seedRootGrantWorld();

    expect(() =>
      store.putGrant(
        validGrant({
          issuer: rootIssuer,
          subject: assigneeBinding,
          capabilityEpoch: 0,
        }),
        rootFences,
      ),
    ).toThrow(/no agent binding for queen/);
    expect(store.getGrant(grantId)).toBeNull();
  });

  test("run-root issuance is refused for a node that is not the root", () => {
    seedRootGrantWorld();
    const childIssuer = {
      nodeId: assigneeNodeId,
      agentId: ORCHESTRATOR_NAME,
      generation: 1,
    };

    expect(() =>
      store.putGrant(
        validGrant({
          issuer: childIssuer,
          subject: assigneeBinding,
          capabilityEpoch: 0,
        }),
        { ...rootFences, binding: childIssuer },
        "run-root",
      ),
    ).toThrow(/stored root principal/);
    expect(store.getGrant(grantId)).toBeNull();
  });

  test("run-root issuance is refused for the root of a different run", () => {
    seedRootGrantWorld();
    const otherRunId = "run_018f4f5e-0000-7000-8000-0000000000d1";
    const otherRootId = "node_018f4f5e-0000-7000-8000-0000000000d2";
    store.putRun({ ...validRun(), runId: otherRunId }, null);
    store.putNode(
      {
        nodeId: otherRootId,
        runId: otherRunId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    const foreignIssuer = {
      nodeId: otherRootId,
      agentId: ORCHESTRATOR_NAME,
      generation: 1,
    };

    expect(() =>
      store.putGrant(
        validGrant({
          issuer: foreignIssuer,
          subject: assigneeBinding,
          capabilityEpoch: 0,
        }),
        { ...rootFences, binding: foreignIssuer },
        "run-root",
      ),
    ).toThrow(/stored root principal/);
  });

  test("run-root issuance is refused when the node does not exist at all", () => {
    seedRootGrantWorld();
    const ghost = {
      nodeId: "node_018f4f5e-0000-7000-8000-0000000000e9",
      agentId: ORCHESTRATOR_NAME,
      generation: 1,
    };

    expect(() =>
      store.putGrant(
        validGrant({
          issuer: ghost,
          subject: assigneeBinding,
          capabilityEpoch: 0,
        }),
        { ...rootFences, binding: ghost },
        "run-root",
      ),
    ).toThrow(/stored root principal/);
  });

  test("root issuance still fences on hierarchyRevision and runEpoch", () => {
    seedRootGrantWorld();
    bumpHierarchyRevision(db, runId);

    expect(() =>
      store.putGrant(
        validGrant({
          issuer: rootIssuer,
          subject: assigneeBinding,
          capabilityEpoch: 0,
        }),
        rootFences,
        "run-root",
      ),
    ).toThrow();
  });
});
