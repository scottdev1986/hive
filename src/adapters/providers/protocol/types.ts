import {
  BASELINE_CAPABILITIES,
  type BaselineCapability,
  type CapabilityAbsences,
  type CapabilityDiscoveryResult,
  type CapabilityMeasurements,
  type CapabilityName,
  type CapabilityProvider,
  type CapabilitySupport,
  type MeasuredProviderCapabilities,
  OPTIONAL_CAPABILITIES,
  type ProvenAbsence,
  type ProviderTransport,
} from "../../../schemas/capability";
import type { ProviderPermissionSettlementOutcome } from "../../../schemas/provider-permission";

export interface ProviderCapabilitySnapshot {
  readonly provider: CapabilityProvider;
  readonly source: "probe" | "session";
  readonly observedAt: string;
  readonly catalog: CapabilityDiscoveryResult;
  readonly measurements: CapabilityMeasurements;
  readonly absences?: CapabilityAbsences;
  readonly commands: readonly VendorCommand[];
}

/** What is actually known about one capability. `unknown` means nobody has measured it and nobody has proven it absent — the one state that is not an answer, and the state a release must not ship. */
export type CapabilityFinding =
  | { readonly state: "supported" }
  | { readonly state: "unsupported" }
  | { readonly state: "not-reported"; readonly absence: ProvenAbsence }
  | { readonly state: "unknown" };

export function capabilityFinding(
  capabilities: MeasuredProviderCapabilities,
  name: CapabilityName,
): CapabilityFinding {
  const measured = capabilities.measured[name];
  if (measured === "supported") return { state: "supported" };
  const absence = capabilities.absences?.[name];
  if (absence !== undefined) return { state: "not-reported", absence };
  if (measured === "unsupported") return { state: "unsupported" };
  return { state: "unknown" };
}

/** Capabilities that are neither measured nor proven absent. A vendor with any of these has a surface that would render ignorance, which is a release blocker rather than a cosmetic gap. */
export function steadyStateUnknowns(
  capabilities: MeasuredProviderCapabilities,
): readonly CapabilityName[] {
  return [...BASELINE_CAPABILITIES, ...OPTIONAL_CAPABILITIES].filter(
    (name) => capabilityFinding(capabilities, name).state === "unknown",
  );
}

/** The only supported way to read a capability. An absent measurement reads back as `unknown`, never as `unsupported`. */
export function capabilitySupport(
  capabilities: MeasuredProviderCapabilities,
  name: CapabilityName,
): CapabilitySupport {
  return capabilities.measured[name] ?? "unknown";
}

/** Baseline capabilities this build has not proven. Unknown counts as failing: an adapter that forgot to measure a row cannot pass the matrix by silence. */
export function unprovenBaseline(
  capabilities: MeasuredProviderCapabilities,
): readonly BaselineCapability[] {
  return BASELINE_CAPABILITIES.filter(
    (name) => capabilitySupport(capabilities, name) !== "supported",
  );
}

export interface ProviderSpawn {
  readonly provider: CapabilityProvider;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ProtocolProbe extends ProviderCapabilitySnapshot {
  readonly source: "probe";
  readonly executable: string;
  readonly version: string | null;
  readonly transport: ProviderTransport;
  readonly verdict: "compatible" | "incompatible";
  readonly reason?: string;
}

export interface VendorSessionRef {
  readonly vendorSessionId: string;
  readonly replayedHistory: boolean;
}

export interface SessionStart {
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly instruction?: string;
}

export interface SessionResume {
  readonly vendorSessionId: string;
  readonly style: "load" | "resume";
}

export interface SubmissionAttachment {
  readonly path: string;
  readonly mimeType: string | null;
}

export interface TurnSubmission {
  readonly session: VendorSessionRef;
  readonly clientInputId: string;
  readonly text: string;
  readonly attachments?: readonly SubmissionAttachment[];
}

/** `unknown` is the honest answer when the transport died between sending and acknowledgement: Hive cannot tell "never accepted" from "accepted, reply lost", and must not guess in either direction. */
export interface SubmissionReceipt {
  readonly clientInputId: string;
  readonly outcome: "accepted" | "rejected" | "unknown";
  readonly turnId: string | null;
  readonly detail?: string;
}

export interface AdapterChildProcess {
  readonly pid: number;
  readonly processGroupId: number;
}

export interface PermissionDecision {
  readonly requestId: string;
  readonly outcome: "allow" | "deny";
  readonly optionId?: string;
  readonly scope?: "once" | "session";
  /** Chosen answers keyed by `ElicitationQuestion.questionId`, for vendors that answer a question by returning selections rather than by selecting one of several permission options. A single-select question carries one label; a multi-select carries the labels chosen. The labels are the vendor's own, echoed back unaltered — a label it did not offer is not an answer. */
  readonly answers?: Readonly<Record<string, string | readonly string[]>>;
}

export interface VendorCommand {
  readonly name: string;
  readonly description: string | null;
  readonly argumentHint?: string;
}

export interface ProviderModelEffort {
  readonly id: string;
  readonly description: string | null;
}

/** Provider-owned model metadata used by the terminal picker. Missing fields stay null; the UI never invents marketing names or effort levels. */
export interface ProviderModel {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: readonly ProviderModelEffort[];
  readonly defaultReasoningEffort: string | null;
}

/** One answer a vendor will accept for a pending elicitation, quoted from the vendor's own option list. `optionId` is the vendor's token and is echoed back verbatim; Hive never invents one, because a request answered with an id the vendor did not offer is a guess wearing a person's authority. */
export interface ElicitationOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow" | "reject" | null;
  readonly description?: string | null;
  /** A longer illustration of the option — a code snippet, a mockup — shown only while it is highlighted. */
  readonly preview?: string | null;
}

/** One question of a possibly multi-question ask. ACP sends a single option list per `session/request_permission` and has no way to express a second question, so its requests normalize to exactly one of these. Claude Code sends up to four in one `AskUserQuestion` call and expects every one answered before the tool returns, which is why this is a list rather than a flattened set of options. */
export interface ElicitationQuestion {
  readonly questionId: string;
  readonly text: string;
  readonly header: string | null;
  readonly multiSelect: boolean;
  /** Whether the provider accepts text that is not one of the listed options. */
  readonly allowCustom: boolean;
  /** Secret answers are never echoed into the transcript after submission. */
  readonly secret: boolean;
  readonly options: readonly ElicitationOption[];
}

export interface ToolFileChange {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

interface NormalizedEventBase {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly raw: unknown;
}

export type NormalizedProviderEvent = NormalizedEventBase &
  (
    | { readonly kind: "runtime-connecting" }
    | { readonly kind: "runtime-ready" }
    | { readonly kind: "runtime-disconnected"; readonly reason: string }
    | { readonly kind: "run-ended"; readonly exitCode: number | null }
    | { readonly kind: "turn-queued"; readonly turnId: string }
    | {
        readonly kind: "turn-started";
        readonly turnId: string;
        readonly clientInputId?: string;
      }
    | { readonly kind: "turn-idle"; readonly turnId: string }
    | {
        readonly kind: "turn-failed";
        readonly turnId: string;
        readonly reason: string;
      }
    | { readonly kind: "interrupted"; readonly turnId: string }
    | {
        readonly kind: "message-delta";
        readonly turnId: string;
        readonly text: string;
      }
    | {
        readonly kind: "thought-delta";
        readonly turnId: string;
        readonly text: string;
      }
    | {
        readonly kind: "tool-started";
        readonly turnId: string;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly detail: string | null;
        readonly toolKind?: ToolKind | null;
        readonly locations?: readonly string[];
        readonly changes?: readonly ToolFileChange[];
        readonly output?: string | null;
      }
    | {
        readonly kind: "tool-updated";
        readonly turnId: string;
        readonly toolCallId: string;
        readonly detail: string | null;
        readonly toolKind?: ToolKind | null;
        readonly locations?: readonly string[];
        readonly changes?: readonly ToolFileChange[];
        readonly output?: string | null;
      }
    | ({
        readonly kind: "tool-finished";
        readonly turnId: string;
        readonly toolCallId: string;
      } & (
        | { readonly status: "ok" }
        | { readonly status: "error"; readonly reason: string | null }
      ))
    | {
        readonly kind: "plan-updated";
        readonly turnId: string;
        readonly entries: readonly string[];
      }
    | {
        readonly kind: "usage-updated";
        readonly turnId: string;
        /** Null when the vendor did not report it. Renderers show an em dash for null and never substitute zero. */
        readonly contextPercent: number | null;
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly cachedInputTokens?: number | null;
        readonly cacheCreationInputTokens?: number | null;
        readonly reasoningTokens?: number | null;
        readonly contextWindow?: number | null;
        /** The vendor's own identity for this reading, and whether the counts are a running session total or one turn's delta. Attribution keys on `usageKey`, so a reconnect that replays a reading the store already has updates that row instead of adding a second one; without it the same tokens are counted twice. `cumulative` counts are replaced rather than summed, which is what lets a replayed total stay the same total. */
        readonly usageKey?: string | null;
        readonly cumulative?: boolean;
        /** Which transport observed this, and when the vendor says it did. Both are persisted alongside the counts, so a reading keeps its provenance and its own clock rather than the time it happened to be ingested. */
        readonly source?: string | null;
        readonly observedAt?: string | null;
      }
    | {
        readonly kind: "config-updated";
        readonly model: string | null;
        readonly effort: string | null;
        readonly mode: string | null;
      }
    | { readonly kind: "compacted"; readonly turnId: string }
    | {
        /** A turn-level unified diff aggregating every file the turn has changed so far, replacing any previous one for the same turn. Codex reports this; vendors that only describe changes per tool call do not. */
        readonly kind: "turn-diff-updated";
        readonly turnId: string;
        readonly diff: string;
      }
    | {
        readonly kind: "approval-waiting";
        readonly requestId: string;
        readonly turnId: string;
        readonly toolName: string | null;
        readonly summary: string;
        readonly detail?: string | null;
        readonly options?: readonly ElicitationOption[];
      }
    | {
        readonly kind: "question-waiting";
        readonly requestId: string;
        readonly turnId: string;
        readonly summary: string;
        readonly detail?: string | null;
        readonly options?: readonly ElicitationOption[];
        readonly questions?: readonly ElicitationQuestion[];
      }
    | {
        readonly kind: "elicitation-settled";
        readonly requestId: string;
        readonly outcome: ProviderPermissionSettlementOutcome;
      }
    | {
        readonly kind: "commands-updated";
        readonly commands: readonly VendorCommand[];
      }
    /** A vendor event with no normalized meaning. It is retained so diagnosis can see it, and it deliberately carries no state so it cannot be mistaken for a lifecycle transition. */
    | { readonly kind: "unrecognized" }
  );

export interface ProviderSession {
  readonly capabilities: MeasuredProviderCapabilities;
  readonly events: AsyncIterable<NormalizedProviderEvent>;
  readonly adapterChild: AdapterChildProcess | null;
  newSession(input: SessionStart): Promise<VendorSessionRef>;
  resumeSession(input: SessionResume): Promise<VendorSessionRef>;
  submit(input: TurnSubmission): Promise<SubmissionReceipt>;
  cancel(turnId: string): Promise<void>;
  respondToPermission(input: PermissionDecision): Promise<void>;
  /** Switch how the vendor asks for permission mid-session, returning the mode it actually applied — which is not always the one requested, and is the only thing worth showing a person. Absent on vendors with no such control. A caller that finds it missing has to say so rather than pretend the mode changed. */
  setPermissionMode?(mode: string): Promise<string>;
  readonly permissionModes?: readonly string[];
  listModelCatalog?(): Promise<readonly ProviderModel[]>;
  listModelIds?(): Promise<readonly string[]>;
  setModel?(input: {
    readonly vendorSessionId: string;
    readonly model: string;
    readonly effort?: string;
  }): Promise<void>;
  runCommand?(input: {
    readonly vendorSessionId: string;
    readonly name: string;
    readonly arguments?: string;
  }): Promise<boolean>;
  listCommands(): Promise<readonly VendorCommand[]>;
  snapshot(): Promise<ProviderCapabilitySnapshot>;
  close(): Promise<void>;
}

export interface ProviderRuntimeAdapter {
  readonly id: CapabilityProvider | "fake";
  readonly transport: ProviderTransport;
  probe(executable: string): Promise<ProtocolProbe>;
  connect(spawn: ProviderSpawn): Promise<ProviderSession>;
}
