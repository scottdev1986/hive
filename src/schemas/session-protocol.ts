import { z } from "zod";
import type * as SessionHostContract from "../daemon/session-host/contract";

export const SESSION_PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export const SESSION_PROTOCOL_PATHS = {
  ghosttyVendor: "vendor/ghostty/",
  sessiond: "native/sessiond/",
  sessiondProtocol: "native/sessiond/src/protocol.zig",
  sessiondBroker: "native/sessiond/src/broker.zig",
  sessiondHost: "native/sessiond/src/session_host.zig",
  sessiondPtyHost: "native/sessiond/src/pty_host.zig",
  sessiondTerminalState: "native/sessiond/src/terminal_state.zig",
  sessiondInputArbiter: "native/sessiond/src/input_arbiter.zig",
  sessiondProcessInspector: "native/sessiond/src/process_inspector.zig",
  daemonSessionHost: "src/daemon/session-host/",
  daemonSessionHostContract: "src/daemon/session-host/contract.ts",
  daemonTmuxHost: "src/daemon/session-host/tmux-host.ts",
  daemonSessiondHost: "src/daemon/session-host/sessiond-host.ts",
  daemonHierarchyRouter: "src/daemon/session-host/hierarchy-router.ts",
  schemas: "src/schemas/",
  sessionProtocolSchema: "src/schemas/session-protocol.ts",
  statusEnvelopeSchema: "src/schemas/status-envelope.ts",
  messageEnvelopeSchema: "src/schemas/message-envelope.ts",
  terminalKit: "workspace/Sources/HiveTerminalKit/",
  workspaceCore: "workspace/Sources/WorkspaceCore/",
  statusReducer: "workspace/Sources/WorkspaceCore/StatusReducer.swift",
  hierarchyReducer: "workspace/Sources/WorkspaceCore/HierarchyReducer.swift",
  fixtures: "workspace/Tests/WorkspaceCoreTests/Fixtures/",
  conformance: "test/session-host-conformance/",
  terminalCorpus: "test/terminal-corpus/",
  ghosttyBuildScript: "scripts/build-ghosttykit.sh",
} as const;

export const TERMINAL_LIMITS = {
  liveSessionsPerHiveHome: 32,
  authenticatedViewersPerGeneration: 4,
  controlJsonBytesPerFrame: 256 * 1024,
  streamChunkBytes: 64 * 1024,
  automatedMessageBytes: 1024 * 1024,
  viewerUnacknowledgedOutputBytes: 8 * 1024 * 1024,
  viewerReattachAfterRebaseMilliseconds: 5_000,
  replayJournalBytesPerGeneration: 64 * 1024 * 1024,
  retainedCheckpoints: 2,
  checkpointBytes: 64 * 1024 * 1024,
  terminalDiskBytesPerHiveHome: 2 * 1024 * 1024 * 1024,
  scrollbackLogicalLines: 50_000,
  nonImageCheckpointBytes: 48 * 1024 * 1024,
  terminalCellsPerDimensionMin: 1,
  terminalCellsPerDimensionMax: 1_000,
  terminalActiveCellsMax: 250_000,
  kittyImageDecodedBytesPerGeneration: 16 * 1024 * 1024,
  controlRpcTimeoutMilliseconds: 10_000,
  attachGrantTimeoutMilliseconds: 30_000,
  visibilityRenewalMilliseconds: 5_000,
  visibilityExpiryMilliseconds: 15_000,
  connectionPingIntervalMilliseconds: 5_000,
  missedPongIntervalsBeforeDetach: 3,
  checkpointOutputIntervalBytes: 2 * 1024 * 1024,
  checkpointIntervalMilliseconds: 30_000,
} as const;

export const FRAME_HEADER = {
  bytes: 32,
  magic: "HVT1",
  magicBytes: [0x48, 0x56, 0x54, 0x31],
  byteOrder: "network",
  widths: {
    magic: 4,
    major: 1,
    minor: 1,
    type: 2,
    flags: 2,
    reserved: 2,
    payloadLength: 4,
    requestId: 8,
    streamSeq: 8,
  },
  offsets: {
    magic: 0,
    major: 4,
    minor: 5,
    type: 6,
    flags: 8,
    reserved: 10,
    payloadLength: 12,
    requestId: 16,
    streamSeq: 24,
  },
  optionalTypeBit: 0x8000,
  unknownOptionalType: "ignore",
  unknownRequiredType: "UNSUPPORTED_FRAME",
} as const;

export const FRAME_FLAGS = {
  response: 1 << 0,
  final: 1 << 1,
  error: 1 << 2,
  contentSensitive: 1 << 3,
  allowedMask: 0x000f,
} as const;

export const FRAME_TYPES = {
  HELLO: 0x0001,
  WELCOME: 0x0002,
  ERROR: 0x0003,
  PING: 0x0004,
  PONG: 0x0005,
  CREATE_BEGIN: 0x0100,
  CREATE_INPUT: 0x0101,
  CREATE_COMMIT: 0x0102,
  CREATED: 0x0103,
  LIST: 0x0110,
  LISTED: 0x0111,
  INSPECT: 0x0112,
  INSPECTED: 0x0113,
  TERMINATE: 0x0114,
  TERMINATED: 0x0115,
  VISIBILITY_RENEW: 0x0116,
  RENEWED: 0x0117,
  ATTACH_REQUEST: 0x0200,
  ATTACH_GRANT: 0x0201,
  HOST_ATTACH: 0x0202,
  SNAPSHOT_BEGIN: 0x0203,
  SNAPSHOT_BYTES: 0x0204,
  OUTPUT: 0x0205,
  APPLIED: 0x0206,
  RESIZE: 0x0207,
  DETACH: 0x0208,
  EVENT: 0x0209,
  CLAIM_ACQUIRE: 0x0300,
  CLAIM_RESULT: 0x0301,
  HUMAN_INPUT: 0x0302,
  CLAIM_RELEASE: 0x0303,
  GESTURE_INPUT: 0x0304,
  AUTOMATION_BEGIN: 0x0310,
  AUTOMATION_CHUNK: 0x0311,
  AUTOMATION_COMMIT: 0x0312,
  AUTOMATION_RESULT: 0x0313,
  AUTOMATION_CANCEL: 0x0314,
  HOST_REGISTER: 0x0400,
  HOST_ADOPT: 0x0401,
  GRANT_REGISTER: 0x0402,
} as const;

export type FrameTypeName = keyof typeof FRAME_TYPES;

export const FRAME_TYPE_GROUPS = [
  { names: ["HELLO", "WELCOME", "ERROR"], direction: "bidirectional", purpose: "handshake-identity-limits-error" },
  { names: ["PING", "PONG"], direction: "bidirectional", purpose: "connection-liveness" },
  { names: ["CREATE_BEGIN", "CREATE_INPUT", "CREATE_COMMIT", "CREATED"], direction: "daemon-broker-bidirectional", purpose: "transactional-create" },
  { names: ["LIST", "LISTED"], direction: "daemon-broker-bidirectional", purpose: "instance-inventory" },
  { names: ["INSPECT", "INSPECTED"], direction: "client-endpoint-bidirectional", purpose: "exact-locator-inspection" },
  { names: ["TERMINATE", "TERMINATED"], direction: "daemon-broker-host-bidirectional", purpose: "termination-positive-readback" },
  { names: ["VISIBILITY_RENEW", "RENEWED"], direction: "daemon-broker-host-bidirectional", purpose: "visibility-lease-renewal" },
  { names: ["ATTACH_REQUEST", "ATTACH_GRANT", "HOST_ATTACH"], direction: "workspace-broker-host-bidirectional", purpose: "one-use-viewer-attach" },
  { names: ["SNAPSHOT_BEGIN", "SNAPSHOT_BYTES"], direction: "host-to-viewer", purpose: "checkpoint-stream" },
  { names: ["OUTPUT", "APPLIED"], direction: "host-viewer-bidirectional", purpose: "ordered-output-and-high-water" },
  { names: ["RESIZE", "DETACH", "EVENT"], direction: "bidirectional", purpose: "geometry-transport-detach-session-event" },
  { names: ["CLAIM_ACQUIRE", "CLAIM_RESULT"], direction: "viewer-host-bidirectional", purpose: "authoring-claim" },
  { names: ["HUMAN_INPUT", "CLAIM_RELEASE", "GESTURE_INPUT"], direction: "viewer-to-host", purpose: "ordered-human-input" },
  { names: ["AUTOMATION_BEGIN", "AUTOMATION_CHUNK", "AUTOMATION_COMMIT", "AUTOMATION_RESULT", "AUTOMATION_CANCEL"], direction: "daemon-host-bidirectional", purpose: "idempotent-buffered-automation" },
  { names: ["HOST_REGISTER", "HOST_ADOPT", "GRANT_REGISTER"], direction: "broker-host-bidirectional", purpose: "authenticated-internal-lifecycle" },
] as const satisfies readonly Readonly<{
  names: readonly FrameTypeName[];
  direction: string;
  purpose: string;
}>[];

export const RAW_BYTE_FRAME_TYPES = [
  "CREATE_INPUT",
  "SNAPSHOT_BYTES",
  "OUTPUT",
  "HUMAN_INPUT",
  "AUTOMATION_CHUNK",
] as const satisfies readonly FrameTypeName[];

export const WIRE_ERROR_CODES = [
  "PROTOCOL_MISMATCH",
  "UNSUPPORTED_FRAME",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INSTANCE_MISMATCH",
  "GENERATION_MISMATCH",
  "NOT_FOUND",
  "NOT_READY",
  "ALREADY_EXISTS",
  "HUMAN_OWNED",
  "HUMAN_ORPHANED",
  "INPUT_BUSY",
  "REBASE_REQUIRED",
  "SNAPSHOT_REQUIRED",
  "CHECKPOINT_UNAVAILABLE",
  "ENGINE_MISMATCH",
  "PAYLOAD_TOO_LARGE",
  "FRAME_TOO_LARGE",
  "MALFORMED_FRAME",
  "IN_DOUBT",
  "VERIFICATION_UNKNOWN",
  "CAPACITY_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
] as const;

export const WireErrorCodeSchema = z.enum(WIRE_ERROR_CODES);
export type WireErrorCode = z.infer<typeof WireErrorCodeSchema>;

export const INPUT_ARBITER_STATES = [
  "FREE",
  "HUMAN_GESTURE",
  "HUMAN_OWNED",
  "HUMAN_ORPHANED",
  "AUTOMATION_BUFFERING",
  "AUTOMATION_COMMITTED",
  "TERMINATING",
  "CLOSED",
] as const;

export const InputArbiterStateSchema = z.enum(INPUT_ARBITER_STATES);
export type InputArbiterState = z.infer<typeof InputArbiterStateSchema>;

export const INPUT_ARBITER_TRANSITIONS = [
  { from: "FREE", event: "CLAIM_ACQUIRE", through: [], to: "HUMAN_OWNED" },
  { from: "FREE", event: "GESTURE_INPUT", through: ["HUMAN_GESTURE"], to: "FREE" },
  { from: "FREE", event: "AUTOMATION_BEGIN", through: [], to: "AUTOMATION_BUFFERING" },
  { from: "HUMAN_OWNED", event: "HUMAN_INPUT", through: [], to: "HUMAN_OWNED" },
  { from: "HUMAN_OWNED", event: "CLAIM_RELEASE", through: [], to: "FREE" },
  { from: "HUMAN_OWNED", event: "VIEWER_DISCONNECT", through: [], to: "HUMAN_ORPHANED" },
  { from: "HUMAN_ORPHANED", event: "OPERATOR_RESUME", through: [], to: "HUMAN_OWNED" },
  { from: "HUMAN_ORPHANED", event: "OPERATOR_DISCARD", through: [], to: "FREE" },
  {
    from: "AUTOMATION_BUFFERING",
    event: "AUTOMATION_COMMIT",
    through: ["AUTOMATION_COMMITTED"],
    to: "FREE",
  },
  { from: "*", event: "TERMINATE", through: ["TERMINATING"], to: "CLOSED" },
] as const;

export const INPUT_EVIDENCE_LEVELS = [
  "buffered",
  "committed",
  "written",
  "provider-observed",
] as const;

export const InputEvidenceLevelSchema = z.enum(INPUT_EVIDENCE_LEVELS);
export type InputEvidenceLevel = z.infer<typeof InputEvidenceLevelSchema>;

export const INPUT_EVIDENCE_CONTRACTS = {
  buffered: { means: "length-and-digest-verified", excludes: ["authorized", "ready", "injected", "read"] },
  committed: { means: "host-write-queue-owns-contiguous-range", excludes: ["kernel-consumed", "provider-consumed"] },
  written: { means: "pty-master-accepted-complete-range-in-order", excludes: ["provider-ui-accepted", "agent-read"] },
  "provider-observed": { means: "matching-provider-boundary-after-attempt", excludes: ["understood", "acknowledged", "applied"] },
} as const satisfies Record<(typeof INPUT_EVIDENCE_LEVELS)[number], unknown>;

export const INPUT_RECEIPT_STATES = [
  "queued",
  "buffered",
  "committed",
  "written",
  "in-doubt",
] as const;

export const GHOSTTY_BRIDGE_EVENTS = {
  INVALIDATE: 1,
  TITLE: 2,
  PWD: 3,
  BELL: 4,
  CLIPBOARD_DENIED: 5,
  CLOSE_REQUEST: 6,
} as const;

export const CHECKPOINT_HEADER = {
  bytes: 116,
  magic: "HVTCP001",
  version: 1,
  flags: 0,
  byteOrder: "network",
  cellPixelEncoding: "unsigned-fixed-16.16",
  payloadMaxBytes: TERMINAL_LIMITS.checkpointBytes,
  engineBuildIdBytes: 32,
  payloadSha256Bytes: 32,
  widths: {
    magic: 8,
    version: 2,
    headerBytes: 2,
    flags: 4,
    throughSeq: 8,
    createdMonoNanos: 8,
    columns: 4,
    rows: 4,
    cellWidthPx: 4,
    cellHeightPx: 4,
    engineBuildId: 32,
    payloadLength: 4,
    payloadSha256: 32,
  },
  offsets: {
    magic: 0,
    version: 8,
    headerBytes: 10,
    flags: 12,
    throughSeq: 16,
    createdMonoNanos: 24,
    columns: 32,
    rows: 36,
    cellWidthPx: 40,
    cellHeightPx: 44,
    engineBuildId: 48,
    payloadLength: 80,
    payloadSha256: 84,
  },
} as const;

export const DECIMAL_UINT64_PATTERN = "^(?:0|[1-9][0-9]{0,19})$";
export const DecimalUint64Schema = z.string().regex(new RegExp(DECIMAL_UINT64_PATTERN)).refine(
  (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
  "must fit in an unsigned 64-bit integer",
).meta({ format: "hive-uint64-decimal" });
export const SafeUintSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PositiveGenerationSchema = SafeUintSchema.min(1);
export const Rfc3339UtcMillisecondsSchema = z.iso.datetime({
  offset: false,
  precision: 3,
});
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const UUID_V7_BODY =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function domainUuidV7Schema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_${UUID_V7_BODY}$`));
}

export const SESSION_PROTOCOL_PROVIDERS = [
  "claude",
  "codex",
  "grok",
] as const;
export const SessionProtocolProviderSchema = z.enum(SESSION_PROTOCOL_PROVIDERS);

export const SessionSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("root") }),
  z.strictObject({ kind: z.literal("agent"), agentId: z.string().min(1) }),
]).readonly();
export type SessionSubject = z.infer<typeof SessionSubjectSchema>;

export const SessionLocatorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: z.string().min(1),
  subject: SessionSubjectSchema,
  generation: PositiveGenerationSchema,
  sessionId: domainUuidV7Schema("ses"),
  hostKind: z.enum(["tmux", "sessiond"]),
  engineBuildId: z.string().min(1).nullable(),
}).readonly();
export type SessionLocator = z.infer<typeof SessionLocatorSchema>;

export const TerminalGeometrySchema = z.strictObject({
  columns: z.number().int().min(TERMINAL_LIMITS.terminalCellsPerDimensionMin)
    .max(TERMINAL_LIMITS.terminalCellsPerDimensionMax),
  rows: z.number().int().min(TERMINAL_LIMITS.terminalCellsPerDimensionMin)
    .max(TERMINAL_LIMITS.terminalCellsPerDimensionMax),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  cellWidthPx: z.number().positive(),
  cellHeightPx: z.number().positive(),
}).refine(
  ({ columns, rows }) => columns * rows <= TERMINAL_LIMITS.terminalActiveCellsMax,
  "active terminal cells exceed the v1 limit",
).meta({ "x-hive-max-active-cells": TERMINAL_LIMITS.terminalActiveCellsMax }).readonly();
export type TerminalGeometry = z.infer<typeof TerminalGeometrySchema>;

export const SessionSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locator: SessionLocatorSchema,
  provider: SessionProtocolProviderSchema,
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
}).readonly();
export type SessionSpec = z.infer<typeof SessionSpecSchema>;

const SessionExitSchema = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  observedAt: Rfc3339UtcMillisecondsSchema,
}).nullable();
const SessionSurvivorsSchema = z.array(z.strictObject({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  reason: z.string().min(1),
})).readonly();

export const SessionInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locator: SessionLocatorSchema,
  presence: z.enum(["present", "exited", "lost", "unknown"]),
  complete: z.boolean(),
  hostPid: z.number().int().positive().nullable(),
  hostStartToken: z.string().min(1).nullable(),
  providerRoot: z.strictObject({
    pid: z.number().int().positive(),
    startToken: z.string().min(1),
    processGroupId: z.number().int().positive(),
  }).nullable(),
  expectedExecutable: z.string().min(1),
  executableVerified: z.boolean(),
  outputSeq: DecimalUint64Schema,
  checkpointSeq: DecimalUint64Schema,
  checkpointAvailable: z.boolean(),
  input: z.strictObject({
    state: InputArbiterStateSchema,
    ownerViewerId: z.string().min(1).nullable(),
    claimId: z.string().min(1).nullable(),
  }),
  viewerCount: z.number().int().min(0).max(TERMINAL_LIMITS.authenticatedViewersPerGeneration),
  geometry: TerminalGeometrySchema,
  resources: z.record(z.string(), z.number()).readonly(),
  visibility: z.strictObject({
    state: z.enum(["attaching", "visible", "reconnecting", "expired"]),
    workspaceSessionId: z.string().min(1),
    openTerminalRevision: DecimalUint64Schema,
    expiresAt: Rfc3339UtcMillisecondsSchema,
  }),
  exit: SessionExitSchema,
  survivors: SessionSurvivorsSchema,
  evidenceAt: Rfc3339UtcMillisecondsSchema,
  diagnosticIds: z.array(z.string().min(1)).readonly(),
}).readonly();
export type SessionInspection = z.infer<typeof SessionInspectionSchema>;

export const CreateResultSchema = z.strictObject({
  locator: SessionLocatorSchema,
  inspection: SessionInspectionSchema,
  created: z.literal(true),
}).readonly();
export const CaptureRequestSchema = z.strictObject({
  include: z.enum(["metadata", "visible-text"]),
  maxRows: z.number().int().min(1).max(200),
  expectedOutputSeq: DecimalUint64Schema.optional(),
}).readonly();
export const CaptureResultSchema = z.strictObject({
  locator: SessionLocatorSchema,
  outputSeq: DecimalUint64Schema,
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  screen: z.enum(["primary", "alternate"]),
  cursor: z.strictObject({
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    visible: z.boolean(),
  }),
  text: z.string().nullable(),
  truncated: z.boolean(),
  sha256: Sha256HexSchema,
}).readonly();
export const AttachRequestSchema = z.strictObject({
  viewerId: z.string().min(1),
  geometry: TerminalGeometrySchema,
  operations: z.array(z.enum(["view", "human-input", "resize"])).readonly(),
}).readonly();
export const AttachGrantSchema = z.strictObject({
  locator: SessionLocatorSchema,
  endpoint: z.string().min(1),
  token: z.string().min(1),
  expiresAt: Rfc3339UtcMillisecondsSchema,
  engineBuildId: z.string().min(1),
  checkpointSeq: DecimalUint64Schema,
  outputSeq: DecimalUint64Schema,
  operations: z.array(z.enum(["view", "human-input", "resize"])).readonly(),
}).readonly();
export const VisibilityRequestSchema = z.strictObject({
  workspaceSessionId: z.string().min(1),
  workspacePid: z.number().int().positive(),
  workspaceStartToken: z.string().min(1),
  openTerminalRevision: DecimalUint64Schema,
}).readonly();
export const VisibilityLeaseSchema = z.strictObject({
  locator: SessionLocatorSchema,
  state: z.literal("active"),
  expiresAt: Rfc3339UtcMillisecondsSchema,
  openTerminalRevision: DecimalUint64Schema,
}).readonly();
export const ResizeResultSchema = z.strictObject({
  locator: SessionLocatorSchema,
  geometry: TerminalGeometrySchema,
  revision: DecimalUint64Schema,
}).readonly();
const AutomatedInputObjectSchema = z.strictObject({
  transactionId: domainUuidV7Schema("txn"),
  idempotencyKey: z.string().min(1),
  messageId: domainUuidV7Schema("msg"),
  recipientGeneration: PositiveGenerationSchema,
  capabilityEpoch: SafeUintSchema,
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  sha256: Sha256HexSchema,
  providerStrategy: z.string().min(1),
  submit: z.enum(["none", "return", "control-enter"]),
});
export const AutomatedInputSchema = AutomatedInputObjectSchema.readonly();
export const AutomatedInputMetadataSchema = AutomatedInputObjectSchema.omit({ bytes: true }).readonly();
export const InputReceiptSchema = z.strictObject({
  transactionId: domainUuidV7Schema("txn"),
  messageId: domainUuidV7Schema("msg"),
  state: z.enum(INPUT_RECEIPT_STATES),
  byteRange: z.strictObject({
    start: DecimalUint64Schema,
    endExclusive: DecimalUint64Schema,
  }).nullable(),
  providerObservation: z.enum(["unavailable", "pending", "observed"]),
  evidenceAt: Rfc3339UtcMillisecondsSchema,
  diagnosticId: z.string().min(1).nullable(),
}).readonly();
export const TerminationRequestSchema = z.strictObject({
  mode: z.enum(["graceful", "immediate"]),
  reason: z.string().min(1),
  requestId: domainUuidV7Schema("req"),
}).readonly();
export const TerminationResultSchema = z.strictObject({
  locator: SessionLocatorSchema,
  state: z.enum(["terminated", "survivors", "unknown"]),
  exit: SessionExitSchema,
  survivors: SessionSurvivorsSchema,
  errors: z.array(z.strictObject({
    phase: z.string().min(1),
    code: z.string().min(1),
    diagnosticId: z.string().min(1),
  })).readonly(),
}).readonly();
export const SessionEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: domainUuidV7Schema("evt"),
  eventSeq: DecimalUint64Schema,
  locator: SessionLocatorSchema,
  kind: z.string().min(1),
  revision: DecimalUint64Schema,
  occurredAt: Rfc3339UtcMillisecondsSchema,
  data: z.record(z.string(), z.unknown()).readonly(),
}).readonly();

export const SESSION_WIRE_SCHEMAS = {
  sessionLocator: SessionLocatorSchema,
  terminalGeometry: TerminalGeometrySchema,
  sessionSpec: SessionSpecSchema,
  sessionInspection: SessionInspectionSchema,
  createResult: CreateResultSchema,
  captureRequest: CaptureRequestSchema,
  captureResult: CaptureResultSchema,
  attachRequest: AttachRequestSchema,
  attachGrant: AttachGrantSchema,
  visibilityRequest: VisibilityRequestSchema,
  visibilityLease: VisibilityLeaseSchema,
  resizeResult: ResizeResultSchema,
  automatedInputMetadata: AutomatedInputMetadataSchema,
  inputReceipt: InputReceiptSchema,
  terminationRequest: TerminationRequestSchema,
  terminationResult: TerminationResultSchema,
  sessionEvent: SessionEventSchema,
} as const;

type Assert<T extends true> = T;
type Equals<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;

type SessionSubjectSchemaMatchesContract = Assert<Equals<z.infer<typeof SessionSubjectSchema>, SessionHostContract.SessionSubject>>;
type SessionLocatorSchemaMatchesContract = Assert<Equals<z.infer<typeof SessionLocatorSchema>, SessionHostContract.SessionLocator>>;
type SessionSpecSchemaMatchesContract = Assert<Equals<z.infer<typeof SessionSpecSchema>, SessionHostContract.SessionSpec>>;
type TerminalGeometrySchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalGeometrySchema>, SessionHostContract.TerminalGeometry>>;
type SessionInspectionSchemaMatchesContract = Assert<Equals<z.infer<typeof SessionInspectionSchema>, SessionHostContract.SessionInspection>>;
type CreateResultSchemaMatchesContract = Assert<Equals<z.infer<typeof CreateResultSchema>, SessionHostContract.CreateResult>>;
type CaptureRequestSchemaMatchesContract = Assert<Equals<z.infer<typeof CaptureRequestSchema>, SessionHostContract.CaptureRequest>>;
type CaptureResultSchemaMatchesContract = Assert<Equals<z.infer<typeof CaptureResultSchema>, SessionHostContract.CaptureResult>>;
type AttachRequestSchemaMatchesContract = Assert<Equals<z.infer<typeof AttachRequestSchema>, SessionHostContract.AttachRequest>>;
type AttachGrantSchemaMatchesContract = Assert<Equals<z.infer<typeof AttachGrantSchema>, SessionHostContract.AttachGrant>>;
type VisibilityRequestSchemaMatchesContract = Assert<Equals<z.infer<typeof VisibilityRequestSchema>, SessionHostContract.VisibilityRequest>>;
type VisibilityLeaseSchemaMatchesContract = Assert<Equals<z.infer<typeof VisibilityLeaseSchema>, SessionHostContract.VisibilityLease>>;
type ResizeResultSchemaMatchesContract = Assert<Equals<z.infer<typeof ResizeResultSchema>, SessionHostContract.ResizeResult>>;
type AutomatedInputSchemaMatchesContract = Assert<Equals<z.infer<typeof AutomatedInputSchema>, SessionHostContract.AutomatedInput>>;
type InputReceiptSchemaMatchesContract = Assert<Equals<z.infer<typeof InputReceiptSchema>, SessionHostContract.InputReceipt>>;
type TerminationRequestSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminationRequestSchema>, SessionHostContract.TerminationRequest>>;
type TerminationResultSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminationResultSchema>, SessionHostContract.TerminationResult>>;
type SessionEventSchemaMatchesContract = Assert<Equals<z.infer<typeof SessionEventSchema>, SessionHostContract.SessionEvent>>;

export const SESSION_HOST_PERMISSIONS = {
  inspect: ["authorized-instance"],
  list: ["authorized-instance"],
  captureMetadata: ["self", "operator"],
  captureVisibleText: ["terminal:observe", "content-audit"],
  attach: ["authorized-viewer", "exact-generation"],
  resize: ["selected-viewer", "control-daemon"],
  automatedInput: ["communication-authorized-message", "exact-generation", "capability-epoch"],
  terminate: ["authorized-lifecycle-intent", "terminal-close", "terminal-quit", "visibility-expiry"],
  subscribe: ["authorized-instance", "retained-event-cursor"],
} as const;

export const SESSION_PROTOCOL_CONTRACT = {
  version: SESSION_PROTOCOL_VERSION,
  paths: SESSION_PROTOCOL_PATHS,
  limits: TERMINAL_LIMITS,
  frameHeader: FRAME_HEADER,
  frameFlags: FRAME_FLAGS,
  frameTypes: FRAME_TYPES,
  frameTypeGroups: FRAME_TYPE_GROUPS,
  rawByteFrameTypes: RAW_BYTE_FRAME_TYPES,
  errorCodes: WIRE_ERROR_CODES,
  inputArbiterStates: INPUT_ARBITER_STATES,
  inputArbiterTransitions: INPUT_ARBITER_TRANSITIONS,
  inputEvidenceLevels: INPUT_EVIDENCE_LEVELS,
  inputEvidenceContracts: INPUT_EVIDENCE_CONTRACTS,
  ghosttyBridgeEvents: GHOSTTY_BRIDGE_EVENTS,
  checkpointHeader: CHECKPOINT_HEADER,
  permissions: SESSION_HOST_PERMISSIONS,
} as const;
