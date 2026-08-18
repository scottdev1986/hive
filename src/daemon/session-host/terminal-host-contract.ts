export const TERMINAL_HOST_CONTRACT_VERSION = "1.0.0" as const;

import type {
  Checkpoint,
  ExitStatus,
  HostLimits,
  InputReceipt,
  ReapEvidence,
  SessionRef,
  TerminalHostCreateRequest as CreateRequest,
  TerminalHostCreateResult as CreateResult,
  TerminalHostResizeResult as ResizeResult,
  TerminalHostSessionInspection as SessionInspection,
  TerminalHostTerminationResult as TerminationResult,
  WindowSize,
} from "../../schemas/session-protocol";

export type {
  Checkpoint,
  Command,
  Completeness,
  EnvironmentEntry,
  ExitStatus,
  HostLimits,
  InputReceipt,
  JobControlEvidence,
  LaunchFailureLayer,
  LaunchOutcome,
  ProcessIdentity,
  ReapEvidence,
  SessionRef,
  TerminalHostCreateRequest as CreateRequest,
  TerminalHostCreateResult as CreateResult,
  TerminalHostResizeResult as ResizeResult,
  TerminalHostSessionInspection as SessionInspection,
  TerminalHostTerminationResult as TerminationResult,
  TerminalProfile,
  WindowSize,
} from "../../schemas/session-protocol";

export type Sequence = string;
export type Incarnation = string;

export type TransferableHandle = Readonly<{
  token: string;
  sourceDisposition: "retain" | "close-after-transfer";
}>;

export type DescriptorMapping = Readonly<{
  handle: TransferableHandle;
  targetDescriptor: number;
}>;

export type InputOperation =
  | Readonly<{ kind: "bytes"; bytes: Uint8Array }>
  | Readonly<{ kind: "canonical-end-of-file" }>
  | Readonly<{ kind: "hangup" }>;

export type ExpectedForeground = Readonly<{
  pid: number;
  startToken: string;
  processGroupId: number;
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
  | (OrderedEventBase &
      Readonly<{
        kind: "output";
        bytes: Uint8Array;
        outputRange: Readonly<{ start: Sequence; endExclusive: Sequence }>;
      }>)
  | (OrderedEventBase &
      Readonly<{
        kind: "output-gap";
        missingRange: Readonly<{ start: Sequence; endExclusive: Sequence }>;
        checkpointRequired: boolean;
      }>)
  | (OrderedEventBase & Readonly<{ kind: "output-closed"; reason: string }>)
  | (OrderedEventBase & Readonly<{ kind: "process-exited"; exit: ExitStatus }>)
  | (OrderedEventBase &
      Readonly<{ kind: "process-reaped"; reap: ReapEvidence }>)
  | (OrderedEventBase &
      Readonly<{ kind: "checkpoint"; checkpoint: Checkpoint }>)
  | (OrderedEventBase &
      Readonly<{
        kind: "resize-applied";
        revision: Sequence;
        readback: WindowSize;
      }>)
  | (OrderedEventBase &
      Readonly<{ kind: "flow-control"; outputPaused: boolean }>);

export type OutputAcknowledgement = Readonly<{
  throughEventSequence: Sequence;
  throughOutputOffset: Sequence;
  availableCreditBytes: number;
}>;

export type SubscriptionCapabilities = Readonly<{
  protocolVersions: readonly string[];
}>;

/** Retained events are bounded and released by acknowledgement. Events are counted rather than measured, so every bound but the frame cap is a count. */
export type SubscriptionLimits = Readonly<{
  maxEventFrameBytes: number;
  retainedEventCount: number;
  unacknowledgedEventLowWater: number;
  unacknowledgedEventHighWater: number;
}>;

export type SubscriptionCursor = Readonly<{
  eventSequence: Sequence;
  outputOffset: Sequence;
}>;

export type SubscriptionStart =
  | Readonly<{ position: "at"; cursor: SubscriptionCursor }>
  | Readonly<{ position: "end" }>;

export type SubscribeResult =
  | Readonly<{
      state: "subscribed";
      subscriptionId: string;
      negotiatedProtocol: string;
      limits: SubscriptionLimits;
      resumeFrom: SubscriptionCursor;
    }>
  | Readonly<{
      state: "gap";
      missing: Readonly<{ start: Sequence; endExclusive: Sequence }>;
      freshInspection: "required";
    }>
  | Readonly<{ state: "unknown"; diagnostic: string }>;

export type EventAcknowledgement = Readonly<{
  subscriptionId: string;
  through: SubscriptionCursor;
  availableEventCredit: number;
}>;

export interface TerminalHost {
  create(request: CreateRequest): Promise<CreateResult>;
  submitInput(
    request: Readonly<{
      session: SessionRef;
      provenance: "user" | "automation" | "terminal";
      action: "edit" | "submit" | "cancel" | "gesture" | "deliver" | "keys";
      transactionId: string;
      idempotencyKey: string;
      expectedForeground?: ExpectedForeground;
      operation: InputOperation;
    }>,
  ): Promise<InputReceipt>;
  resize(
    request: Readonly<{
      session: SessionRef;
      window: WindowSize;
      revision: Sequence;
      idempotencyKey: string;
    }>,
  ): Promise<ResizeResult>;
  attach(
    request: Readonly<{
      session: SessionRef;
      cursor: AttachCursor;
      capabilities: AttachCapabilities;
    }>,
  ): Promise<AttachResult>;
  acknowledgeOutput(
    request: Readonly<{
      session: SessionRef;
      attachmentId: string;
      throughEventSequence: Sequence;
      throughOutputOffset: Sequence;
    }>,
  ): Promise<OutputAcknowledgement>;
  inspect(session: SessionRef): Promise<SessionInspection>;
  list(): Promise<readonly SessionInspection[]>;
  /** A subscription is a resumable cursor, not a boolean: it negotiates capabilities and event flow-control limits and begins at a caller-supplied event position or at the current end. A position outside retention is a gap, never silent loss. */
  subscribe(
    request: Readonly<{
      session: SessionRef;
      capabilities: SubscriptionCapabilities;
      limits: SubscriptionLimits;
      from: SubscriptionStart;
    }>,
  ): Promise<SubscribeResult>;
  /** Delivery for one subscription. Subscribers are independent, so this is keyed by subscription and never by session alone. */
  events(
    request: Readonly<{
      session: SessionRef;
      subscriptionId: string;
    }>,
  ): AsyncIterable<TerminalEvent>;
  acknowledgeEvents(
    request: Readonly<{
      session: SessionRef;
      subscriptionId: string;
      through: SubscriptionCursor;
    }>,
  ): Promise<EventAcknowledgement>;
  terminate(
    request: Readonly<{
      session: SessionRef;
      mode: "graceful" | "immediate";
      target: "foreground-group" | "session-members" | "process-tree";
      deadline: string;
      idempotencyKey: string;
    }>,
  ): Promise<TerminationResult>;
}
