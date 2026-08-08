import { describe, expect, test } from "bun:test";
import {
  DigestSchema,
  GitShaSchema,
  RunIdSchema,
} from "../../src/schemas/hierarchy-ids";
import {
  BUDGET_DIMENSIONS,
  PlanRevisionSchema,
  REVISION_LIFECYCLE,
  RunBudgetSchema,
  RunSchema,
  SpecRevisionSchema,
  TOPOLOGY_SHAPES,
  TopologyDecisionSchema,
} from "../../src/schemas/hierarchy-run";
import { required } from "../required";

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskIdA = "task_018f4f5e-0000-7000-8000-0000000000a1";
const taskIdB = "task_018f4f5e-0000-7000-8000-0000000000a2";
const artId = "art_018f4f5e-0000-7000-8000-000000000003";
const digest = `sha256:${"a".repeat(64)}`;
const gitSha = "b".repeat(40);
const createdAt = "2026-07-30T12:00:00.000Z";

const gatePolicy = {
  reviewLocGreenMax: 100,
  reviewLocAmberMax: 250,
  reviewFilesMax: 10,
};

const validSpecRevision = {
  runId,
  revision: "1",
  digest,
  createdAt,
  lifecycle: "approved" as const,
  objective: "Freeze the §06 run-record schemas",
  acceptanceIds: ["A1"],
  scope: "hierarchy run records only",
  nonGoals: ["no store", "no ops"],
  constraints: {
    architecture: ["daemon owns writes"],
    security: ["no arbitrary filesystem access"],
    outwardEffect: ["schema-only, no runtime behavior"],
  },
  gatePolicy,
  evidenceArtifactRefs: [artId],
  proposer: "queen",
  engineerApproval: { approvedBy: "engineer", approvedAt: createdAt },
};

const validPlanRevision = {
  runId,
  revision: "1",
  digest,
  createdAt,
  lifecycle: "approved" as const,
  parentRevision: null,
  taskDag: [
    { taskId: taskIdA, dependsOn: [] },
    { taskId: taskIdB, dependsOn: [taskIdA] },
  ],
  topologyRationale: "two file-disjoint schema modules",
  proposer: "queen",
};

const validTopologyDecision = {
  runId,
  revision: "1",
  digest,
  createdAt,
  lifecycle: "approved" as const,
  shape: "direct" as const,
  decomposition: {
    planRevision: { revision: "1", digest },
    taskDag: validPlanRevision.taskDag,
  },
  coupling: {
    sharedFiles: [],
    sharedInvariants: ["id/digest/revision conventions"],
    interfaceMaturity: "frozen at H0",
    dependencyDepth: 0,
    expectedIntegrationConflict: "none — file-disjoint",
  },
  parallelValue: {
    independentWorkUnits: 1,
    predictedCriticalPath: "schema authoring",
    expectedWallClockBenefit: "none — single worker",
  },
  coordinationCost: {
    leadLoad: "none",
    reviewLoad: "one review",
    communicationLoad: "none",
    ciLoad: "vitest/bun:test only",
    promotionQueueLoad: "one candidate",
  },
  budgetEvidence: {
    reservedSessions: 1,
    tokensOrCostEstimate: "small",
    wallTimeEstimate: "under an hour",
    reviewerCapacity: "one reviewer",
    perLeadCrewLimit: 0,
  },
  decisionProvenance: {
    proposer: "queen",
    engineerDecision: {
      outcome: "approved" as const,
      decidedBy: "engineer",
      decidedAt: createdAt,
    },
    specRevision: { revision: "1", digest },
    rationale: "direct attach — one worker, no shared files",
  },
};

const budgetLimit = { hard: 10, soft: 8, reserved: 2, used: 1 };
const validRunBudget = {
  runId,
  revision: "1",
  digest,
  createdAt,
  lifecycle: "approved" as const,
  limits: Object.fromEntries(
    BUDGET_DIMENSIONS.map((dimension) => [dimension, budgetLimit]),
  ),
  anomalyThresholds: { retryRateMax: 5 },
};

const validRun = {
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

describe("hierarchy-ids primitives reject malformed values", () => {
  test("RunId requires the run_ prefix and a v7 UUID body", () => {
    expect(RunIdSchema.safeParse(runId).success).toBe(true);
    expect(
      RunIdSchema.safeParse("task_018f4f5e-0000-7000-8000-000000000001")
        .success,
    ).toBe(false);
    expect(RunIdSchema.safeParse("run_not-a-uuid").success).toBe(false);
  });

  test("Digest requires the sha256: prefix and 64 hex characters", () => {
    expect(DigestSchema.safeParse(digest).success).toBe(true);
    expect(DigestSchema.safeParse("a".repeat(64)).success).toBe(false);
    expect(DigestSchema.safeParse(`sha256:${"a".repeat(63)}`).success).toBe(
      false,
    );
    expect(DigestSchema.safeParse(`sha256:${"g".repeat(64)}`).success).toBe(
      false,
    );
  });

  test("GitSha requires exactly 40 lowercase hex characters", () => {
    expect(GitShaSchema.safeParse(gitSha).success).toBe(true);
    expect(GitShaSchema.safeParse(gitSha.slice(0, 39)).success).toBe(false);
    expect(GitShaSchema.safeParse("g".repeat(40)).success).toBe(false);
    expect(GitShaSchema.safeParse(gitSha.toUpperCase()).success).toBe(false);
  });
});

describe("SpecRevisionSchema", () => {
  test("round-trips a valid record", () => {
    const parsed = SpecRevisionSchema.parse(validSpecRevision);
    expect(SpecRevisionSchema.parse(roundTrip(parsed))).toEqual(parsed);
  });

  test("lifecycle is exactly proposed/approved/superseded", () => {
    expect([...REVISION_LIFECYCLE].sort()).toEqual([
      "approved",
      "proposed",
      "superseded",
    ]);
  });

  test("rejects an unknown field (strict object)", () => {
    expect(
      SpecRevisionSchema.safeParse({ ...validSpecRevision, extra: "nope" })
        .success,
    ).toBe(false);
  });
});

describe("PlanRevisionSchema", () => {
  test("round-trips a valid record", () => {
    const parsed = PlanRevisionSchema.parse(validPlanRevision);
    expect(PlanRevisionSchema.parse(roundTrip(parsed))).toEqual(parsed);
  });

  test("accepts a null parent revision for the first plan", () => {
    expect(PlanRevisionSchema.safeParse(validPlanRevision).success).toBe(true);
  });
});

describe("TopologyDecisionSchema", () => {
  test("round-trips a valid record", () => {
    const parsed = TopologyDecisionSchema.parse(validTopologyDecision);
    expect(TopologyDecisionSchema.parse(roundTrip(parsed))).toEqual(parsed);
  });

  test("shape is exactly direct | flat | full-hive", () => {
    expect([...TOPOLOGY_SHAPES].sort()).toEqual([
      "direct",
      "flat",
      "full-hive",
    ]);
  });

  test.each(["flat", "full-hive"] as const)("accepts shape=%s", (shape) => {
    expect(
      TopologyDecisionSchema.safeParse({ ...validTopologyDecision, shape })
        .success,
    ).toBe(true);
  });

  test("rejects a shape outside the enum", () => {
    expect(
      TopologyDecisionSchema.safeParse({
        ...validTopologyDecision,
        shape: "hierarchical",
      }).success,
    ).toBe(false);
  });
});

describe("RunBudgetSchema", () => {
  test("round-trips a valid record", () => {
    const parsed = RunBudgetSchema.parse(validRunBudget);
    expect(RunBudgetSchema.parse(roundTrip(parsed))).toEqual(parsed);
  });

  test("every dimension carries both a hard and a soft limit", () => {
    const parsed = RunBudgetSchema.parse(validRunBudget);
    for (const dimension of BUDGET_DIMENSIONS) {
      const limit = required(parsed.limits[dimension]);
      expect(typeof limit.hard).toBe("number");
      expect(typeof limit.soft).toBe("number");
    }
  });

  test("rejects a missing dimension", () => {
    const { activeSessions: _dropped, ...incomplete } = validRunBudget.limits;
    expect(
      RunBudgetSchema.safeParse({ ...validRunBudget, limits: incomplete })
        .success,
    ).toBe(false);
  });

  test("rejects a soft limit above the hard limit", () => {
    const broken = {
      ...validRunBudget,
      limits: {
        ...validRunBudget.limits,
        tokens: { hard: 10, soft: 20, reserved: 2, used: 1 },
      },
    };
    expect(RunBudgetSchema.safeParse(broken).success).toBe(false);
  });

  test("rejects a reservation above the hard limit", () => {
    const broken = {
      ...validRunBudget,
      limits: {
        ...validRunBudget.limits,
        tokens: { hard: 10, soft: 8, reserved: 12, used: 1 },
      },
    };
    expect(RunBudgetSchema.safeParse(broken).success).toBe(false);
  });

  test("rejects usage above its own reservation", () => {
    const broken = {
      ...validRunBudget,
      limits: {
        ...validRunBudget.limits,
        tokens: { hard: 10, soft: 8, reserved: 2, used: 5 },
      },
    };
    expect(RunBudgetSchema.safeParse(broken).success).toBe(false);
  });
});

describe("RunSchema", () => {
  test("round-trips a valid record", () => {
    const parsed = RunSchema.parse(validRun);
    expect(RunSchema.parse(roundTrip(parsed))).toEqual(parsed);
  });

  test("phase is exactly P0..P6", () => {
    for (const phase of ["P0", "P1", "P2", "P3", "P4", "P5", "P6"] as const) {
      expect(RunSchema.safeParse({ ...validRun, phase }).success).toBe(true);
    }
    expect(RunSchema.safeParse({ ...validRun, phase: "P7" }).success).toBe(
      false,
    );
  });

  test("an approved G1 binds spec/plan/topology/budget as exact revision+digest pairs", () => {
    const parsed = RunSchema.parse(validRun);
    if (parsed.g1.state !== "approved")
      throw new Error("fixture must be approved");
    expect(parsed.g1.spec).toEqual({ revision: "1", digest });
    expect(parsed.g1.plan).toEqual({ revision: "1", digest });
    expect(parsed.g1.topology).toEqual({ revision: "1", digest });
    expect(parsed.g1.budget).toEqual({ revision: "1", digest });
  });

  test("rejects a free-form G1 package instead of exact revision+digest refs", () => {
    const broken = {
      ...validRun,
      g1: {
        state: "approved" as const,
        decider: "engineer",
        decidedAt: createdAt,
        spec: "the spec I approved verbally",
        plan: { revision: "1", digest },
        topology: { revision: "1", digest },
        budget: { revision: "1", digest },
      },
    };
    expect(RunSchema.safeParse(broken).success).toBe(false);
  });

  test("a pending G1 carries no decider or package", () => {
    expect(
      RunSchema.safeParse({ ...validRun, g1: { state: "pending" } }).success,
    ).toBe(true);
    expect(
      RunSchema.safeParse({
        ...validRun,
        g1: { state: "pending", decider: "engineer" },
      }).success,
    ).toBe(false);
  });

  test("G2 approval binds the exact run-stage SHA, digest, evidence, and target base", () => {
    const approvedG2 = {
      ...validRun,
      g2: {
        state: "approved" as const,
        decider: "engineer",
        decidedAt: createdAt,
        runStageSha: gitSha,
        digest,
        evidenceArtifactRefs: [artId],
        targetMainBase: gitSha,
      },
    };
    expect(RunSchema.safeParse(approvedG2).success).toBe(true);
  });

  test("rejects a free-form, non-SHA targetMainBase on an approved G2", () => {
    const broken = {
      ...validRun,
      g2: {
        state: "approved" as const,
        decider: "engineer",
        decidedAt: createdAt,
        runStageSha: gitSha,
        digest,
        evidenceArtifactRefs: [artId],
        targetMainBase: "main",
      },
    };
    expect(RunSchema.safeParse(broken).success).toBe(false);
  });
});
