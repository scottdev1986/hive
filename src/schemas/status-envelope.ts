import { z } from "zod";
import {
  DecimalUint64Schema,
  PositiveGenerationSchema,
  Rfc3339UtcMillisecondsSchema,
  Sha256HexSchema,
  domainUuidV7Schema,
} from "./session-protocol";

export const WORKSPACE_EVENT_SOURCE_KINDS = [
  "sessiond",
  "provider-hook",
  "provider-app-server",
  "provider-telemetry",
  "agent-report",
  "task",
  "operator",
] as const;
export const WORKSPACE_EVENT_CONFIDENCE = ["authoritative", "high", "low"] as const;
export const STATUS_PHASES = [
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "blocked",
  "complete",
] as const;

export const STATUS_LIMITS = {
  processHeartbeatMilliseconds: 5_000,
  processDelayedAfterMilliseconds: 10_000,
  processUnknownAfterMilliseconds: 15_000,
  providerFreshnessMilliseconds: 30_000,
  reportFreshForSecondsMin: 30,
  reportFreshForSecondsDefault: 120,
  reportFreshForSecondsMax: 600,
  summaryCharactersMax: 280,
  blockerCharactersMax: 1_000,
  evidenceRefsMax: 16,
  evidenceRefCharactersMax: 512,
  nextCheckpointCharactersMax: 280,
  terminalObservationRowsMin: 1,
  terminalObservationRowsMax: 200,
} as const;

export const STATUS_PERMISSIONS = {
  updateStatus: "status:write",
  terminalObserve: "terminal:observe",
  visibleTextConstraint: "content=true",
  roleGrants: ["reader", "writer"],
} as const;

export const STATUS_REDUCER_CONTRACT = {
  delivery: "at-least-once",
  deduplicateBy: "eventId",
  lowerEntityRevision: "reject",
  identicalDuplicate: "accept",
  conflictingDuplicateId: "corruption",
  sequencePurpose: "stream-continuity",
  sequenceGap: "snapshot-required",
  comparison: "canonical-json-after-every-prefix-and-permutation",
} as const;

export const WORKSPACE_SNAPSHOT_CONTRACT = {
  digestOf: "canonical-json-entities-code-unit-key-order",
  verify: ["schema", "content-sha256", "seq-monotonicity"],
  resumeAt: "seq+1",
} as const;

export const WorkspaceEventV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  eventId: domainUuidV7Schema("evt"),
  seq: DecimalUint64Schema,
  entity: z.strictObject({
    kind: z.string().min(1),
    id: z.string().min(1),
    generation: PositiveGenerationSchema.optional(),
  }),
  entityRevision: DecimalUint64Schema,
  occurredAt: Rfc3339UtcMillisecondsSchema,
  kind: z.string().min(1),
  source: z.strictObject({
    kind: z.enum(WORKSPACE_EVENT_SOURCE_KINDS),
    id: z.string().min(1),
    observedAt: Rfc3339UtcMillisecondsSchema,
    confidence: z.enum(WORKSPACE_EVENT_CONFIDENCE),
  }),
  data: z.record(z.string(), z.unknown()),
});
export type WorkspaceEventV2 = z.infer<typeof WorkspaceEventV2Schema>;

// Shape adjudicated for WP7: §24 required a schema/hash/high-water snapshot
// without fixing the wire fields. The snapshot is a projection checkpoint,
// never a second event log.
export const WorkspaceSnapshotV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  instanceId: z.string().min(1),
  seq: DecimalUint64Schema,
  entities: z.array(z.strictObject({
    kind: z.string().min(1),
    id: z.string().min(1),
    generation: PositiveGenerationSchema.optional(),
    entityRevision: DecimalUint64Schema,
    projection: z.record(z.string(), z.unknown()),
  })),
  createdAt: Rfc3339UtcMillisecondsSchema,
  contentSha256: Sha256HexSchema,
});
export type WorkspaceSnapshotV2 = z.infer<typeof WorkspaceSnapshotV2Schema>;

const PositiveDecimalUint64Schema = z.string()
  .regex(/^(?:[1-9][0-9]{0,19})$/)
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "must fit in an unsigned 64-bit integer",
  ).meta({ format: "hive-uint64-decimal" });

// The minimal flat C0 record. The Queen's Hive extends this later; status must
// not infer task, review, gate, or hierarchy state from it.
const FlatAssignmentCommonShape = {
  assignmentId: domainUuidV7Schema("asg"),
  agentId: z.string().min(1),
  assignmentGeneration: PositiveDecimalUint64Schema,
  openedAt: Rfc3339UtcMillisecondsSchema,
} as const;

export const FlatAssignmentSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...FlatAssignmentCommonShape,
    state: z.literal("open"),
    closedAt: z.null(),
  }),
  z.strictObject({
    ...FlatAssignmentCommonShape,
    state: z.literal("closed"),
    closedAt: Rfc3339UtcMillisecondsSchema,
  }),
]);
export type FlatAssignment = z.infer<typeof FlatAssignmentSchema>;

const StatusUpdateCommonShape = {
  requestId: domainUuidV7Schema("req"),
  assignmentId: domainUuidV7Schema("asg"),
  assignmentGeneration: PositiveDecimalUint64Schema,
  progress: z.number().int().min(0).max(100).optional(),
  summary: z.string().min(1).max(STATUS_LIMITS.summaryCharactersMax),
  evidenceRefs: z.array(
    z.string().min(1).max(STATUS_LIMITS.evidenceRefCharactersMax),
  ).max(STATUS_LIMITS.evidenceRefsMax),
  nextCheckpoint: z.string().min(1).max(STATUS_LIMITS.nextCheckpointCharactersMax).optional(),
  freshForSeconds: z.number().int()
    .min(STATUS_LIMITS.reportFreshForSecondsMin)
    .max(STATUS_LIMITS.reportFreshForSecondsMax)
    .default(STATUS_LIMITS.reportFreshForSecondsDefault),
} as const;

const nonBlockedStatusSchema = (phase: Exclude<(typeof STATUS_PHASES)[number], "blocked">) =>
  z.strictObject({
    ...StatusUpdateCommonShape,
    phase: z.literal(phase),
    blocker: z.null(),
  });

export const HiveUpdateStatusInputSchema = z.discriminatedUnion("phase", [
  nonBlockedStatusSchema("planning"),
  nonBlockedStatusSchema("implementing"),
  nonBlockedStatusSchema("testing"),
  nonBlockedStatusSchema("reviewing"),
  z.strictObject({
    ...StatusUpdateCommonShape,
    phase: z.literal("blocked"),
    blocker: z.string().min(1).max(STATUS_LIMITS.blockerCharactersMax),
  }),
  nonBlockedStatusSchema("complete"),
]);
export type HiveUpdateStatusInput = z.infer<typeof HiveUpdateStatusInputSchema>;

export const HiveTerminalObserveInputSchema = z.strictObject({
  sessionId: domainUuidV7Schema("ses"),
  generation: PositiveGenerationSchema,
  include: z.enum(["metadata", "visible-text"]),
  maxRows: z.number().int()
    .min(STATUS_LIMITS.terminalObservationRowsMin)
    .max(STATUS_LIMITS.terminalObservationRowsMax),
});
export type HiveTerminalObserveInput = z.infer<typeof HiveTerminalObserveInputSchema>;

export const STATUS_WIRE_SCHEMAS = {
  workspaceEventV2: WorkspaceEventV2Schema,
  workspaceSnapshotV2: WorkspaceSnapshotV2Schema,
  flatAssignment: FlatAssignmentSchema,
  hiveUpdateStatusInput: HiveUpdateStatusInputSchema,
  hiveTerminalObserveInput: HiveTerminalObserveInputSchema,
} as const;

export const STATUS_CONTRACT = {
  eventSourceKinds: WORKSPACE_EVENT_SOURCE_KINDS,
  confidence: WORKSPACE_EVENT_CONFIDENCE,
  phases: STATUS_PHASES,
  limits: STATUS_LIMITS,
  permissions: STATUS_PERMISSIONS,
  reducer: STATUS_REDUCER_CONTRACT,
  snapshot: WORKSPACE_SNAPSHOT_CONTRACT,
} as const;
