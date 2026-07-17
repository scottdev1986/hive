import {
  STATUS_LIMITS,
  STATUS_PHASES,
  WORKSPACE_EVENT_CONFIDENCE,
  WORKSPACE_EVENT_SOURCE_KINDS,
  type WorkspaceEventV2,
} from "../schemas/status-envelope";

export const SESSION_STATES = ["creating", "live", "exited", "replacing", "lost"] as const;
export const TURN_STATES = [
  "unknown", "ready", "working", "idle", "awaiting_approval", "paused",
  "stuck", "done", "failed",
] as const;
export const INPUT_STATES = ["free", "human_owned", "human_orphaned", "automation"] as const;
export const HEALTH_STATES = ["healthy", "delayed", "stale", "disconnected", "unknown"] as const;
export const ATTENTION_STATES = ["none", "info", "action", "approval", "failure"] as const;

type SessionState = (typeof SESSION_STATES)[number];
type TurnState = (typeof TURN_STATES)[number];
type InputState = (typeof INPUT_STATES)[number];
type HealthState = (typeof HEALTH_STATES)[number];
type Attention = (typeof ATTENTION_STATES)[number];
type SourceKind = (typeof WORKSPACE_EVENT_SOURCE_KINDS)[number];
type Confidence = (typeof WORKSPACE_EVENT_CONFIDENCE)[number];

export type StatusFreshness = "fresh" | "stale" | "unknown";

export type StatusField<T> = Readonly<{
  value: T | null;
  source: Readonly<{ kind: SourceKind; id: string }>;
  observedAt: string;
  freshness: StatusFreshness;
  confidence: Confidence;
}>;

export type AuthenticatedStatusReport = Readonly<{
  phase: (typeof STATUS_PHASES)[number];
  progress: number | null;
  summary: string;
  blocker: string | null;
  evidenceRefs: readonly string[];
  nextCheckpoint: string | null;
  assignmentId: string;
  assignmentGeneration: string;
  freshUntil: string;
  source: Readonly<{ kind: "agent-report"; id: string }>;
  observedAt: string;
  freshness: StatusFreshness;
  confidence: Confidence;
}>;

export type StatusSourceDetail = Readonly<{
  eventId: string;
  kind: string;
  entityRevision: string;
  source: WorkspaceEventV2["source"];
}>;

export type FusedAgentStatus = Readonly<{
  agentId: string;
  generation: number;
  revision: string;
  sessionState: StatusField<SessionState> | null;
  turnState: StatusField<TurnState> | null;
  workflowState: Readonly<{ kind: "reserved" }>;
  inputState: StatusField<InputState> | null;
  healthState: StatusField<HealthState> | null;
  attention: StatusField<Attention> | null;
  report: AuthenticatedStatusReport | null;
  sources: readonly StatusSourceDetail[];
  conflicts: readonly string[];
}>;

export type VisibleStatus = Readonly<{
  primaryLabel: string;
  progress: number | null;
  attention: Attention;
  sourceStack: readonly StatusSourceDetail[];
  conflicts: readonly string[];
}>;

type Candidate<T> = Readonly<{
  value: T;
  event: WorkspaceEventV2;
  rank: number;
}>;

const sourceRank = (kind: SourceKind): number => {
  switch (kind) {
    case "sessiond": return 500;
    case "provider-app-server": return 400;
    case "provider-hook": return 350;
    case "provider-telemetry": return 300;
    case "agent-report": return 200;
    case "task": return 600;
    case "operator": return 600;
  }
};

const enumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null => typeof value === "string" && allowed.includes(value as T)
  ? value as T
  : null;

const ageMilliseconds = (observedAt: string, now: Date): number =>
  Math.max(0, now.getTime() - Date.parse(observedAt));

const freshnessFor = (
  event: WorkspaceEventV2,
  now: Date,
): StatusFreshness => {
  const age = ageMilliseconds(event.source.observedAt, now);
  if (event.source.kind === "sessiond") {
    if (age > STATUS_LIMITS.processUnknownAfterMilliseconds) return "unknown";
    if (age > STATUS_LIMITS.processDelayedAfterMilliseconds) return "stale";
    return "fresh";
  }
  if (
    event.source.kind === "provider-app-server" ||
    event.source.kind === "provider-hook" ||
    event.source.kind === "provider-telemetry"
  ) {
    return age > STATUS_LIMITS.providerFreshnessMilliseconds ? "stale" : "fresh";
  }
  return "fresh";
};

const fieldFrom = <T>(candidate: Candidate<T>, now: Date): StatusField<T> => ({
  value: candidate.value,
  source: { kind: candidate.event.source.kind, id: candidate.event.source.id },
  observedAt: candidate.event.source.observedAt,
  freshness: freshnessFor(candidate.event, now),
  confidence: candidate.event.source.confidence,
});

const choose = <T>(
  candidates: readonly Candidate<T>[],
  now: Date,
  field: string,
  conflicts: string[],
): StatusField<T> | null => {
  const ordered = [...candidates].sort((left, right) =>
    right.rank - left.rank ||
    Date.parse(right.event.source.observedAt) - Date.parse(left.event.source.observedAt)
  );
  const winner = ordered[0];
  if (winner === undefined) return null;
  for (const candidate of ordered.slice(1)) {
    if (candidate.value !== winner.value) {
      conflicts.push(
        `${field}: ${candidate.event.source.kind}=${String(candidate.value)} conflicts with ` +
          `${winner.event.source.kind}=${String(winner.value)}`,
      );
    }
  }
  return fieldFrom(winner, now);
};

const belongsToAgent = (
  event: WorkspaceEventV2,
  agentId: string,
  generation: number,
): boolean => {
  if (
    event.entity.kind === "agent" && event.entity.id === agentId &&
    (event.entity.generation === undefined || event.entity.generation === generation)
  ) return true;
  return event.data.agentId === agentId &&
    (event.data.generation === undefined || event.data.generation === generation);
};

const reportFrom = (
  events: readonly WorkspaceEventV2[],
  now: Date,
): AuthenticatedStatusReport | null => {
  const candidates = events.filter((event) =>
    event.kind === "agent.status-reported" &&
    event.source.kind === "agent-report" && event.data.authenticated === true
  ).sort((left, right) =>
    BigInt(left.entityRevision) < BigInt(right.entityRevision) ? 1 : -1
  );
  const event = candidates[0];
  if (event === undefined) return null;
  const phase = enumValue(event.data.phase, STATUS_PHASES);
  if (
    phase === null || typeof event.data.summary !== "string" ||
    typeof event.data.assignmentId !== "string" ||
    typeof event.data.assignmentGeneration !== "string" ||
    typeof event.data.freshUntil !== "string"
  ) return null;
  const freshness = now.getTime() <= Date.parse(event.data.freshUntil)
    ? "fresh"
    : "stale";
  return {
    phase,
    progress: typeof event.data.progress === "number" ? event.data.progress : null,
    summary: event.data.summary,
    blocker: typeof event.data.blocker === "string" ? event.data.blocker : null,
    evidenceRefs: Array.isArray(event.data.evidenceRefs)
      ? event.data.evidenceRefs.filter((value): value is string => typeof value === "string")
      : [],
    nextCheckpoint: typeof event.data.nextCheckpoint === "string"
      ? event.data.nextCheckpoint
      : null,
    assignmentId: event.data.assignmentId,
    assignmentGeneration: event.data.assignmentGeneration,
    freshUntil: event.data.freshUntil,
    source: { kind: "agent-report", id: event.source.id },
    observedAt: event.source.observedAt,
    freshness,
    confidence: event.source.confidence,
  };
};

export function fuseAgentStatus(
  allEvents: readonly WorkspaceEventV2[],
  identity: Readonly<{ agentId: string; generation: number }>,
  now: Date,
): FusedAgentStatus {
  const events = allEvents.filter((event) =>
    belongsToAgent(event, identity.agentId, identity.generation)
  );
  const session: Candidate<SessionState>[] = [];
  const turn: Candidate<TurnState>[] = [];
  const input: Candidate<InputState>[] = [];
  const health: Candidate<HealthState>[] = [];
  const attentionEvents: Candidate<Attention>[] = [];
  const resolvedAttention = new Set(events
    .filter((event) => event.kind === "status.attention-resolved")
    .map((event) => event.data.causeEventId)
    .filter((value): value is string => typeof value === "string"));

  for (const event of events) {
    const rank = sourceRank(event.source.kind);
    if (event.kind === "status.session" && event.source.kind === "sessiond") {
      const value = enumValue(event.data.value, SESSION_STATES);
      if (value !== null) session.push({ value, event, rank });
    } else if (event.kind === "status.turn") {
      const value = enumValue(event.data.value, TURN_STATES);
      if (
        value !== null && (
          event.source.kind === "provider-app-server" ||
          event.source.kind === "provider-hook" ||
          event.source.kind === "provider-telemetry"
        )
      ) {
        turn.push({ value, event, rank });
      } else if (
        value !== null && event.source.kind === "sessiond" &&
        (value === "done" || value === "failed")
      ) {
        // Positive exit evidence is the only session fact that can safely
        // fill a missing provider lifecycle. It remains below every provider.
        turn.push({ value, event, rank: 250 });
      }
    } else if (event.kind === "status.input" && event.source.kind === "sessiond") {
      const value = enumValue(event.data.value, INPUT_STATES);
      if (value !== null) input.push({ value, event, rank });
    } else if (event.kind === "status.health" && event.source.kind === "sessiond") {
      const value = enumValue(event.data.value, HEALTH_STATES);
      if (value !== null) health.push({ value, event, rank });
    } else if (
      event.kind === "status.attention" &&
      event.data.resolved !== true && !resolvedAttention.has(event.eventId)
    ) {
      const value = enumValue(event.data.value, ATTENTION_STATES);
      if (value !== null && value !== "none") {
        attentionEvents.push({
          value,
          event,
          rank: ATTENTION_STATES.indexOf(value),
        });
      }
    }
  }

  const conflicts: string[] = [];
  const sessionState = choose(session, now, "sessionState", conflicts);
  const turnState = choose(turn, now, "turnState", conflicts);
  const inputState = choose(input, now, "inputState", conflicts);
  let healthState = choose(health, now, "healthState", conflicts);
  if (healthState?.source.kind === "sessiond") {
    if (healthState.freshness === "stale") {
      healthState = { ...healthState, value: "delayed" };
    } else if (healthState.freshness === "unknown") {
      healthState = { ...healthState, value: "unknown" };
    }
  }
  const attention = choose(attentionEvents, now, "attention", conflicts);
  const report = reportFrom(events, now);
  if (
    report?.phase === "complete" && turnState !== null && turnState.value !== null &&
    !["done", "idle", "failed"].includes(turnState.value)
  ) {
    conflicts.push(`report=complete conflicts with provider lifecycle=${turnState.value}`);
  }

  const revision = events.reduce(
    (highest, event) => BigInt(event.entityRevision) > BigInt(highest)
      ? event.entityRevision
      : highest,
    "0",
  );
  return {
    agentId: identity.agentId,
    generation: identity.generation,
    revision,
    sessionState,
    turnState,
    workflowState: { kind: "reserved" },
    inputState,
    healthState,
    attention,
    report,
    sources: events.map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      entityRevision: event.entityRevision,
      source: event.source,
    })),
    conflicts,
  };
}

export function composeVisibleStatus(status: FusedAgentStatus): VisibleStatus {
  if (status.report?.freshness === "fresh") {
    return {
      primaryLabel: `${status.report.phase}: ${status.report.summary}`,
      progress: status.report.progress,
      attention: status.attention?.value ?? "none",
      sourceStack: status.sources,
      conflicts: status.conflicts,
    };
  }
  if (status.turnState?.value !== null && status.turnState !== null) {
    const marker = status.turnState.freshness === "fresh"
      ? ""
      : ` (${status.turnState.freshness})`;
    return {
      primaryLabel: `${status.turnState.value}${marker}`,
      progress: null,
      attention: status.attention?.value ?? "none",
      sourceStack: status.sources,
      conflicts: status.conflicts,
    };
  }
  const health = status.healthState?.value ?? "unknown";
  return {
    primaryLabel: health,
    progress: null,
    attention: status.attention?.value ?? "none",
    sourceStack: status.sources,
    conflicts: status.conflicts,
  };
}
