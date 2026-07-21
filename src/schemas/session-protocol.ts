import { z } from "zod";
import type * as SessionHostContract from "../daemon/session-host/contract";
import type * as TerminalHostContract from "../daemon/session-host/terminal-host-contract";

export const SESSION_PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const SESSION_PROTOCOL_MINOR_RANGE = {
  min: SESSION_PROTOCOL_VERSION.minor,
  max: SESSION_PROTOCOL_VERSION.minor,
} as const;

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
  inputTransactionBytes: 128 * 1024,
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
  INPUT_ORPHAN_DISCARD: 0x0118,
  ORPHAN_DISCARDED: 0x0119,
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
  INPUT_SUBMIT: 0x0305,
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
  { names: ["INPUT_ORPHAN_DISCARD", "ORPHAN_DISCARDED"], direction: "daemon-broker-host-bidirectional", purpose: "operator-orphaned-claim-discard" },
  { names: ["ATTACH_REQUEST", "ATTACH_GRANT", "HOST_ATTACH"], direction: "workspace-broker-host-bidirectional", purpose: "one-use-viewer-attach" },
  { names: ["SNAPSHOT_BEGIN", "SNAPSHOT_BYTES"], direction: "host-to-viewer", purpose: "checkpoint-stream" },
  { names: ["OUTPUT", "APPLIED"], direction: "host-viewer-bidirectional", purpose: "ordered-output-and-high-water" },
  { names: ["RESIZE", "DETACH", "EVENT"], direction: "bidirectional", purpose: "geometry-transport-detach-session-event" },
  { names: ["CLAIM_ACQUIRE", "CLAIM_RESULT"], direction: "viewer-host-bidirectional", purpose: "authoring-claim" },
  { names: ["HUMAN_INPUT", "CLAIM_RELEASE", "GESTURE_INPUT", "INPUT_SUBMIT"], direction: "viewer-to-host", purpose: "ordered-human-input" },
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
  "GENERATION_GONE",
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
export const Secret256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const TaggedSha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

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

const ProtocolMinorSchema = z.number().int().min(0).max(255);
const SelectedProtocolSchema = z.strictObject({
  major: z.literal(SESSION_PROTOCOL_VERSION.major),
  minor: ProtocolMinorSchema,
}).readonly();
const ProcessRootSchema = z.strictObject({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  processGroupId: z.number().int().positive(),
});

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
const SessionVisibilitySchema = z.strictObject({
  state: z.enum(["attaching", "visible", "reconnecting", "expired"]),
  workspaceSessionId: z.string().min(1),
  openTerminalRevision: DecimalUint64Schema,
  expiresAt: Rfc3339UtcMillisecondsSchema,
});

export const SessionInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locator: SessionLocatorSchema,
  presence: z.enum(["present", "exited", "lost", "unknown"]),
  complete: z.boolean(),
  hostPid: z.number().int().positive().nullable(),
  hostStartToken: z.string().min(1).nullable(),
  providerRoot: ProcessRootSchema.nullable(),
  expectedExecutable: z.string().min(1),
  executableVerified: z.boolean(),
  outputSeq: DecimalUint64Schema,
  checkpointSeq: DecimalUint64Schema,
  checkpointAvailable: z.boolean(),
  input: z.strictObject({
    // UNKNOWN is an observation-only value for hosts that cannot inspect an
    // arbiter. It is not a §22 arbiter state and the state machine never emits it.
    state: z.union([InputArbiterStateSchema, z.literal("UNKNOWN")]),
    ownerViewerId: z.string().min(1).nullable(),
    claimId: z.string().min(1).nullable(),
  }),
  viewerCount: z.number().int().min(0).max(TERMINAL_LIMITS.authenticatedViewersPerGeneration),
  geometry: TerminalGeometrySchema,
  resources: z.record(z.string(), z.number()).readonly(),
  visibility: SessionVisibilitySchema,
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

/** Frozen A0 terminal-host identity carried by direct-host control operations. */
export const TerminalHostSessionRefSchema = z.strictObject({
  key: z.string().min(1),
  incarnation: z.string().min(1),
}).readonly();
export const TerminalHostWindowSizeSchema = z.strictObject({
  columns: z.number().int().min(TERMINAL_LIMITS.terminalCellsPerDimensionMin)
    .max(TERMINAL_LIMITS.terminalCellsPerDimensionMax),
  rows: z.number().int().min(TERMINAL_LIMITS.terminalCellsPerDimensionMin)
    .max(TERMINAL_LIMITS.terminalCellsPerDimensionMax),
  widthPixels: z.number().int().nonnegative().max(65_535),
  heightPixels: z.number().int().nonnegative().max(65_535),
}).refine(
  ({ columns, rows }) => columns * rows <= TERMINAL_LIMITS.terminalActiveCellsMax,
  "active terminal cells exceed the v1 limit",
).meta({ "x-hive-max-active-cells": TERMINAL_LIMITS.terminalActiveCellsMax }).readonly();
const TerminalHostCompletenessSchema = z.enum(["complete", "partial", "unavailable", "unknown"]);
export const TerminalHostProcessIdentitySchema = z.strictObject({
  processId: z.number().int().positive(),
  startToken: z.string().min(1),
}).readonly();
export const TerminalHostTerminalProfileSchema = z.strictObject({
  inputMode: z.enum(["canonical", "literal"]),
  echo: z.boolean(),
  signalCharacters: z.boolean(),
  softwareFlowControl: z.boolean(),
  eofByte: z.number().int().min(0).max(255),
  startByte: z.number().int().min(0).max(255),
  stopByte: z.number().int().min(0).max(255),
  hangupOnLastClose: z.boolean(),
}).readonly();
export const TerminalHostEnvironmentEntrySchema = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
}).readonly();
export const TerminalHostTransferableHandleSchema = z.strictObject({
  token: z.string().min(1),
  sourceDisposition: z.enum(["retain", "close-after-transfer"]),
}).readonly();
export const TerminalHostDescriptorMappingSchema = z.strictObject({
  handle: TerminalHostTransferableHandleSchema,
  targetDescriptor: z.number().int().min(3),
}).readonly();
export const TerminalHostCommandSchema = z.strictObject({
  executable: z.string().min(1),
  arguments: z.array(z.string()).readonly(),
  workingDirectory: z.string().min(1),
  completeEnvironment: z.array(TerminalHostEnvironmentEntrySchema).readonly(),
  descriptorMap: z.array(TerminalHostDescriptorMappingSchema).readonly(),
}).readonly();
export const TerminalHostLimitsSchema = z.strictObject({
  maxInputTransactionBytes: SafeUintSchema,
  maxInputQueueBytes: SafeUintSchema,
  maxOutputFrameBytes: SafeUintSchema,
  outputLowWaterBytes: SafeUintSchema,
  outputHighWaterBytes: SafeUintSchema,
  outputRetentionBytes: SafeUintSchema,
}).readonly();
export const TerminalHostJobControlEvidenceSchema = z.strictObject({
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
}).readonly();
export const TerminalHostExitStatusSchema = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.number().int().nonnegative().nullable(),
  observedAt: Rfc3339UtcMillisecondsSchema,
}).readonly();
export const TerminalHostReapEvidenceSchema = z.strictObject({
  authority: z.enum(["direct-parent", "durable-parent-record", "unavailable"]),
  reaped: z.boolean(),
  status: TerminalHostExitStatusSchema.nullable(),
  completeness: TerminalHostCompletenessSchema,
}).readonly();
export const TerminalHostLaunchOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("running"),
    child: TerminalHostProcessIdentitySchema,
    execProof: z.literal("replacement-observed"),
    jobControl: TerminalHostJobControlEvidenceSchema,
  }).readonly(),
  z.strictObject({
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
  }).readonly(),
  z.strictObject({
    state: z.literal("exited"),
    exit: TerminalHostExitStatusSchema,
    reap: TerminalHostReapEvidenceSchema,
  }).readonly(),
  z.strictObject({ state: z.literal("unknown"), diagnostic: z.string().min(1) }).readonly(),
]);
export const TerminalHostCreateRequestSchema = z.strictObject({
  key: z.string().min(1),
  idempotencyKey: z.string().min(1),
  command: TerminalHostCommandSchema,
  terminalProfile: TerminalHostTerminalProfileSchema,
  initialWindow: TerminalHostWindowSizeSchema,
}).readonly();
export const TerminalHostCreateResultSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  outcome: TerminalHostLaunchOutcomeSchema,
  limits: TerminalHostLimitsSchema,
}).readonly();
export const TerminalHostInputClaimSchema = z.strictObject({
  token: z.string().min(1),
  writer: z.string().min(1),
  kind: z.enum(["human", "automation"]),
  leaseExpiresAt: Rfc3339UtcMillisecondsSchema,
}).readonly();
export const TerminalHostClaimResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("granted"), claim: TerminalHostInputClaimSchema }).readonly(),
  z.strictObject({
    state: z.literal("denied"),
    owner: TerminalHostInputClaimSchema.nullable(),
    diagnostic: z.string().min(1),
  }).readonly(),
  z.strictObject({ state: z.literal("unknown"), diagnostic: z.string().min(1) }).readonly(),
]);
export const TerminalHostInputReceiptSchema = z.strictObject({
  transactionId: z.string().min(1),
  stage: z.enum(["accepted", "queued", "written-to-terminal", "rejected", "unknown"]),
  byteRange: z.strictObject({
    start: DecimalUint64Schema,
    endExclusive: DecimalUint64Schema,
  }).readonly().nullable(),
  orderedAt: DecimalUint64Schema.nullable(),
  availableCreditBytes: SafeUintSchema,
  consumedByProcess: z.literal("not-claimed"),
  completeness: TerminalHostCompletenessSchema,
  diagnostic: z.string().min(1).nullable(),
}).readonly();
export const TerminalHostResizeResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("applied"),
    revision: DecimalUint64Schema,
    readback: TerminalHostWindowSizeSchema,
    orderedAt: DecimalUint64Schema,
    foregroundProcessObservation: z.literal("not-claimed"),
  }).readonly(),
  z.strictObject({ state: z.literal("stale"), currentRevision: DecimalUint64Schema }).readonly(),
  z.strictObject({ state: z.literal("unknown"), diagnostic: z.string().min(1) }).readonly(),
]);

export const BASE64_BYTES_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
const TerminalHostCheckpointBytesSchema = z.codec(
  z.string()
    .max(Math.ceil(TERMINAL_LIMITS.checkpointBytes / 3) * 4)
    .regex(new RegExp(BASE64_BYTES_PATTERN)),
  z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  {
    decode: (value) => new Uint8Array(Buffer.from(value, "base64")),
    encode: (value) => Buffer.from(value).toString("base64"),
  },
);
export const TerminalHostCheckpointSchema = z.strictObject({
  contentType: z.string().min(1),
  schemaVersion: z.string().min(1),
  hashAlgorithm: z.literal("sha256"),
  hash: z.string().min(1),
  throughEventSequence: DecimalUint64Schema,
  throughOutputOffset: DecimalUint64Schema,
  opaqueBytes: TerminalHostCheckpointBytesSchema,
}).readonly();
export const TerminalHostSessionInspectionSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  lifecycle: z.enum(["creating", "running", "exited", "lost", "unknown"]),
  completeness: TerminalHostCompletenessSchema,
  host: TerminalHostProcessIdentitySchema.nullable(),
  child: TerminalHostProcessIdentitySchema.nullable(),
  jobControl: TerminalHostJobControlEvidenceSchema.nullable(),
  window: z.strictObject({
    value: TerminalHostWindowSizeSchema,
    revision: DecimalUint64Schema,
  }).readonly(),
  output: z.strictObject({
    closed: z.boolean(),
    retained: z.strictObject({
      start: DecimalUint64Schema,
      endExclusive: DecimalUint64Schema,
    }).readonly(),
  }).readonly(),
  checkpoints: z.strictObject({
    retained: SafeUintSchema,
    newest: TerminalHostCheckpointSchema.nullable(),
  }).readonly(),
  inputOwner: TerminalHostInputClaimSchema.nullable(),
  exit: TerminalHostExitStatusSchema.nullable(),
  reap: TerminalHostReapEvidenceSchema,
  descendants: z.array(TerminalHostProcessIdentitySchema).readonly(),
  survivors: z.array(z.strictObject({
    process: TerminalHostProcessIdentitySchema,
    reason: z.string(),
  }).readonly()).readonly(),
  evidenceAt: Rfc3339UtcMillisecondsSchema,
  diagnostics: z.array(z.string()).readonly(),
}).readonly();
export const TerminalHostTerminationRequestSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  mode: z.enum(["graceful", "immediate"]),
  target: z.enum(["foreground-group", "session-members", "process-tree"]),
  deadline: Rfc3339UtcMillisecondsSchema,
  idempotencyKey: z.string().min(1),
}).readonly();
export const TerminalHostTerminationResultSchema = z.strictObject({
  state: z.enum(["terminated", "survivors", "unknown"]),
  exit: TerminalHostExitStatusSchema.nullable(),
  reap: TerminalHostReapEvidenceSchema,
  survivors: z.array(z.strictObject({
    process: TerminalHostProcessIdentitySchema,
    reason: z.string(),
  }).readonly()).readonly(),
  completeness: TerminalHostCompletenessSchema,
  diagnostics: z.array(z.string()).readonly(),
}).readonly();
/** §5 ordered resize, neutral projection. The revision is monotonic and the
 * idempotency key makes a repeat of the same transaction replay its receipt
 * rather than mutate a second time. */
export const TerminalHostResizeRequestSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  window: TerminalHostWindowSizeSchema,
  revision: DecimalUint64Schema,
  idempotencyKey: z.string().min(1),
}).readonly();
/** §5 applied receipt. `window` is what the terminal reported AFTER the set,
 * not what was asked for, and `orderedAt` is the receipt's position in the
 * session mutation order it shares with input. There is deliberately no field
 * claiming the foreground application handled its resize notification: the
 * host cannot observe that, so the projection must not be able to say it. */
export const TerminalHostResizeReceiptSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  revision: DecimalUint64Schema,
  orderedAt: DecimalUint64Schema,
  window: TerminalHostWindowSizeSchema,
}).readonly();
/** §7 checkpoint capability. A caller that cannot apply a checkpoint offers
 * none, so this is the unit of the checkpoint half of attach negotiation and
 * names the same pair a checkpoint document carries. */
export const TerminalHostCheckpointCapabilitySchema = z.strictObject({
  contentType: z.string().min(1),
  schemaVersion: z.string().min(1),
}).readonly();
/** §7 attachment cursor. It names BOTH positions in the one session order — an
 * event position and an output byte offset — so a resumed attachment and the
 * events around it stay comparable without a second clock, and it MAY bind an
 * opaque checkpoint identity: the hash of the checkpoint the caller has already
 * applied, or null when it has applied none. The identity is opaque here on
 * purpose — attach compares it, it never interprets it. */
export const TerminalHostAttachCursorSchema = z.strictObject({
  eventSequence: DecimalUint64Schema,
  outputOffset: DecimalUint64Schema,
  checkpoint: z.string().min(1).nullable(),
}).readonly();
/** §7 attach request. It offers a same-major protocol minor range and the
 * checkpoint capabilities the caller can apply; the host selects one of each,
 * which is what makes attachment negotiated rather than assumed. */
export const TerminalHostAttachRequestSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  protocol: z.strictObject({
    major: z.literal(SESSION_PROTOCOL_VERSION.major),
    minMinor: ProtocolMinorSchema,
    maxMinor: ProtocolMinorSchema,
  }).refine(({ minMinor, maxMinor }) => minMinor <= maxMinor, "protocol minor range is reversed")
    .meta({ "x-hive-ordered-minor-range": true }).readonly(),
  checkpointCapabilities: z.array(TerminalHostCheckpointCapabilitySchema).readonly(),
  cursor: TerminalHostAttachCursorSchema,
}).readonly();
/** §7 attach outcome. `resumeFrom` is where the stream WILL resume, reported by
 * the host rather than assumed from the cursor that was asked for — the same
 * readback rule the resize receipt follows. There is deliberately no field for
 * a partially delivered escape sequence or a split multibyte character: resume
 * is exactly-once at byte boundaries, so no shape here can excuse resuming
 * inside one. A cursor outside retention is a `gap` that states the missing
 * range and requires a full checkpoint; silent loss has no encoding. */
export const TerminalHostAttachResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("attached"),
    session: TerminalHostSessionRefSchema,
    protocol: SelectedProtocolSchema,
    checkpoint: TerminalHostCheckpointCapabilitySchema.nullable(),
    resumeFrom: TerminalHostAttachCursorSchema,
  }).readonly(),
  z.strictObject({
    state: z.literal("gap"),
    session: TerminalHostSessionRefSchema,
    missing: z.strictObject({
      start: DecimalUint64Schema,
      endExclusive: DecimalUint64Schema,
    }).readonly(),
    checkpointRequirement: z.literal("full"),
  }).readonly(),
  z.strictObject({ state: z.literal("unknown"), diagnostic: z.string().min(1) }).readonly(),
]);
/** §11 event flow-control limits, negotiated on the same terms as output (§6).
 * Retained events are bounded and released by acknowledgement; these are the
 * concrete caps and watermarks the behavioral contract deliberately leaves to
 * the wire. Events are counted rather than measured, so the retention and
 * acknowledgement bounds are event counts and one is a byte cap on a single
 * delivered event. */
export const TerminalHostSubscriptionLimitsSchema = z.strictObject({
  maxEventFrameBytes: SafeUintSchema,
  retainedEventCount: SafeUintSchema,
  unacknowledgedEventLowWater: SafeUintSchema,
  unacknowledgedEventHighWater: SafeUintSchema,
}).readonly();
/** §11 subscription cursor. It names both positions in the one session order —
 * an event position and the output offset beside it — so a delivered event and
 * the output around it stay comparable without a second clock. */
export const TerminalHostSubscriptionCursorSchema = z.strictObject({
  eventSequence: DecimalUint64Schema,
  outputOffset: DecimalUint64Schema,
}).readonly();
/** §11 subscribe request. A subscription is a resumable cursor, not a boolean:
 * it negotiates a same-major minor range and event flow-control limits, and
 * begins either at a caller-supplied event position or at the current end. */
export const TerminalHostSubscribeRequestSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  protocol: z.strictObject({
    major: z.literal(SESSION_PROTOCOL_VERSION.major),
    minMinor: ProtocolMinorSchema,
    maxMinor: ProtocolMinorSchema,
  }).refine(({ minMinor, maxMinor }) => minMinor <= maxMinor, "protocol minor range is reversed")
    .meta({ "x-hive-ordered-minor-range": true }).readonly(),
  limits: TerminalHostSubscriptionLimitsSchema,
  from: z.discriminatedUnion("position", [
    z.strictObject({
      position: z.literal("at"),
      cursor: TerminalHostSubscriptionCursorSchema,
    }).readonly(),
    z.strictObject({ position: z.literal("end") }).readonly(),
  ]),
}).readonly();
/** §11 subscribe outcome. `resumeFrom` is where delivery WILL begin, reported by
 * the host rather than echoed from the request — the same readback rule attach
 * and the resize receipt follow. A cursor outside retention is a `gap` that
 * states the missing event range and requires a fresh inspection; silent loss
 * has no encoding. A subscription is never evidence that the session itself
 * changed, so the outcome carries no field that could assert it did. */
export const TerminalHostSubscribeResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("subscribed"),
    session: TerminalHostSessionRefSchema,
    protocol: SelectedProtocolSchema,
    limits: TerminalHostSubscriptionLimitsSchema,
    resumeFrom: TerminalHostSubscriptionCursorSchema,
  }).readonly(),
  z.strictObject({
    state: z.literal("gap"),
    session: TerminalHostSessionRefSchema,
    missing: z.strictObject({
      start: DecimalUint64Schema,
      endExclusive: DecimalUint64Schema,
    }).readonly(),
    freshInspection: z.literal("required"),
  }).readonly(),
  z.strictObject({ state: z.literal("unknown"), diagnostic: z.string().min(1) }).readonly(),
]);
/** An inventory revision is strictly positive; zero and any leading zero are
 * noncanonical and fail before the guarded operation runs. Same canonical
 * pattern the status spine uses, so the native validator rejects both. */
const PositiveDecimalUint64Schema = z.string()
  .regex(/^(?:[1-9][0-9]{0,19})$/)
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "must fit in an unsigned 64-bit integer",
  ).meta({ format: "hive-uint64-decimal" });
/** Visibility extension §Boundary. The complete neutral evidence a source
 * offers: one source-session identity, its EXACT live process identity, and the
 * current positive inventory revision. A PID by itself is never identity, so
 * the process carries the operating-system-derived start token that makes PID
 * reuse detectable. Possession of a socket, renderer traffic, a heartbeat, or a
 * saved snapshot is not evidence, and none of them has a field here. */
export const TerminalHostVisibilityRequestSchema = z.strictObject({
  sourceSession: z.string().min(1),
  sourceProcess: TerminalHostProcessIdentitySchema,
  inventoryRevision: PositiveDecimalUint64Schema,
}).readonly();
/** Visibility extension §Normative vocabulary. A lease binds the host-issued
 * exact session reference, the ACCEPTED source identity, and the ACCEPTED
 * revision, and is active only between `issuedAt` and a finite `expiresAt`. */
export const TerminalHostVisibilityLeaseSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  sourceSession: z.string().min(1),
  sourceProcess: TerminalHostProcessIdentitySchema,
  inventoryRevision: PositiveDecimalUint64Schema,
  state: z.literal("active"),
  issuedAt: Rfc3339UtcMillisecondsSchema,
  expiresAt: Rfc3339UtcMillisecondsSchema,
}).refine(
  ({ issuedAt, expiresAt }) => issuedAt < expiresAt,
  "an active lease must expire strictly after it was issued",
  // A lease is active only BETWEEN its timestamps, so an `active` document whose
  // deadline does not follow its issue instant describes a window it could never
  // have been active in. Both stamps are UTC with fixed millisecond precision and
  // no offset, so byte order is chronological order and the native validator can
  // enforce this with the same comparison.
).meta({ "x-hive-ordered-lease-window": true }).readonly();
/** Visibility extension §3 renewal request. It names the exact session
 * reference and repeats the COMPLETE visibility request — renewal re-proves
 * current representation rather than trusting the lease it already holds. */
export const TerminalHostVisibilityRenewalRequestSchema = z.strictObject({
  session: TerminalHostSessionRefSchema,
  visibility: TerminalHostVisibilityRequestSchema,
}).readonly();
/** Visibility extension §3/§5 renewal outcome. Success returns a NEW active
 * lease with a finite expiry. A rejection carries exactly one typed reason from
 * the closed §5 list and no lease: it does not extend the deadline, and — the
 * expired case aside — it never pretends the prior lease or process vanished,
 * because the existing bounded deadline stays authoritative. Partial or
 * unavailable evidence is `unknown`, never absence, rejection, or success. */
export const TerminalHostVisibilityRenewalResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("active"),
    renewed: z.literal(true),
    lease: TerminalHostVisibilityLeaseSchema,
  }).readonly(),
  z.strictObject({
    state: z.literal("rejected"),
    // §3 names this field: a rejected or unknown renewal HAS `renewed: false`.
    // Carrying it as a literal rather than leaving it implied in the
    // discriminator means a consumer that reads the field without switching on
    // the state still cannot read a rejection as a renewal.
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
  }).readonly(),
  z.strictObject({
    state: z.literal("unknown"),
    renewed: z.literal(false),
    diagnostic: z.string().min(1),
  }).readonly(),
]);

const EncodedInputBytesSchema = z.string()
  .max(Math.ceil(TERMINAL_LIMITS.inputTransactionBytes / 3) * 4)
  .regex(new RegExp(BASE64_BYTES_PATTERN));

/** Strict wire projection of frozen A0 claimInput. */
export const ClaimAcquirePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: TerminalHostSessionRefSchema,
  writer: z.string().min(1),
  kind: z.enum(["human", "automation"]),
  leaseMilliseconds: SafeUintSchema.min(1),
  idempotencyKey: z.string().min(1),
}).readonly();
export const ClaimResultPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  result: TerminalHostClaimResultSchema,
}).readonly();

/** INPUT_SUBMIT is JSON control; raw HUMAN_INPUT remains keystroke streaming. */
export const InputSubmitPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: TerminalHostSessionRefSchema,
  claimToken: z.string().min(1),
  transactionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  operation: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("bytes"),
      encoding: z.literal("base64"),
      bytes: EncodedInputBytesSchema,
    }).readonly(),
    z.strictObject({ kind: z.literal("canonical-end-of-file") }).readonly(),
    z.strictObject({ kind: z.literal("hangup") }).readonly(),
  ]),
}).readonly();

/** Strict wire projection of frozen A0 resize. */
export const ResizePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: TerminalHostSessionRefSchema,
  window: TerminalHostWindowSizeSchema,
  revision: DecimalUint64Schema,
  idempotencyKey: z.string().min(1),
}).readonly();

/** Correlated result union shared by INPUT_SUBMIT and RESIZE, plus the §20
 * viewer→host ordered-output high-water acknowledgement (B2.2). */
export const AppliedPayloadSchema = z.discriminatedUnion("resultKind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    resultKind: z.literal("input"),
    receipt: TerminalHostInputReceiptSchema,
  }).readonly(),
  z.strictObject({
    schemaVersion: z.literal(1),
    resultKind: z.literal("resize"),
    result: TerminalHostResizeResultSchema,
  }).readonly(),
  z.strictObject({
    schemaVersion: z.literal(1),
    resultKind: z.literal("output"),
    /** Exclusive contiguous OUTPUT byte high-water the viewer has applied. */
    throughSeq: DecimalUint64Schema,
  }).readonly(),
]);
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
  /** Domain idempotency key (`req_…`), distinct from the uint64 frame-header correlation requestId. */
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

const HelloCommonShape = {
  /** §20 HELLO carries schemaVersion; the v1 shape fixes it to 1. */
  schemaVersion: z.literal(1),
  /** §20 HELLO names the peer build hash; shape adjudicated as buildId. */
  buildId: z.string().min(1),
  /** §20 HELLO names the Hive instance. */
  instanceId: z.string().min(1),
  /** §20 HELLO names a same-major minor range; shape adjudicated as min/max minor. */
  protocol: z.strictObject({
    major: z.literal(SESSION_PROTOCOL_VERSION.major),
    minMinor: ProtocolMinorSchema,
    maxMinor: ProtocolMinorSchema,
  }).refine(({ minMinor, maxMinor }) => minMinor <= maxMinor, "protocol minor range is reversed")
    .meta({ "x-hive-ordered-minor-range": true }).readonly(),
};
const DaemonControlIdentitySchema = z.strictObject({
  /** src/daemon/handshake.ts DaemonHandshake.productVersion; source checkouts use HIVE_VERSION's 0.0.0-dev fallback. */
  productVersion: z.string().min(1),
  /** src/daemon/handshake.ts DaemonHandshake.buildHash; source checkouts carry currentBuildHash(). */
  buildHash: z.string().min(1),
  /** src/daemon/handshake.ts DaemonHandshake.wireProtocol and handshakeMismatch's overlapping-range comparison. */
  wireProtocol: z.strictObject({
    min: z.number(),
    max: z.number(),
  }).refine(({ min, max }) => min <= max, "daemon wire protocol range is reversed").readonly(),
  /** src/daemon/handshake.ts DaemonHandshake.schemaEpoch is §21's schema identity today; §27 hashes extend both later. */
  schemaEpoch: z.number(),
  /** src/daemon/handshake.ts DaemonHandshake.instanceId. */
  instanceId: z.string().min(1),
  /** src/daemon/handshake.ts handshakeMismatch treats HiveUUID as project identity. */
  hiveUuid: z.string().min(1),
  /** src/daemon/handshake.ts handshakeMismatch treats identityKey as project identity. */
  identityKey: z.string().min(1),
  /** src/daemon/handshake.ts handshakeMismatch treats repository family as project identity when present. */
  repoFamilyKey: z.string().min(1).nullable(),
}).readonly();

export const HelloPayloadSchema = z.discriminatedUnion("clientRole", [
  z.strictObject({
    ...HelloCommonShape,
    /** §20/§21 connect a viewer; shape adjudicated to the four connecting roles. */
    clientRole: z.literal("viewer"),
    /** §20 permits a presented grant; shape adjudicated as optional only for viewers. */
    grantToken: z.string().min(1).optional(),
  }),
  z.strictObject({
    ...HelloCommonShape,
    /** §21 authenticates daemon control against kernel identity and the existing daemon handshake. */
    clientRole: z.literal("daemon"),
    /** §21's six-way daemon comparison, using the existing handshake's exact field names and semantics. */
    daemonControl: DaemonControlIdentitySchema,
  }),
  z.strictObject({
    ...HelloCommonShape,
    /** §20/§21 authenticate broker peers by kernel credentials; they cannot present grants. */
    clientRole: z.literal("broker"),
  }),
  z.strictObject({
    ...HelloCommonShape,
    /** §20/§21 authenticate host peers by kernel credentials; they cannot present grants. */
    clientRole: z.literal("host"),
  }),
]).readonly();

export const WelcomePayloadSchema = z.strictObject({
  /** §20 WELCOME is a v1 control payload. */
  schemaVersion: z.literal(1),
  /** §20 WELCOME returns the selected version. */
  protocol: SelectedProtocolSchema,
  /** §20 WELCOME returns the endpoint instance ID. */
  instanceId: z.string().min(1),
  /** §20 WELCOME names the endpoint; shape adjudicated to broker or host. */
  endpointRole: z.enum(["broker", "host"]),
  /** §20 WELCOME returns the endpoint build ID. */
  buildId: z.string().min(1),
  /** §20 WELCOME returns an engine ID; shape adjudicated nullable until bound. */
  engineBuildId: z.string().min(1).nullable(),
  /** §20 WELCOME returns a connection ID; shape adjudicated as decimal uint64. */
  connectionId: DecimalUint64Schema,
  /** §20 WELCOME returns a monotonic server epoch; shape adjudicated as decimal nanos. */
  serverEpoch: DecimalUint64Schema,
  /** §20 returns limits; shape adjudicated to the four §18 negotiated transport caps. */
  limits: z.strictObject({
    controlFrameMaxBytes: z.number().int().positive().max(TERMINAL_LIMITS.controlJsonBytesPerFrame),
    maxInputTransactionBytes: z.number().int().positive().max(TERMINAL_LIMITS.inputTransactionBytes),
    streamChunkMaxBytes: z.number().int().positive().max(TERMINAL_LIMITS.streamChunkBytes),
    automatedMessageMaxBytes: z.number().int().positive().max(TERMINAL_LIMITS.automatedMessageBytes),
    viewerQueueMaxBytes: z.number().int().positive().max(TERMINAL_LIMITS.viewerUnacknowledgedOutputBytes),
  }).readonly(),
}).readonly();

export const ErrorPayloadSchema = z.strictObject({
  /** §20 ERROR is a v1 control payload. */
  schemaVersion: z.literal(1),
  /** §20 ERROR carries one typed code from the normative error table. */
  code: WireErrorCodeSchema,
  /** §20 error meanings are surfaced as a nonempty redacted message. */
  message: z.string().min(1),
  /** §20 INTERNAL and verification failures may carry a diagnostic ID. */
  diagnosticId: z.string().min(1).nullable(),
}).readonly();

export const PingPongPayloadSchema = z.strictObject({
  /** §20 PING/PONG are v1 control payloads. */
  schemaVersion: z.literal(1),
  /** §20 PING/PONG carry sender monotonic nanos; §18 encodes uint64 as decimal text. */
  monoNanos: DecimalUint64Schema,
}).readonly();

const HostRecordProjectionSchema = z.strictObject({
  /** §21 adoption compares the exact locator. */
  locator: SessionLocatorSchema,
  /** §21 launch/adoption readback includes host PID. */
  hostPid: z.number().int().positive(),
  /** §21 launch/adoption readback includes the PID start token. */
  hostStartToken: z.string().min(1),
  /** §21 launch/adoption readback includes the process root. */
  processRoot: ProcessRootSchema,
  /** §21 launch/adoption readback includes the expected executable. */
  expectedExecutable: z.string().min(1),
  /** §21 launch/adoption compares the executable build. */
  executableBuildHash: z.string().min(1),
  /** §21 launch/adoption compares the engine build. */
  engineBuildId: z.string().min(1),
  /** §21 launch/adoption compares protocol major/minor. */
  protocol: SelectedProtocolSchema,
  /** §21 launch readback includes terminal geometry. */
  geometry: TerminalGeometrySchema,
  /** §21 HostRecordV1 preserves exact lifecycle state. */
  state: z.enum(["starting", "live", "exited", "unknown"]),
  /** §21 launch/adoption compares the exclusive output sequence. */
  outputSeq: DecimalUint64Schema,
  /** §21 HostRecordV1 preserves the newest checkpoint sequence. */
  checkpointSeq: DecimalUint64Schema,
  /** §19/§21 launch readback proves the initial attaching visibility lease. */
  visibility: SessionVisibilitySchema,
}).readonly();

/** §21 HostRecordV1 is the complete strict on-disk recovery record. */
export const HostRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ...HostRecordProjectionSchema.unwrap().shape,
  socketRelativePath: z.literal("host.sock"),
  createdAt: Rfc3339UtcMillisecondsSchema,
}).readonly();

export const HostRegisterPayloadSchema = z.union([
  z.strictObject({
    /** §21 host launch registration is a v1 control payload. */
    schemaVersion: z.literal(1),
    /** §21 launch readback projects the listed HostRecordV1 identity/evidence fields. */
    record: HostRecordProjectionSchema,
  }),
  z.strictObject({
    /** §21 registration response is a v1 control payload. */
    schemaVersion: z.literal(1),
    /** §21 publication follows exact readback; shape adjudicated as accepted=true. */
    accepted: z.literal(true),
  }),
]).readonly();

export const HostAdoptPayloadSchema = z.union([
  z.strictObject({
    /** §21 broker adoption challenge is a v1 control payload. */
    schemaVersion: z.literal(1),
    /** §21 challenges with the 32-byte secret; shape adjudicated as 64 lowercase hex. */
    adoptionSecretHex: Secret256HexSchema,
    /** §21 challenges the recorded exact locator. */
    expectedLocator: SessionLocatorSchema,
    /** §21 host validates the broker build. */
    brokerBuildId: z.string().min(1),
    /** §21 host validates broker protocol. */
    protocol: SelectedProtocolSchema,
    /** §21 permits only adoption on this challenge; shape adjudicated as a literal. */
    operation: z.literal("adopt"),
  }),
  z.strictObject({
    /** §21 adoption readback is a v1 control payload. */
    schemaVersion: z.literal(1),
    /** §21 adoption compares the exact locator. */
    locator: SessionLocatorSchema,
    /** §21 adoption compares host PID. */
    hostPid: z.number().int().positive(),
    /** §21 adoption compares the host PID start token. */
    hostStartToken: z.string().min(1),
    /** §21 adoption compares the live executable path. */
    executable: z.string().min(1),
    /** §21 adoption compares the executable build. */
    executableBuildHash: z.string().min(1),
    /** §21 adoption compares the engine build. */
    engineBuildId: z.string().min(1),
    /** §21 adoption compares the host-selected protocol, not the broker's offered constants. */
    protocol: SelectedProtocolSchema,
    /** §21 adoption compares the process root. */
    processRoot: ProcessRootSchema,
    /** §21 adoption compares the output sequence. */
    outputSeq: DecimalUint64Schema,
    /** §21 readback preserves checkpoint high-water evidence. */
    checkpointSeq: DecimalUint64Schema,
    /** §21 adoption verifies the current Workspace open-terminal revision. */
    visibility: SessionVisibilitySchema,
  }),
]).readonly();

export const GrantRegisterPayloadSchema = z.union([
  z.strictObject({
    /** §21 one-use viewer grant registration is a v1 control payload. */
    schemaVersion: z.literal(1),
    /** §21 stores only the 256-bit hash; shape adjudicated as sha256: plus lowercase hex. */
    grantTokenSha256: TaggedSha256Schema,
    /** §19 issueAttach binds a grant to the exact viewer identity. */
    viewerId: z.string().min(1),
    /** §19 issueAttach binds the granted operations. */
    operations: z.array(z.enum(["view", "human-input", "resize"])).readonly(),
    /** §18/§21 expire unused attach grants after 30 seconds. */
    expiresAt: Rfc3339UtcMillisecondsSchema,
    /** §19 issueAttach binds the requested terminal geometry. */
    geometry: TerminalGeometrySchema,
  }),
  z.strictObject({
    /** §21 grant registration response is a v1 control payload. */
    schemaVersion: z.literal(1),
    /** §21 registration succeeds only after the host stores the hash; shape adjudicated true. */
    registered: z.literal(true),
  }),
]).readonly();

/** §19/§20 CREATE_BEGIN is the strict wire projection of SessionSpec. */
export const CreateBeginPayloadSchema = z.strictObject({
  ...SessionSpecSchema.unwrap().shape,
  /** §19 create consumes the daemon's just-revalidated pending open-terminal binding. */
  visibility: VisibilityRequestSchema,
}).refine(
  ({ visibility }) => BigInt(visibility.openTerminalRevision) > 0n,
  "create visibility revision must be positive",
).meta({ "x-hive-positive-open-terminal-revision": "visibility" }).readonly();
/** §20 CREATE_COMMIT authenticates the bounded initial-input byte stream. */
export const CreateCommitPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  totalLength: SafeUintSchema.max(TERMINAL_LIMITS.automatedMessageBytes),
  sha256: Sha256HexSchema,
}).readonly();
/** §19/§20 CREATED is the strict wire projection of CreateResult. */
export const CreatedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...CreateResultSchema.unwrap().shape,
}).readonly();
/** Frozen A0 list is deliberately unscoped; Hive filtering lives in the adapter. */
export const ListPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
}).readonly();
/** LISTED carries the exact frozen A0 inspection shape for every live host record. */
export const ListedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(TerminalHostSessionInspectionSchema).readonly(),
}).readonly();
/** Frozen A0 INSPECT names one neutral session incarnation. */
export const InspectPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: TerminalHostSessionRefSchema,
}).readonly();
/** INSPECTED is the strict wire projection of frozen A0 SessionInspection. */
export const InspectedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...TerminalHostSessionInspectionSchema.unwrap().shape,
}).readonly();
/** TERMINATE projects the complete frozen A0 termination request. */
export const TerminatePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...TerminalHostTerminationRequestSchema.unwrap().shape,
}).readonly();
/** TERMINATED is the strict wire projection of frozen A0 TerminationResult. */
export const TerminatedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...TerminalHostTerminationResultSchema.unwrap().shape,
}).readonly();
/** §19/§20 VISIBILITY_RENEW combines the exact locator with VisibilityRequest. */
export const VisibilityRenewPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locator: SessionLocatorSchema,
  ...VisibilityRequestSchema.unwrap().shape,
}).readonly();
/** §19/§20 RENEWED is the strict wire projection of VisibilityLease. */
export const RenewedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...VisibilityLeaseSchema.unwrap().shape,
}).readonly();
/** §22 INPUT_ORPHAN_DISCARD: an authenticated delivery-time resolution of a
 * human input claim. `orphaned` destroys only an abandoned draft; `held` is
 * the explicitly authorized M1 fleet-unwedging preemption of a live draft. */
export const OrphanDiscardPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locator: SessionLocatorSchema,
  mode: z.enum(["orphaned", "held"]),
}).readonly();
/** §22 ORPHAN_DISCARDED is deliberately a discriminated result: consumers
 * cannot flatten a destructive preemption into an ordinary orphan discard. */
export const OrphanDiscardedPayloadSchema = z.discriminatedUnion("state", [
  z.strictObject({
    schemaVersion: z.literal(1),
    state: z.literal("discarded"),
    priorOwnerViewerId: z.string().min(1),
    priorClaimId: z.string().min(1),
    orphanAgeMilliseconds: DecimalUint64Schema,
    diagnostic: z.string().min(1),
  }).readonly(),
  z.strictObject({
    schemaVersion: z.literal(1),
    state: z.literal("preempted"),
    priorOwnerViewerId: z.string().min(1),
    priorClaimId: z.string().min(1),
    orphanAgeMilliseconds: z.null(),
    diagnostic: z.string().min(1),
  }).readonly(),
  z.strictObject({
    schemaVersion: z.literal(1),
    state: z.literal("refused"),
    priorOwnerViewerId: z.string().min(1).nullable(),
    priorClaimId: z.string().min(1).nullable(),
    orphanAgeMilliseconds: DecimalUint64Schema.nullable(),
    diagnostic: z.string().min(1),
  }).readonly(),
]).readonly();
/** §19/§20 ATTACH_REQUEST combines the exact locator with AttachRequest. */
export const AttachRequestPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locator: SessionLocatorSchema,
  ...AttachRequestSchema.unwrap().shape,
}).readonly();
/** §19/§20 ATTACH_GRANT is the strict wire projection of AttachGrant. */
export const AttachGrantPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...AttachGrantSchema.unwrap().shape,
}).readonly();
/** §09/§20 HOST_ATTACH presents the one-use token and replay starting point. */
export const HostAttachPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locator: SessionLocatorSchema,
  token: z.string().min(1),
  geometry: TerminalGeometrySchema,
  afterSeq: DecimalUint64Schema,
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
  helloPayload: HelloPayloadSchema,
  welcomePayload: WelcomePayloadSchema,
  errorPayload: ErrorPayloadSchema,
  pingPongPayload: PingPongPayloadSchema,
  hostRegisterPayload: HostRegisterPayloadSchema,
  hostAdoptPayload: HostAdoptPayloadSchema,
  grantRegisterPayload: GrantRegisterPayloadSchema,
  hostRecordV1: HostRecordV1Schema,
  createBeginPayload: CreateBeginPayloadSchema,
  createCommitPayload: CreateCommitPayloadSchema,
  createdPayload: CreatedPayloadSchema,
  listPayload: ListPayloadSchema,
  listedPayload: ListedPayloadSchema,
  inspectPayload: InspectPayloadSchema,
  inspectedPayload: InspectedPayloadSchema,
  terminatePayload: TerminatePayloadSchema,
  terminatedPayload: TerminatedPayloadSchema,
  visibilityRenewPayload: VisibilityRenewPayloadSchema,
  renewedPayload: RenewedPayloadSchema,
  orphanDiscardPayload: OrphanDiscardPayloadSchema,
  orphanDiscardedPayload: OrphanDiscardedPayloadSchema,
  attachRequestPayload: AttachRequestPayloadSchema,
  attachGrantPayload: AttachGrantPayloadSchema,
  hostAttachPayload: HostAttachPayloadSchema,
  claimAcquirePayload: ClaimAcquirePayloadSchema,
  claimResultPayload: ClaimResultPayloadSchema,
  inputSubmitPayload: InputSubmitPayloadSchema,
  resizePayload: ResizePayloadSchema,
  appliedPayload: AppliedPayloadSchema,
  terminalHostCreateRequest: TerminalHostCreateRequestSchema,
  terminalHostCreateResult: TerminalHostCreateResultSchema,
  terminalHostCheckpoint: TerminalHostCheckpointSchema,
  terminalHostSessionInspection: TerminalHostSessionInspectionSchema,
  terminalHostTerminationRequest: TerminalHostTerminationRequestSchema,
  terminalHostTerminationResult: TerminalHostTerminationResultSchema,
  terminalHostResizeRequest: TerminalHostResizeRequestSchema,
  terminalHostResizeReceipt: TerminalHostResizeReceiptSchema,
  terminalHostAttachRequest: TerminalHostAttachRequestSchema,
  terminalHostAttachResult: TerminalHostAttachResultSchema,
  terminalHostSubscribeRequest: TerminalHostSubscribeRequestSchema,
  terminalHostSubscribeResult: TerminalHostSubscribeResultSchema,
  terminalHostVisibilityRenewalRequest: TerminalHostVisibilityRenewalRequestSchema,
  terminalHostVisibilityRenewalResult: TerminalHostVisibilityRenewalResultSchema,
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

// The §20 transport-only payload schemas above have no §19 SessionHost
// counterparts and are intentionally exempt from these Equals assertions.

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
type TerminalHostSessionRefSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostSessionRefSchema>, TerminalHostContract.SessionRef>>;
type TerminalHostWindowSizeSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostWindowSizeSchema>, TerminalHostContract.WindowSize>>;
type TerminalHostProcessIdentitySchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostProcessIdentitySchema>, TerminalHostContract.ProcessIdentity>>;
type TerminalHostTerminalProfileSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostTerminalProfileSchema>, TerminalHostContract.TerminalProfile>>;
type TerminalHostEnvironmentEntrySchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostEnvironmentEntrySchema>, TerminalHostContract.EnvironmentEntry>>;
type TerminalHostTransferableHandleSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostTransferableHandleSchema>, TerminalHostContract.TransferableHandle>>;
type TerminalHostDescriptorMappingSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostDescriptorMappingSchema>, TerminalHostContract.DescriptorMapping>>;
type TerminalHostCommandSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostCommandSchema>, TerminalHostContract.Command>>;
type TerminalHostLimitsSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostLimitsSchema>, TerminalHostContract.HostLimits>>;
type TerminalHostJobControlEvidenceSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostJobControlEvidenceSchema>, TerminalHostContract.JobControlEvidence>>;
type TerminalHostExitStatusSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostExitStatusSchema>, TerminalHostContract.ExitStatus>>;
type TerminalHostReapEvidenceSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostReapEvidenceSchema>, TerminalHostContract.ReapEvidence>>;
type TerminalHostLaunchOutcomeSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostLaunchOutcomeSchema>, TerminalHostContract.LaunchOutcome>>;
type TerminalHostCreateRequestSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostCreateRequestSchema>, TerminalHostContract.CreateRequest>>;
type TerminalHostCreateResultSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostCreateResultSchema>, TerminalHostContract.CreateResult>>;
type TerminalHostInputClaimSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostInputClaimSchema>, TerminalHostContract.InputClaim>>;
type TerminalHostClaimResultSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostClaimResultSchema>, TerminalHostContract.ClaimResult>>;
type TerminalHostInputReceiptSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostInputReceiptSchema>, TerminalHostContract.InputReceipt>>;
type TerminalHostResizeResultSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostResizeResultSchema>, TerminalHostContract.ResizeResult>>;
type TerminalHostCheckpointSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostCheckpointSchema>, TerminalHostContract.Checkpoint>>;
type TerminalHostSessionInspectionSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostSessionInspectionSchema>, TerminalHostContract.SessionInspection>>;
type TerminalHostTerminationRequestSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostTerminationRequestSchema>, Parameters<TerminalHostContract.TerminalHost["terminate"]>[0]>>;
type TerminalHostTerminationResultSchemaMatchesContract = Assert<Equals<z.infer<typeof TerminalHostTerminationResultSchema>, TerminalHostContract.TerminationResult>>;
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
