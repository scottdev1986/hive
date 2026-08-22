import type { MeasuredProviderCapabilities } from "../../schemas/capability";
import { isNumber, isRecord, isString } from "../../shared/is-record";
import {
  ATTENTION_STATES,
  HEALTH_STATES,
  INPUT_STATES,
  MAIL_STATES,
  RUNTIME_STATES,
  STATUS_LIMITS,
  STATUS_PHASES,
  TURN_STATES,
  type WORKSPACE_EVENT_CONFIDENCE,
  type WORKSPACE_EVENT_SOURCE_KINDS,
  type WorkspaceEventV2,
  type WorkspaceStatusDimensionsV1,
  WorkspaceStatusDimensionsV1Schema,
} from "../../schemas/status-envelope";
import {
  isActiveAttentionEvent,
  isAuthenticatedReportEvent,
  SESSION_STATES,
  statusCandidateForEvent,
} from "./status-current-projection";

export {
  ATTENTION_STATES,
  HEALTH_STATES,
  INPUT_STATES,
  MAIL_STATES,
  RUNTIME_STATES,
  SESSION_STATES,
  TURN_STATES,
};

type RuntimeState = (typeof RUNTIME_STATES)[number];
type MailState = (typeof MAIL_STATES)[number];
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

export const STATUS_DIMENSIONS = [
  "session",
  "runtime",
  "turn",
  "input",
  "mail",
  "health",
  "attention",
] as const;
export type StatusDimension = (typeof STATUS_DIMENSIONS)[number];

export type StatusAbsence =
  | Readonly<{ kind: "vendor-does-not-report"; citation: string }>
  | Readonly<{ kind: "disconnected"; since: string }>
  | Readonly<{ kind: "stale-since"; observedAt: string }>
  | Readonly<{ kind: "unmeasured" }>;

export type VendorReportingProofs = Readonly<
  Partial<Record<StatusDimension, Readonly<{ citation: string }>>>
>;

export type ProviderCapabilitiesEvidence = Readonly<{
  vendorSessionId: string;
  capabilities: MeasuredProviderCapabilities;
  observedAt: string;
}>;

export type FusedAgentStatus = Readonly<{
  agentId: string;
  incarnationGeneration: number | null;
  revision: string;
  sessionState: StatusField<SessionState> | null;
  runtimeState: StatusField<RuntimeState> | null;
  turnState: StatusField<TurnState> | null;
  workflowState: Readonly<{ kind: "reserved" }>;
  inputState: StatusField<InputState> | null;
  mailState: StatusField<MailState> | null;
  healthState: StatusField<HealthState> | null;
  attention: StatusField<Attention> | null;
  absences: Readonly<Partial<Record<StatusDimension, StatusAbsence>>>;
  providerCapabilities: StatusField<MeasuredProviderCapabilities> | null;
  report: AuthenticatedStatusReport | null;
  sources: readonly StatusSourceDetail[];
  conflicts: readonly string[];
}>;

const workspaceDimension = <T extends string>(
  field: StatusField<T> | null,
  absence: StatusAbsence | undefined,
) =>
  field === null
    ? ({
        kind: "absent",
        reason: absence ?? { kind: "unmeasured" },
      } as const)
    : ({ kind: "observed", field } as const);

export function workspaceStatusDimensions(
  status: FusedAgentStatus,
): WorkspaceStatusDimensionsV1 {
  return WorkspaceStatusDimensionsV1Schema.parse({
    schemaVersion: 1,
    revision: status.revision,
    runtime: workspaceDimension(status.runtimeState, status.absences.runtime),
    turn: workspaceDimension(status.turnState, status.absences.turn),
    input: workspaceDimension(status.inputState, status.absences.input),
    mail: workspaceDimension(status.mailState, status.absences.mail),
    health: workspaceDimension(status.healthState, status.absences.health),
    attention: workspaceDimension(status.attention, status.absences.attention),
  });
}

export function steadyStateUnknowns(
  status: FusedAgentStatus,
): readonly StatusDimension[] {
  return STATUS_DIMENSIONS.filter(
    (dimension) => status.absences[dimension]?.kind === "unmeasured",
  );
}

type Candidate<T> = Readonly<{
  value: T;
  event: WorkspaceEventV2;
  rank: number;
}>;

const sourceRank = (kind: SourceKind): number => {
  switch (kind) {
    case "sessiond":
      return 500;
    // One rank for both names: the protocol source supersedes the transport it was renamed from, so a migration cannot reorder anything by relabelling.
    case "provider-protocol":
      return 400;
    case "provider-app-server":
      return 400;
    case "provider-hook":
      return 350;
    case "provider-telemetry":
      return 300;
    case "agent-report":
      return 200;
    case "task":
      return 600;
    case "user":
      return 600;
  }
};

const enumValue = <T extends string, V>(
  value: V,
  allowed: readonly T[],
): T | null => {
  if (!isString(value)) return null;
  const text: string = value;
  for (const option of allowed) {
    if (option === text) return option;
  }
  return null;
};

const ageMilliseconds = (observedAt: string, now: Date): number =>
  Math.max(0, now.getTime() - Date.parse(observedAt));

const freshnessFor = (event: WorkspaceEventV2, now: Date): StatusFreshness => {
  const age = ageMilliseconds(event.source.observedAt, now);
  if (event.source.kind === "sessiond") {
    if (age > STATUS_LIMITS.processUnknownAfterMilliseconds) return "unknown";
    if (age > STATUS_LIMITS.processDelayedAfterMilliseconds) return "stale";
    return "fresh";
  }
  if (
    event.source.kind === "provider-protocol" ||
    event.source.kind === "provider-app-server" ||
    event.source.kind === "provider-hook" ||
    event.source.kind === "provider-telemetry"
  ) {
    return age > STATUS_LIMITS.providerFreshnessMilliseconds
      ? "stale"
      : "fresh";
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
  const ordered = [...candidates].sort(
    (left, right) =>
      right.rank - left.rank ||
      Date.parse(right.event.source.observedAt) -
        Date.parse(left.event.source.observedAt),
  );
  const winner = ordered[0];
  if (winner === undefined) return null;
  const sourceKey = (candidate: Candidate<T>): string =>
    `${candidate.event.source.kind}:${candidate.event.source.id}`;
  const newestPerSource = new Map<string, number>();
  for (const candidate of ordered) {
    const key = sourceKey(candidate);
    const observedAt = Date.parse(candidate.event.source.observedAt);
    const prior = newestPerSource.get(key);
    if (prior === undefined || observedAt > prior) {
      newestPerSource.set(key, observedAt);
    }
  }
  for (const candidate of ordered.slice(1)) {
    const observedAt = Date.parse(candidate.event.source.observedAt);
    if (observedAt < (newestPerSource.get(sourceKey(candidate)) ?? 0)) {
      continue;
    }
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
  incarnationGeneration: number | null,
): boolean => {
  if (event.entity.kind === "agent" && event.entity.id === agentId) {
    const binding = event.data.binding;
    const reportGeneration =
      isRecord(binding) &&
      "incarnationGeneration" in binding &&
      isNumber(binding.incarnationGeneration)
        ? binding.incarnationGeneration
        : undefined;
    return (
      incarnationGeneration === null ||
      reportGeneration === undefined ||
      reportGeneration === incarnationGeneration
    );
  }
  if (event.data.agentId !== agentId) return false;
  const eventGeneration =
    event.entity.kind === "session"
      ? event.entity.generation
      : isNumber(event.data.incarnationGeneration)
        ? event.data.incarnationGeneration
        : undefined;
  return (
    incarnationGeneration === null ||
    eventGeneration === undefined ||
    eventGeneration === incarnationGeneration
  );
};

const reportFrom = (
  events: readonly WorkspaceEventV2[],
  now: Date,
): AuthenticatedStatusReport | null => {
  const candidates = events
    .filter(isAuthenticatedReportEvent)
    .sort((left, right) =>
      BigInt(left.entityRevision) < BigInt(right.entityRevision) ? 1 : -1,
    );
  const event = candidates[0];
  if (event === undefined) return null;
  const phase = enumValue(event.data.phase, STATUS_PHASES);
  if (
    phase === null ||
    !isString(event.data.summary) ||
    !isString(event.data.assignmentId) ||
    !isString(event.data.assignmentGeneration) ||
    !isString(event.data.freshUntil)
  )
    return null;
  const freshness =
    now.getTime() <= Date.parse(event.data.freshUntil) ? "fresh" : "stale";
  return {
    phase,
    progress: isNumber(event.data.progress) ? event.data.progress : null,
    summary: event.data.summary,
    blocker: isString(event.data.blocker) ? event.data.blocker : null,
    evidenceRefs: Array.isArray(event.data.evidenceRefs)
      ? event.data.evidenceRefs.filter((value): value is string =>
          isString(value),
        )
      : [],
    nextCheckpoint: isString(event.data.nextCheckpoint)
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

/** Resolves a blank dimension to the most specific fact available about it. Proven absence beats a live-transport explanation, which beats a stale reading, which beats admitting nothing was measured. The order matters: a vendor that provably never reports a datum is not "disconnected" just because its transport also dropped. */
const absenceFor = (
  dimension: StatusDimension,
  proofs: VendorReportingProofs,
  runtime: StatusField<RuntimeState> | null,
  session: StatusField<SessionState> | null,
  newestObservedAt: string | null,
): StatusAbsence => {
  const proof = proofs[dimension];
  if (proof !== undefined) {
    return { kind: "vendor-does-not-report", citation: proof.citation };
  }
  if (runtime?.value === "disconnected" || runtime?.value === "exited") {
    return { kind: "disconnected", since: runtime.observedAt };
  }
  if (session?.value === "exited" || session?.value === "lost") {
    return { kind: "disconnected", since: session.observedAt };
  }
  if (newestObservedAt !== null) {
    return { kind: "stale-since", observedAt: newestObservedAt };
  }
  return { kind: "unmeasured" };
};

export function fuseAgentStatus(
  allEvents: readonly WorkspaceEventV2[],
  identity: Readonly<{ agentId: string; incarnationGeneration: number | null }>,
  now: Date,
  reportingProofs: VendorReportingProofs = {},
  providerCapabilities: ProviderCapabilitiesEvidence | null = null,
): FusedAgentStatus {
  const events = allEvents.filter((event) =>
    belongsToAgent(event, identity.agentId, identity.incarnationGeneration),
  );
  const session: Candidate<SessionState>[] = [];
  const runtime: Candidate<RuntimeState>[] = [];
  const turn: Candidate<TurnState>[] = [];
  const input: Candidate<InputState>[] = [];
  const mail: Candidate<MailState>[] = [];
  const health: Candidate<HealthState>[] = [];
  const attentionEvents: Candidate<Attention>[] = [];
  const resolvedAttention = new Set(
    events
      .filter((event) => event.kind === "status.attention-resolved")
      .map((event) => event.data.causeEventId)
      .filter((value): value is string => isString(value)),
  );

  for (const event of events) {
    const rank = sourceRank(event.source.kind);
    const candidate = statusCandidateForEvent(event);
    if (candidate?.dimension === "session") {
      session.push({ value: candidate.value, event, rank });
    } else if (candidate?.dimension === "runtime") {
      runtime.push({ value: candidate.value, event, rank });
    } else if (candidate?.dimension === "turn") {
      turn.push({
        value: candidate.value,
        event,
        rank: candidate.rank ?? rank,
      });
    } else if (candidate?.dimension === "input") {
      input.push({ value: candidate.value, event, rank });
    } else if (candidate?.dimension === "mail") {
      mail.push({ value: candidate.value, event, rank });
    } else if (candidate?.dimension === "health") {
      health.push({ value: candidate.value, event, rank });
    } else if (
      isActiveAttentionEvent(event) &&
      !resolvedAttention.has(event.eventId)
    ) {
      // SAFETY: The surrounding code already established this contract.
      const value = event.data.value as Attention;
      attentionEvents.push({
        value,
        event,
        rank: ATTENTION_STATES.indexOf(value),
      });
    }
  }

  const conflicts: string[] = [];
  const sessionState = choose(session, now, "sessionState", conflicts);
  const runtimeState = choose(runtime, now, "runtimeState", conflicts);
  const turnState = choose(turn, now, "turnState", conflicts);
  const inputState = choose(input, now, "inputState", conflicts);
  const mailState = choose(mail, now, "mailState", conflicts);
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
  const providerCapabilitiesField =
    providerCapabilities === null
      ? null
      : {
          value: providerCapabilities.capabilities,
          source: {
            kind: "provider-protocol" as const,
            id: providerCapabilities.vendorSessionId,
          },
          observedAt: providerCapabilities.observedAt,
          freshness:
            ageMilliseconds(providerCapabilities.observedAt, now) >
            STATUS_LIMITS.providerFreshnessMilliseconds
              ? ("stale" as const)
              : ("fresh" as const),
          confidence: "authoritative" as const,
        };
  if (
    report?.phase === "complete" &&
    turnState !== null &&
    turnState.value !== null &&
    !["done", "idle", "failed"].includes(turnState.value)
  ) {
    conflicts.push(
      `report=complete conflicts with provider lifecycle=${turnState.value}`,
    );
  }

  const fields = {
    session: sessionState,
    runtime: runtimeState,
    turn: turnState,
    input: inputState,
    mail: mailState,
    health: healthState,
    attention,
  } satisfies Record<StatusDimension, StatusField<string> | null>;
  // The newest event a dimension ever produced, even one whose value was superseded or dropped: it is what separates "went quiet" from "never spoke", and those are different facts.
  const lastHeard = new Map<StatusDimension, string>();
  for (const event of events) {
    const dimension = STATUS_DIMENSIONS.find(
      (name) => event.kind === `status.${name}`,
    );
    if (dimension === undefined) continue;
    const seen = lastHeard.get(dimension);
    if (seen === undefined || event.source.observedAt > seen) {
      lastHeard.set(dimension, event.source.observedAt);
    }
  }
  const absences: Partial<Record<StatusDimension, StatusAbsence>> = {};
  for (const dimension of STATUS_DIMENSIONS) {
    if (fields[dimension] !== null) continue;
    absences[dimension] = absenceFor(
      dimension,
      reportingProofs,
      runtimeState,
      sessionState,
      lastHeard.get(dimension) ?? null,
    );
  }

  const revision = events.reduce(
    (highest, event) =>
      BigInt(event.entityRevision) > BigInt(highest)
        ? event.entityRevision
        : highest,
    "0",
  );
  return {
    agentId: identity.agentId,
    incarnationGeneration: identity.incarnationGeneration,
    revision,
    sessionState,
    runtimeState,
    turnState,
    workflowState: { kind: "reserved" },
    inputState,
    mailState,
    healthState,
    absences,
    providerCapabilities: providerCapabilitiesField,
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
