import {
  ATTENTION_STATES,
  HEALTH_STATES,
  INPUT_STATES,
  MAIL_STATES,
  RUNTIME_STATES,
  TURN_STATES,
  type WorkspaceEventV2,
} from "../../schemas/status-envelope";

export const SESSION_STATES = [
  "creating",
  "live",
  "exited",
  "replacing",
  "lost",
] as const;

type StatusCandidate =
  | Readonly<{
      dimension: "session";
      value: (typeof SESSION_STATES)[number];
    }>
  | Readonly<{
      dimension: "runtime";
      value: (typeof RUNTIME_STATES)[number];
    }>
  | Readonly<{
      dimension: "turn";
      value: (typeof TURN_STATES)[number];
      rank?: number;
    }>
  | Readonly<{
      dimension: "input";
      value: (typeof INPUT_STATES)[number];
    }>
  | Readonly<{
      dimension: "mail";
      value: (typeof MAIL_STATES)[number];
    }>
  | Readonly<{
      dimension: "health";
      value: (typeof HEALTH_STATES)[number];
    }>;

const enumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null =>
  typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : null;

export function statusCandidateForEvent(
  event: WorkspaceEventV2,
): StatusCandidate | null {
  const { kind, source, data } = event;
  if (kind === "status.session" && source.kind === "sessiond") {
    const value = enumValue(data.value, SESSION_STATES);
    return value === null ? null : { dimension: "session", value };
  }
  if (
    kind === "status.runtime" &&
    (source.kind === "provider-protocol" ||
      source.kind === "provider-app-server")
  ) {
    const value = enumValue(data.value, RUNTIME_STATES);
    return value === null ? null : { dimension: "runtime", value };
  }
  if (
    kind === "status.mail" &&
    (source.kind === "provider-protocol" || source.kind === "sessiond")
  ) {
    const value = enumValue(data.value, MAIL_STATES);
    return value === null ? null : { dimension: "mail", value };
  }
  if (kind === "status.turn") {
    const value = enumValue(data.value, TURN_STATES);
    if (value === null) return null;
    if (
      source.kind === "provider-protocol" ||
      source.kind === "provider-app-server" ||
      source.kind === "provider-hook" ||
      source.kind === "provider-telemetry"
    ) {
      return { dimension: "turn", value };
    }
    return source.kind === "sessiond" &&
      (value === "done" || value === "failed")
      ? { dimension: "turn", value, rank: 250 }
      : null;
  }
  if (kind === "status.input" && source.kind === "sessiond") {
    const value = enumValue(data.value, INPUT_STATES);
    return value === null ? null : { dimension: "input", value };
  }
  if (kind === "status.health" && source.kind === "sessiond") {
    const value = enumValue(data.value, HEALTH_STATES);
    return value === null ? null : { dimension: "health", value };
  }
  return null;
}

export const isAuthenticatedReportEvent = (event: WorkspaceEventV2): boolean =>
  event.kind === "agent.status-reported" &&
  event.source.kind === "agent-report" &&
  event.data.authenticated === true;

export const isActiveAttentionEvent = (event: WorkspaceEventV2): boolean => {
  const value = enumValue(event.data.value, ATTENTION_STATES);
  return (
    event.kind === "status.attention" &&
    event.data.resolved !== true &&
    value !== null &&
    value !== "none"
  );
};
