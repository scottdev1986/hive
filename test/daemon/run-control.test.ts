import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  HierarchyConflictError,
  HierarchyFenceError,
} from "../../src/daemon/hierarchy-service/records";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import {
  ABORTED_RUN_ADMISSION_SEAM,
  RunControl,
  RunNotFoundError,
  runStageDigest,
} from "../../src/daemon/hierarchy-service/hierarchy-run-control";
import type { DelegationGrant } from "../../src/schemas/hierarchy-node";
import type {
  PlanRevision,
  Run,
  RunBudget,
  SpecRevision,
  TopologyDecision,
} from "../../src/schemas/hierarchy-run";
import type { IntegrationStage } from "../../src/schemas/integration-stage";
import {
  RUN_CONTROL_FAILURE_CODES,
  type RunControlBody,
  type RunControlIntent,
  RunControlIntentSchema,
} from "../../src/schemas/run-control";
import type { TaskDetail } from "../../src/schemas/task-detail";
import { SpawnAdmission } from "../../src/daemon/spawn/admission";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const nodeId = "node_018f4f5e-0000-7000-8000-000000000001";
const stageId = "stage_018f4f5e-0000-7000-8000-000000000001";
const grantId = "grant_018f4f5e-0000-7000-8000-000000000001";
const artId = "art_018f4f5e-0000-7000-8000-000000000003";
const otherArtId = "art_018f4f5e-0000-7000-8000-000000000004";
const createdAt = "2026-07-30T12:00:00.000Z";

// Each bound record carries its OWN digest, so a drift test that moves one
// fact cannot accidentally still match another record's value.
const digestOf = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;
const specDigest = digestOf("a");
const planDigest = digestOf("b");
const topologyDigest = digestOf("c");
const budgetDigest = digestOf("d");
const strangeDigest = digestOf("e");
const baseSha = "f".repeat(40);
const headSha = "1".repeat(40);
const otherSha = "2".repeat(40);

const binding = { nodeId, agentId: "worker", generation: 1 };

function validRun(overrides: Partial<Run> = {}): Run {
  return {
    runId,
    revision: "1",
    repo: "hive",
    instanceId: "instance-1",
    approvedSpec: null,
    currentPlan: { revision: "1", digest: planDigest },
    topology: { revision: "1", digest: topologyDigest },
    phase: "P0",
    g1: { state: "pending" },
    g2: { state: "pending" },
    baseSha,
    budget: { revision: "1", digest: budgetDigest },
    runEpoch: 0,
    lifecycle: "active",
    ...overrides,
  };
}

function validSpec(): SpecRevision {
  return {
    runId,
    revision: "1",
    digest: specDigest,
    createdAt,
    lifecycle: "proposed",
    objective: "Run control",
    acceptanceIds: ["A14"],
    scope: "gate decisions",
    nonGoals: ["promotion"],
    constraints: { architecture: [], security: [], outwardEffect: [] },
    gatePolicy: {
      reviewLocGreenMax: 100,
      reviewLocAmberMax: 250,
      reviewFilesMax: 10,
    },
    evidenceArtifactRefs: [artId],
    proposer: "queen",
    engineerApproval: null,
  };
}

function validPlan(): PlanRevision {
  return {
    runId,
    revision: "1",
    digest: planDigest,
    createdAt,
    lifecycle: "proposed",
    parentRevision: null,
    taskDag: [{ taskId, dependsOn: [] }],
    topologyRationale: "one task",
    proposer: "queen",
  };
}

function validTopology(): TopologyDecision {
  return {
    runId,
    revision: "1",
    digest: topologyDigest,
    createdAt,
    lifecycle: "proposed",
    shape: "direct",
    decomposition: {
      planRevision: { revision: "1", digest: planDigest },
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
      predictedCriticalPath: "run control",
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
      specRevision: { revision: "1", digest: specDigest },
      rationale: "direct",
    },
  };
}

function validBudget(): RunBudget {
  const limit = { hard: 4, soft: 2, reserved: 2, used: 1 };
  return {
    runId,
    revision: "1",
    digest: budgetDigest,
    createdAt,
    lifecycle: "proposed",
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
}

function validStage(
  overrides: Partial<IntegrationStage> = {},
): IntegrationStage {
  return {
    stageId,
    revision: "1",
    kind: "run",
    runId,
    ownerNodeId: null,
    daemonRef: "refs/hive/run-stage",
    baseSha,
    headSha,
    acceptedPromotionGrantIds: [],
    validation: { environment: "bun", evidenceArtifactRefs: [artId] },
    queueHighWater: 0,
    lifecycle: "active",
    ...overrides,
  } as IntegrationStage;
}

function validGrant(): DelegationGrant {
  return {
    grantId,
    parentGrantId: null,
    issuer: binding,
    subject: binding,
    runId,
    taskIds: [taskId],
    descendantNodeIds: [nodeId],
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
  };
}

function seed(store: HierarchyStore, run: Run = validRun()): void {
  store.putRun(run, null);
  store.putSpecRevision(validSpec());
  store.putPlanRevision(validPlan(), 0);
  store.putTopologyDecision(validTopology());
  store.putRunBudget(validBudget(), 0);
  store.putIntegrationStage(validStage(), null);
  store.putNode(
    {
      nodeId,
      runId,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "worker",
      assignmentKind: "author",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    },
    null,
  );
  store.putRootBinding(runId, nodeId);
  store.putAgentBinding(
    {
      ...binding,
      provider: "codex",
      model: "gpt-5",
      sessionLocator: {
        schemaVersion: 1,
        instanceId: "instance-1",
        subject: { kind: "agent", agentId: "worker" },
        generation: 1,
        sessionId: "ses_018f4f5e-0000-7000-8000-000000000001",
        hostKind: "sessiond",
        engineBuildId: "build-1",
      },
      worktree: "/worktree",
      branch: "hive/worker",
      baseSha,
      credentialId: "cred-worker",
      boundAt: createdAt,
      unboundAt: null,
    },
    runId,
  );
}

const g1Body = (overrides: Partial<RunControlBody> = {}): RunControlBody =>
  ({
    operation: "approve-g1",
    runId,
    spec: { revision: "1", digest: specDigest },
    plan: { revision: "1", digest: planDigest },
    topology: { revision: "1", digest: topologyDigest },
    budget: { revision: "1", digest: budgetDigest },
    ...overrides,
  }) as RunControlBody;

const g2Body = (overrides: Partial<RunControlBody> = {}): RunControlBody =>
  ({
    operation: "approve-g2",
    runId,
    runStageSha: headSha,
    digest: runStageDigest(validStage()),
    evidenceArtifactRefs: [artId],
    targetMainBase: baseSha,
    ...overrides,
  }) as RunControlBody;

// The key is derived from what the intent is fenced on, so two identical
// intents replay under one key while a genuinely different attempt spends its
// own — the same discipline a client is expected to keep.
const intent = (
  body: RunControlBody,
  revision = "1",
  epoch = "0",
  key?: string,
): RunControlIntent => ({
  schemaVersion: 1,
  intentId: `intent-${body.operation}`,
  expected: { kind: "revision-and-epoch", revision, epoch },
  idempotencyKey: key ?? `key-${body.operation}-${revision}-${epoch}`,
  body,
});

/** G2 is only reachable after G1, so its fixtures start from an approved G1. */
function seedThroughG1(): void {
  seed(store);
  const approved = control.apply(intent(g1Body()), "engineer");
  if (approved.outcome.status !== "accepted") {
    throw new Error("G1 fixture did not approve");
  }
}

let db: HiveDatabase;
let store: HierarchyStore;
let control: RunControl;

beforeEach(() => {
  db = new HiveDatabase(":memory:");
  store = new HierarchyStore(db);
  control = new RunControl(store);
});

afterEach(() => {
  db.close();
});

describe("G1 binds the exact proposal package", () => {
  test("the exact package is approved and recorded fact by fact", () => {
    seed(store);
    const result = control.apply(intent(g1Body()), "engineer");

    expect(result.outcome.status).toBe("accepted");
    const run = store.getRun(runId);
    expect(run?.g1).toEqual({
      state: "approved",
      decider: "engineer",
      decidedAt: expect.any(String),
      spec: { revision: "1", digest: specDigest },
      plan: { revision: "1", digest: planDigest },
      topology: { revision: "1", digest: topologyDigest },
      budget: { revision: "1", digest: budgetDigest },
    });
    expect(run?.approvedSpec).toEqual({ revision: "1", digest: specDigest });
    expect(run?.revision).toBe("2");
  });

  // One test per bound fact: each moves exactly one digest and must be the
  // reason the approval is refused.
  for (const drift of [
    { fact: "spec", body: { spec: { revision: "1", digest: strangeDigest } } },
    { fact: "plan", body: { plan: { revision: "1", digest: strangeDigest } } },
    {
      fact: "topology",
      body: { topology: { revision: "1", digest: strangeDigest } },
    },
    {
      fact: "budget",
      body: { budget: { revision: "1", digest: strangeDigest } },
    },
  ]) {
    test(`a drifted ${drift.fact} digest is refused and nothing is approved`, () => {
      seed(store);
      const result = control.apply(intent(g1Body(drift.body)), "engineer");

      expect(result.outcome).toEqual({
        status: "rejected",
        failure: {
          code: RUN_CONTROL_FAILURE_CODES.gateFactDrift,
          message: expect.stringContaining(drift.fact),
        },
      });
      expect(store.getRun(runId)?.g1.state).toBe("pending");
      expect(store.getRun(runId)?.revision).toBe("1");
    });
  }

  test("a bound revision that was never written is refused", () => {
    seed(store);
    const result = control.apply(
      intent(g1Body({ plan: { revision: "9", digest: planDigest } })),
      "engineer",
    );

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.gateFactDrift,
        message: expect.stringContaining("plan revision 9 does not exist"),
      },
    });
  });

  test("an approval built before the run moved is refused on revision", () => {
    seed(store);
    store.putRun({ ...validRun(), revision: "2", phase: "P1" }, "1");

    const result = control.apply(intent(g1Body()), "engineer");

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.revisionConflict,
        message: expect.stringContaining("run is at 2"),
      },
    });
  });

  test("an approval built before the epoch moved is refused on epoch", () => {
    seed(store);
    store.advanceRunEpoch(runId, 0);

    const result = control.apply(intent(g1Body()), "engineer");

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.epochConflict,
        message: expect.stringContaining("run is at 1"),
      },
    });
  });

  test("a gate is decided once", () => {
    seed(store);
    control.apply(intent(g1Body()), "engineer");

    const again = control.apply(intent(g1Body(), "2"), "engineer");

    expect(again.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.gateAlreadyDecided,
        message: expect.stringContaining("G1"),
      },
    });
  });

  // A superseded revision is still a stored record with a valid digest, so the
  // stored-digest checks above cannot see this: only the run's own pointers can.
  for (const fact of ["plan", "topology", "budget"] as const) {
    test(`approving a superseded ${fact} while the run points elsewhere is refused`, () => {
      seed(store);
      const supersededDigest = digestOf("9");
      if (fact === "plan") {
        store.putPlanRevision(
          { ...validPlan(), revision: "2", digest: supersededDigest },
          0,
        );
      } else if (fact === "topology") {
        store.putTopologyDecision({
          ...validTopology(),
          revision: "2",
          digest: supersededDigest,
        });
      } else {
        store.putRunBudget(
          { ...validBudget(), revision: "2", digest: supersededDigest },
          0,
        );
      }
      const moved = {
        ...validRun(),
        revision: "2",
        [fact === "plan" ? "currentPlan" : fact]: {
          revision: "2",
          digest: supersededDigest,
        },
      };
      store.putRun(moved, "1");

      // The intent still names revision 1: a real record, correct digest, and
      // no longer the revision execution follows.
      const result = control.apply(intent(g1Body(), "2"), "engineer");

      expect(result.outcome).toEqual({
        status: "rejected",
        failure: {
          code: RUN_CONTROL_FAILURE_CODES.gateFactDrift,
          message: expect.stringContaining("not the run's active revision"),
        },
      });
      expect(store.getRun(runId)?.g1.state).toBe("pending");
    });
  }

  test("a paused run cannot have its gate approved", () => {
    seed(store);
    control.apply(intent({ operation: "run-pause", runId }), "engineer");

    const result = control.apply(intent(g1Body(), "2", "1"), "engineer");

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.lifecycleInvalid,
        message: expect.stringContaining("paused"),
      },
    });
  });
});

describe("G2 binds the exact assembled candidate", () => {
  test("the exact SHA, digest, evidence, and base are approved", () => {
    seedThroughG1();
    const result = control.apply(intent(g2Body(), "2"), "engineer");

    expect(result.outcome.status).toBe("accepted");
    expect(store.getRun(runId)?.g2).toEqual({
      state: "approved",
      decider: "engineer",
      decidedAt: expect.any(String),
      runStageSha: headSha,
      digest: runStageDigest(validStage()),
      evidenceArtifactRefs: [artId],
      targetMainBase: baseSha,
    });
  });

  for (const drift of [
    { fact: "run-stage SHA", body: { runStageSha: otherSha } },
    { fact: "run-stage digest", body: { digest: strangeDigest } },
    { fact: "stage evidence", body: { evidenceArtifactRefs: [otherArtId] } },
    { fact: "target-main base", body: { targetMainBase: otherSha } },
  ]) {
    test(`a drifted ${drift.fact} is refused and nothing is approved`, () => {
      seedThroughG1();
      const result = control.apply(intent(g2Body(drift.body), "2"), "engineer");

      expect(result.outcome).toEqual({
        status: "rejected",
        failure: {
          code: RUN_CONTROL_FAILURE_CODES.gateFactDrift,
          message: expect.stringContaining(drift.fact),
        },
      });
      expect(store.getRun(runId)?.g2.state).toBe("pending");
    });
  }

  test("an approval of a stage that has since moved is refused", () => {
    seedThroughG1();
    const approvalOfTheStageAsRead = g2Body();
    store.putIntegrationStage(
      validStage({ revision: "2", queueHighWater: 1 }),
      "1",
    );

    const result = control.apply(
      intent(approvalOfTheStageAsRead, "2"),
      "engineer",
    );

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.gateFactDrift,
        message: expect.stringContaining("run-stage digest"),
      },
    });
  });

  test("G2 cannot be approved while G1 is still pending", () => {
    seed(store);
    const result = control.apply(intent(g2Body()), "engineer");

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.gateOutOfOrder,
        message: expect.stringContaining("before G1"),
      },
    });
    expect(store.getRun(runId)?.g2.state).toBe("pending");
  });

  test("a stage that moves after the check is caught before the write", () => {
    // The stage is CAS-moved on the second read — the one the commit makes —
    // so the approval is decided on a stage that is already gone unless the
    // check and the write share a boundary.
    class StageMovesMidDecision extends HierarchyStore {
      armed = false;
      moved = false;
      listIntegrationStages(id: string) {
        const asRead = super.listIntegrationStages(id);
        if (this.armed && !this.moved) {
          this.moved = true;
          super.putIntegrationStage(
            validStage({ revision: "2", queueHighWater: 1 }),
            "1",
          );
        }
        return asRead;
      }
    }
    const racing = new StageMovesMidDecision(db);
    const racingControl = new RunControl(racing);
    seed(racing);
    racingControl.apply(intent(g1Body()), "engineer");
    racing.armed = true;

    const result = racingControl.apply(intent(g2Body(), "2"), "engineer");

    expect(racing.moved).toBe(true);
    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.gateFactDrift,
        message: expect.stringContaining("changed while the approval"),
      },
    });
    expect(racing.getRun(runId)?.g2.state).toBe("pending");
  });
});

describe("pause, resume, and abort move the run epoch", () => {
  test("work holding the pre-pause epoch is refused after a pause", () => {
    seed(store);
    const result = control.apply(
      intent({ operation: "run-pause", runId }),
      "engineer",
    );

    expect(result.outcome.status).toBe("accepted");
    expect(store.getRun(runId)?.lifecycle).toBe("paused");
    expect(store.getFences(runId)?.runEpoch).toBe(1);
    expect(() =>
      store.putGrant(validGrant(), {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding,
      }),
    ).toThrow(HierarchyFenceError);
  });

  test("resume reissues the epoch rather than restoring the paused one", () => {
    seed(store);
    control.apply(intent({ operation: "run-pause", runId }), "engineer");

    const result = control.apply(
      intent({ operation: "run-resume", runId }, "2", "1"),
      "engineer",
    );

    expect(result.outcome.status).toBe("accepted");
    expect(store.getRun(runId)?.lifecycle).toBe("active");
    expect(store.getFences(runId)?.runEpoch).toBe(2);
  });

  test("resuming a run that was never paused is refused", () => {
    seed(store);
    const result = control.apply(
      intent({ operation: "run-resume", runId }),
      "engineer",
    );

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.lifecycleInvalid,
        message: expect.stringContaining("active"),
      },
    });
    expect(store.getFences(runId)?.runEpoch).toBe(0);
  });

  test("abort leaves the state admission refuses: aborted plus a moved epoch", () => {
    seed(store);
    control.apply(intent({ operation: "run-abort", runId }), "engineer");

    // The promotion engine owns the refusal itself; what abort guarantees is
    // exactly the state named by ABORTED_RUN_ADMISSION_SEAM.
    expect(ABORTED_RUN_ADMISSION_SEAM).toContain("aborted");
    expect(store.getRun(runId)?.lifecycle).toBe("aborted");
    expect(store.getFences(runId)?.runEpoch).toBe(1);
    expect(() =>
      store.putGrant(validGrant(), {
        expectedHierarchyRevision: "0",
        expectedRunEpoch: 0,
        expectedCapabilityEpoch: 1,
        binding,
      }),
    ).toThrow(HierarchyFenceError);
  });

  test("an aborted run cannot be resumed", () => {
    seed(store);
    control.apply(intent({ operation: "run-abort", runId }), "engineer");

    const result = control.apply(
      intent({ operation: "run-resume", runId }, "2", "1"),
      "engineer",
    );

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.lifecycleInvalid,
        message: expect.stringContaining("aborted"),
      },
    });
  });
});

describe("every result carries what the client needs to continue", () => {
  test("an accepted result carries operation id, post-state token, and state", () => {
    seed(store);
    const result = control.apply(intent(g1Body()), "engineer");

    expect(result.intentId).toBe("intent-approve-g1");
    expect(result.operationId.length).toBeGreaterThan(0);
    expect(result.postStateToken).toEqual({
      kind: "revision-and-epoch",
      revision: "2",
      epoch: "0",
    });
    expect(result.observedPostState.g1.state).toBe("approved");
  });

  test("a rejected result carries the state that stayed in force", () => {
    seed(store);
    const result = control.apply(
      intent(g1Body({ spec: { revision: "1", digest: strangeDigest } })),
      "engineer",
    );

    expect(result.operationId.length).toBeGreaterThan(0);
    expect(result.postStateToken).toEqual({
      kind: "revision-and-epoch",
      revision: "1",
      epoch: "0",
    });
    expect(result.observedPostState.g1.state).toBe("pending");
    expect(result.observedPostState.revision).toBe("1");
  });

  test("an intent naming no stored run has no state to observe", () => {
    expect(() => control.apply(intent(g1Body()), "engineer")).toThrow(
      RunNotFoundError,
    );
  });
});

describe("an idempotency key buys exactly one decision", () => {
  test("the same intent replayed returns the original decision, not a second one", () => {
    seed(store);
    const first = control.apply(intent({ operation: "run-pause", runId }), "e");

    const replay = control.apply(
      intent({ operation: "run-pause", runId }),
      "e",
    );

    expect(replay).toEqual(first);
    expect(replay.operationId).toBe(first.operationId);
    // Replayed, not re-applied: one pause, one epoch, one revision bump.
    expect(store.getFences(runId)?.runEpoch).toBe(1);
    expect(store.getRun(runId)?.revision).toBe("2");
  });

  test("a spent key cannot be reused for different bytes", () => {
    seed(store);
    const key = "key-shared";
    control.apply(
      intent({ operation: "run-pause", runId }, "1", "0", key),
      "e",
    );

    const other = control.apply(
      intent({ operation: "run-abort", runId }, "2", "1", key),
      "e",
    );

    expect(other.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.idempotencyKeyReused,
        message: expect.stringContaining(key),
      },
    });
    expect(store.getRun(runId)?.lifecycle).toBe("paused");
    expect(other.observedPostState.lifecycle).toBe("paused");
  });

  test("a refusal spends no key: it is decided again from live state", () => {
    seed(store);
    const refused = control.apply(
      intent(g1Body({ spec: { revision: "1", digest: strangeDigest } })),
      "engineer",
    );

    expect(refused.outcome.status).toBe("rejected");
    expect(store.getRunControlDecision("key-approve-g1-1-0")).toBeNull();
    // Positive control: an accepted decision under the same shape IS recorded.
    control.apply(intent(g1Body()), "engineer");
    expect(store.getRunControlDecision("key-approve-g1-1-0")).not.toBeNull();
  });
});

describe("a lost race is a refusal, never a server fault", () => {
  test("a store conflict during the write comes back as a rejected result", () => {
    class LosesTheWrite extends HierarchyStore {
      putRun(): never {
        throw new HierarchyConflictError("9");
      }
    }
    const racing = new LosesTheWrite(db);
    seed(store);

    const result = new RunControl(racing).apply(intent(g1Body()), "engineer");

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.revisionConflict,
        message: expect.stringContaining("revision 9"),
      },
    });
    expect(result.observedPostState.revision).toBe("1");
    expect(store.getRun(runId)?.g1.state).toBe("pending");
  });

  test("a failed transition leaves no half-applied epoch behind", () => {
    // A pause is two writes: retire the epoch, then move the lifecycle. If the
    // second one loses, the first must not survive on its own — a run fenced
    // against its own workers with nothing recording why.
    class LosesTheLifecycleWrite extends HierarchyStore {
      putRun(): never {
        throw new HierarchyConflictError("9");
      }
    }
    seed(store);
    const racing = new LosesTheLifecycleWrite(db);

    const result = new RunControl(racing).apply(
      intent({ operation: "run-pause", runId }),
      "engineer",
    );

    expect(result.outcome.status).toBe("rejected");
    expect(store.getFences(runId)?.runEpoch).toBe(0);
    expect(store.getRun(runId)?.lifecycle).toBe("active");
  });

  test("an epoch fence lost during the write comes back as a rejected result", () => {
    class LosesTheEpoch extends HierarchyStore {
      advanceRunEpoch(): never {
        throw new HierarchyFenceError("runEpoch", 0, 7);
      }
    }
    const racing = new LosesTheEpoch(db);
    seed(store);

    const result = new RunControl(racing).apply(
      intent({ operation: "run-pause", runId }),
      "engineer",
    );

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.epochConflict,
        message: expect.stringContaining("epoch moved to 7"),
      },
    });
    expect(store.getRun(runId)?.lifecycle).toBe("active");
  });
});

// Genesis. Every other operation decides about a run that exists; this one is
// the reason any run exists at all, so its subject is what it writes and — more
// importantly — what it refuses to grant.
describe("run-create", () => {
  const rootNodeId = "node_018f4f5e-0000-7000-8000-0000000000f1";

  const createBody = (
    overrides: Partial<
      Extract<RunControlBody, { operation: "run-create" }>
    > = {},
  ): RunControlBody => ({
    operation: "run-create",
    runId,
    repo: "hive",
    instanceId: "instance-1",
    baseSha,
    rootNodeId,
    spec: validSpec(),
    plan: validPlan(),
    topology: validTopology(),
    budget: validBudget(),
    ...overrides,
  });

  const createIntent = (
    body: RunControlBody = createBody(),
    key = "key-run-create",
  ): RunControlIntent =>
    RunControlIntentSchema.parse({
      schemaVersion: 1,
      intentId: "intent-run-create",
      expected: { kind: "revision-and-epoch", revision: "0", epoch: "0" },
      idempotencyKey: key,
      body,
    });

  test("writes the whole run spine in one transaction", () => {
    expect(store.getRun(runId)).toBeNull();

    const result = control.apply(createIntent(), "engineer");

    expect(result.outcome).toEqual({ status: "accepted" });
    const run = store.getRun(runId);
    expect(run).not.toBeNull();
    // The package the user supplied is stored and the run points at it, so
    // approve-g1 has real records to bind rather than dangling references.
    expect(store.getSpecRevision(runId, "1")).not.toBeNull();
    expect(store.getPlanRevision(runId, "1")).not.toBeNull();
    expect(store.getTopologyDecision(runId, "1")).not.toBeNull();
    expect(store.getRunBudget(runId, "1")).not.toBeNull();
    expect(run?.currentPlan).toEqual({ revision: "1", digest: planDigest });
    expect(run?.budget).toEqual({ revision: "1", digest: budgetDigest });
    // putRun is the only thing that seeds the fence table; without this row no
    // hierarchy write in the run can derive its fences.
    expect(store.getFences(runId)).toEqual({
      hierarchyRevision: "0",
      runEpoch: 0,
    });
    expect(store.getNode(rootNodeId)?.parentNodeId).toBeNull();
    expect(store.getRootBinding(runId)).toEqual({
      nodeId: rootNodeId,
      agentId: ORCHESTRATOR_NAME,
      generation: 1,
    });
  });

  test("grants nothing: G1 stays pending while the root principal exists", () => {
    control.apply(createIntent(), "engineer");

    const run = store.getRun(runId);
    expect(run?.g1).toEqual({ state: "pending" });
    expect(run?.g2).toEqual({ state: "pending" });
    expect(run?.approvedSpec).toBeNull();
    // The root principal is not a spawned agent binding. Genesis records the
    // stable root seat without manufacturing an agents-table row.
    expect(store.findBindingsByNode(rootNodeId)).toEqual([]);
    expect(store.getRootBinding(runId)?.nodeId).toBe(rootNodeId);
  });

  test("the created run is the one approve-g1 can then approve", () => {
    control.apply(createIntent(), "engineer");

    const approved = control.apply(intent(g1Body()), "engineer");

    expect(approved.outcome).toEqual({ status: "accepted" });
    expect(store.getRun(runId)?.g1.state).toBe("approved");
  });

  test("a second create of the same run is refused, not applied twice", () => {
    control.apply(createIntent(), "engineer");
    const before = store.getRun(runId);

    const again = control.apply(
      createIntent(createBody(), "key-second"),
      "engineer",
    );

    expect(again.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.runAlreadyExists,
        message: expect.stringContaining("already exists"),
      },
    });
    expect(store.getRun(runId)).toEqual(before);
  });

  test("replaying one key returns the first decision rather than creating again", () => {
    const first = control.apply(createIntent(), "engineer");
    const replayed = control.apply(createIntent(), "engineer");

    expect(replayed).toEqual(first);
    expect(store.listRuns()).toHaveLength(1);
  });

  test("a package stitched from another run is refused at the wire", () => {
    const foreign = {
      ...validSpec(),
      runId: "run_018f4f5e-0000-7000-8000-0000000000ff",
    };

    const parsed = RunControlIntentSchema.safeParse({
      schemaVersion: 1,
      intentId: "intent-run-create",
      expected: { kind: "revision-and-epoch", revision: "0", epoch: "0" },
      idempotencyKey: "key-foreign",
      body: { ...createBody(), spec: foreign },
    });

    expect(parsed.success).toBe(false);
    expect(store.getRun(runId)).toBeNull();
  });

  test("a create fencing on live state instead of absence is refused at the wire", () => {
    const parsed = RunControlIntentSchema.safeParse({
      schemaVersion: 1,
      intentId: "intent-run-create",
      expected: { kind: "revision-and-epoch", revision: "1", epoch: "0" },
      idempotencyKey: "key-live-fence",
      body: createBody(),
    });

    expect(parsed.success).toBe(false);
  });
});

// The root's own delegation. run-create makes a run; this is how work gets
// inside one before the queen begins issuing narrower updates through MCP.
describe("run-delegate", () => {
  const childNodeId = "node_018f4f5e-0000-7000-8000-0000000000c1";
  const childRef = {
    nodeId: childNodeId,
    agentId: "worker-child",
    generation: 1,
  };
  const rootIssuer = {
    nodeId,
    agentId: ORCHESTRATOR_NAME,
    generation: 1,
  };

  function childNode() {
    return {
      nodeId: childNodeId,
      runId,
      parentNodeId: nodeId,
      ownerNodeId: nodeId,
      organizationalRole: "worker" as const,
      assignmentKind: "author" as const,
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active" as const,
      revision: "1",
    };
  }

  function delegatedTask(): TaskDetail {
    return {
      taskId,
      revision: "1",
      parentTaskId: null,
      dependsOn: [],
      delegationSpec: {
        objective: "Do the first unit of work in this run",
        parentAcceptanceIds: ["A1"],
        childOutcome: "The unit is delivered",
        terminationCondition: "Acceptance A1 is met",
        inputs: {
          specRevision: { revision: "1", digest: specDigest },
          planRevision: { revision: "1", digest: planDigest },
          taskRevisions: [{ taskId, revision: "1" }],
          interfaceRevisions: [],
          baseSha,
          prerequisites: [],
          sourceArtifactRefs: [],
        },
        boundaries: {
          allowedPaths: ["src/daemon"],
        },
        authority: {
          grantId,
          permittedOperations: ["read", "write", "promote"],
          environment: "worktree",
          worktree: "/worktrees/child",
          branch: "hive/worker",
          explicitNonAuthority: [],
        },
        allowance: {
          sessions: 1,
          tokens: 1_000,
          costCents: 10,
          wallTimeMs: 60_000,
          retries: 0,
          blockers: [],
          owner: rootIssuer,
        },
      },
      acceptanceIds: ["A1"],
      ownerNodeId: nodeId,
      assigneeNodeId: childNodeId,
      pathLeases: [{ path: "src/daemon", mode: "write" as const }],
      branch: "hive/worker",
      baseSha,
      state: "assigned" as const,
      blockers: [],
      evidence: [],
      artifactRefs: [],
    };
  }

  const delegateBody = (
    overrides: Record<string, unknown> = {},
  ): RunControlBody =>
    ({
      operation: "run-delegate",
      runId,
      node: childNode(),
      task: delegatedTask(),
      grant: {
        ...validGrant(),
        issuer: rootIssuer,
        capabilityEpoch: 0,
        subject: childRef,
        descendantNodeIds: [childNodeId],
        // The anchor must actually confer what the spec claims: admission
        // refuses a spec asking for an operation its grant never granted.
        actions: ["read", "write", "test", "promote"],
      },
      ...overrides,
    }) as RunControlBody;

  const delegateIntent = (body: RunControlBody = delegateBody()) =>
    RunControlIntentSchema.parse({
      schemaVersion: 1,
      intentId: "intent-run-delegate",
      expected: { kind: "revision-and-epoch", revision: "2", epoch: "0" },
      idempotencyKey: "key-run-delegate",
      body,
    });

  // THE TRUST ANCHOR, DIRECTION ONE: without a path scope it refuses. The root
  // grant bounds every grant that attenuates below it, so a scope nobody chose
  // would make the whole chain vacuous while still looking enforced.
  test("refuses a root grant with no path scope", () => {
    seedThroughG1();
    const body = delegateBody();
    const stripped = {
      ...body,
      grant: { ...(body as { grant: DelegationGrant }).grant, paths: [] },
    } as RunControlBody;

    const result = control.apply(delegateIntent(stripped), "engineer");

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.delegationInvalid,
        message: expect.stringContaining("non-empty grant path scope"),
      },
    });
    expect(store.getGrant(grantId)).toBeNull();
    expect(store.getNode(childNodeId)).toBeNull();
  });

  // DIRECTION TWO: supplied, it is stored and the chain attenuates from it.
  test("writes node, task and grant, and the chain attenuates from the scope", () => {
    seedThroughG1();

    const result = control.apply(delegateIntent(), "engineer");

    expect(result.outcome).toEqual({ status: "accepted" });
    expect(store.getNode(childNodeId)?.parentNodeId).toBe(nodeId);
    expect(store.getTask(taskId)?.assigneeNodeId).toBe(childNodeId);
    const stored = store.getGrant(grantId);
    expect(stored?.paths).toEqual(["src/daemon"]);
    expect(stored?.issuer).toEqual(rootIssuer);

    // A child grant may narrow the anchor's scope but never widen it.
    expect(() =>
      store.putGrant(
        {
          ...validGrant(),
          grantId: "grant_018f4f5e-0000-7000-8000-0000000000c9",
          parentGrantId: grantId,
          issuer: childRef,
          subject: childRef,
          paths: ["src"],
        },
        {
          expectedHierarchyRevision:
            store.getFences(runId)?.hierarchyRevision ?? "0",
          expectedRunEpoch: 0,
          expectedCapabilityEpoch: 1,
          binding: childRef,
        },
      ),
    ).toThrow();
  });

  // run-create grants nothing, and this is where that is felt: a run whose
  // package no engineer has approved cannot be delegated into.
  test("refuses to delegate into a run whose G1 is not approved", () => {
    seed(store);

    const result = control.apply(
      RunControlIntentSchema.parse({
        schemaVersion: 1,
        intentId: "intent-run-delegate",
        expected: { kind: "revision-and-epoch", revision: "1", epoch: "0" },
        idempotencyKey: "key-ungated",
        body: delegateBody(),
      }),
      "engineer",
    );

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.gateNotApproved,
        message: expect.stringContaining("no approved G1"),
      },
    });
    expect(store.getGrant(grantId)).toBeNull();
  });

  test("a genesis root grant carries its worker identity into spawn admission", () => {
    seedThroughG1();
    const delegated = control.apply(delegateIntent(), "engineer");
    expect(delegated.outcome).toEqual({ status: "accepted" });

    const admission = new SpawnAdmission(
      store,
      // The fixture grant expires an hour after the fixture clock, so admission
      // reads that clock rather than the wall clock this suite happens to run
      // on — otherwise the proof would rot the day after it was written.
      () => new Date(createdAt),
    );

    expect(
      admission.preflight(
        {
          runId,
          runEpoch: 0,
          nodeId: childNodeId,
          taskId,
          delegationSpec: delegatedTask().delegationSpec,
          grantId,
        },
        "author",
      ),
    ).toMatchObject(childRef);
  });

  test("refuses a delegation issued from any node but the run root", () => {
    seedThroughG1();
    const body = delegateBody();
    const forged = {
      ...body,
      grant: {
        ...(body as { grant: DelegationGrant }).grant,
        issuer: { ...childRef },
      },
    } as RunControlBody;

    const result = control.apply(delegateIntent(forged), "engineer");

    expect(result.outcome).toEqual({
      status: "rejected",
      failure: {
        code: RUN_CONTROL_FAILURE_CODES.delegationInvalid,
        message: expect.stringContaining("root node"),
      },
    });
    expect(store.getGrant(grantId)).toBeNull();
  });
});
