export type SessionSubject =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "agent"; agentId: string }>; // stable database UUID, never display name

export type SessionLocator = Readonly<{
  schemaVersion: 1;
  instanceId: string;     // hiveInstanceSuffix(resolveHiveHome())
  subject: SessionSubject;
  generation: number;     // positive, monotonically increasing per subject
  sessionId: string;      // random ses_ UUIDv7
  hostKind: "tmux" | "sessiond";
  engineBuildId: string | null;
}>;

export type SessionSpec = Readonly<{
  schemaVersion: 1;
  locator: SessionLocator;
  provider: "claude" | "codex" | "grok";
  toolSessionId: string | null;
  cwd: string;                    // canonical absolute worktree/repository path
  argv: readonly [string, ...string[]];
  environment: Readonly<Record<string, string>>;
  expectedExecutable: string;     // exact argv[0] identity after resolution
  readOnly: boolean;
  capabilityEpoch: number;
  geometry: TerminalGeometry;
  launchGrantId: string;          // daemon-side authorized-launch record
  launchGrantRevision: number;
}>;

export type TerminalGeometry = Readonly<{
  columns: number; rows: number;
  widthPx: number; heightPx: number;
  cellWidthPx: number; cellHeightPx: number;
}>;

export interface SessionHost {
  create(spec: SessionSpec, initialInput: Uint8Array): Promise<CreateResult>;
  inspect(locator: SessionLocator): Promise<SessionInspection>;
  list(instanceId: string): Promise<readonly SessionInspection[]>;
  capture(locator: SessionLocator, request: CaptureRequest): Promise<CaptureResult>;
  issueAttach(locator: SessionLocator, request: AttachRequest): Promise<AttachGrant>;
  renewVisibility(locator: SessionLocator, request: VisibilityRequest): Promise<VisibilityLease>;
  resize(locator: SessionLocator, geometry: TerminalGeometry): Promise<ResizeResult>;
  writeAutomated(locator: SessionLocator, input: AutomatedInput): Promise<InputReceipt>;
  terminate(locator: SessionLocator, request: TerminationRequest): Promise<TerminationResult>;
  subscribe(afterEventSeq: string): AsyncIterable<SessionEvent>;
}

export type SessionInspection = Readonly<{
  schemaVersion: 1; locator: SessionLocator;
  presence: "present" | "exited" | "lost" | "unknown";
  complete: boolean; hostPid: number | null; hostStartToken: string | null;
  providerRoot: { pid: number; startToken: string; processGroupId: number } | null;
  expectedExecutable: string; executableVerified: boolean;
  outputSeq: string; checkpointSeq: string; checkpointAvailable: boolean;
  input: { state: string; ownerViewerId: string | null; claimId: string | null };
  viewerCount: number; geometry: TerminalGeometry; resources: Readonly<Record<string, number>>;
  visibility: { state: "attaching" | "visible" | "reconnecting" | "expired";
    workspaceSessionId: string; openTerminalRevision: string; expiresAt: string };
  exit: { code: number | null; signal: number | null; observedAt: string } | null;
  survivors: readonly { pid: number; startToken: string; reason: string }[];
  evidenceAt: string; diagnosticIds: readonly string[];
}>;

export type CreateResult = Readonly<{
  locator: SessionLocator; inspection: SessionInspection; created: true;
}>;
export type CaptureRequest = Readonly<{
  include: "metadata" | "visible-text"; maxRows: number; expectedOutputSeq?: string;
}>;
export type CaptureResult = Readonly<{
  locator: SessionLocator; outputSeq: string; columns: number; rows: number;
  screen: "primary" | "alternate"; cursor: { row: number; column: number; visible: boolean };
  text: string | null; truncated: boolean; sha256: string;
}>;
export type AttachRequest = Readonly<{
  viewerId: string; geometry: TerminalGeometry;
  operations: readonly ("view" | "human-input" | "resize")[];
}>;
export type AttachGrant = Readonly<{
  locator: SessionLocator; endpoint: string; token: string; expiresAt: string;
  engineBuildId: string; checkpointSeq: string; outputSeq: string;
  operations: readonly ("view" | "human-input" | "resize")[];
}>;
export type VisibilityRequest = Readonly<{
  workspaceSessionId: string; workspacePid: number; workspaceStartToken: string;
  openTerminalRevision: string;
}>;
export type VisibilityLease = Readonly<{
  locator: SessionLocator; state: "active"; expiresAt: string;
  openTerminalRevision: string;
}>;
export type ResizeResult = Readonly<{ locator: SessionLocator; geometry: TerminalGeometry; revision: string }>;
export type AutomatedInput = Readonly<{
  transactionId: string; idempotencyKey: string; messageId: string;
  recipientGeneration: number; capabilityEpoch: number; bytes: Uint8Array; sha256: string;
  providerStrategy: string; submit: "none" | "return" | "control-enter";
}>;
export type InputReceipt = Readonly<{
  transactionId: string; messageId: string;
  state: "queued" | "buffered" | "committed" | "written" | "in-doubt";
  byteRange: { start: string; endExclusive: string } | null;
  providerObservation: "unavailable" | "pending" | "observed";
  evidenceAt: string; diagnosticId: string | null;
}>;
export type TerminationRequest = Readonly<{
  mode: "graceful" | "immediate"; reason: string; requestId: string;
}>;
export type TerminationResult = Readonly<{
  locator: SessionLocator; state: "terminated" | "survivors" | "unknown";
  exit: SessionInspection["exit"];
  survivors: SessionInspection["survivors"];
  errors: readonly { phase: string; code: string; diagnosticId: string }[];
}>;
export type SessionEvent = Readonly<{
  schemaVersion: 1; eventId: string; eventSeq: string; locator: SessionLocator;
  kind: string; revision: string; occurredAt: string; data: Readonly<Record<string, unknown>>;
}>;
