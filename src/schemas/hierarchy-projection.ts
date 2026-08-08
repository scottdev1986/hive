// hierarchy-projection.ts Snapshot entity shapes the Live Run hierarchy rail reads. Hierarchy records are durable truth; these projections are the read surface U4 renders. Every field that a screen might display carries an explicit availability state so "we never built this source" cannot look like "the value is empty". Entity kinds ride inside WorkspaceSnapshotV2's generic entities[] as new kind strings. The snapshot envelope stays untouched — kinds are free-form strings, and FlatAssignment remains the legacy C0 record that the Queen's Hive extends later rather than a hierarchy authority. SessionLocator is deliberately not part of any hierarchy-node projection. A node entity may carry an AgentBindingRef; the locator lives on the binding record and is joined elsewhere.

import { z } from "zod";
import {
  ArtifactRefIdSchema,
  DigestSchema,
  GitShaSchema,
  RevisionRefSchema,
  RevisionSchema,
  RunIdSchema,
  SafeUintSchema,
  TaskIdSchema,
} from "./hierarchy-ids";
import {
  AgentBindingRefSchema,
  AssignmentKindSchema,
  HierarchyNodeLifecycleSchema,
  NodeIdSchema,
  OrganizationalRoleSchema,
} from "./hierarchy-node";
import {
  BudgetDimensionSchema,
  BudgetLimitSchema,
  G1StateSchema,
  G2StateSchema,
  RunLifecycleSchema,
  RunPhaseSchema,
  TopologyShapeSchema,
} from "./hierarchy-run";
import {
  ReviewIdSchema,
  ReviewInvalidationSchema,
  ReviewVerdictSchema,
} from "./integration-stage";
import { OwnerLossReasonSchema, TransferIdSchema } from "./ownership-transfer";
import {
  DecimalUint64Schema,
  PositiveGenerationSchema,
} from "./session-protocol";
import { TaskStateSchema } from "./task-detail";

export const HIERARCHY_PROJECTION_SCHEMA_VERSION = 2;

export const HIERARCHY_ENTITY_KINDS = {
  run: "hierarchy-run",
  node: "hierarchy-node",
  budget: "hierarchy-budget",
  review: "hierarchy-review",
  incident: "hierarchy-incident",
  strandedManifest: "hierarchy-stranded-manifest",
  task: "hierarchy-task",
} as const;

export const ABSENCE_REASONS = ["unmeasured", "source-absent"] as const;
export const AbsenceReasonSchema = z.enum(ABSENCE_REASONS);
export type AbsenceReason = z.infer<typeof AbsenceReasonSchema>;

export function availableFieldSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion("availability", [
    z.strictObject({
      availability: z.literal("present"),
      value: valueSchema,
    }),
    z.strictObject({
      availability: z.literal("absent"),
      reason: AbsenceReasonSchema,
      detail: z.string().min(1),
    }),
  ]);
}

export type AvailableField<T> =
  | { availability: "present"; value: T }
  | { availability: "absent"; reason: AbsenceReason; detail: string };

export function presentField<T>(value: T): AvailableField<T> {
  return { availability: "present", value };
}

export function absentField<T = never>(
  reason: AbsenceReason,
  detail: string,
): AvailableField<T> {
  return { availability: "absent", reason, detail };
}

/** Reserved queen root identity. Projected above run nodes; never a fake agent. */
export const HierarchyRootIdentitySchema = z.strictObject({
  kind: z.literal("queen-root"),
  runId: RunIdSchema,
  instanceId: z.string().min(1),
  repo: z.string().min(1),
});
export type HierarchyRootIdentity = z.infer<typeof HierarchyRootIdentitySchema>;

export const HierarchyRunProjectionSchema = z.strictObject({
  schemaVersion: z.literal(HIERARCHY_PROJECTION_SCHEMA_VERSION),
  runId: RunIdSchema,
  entityRevision: RevisionSchema,
  root: availableFieldSchema(HierarchyRootIdentitySchema),
  phase: availableFieldSchema(RunPhaseSchema),
  lifecycle: availableFieldSchema(RunLifecycleSchema),
  topologyShape: availableFieldSchema(TopologyShapeSchema),
  /** G1 state with exact RevisionRefs when approved — never free-form prose. */
  g1: availableFieldSchema(G1StateSchema),
  g2: availableFieldSchema(G2StateSchema),
  /** How this topology was produced: a TopologyDecision on a hierarchy Run is the only producer there is. The vocabulary lists exactly that one, because a value nothing emits is a claim the daemon cannot back — a second source arrives with a schemaVersion bump, not with a name reserved in advance. */
  topologySource: availableFieldSchema(z.enum(["hierarchy"])),
});
export type HierarchyRunProjection = z.infer<
  typeof HierarchyRunProjectionSchema
>;

export const HierarchyNodeProjectionSchema = z.strictObject({
  schemaVersion: z.literal(HIERARCHY_PROJECTION_SCHEMA_VERSION),
  nodeId: NodeIdSchema,
  runId: RunIdSchema,
  entityRevision: RevisionSchema,
  parentNodeId: availableFieldSchema(NodeIdSchema.nullable()),
  ownerNodeId: availableFieldSchema(NodeIdSchema.nullable()),
  organizationalRole: availableFieldSchema(OrganizationalRoleSchema),
  /** Current duty. Reviewer is an assignment kind here, never a hierarchy tier. */
  assignmentKind: availableFieldSchema(AssignmentKindSchema),
  taskScope: availableFieldSchema(z.array(TaskIdSchema)),
  lifecycle: availableFieldSchema(HierarchyNodeLifecycleSchema),
  /** Agent binding reference only. SessionLocator stays on the binding record and must not appear on this entity. */
  binding: availableFieldSchema(AgentBindingRefSchema),
});
export type HierarchyNodeProjection = z.infer<
  typeof HierarchyNodeProjectionSchema
>;

export const HierarchyBudgetProjectionSchema = z.strictObject({
  schemaVersion: z.literal(HIERARCHY_PROJECTION_SCHEMA_VERSION),
  runId: RunIdSchema,
  entityRevision: RevisionSchema,
  limits: availableFieldSchema(
    z.record(BudgetDimensionSchema, BudgetLimitSchema),
  ),
});
export type HierarchyBudgetProjection = z.infer<
  typeof HierarchyBudgetProjectionSchema
>;

/** One board row: identity, state, ownership, relationships, progress, and closure — every field a stored fact. The delegation spec stays on the stored record: it is authority, not display, and a row has no consumer for it. Revision is a compare-and-swap response field, never a selector. */
export const HierarchyTaskSummarySchema = z.strictObject({
  taskId: TaskIdSchema,
  revision: RevisionSchema,
  state: TaskStateSchema,
  ownerNodeId: NodeIdSchema,
  assigneeNodeId: NodeIdSchema.nullable(),
  parentTaskId: TaskIdSchema.nullable(),
  dependsOn: z.array(TaskIdSchema),
  branch: z.string().min(1),
  blockers: z.array(z.string().min(1)),
  evidence: z.array(ArtifactRefIdSchema),
});
export type HierarchyTaskSummary = z.infer<typeof HierarchyTaskSummarySchema>;

export const HierarchyTaskProjectionSchema = z.strictObject({
  schemaVersion: z.literal(HIERARCHY_PROJECTION_SCHEMA_VERSION),
  runId: RunIdSchema,
  entityRevision: RevisionSchema,
  tasks: availableFieldSchema(z.array(HierarchyTaskSummarySchema)),
});
export type HierarchyTaskProjection = z.infer<
  typeof HierarchyTaskProjectionSchema
>;

export const HierarchyReviewSummarySchema = z.strictObject({
  reviewId: ReviewIdSchema,
  revision: RevisionSchema,
  verdict: ReviewVerdictSchema,
  invalidation: ReviewInvalidationSchema,
  reviewer: AgentBindingRefSchema,
  candidate: z.strictObject({
    commitSha: GitShaSchema,
    patchDigest: DigestSchema,
    baseSha: GitShaSchema,
  }),
  taskId: TaskIdSchema,
});
export type HierarchyReviewSummary = z.infer<
  typeof HierarchyReviewSummarySchema
>;

export const HierarchyReviewProjectionSchema = z.strictObject({
  schemaVersion: z.literal(HIERARCHY_PROJECTION_SCHEMA_VERSION),
  runId: RunIdSchema,
  entityRevision: RevisionSchema,
  reviews: availableFieldSchema(z.array(HierarchyReviewSummarySchema)),
});
export type HierarchyReviewProjection = z.infer<
  typeof HierarchyReviewProjectionSchema
>;

export const HIERARCHY_INCIDENT_KINDS = [
  "run-decision",
  "recovery",
  "breaker",
  "contract-conflict",
] as const;
export const HierarchyIncidentKindSchema = z.enum(HIERARCHY_INCIDENT_KINDS);

export const AbsentOnlyFieldSchema = z.strictObject({
  availability: z.literal("absent"),
  reason: z.literal("source-absent"),
  detail: z.string().min(1),
});

export const RunDecisionIncidentSchema = z.strictObject({
  idempotencyKey: z.string().min(1),
  intentDigest: DigestSchema,
  outcome: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("accepted") }),
    z.strictObject({
      status: z.literal("rejected"),
      failureCode: z.string().min(1),
    }),
  ]),
  observedRevision: RevisionSchema,
});
export type RunDecisionIncident = z.infer<typeof RunDecisionIncidentSchema>;

export const RecoveryIncidentSchema = z.strictObject({
  transferId: TransferIdSchema,
  reason: OwnerLossReasonSchema,
  lostOwnerNodeId: NodeIdSchema,
  successorNodeId: NodeIdSchema,
  hierarchyRevision: RevisionSchema,
});
export type RecoveryIncident = z.infer<typeof RecoveryIncidentSchema>;

export const HierarchyIncidentProjectionSchema = z.strictObject({
  schemaVersion: z.literal(HIERARCHY_PROJECTION_SCHEMA_VERSION),
  runId: RunIdSchema,
  entityRevision: RevisionSchema,
  runDecision: availableFieldSchema(z.array(RunDecisionIncidentSchema)),
  recovery: availableFieldSchema(z.array(RecoveryIncidentSchema)),
  breaker: AbsentOnlyFieldSchema,
});
export type HierarchyIncidentProjection = z.infer<
  typeof HierarchyIncidentProjectionSchema
>;

export const StrandedManifestAttentionSchema = z.strictObject({
  nodeId: NodeIdSchema.nullable(),
  agentId: z.string().min(1).nullable(),
  branch: z.string().min(1),
  workManifestRevision: RevisionRefSchema.nullable(),
  unmergedCommits: SafeUintSchema,
  dirtyFileCount: SafeUintSchema,
  disposition: z.enum(["preserve", "discard-required", "unknown"]),
});
export type StrandedManifestAttention = z.infer<
  typeof StrandedManifestAttentionSchema
>;

export const HierarchyStrandedManifestProjectionSchema = z.strictObject({
  schemaVersion: z.literal(HIERARCHY_PROJECTION_SCHEMA_VERSION),
  runId: RunIdSchema.nullable(),
  entityRevision: RevisionSchema,
  items: availableFieldSchema(z.array(StrandedManifestAttentionSchema)),
});
export type HierarchyStrandedManifestProjection = z.infer<
  typeof HierarchyStrandedManifestProjectionSchema
>;

export const HierarchySnapshotEntitySchema = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
  generation: PositiveGenerationSchema.optional(),
  entityRevision: DecimalUint64Schema,
  projection: z.record(z.string(), z.unknown()),
});
export type HierarchySnapshotEntity = z.infer<
  typeof HierarchySnapshotEntitySchema
>;
