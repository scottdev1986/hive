import { z } from "zod";
import { TERMINAL_LIMITS } from "./limits";
import {
  DecimalUint64Schema,
  Rfc3339UtcMillisecondsSchema,
  SafeUintSchema,
} from "./primitives";
import {
  ProtocolMinorSchema,
  SelectedProtocolSchema,
  SESSION_PROTOCOL_VERSION,
} from "./session-protocol-version";

export const TerminalHostSessionRefSchema = z
  .strictObject({
    key: z.string().min(1),
    incarnation: z.string().min(1),
  })
  .readonly();
export type SessionRef = z.infer<typeof TerminalHostSessionRefSchema>;
export const TerminalHostWindowSizeSchema = z
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
    widthPixels: z.number().int().nonnegative().max(65_535),
    heightPixels: z.number().int().nonnegative().max(65_535),
  })
  .refine(
    ({ columns, rows }) =>
      columns * rows <= TERMINAL_LIMITS.terminalActiveCellsMax,
    "active terminal cells exceed the v1 limit",
  )
  .meta({ "x-hive-max-active-cells": TERMINAL_LIMITS.terminalActiveCellsMax })
  .readonly();
export type WindowSize = z.infer<typeof TerminalHostWindowSizeSchema>;
const TerminalHostCompletenessSchema = z.enum([
  "complete",
  "partial",
  "unavailable",
  "unknown",
]);
export type Completeness = z.infer<typeof TerminalHostCompletenessSchema>;
export const TerminalHostProcessIdentitySchema = z
  .strictObject({
    processId: z.number().int().positive(),
    startToken: z.string().min(1),
  })
  .readonly();
export type ProcessIdentity = z.infer<typeof TerminalHostProcessIdentitySchema>;
export const TerminalHostTerminalProfileSchema = z
  .strictObject({
    inputMode: z.enum(["canonical", "literal"]),
    echo: z.boolean(),
    signalCharacters: z.boolean(),
    softwareFlowControl: z.boolean(),
    eofByte: z.number().int().min(0).max(255),
    startByte: z.number().int().min(0).max(255),
    stopByte: z.number().int().min(0).max(255),
    hangupOnLastClose: z.boolean(),
  })
  .readonly();
export type TerminalProfile = z.infer<typeof TerminalHostTerminalProfileSchema>;
export const TerminalHostEnvironmentEntrySchema = z
  .strictObject({
    name: z.string().min(1),
    value: z.string(),
  })
  .readonly();
export type EnvironmentEntry = z.infer<
  typeof TerminalHostEnvironmentEntrySchema
>;
export const TerminalHostTransferableHandleSchema = z
  .strictObject({
    token: z.string().min(1),
    sourceDisposition: z.enum(["retain", "close-after-transfer"]),
  })
  .readonly();
export type TransferableHandle = z.infer<
  typeof TerminalHostTransferableHandleSchema
>;
export const TerminalHostDescriptorMappingSchema = z
  .strictObject({
    handle: TerminalHostTransferableHandleSchema,
    targetDescriptor: z.number().int().min(3),
  })
  .readonly();
export type DescriptorMapping = z.infer<
  typeof TerminalHostDescriptorMappingSchema
>;
export const TerminalHostCommandSchema = z
  .strictObject({
    executable: z.string().min(1),
    arguments: z.array(z.string()).readonly(),
    workingDirectory: z.string().min(1),
    completeEnvironment: z.array(TerminalHostEnvironmentEntrySchema).readonly(),
    descriptorMap: z.array(TerminalHostDescriptorMappingSchema).readonly(),
  })
  .readonly();
export type Command = z.infer<typeof TerminalHostCommandSchema>;
export const TerminalHostLimitsSchema = z
  .strictObject({
    maxInputTransactionBytes: SafeUintSchema,
    maxInputQueueBytes: SafeUintSchema,
    maxOutputFrameBytes: SafeUintSchema,
    outputLowWaterBytes: SafeUintSchema,
    outputHighWaterBytes: SafeUintSchema,
    outputRetentionBytes: SafeUintSchema,
  })
  .readonly();
export type HostLimits = z.infer<typeof TerminalHostLimitsSchema>;
export const TerminalHostJobControlEvidenceSchema = z
  .strictObject({
    sessionLeader: z.boolean(),
    controllingTerminal: z.boolean(),
    standardStreamsShareTerminal: z.boolean(),
    childSessionId: z.number().int().positive(),
    childProcessGroupId: z.number().int().positive(),
    foregroundProcessGroupId: z.number().int().positive(),
    terminalIdentity: z.string().min(1),
    initialProfileAppliedBeforeExec: z.boolean(),
    initialWindowAppliedBeforeExec: z.boolean(),
    completeness: TerminalHostCompletenessSchema,
  })
  .readonly();
export type JobControlEvidence = z.infer<
  typeof TerminalHostJobControlEvidenceSchema
>;
export const TerminalHostExitStatusSchema = z
  .strictObject({
    code: z.number().int().nullable(),
    signal: z.number().int().nonnegative().nullable(),
    observedAt: Rfc3339UtcMillisecondsSchema,
  })
  .readonly();
export type ExitStatus = z.infer<typeof TerminalHostExitStatusSchema>;
export const TerminalHostReapEvidenceSchema = z
  .strictObject({
    authority: z.enum([
      "direct-parent",
      "durable-parent-record",
      "unavailable",
    ]),
    reaped: z.boolean(),
    status: TerminalHostExitStatusSchema.nullable(),
    completeness: TerminalHostCompletenessSchema,
  })
  .readonly();
export type ReapEvidence = z.infer<typeof TerminalHostReapEvidenceSchema>;
export const TerminalHostLaunchOutcomeSchema = z.discriminatedUnion("state", [
  z
    .strictObject({
      state: z.literal("running"),
      child: TerminalHostProcessIdentitySchema,
      execProof: z.literal("replacement-observed"),
      jobControl: TerminalHostJobControlEvidenceSchema,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("exec-failed"),
      layer: z.enum([
        "command",
        "working-directory",
        "environment",
        "descriptor-transfer",
        "terminal-setup",
        "exec-transition",
      ]),
      osCode: z.union([z.string(), z.number().int(), z.null()]),
      diagnostic: z.string().min(1),
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("exited"),
      exit: TerminalHostExitStatusSchema,
      reap: TerminalHostReapEvidenceSchema,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("unknown"),
      diagnostic: z.string().min(1),
    })
    .readonly(),
]);
export type LaunchOutcome = z.infer<typeof TerminalHostLaunchOutcomeSchema>;
export type LaunchFailureLayer = Extract<
  LaunchOutcome,
  { state: "exec-failed" }
>["layer"];
export const TerminalHostCreateRequestSchema = z
  .strictObject({
    key: z.string().min(1),
    idempotencyKey: z.string().min(1),
    command: TerminalHostCommandSchema,
    terminalProfile: TerminalHostTerminalProfileSchema,
    initialWindow: TerminalHostWindowSizeSchema,
  })
  .readonly();
export type TerminalHostCreateRequest = z.infer<
  typeof TerminalHostCreateRequestSchema
>;
export const TerminalHostCreateResultSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    outcome: TerminalHostLaunchOutcomeSchema,
    limits: TerminalHostLimitsSchema,
  })
  .readonly();
export type TerminalHostCreateResult = z.infer<
  typeof TerminalHostCreateResultSchema
>;
export const TerminalHostInputClaimSchema = z
  .strictObject({
    token: z.string().min(1),
    writer: z.string().min(1),
    kind: z.enum(["user", "automation"]),
    leaseExpiresAt: Rfc3339UtcMillisecondsSchema,
  })
  .readonly();
export type InputClaim = z.infer<typeof TerminalHostInputClaimSchema>;
export const TerminalHostClaimResultSchema = z.discriminatedUnion("state", [
  z
    .strictObject({
      state: z.literal("granted"),
      claim: TerminalHostInputClaimSchema,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("denied"),
      owner: TerminalHostInputClaimSchema.nullable(),
      diagnostic: z.string().min(1),
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("unknown"),
      diagnostic: z.string().min(1),
    })
    .readonly(),
]);
export type ClaimResult = z.infer<typeof TerminalHostClaimResultSchema>;
export const TerminalHostInputReceiptSchema = z
  .strictObject({
    transactionId: z.string().min(1),
    stage: z.enum([
      "accepted",
      "queued",
      "written-to-terminal",
      "rejected",
      "unknown",
    ]),
    byteRange: z
      .strictObject({
        start: DecimalUint64Schema,
        endExclusive: DecimalUint64Schema,
      })
      .readonly()
      .nullable(),
    orderedAt: DecimalUint64Schema.nullable(),
    availableCreditBytes: SafeUintSchema,
    consumedByProcess: z.literal("not-claimed"),
    completeness: TerminalHostCompletenessSchema,
    diagnostic: z.string().min(1).nullable(),
  })
  .readonly();
export type InputReceipt = z.infer<typeof TerminalHostInputReceiptSchema>;
export const TerminalHostResizeResultSchema = z.discriminatedUnion("state", [
  z
    .strictObject({
      state: z.literal("applied"),
      revision: DecimalUint64Schema,
      readback: TerminalHostWindowSizeSchema,
      orderedAt: DecimalUint64Schema,
      foregroundProcessObservation: z.literal("not-claimed"),
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("stale"),
      currentRevision: DecimalUint64Schema,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("unknown"),
      diagnostic: z.string().min(1),
    })
    .readonly(),
]);
export type TerminalHostResizeResult = z.infer<
  typeof TerminalHostResizeResultSchema
>;

export const BASE64_BYTES_PATTERN =
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
const TerminalHostCheckpointBytesSchema = z.codec(
  z
    .string()
    .max(Math.ceil(TERMINAL_LIMITS.checkpointBytes / 3) * 4)
    .regex(new RegExp(BASE64_BYTES_PATTERN)),
  z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  {
    decode: (value) => new Uint8Array(Buffer.from(value, "base64")),
    encode: (value) => Buffer.from(value).toString("base64"),
  },
);
export const TerminalHostCheckpointSchema = z
  .strictObject({
    contentType: z.string().min(1),
    schemaVersion: z.string().min(1),
    hashAlgorithm: z.literal("sha256"),
    hash: z.string().min(1),
    throughEventSequence: DecimalUint64Schema,
    throughOutputOffset: DecimalUint64Schema,
    opaqueBytes: TerminalHostCheckpointBytesSchema,
  })
  .readonly();
export type Checkpoint = z.infer<typeof TerminalHostCheckpointSchema>;
const TerminalHostLifecycleSchema = z.enum([
  "creating",
  "running",
  "exited",
  "lost",
  "unknown",
]);
export const TerminalHostSessionInspectionSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    lifecycle: TerminalHostLifecycleSchema,
    completeness: TerminalHostCompletenessSchema,
    host: TerminalHostProcessIdentitySchema.nullable(),
    child: TerminalHostProcessIdentitySchema.nullable(),
    jobControl: TerminalHostJobControlEvidenceSchema.nullable(),
    window: z
      .strictObject({
        value: TerminalHostWindowSizeSchema,
        revision: DecimalUint64Schema,
      })
      .readonly(),
    output: z
      .strictObject({
        closed: z.boolean(),
        retained: z
          .strictObject({
            start: DecimalUint64Schema,
            endExclusive: DecimalUint64Schema,
          })
          .readonly(),
      })
      .readonly(),
    checkpoints: z
      .strictObject({
        retained: SafeUintSchema,
        newest: TerminalHostCheckpointSchema.nullable(),
      })
      .readonly(),
    inputOwner: TerminalHostInputClaimSchema.nullable(),
    exit: TerminalHostExitStatusSchema.nullable(),
    reap: TerminalHostReapEvidenceSchema,
    descendants: z.array(TerminalHostProcessIdentitySchema).readonly(),
    survivors: z
      .array(
        z
          .strictObject({
            process: TerminalHostProcessIdentitySchema,
            reason: z.string(),
          })
          .readonly(),
      )
      .readonly(),
    evidenceAt: Rfc3339UtcMillisecondsSchema,
    diagnostics: z.array(z.string()).readonly(),
  })
  .readonly();
export type TerminalHostSessionInspection = z.infer<
  typeof TerminalHostSessionInspectionSchema
>;
export const TerminalHostTerminationRequestSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    mode: z.enum(["graceful", "immediate"]),
    target: z.enum(["foreground-group", "session-members", "process-tree"]),
    deadline: Rfc3339UtcMillisecondsSchema,
    idempotencyKey: z.string().min(1),
  })
  .readonly();
export type TerminalHostTerminationRequest = z.infer<
  typeof TerminalHostTerminationRequestSchema
>;
export const TerminalHostTerminationResultSchema = z
  .strictObject({
    state: z.enum(["terminated", "survivors", "unknown"]),
    exit: TerminalHostExitStatusSchema.nullable(),
    reap: TerminalHostReapEvidenceSchema,
    survivors: z
      .array(
        z
          .strictObject({
            process: TerminalHostProcessIdentitySchema,
            reason: z.string(),
          })
          .readonly(),
      )
      .readonly(),
    completeness: TerminalHostCompletenessSchema,
    diagnostics: z.array(z.string()).readonly(),
  })
  .readonly();
export type TerminalHostTerminationResult = z.infer<
  typeof TerminalHostTerminationResultSchema
>;
export const TerminalHostResizeRequestSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    window: TerminalHostWindowSizeSchema,
    revision: DecimalUint64Schema,
    idempotencyKey: z.string().min(1),
  })
  .readonly();
/** Reports the observed window and mutation order, not app-level resize handling. */
export const TerminalHostResizeReceiptSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    revision: DecimalUint64Schema,
    orderedAt: DecimalUint64Schema,
    window: TerminalHostWindowSizeSchema,
  })
  .readonly();
/** Checkpoint capability negotiated during attach. */
export const TerminalHostCheckpointCapabilitySchema = z
  .strictObject({
    contentType: z.string().min(1),
    schemaVersion: z.string().min(1),
  })
  .readonly();
/** Attachment cursor uses the session order and an opaque checkpoint identity. */
export const TerminalHostAttachCursorSchema = z
  .strictObject({
    eventSequence: DecimalUint64Schema,
    outputOffset: DecimalUint64Schema,
    checkpoint: z.string().min(1).nullable(),
  })
  .readonly();
/** Attach negotiates a same-major minor range and checkpoint capability. */
export const TerminalHostAttachRequestSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    protocol: z
      .strictObject({
        major: z.literal(SESSION_PROTOCOL_VERSION.major),
        minMinor: ProtocolMinorSchema,
        maxMinor: ProtocolMinorSchema,
      })
      .refine(
        ({ minMinor, maxMinor }) => minMinor <= maxMinor,
        "protocol minor range is reversed",
      )
      .meta({ "x-hive-ordered-minor-range": true })
      .readonly(),
    checkpointCapabilities: z
      .array(TerminalHostCheckpointCapabilitySchema)
      .readonly(),
    cursor: TerminalHostAttachCursorSchema,
  })
  .readonly();
/** Host-reported resume position; a retention gap requires a full checkpoint. */
export const TerminalHostAttachResultSchema = z.discriminatedUnion("state", [
  z
    .strictObject({
      state: z.literal("attached"),
      session: TerminalHostSessionRefSchema,
      protocol: SelectedProtocolSchema,
      checkpoint: TerminalHostCheckpointCapabilitySchema.nullable(),
      resumeFrom: TerminalHostAttachCursorSchema,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("gap"),
      session: TerminalHostSessionRefSchema,
      missing: z
        .strictObject({
          start: DecimalUint64Schema,
          endExclusive: DecimalUint64Schema,
        })
        .readonly(),
      checkpointRequirement: z.literal("full"),
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("unknown"),
      diagnostic: z.string().min(1),
    })
    .readonly(),
]);

const PositiveSafeUintSchema = SafeUintSchema.min(1);

/** Positive negotiated caps; low-water cannot exceed high-water. */
export const TerminalHostSubscriptionLimitsSchema = z
  .strictObject({
    maxEventFrameBytes: PositiveSafeUintSchema,
    retainedEventCount: PositiveSafeUintSchema,
    unacknowledgedEventLowWater: PositiveSafeUintSchema,
    unacknowledgedEventHighWater: PositiveSafeUintSchema,
  })
  .refine(
    ({ unacknowledgedEventLowWater, unacknowledgedEventHighWater }) =>
      unacknowledgedEventLowWater <= unacknowledgedEventHighWater,
    "event watermarks are reversed",
  )
  .meta({ "x-hive-ordered-event-watermarks": true })
  .readonly();
/** Subscription cursor uses the session event and output order. */
export const TerminalHostSubscriptionCursorSchema = z
  .strictObject({
    eventSequence: DecimalUint64Schema,
    outputOffset: DecimalUint64Schema,
  })
  .readonly();
export const TerminalHostSubscribeRequestSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    protocol: z
      .strictObject({
        major: z.literal(SESSION_PROTOCOL_VERSION.major),
        minMinor: ProtocolMinorSchema,
        maxMinor: ProtocolMinorSchema,
      })
      .refine(
        ({ minMinor, maxMinor }) => minMinor <= maxMinor,
        "protocol minor range is reversed",
      )
      .meta({ "x-hive-ordered-minor-range": true })
      .readonly(),
    limits: TerminalHostSubscriptionLimitsSchema,
    from: z.discriminatedUnion("position", [
      z
        .strictObject({
          position: z.literal("at"),
          cursor: TerminalHostSubscriptionCursorSchema,
        })
        .readonly(),
      z.strictObject({ position: z.literal("end") }).readonly(),
    ]),
  })
  .readonly();
/** Host-reported delivery position; a retention gap requires fresh inspection. */
export const TerminalHostSubscribeResultSchema = z.discriminatedUnion("state", [
  z
    .strictObject({
      state: z.literal("subscribed"),
      session: TerminalHostSessionRefSchema,
      subscriptionId: z.string().min(1),
      protocol: SelectedProtocolSchema,
      limits: TerminalHostSubscriptionLimitsSchema,
      resumeFrom: TerminalHostSubscriptionCursorSchema,
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("gap"),
      session: TerminalHostSessionRefSchema,
      missing: z
        .strictObject({
          start: DecimalUint64Schema,
          endExclusive: DecimalUint64Schema,
        })
        .readonly(),
      freshInspection: z.literal("required"),
    })
    .readonly(),
  z
    .strictObject({
      state: z.literal("unknown"),
      diagnostic: z.string().min(1),
    })
    .readonly(),
]);
export const TerminalHostSubscriptionEventSchema = z.discriminatedUnion(
  "fact",
  [
    z
      .strictObject({
        fact: z.literal("lifecycle"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        lifecycle: TerminalHostLifecycleSchema,
      })
      .readonly(),
    z
      .strictObject({
        fact: z.literal("launch"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        outcome: TerminalHostLaunchOutcomeSchema,
      })
      .readonly(),
    z
      .strictObject({
        fact: z.literal("resize-applied"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        revision: DecimalUint64Schema,
        window: TerminalHostWindowSizeSchema,
      })
      .readonly(),
    z
      .strictObject({
        fact: z.literal("input-ownership"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        owner: TerminalHostInputClaimSchema.nullable(),
      })
      .readonly(),
    z
      .strictObject({
        fact: z.literal("retention-gap"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        missing: z
          .strictObject({
            start: DecimalUint64Schema,
            endExclusive: DecimalUint64Schema,
          })
          .readonly(),
        freshInspection: z.literal("required"),
      })
      .readonly(),
    z
      .strictObject({
        fact: z.literal("output-closed"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        reason: z.string().min(1),
      })
      .readonly(),
    z
      .strictObject({
        fact: z.literal("exit"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        exit: TerminalHostExitStatusSchema,
      })
      .readonly(),
    z
      .strictObject({
        fact: z.literal("reap"),
        session: TerminalHostSessionRefSchema,
        at: TerminalHostSubscriptionCursorSchema,
        reap: TerminalHostReapEvidenceSchema,
      })
      .readonly(),
  ],
);
/** Acknowledgement releases events only for its named subscription. */
export const TerminalHostEventAcknowledgementRequestSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    subscriptionId: z.string().min(1),
    through: TerminalHostSubscriptionCursorSchema,
  })
  .readonly();
/** Reports what the host released, rather than echoing the request. */
export const TerminalHostEventAcknowledgementSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    subscriptionId: z.string().min(1),
    through: TerminalHostSubscriptionCursorSchema,
    availableEventCredit: SafeUintSchema,
  })
  .readonly();
/** Inventory revisions are strictly positive canonical decimals. */
const PositiveDecimalUint64Schema = z
  .string()
  .regex(/^(?:[1-9][0-9]{0,19})$/)
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "must fit in an unsigned 64-bit integer",
  )
  .meta({ description: "unsigned 64-bit integer encoded as a decimal string" });
/** Visibility evidence uses a session, process start token, and inventory revision. */
export const TerminalHostVisibilityRequestSchema = z
  .strictObject({
    sourceSession: z.string().min(1),
    sourceProcess: TerminalHostProcessIdentitySchema,
    inventoryRevision: PositiveDecimalUint64Schema,
  })
  .readonly();
/** A visibility lease binds accepted source evidence for a finite interval. */
export const TerminalHostVisibilityLeaseSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    sourceSession: z.string().min(1),
    sourceProcess: TerminalHostProcessIdentitySchema,
    inventoryRevision: PositiveDecimalUint64Schema,
    state: z.literal("active"),
    issuedAt: Rfc3339UtcMillisecondsSchema,
    expiresAt: Rfc3339UtcMillisecondsSchema,
  })
  .refine(
    ({ issuedAt, expiresAt }) => issuedAt < expiresAt,
    "an active lease must expire strictly after it was issued",
    // UTC millisecond timestamps sort chronologically for native validation.
  )
  .meta({ "x-hive-ordered-lease-window": true })
  .readonly();
/** Renewal re-proves current visibility instead of trusting the existing lease. */
export const TerminalHostVisibilityRenewalRequestSchema = z
  .strictObject({
    session: TerminalHostSessionRefSchema,
    visibility: TerminalHostVisibilityRequestSchema,
  })
  .readonly();
/** Rejection leaves the existing deadline authoritative; partial evidence is unknown. */
export const TerminalHostVisibilityRenewalResultSchema = z.discriminatedUnion(
  "state",
  [
    z
      .strictObject({
        state: z.literal("active"),
        renewed: z.literal(true),
        lease: TerminalHostVisibilityLeaseSchema,
      })
      .readonly(),
    z
      .strictObject({
        state: z.literal("rejected"),
        // Explicit false prevents a rejection from reading as a renewal.
        renewed: z.literal(false),
        reason: z.enum([
          "invalid-revision",
          "stale-revision",
          "unverified-revision",
          "source-identity-mismatch",
          "source-not-live",
          "session-not-represented",
          "duplicate-session-owner",
          "session-generation-mismatch",
          "lease-expired",
        ]),
        diagnostic: z.string().min(1),
      })
      .readonly(),
    z
      .strictObject({
        state: z.literal("unknown"),
        renewed: z.literal(false),
        diagnostic: z.string().min(1),
      })
      .readonly(),
  ],
);
