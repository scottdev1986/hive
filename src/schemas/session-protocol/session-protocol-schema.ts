import { z } from "zod";
import { INPUT_RECEIPT_STATES } from "./input-arbiter";
import { TERMINAL_LIMITS } from "./limits";
import {
  DecimalUint64Schema,
  domainUuidV7Schema,
  PositiveGenerationSchema,
  Rfc3339UtcMillisecondsSchema,
  SafeUintSchema,
  SessionProtocolProviderSchema,
  Sha256HexSchema,
} from "./primitives";

export const SessionSubjectSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("root") }),
    z.strictObject({ kind: z.literal("agent"), agentId: z.string().min(1) }),
  ])
  .readonly();
export type SessionSubject = z.infer<typeof SessionSubjectSchema>;

export const SessionLocatorSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    instanceId: z.string().min(1),
    subject: SessionSubjectSchema,
    generation: PositiveGenerationSchema,
    sessionId: domainUuidV7Schema("ses"),
    hostKind: z.literal("sessiond"),
    engineBuildId: z.string().min(1),
  })
  .readonly();
export type SessionLocator = z.infer<typeof SessionLocatorSchema>;

export const ProcessRootSchema = z.strictObject({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  processGroupId: z.number().int().positive(),
});

export const TerminalGeometrySchema = z
  .strictObject({
    columns: z
      .number()
      .int()
      .min(TERMINAL_LIMITS.terminalCellsPerDimensionMin)
      .max(TERMINAL_LIMITS.terminalCellsPerDimensionMax),
    rows: z
      .number()
      .int()
      .min(TERMINAL_LIMITS.terminalCellsPerDimensionMin)
      .max(TERMINAL_LIMITS.terminalCellsPerDimensionMax),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    cellWidthPx: z.number().positive(),
    cellHeightPx: z.number().positive(),
  })
  .refine(
    ({ columns, rows }) =>
      columns * rows <= TERMINAL_LIMITS.terminalActiveCellsMax,
    "active terminal cells exceed the v1 limit",
  )
  .meta({ "x-hive-max-active-cells": TERMINAL_LIMITS.terminalActiveCellsMax })
  .readonly();
export type TerminalGeometry = z.infer<typeof TerminalGeometrySchema>;

export const SessionSpecSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    locator: SessionLocatorSchema,
    /** Null only for a headless orchestrator root's session: a plain shell with no vendor CLI launched inside it. Every vendor launch supplies one — enforced by its own input schema requiring a non-null provider, not by a refinement here. */
    provider: SessionProtocolProviderSchema.nullable(),
    toolSessionId: z.string().min(1).nullable(),
    cwd: z.string().startsWith("/"),
    argv: z.tuple([z.string().min(1)], z.string()).readonly(),
    environment: z.record(z.string(), z.string()).readonly(),
    expectedExecutable: z.string().min(1),
    readOnly: z.boolean(),
    capabilityEpoch: SafeUintSchema,
    geometry: TerminalGeometrySchema,
    launchGrantId: z.string().min(1),
    launchGrantRevision: SafeUintSchema,
  })
  .readonly();
export type SessionSpec = z.infer<typeof SessionSpecSchema>;

export const SessionExitSchema = z
  .strictObject({
    code: z.number().int().nullable(),
    signal: z.number().int().nullable(),
    observedAt: Rfc3339UtcMillisecondsSchema,
  })
  .nullable();
export const SessionSurvivorsSchema = z
  .array(
    z.strictObject({
      pid: z.number().int().positive(),
      startToken: z.string().min(1),
      reason: z.string().min(1),
    }),
  )
  .readonly();
export const SessionVisibilitySchema = z.strictObject({
  state: z.enum(["attaching", "visible", "reconnecting", "expired"]),
  workspaceSessionId: z.string().min(1),
  openTerminalRevision: DecimalUint64Schema,
  expiresAt: Rfc3339UtcMillisecondsSchema,
});

const ForegroundIdentityFields = {
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  foregroundProcessGroupId: z.number().int().positive(),
} as const;

const SessionForegroundSchema = z.discriminatedUnion("state", [
  z
    .strictObject({ state: z.literal("shell-idle"), runId: z.null() })
    .readonly(),
  z
    .strictObject({
      state: z.literal("managed"),
      runId: z.string().uuid(),
      ...ForegroundIdentityFields,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("unmanaged"),
      runId: z.null(),
      ...ForegroundIdentityFields,
    })
    .readonly(),
  z.strictObject({ state: z.literal("unknown"), runId: z.null() }).readonly(),
]);

export const SessionInspectionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    locator: SessionLocatorSchema,
    presence: z.enum(["present", "exited", "lost", "unknown"]),
    complete: z.boolean(),
    hostPid: z.number().int().positive().nullable(),
    hostStartToken: z.string().min(1).nullable(),
    shellRoot: ProcessRootSchema.nullable(),
    foreground: SessionForegroundSchema,
    expectedExecutable: z.string().min(1),
    executableVerified: z.boolean(),
    outputSeq: DecimalUint64Schema,
    checkpointSeq: DecimalUint64Schema,
    checkpointAvailable: z.boolean(),
    viewerCount: z
      .number()
      .int()
      .min(0)
      .max(TERMINAL_LIMITS.authenticatedViewersPerGeneration),
    geometry: TerminalGeometrySchema,
    resources: z.record(z.string(), z.number()).readonly(),
    visibility: SessionVisibilitySchema,
    exit: SessionExitSchema,
    survivors: SessionSurvivorsSchema,
    evidenceAt: Rfc3339UtcMillisecondsSchema,
    diagnosticIds: z.array(z.string().min(1)).readonly(),
  })
  .readonly();
export type SessionInspection = z.infer<typeof SessionInspectionSchema>;

export const CreateResultSchema = z
  .strictObject({
    locator: SessionLocatorSchema,
    inspection: SessionInspectionSchema,
    created: z.literal(true),
  })
  .readonly();
export type CreateResult = z.infer<typeof CreateResultSchema>;
export const CaptureRequestSchema = z
  .strictObject({
    include: z.enum(["metadata", "visible-text"]),
    maxRows: z.number().int().min(1).max(200),
    expectedOutputSeq: DecimalUint64Schema.optional(),
  })
  .readonly();
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;
export const CaptureResultSchema = z
  .strictObject({
    locator: SessionLocatorSchema,
    outputSeq: DecimalUint64Schema,
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    rowStart: z.number().int().nonnegative(),
    screen: z.enum(["primary", "alternate"]),
    cursor: z.strictObject({
      row: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
      visible: z.boolean(),
    }),
    text: z.string().nullable(),
    styledText: z.string().nullable(),
    truncated: z.boolean(),
    sha256: Sha256HexSchema,
    composer: z
      .strictObject({
        profile: SessionProtocolProviderSchema,
        present: z.boolean(),
        nonempty: z.boolean(),
        stable: z.boolean(),
        userEditSinceEmpty: z.boolean(),
        userOperationInFlight: z.boolean(),
        claim: z.boolean(),
        invariant: z.enum(["ok", "fault"]),
      })
      .readonly()
      .nullable(),
  })
  .readonly();
export type CaptureResult = z.infer<typeof CaptureResultSchema>;
export const AttachRequestSchema = z
  .strictObject({
    viewerId: z.string().min(1),
    geometry: TerminalGeometrySchema,
    operations: z.array(z.enum(["view", "user-input", "resize"])).readonly(),
  })
  .readonly();
export type AttachRequest = z.infer<typeof AttachRequestSchema>;
export const AttachGrantSchema = z
  .strictObject({
    locator: SessionLocatorSchema,
    endpoint: z.string().min(1),
    token: z.string().min(1),
    expiresAt: Rfc3339UtcMillisecondsSchema,
    engineBuildId: z.string().min(1),
    checkpointSeq: DecimalUint64Schema,
    outputSeq: DecimalUint64Schema,
    operations: z.array(z.enum(["view", "user-input", "resize"])).readonly(),
  })
  .readonly();
export type AttachGrant = z.infer<typeof AttachGrantSchema>;
export const VisibilityRequestSchema = z
  .strictObject({
    workspaceSessionId: z.string().min(1),
    workspacePid: z.number().int().positive(),
    workspaceStartToken: z.string().min(1),
    openTerminalRevision: DecimalUint64Schema,
  })
  .readonly();
export type VisibilityRequest = z.infer<typeof VisibilityRequestSchema>;
export const VisibilityLeaseSchema = z
  .strictObject({
    locator: SessionLocatorSchema,
    state: z.literal("active"),
    expiresAt: Rfc3339UtcMillisecondsSchema,
    openTerminalRevision: DecimalUint64Schema,
  })
  .readonly();
export type VisibilityLease = z.infer<typeof VisibilityLeaseSchema>;
export const ResizeResultSchema = z
  .strictObject({
    locator: SessionLocatorSchema,
    geometry: TerminalGeometrySchema,
    revision: DecimalUint64Schema,
  })
  .readonly();
export type ResizeResult = z.infer<typeof ResizeResultSchema>;

export const InputReceiptSchema = z
  .strictObject({
    state: z.enum(INPUT_RECEIPT_STATES),
    byteRange: z
      .strictObject({
        start: DecimalUint64Schema,
        endExclusive: DecimalUint64Schema,
      })
      .nullable(),
    evidenceAt: Rfc3339UtcMillisecondsSchema,
    diagnosticId: z.string().min(1).nullable(),
  })
  .readonly();
export const TerminationRequestSchema = z
  .strictObject({
    mode: z.enum(["graceful", "immediate"]),
    reason: z.string().min(1),
    /** Domain idempotency key (`req_…`), distinct from the uint64 frame-header correlation requestId. */
    requestId: domainUuidV7Schema("req"),
  })
  .readonly();
export type TerminationRequest = z.infer<typeof TerminationRequestSchema>;
export const TerminationResultSchema = z
  .strictObject({
    locator: SessionLocatorSchema,
    state: z.enum(["terminated", "survivors", "unknown"]),
    exit: SessionExitSchema,
    survivors: SessionSurvivorsSchema,
    errors: z
      .array(
        z.strictObject({
          phase: z.string().min(1),
          code: z.string().min(1),
          diagnosticId: z.string().min(1),
        }),
      )
      .readonly(),
  })
  .readonly();
export type TerminationResult = z.infer<typeof TerminationResultSchema>;

export const SessionEventSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    eventId: domainUuidV7Schema("evt"),
    eventSeq: DecimalUint64Schema,
    locator: SessionLocatorSchema,
    kind: z.string().min(1),
    revision: DecimalUint64Schema,
    occurredAt: Rfc3339UtcMillisecondsSchema,
    data: z.record(z.string(), z.json()).readonly(),
  })
  .readonly();
export type SessionEvent = z.infer<typeof SessionEventSchema>;
