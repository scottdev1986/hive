import {
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPES,
  RAW_BYTE_FRAME_TYPES,
  SESSION_PROTOCOL_MINOR_RANGE,
  SESSION_PROTOCOL_VERSION,
  TERMINAL_LIMITS,
  type FrameTypeName,
} from "../../src/schemas/session-protocol";
import type { WorkspaceEventV2 } from "../../src/schemas/status-envelope";

export const FIXTURE_TIME = "2026-07-16T12:00:00.000Z";
export const FIXTURE_IDS = {
  assignment: "asg_018f1e90-7b5a-7cc0-8000-000000000000",
  session: "ses_018f1e90-7b5a-7cc0-8000-000000000001",
  transaction: "txn_018f1e90-7b5a-7cc0-8000-000000000002",
  message: "msg_018f1e90-7b5a-7cc0-8000-000000000003",
  request: "req_018f1e90-7b5a-7cc0-8000-000000000004",
  events: [
    "evt_018f1e90-7b5a-7cc0-8000-000000000005",
    "evt_018f1e90-7b5a-7cc0-8000-000000000006",
    "evt_018f1e90-7b5a-7cc0-8000-000000000007",
  ],
} as const;

export const fixtureGeometry = {
  columns: 120,
  rows: 40,
  widthPx: 1_200,
  heightPx: 800,
  cellWidthPx: 10,
  cellHeightPx: 20,
};

export const fixtureLocator = {
  schemaVersion: 1,
  instanceId: "hive-fixture",
  subject: { kind: "agent", agentId: "agent-fixture" },
  generation: 3,
  sessionId: FIXTURE_IDS.session,
  hostKind: "sessiond",
  engineBuildId: "engine-fixture",
};

export const fixtureInspection = {
  schemaVersion: 1,
  locator: fixtureLocator,
  presence: "present",
  complete: true,
  hostPid: 4100,
  hostStartToken: "4100:123456",
  providerRoot: { pid: 4101, startToken: "4101:123457", processGroupId: 4101 },
  expectedExecutable: "/usr/local/bin/codex",
  executableVerified: true,
  outputSeq: "4096",
  checkpointSeq: "2048",
  checkpointAvailable: true,
  input: { state: "FREE", ownerViewerId: null, claimId: null },
  viewerCount: 1,
  geometry: fixtureGeometry,
  resources: { rssBytes: 16_777_216 },
  visibility: {
    state: "visible",
    workspaceSessionId: "workspace-fixture",
    openTerminalRevision: "7",
    expiresAt: "2026-07-16T12:00:15.000Z",
  },
  exit: null,
  survivors: [],
  evidenceAt: FIXTURE_TIME,
  diagnosticIds: [],
};
const fixtureAttachingVisibility = {
  state: "attaching",
  workspaceSessionId: "workspace-fixture",
  openTerminalRevision: "7",
  expiresAt: "2026-07-16T12:00:30.000Z",
};

export type WireCorpusCase = Readonly<{
  name: string;
  schema: string;
  value: unknown;
}>;

const fixtureProtocol = { major: 1, minor: 0 };
const fixtureHelloCommon = {
  schemaVersion: 1,
  buildId: "build-fixture",
  instanceId: fixtureLocator.instanceId,
  protocol: { major: 1, minMinor: 0, maxMinor: 0 },
};
const fixtureHello = {
  ...fixtureHelloCommon,
  clientRole: "viewer",
  grantToken: "attach-token-fixture",
};
const fixtureDaemonControl = {
  productVersion: "0.0.0-dev",
  buildHash: "daemon-build-fixture",
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  instanceId: fixtureLocator.instanceId,
  hiveUuid: "hive-uuid-fixture",
  identityKey: "project-identity-fixture",
  repoFamilyKey: null,
};
const fixtureDaemonHello = {
  ...fixtureHelloCommon,
  clientRole: "daemon",
  daemonControl: fixtureDaemonControl,
};
const fixtureWelcome = {
  schemaVersion: 1,
  protocol: fixtureProtocol,
  instanceId: fixtureLocator.instanceId,
  endpointRole: "broker",
  buildId: "build-fixture",
  engineBuildId: null,
  connectionId: "1",
  serverEpoch: "123456789",
  limits: {
    controlFrameMaxBytes: TERMINAL_LIMITS.controlJsonBytesPerFrame,
    streamChunkMaxBytes: TERMINAL_LIMITS.streamChunkBytes,
    automatedMessageMaxBytes: TERMINAL_LIMITS.automatedMessageBytes,
    viewerQueueMaxBytes: TERMINAL_LIMITS.viewerUnacknowledgedOutputBytes,
  },
};
const fixtureHostRecord = {
  locator: fixtureLocator,
  hostPid: 4100,
  hostStartToken: "4100:123456",
  processRoot: { pid: 4101, startToken: "4101:123457", processGroupId: 4101 },
  expectedExecutable: "/usr/local/bin/codex",
  executableBuildHash: "executable-build-fixture",
  engineBuildId: "engine-fixture",
  protocol: fixtureProtocol,
  geometry: fixtureGeometry,
  state: "live",
  outputSeq: "4096",
  checkpointSeq: "2048",
  visibility: fixtureAttachingVisibility,
};
const fixtureHostRecordV1 = {
  schemaVersion: 1,
  ...fixtureHostRecord,
  socketRelativePath: "host.sock",
  createdAt: FIXTURE_TIME,
};
const fixtureAdoptRequest = {
  schemaVersion: 1,
  adoptionSecretHex: "a".repeat(64),
  expectedLocator: fixtureLocator,
  brokerBuildId: "broker-build-fixture",
  protocol: fixtureProtocol,
  operation: "adopt",
};
const fixtureGrantRegistration = {
  schemaVersion: 1,
  grantTokenSha256: `sha256:${"b".repeat(64)}`,
  viewerId: "viewer-fixture",
  operations: ["view", "human-input", "resize"],
  expiresAt: "2026-07-16T12:00:30.000Z",
  geometry: fixtureGeometry,
};
const fixtureSessionSpec = {
  schemaVersion: 1,
  locator: fixtureLocator,
  provider: "codex",
  toolSessionId: "tool-session-fixture",
  cwd: "/tmp/hive-fixture",
  argv: ["/usr/local/bin/codex", "--quiet"],
  environment: { TERM: "xterm-ghostty" },
  expectedExecutable: "/usr/local/bin/codex",
  readOnly: false,
  capabilityEpoch: 9,
  geometry: fixtureGeometry,
  launchGrantId: "grant-fixture",
  launchGrantRevision: 2,
};
const fixtureCreateResult = {
  locator: fixtureLocator,
  inspection: { ...fixtureInspection, visibility: fixtureAttachingVisibility },
  created: true,
};
const fixtureAttachRequest = {
  viewerId: "viewer-fixture",
  geometry: fixtureGeometry,
  operations: ["view", "human-input", "resize"],
};
const fixtureAttachGrant = {
  locator: fixtureLocator,
  endpoint: "/tmp/hive-fixture/session.sock",
  token: "opaque-token",
  expiresAt: "2026-07-16T12:00:30.000Z",
  engineBuildId: "engine-fixture",
  checkpointSeq: "2048",
  outputSeq: "4096",
  operations: ["view", "human-input", "resize"],
};
const fixtureVisibilityRequest = {
  workspaceSessionId: "workspace-fixture",
  workspacePid: 4000,
  workspaceStartToken: "4000:123455",
  openTerminalRevision: "7",
};
const fixtureCreateBegin = { ...fixtureSessionSpec, visibility: fixtureVisibilityRequest };
const fixtureVisibilityLease = {
  locator: fixtureLocator,
  state: "active",
  expiresAt: "2026-07-16T12:00:15.000Z",
  openTerminalRevision: "7",
};
const fixtureTerminationRequest = { mode: "graceful", reason: "terminal closed", requestId: FIXTURE_IDS.request };
const fixtureTerminationResult = { locator: fixtureLocator, state: "terminated", exit: null, survivors: [], errors: [] };

const validCases: readonly WireCorpusCase[] = [
  { name: "session locator", schema: "sessionLocator", value: fixtureLocator },
  { name: "terminal geometry", schema: "terminalGeometry", value: fixtureGeometry },
  {
    name: "session specification",
    schema: "sessionSpec",
    value: fixtureSessionSpec,
  },
  { name: "session inspection", schema: "sessionInspection", value: fixtureInspection },
  {
    name: "create result",
    schema: "createResult",
    value: fixtureCreateResult,
  },
  {
    name: "capture request",
    schema: "captureRequest",
    value: { include: "visible-text", maxRows: 50, expectedOutputSeq: "4096" },
  },
  {
    name: "capture result",
    schema: "captureResult",
    value: {
      locator: fixtureLocator,
      outputSeq: "4096",
      columns: 120,
      rows: 40,
      screen: "primary",
      cursor: { row: 4, column: 12, visible: true },
      text: "fixture output",
      truncated: false,
      sha256: "a".repeat(64),
    },
  },
  {
    name: "attach request",
    schema: "attachRequest",
    value: fixtureAttachRequest,
  },
  {
    name: "attach grant",
    schema: "attachGrant",
    value: fixtureAttachGrant,
  },
  {
    name: "visibility request",
    schema: "visibilityRequest",
    value: fixtureVisibilityRequest,
  },
  {
    name: "visibility lease",
    schema: "visibilityLease",
    value: fixtureVisibilityLease,
  },
  {
    name: "resize result",
    schema: "resizeResult",
    value: { locator: fixtureLocator, geometry: fixtureGeometry, revision: "8" },
  },
  {
    name: "automated input metadata",
    schema: "automatedInputMetadata",
    value: {
      transactionId: FIXTURE_IDS.transaction,
      idempotencyKey: "fixture-key",
      messageId: FIXTURE_IDS.message,
      recipientGeneration: 3,
      capabilityEpoch: 9,
      sha256: "b".repeat(64),
      providerStrategy: "codex-hooks-v1",
      submit: "return",
    },
  },
  {
    name: "input receipt",
    schema: "inputReceipt",
    value: {
      transactionId: FIXTURE_IDS.transaction,
      messageId: FIXTURE_IDS.message,
      state: "written",
      byteRange: { start: "5000", endExclusive: "5012" },
      providerObservation: "pending",
      evidenceAt: FIXTURE_TIME,
      diagnosticId: null,
    },
  },
  {
    name: "termination request",
    schema: "terminationRequest",
    value: fixtureTerminationRequest,
  },
  {
    name: "termination result",
    schema: "terminationResult",
    value: fixtureTerminationResult,
  },
  {
    name: "session event",
    schema: "sessionEvent",
    value: {
      schemaVersion: 1,
      eventId: FIXTURE_IDS.events[0],
      eventSeq: "1",
      locator: fixtureLocator,
      kind: "session.output",
      revision: "1",
      occurredAt: FIXTURE_TIME,
      data: { outputSeq: "4096" },
    },
  },
  {
    name: "workspace event v2",
    schema: "workspaceEventV2",
    value: {
      schemaVersion: 2,
      eventId: FIXTURE_IDS.events[1],
      seq: "2",
      entity: { kind: "agent", id: "agent-fixture", generation: 3 },
      entityRevision: "2",
      occurredAt: FIXTURE_TIME,
      kind: "agent.status-reported",
      source: {
        kind: "agent-report",
        id: "agent-fixture:3",
        observedAt: FIXTURE_TIME,
        confidence: "authoritative",
      },
      data: { phase: "testing" },
    },
  },
  {
    name: "status update",
    schema: "hiveUpdateStatusInput",
    value: {
      assignmentId: FIXTURE_IDS.assignment,
      assignmentGeneration: "42",
      phase: "testing",
      progress: 80,
      summary: "Running the shared contract corpus",
      blocker: null,
      evidenceRefs: ["event:fixture"],
      nextCheckpoint: "Cross-language parity",
      freshForSeconds: 120,
    },
  },
  {
    name: "terminal observation request",
    schema: "hiveTerminalObserveInput",
    value: { sessionId: FIXTURE_IDS.session, generation: 3, include: "visible-text", maxRows: 50 },
  },
  {
    name: "terminal delivery attempt",
    schema: "terminalDeliveryAttempt",
    value: {
      schemaVersion: 1,
      transactionId: FIXTURE_IDS.transaction,
      messageId: FIXTURE_IDS.message,
      locator: fixtureLocator,
      recipientGeneration: 3,
      adapter: "codex-tui",
      priority: "normal",
      intent: "instruction",
      evidence: "transport-written",
      byteRange: { start: "5000", endExclusive: "5012" },
      nativeEndpointReceipt: null,
      startedAt: FIXTURE_TIME,
      completedAt: "2026-07-16T12:00:00.010Z",
      evidenceRefs: ["session-event:1"],
    },
  },
  { name: "HELLO viewer grant", schema: "helloPayload", value: fixtureHello },
  { name: "HELLO daemon control identity", schema: "helloPayload", value: fixtureDaemonHello },
  { name: "HELLO broker", schema: "helloPayload", value: { ...fixtureHelloCommon, clientRole: "broker" } },
  { name: "HELLO host", schema: "helloPayload", value: { ...fixtureHelloCommon, clientRole: "host" } },
  { name: "complete HostRecordV1", schema: "hostRecordV1", value: fixtureHostRecordV1 },
  { name: "CREATE_BEGIN session spec and pending visibility", schema: "createBeginPayload", value: fixtureCreateBegin },
  { name: "CREATE_COMMIT digest", schema: "createCommitPayload", value: { schemaVersion: 1, totalLength: 12, sha256: "a".repeat(64) } },
  { name: "CREATED result", schema: "createdPayload", value: { schemaVersion: 1, ...fixtureCreateResult } },
  { name: "LIST instance", schema: "listPayload", value: { schemaVersion: 1, instanceId: fixtureLocator.instanceId } },
  { name: "LISTED inventory", schema: "listedPayload", value: { schemaVersion: 1, entries: [fixtureInspection], complete: true } },
  { name: "INSPECT locator", schema: "inspectPayload", value: { schemaVersion: 1, locator: fixtureLocator } },
  { name: "INSPECTED evidence", schema: "inspectedPayload", value: fixtureInspection },
  { name: "TERMINATE exact generation", schema: "terminatePayload", value: { schemaVersion: 1, locator: fixtureLocator, ...fixtureTerminationRequest } },
  { name: "TERMINATED result", schema: "terminatedPayload", value: { schemaVersion: 1, ...fixtureTerminationResult } },
  { name: "VISIBILITY_RENEW exact generation", schema: "visibilityRenewPayload", value: { schemaVersion: 1, locator: fixtureLocator, ...fixtureVisibilityRequest } },
  { name: "RENEWED lease", schema: "renewedPayload", value: { schemaVersion: 1, ...fixtureVisibilityLease } },
  { name: "ATTACH_REQUEST exact generation", schema: "attachRequestPayload", value: { schemaVersion: 1, locator: fixtureLocator, ...fixtureAttachRequest } },
  { name: "ATTACH_GRANT exact host", schema: "attachGrantPayload", value: { schemaVersion: 1, ...fixtureAttachGrant } },
  { name: "HOST_ATTACH replay cursor", schema: "hostAttachPayload", value: { schemaVersion: 1, locator: fixtureLocator, token: "opaque-token", geometry: fixtureGeometry, afterSeq: "4096" } },
  { name: "WELCOME broker", schema: "welcomePayload", value: fixtureWelcome },
  { name: "typed ERROR", schema: "errorPayload", value: { schemaVersion: 1, code: "UNAUTHENTICATED", message: "grant rejected", diagnosticId: null } },
  { name: "PING monotonic nanos", schema: "pingPongPayload", value: { schemaVersion: 1, monoNanos: "123456789" } },
  { name: "HOST_REGISTER readback", schema: "hostRegisterPayload", value: { schemaVersion: 1, record: fixtureHostRecord } },
  { name: "HOST_REGISTER accepted", schema: "hostRegisterPayload", value: { schemaVersion: 1, accepted: true } },
  { name: "HOST_ADOPT challenge", schema: "hostAdoptPayload", value: fixtureAdoptRequest },
  {
    name: "HOST_ADOPT readback",
    schema: "hostAdoptPayload",
    value: {
      schemaVersion: 1,
      locator: fixtureLocator,
      hostPid: fixtureHostRecord.hostPid,
      hostStartToken: fixtureHostRecord.hostStartToken,
      executable: fixtureHostRecord.expectedExecutable,
      executableBuildHash: fixtureHostRecord.executableBuildHash,
      engineBuildId: fixtureHostRecord.engineBuildId,
      protocol: fixtureHostRecord.protocol,
      processRoot: fixtureHostRecord.processRoot,
      outputSeq: fixtureHostRecord.outputSeq,
      checkpointSeq: fixtureHostRecord.checkpointSeq,
      visibility: fixtureInspection.visibility,
    },
  },
  { name: "GRANT_REGISTER request", schema: "grantRegisterPayload", value: fixtureGrantRegistration },
  { name: "GRANT_REGISTER accepted", schema: "grantRegisterPayload", value: { schemaVersion: 1, registered: true } },
  {
    name: "session inspection preserves unknown input observation",
    schema: "sessionInspection",
    value: { ...fixtureInspection, input: { ...fixtureInspection.input, state: "UNKNOWN" } },
  },
];

const invalidCases: readonly WireCorpusCase[] = [
  { name: "locator rejects display-name fallback", schema: "sessionLocator", value: { ...fixtureLocator, sessionId: "codex" } },
  { name: "geometry rejects zero", schema: "terminalGeometry", value: { ...fixtureGeometry, columns: 0 } },
  { name: "geometry enforces active-cell cap", schema: "terminalGeometry", value: { ...fixtureGeometry, columns: 501, rows: 500 } },
  { name: "spec rejects empty argv", schema: "sessionSpec", value: { ...(validCases[2]!.value as object), argv: [] } },
  { name: "inspection rejects invented presence", schema: "sessionInspection", value: { ...fixtureInspection, presence: "absent" } },
  { name: "inspection rejects invented input state", schema: "sessionInspection", value: { ...fixtureInspection, input: { ...fixtureInspection.input, state: "AUTOMATION_WRITING" } } },
  { name: "create rejects false success", schema: "createResult", value: { locator: fixtureLocator, inspection: fixtureInspection, created: false } },
  { name: "capture request enforces row cap", schema: "captureRequest", value: { include: "metadata", maxRows: 201 } },
  { name: "capture rejects malformed digest", schema: "captureResult", value: { ...(validCases[6]!.value as object), sha256: "bad" } },
  { name: "attach rejects unknown operation", schema: "attachRequest", value: { viewerId: "v", geometry: fixtureGeometry, operations: ["focus"] } },
  { name: "grant requires endpoint", schema: "attachGrant", value: { ...(validCases[8]!.value as object), endpoint: "" } },
  { name: "visibility rejects invalid pid", schema: "visibilityRequest", value: { ...(validCases[9]!.value as object), workspacePid: 0 } },
  { name: "lease rejects inactive state", schema: "visibilityLease", value: { ...(validCases[10]!.value as object), state: "expired" } },
  { name: "resize rejects negative revision", schema: "resizeResult", value: { locator: fixtureLocator, geometry: fixtureGeometry, revision: "-1" } },
  { name: "resize rejects uint64 overflow", schema: "resizeResult", value: { locator: fixtureLocator, geometry: fixtureGeometry, revision: "18446744073709551616" } },
  { name: "automation rejects unknown submit", schema: "automatedInputMetadata", value: { ...(validCases[12]!.value as object), submit: "enter" } },
  { name: "receipt rejects false read evidence", schema: "inputReceipt", value: { ...(validCases[13]!.value as object), state: "read" } },
  { name: "termination rejects detach", schema: "terminationRequest", value: { mode: "detach", reason: "close", requestId: FIXTURE_IDS.request } },
  { name: "termination result rejects absent", schema: "terminationResult", value: { locator: fixtureLocator, state: "absent", exit: null, survivors: [], errors: [] } },
  { name: "session event rejects wrong version", schema: "sessionEvent", value: { ...(validCases[16]!.value as object), schemaVersion: 2 } },
  { name: "workspace event rejects screen source", schema: "workspaceEventV2", value: { ...(validCases[17]!.value as object), source: { kind: "terminal-screen", id: "screen", observedAt: FIXTURE_TIME, confidence: "low" } } },
  {
    name: "blocked status requires blocker",
    schema: "hiveUpdateStatusInput",
    value: {
      assignmentId: FIXTURE_IDS.assignment,
      assignmentGeneration: "42",
      phase: "blocked",
      summary: "Blocked",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 120,
    },
  },
  { name: "observation rejects scrollback-sized request", schema: "hiveTerminalObserveInput", value: { sessionId: FIXTURE_IDS.session, generation: 3, include: "visible-text", maxRows: 201 } },
  { name: "terminal attempt rejects recipient acknowledgment", schema: "terminalDeliveryAttempt", value: { ...(validCases[20]!.value as object), evidence: "recipient-acknowledged" } },
  { name: "terminal attempt requires one receipt form", schema: "terminalDeliveryAttempt", value: { ...(validCases[20]!.value as object), byteRange: null, nativeEndpointReceipt: null } },
  { name: "HELLO rejects unknown field", schema: "helloPayload", value: { ...fixtureHello, authority: "claimed" } },
  { name: "HELLO rejects daemon without control identity", schema: "helloPayload", value: { ...fixtureHelloCommon, clientRole: "daemon" } },
  { name: "HELLO rejects daemon grant", schema: "helloPayload", value: { ...fixtureDaemonHello, grantToken: "forbidden" } },
  { name: "HELLO rejects daemon block from viewer", schema: "helloPayload", value: { ...fixtureHello, daemonControl: fixtureDaemonControl } },
  { name: "HELLO rejects reversed minor range", schema: "helloPayload", value: { ...fixtureHello, protocol: { major: 1, minMinor: 1, maxMinor: 0 } } },
  { name: "HostRecordV1 rejects an absolute socket path", schema: "hostRecordV1", value: { ...fixtureHostRecordV1, socketRelativePath: "/tmp/host.sock" } },
  { name: "CREATE_BEGIN rejects missing locator", schema: "createBeginPayload", value: { ...fixtureCreateBegin, locator: undefined } },
  { name: "CREATE_BEGIN rejects missing visibility", schema: "createBeginPayload", value: fixtureSessionSpec },
  { name: "CREATE_BEGIN rejects zero open-terminal revision", schema: "createBeginPayload", value: { ...fixtureCreateBegin, visibility: { ...fixtureVisibilityRequest, openTerminalRevision: "0" } } },
  { name: "CREATE_COMMIT rejects oversized input", schema: "createCommitPayload", value: { schemaVersion: 1, totalLength: TERMINAL_LIMITS.automatedMessageBytes + 1, sha256: "a".repeat(64) } },
  { name: "CREATED rejects missing inspection", schema: "createdPayload", value: { schemaVersion: 1, locator: fixtureLocator, created: true } },
  { name: "LIST rejects missing instance", schema: "listPayload", value: { schemaVersion: 1 } },
  { name: "LISTED rejects missing completeness", schema: "listedPayload", value: { schemaVersion: 1, entries: [fixtureInspection] } },
  { name: "INSPECT rejects missing locator", schema: "inspectPayload", value: { schemaVersion: 1 } },
  { name: "INSPECTED rejects unknown field", schema: "inspectedPayload", value: { ...fixtureInspection, trusted: true } },
  { name: "TERMINATE rejects missing locator", schema: "terminatePayload", value: { schemaVersion: 1, ...fixtureTerminationRequest } },
  { name: "TERMINATED rejects missing state", schema: "terminatedPayload", value: { schemaVersion: 1, ...fixtureTerminationResult, state: undefined } },
  { name: "VISIBILITY_RENEW rejects missing locator", schema: "visibilityRenewPayload", value: { schemaVersion: 1, ...fixtureVisibilityRequest } },
  { name: "RENEWED rejects missing locator", schema: "renewedPayload", value: { schemaVersion: 1, state: "active", expiresAt: fixtureVisibilityLease.expiresAt, openTerminalRevision: "7" } },
  { name: "ATTACH_REQUEST rejects missing locator", schema: "attachRequestPayload", value: { schemaVersion: 1, ...fixtureAttachRequest } },
  { name: "ATTACH_GRANT rejects missing token", schema: "attachGrantPayload", value: { schemaVersion: 1, ...fixtureAttachGrant, token: undefined } },
  { name: "HOST_ATTACH rejects numeric replay cursor", schema: "hostAttachPayload", value: { schemaVersion: 1, locator: fixtureLocator, token: "opaque-token", geometry: fixtureGeometry, afterSeq: 4096 } },
  { name: "WELCOME rejects unknown field", schema: "welcomePayload", value: { ...fixtureWelcome, authority: true } },
  { name: "ERROR rejects unknown field", schema: "errorPayload", value: { schemaVersion: 1, code: "INTERNAL", message: "failure", diagnosticId: null, retry: true } },
  { name: "PING rejects unknown field", schema: "pingPongPayload", value: { schemaVersion: 1, monoNanos: "1", wallTime: FIXTURE_TIME } },
  { name: "HOST_REGISTER rejects unknown field", schema: "hostRegisterPayload", value: { schemaVersion: 1, record: fixtureHostRecord, trusted: true } },
  { name: "HOST_ADOPT rejects unknown field", schema: "hostAdoptPayload", value: { ...fixtureAdoptRequest, trusted: true } },
  { name: "HOST_ADOPT rejects malformed secret", schema: "hostAdoptPayload", value: { ...fixtureAdoptRequest, adoptionSecretHex: "not-a-secret" } },
  { name: "GRANT_REGISTER rejects unknown field", schema: "grantRegisterPayload", value: { ...fixtureGrantRegistration, rawToken: "forbidden" } },
  { name: "GRANT_REGISTER rejects untagged hash", schema: "grantRegisterPayload", value: { ...fixtureGrantRegistration, grantTokenSha256: "b".repeat(64) } },
];

export type FrameHeaderFields = Readonly<{
  type: FrameTypeName;
  flags: number;
  payloadLength: number;
  requestId: string;
  streamSeq: string;
}>;

export function encodeFrameHeader(fields: FrameHeaderFields): Uint8Array {
  const bytes = new Uint8Array(FRAME_HEADER.bytes);
  bytes.set(FRAME_HEADER.magicBytes, FRAME_HEADER.offsets.magic);
  const view = new DataView(bytes.buffer);
  view.setUint8(FRAME_HEADER.offsets.major, SESSION_PROTOCOL_VERSION.major);
  view.setUint8(FRAME_HEADER.offsets.minor, SESSION_PROTOCOL_VERSION.minor);
  view.setUint16(FRAME_HEADER.offsets.type, FRAME_TYPES[fields.type]);
  view.setUint16(FRAME_HEADER.offsets.flags, fields.flags);
  view.setUint16(FRAME_HEADER.offsets.reserved, 0);
  view.setUint32(FRAME_HEADER.offsets.payloadLength, fields.payloadLength);
  view.setBigUint64(FRAME_HEADER.offsets.requestId, BigInt(fields.requestId));
  view.setBigUint64(FRAME_HEADER.offsets.streamSeq, BigInt(fields.streamSeq));
  return bytes;
}

export function parseFrameHeader(bytes: Uint8Array): FrameHeaderFields | null {
  if (bytes.byteLength !== FRAME_HEADER.bytes) throw new Error("MALFORMED_FRAME");
  for (const [index, expected] of FRAME_HEADER.magicBytes.entries()) {
    if (bytes[index] !== expected) throw new Error("MALFORMED_FRAME");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(FRAME_HEADER.offsets.major) !== SESSION_PROTOCOL_VERSION.major) {
    throw new Error("PROTOCOL_MISMATCH");
  }
  const minor = view.getUint8(FRAME_HEADER.offsets.minor);
  if (minor < SESSION_PROTOCOL_MINOR_RANGE.min || minor > SESSION_PROTOCOL_MINOR_RANGE.max) {
    throw new Error("PROTOCOL_MISMATCH");
  }
  const typeCode = view.getUint16(FRAME_HEADER.offsets.type);
  const entry = Object.entries(FRAME_TYPES).find(([, code]) => code === typeCode);
  const flags = view.getUint16(FRAME_HEADER.offsets.flags);
  if ((flags & ~FRAME_FLAGS.allowedMask) !== 0 || view.getUint16(FRAME_HEADER.offsets.reserved) !== 0) {
    throw new Error("MALFORMED_FRAME");
  }
  const payloadLength = view.getUint32(FRAME_HEADER.offsets.payloadLength);
  if (!entry) {
    if ((typeCode & FRAME_HEADER.optionalTypeBit) !== 0) {
      if (payloadLength > TERMINAL_LIMITS.controlJsonBytesPerFrame) throw new Error("FRAME_TOO_LARGE");
      return null;
    }
    throw new Error("UNSUPPORTED_FRAME");
  }
  const type = entry[0] as FrameTypeName;
  const cap = (RAW_BYTE_FRAME_TYPES as readonly string[]).includes(type)
    ? TERMINAL_LIMITS.streamChunkBytes
    : TERMINAL_LIMITS.controlJsonBytesPerFrame;
  if (payloadLength > cap) throw new Error("FRAME_TOO_LARGE");
  return {
    type,
    flags,
    payloadLength,
    requestId: view.getBigUint64(FRAME_HEADER.offsets.requestId).toString(),
    streamSeq: view.getBigUint64(FRAME_HEADER.offsets.streamSeq).toString(),
  };
}

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const mutateHeader = (source: Uint8Array, offset: number, value: number): Uint8Array => {
  const copy = source.slice();
  copy[offset] = value;
  return copy;
};

export function buildWireCorpus() {
  const hello: FrameHeaderFields = {
    type: "HELLO",
    flags: 0,
    payloadLength: 128,
    requestId: "42",
    streamSeq: "0",
  };
  const output: FrameHeaderFields = {
    type: "OUTPUT",
    flags: FRAME_FLAGS.final | FRAME_FLAGS.contentSensitive,
    payloadLength: TERMINAL_LIMITS.streamChunkBytes,
    requestId: "0",
    streamSeq: "18446744073709550000",
  };
  const helloBytes = encodeFrameHeader(hello);
  const badReserved = helloBytes.slice();
  new DataView(badReserved.buffer).setUint16(FRAME_HEADER.offsets.reserved, 1);
  const badFlags = helloBytes.slice();
  new DataView(badFlags.buffer).setUint16(FRAME_HEADER.offsets.flags, 0x10);
  const oversized = encodeFrameHeader({ ...output, payloadLength: TERMINAL_LIMITS.streamChunkBytes + 1 });
  const optionalUnknown = helloBytes.slice();
  new DataView(optionalUnknown.buffer).setUint16(FRAME_HEADER.offsets.type, 0x8001);
  const unsolicitedOptionalUnknown = optionalUnknown.slice();
  new DataView(unsolicitedOptionalUnknown.buffer).setBigUint64(FRAME_HEADER.offsets.requestId, 0n);
  const mandatoryUnknown = helloBytes.slice();
  new DataView(mandatoryUnknown.buffer).setUint16(FRAME_HEADER.offsets.type, 0x7000);
  return {
    schemaVersion: 1,
    valid: validCases,
    invalid: invalidCases,
    frameHeaders: {
      valid: [
        { name: "hello", fields: hello, hex: toHex(helloBytes) },
        { name: "maximum output chunk", fields: output, hex: toHex(encodeFrameHeader(output)) },
      ],
      ignored: [
        { name: "unknown optional frame", hex: toHex(optionalUnknown) },
        { name: "unsolicited unknown optional frame", hex: toHex(unsolicitedOptionalUnknown) },
      ],
      invalid: [
        { name: "bad magic", error: "MALFORMED_FRAME", hex: toHex(mutateHeader(helloBytes, 0, 0)) },
        { name: "major mismatch", error: "PROTOCOL_MISMATCH", hex: toHex(mutateHeader(helloBytes, FRAME_HEADER.offsets.major, 2)) },
        { name: "minor mismatch", error: "PROTOCOL_MISMATCH", hex: toHex(mutateHeader(helloBytes, FRAME_HEADER.offsets.minor, SESSION_PROTOCOL_MINOR_RANGE.max + 1)) },
        { name: "reserved bits", error: "MALFORMED_FRAME", hex: toHex(badReserved) },
        { name: "unknown flags", error: "MALFORMED_FRAME", hex: toHex(badFlags) },
        { name: "oversized raw chunk", error: "FRAME_TOO_LARGE", hex: toHex(oversized) },
        { name: "unknown mandatory frame", error: "UNSUPPORTED_FRAME", hex: toHex(mandatoryUnknown) },
      ],
    },
  } as const;
}

export type ReducerProjection = Readonly<{
  highWaterSeq: string;
  paused: boolean;
  recovery: "SNAPSHOT_REQUIRED" | null;
  corruption: string | null;
  entities: Readonly<Record<string, unknown>>;
  seen: Readonly<Record<string, string>>;
}>;

export const emptyReducerProjection = (): ReducerProjection => ({
  highWaterSeq: "0",
  paused: false,
  recovery: null,
  corruption: null,
  entities: {},
  seen: {},
});

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function reduceWorkspaceEvent(
  state: ReducerProjection,
  event: WorkspaceEventV2,
): ReducerProjection {
  if (state.paused || state.corruption !== null) return state;
  const encoded = canonicalJson(event);
  const prior = state.seen[event.eventId];
  if (prior !== undefined) {
    if (prior === encoded) return state;
    return { ...state, corruption: `conflicting duplicate ${event.eventId}` };
  }
  if (BigInt(event.seq) !== BigInt(state.highWaterSeq) + 1n) {
    return { ...state, paused: true, recovery: "SNAPSHOT_REQUIRED" };
  }
  const seen = { ...state.seen, [event.eventId]: encoded };
  const entityKey = `${event.entity.kind}:${event.entity.id}:${event.entity.generation ?? "-"}`;
  const existing = state.entities[entityKey] as { entityRevision?: string } | undefined;
  const entities = existing !== undefined &&
      BigInt(event.entityRevision) < BigInt(existing.entityRevision ?? "0")
    ? state.entities
    : {
      ...state.entities,
      [entityKey]: {
        entityRevision: event.entityRevision,
        eventId: event.eventId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        source: event.source,
        data: event.data,
      },
    };
  return { ...state, highWaterSeq: event.seq, entities, seen };
}

const baseReducerEvents: readonly WorkspaceEventV2[] = [
  {
    schemaVersion: 2,
    eventId: FIXTURE_IDS.events[0],
    seq: "1",
    entity: { kind: "agent", id: "agent-fixture", generation: 3 },
    entityRevision: "1",
    occurredAt: FIXTURE_TIME,
    kind: "agent.status-reported",
    source: { kind: "agent-report", id: "agent-fixture:3", observedAt: FIXTURE_TIME, confidence: "authoritative" },
    data: { phase: "planning", summary: "Reading contracts" },
  },
  {
    schemaVersion: 2,
    eventId: FIXTURE_IDS.events[1],
    seq: "2",
    entity: { kind: "agent", id: "agent-fixture", generation: 3 },
    entityRevision: "2",
    occurredAt: "2026-07-16T12:00:01.000Z",
    kind: "agent.status-reported",
    source: { kind: "agent-report", id: "agent-fixture:3", observedAt: "2026-07-16T12:00:01.000Z", confidence: "authoritative" },
    data: { phase: "testing", summary: "Checking parity" },
  },
  {
    schemaVersion: 2,
    eventId: FIXTURE_IDS.events[2],
    seq: "3",
    entity: { kind: "session", id: FIXTURE_IDS.session, generation: 3 },
    entityRevision: "1",
    occurredAt: "2026-07-16T12:00:02.000Z",
    kind: "session.health",
    source: { kind: "sessiond", id: FIXTURE_IDS.session, observedAt: "2026-07-16T12:00:02.000Z", confidence: "authoritative" },
    data: { presence: "present", outputSeq: "4096" },
  },
];

const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

const prefixesFor = (events: readonly WorkspaceEventV2[]) => {
  let state = emptyReducerProjection();
  return events.map((event) => {
    state = reduceWorkspaceEvent(state, event);
    return state;
  });
};

// These four edge-scenario goldens are deliberately independent literals.
// Do not derive them with reduceWorkspaceEvent: that would make parity tautological.
const HAND_AUTHORED_PLANNING_EVENT =
  '{"data":{"phase":"planning","summary":"Reading contracts"},"entity":{"generation":3,"id":"agent-fixture","kind":"agent"},"entityRevision":"1","eventId":"evt_018f1e90-7b5a-7cc0-8000-000000000005","kind":"agent.status-reported","occurredAt":"2026-07-16T12:00:00.000Z","schemaVersion":2,"seq":"1","source":{"confidence":"authoritative","id":"agent-fixture:3","kind":"agent-report","observedAt":"2026-07-16T12:00:00.000Z"}}';
const HAND_AUTHORED_LOWER_FIRST_EVENT =
  '{"data":{"phase":"testing","summary":"Checking parity"},"entity":{"generation":3,"id":"agent-fixture","kind":"agent"},"entityRevision":"2","eventId":"evt_018f1e90-7b5a-7cc0-8000-000000000005","kind":"agent.status-reported","occurredAt":"2026-07-16T12:00:01.000Z","schemaVersion":2,"seq":"1","source":{"confidence":"authoritative","id":"agent-fixture:3","kind":"agent-report","observedAt":"2026-07-16T12:00:01.000Z"}}';
const HAND_AUTHORED_LOWER_SECOND_EVENT =
  '{"data":{"phase":"planning","summary":"Reading contracts"},"entity":{"generation":3,"id":"agent-fixture","kind":"agent"},"entityRevision":"1","eventId":"evt_018f1e90-7b5a-7cc0-8000-000000000006","kind":"agent.status-reported","occurredAt":"2026-07-16T12:00:00.000Z","schemaVersion":2,"seq":"2","source":{"confidence":"authoritative","id":"agent-fixture:3","kind":"agent-report","observedAt":"2026-07-16T12:00:00.000Z"}}';

const HAND_AUTHORED_PLANNING_PREFIX: ReducerProjection = {
  highWaterSeq: "1",
  paused: false,
  recovery: null,
  corruption: null,
  entities: {
    "agent:agent-fixture:3": {
      entityRevision: "1",
      eventId: FIXTURE_IDS.events[0],
      kind: "agent.status-reported",
      occurredAt: FIXTURE_TIME,
      source: {
        kind: "agent-report",
        id: "agent-fixture:3",
        observedAt: FIXTURE_TIME,
        confidence: "authoritative",
      },
      data: { phase: "planning", summary: "Reading contracts" },
    },
  },
  seen: { [FIXTURE_IDS.events[0]]: HAND_AUTHORED_PLANNING_EVENT },
};

const HAND_AUTHORED_LOWER_FIRST_PREFIX: ReducerProjection = {
  highWaterSeq: "1",
  paused: false,
  recovery: null,
  corruption: null,
  entities: {
    "agent:agent-fixture:3": {
      entityRevision: "2",
      eventId: FIXTURE_IDS.events[0],
      kind: "agent.status-reported",
      occurredAt: "2026-07-16T12:00:01.000Z",
      source: {
        kind: "agent-report",
        id: "agent-fixture:3",
        observedAt: "2026-07-16T12:00:01.000Z",
        confidence: "authoritative",
      },
      data: { phase: "testing", summary: "Checking parity" },
    },
  },
  seen: { [FIXTURE_IDS.events[0]]: HAND_AUTHORED_LOWER_FIRST_EVENT },
};

const HAND_AUTHORED_LOWER_SECOND_PREFIX: ReducerProjection = {
  highWaterSeq: "2",
  paused: false,
  recovery: null,
  corruption: null,
  entities: {
    "agent:agent-fixture:3": {
      entityRevision: "2",
      eventId: FIXTURE_IDS.events[0],
      kind: "agent.status-reported",
      occurredAt: "2026-07-16T12:00:01.000Z",
      source: {
        kind: "agent-report",
        id: "agent-fixture:3",
        observedAt: "2026-07-16T12:00:01.000Z",
        confidence: "authoritative",
      },
      data: { phase: "testing", summary: "Checking parity" },
    },
  },
  seen: {
    [FIXTURE_IDS.events[0]]: HAND_AUTHORED_LOWER_FIRST_EVENT,
    [FIXTURE_IDS.events[1]]: HAND_AUTHORED_LOWER_SECOND_EVENT,
  },
};

const HAND_AUTHORED_CONFLICT_PREFIX: ReducerProjection = {
  highWaterSeq: "1",
  paused: false,
  recovery: null,
  corruption: `conflicting duplicate ${FIXTURE_IDS.events[0]}`,
  entities: {
    "agent:agent-fixture:3": {
      entityRevision: "1",
      eventId: FIXTURE_IDS.events[0],
      kind: "agent.status-reported",
      occurredAt: FIXTURE_TIME,
      source: {
        kind: "agent-report",
        id: "agent-fixture:3",
        observedAt: FIXTURE_TIME,
        confidence: "authoritative",
      },
      data: { phase: "planning", summary: "Reading contracts" },
    },
  },
  seen: { [FIXTURE_IDS.events[0]]: HAND_AUTHORED_PLANNING_EVENT },
};

const HAND_AUTHORED_GAP_PREFIX: ReducerProjection = {
  highWaterSeq: "0",
  paused: true,
  recovery: "SNAPSHOT_REQUIRED",
  corruption: null,
  entities: {},
  seen: {},
};

export function buildReducerCorpus() {
  const permutationScenarios = permutations.map((order, scenarioIndex) => {
    const events = order.map((sourceIndex, sequenceIndex) => ({
      ...baseReducerEvents[sourceIndex],
      eventId: `evt_018f1e90-7b5a-7cc0-8${scenarioIndex.toString(16).padStart(3, "0")}-${(sequenceIndex + 20).toString().padStart(12, "0")}`,
      seq: String(sequenceIndex + 1),
    })) as WorkspaceEventV2[];
    return { name: `permutation-${order.join("")}`, events, prefixes: prefixesFor(events) };
  });
  const duplicateEvents = [baseReducerEvents[0]!, baseReducerEvents[0]!];
  const lowerRevision = [
    { ...baseReducerEvents[1]!, eventId: FIXTURE_IDS.events[0], seq: "1" },
    { ...baseReducerEvents[0]!, eventId: FIXTURE_IDS.events[1], seq: "2" },
  ];
  const conflictingDuplicate = [
    baseReducerEvents[0]!,
    { ...baseReducerEvents[0]!, data: { phase: "complete" } },
  ];
  const gap = [{ ...baseReducerEvents[0]!, seq: "2" }];
  const edgeScenarios = [
    {
      name: "identical-duplicate",
      events: duplicateEvents,
      prefixes: [HAND_AUTHORED_PLANNING_PREFIX, HAND_AUTHORED_PLANNING_PREFIX],
    },
    {
      name: "lower-entity-revision",
      events: lowerRevision,
      prefixes: [HAND_AUTHORED_LOWER_FIRST_PREFIX, HAND_AUTHORED_LOWER_SECOND_PREFIX],
    },
    {
      name: "conflicting-duplicate",
      events: conflictingDuplicate,
      prefixes: [HAND_AUTHORED_PLANNING_PREFIX, HAND_AUTHORED_CONFLICT_PREFIX],
    },
    {
      name: "sequence-gap",
      events: gap,
      prefixes: [HAND_AUTHORED_GAP_PREFIX],
    },
  ];
  return { schemaVersion: 1, scenarios: [...permutationScenarios, ...edgeScenarios] };
}
