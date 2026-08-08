import { z } from "zod";
import {
  ArtifactRefIdSchema,
  CreatedAtSchema,
  DigestSchema,
  GitShaSchema,
  RevisionRefSchema,
  RevisionSchema,
  RunIdSchema,
  SafeUintSchema,
  TaskIdSchema,
} from "./hierarchy-ids";

// Shared by SpecRevision, PlanRevision, and TopologyDecision: each is an append-only proposal on a run, identified by (runId, revision) and bound to a digest so a gate can approve exact content rather than a floating draft.
export const REVISION_LIFECYCLE = [
  "proposed",
  "approved",
  "superseded",
] as const;
export const RevisionLifecycleSchema = z.enum(REVISION_LIFECYCLE);

const RevisionedRecordShape = {
  runId: RunIdSchema,
  revision: RevisionSchema,
  digest: DigestSchema,
  createdAt: CreatedAtSchema,
  lifecycle: RevisionLifecycleSchema,
} as const;

// A task dependency graph: each task names the tasks it depends on. Task itself belongs to another record (owned elsewhere); only the id shape is shared here.
export const TaskDagSchema = z.array(
  z.strictObject({
    taskId: TaskIdSchema,
    dependsOn: z.array(TaskIdSchema),
  }),
);

export const SpecRevisionSchema = z.strictObject({
  ...RevisionedRecordShape,
  objective: z.string().min(1),
  acceptanceIds: z.array(z.string().min(1)).min(1),
  scope: z.string().min(1),
  nonGoals: z.array(z.string().min(1)),
  constraints: z.strictObject({
    architecture: z.array(z.string().min(1)),
    security: z.array(z.string().min(1)),
    outwardEffect: z.array(z.string().min(1)),
  }),
  gatePolicy: z.strictObject({
    reviewLocGreenMax: z.number().int().positive(),
    reviewLocAmberMax: z.number().int().positive(),
    reviewFilesMax: z.number().int().positive(),
  }),
  evidenceArtifactRefs: z.array(ArtifactRefIdSchema),
  proposer: z.string().min(1),
  engineerApproval: z
    .strictObject({
      approvedBy: z.string().min(1),
      approvedAt: CreatedAtSchema,
    })
    .nullable(),
});
export type SpecRevision = z.infer<typeof SpecRevisionSchema>;

export const PlanRevisionSchema = z.strictObject({
  ...RevisionedRecordShape,
  parentRevision: RevisionSchema.nullable(),
  taskDag: TaskDagSchema,
  topologyRationale: z.string().min(1),
  proposer: z.string().min(1),
});
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

export const TOPOLOGY_SHAPES = ["direct", "flat", "full-hive"] as const;
export const TopologyShapeSchema = z.enum(TOPOLOGY_SHAPES);

export const TopologyDecisionSchema = z.strictObject({
  ...RevisionedRecordShape,
  shape: TopologyShapeSchema,
  decomposition: z.strictObject({
    planRevision: RevisionRefSchema,
    taskDag: TaskDagSchema,
  }),
  coupling: z.strictObject({
    sharedFiles: z.array(z.string().min(1)),
    sharedInvariants: z.array(z.string().min(1)),
    interfaceMaturity: z.string().min(1),
    dependencyDepth: z.number().int().nonnegative(),
    expectedIntegrationConflict: z.string().min(1),
  }),
  parallelValue: z.strictObject({
    independentWorkUnits: z.number().int().nonnegative(),
    predictedCriticalPath: z.string().min(1),
    expectedWallClockBenefit: z.string().min(1),
  }),
  coordinationCost: z.strictObject({
    leadLoad: z.string().min(1),
    reviewLoad: z.string().min(1),
    communicationLoad: z.string().min(1),
    ciLoad: z.string().min(1),
    promotionQueueLoad: z.string().min(1),
  }),
  budgetEvidence: z.strictObject({
    reservedSessions: z.number().int().nonnegative(),
    tokensOrCostEstimate: z.string().min(1),
    wallTimeEstimate: z.string().min(1),
    reviewerCapacity: z.string().min(1),
    perLeadCrewLimit: z.number().int().nonnegative(),
  }),
  decisionProvenance: z.strictObject({
    proposer: z.string().min(1),
    engineerDecision: z
      .strictObject({
        outcome: z.enum(["approved", "overridden"]),
        decidedBy: z.string().min(1),
        decidedAt: CreatedAtSchema,
      })
      .nullable(),
    specRevision: RevisionRefSchema,
    rationale: z.string().min(1),
  }),
});
export type TopologyDecision = z.infer<typeof TopologyDecisionSchema>;

// One named budget dimension's hard/soft ceiling plus current reservation and usage. z.record over a fixed enum key requires every dimension present, so a RunBudget can never omit one — the record equivalent of a strict object.
export const BUDGET_DIMENSIONS = [
  "activeSessions",
  "totalSpawns",
  "perLeadCrew",
  "reviewerPool",
  "vendorQuota",
  "tokens",
  "costCents",
  "wallTimeMs",
  "ci",
  "wakeBudget",
  "messageBudget",
] as const;
export const BudgetDimensionSchema = z.enum(BUDGET_DIMENSIONS);

export const BudgetLimitSchema = z
  .strictObject({
    hard: SafeUintSchema,
    soft: SafeUintSchema,
    reserved: SafeUintSchema,
    used: SafeUintSchema,
  })
  .refine((limit) => limit.soft <= limit.hard, {
    message: "soft limit must not exceed hard limit",
  })
  .refine((limit) => limit.reserved <= limit.hard, {
    message: "reservation must not exceed hard limit",
  })
  .refine((limit) => limit.used <= limit.reserved, {
    message: "usage must not exceed its reservation",
  });

export const RunBudgetSchema = z.strictObject({
  ...RevisionedRecordShape,
  limits: z.record(BudgetDimensionSchema, BudgetLimitSchema),
  anomalyThresholds: z.record(z.string().min(1), z.number()),
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;

export const RUN_PHASES = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"] as const;
export const RunPhaseSchema = z.enum(RUN_PHASES);

export const RUN_LIFECYCLE = [
  "active",
  "paused",
  "completed",
  "aborted",
] as const;
export const RunLifecycleSchema = z.enum(RUN_LIFECYCLE);
export type RunLifecycle = z.infer<typeof RunLifecycleSchema>;

// G1 binds the exact SpecRevision with its preliminary PlanRevision, TopologyDecision, and RunBudget as one package — four RevisionRefs, never a free-form description of what was approved.
export const G1StateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z.strictObject({
    state: z.literal("approved"),
    decider: z.string().min(1),
    decidedAt: CreatedAtSchema,
    spec: RevisionRefSchema,
    plan: RevisionRefSchema,
    topology: RevisionRefSchema,
    budget: RevisionRefSchema,
  }),
]);
export type G1State = z.infer<typeof G1StateSchema>;

// G2 approves the exact assembled run-stage SHA, its digest, evidence, and target-main base — never a floating branch.
export const G2StateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z.strictObject({
    state: z.literal("approved"),
    decider: z.string().min(1),
    decidedAt: CreatedAtSchema,
    runStageSha: GitShaSchema,
    digest: DigestSchema,
    evidenceArtifactRefs: z.array(ArtifactRefIdSchema),
    targetMainBase: GitShaSchema,
  }),
]);
export type G2State = z.infer<typeof G2StateSchema>;

export const RunSchema = z.strictObject({
  runId: RunIdSchema,
  revision: RevisionSchema,
  repo: z.string().min(1),
  instanceId: z.string().min(1),
  approvedSpec: RevisionRefSchema.nullable(),
  currentPlan: RevisionRefSchema,
  topology: RevisionRefSchema,
  phase: RunPhaseSchema,
  g1: G1StateSchema,
  g2: G2StateSchema,
  baseSha: GitShaSchema,
  budget: RevisionRefSchema,
  runEpoch: SafeUintSchema,
  lifecycle: RunLifecycleSchema,
});
export type Run = z.infer<typeof RunSchema>;
