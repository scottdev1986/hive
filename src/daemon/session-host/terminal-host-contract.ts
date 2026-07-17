/**
 * Project-neutral terminal host contract. All product policy belongs in an
 * adapter above this boundary.
 */
export const TERMINAL_HOST_CONTRACT_VERSION = "1.0.0" as const;

export type Completeness = "complete" | "partial" | "unavailable" | "unknown";
export type Sequence = string;
export type Incarnation = string;

export type SessionRef = Readonly<{
  key: string;
  incarnation: Incarnation;
}>;

export type ProcessIdentity = Readonly<{
  processId: number;
  startToken: string;
}>;

export type WindowSize = Readonly<{
  columns: number;
  rows: number;
  widthPixels: number;
  heightPixels: number;
}>;

export type TerminalProfile = Readonly<{
  inputMode: "canonical" | "literal";
  echo: boolean;
  signalCharacters: boolean;
  softwareFlowControl: boolean;
  eofByte: number;
  startByte: number;
  stopByte: number;
  hangupOnLastClose: boolean;
}>;

export type EnvironmentEntry = Readonly<{ name: string; value: string }>;

export type TransferableHandle = Readonly<{
  token: string;
  sourceDisposition: "retain" | "close-after-transfer";
}>;

export type DescriptorMapping = Readonly<{
  handle: TransferableHandle;
  targetDescriptor: number;
}>;

export type Command = Readonly<{
  executable: string;
  arguments: readonly string[];
  workingDirectory: string;
  completeEnvironment: readonly EnvironmentEntry[];
  descriptorMap: readonly DescriptorMapping[];
}>;

export type HostLimits = Readonly<{
  maxInputTransactionBytes: number;
  maxInputQueueBytes: number;
  maxOutputFrameBytes: number;
  outputLowWaterBytes: number;
  outputHighWaterBytes: number;
  outputRetentionBytes: number;
}>;

export type JobControlEvidence = Readonly<{
  sessionLeader: boolean;
  controllingTerminal: boolean;
  standardStreamsShareTerminal: boolean;
  childSessionId: number;
  childProcessGroupId: number;
  foregroundProcessGroupId: number;
  terminalIdentity: string;
  initialProfileAppliedBeforeExec: boolean;
  initialWindowAppliedBeforeExec: boolean;
  completeness: Completeness;
}>;

export type ExitStatus = Readonly<{
  code: number | null;
  signal: number | null;
  observedAt: string;
}>;

export type ReapEvidence = Readonly<{
  authority: "direct-parent" | "durable-parent-record" | "unavailable";
  reaped: boolean;
  status: ExitStatus | null;
  completeness: Completeness;
}>;

export type LaunchFailureLayer =
  | "command"
  | "working-directory"
  | "environment"
  | "descriptor-transfer"
  | "terminal-setup"
  | "exec-transition";

export type LaunchOutcome =
  | Readonly<{
      state: "running";
      child: ProcessIdentity;
      execProof: "replacement-observed";
      jobControl: JobControlEvidence;
    }>
  | Readonly<{
      state: "exec-failed";
      layer: LaunchFailureLayer;
      osCode: string | number | null;
      diagnostic: string;
    }>
  | Readonly<{ state: "exited"; exit: ExitStatus; reap: ReapEvidence }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;

export type CreateRequest = Readonly<{
  key: string;
  idempotencyKey: string;
  command: Command;
  terminalProfile: TerminalProfile;
  initialWindow: WindowSize;
}>;

export type CreateResult = Readonly<{
  session: SessionRef;
  outcome: LaunchOutcome;
  limits: HostLimits;
}>;

export type InputClaim = Readonly<{
  token: string;
  writer: string;
  kind: "human" | "automation";
  leaseExpiresAt: string;
}>;

export type ClaimResult =
  | Readonly<{ state: "granted"; claim: InputClaim }>
  | Readonly<{ state: "denied"; owner: InputClaim | null; diagnostic: string }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;

export type InputOperation =
  | Readonly<{ kind: "bytes"; bytes: Uint8Array }>
  | Readonly<{ kind: "canonical-end-of-file" }>
  | Readonly<{ kind: "hangup" }>;

export type InputReceipt = Readonly<{
  transactionId: string;
  stage: "accepted" | "queued" | "written-to-terminal" | "rejected" | "unknown";
  byteRange: Readonly<{ start: Sequence; endExclusive: Sequence }> | null;
  orderedAt: Sequence | null;
  availableCreditBytes: number;
  consumedByProcess: "not-claimed";
  completeness: Completeness;
  diagnostic: string | null;
}>;

export type ResizeResult =
  | Readonly<{
      state: "applied";
      revision: Sequence;
      readback: WindowSize;
      orderedAt: Sequence;
      foregroundProcessObservation: "not-claimed";
    }>
  | Readonly<{ state: "stale"; currentRevision: Sequence }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;

export type Checkpoint = Readonly<{
  contentType: string;
  schemaVersion: string;
  hashAlgorithm: "sha256";
  hash: string;
  throughEventSequence: Sequence;
  throughOutputOffset: Sequence;
  opaqueBytes: Uint8Array;
}>;

export type AttachCursor = Readonly<{
  afterEventSequence: Sequence;
  afterOutputOffset: Sequence;
  checkpoint: Readonly<{
    contentType: string;
    schemaVersion: string;
    hash: string;
    throughEventSequence: Sequence;
    throughOutputOffset: Sequence;
  }> | null;
}>;

export type AttachCapabilities = Readonly<{
  protocolVersions: readonly string[];
  checkpointContentTypes: readonly string[];
  buildId: string;
}>;

export type AttachResult =
  | Readonly<{
      state: "attached";
      attachmentId: string;
      negotiatedProtocol: string;
      hostBuildId: string;
      cursor: AttachCursor;
      checkpoint: Checkpoint | null;
      limits: HostLimits;
    }>
  | Readonly<{
      state: "gap";
      retainedOutput: Readonly<{ start: Sequence; endExclusive: Sequence }>;
      requiredCheckpoint: Checkpoint;
    }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;

type OrderedEventBase = Readonly<{
  session: SessionRef;
  eventSequence: Sequence;
  occurredAt: string;
}>;

export type TerminalEvent =
  | (OrderedEventBase & Readonly<{
      kind: "output";
      bytes: Uint8Array;
      outputRange: Readonly<{ start: Sequence; endExclusive: Sequence }>;
    }>)
  | (OrderedEventBase & Readonly<{
      kind: "output-gap";
      missingRange: Readonly<{ start: Sequence; endExclusive: Sequence }>;
      checkpointRequired: boolean;
    }>)
  | (OrderedEventBase & Readonly<{ kind: "output-closed"; reason: string }>)
  | (OrderedEventBase & Readonly<{ kind: "process-exited"; exit: ExitStatus }>)
  | (OrderedEventBase & Readonly<{ kind: "process-reaped"; reap: ReapEvidence }>)
  | (OrderedEventBase & Readonly<{ kind: "checkpoint"; checkpoint: Checkpoint }>)
  | (OrderedEventBase & Readonly<{
      kind: "resize-applied";
      revision: Sequence;
      readback: WindowSize;
    }>)
  | (OrderedEventBase & Readonly<{ kind: "flow-control"; outputPaused: boolean }>);

export type SessionInspection = Readonly<{
  session: SessionRef;
  lifecycle: "creating" | "running" | "exited" | "lost" | "unknown";
  completeness: Completeness;
  host: ProcessIdentity | null;
  child: ProcessIdentity | null;
  jobControl: JobControlEvidence | null;
  window: Readonly<{ value: WindowSize; revision: Sequence }>;
  output: Readonly<{
    closed: boolean;
    retained: Readonly<{ start: Sequence; endExclusive: Sequence }>;
  }>;
  checkpoints: Readonly<{
    retained: number;
    newest: Checkpoint | null;
  }>;
  inputOwner: InputClaim | null;
  exit: ExitStatus | null;
  reap: ReapEvidence;
  descendants: readonly ProcessIdentity[];
  survivors: readonly Readonly<{ process: ProcessIdentity; reason: string }>[];
  evidenceAt: string;
  diagnostics: readonly string[];
}>;

export type OutputAcknowledgement = Readonly<{
  throughEventSequence: Sequence;
  throughOutputOffset: Sequence;
  availableCreditBytes: number;
}>;

export type TerminationResult = Readonly<{
  state: "terminated" | "survivors" | "unknown";
  exit: ExitStatus | null;
  reap: ReapEvidence;
  survivors: readonly Readonly<{ process: ProcessIdentity; reason: string }>[];
  completeness: Completeness;
  diagnostics: readonly string[];
}>;

export interface TerminalHost {
  create(request: CreateRequest): Promise<CreateResult>;
  claimInput(request: Readonly<{
    session: SessionRef;
    writer: string;
    kind: "human" | "automation";
    leaseMilliseconds: number;
    idempotencyKey: string;
  }>): Promise<ClaimResult>;
  releaseInput(request: Readonly<{
    session: SessionRef;
    claimToken: string;
    idempotencyKey: string;
  }>): Promise<void>;
  submitInput(request: Readonly<{
    session: SessionRef;
    claimToken: string;
    transactionId: string;
    idempotencyKey: string;
    operation: InputOperation;
  }>): Promise<InputReceipt>;
  resize(request: Readonly<{
    session: SessionRef;
    window: WindowSize;
    revision: Sequence;
    idempotencyKey: string;
  }>): Promise<ResizeResult>;
  attach(request: Readonly<{
    session: SessionRef;
    cursor: AttachCursor;
    capabilities: AttachCapabilities;
  }>): Promise<AttachResult>;
  acknowledgeOutput(request: Readonly<{
    session: SessionRef;
    attachmentId: string;
    throughEventSequence: Sequence;
    throughOutputOffset: Sequence;
  }>): Promise<OutputAcknowledgement>;
  inspect(session: SessionRef): Promise<SessionInspection>;
  list(): Promise<readonly SessionInspection[]>;
  subscribe(request: Readonly<{
    session: SessionRef;
    afterEventSequence: Sequence;
  }>): AsyncIterable<TerminalEvent>;
  terminate(request: Readonly<{
    session: SessionRef;
    mode: "graceful" | "immediate";
    target: "foreground-group" | "session-members" | "process-tree";
    deadline: string;
    idempotencyKey: string;
  }>): Promise<TerminationResult>;
}
