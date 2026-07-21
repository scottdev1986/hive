import { createHash } from "node:crypto";
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
import {
  canonicalJson,
  emptyStatusProjection,
  reduceStatusEvent,
  type StatusReducerProjection,
} from "../../src/daemon/status-events";

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
    maxInputTransactionBytes: TERMINAL_LIMITS.inputTransactionBytes,
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
const fixtureTerminalHostSession = { key: fixtureLocator.sessionId, incarnation: "3" };
const fixtureTerminalHostCreateRequest = {
  key: fixtureTerminalHostSession.key,
  idempotencyKey: "create-fixture-key",
  command: {
    executable: "/usr/bin/env",
    arguments: ["env"],
    workingDirectory: "/tmp/hive-fixture",
    completeEnvironment: [
      { name: "LANG", value: "en_US.UTF-8" },
      { name: "TERM", value: "xterm-ghostty" },
    ],
    descriptorMap: [],
  },
  terminalProfile: {
    inputMode: "literal",
    echo: false,
    signalCharacters: true,
    softwareFlowControl: false,
    eofByte: 4,
    startByte: 17,
    stopByte: 19,
    hangupOnLastClose: true,
  },
  initialWindow: { columns: 120, rows: 40, widthPixels: 1_200, heightPixels: 800 },
};
const fixtureTerminalHostCreateResult = {
  session: fixtureTerminalHostSession,
  outcome: {
    state: "running",
    child: { processId: 4101, startToken: "4101:123457" },
    execProof: "replacement-observed",
    jobControl: {
      sessionLeader: true,
      controllingTerminal: true,
      standardStreamsShareTerminal: true,
      childSessionId: 4101,
      childProcessGroupId: 4101,
      foregroundProcessGroupId: 4101,
      terminalIdentity: "/dev/ttys001",
      initialProfileAppliedBeforeExec: true,
      initialWindowAppliedBeforeExec: true,
      completeness: "complete",
    },
  },
  limits: {
    maxInputTransactionBytes: TERMINAL_LIMITS.inputTransactionBytes,
    maxInputQueueBytes: TERMINAL_LIMITS.inputTransactionBytes,
    maxOutputFrameBytes: TERMINAL_LIMITS.streamChunkBytes,
    outputLowWaterBytes: 2 * 1024 * 1024,
    outputHighWaterBytes: 4 * 1024 * 1024,
    outputRetentionBytes: TERMINAL_LIMITS.replayJournalBytesPerGeneration,
  },
};
const fixtureTerminalHostClaim = {
  token: "claim-fixture-token",
  writer: "viewer-fixture",
  kind: "human",
  leaseExpiresAt: "2026-07-16T12:00:15.000Z",
};
const fixtureTerminalHostReceipt = {
  transactionId: "terminal-input-fixture",
  stage: "written-to-terminal",
  byteRange: { start: "0", endExclusive: "5" },
  orderedAt: "1",
  availableCreditBytes: TERMINAL_LIMITS.inputTransactionBytes,
  consumedByProcess: "not-claimed",
  completeness: "complete",
  diagnostic: null,
};
const fixtureTerminalHostResize = {
  state: "applied",
  revision: "8",
  readback: { columns: 111, rows: 37, widthPixels: 1110, heightPixels: 740 },
  orderedAt: "2",
  foregroundProcessObservation: "not-claimed",
};
const fixtureTerminalHostCheckpoint = {
  contentType: "application/vnd.hive.terminal-checkpoint",
  schemaVersion: "1",
  hashAlgorithm: "sha256",
  hash: "b".repeat(64),
  throughEventSequence: "12",
  throughOutputOffset: "2048",
  opaqueBytes: "dGVybWluYWwtc3RhdGU=",
};
const fixtureTerminalHostInspection = {
  session: fixtureTerminalHostSession,
  lifecycle: "running",
  completeness: "complete",
  host: { processId: 4100, startToken: "4100:123456" },
  child: fixtureTerminalHostCreateResult.outcome.child,
  jobControl: fixtureTerminalHostCreateResult.outcome.jobControl,
  window: {
    value: fixtureTerminalHostCreateRequest.initialWindow,
    revision: fixtureTerminalHostResize.revision,
  },
  output: {
    closed: false,
    retained: { start: "2048", endExclusive: "4096" },
  },
  checkpoints: { retained: 1, newest: fixtureTerminalHostCheckpoint },
  inputOwner: fixtureTerminalHostClaim,
  exit: null,
  reap: {
    authority: "direct-parent",
    reaped: false,
    status: null,
    completeness: "complete",
  },
  descendants: [{ processId: 4102, startToken: "4102:123458" }],
  survivors: [],
  evidenceAt: FIXTURE_TIME,
  diagnostics: [],
};
const fixtureTerminalHostExit = {
  code: null,
  signal: 9,
  observedAt: FIXTURE_TIME,
};
const fixtureTerminalHostResizeRequest = {
  session: fixtureTerminalHostSession,
  window: { columns: 111, rows: 37, widthPixels: 1_776, heightPixels: 999 },
  revision: "41",
  idempotencyKey: "resize-fixture-key",
};
const fixtureTerminalHostResizeReceipt = {
  session: fixtureTerminalHostSession,
  revision: "41",
  orderedAt: "7",
  window: fixtureTerminalHostResizeRequest.window,
};
const fixtureTerminalHostAttachRequest = {
  session: fixtureTerminalHostSession,
  protocol: { major: 1, minMinor: 0, maxMinor: 0 },
  checkpointCapabilities: [
    { contentType: "application/vnd.hive.terminal-checkpoint", schemaVersion: "1" },
  ],
  cursor: { eventSequence: "12", outputOffset: "4096", checkpoint: "sha256:cafe" },
};
const fixtureTerminalHostAttachResult = {
  state: "attached",
  session: fixtureTerminalHostSession,
  protocol: { major: 1, minor: 0 },
  checkpoint: { contentType: "application/vnd.hive.terminal-checkpoint", schemaVersion: "1" },
  resumeFrom: { eventSequence: "12", outputOffset: "4096", checkpoint: "sha256:cafe" },
};
const fixtureTerminalHostAttachGap = {
  state: "gap",
  session: fixtureTerminalHostSession,
  missing: { start: "4096", endExclusive: "9001" },
  checkpointRequirement: "full",
};
const fixtureTerminalHostSubscriptionLimits = {
  maxEventFrameBytes: 65_536,
  retainedEventCount: 4_096,
  unacknowledgedEventLowWater: 256,
  unacknowledgedEventHighWater: 1_024,
};
const fixtureTerminalHostSubscribeRequest = {
  session: fixtureTerminalHostSession,
  protocol: { major: 1, minMinor: 0, maxMinor: 0 },
  limits: fixtureTerminalHostSubscriptionLimits,
  from: { position: "at", cursor: { eventSequence: "12", outputOffset: "4096" } },
};
const fixtureTerminalHostSubscribeResult = {
  state: "subscribed",
  session: fixtureTerminalHostSession,
  protocol: { major: 1, minor: 0 },
  limits: fixtureTerminalHostSubscriptionLimits,
  resumeFrom: { eventSequence: "12", outputOffset: "4096" },
};
const fixtureTerminalHostSubscribeGap = {
  state: "gap",
  session: fixtureTerminalHostSession,
  missing: { start: "12", endExclusive: "37" },
  freshInspection: "required",
};
const fixtureTerminalHostVisibilityRequest = {
  sourceSession: "workspace-session-7",
  sourceProcess: { processId: 5150, startToken: "5150:998877" },
  inventoryRevision: "19",
};
const fixtureTerminalHostVisibilityRenewalRequest = {
  session: fixtureTerminalHostSession,
  visibility: fixtureTerminalHostVisibilityRequest,
};
// A lease is active only BETWEEN issuedAt and a finite expiresAt, and the
// visibility extension freezes that neutral duration at 15 seconds — so an
// active fixture must span a real window, not collapse to a single instant.
const FIXTURE_LEASE_EXPIRY = "2026-07-16T12:00:15.000Z";
const fixtureTerminalHostVisibilityRenewalResult = {
  state: "active",
  renewed: true,
  lease: {
    session: fixtureTerminalHostSession,
    sourceSession: fixtureTerminalHostVisibilityRequest.sourceSession,
    sourceProcess: fixtureTerminalHostVisibilityRequest.sourceProcess,
    inventoryRevision: fixtureTerminalHostVisibilityRequest.inventoryRevision,
    state: "active",
    issuedAt: FIXTURE_TIME,
    expiresAt: FIXTURE_LEASE_EXPIRY,
  },
};
const fixtureTerminalHostTerminationRequest = {
  session: fixtureTerminalHostSession,
  mode: "immediate",
  target: "process-tree",
  deadline: "2026-07-16T12:00:02.000Z",
  idempotencyKey: "terminate-fixture-key",
};
const fixtureTerminalHostTerminationResult = {
  state: "terminated",
  exit: fixtureTerminalHostExit,
  reap: {
    authority: "direct-parent",
    reaped: true,
    status: fixtureTerminalHostExit,
    completeness: "complete",
  },
  survivors: [],
  completeness: "complete",
  diagnostics: [],
};

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
      entity: { kind: "agent", id: "agent-fixture" },
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
      requestId: FIXTURE_IDS.request,
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
  {
    name: "workspace snapshot v2",
    schema: "workspaceSnapshotV2",
    value: {
      schemaVersion: 2,
      instanceId: "hive-fixture",
      seq: "2",
      entities: [{
        kind: "agent",
        id: "agent-fixture",
        entityRevision: "2",
        projection: { turnState: "working" },
      }],
      createdAt: FIXTURE_TIME,
      contentSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  },
  {
    name: "flat assignment",
    schema: "flatAssignment",
    value: {
      assignmentId: FIXTURE_IDS.assignment,
      agentId: "agent-fixture",
      assignmentGeneration: "1",
      state: "open",
      openedAt: FIXTURE_TIME,
      closedAt: null,
    },
  },
  {
    name: "hv1 capability constraints",
    schema: "hv1CapabilityRecord",
    value: {
      id: "018f1e90-7b5a-7cc0-8000-000000000008",
      subject: "operator",
      role: "operator",
      epoch: 0,
      constraints: { content: true, scope: "operator" },
      subjects: ["agent-fixture"],
      issuedAt: FIXTURE_TIME,
      expiresAt: "2026-07-17T12:00:00.000Z",
      revokedAt: null,
    },
  },
  {
    name: "workspace event code-unit case ordering",
    schema: "workspaceEventV2",
    value: {
      schemaVersion: 2,
      eventId: "evt_018f1e90-7b5a-7cc0-8000-000000000009",
      seq: "3",
      entity: { kind: "agent", id: "agent-case-order" },
      entityRevision: "1",
      occurredAt: FIXTURE_TIME,
      kind: "agent.status-reported",
      source: {
        kind: "agent-report",
        id: "agent-case-order",
        observedAt: FIXTURE_TIME,
        confidence: "authoritative",
      },
      data: { B: "upper", a: "lower" },
    },
  },
  {
    name: "workspace event code-unit numeric ordering",
    schema: "workspaceEventV2",
    value: {
      schemaVersion: 2,
      eventId: "evt_018f1e90-7b5a-7cc0-8000-00000000000a",
      seq: "4",
      entity: { kind: "agent", id: "agent-numeric-order" },
      entityRevision: "1",
      occurredAt: FIXTURE_TIME,
      kind: "agent.status-reported",
      source: {
        kind: "agent-report",
        id: "agent-numeric-order",
        observedAt: FIXTURE_TIME,
        confidence: "authoritative",
      },
      data: { a10: "ten", a9: "nine" },
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
  { name: "LIST neutral inventory", schema: "listPayload", value: { schemaVersion: 1 } },
  { name: "LISTED frozen inventory", schema: "listedPayload", value: { schemaVersion: 1, entries: [fixtureTerminalHostInspection] } },
  { name: "INSPECT neutral session", schema: "inspectPayload", value: { schemaVersion: 1, session: fixtureTerminalHostSession } },
  { name: "INSPECTED frozen evidence", schema: "inspectedPayload", value: { schemaVersion: 1, ...fixtureTerminalHostInspection } },
  { name: "TERMINATE frozen request", schema: "terminatePayload", value: { schemaVersion: 1, ...fixtureTerminalHostTerminationRequest } },
  { name: "TERMINATED frozen result", schema: "terminatedPayload", value: { schemaVersion: 1, ...fixtureTerminalHostTerminationResult } },
  { name: "VISIBILITY_RENEW exact generation", schema: "visibilityRenewPayload", value: { schemaVersion: 1, locator: fixtureLocator, ...fixtureVisibilityRequest } },
  { name: "RENEWED lease", schema: "renewedPayload", value: { schemaVersion: 1, ...fixtureVisibilityLease } },
  { name: "INPUT_ORPHAN_DISCARD resolves an orphaned exact generation", schema: "orphanDiscardPayload", value: { schemaVersion: 1, locator: fixtureLocator, mode: "orphaned" } },
  { name: "INPUT_ORPHAN_DISCARD authorizes a held-claim preemption", schema: "orphanDiscardPayload", value: { schemaVersion: 1, locator: fixtureLocator, mode: "held" } },
  { name: "ORPHAN_DISCARDED names the prior orphan owner and host age", schema: "orphanDiscardedPayload", value: { schemaVersion: 1, state: "discarded", priorOwnerViewerId: "viewer-a", priorClaimId: "clm_018f1e90-7b5a-7cc0-8000-000000000001", orphanAgeMilliseconds: "120000", diagnostic: "orphaned human claim discarded" } },
  { name: "ORPHAN_DISCARDED types a held human preemption", schema: "orphanDiscardedPayload", value: { schemaVersion: 1, state: "preempted", priorOwnerViewerId: "viewer-a", priorClaimId: "clm_018f1e90-7b5a-7cc0-8000-000000000001", orphanAgeMilliseconds: null, diagnostic: "held human claim preempted for delivery" } },
  { name: "ATTACH_REQUEST exact generation", schema: "attachRequestPayload", value: { schemaVersion: 1, locator: fixtureLocator, ...fixtureAttachRequest } },
  { name: "ATTACH_GRANT exact host", schema: "attachGrantPayload", value: { schemaVersion: 1, ...fixtureAttachGrant } },
  { name: "HOST_ATTACH replay cursor", schema: "hostAttachPayload", value: { schemaVersion: 1, locator: fixtureLocator, token: "opaque-token", geometry: fixtureGeometry, afterSeq: "4096" } },
  { name: "WELCOME broker", schema: "welcomePayload", value: fixtureWelcome },
  { name: "typed ERROR", schema: "errorPayload", value: { schemaVersion: 1, code: "UNAUTHENTICATED", message: "grant rejected", diagnosticId: null } },
  { name: "typed generation-gone ERROR", schema: "errorPayload", value: { schemaVersion: 1, code: "GENERATION_GONE", message: "generation is gone", diagnosticId: null } },
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
    name: "frozen neutral create request",
    schema: "terminalHostCreateRequest",
    value: fixtureTerminalHostCreateRequest,
  },
  {
    name: "frozen neutral create result",
    schema: "terminalHostCreateResult",
    value: fixtureTerminalHostCreateResult,
  },
  {
    name: "frozen neutral checkpoint",
    schema: "terminalHostCheckpoint",
    value: fixtureTerminalHostCheckpoint,
  },
  {
    name: "frozen neutral inspection",
    schema: "terminalHostSessionInspection",
    value: fixtureTerminalHostInspection,
  },
  {
    name: "frozen neutral resize request",
    schema: "terminalHostResizeRequest",
    value: fixtureTerminalHostResizeRequest,
  },
  {
    name: "frozen neutral resize receipt reports the post-set readback",
    schema: "terminalHostResizeReceipt",
    value: fixtureTerminalHostResizeReceipt,
  },
  {
    name: "frozen neutral attach request negotiates protocol and checkpoints",
    schema: "terminalHostAttachRequest",
    value: fixtureTerminalHostAttachRequest,
  },
  {
    name: "frozen neutral attach result resumes at a host-reported cursor",
    schema: "terminalHostAttachResult",
    value: fixtureTerminalHostAttachResult,
  },
  {
    name: "frozen neutral attach result reports an out-of-retention gap",
    schema: "terminalHostAttachResult",
    value: fixtureTerminalHostAttachGap,
  },
  {
    name: "frozen neutral attach cursor may bind no applied checkpoint",
    schema: "terminalHostAttachRequest",
    value: {
      ...fixtureTerminalHostAttachRequest,
      cursor: { ...fixtureTerminalHostAttachRequest.cursor, checkpoint: null },
    },
  },
  {
    name: "frozen neutral subscribe request negotiates limits from an event position",
    schema: "terminalHostSubscribeRequest",
    value: fixtureTerminalHostSubscribeRequest,
  },
  {
    name: "frozen neutral subscribe request may begin at the current end",
    schema: "terminalHostSubscribeRequest",
    value: { ...fixtureTerminalHostSubscribeRequest, from: { position: "end" } },
  },
  {
    name: "frozen neutral subscribe result resumes at a host-reported cursor",
    schema: "terminalHostSubscribeResult",
    value: fixtureTerminalHostSubscribeResult,
  },
  {
    name: "frozen neutral subscribe result reports an out-of-retention event gap",
    schema: "terminalHostSubscribeResult",
    value: fixtureTerminalHostSubscribeGap,
  },
  {
    name: "frozen neutral visibility renewal repeats the complete request",
    schema: "terminalHostVisibilityRenewalRequest",
    value: fixtureTerminalHostVisibilityRenewalRequest,
  },
  {
    name: "frozen neutral visibility renewal returns a new active bounded lease",
    schema: "terminalHostVisibilityRenewalResult",
    value: fixtureTerminalHostVisibilityRenewalResult,
  },
  {
    name: "frozen neutral visibility renewal rejects with one typed reason",
    schema: "terminalHostVisibilityRenewalResult",
    value: {
      state: "rejected",
      renewed: false,
      reason: "stale-revision",
      diagnostic: "revision 19 is behind the source",
    },
  },
  {
    name: "frozen neutral visibility renewal reports incomplete evidence as unknown",
    schema: "terminalHostVisibilityRenewalResult",
    value: { state: "unknown", renewed: false, diagnostic: "inventory revision unavailable" },
  },
  {
    name: "frozen neutral termination request",
    schema: "terminalHostTerminationRequest",
    value: fixtureTerminalHostTerminationRequest,
  },
  {
    name: "frozen neutral termination result",
    schema: "terminalHostTerminationResult",
    value: fixtureTerminalHostTerminationResult,
  },
  {
    name: "CLAIM_ACQUIRE frozen request",
    schema: "claimAcquirePayload",
    value: {
      schemaVersion: 1,
      session: fixtureTerminalHostSession,
      writer: fixtureTerminalHostClaim.writer,
      kind: fixtureTerminalHostClaim.kind,
      leaseMilliseconds: 15_000,
      idempotencyKey: "claim-fixture-key",
    },
  },
  {
    name: "CLAIM_RESULT frozen grant",
    schema: "claimResultPayload",
    value: { schemaVersion: 1, result: { state: "granted", claim: fixtureTerminalHostClaim } },
  },
  {
    name: "INPUT_SUBMIT frozen byte operation",
    schema: "inputSubmitPayload",
    value: {
      schemaVersion: 1,
      session: fixtureTerminalHostSession,
      claimToken: fixtureTerminalHostClaim.token,
      transactionId: fixtureTerminalHostReceipt.transactionId,
      idempotencyKey: "input-fixture-key",
      operation: { kind: "bytes", encoding: "base64", bytes: "aGVsbG8=" },
    },
  },
  {
    name: "RESIZE frozen request",
    schema: "resizePayload",
    value: {
      schemaVersion: 1,
      session: fixtureTerminalHostSession,
      window: fixtureTerminalHostResize.readback,
      revision: fixtureTerminalHostResize.revision,
      idempotencyKey: "resize-fixture-key",
    },
  },
  {
    name: "APPLIED frozen input receipt",
    schema: "appliedPayload",
    value: { schemaVersion: 1, resultKind: "input", receipt: fixtureTerminalHostReceipt },
  },
  {
    name: "APPLIED frozen resize receipt",
    schema: "appliedPayload",
    value: { schemaVersion: 1, resultKind: "resize", result: fixtureTerminalHostResize },
  },
  {
    name: "APPLIED frozen output acknowledgement",
    schema: "appliedPayload",
    value: { schemaVersion: 1, resultKind: "output", throughSeq: "262144" },
  },
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
      requestId: FIXTURE_IDS.request,
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
  { name: "snapshot rejects malformed digest", schema: "workspaceSnapshotV2", value: { ...(validCases[21]!.value as object), contentSha256: "bad" } },
  { name: "assignment generation starts at one", schema: "flatAssignment", value: { ...(validCases[22]!.value as object), assignmentGeneration: "0" } },
  { name: "operator scope requires subjects", schema: "hv1CapabilityRecord", value: { ...(validCases[23]!.value as object), subjects: undefined } },
  { name: "status update requires stable request id", schema: "hiveUpdateStatusInput", value: { ...(validCases[18]!.value as object), requestId: undefined } },
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
  { name: "LIST rejects Hive scope", schema: "listPayload", value: { schemaVersion: 1, instanceId: fixtureLocator.instanceId } },
  { name: "LISTED rejects missing entries", schema: "listedPayload", value: { schemaVersion: 1 } },
  { name: "INSPECT rejects missing session", schema: "inspectPayload", value: { schemaVersion: 1 } },
  { name: "INSPECTED rejects unknown field", schema: "inspectedPayload", value: { schemaVersion: 1, ...fixtureTerminalHostInspection, trusted: true } },
  { name: "TERMINATE rejects missing target", schema: "terminatePayload", value: { schemaVersion: 1, ...fixtureTerminalHostTerminationRequest, target: undefined } },
  { name: "TERMINATED rejects missing reap", schema: "terminatedPayload", value: { schemaVersion: 1, ...fixtureTerminalHostTerminationResult, reap: undefined } },
  { name: "VISIBILITY_RENEW rejects missing locator", schema: "visibilityRenewPayload", value: { schemaVersion: 1, ...fixtureVisibilityRequest } },
  { name: "RENEWED rejects missing locator", schema: "renewedPayload", value: { schemaVersion: 1, state: "active", expiresAt: fixtureVisibilityLease.expiresAt, openTerminalRevision: "7" } },
  { name: "INPUT_ORPHAN_DISCARD rejects missing locator", schema: "orphanDiscardPayload", value: { schemaVersion: 1 } },
  { name: "INPUT_ORPHAN_DISCARD rejects an untyped resolution mode", schema: "orphanDiscardPayload", value: { schemaVersion: 1, locator: fixtureLocator, mode: "live" } },
  { name: "ORPHAN_DISCARDED rejects a missing typed state", schema: "orphanDiscardedPayload", value: { schemaVersion: 1, priorOwnerViewerId: null, priorClaimId: null, orphanAgeMilliseconds: null, diagnostic: "missing state" } },
  { name: "ATTACH_REQUEST rejects missing locator", schema: "attachRequestPayload", value: { schemaVersion: 1, ...fixtureAttachRequest } },
  { name: "ATTACH_GRANT rejects missing token", schema: "attachGrantPayload", value: { schemaVersion: 1, ...fixtureAttachGrant, token: undefined } },
  { name: "HOST_ATTACH rejects numeric replay cursor", schema: "hostAttachPayload", value: { schemaVersion: 1, locator: fixtureLocator, token: "opaque-token", geometry: fixtureGeometry, afterSeq: 4096 } },
  { name: "WELCOME rejects unknown field", schema: "welcomePayload", value: { ...fixtureWelcome, authority: true } },
  { name: "ERROR rejects unknown field", schema: "errorPayload", value: { schemaVersion: 1, code: "INTERNAL", message: "failure", diagnosticId: null, retry: true } },
  { name: "ERROR rejects an unknown typed code", schema: "errorPayload", value: { schemaVersion: 1, code: "GENERATION_ABSENT", message: "failure", diagnosticId: null } },
  { name: "PING rejects unknown field", schema: "pingPongPayload", value: { schemaVersion: 1, monoNanos: "1", wallTime: FIXTURE_TIME } },
  { name: "HOST_REGISTER rejects unknown field", schema: "hostRegisterPayload", value: { schemaVersion: 1, record: fixtureHostRecord, trusted: true } },
  { name: "HOST_ADOPT rejects unknown field", schema: "hostAdoptPayload", value: { ...fixtureAdoptRequest, trusted: true } },
  { name: "HOST_ADOPT rejects malformed secret", schema: "hostAdoptPayload", value: { ...fixtureAdoptRequest, adoptionSecretHex: "not-a-secret" } },
  { name: "GRANT_REGISTER rejects unknown field", schema: "grantRegisterPayload", value: { ...fixtureGrantRegistration, rawToken: "forbidden" } },
  { name: "GRANT_REGISTER rejects untagged hash", schema: "grantRegisterPayload", value: { ...fixtureGrantRegistration, grantTokenSha256: "b".repeat(64) } },
  {
    name: "frozen create request rejects Hive policy",
    schema: "terminalHostCreateRequest",
    value: { ...fixtureTerminalHostCreateRequest, visibility: fixtureVisibilityRequest },
  },
  {
    name: "frozen create result rejects collapsed launch failure",
    schema: "terminalHostCreateResult",
    value: { ...fixtureTerminalHostCreateResult, outcome: { state: "failed" } },
  },
  {
    name: "frozen checkpoint rejects malformed bytes",
    schema: "terminalHostCheckpoint",
    value: { ...fixtureTerminalHostCheckpoint, opaqueBytes: "not base64" },
  },
  {
    name: "frozen inspection requires reap evidence",
    schema: "terminalHostSessionInspection",
    value: { ...fixtureTerminalHostInspection, reap: undefined },
  },
  {
    name: "frozen resize request rejects a non-monotonic revision encoding",
    schema: "terminalHostResizeRequest",
    value: { ...fixtureTerminalHostResizeRequest, revision: "041" },
  },
  {
    name: "frozen resize receipt cannot claim the application handled it",
    schema: "terminalHostResizeReceipt",
    value: { ...fixtureTerminalHostResizeReceipt, applicationNotified: true },
  },
  {
    name: "frozen attach request rejects a reversed negotiation minor range",
    schema: "terminalHostAttachRequest",
    value: { ...fixtureTerminalHostAttachRequest, protocol: { major: 1, minMinor: 1, maxMinor: 0 } },
  },
  {
    name: "frozen attach result cannot claim it resumed inside a sequence",
    schema: "terminalHostAttachResult",
    value: { ...fixtureTerminalHostAttachResult, resumedMidSequence: false },
  },
  {
    name: "frozen subscribe request rejects a reversed negotiation minor range",
    schema: "terminalHostSubscribeRequest",
    value: { ...fixtureTerminalHostSubscribeRequest, protocol: { major: 1, minMinor: 1, maxMinor: 0 } },
  },
  {
    name: "frozen subscribe gap cannot drop its fresh-inspection requirement",
    schema: "terminalHostSubscribeResult",
    value: { ...fixtureTerminalHostSubscribeGap, freshInspection: "waived" },
  },
  {
    name: "frozen visibility renewal rejects a nonpositive inventory revision",
    schema: "terminalHostVisibilityRenewalRequest",
    value: {
      ...fixtureTerminalHostVisibilityRenewalRequest,
      visibility: { ...fixtureTerminalHostVisibilityRequest, inventoryRevision: "0" },
    },
  },
  {
    name: "frozen visibility renewal cannot reject for an untyped reason",
    schema: "terminalHostVisibilityRenewalResult",
    value: {
      state: "rejected",
      renewed: false,
      reason: "renderer-disconnect",
      diagnostic: "viewer went away",
    },
  },
  {
    name: "frozen visibility rejection cannot claim it renewed the lease",
    schema: "terminalHostVisibilityRenewalResult",
    value: {
      state: "rejected",
      renewed: true,
      reason: "lease-expired",
      diagnostic: "deadline already passed",
    },
  },
  {
    name: "frozen active lease cannot expire at the instant it was issued",
    schema: "terminalHostVisibilityRenewalResult",
    value: {
      ...fixtureTerminalHostVisibilityRenewalResult,
      lease: {
        ...fixtureTerminalHostVisibilityRenewalResult.lease,
        expiresAt: fixtureTerminalHostVisibilityRenewalResult.lease.issuedAt,
      },
    },
  },
  {
    name: "frozen termination request requires target",
    schema: "terminalHostTerminationRequest",
    value: { ...fixtureTerminalHostTerminationRequest, target: undefined },
  },
  {
    name: "frozen termination result requires completeness",
    schema: "terminalHostTerminationResult",
    value: { ...fixtureTerminalHostTerminationResult, completeness: undefined },
  },
  {
    name: "CLAIM_ACQUIRE rejects absent session fencing",
    schema: "claimAcquirePayload",
    value: { schemaVersion: 1, writer: "viewer", kind: "human", leaseMilliseconds: 1, idempotencyKey: "claim" },
  },
  {
    name: "CLAIM_RESULT rejects invented ownership",
    schema: "claimResultPayload",
    value: { schemaVersion: 1, result: { state: "denied", owner: null, diagnostic: "" } },
  },
  {
    name: "INPUT_SUBMIT rejects malformed base64",
    schema: "inputSubmitPayload",
    value: {
      schemaVersion: 1,
      session: fixtureTerminalHostSession,
      claimToken: fixtureTerminalHostClaim.token,
      transactionId: "terminal-input-fixture",
      idempotencyKey: "input-fixture-key",
      operation: { kind: "bytes", encoding: "base64", bytes: "not base64" },
    },
  },
  {
    name: "RESIZE rejects absent idempotency key",
    schema: "resizePayload",
    value: { schemaVersion: 1, session: fixtureTerminalHostSession, window: fixtureTerminalHostResize.readback, revision: "8" },
  },
  {
    name: "APPLIED rejects ambiguous result branch",
    schema: "appliedPayload",
    value: {
      schemaVersion: 1,
      resultKind: "input",
      receipt: fixtureTerminalHostReceipt,
      result: fixtureTerminalHostResize,
    },
  },
  {
    name: "APPLIED output acknowledgement rejects non-decimal high-water",
    schema: "appliedPayload",
    value: { schemaVersion: 1, resultKind: "output", throughSeq: "0x40" },
  },
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

export type ReducerProjection = StatusReducerProjection;
export const emptyReducerProjection = emptyStatusProjection;
export { canonicalJson };
export const reduceWorkspaceEvent = reduceStatusEvent;

const baseReducerEvents: readonly WorkspaceEventV2[] = [
  {
    schemaVersion: 2,
    eventId: FIXTURE_IDS.events[0],
    seq: "1",
    entity: { kind: "agent", id: "agent-fixture" },
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
    entity: { kind: "agent", id: "agent-fixture" },
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
  '{"data":{"phase":"planning","summary":"Reading contracts"},"entity":{"id":"agent-fixture","kind":"agent"},"entityRevision":"1","eventId":"evt_018f1e90-7b5a-7cc0-8000-000000000005","kind":"agent.status-reported","occurredAt":"2026-07-16T12:00:00.000Z","schemaVersion":2,"seq":"1","source":{"confidence":"authoritative","id":"agent-fixture:3","kind":"agent-report","observedAt":"2026-07-16T12:00:00.000Z"}}';
const HAND_AUTHORED_LOWER_FIRST_EVENT =
  '{"data":{"phase":"testing","summary":"Checking parity"},"entity":{"id":"agent-fixture","kind":"agent"},"entityRevision":"2","eventId":"evt_018f1e90-7b5a-7cc0-8000-000000000005","kind":"agent.status-reported","occurredAt":"2026-07-16T12:00:01.000Z","schemaVersion":2,"seq":"1","source":{"confidence":"authoritative","id":"agent-fixture:3","kind":"agent-report","observedAt":"2026-07-16T12:00:01.000Z"}}';
const HAND_AUTHORED_LOWER_SECOND_EVENT =
  '{"data":{"phase":"planning","summary":"Reading contracts"},"entity":{"id":"agent-fixture","kind":"agent"},"entityRevision":"1","eventId":"evt_018f1e90-7b5a-7cc0-8000-000000000006","kind":"agent.status-reported","occurredAt":"2026-07-16T12:00:00.000Z","schemaVersion":2,"seq":"2","source":{"confidence":"authoritative","id":"agent-fixture:3","kind":"agent-report","observedAt":"2026-07-16T12:00:00.000Z"}}';

const HAND_AUTHORED_PLANNING_PREFIX: ReducerProjection = {
  highWaterSeq: "1",
  paused: false,
  recovery: null,
  corruption: null,
  entities: {
    "agent:agent-fixture": {
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
    "agent:agent-fixture": {
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
    "agent:agent-fixture": {
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
    "agent:agent-fixture": {
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
  const caseOrdering = [{
    ...baseReducerEvents[0]!,
    eventId: "evt_018f1e90-7b5a-7cc0-8000-000000000009",
    data: { B: "upper", a: "lower" },
  }];
  const numericOrdering = [{
    ...baseReducerEvents[0]!,
    eventId: "evt_018f1e90-7b5a-7cc0-8000-00000000000a",
    data: { a10: "ten", a9: "nine" },
  }];
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
    {
      name: "code-unit-case-ordering",
      events: caseOrdering,
      prefixes: prefixesFor(caseOrdering),
    },
    {
      name: "code-unit-numeric-ordering",
      events: numericOrdering,
      prefixes: prefixesFor(numericOrdering),
    },
  ];
  const canonicalization = [
    {
      name: "code-unit-case-ordering",
      entities: [{
        kind: "agent",
        id: "agent-case-order",
        entityRevision: "1",
        projection: { B: "upper", a: "lower" },
      }],
    },
    {
      name: "code-unit-numeric-ordering",
      entities: [{
        kind: "agent",
        id: "agent-numeric-order",
        entityRevision: "1",
        projection: { a10: "ten", a9: "nine" },
      }],
    },
  ].map((fixture) => {
    const canonical = canonicalJson(fixture.entities);
    return {
      ...fixture,
      canonical,
      sha256: createHash("sha256").update(canonical).digest("hex"),
    };
  });
  return {
    schemaVersion: 1,
    canonicalization,
    scenarios: [...permutationScenarios, ...edgeScenarios],
  };
}
