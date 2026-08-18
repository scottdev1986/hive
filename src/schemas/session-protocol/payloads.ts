import { z } from "zod";
import { WireErrorCodeSchema } from "./frames";
import { TERMINAL_LIMITS } from "./limits";
import {
  DecimalUint64Schema,
  Rfc3339UtcMillisecondsSchema,
  Secret256HexSchema,
  TaggedSha256Schema,
} from "./primitives";
import {
  AttachGrantSchema,
  AttachRequestSchema,
  ProcessRootSchema,
  SessionLocatorSchema,
  SessionSpecSchema,
  SessionVisibilitySchema,
  TerminalGeometrySchema,
  VisibilityLeaseSchema,
  VisibilityRequestSchema,
} from "./session-protocol-schema";
import {
  BASE64_BYTES_PATTERN,
  TerminalHostInputReceiptSchema,
  TerminalHostResizeResultSchema,
  TerminalHostSessionInspectionSchema,
  TerminalHostSessionRefSchema,
  TerminalHostTerminationRequestSchema,
  TerminalHostTerminationResultSchema,
  TerminalHostWindowSizeSchema,
} from "./terminal-host";
import {
  ProtocolMinorSchema,
  SelectedProtocolSchema,
  SESSION_PROTOCOL_VERSION,
} from "./session-protocol-version";

const EncodedInputBytesSchema = z
  .string()
  .max(Math.ceil(TERMINAL_LIMITS.inputTransactionBytes / 3) * 4)
  .regex(new RegExp(BASE64_BYTES_PATTERN));

const ForegroundProcessIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  processGroupId: z.number().int().positive(),
});

export const ExpectedForegroundSchema = ForegroundProcessIdentitySchema.extend({
  providerRunId: z.string().uuid(),
});

export const InputSubmitPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    session: TerminalHostSessionRefSchema,
    provenance: z.enum(["user", "automation", "terminal"]),
    action: z.enum(["edit", "submit", "cancel", "gesture", "deliver", "keys"]),
    transactionId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    expectedForeground: ForegroundProcessIdentitySchema.readonly().optional(),
    operation: z.discriminatedUnion("kind", [
      z
        .strictObject({
          kind: z.literal("bytes"),
          encoding: z.literal("base64"),
          bytes: EncodedInputBytesSchema,
        })
        .readonly(),
      z.strictObject({ kind: z.literal("canonical-end-of-file") }).readonly(),
      z.strictObject({ kind: z.literal("hangup") }).readonly(),
    ]),
  })
  .readonly();

export const ResizePayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    session: TerminalHostSessionRefSchema,
    window: TerminalHostWindowSizeSchema,
    revision: DecimalUint64Schema,
    idempotencyKey: z.string().min(1),
  })
  .readonly();

export const AppliedPayloadSchema = z.discriminatedUnion("resultKind", [
  z
    .strictObject({
      schemaVersion: z.literal(1),
      resultKind: z.literal("input"),
      receipt: TerminalHostInputReceiptSchema,
    })
    .readonly(),
  z
    .strictObject({
      schemaVersion: z.literal(1),
      resultKind: z.literal("resize"),
      result: TerminalHostResizeResultSchema,
    })
    .readonly(),
  z
    .strictObject({
      schemaVersion: z.literal(1),
      resultKind: z.literal("output"),
      throughSeq: DecimalUint64Schema,
    })
    .readonly(),
]);
const AutomatedInputObjectSchema = z.strictObject({
  terminal: SessionLocatorSchema,
  expectedForeground: ExpectedForegroundSchema,
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  idempotencyKey: z.string().min(1),
});
export const AutomatedInputMetadataSchema = AutomatedInputObjectSchema.omit({
  bytes: true,
}).readonly();

const HelloCommonShape = {
  schemaVersion: z.literal(1),
  buildId: z.string().min(1),
  instanceId: z.string().min(1),
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
};
const DaemonControlIdentitySchema = z
  .strictObject({
    productVersion: z.string().min(1),
    buildHash: z.string().min(1),
    wireProtocol: z
      .strictObject({
        min: z.number(),
        max: z.number(),
      })
      .refine(
        ({ min, max }) => min <= max,
        "daemon wire protocol range is reversed",
      )
      .readonly(),
    schemaEpoch: z.number(),
    instanceId: z.string().min(1),
    hiveUuid: z.string().min(1),
    identityKey: z.string().min(1),
    repoFamilyKey: z.string().min(1).nullable(),
  })
  .readonly();

export const HelloPayloadSchema = z
  .discriminatedUnion("clientRole", [
    z.strictObject({
      ...HelloCommonShape,
      clientRole: z.literal("viewer"),
      grantToken: z.string().min(1).optional(),
    }),
    z.strictObject({
      ...HelloCommonShape,
      clientRole: z.literal("daemon"),
      daemonControl: DaemonControlIdentitySchema,
    }),
    z.strictObject({
      ...HelloCommonShape,
      clientRole: z.literal("broker"),
    }),
    z.strictObject({
      ...HelloCommonShape,
      clientRole: z.literal("host"),
    }),
  ])
  .readonly();

export const WelcomePayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    protocol: SelectedProtocolSchema,
    instanceId: z.string().min(1),
    endpointRole: z.enum(["broker", "host"]),
    buildId: z.string().min(1),
    engineBuildId: z.string().min(1).nullable(),
    connectionId: DecimalUint64Schema,
    serverEpoch: DecimalUint64Schema,
    limits: z
      .strictObject({
        controlFrameMaxBytes: z
          .number()
          .int()
          .positive()
          .max(TERMINAL_LIMITS.controlJsonBytesPerFrame),
        maxInputTransactionBytes: z
          .number()
          .int()
          .positive()
          .max(TERMINAL_LIMITS.inputTransactionBytes),
        streamChunkMaxBytes: z
          .number()
          .int()
          .positive()
          .max(TERMINAL_LIMITS.streamChunkBytes),
        automatedMessageMaxBytes: z
          .number()
          .int()
          .positive()
          .max(TERMINAL_LIMITS.automatedMessageBytes),
        viewerQueueMaxBytes: z
          .number()
          .int()
          .positive()
          .max(TERMINAL_LIMITS.viewerUnacknowledgedOutputBytes),
      })
      .readonly(),
  })
  .readonly();

export const ErrorPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    code: WireErrorCodeSchema,
    message: z.string().min(1),
    diagnosticId: z.string().min(1).nullable(),
  })
  .readonly();

export const PingPongPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** PING/PONG carry sender monotonic nanoseconds; uint64 uses decimal text. */
    monoNanos: DecimalUint64Schema,
  })
  .readonly();

const HostRecordProjectionSchema = z
  .strictObject({
    locator: SessionLocatorSchema,
    hostPid: z.number().int().positive(),
    hostStartToken: z.string().min(1),
    processRoot: ProcessRootSchema,
    expectedExecutable: z.string().min(1),
    executableBuildHash: z.string().min(1),
    engineBuildId: z.string().min(1),
    protocol: SelectedProtocolSchema,
    geometry: TerminalGeometrySchema,
    state: z.enum(["starting", "live", "exited", "unknown"]),
    outputSeq: DecimalUint64Schema,
    checkpointSeq: DecimalUint64Schema,
    visibility: SessionVisibilitySchema,
  })
  .readonly();

export const HostRecordV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...HostRecordProjectionSchema.unwrap().shape,
    createdAt: Rfc3339UtcMillisecondsSchema,
  })
  .readonly();

export const HostRegisterPayloadSchema = z
  .union([
    z.strictObject({
      schemaVersion: z.literal(1),
      record: HostRecordProjectionSchema,
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      accepted: z.literal(true),
    }),
  ])
  .readonly();

export const HostAdoptPayloadSchema = z
  .union([
    z.strictObject({
      schemaVersion: z.literal(1),
      adoptionSecretHex: Secret256HexSchema,
      expectedLocator: SessionLocatorSchema,
      brokerBuildId: z.string().min(1),
      protocol: SelectedProtocolSchema,
      operation: z.literal("adopt"),
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      locator: SessionLocatorSchema,
      hostPid: z.number().int().positive(),
      hostStartToken: z.string().min(1),
      executable: z.string().min(1),
      executableBuildHash: z.string().min(1),
      engineBuildId: z.string().min(1),
      /** Adoption compares the host-selected protocol, not the broker's offered constants. */
      protocol: SelectedProtocolSchema,
      processRoot: ProcessRootSchema,
      outputSeq: DecimalUint64Schema,
      checkpointSeq: DecimalUint64Schema,
      visibility: SessionVisibilitySchema,
    }),
  ])
  .readonly();

export const GrantRegisterPayloadSchema = z
  .union([
    z.strictObject({
      schemaVersion: z.literal(1),
      grantTokenSha256: TaggedSha256Schema,
      viewerId: z.string().min(1),
      operations: z.array(z.enum(["view", "user-input", "resize"])).readonly(),
      expiresAt: Rfc3339UtcMillisecondsSchema,
      geometry: TerminalGeometrySchema,
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      registered: z.literal(true),
    }),
  ])
  .readonly();

export const CreateBeginPayloadSchema = z
  .strictObject({
    ...SessionSpecSchema.unwrap().shape,
    visibility: VisibilityRequestSchema,
  })
  .refine(
    ({ visibility }) => BigInt(visibility.openTerminalRevision) > 0n,
    "create visibility revision must be positive",
  )
  .meta({ "x-hive-positive-open-terminal-revision": "visibility" })
  .readonly();
/** Frozen A0 list is deliberately unscoped; Hive filtering lives in the adapter. */
export const ListPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
  })
  .readonly();
export const ListedPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    entries: z.array(TerminalHostSessionInspectionSchema).readonly(),
  })
  .readonly();
export const InspectPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    session: TerminalHostSessionRefSchema,
  })
  .readonly();
export const InspectedPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...TerminalHostSessionInspectionSchema.unwrap().shape,
  })
  .readonly();
export const TerminatePayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...TerminalHostTerminationRequestSchema.unwrap().shape,
  })
  .readonly();
export const TerminatedPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...TerminalHostTerminationResultSchema.unwrap().shape,
  })
  .readonly();
export const VisibilityRenewPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    locator: SessionLocatorSchema,
    ...VisibilityRequestSchema.unwrap().shape,
  })
  .readonly();
export const RenewedPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...VisibilityLeaseSchema.unwrap().shape,
  })
  .readonly();
export const AttachRequestPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    locator: SessionLocatorSchema,
    ...AttachRequestSchema.unwrap().shape,
  })
  .readonly();
export const AttachGrantPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...AttachGrantSchema.unwrap().shape,
  })
  .readonly();
export const HostAttachPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    locator: SessionLocatorSchema,
    token: z.string().min(1),
    geometry: TerminalGeometrySchema,
    afterSeq: DecimalUint64Schema,
  })
  .readonly();
