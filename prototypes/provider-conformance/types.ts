export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = typeof PROVIDERS[number];

export const COMMON_SCENARIOS = [
  "lifecycle",
  "approve",
  "deny",
  "needs-user",
  "steer",
  "cancel",
  "resume",
  "invalid-model",
  "read-only",
] as const;
export type CommonScenario = typeof COMMON_SCENARIOS[number];

export const CODEX_ONLY_SCENARIOS = ["dual-client"] as const;
export const SCENARIOS = [...COMMON_SCENARIOS, ...CODEX_ONLY_SCENARIOS] as const;
export type Scenario = typeof SCENARIOS[number];

export function scenarioApplies(provider: Provider, scenario: Scenario): boolean {
  return provider === "codex" || scenario !== "dual-client";
}

export function scenariosFor(provider: Provider): Scenario[] {
  return SCENARIOS.filter((scenario) => scenarioApplies(provider, scenario));
}

export type CostClass = "non-billable" | "billable" | "unknown";
export type Outcome = "pass" | "fail" | "not-run";

export interface InstallationBinding {
  provider: Provider;
  requestedPath: string;
  executablePath: string;
  sha256: string;
  sizeBytes: number;
  version: string;
  probedAt: string;
  probe: {
    argv: string[];
    billable: "no";
    provenance: string;
  };
}

export type EventType =
  | "session.started"
  | "session.resumed"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "model.reported"
  | "model.rejected"
  | "model.substituted"
  | "policy.reported"
  | "approval.requested"
  | "approval.responded"
  | "user-input.requested"
  | "user-input.responded"
  | "tool.started"
  | "tool.completed"
  | "tool.denied"
  | "steer.accepted"
  | "cancel.receipt"
  | "client.attached"
  | "client.subscribed"
  | "client.observed"
  | "input.injected"
  | "validation.started"
  | "validation.rejected"
  | "marker.observed"
  | "diagnostic";

export interface NormalizedEvent {
  sequence: number;
  at: string;
  type: EventType;
  sessionId?: string;
  turnId?: string;
  requestId?: string;
  model?: string;
  tool?: string;
  decision?: "approve" | "deny";
  status?: string;
  text?: string;
  receipt?: boolean;
  resumedFrom?: string;
  exists?: boolean;
  content?: string;
  validationOnly?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CostObservation {
  classification: CostClass;
  observedUsd?: number;
  observedInputTokens?: number;
  observedOutputTokens?: number;
  provenance: string[];
}

export interface AdapterRun {
  provider: Provider;
  scenario: Scenario;
  binding: InstallationBinding;
  selectedModel: string;
  invalidModel?: string;
  events: NormalizedEvent[];
  cost: CostObservation;
  fallbackConfigured: boolean;
  realTaskStarted: boolean;
  rawCapturePath?: string;
  diagnostics: string[];
}

export interface AssertionResult {
  id: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioResult extends AdapterRun {
  outcome: Outcome;
  assertions: AssertionResult[];
}

export interface ProvenanceAxis {
  status: "yes" | "partial" | "no" | "pass" | "fail" | "not-run" | CostClass;
  provenance: string[];
  note?: string;
}

export interface EvidenceFact {
  provider: Provider;
  scenario: Scenario;
  documented: ProvenanceAxis;
  observed: ProvenanceAxis;
  billable: ProvenanceAxis;
}

export interface ConformanceReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  live: boolean;
  billableExecutionAuthorized: boolean;
  scenarios: Scenario[];
  providers: Provider[];
  results: ScenarioResult[];
  evidence: EvidenceFact[];
}

export interface AdapterContext {
  runId: string;
  runDirectory: string;
  scenarioDirectory: string;
  selectedModel: string;
  invalidModel: string;
  timeoutMs: number;
}

export interface PreparedAdapter {
  provider: Provider;
  binding: InstallationBinding;
  selectedModel: string;
  preflightProvenance: string[];
  run(scenario: Scenario, context: AdapterContext): Promise<AdapterRun>;
}
