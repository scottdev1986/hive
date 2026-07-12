export type Vendor = "claude" | "codex";

export type Boundary =
  | "before_accept"
  | "after_accept_before_write"
  | "after_write_before_first_event"
  | "during_tool_approval"
  | "after_provider_final_before_wal"
  | "after_wal_before_broker_ack";

export type CrashTarget = "ui" | "broker" | "host" | "provider";

export type InFlightPhase =
  | "idle"
  | "before_accept"
  | "accepted"
  | "written"
  | "running"
  | "awaiting_approval"
  | "provider_final"
  | "terminal_durable"
  | "unknown_outcome"
  | "wal_overflow";

export interface CommandEnvelope {
  commandId: string;
  brokerGeneration: number;
  sessionEpoch: number;
  prompt: string;
  explicitReconcile?: boolean;
}

export interface ChildIdentity {
  pid: number;
  processGroupId: number;
  executable: string;
  executableBindingHash: string;
  argvHash: string;
  vendor: Vendor;
}

export interface SemanticEvent {
  sequence: number;
  providerEventId: string;
  commandId: string;
  brokerGeneration: number;
  sessionEpoch: number;
  observedAt: string;
  type: string;
  payload: Record<string, unknown>;
}

export type WalRecord =
  | { kind: "CHILD"; at: string; child: ChildIdentity }
  | { kind: "ACCEPTED"; at: string; command: Omit<CommandEnvelope, "prompt"> }
  | { kind: "COMMAND_WRITTEN"; at: string; commandId: string }
  | { kind: "APPROVAL_WRITTEN"; at: string; approvalId: string; decision: "approve" | "deny" }
  | { kind: "EVENT"; at: string; event: SemanticEvent }
  | { kind: "ACK"; at: string; highWaterMark: number };

export interface HostConfig {
  tenantId: string;
  authToken: string;
  vendor: Vendor;
  socketPath: string;
  stateDir: string;
  boundary: Boundary;
  maxWalBytes: number;
}

export interface ReconnectReport {
  tenantId: string;
  childIdentity: ChildIdentity | null;
  vendorSessionId: string | null;
  lastAcceptedCommand: Omit<CommandEnvelope, "prompt"> | null;
  lastEventSequence: number;
  highWaterMark: number;
  inFlightPhase: InFlightPhase;
  pendingApprovalId: string | null;
  replay: SemanticEvent[];
}

export interface ProviderLedger {
  vendor: Vendor;
  vendorSessionId: string;
  state: "idle" | "working" | "pending_approval" | "completed";
  commandId: string | null;
  promptExecutions: number;
  approvalExecutions: number;
  toolExecutions: number;
  approvalId: string | null;
  finalText: string | null;
}

export interface RpcRequest {
  tenantId: string;
  authToken: string;
  action: "start" | "snapshot" | "release" | "approve" | "ack" | "shutdown";
  command?: CommandEnvelope;
  approvalId?: string;
  decision?: "approve" | "deny";
  highWaterMark?: number;
}

export interface MatrixRow {
  vendor: Vendor;
  crashTarget: CrashTarget;
  boundary: Boundary;
  outcome: "replayed_known_state" | "clean_vendor_resume" | "UNKNOWN_OUTCOME";
  promptExecutions: number;
  approvalExecutions: number;
  toolExecutions: number;
  duplicatePrompt: boolean;
  duplicateApproval: boolean;
  duplicateTool: boolean;
  falseCompletion: boolean;
  crossTenantAdoption: boolean;
  orphanedProcesses: boolean;
  lastEventSequence: number;
  highWaterMark: number;
  notes: string;
}
