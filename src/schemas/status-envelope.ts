import { z } from "zod";
import { MAIL_STATUS_STATES } from "./mail-wake";
import {
  DecimalUint64Schema,
  domainUuidV7Schema,
  PositiveGenerationSchema,
  Rfc3339UtcMillisecondsSchema,
  Sha256HexSchema,
} from "./primitives";

export const WORKSPACE_EVENT_SOURCE_KINDS = [
  "sessiond",
  "provider-hook",
  // Structured lifecycle from a vendor's own protocol. `provider-app-server` stays readable because Codex events already carry it, but it names one vendor's transport and new adapters must not borrow it.
  "provider-protocol",
  "provider-app-server",
  "provider-telemetry",
  "agent-report",
  "task",
  "user",
  // What an agent's own pane saw it do — tool calls, mail it read or sent, questions it asked. A history feed for the inspector, never a status observation: fusion ranks it last and the store keeps it out of the activity slot.
  "agent-pane",
] as const;
export const WORKSPACE_EVENT_CONFIDENCE = [
  "authoritative",
  "high",
  "low",
] as const;
export const STATUS_PHASES = [
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "blocked",
  "complete",
] as const;

export const RUNTIME_STATES = [
  "starting",
  "connecting",
  "ready",
  "degraded",
  "disconnected",
  "exited",
] as const;
export const TURN_STATES = [
  "unknown",
  "ready",
  "working",
  "idle",
  "queued",
  "submitting",
  "awaiting_approval",
  "awaiting_answer",
  "cancelling",
  "paused",
  "stuck",
  "done",
  "failed",
] as const;
export const INPUT_STATES = [
  "empty",
  "editing",
  "composing",
  "queued",
  "delivery_unknown",
] as const;
export const MAIL_STATES = MAIL_STATUS_STATES;
export const HEALTH_STATES = [
  "healthy",
  "delayed",
  "stale",
  "disconnected",
  "unknown",
] as const;
export const ATTENTION_STATES = [
  "none",
  "info",
  "action",
  "approval",
  "failure",
] as const;
export const STATUS_FRESHNESS_STATES = ["fresh", "stale", "unknown"] as const;

/** The root's status words. Provider-native turn states are preserved exactly;
 * lifecycle words cover launch, connection, and exit before or after a turn. */
export const ORCHESTRATOR_STATUSES = [
  "spawning",
  "connecting",
  "ready",
  "queued",
  "submitting",
  "working",
  "idle",
  "awaiting_approval",
  "awaiting_answer",
  "cancelling",
  "done",
  "failed",
  "disconnected",
  "exited",
] as const;
export const OrchestratorStatusSchema = z.enum(ORCHESTRATOR_STATUSES);
export type OrchestratorStatus = z.infer<typeof OrchestratorStatusSchema>;

const WorkspaceStatusSourceSchema = z.strictObject({
  kind: z.enum(WORKSPACE_EVENT_SOURCE_KINDS),
  id: z.string().min(1),
});

const WorkspaceStatusFieldSchema = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    value,
    source: WorkspaceStatusSourceSchema,
    observedAt: Rfc3339UtcMillisecondsSchema,
    freshness: z.enum(STATUS_FRESHNESS_STATES),
    confidence: z.enum(WORKSPACE_EVENT_CONFIDENCE),
  });

export const WorkspaceStatusAbsenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("vendor-does-not-report"),
    citation: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("disconnected"),
    since: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({
    kind: z.literal("stale-since"),
    observedAt: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({ kind: z.literal("unmeasured") }),
]);

const WorkspaceStatusDimensionSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("observed"),
      field: WorkspaceStatusFieldSchema(value),
    }),
    z.strictObject({
      kind: z.literal("absent"),
      reason: WorkspaceStatusAbsenceSchema,
    }),
  ]);

export const WorkspaceStatusDimensionsV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: DecimalUint64Schema,
  runtime: WorkspaceStatusDimensionSchema(z.enum(RUNTIME_STATES)),
  turn: WorkspaceStatusDimensionSchema(z.enum(TURN_STATES)),
  input: WorkspaceStatusDimensionSchema(z.enum(INPUT_STATES)),
  mail: WorkspaceStatusDimensionSchema(z.enum(MAIL_STATES)),
  health: WorkspaceStatusDimensionSchema(z.enum(HEALTH_STATES)),
  attention: WorkspaceStatusDimensionSchema(z.enum(ATTENTION_STATES)),
});
export type WorkspaceStatusDimensionsV1 = z.infer<
  typeof WorkspaceStatusDimensionsV1Schema
>;

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
  data: z.record(z.string(), z.json()),
});
export type WorkspaceEventV2 = z.infer<typeof WorkspaceEventV2Schema>;

// The snapshot is a schema, hash, and high-water projection checkpoint, never a second event log.
export const WorkspaceSnapshotV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  instanceId: z.string().min(1),
  seq: DecimalUint64Schema,
  entities: z.array(
    z.strictObject({
      kind: z.string().min(1),
      id: z.string().min(1),
      generation: PositiveGenerationSchema.optional(),
      entityRevision: DecimalUint64Schema,
      projection: z.record(z.string(), z.json()),
    }),
  ),
  createdAt: Rfc3339UtcMillisecondsSchema,
  contentSha256: Sha256HexSchema,
});
export type WorkspaceSnapshotV2 = z.infer<typeof WorkspaceSnapshotV2Schema>;

const PositiveDecimalUint64Schema = z
  .string()
  .regex(/^(?:[1-9][0-9]{0,19})$/)
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "must fit in an unsigned 64-bit integer",
  )
  .meta({ description: "unsigned 64-bit integer encoded as a decimal string" });

// The minimal flat C0 record. The Queen's Hive extends this later; status must not infer task, review, gate, or hierarchy state from it.
const FlatAssignmentCommonFields = {
  assignmentId: domainUuidV7Schema("asg"),
  agentId: z.string().min(1),
  assignmentGeneration: PositiveDecimalUint64Schema,
  openedAt: Rfc3339UtcMillisecondsSchema,
} as const;

export const FlatAssignmentSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...FlatAssignmentCommonFields,
    state: z.literal("open"),
    closedAt: z.null(),
  }),
  z.strictObject({
    ...FlatAssignmentCommonFields,
    state: z.literal("closed"),
    closedAt: Rfc3339UtcMillisecondsSchema,
  }),
]);
export type FlatAssignment = z.infer<typeof FlatAssignmentSchema>;

const StatusUpdateCommonFields = {
  requestId: domainUuidV7Schema("req"),
  assignmentId: domainUuidV7Schema("asg"),
  assignmentGeneration: PositiveDecimalUint64Schema,
  progress: z.number().int().min(0).max(100).optional(),
  summary: z.string().min(1).max(STATUS_LIMITS.summaryCharactersMax),
  evidenceRefs: z
    .array(z.string().min(1).max(STATUS_LIMITS.evidenceRefCharactersMax))
    .max(STATUS_LIMITS.evidenceRefsMax),
  nextCheckpoint: z
    .string()
    .min(1)
    .max(STATUS_LIMITS.nextCheckpointCharactersMax)
    .optional(),
  freshForSeconds: z
    .number()
    .int()
    .min(STATUS_LIMITS.reportFreshForSecondsMin)
    .max(STATUS_LIMITS.reportFreshForSecondsMax)
    .default(STATUS_LIMITS.reportFreshForSecondsDefault),
} as const;

const nonBlockedStatusSchema = (
  phase: Exclude<(typeof STATUS_PHASES)[number], "blocked">,
) =>
  z.strictObject({
    ...StatusUpdateCommonFields,
    phase: z.literal(phase),
    blocker: z.null().optional(),
  });

export const HiveUpdateStatusInputSchema = z.discriminatedUnion("phase", [
  nonBlockedStatusSchema("planning"),
  nonBlockedStatusSchema("implementing"),
  nonBlockedStatusSchema("testing"),
  nonBlockedStatusSchema("reviewing"),
  z.strictObject({
    ...StatusUpdateCommonFields,
    phase: z.literal("blocked"),
    blocker: z.string().min(1).max(STATUS_LIMITS.blockerCharactersMax),
  }),
  nonBlockedStatusSchema("complete"),
]);

const ADVERTISED_STATUS_VALIDATION_REQUEST_ID =
  "req_00000000-0000-7000-8000-000000000000";

// MCP requires a top-level object schema. Delegate its cross-field validation
// to the store's discriminated union so the public and internal boundaries
// cannot accept different phase/blocker combinations.
export const HiveUpdateStatusAdvertisedSchema = z
  .strictObject({
    ...StatusUpdateCommonFields,
    requestId: StatusUpdateCommonFields.requestId
      .optional()
      .describe(
        "Omit on the first call. On a retry, reuse only the exact req_ UUIDv7 returned by the daemon.",
      ),
    phase: z
      .enum(STATUS_PHASES)
      .describe(
        "Use blocked only with a non-empty blocker; every other phase requires blocker to be omitted or null.",
      ),
    blocker: z
      .union([
        z.string().min(1).max(STATUS_LIMITS.blockerCharactersMax),
        z.null(),
      ])
      .optional()
      .describe(
        "A non-empty reason supplied only when phase is blocked; otherwise omit or pass null.",
      ),
  })
  .superRefine((input, context) => {
    const validated = HiveUpdateStatusInputSchema.safeParse({
      ...input,
      requestId: input.requestId ?? ADVERTISED_STATUS_VALIDATION_REQUEST_ID,
    });
    if (validated.success) return;
    for (const issue of validated.error.issues) {
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  });
export type HiveUpdateStatusAdvertisedInput = z.infer<
  typeof HiveUpdateStatusAdvertisedSchema
>;

export const HiveTerminalObserveInputSchema = z.strictObject({
  sessionId: domainUuidV7Schema("ses"),
  generation: PositiveGenerationSchema,
  include: z.enum(["metadata", "visible-text"]),
  maxRows: z
    .number()
    .int()
    .min(STATUS_LIMITS.terminalObservationRowsMin)
    .max(STATUS_LIMITS.terminalObservationRowsMax),
});

/** One thing an agent's pane watched happen, reported without the payload: the inspector shows that a file was edited or a message was read, and the pane keeps the text. */
export const PaneEventSchema = z.strictObject({
  occurredAt: Rfc3339UtcMillisecondsSchema,
  kind: z
    .string()
    .regex(
      /^pane\.[a-z]+(\.[a-z]+)*$/,
      "a pane event kind is pane.<area>.<what>",
    ),
  data: z.record(z.string(), z.json()),
});
export type PaneEvent = z.infer<typeof PaneEventSchema>;

export const PaneEventsReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  events: z.array(PaneEventSchema).min(1).max(200),
});

export const WorkspaceEventsQuerySchema = z.strictObject({
  agent: z.string().min(1),
  afterSeq: DecimalUint64Schema.default("0"),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  /** The newest `limit` events rather than the oldest: what an inspector opening on a long-lived agent wants first. Still returned oldest-first, with no resume cursor. */
  latest: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

/** A page of one agent's typed events, oldest first. `nextSeq` is set only when the page was cut at `limit`, so a reader that sees null has everything. */
export const WorkspaceEventsPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  agentId: z.string().min(1),
  events: z.array(WorkspaceEventV2Schema),
  nextSeq: DecimalUint64Schema.nullable(),
});
export type WorkspaceEventsPage = z.infer<typeof WorkspaceEventsPageSchema>;

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
