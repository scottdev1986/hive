import type { AgentRecord } from "../schemas/agent";
import type { WorkspaceStatusDimensionsV1 } from "../schemas/status-envelope";
import type { WorkspaceOrchestratorSnapshot } from "./workspace-feed";

export type WorkspacePanePresentation =
  | { kind: "running" }
  | { kind: "waiting"; waitingKind: "approval" | "userInput" }
  | { kind: "completed" }
  | { kind: "failed" }
  | { kind: "unknown" }
  | { kind: "disconnected"; reason: string; lastConfirmed: string };

export type WorkspaceAgentActivity =
  | "working"
  | "idle"
  | "needs-user"
  | "held"
  | "spawning"
  | "done"
  | "failed"
  | "disconnected"
  | "unknown";

export interface WorkspaceAttentionPresentation {
  id: string;
  severity: "waiting" | "completed" | "failed" | "disconnected";
  title: string;
  detail: string;
  raisedAt: number;
}

export interface WorkspaceAgentPresentation {
  panePresence: "visible" | "closed";
  terminalState: "pending" | "live" | "reconnecting" | "exited" | "failed";
  headerDetail: string;
  paneStatus: WorkspacePanePresentation;
  activity: WorkspaceAgentActivity;
  attention: WorkspaceAttentionPresentation | null;
}

const observed = <T>(
  dimension: { kind: "observed"; field: { value: T } } | { kind: "absent" },
): T | null => (dimension.kind === "observed" ? dimension.field.value : null);

function dimensionHeader(
  dimension:
    | { kind: "observed"; field: { value: string; freshness: string } }
    | { kind: "absent"; reason: { kind: string } },
): string {
  if (dimension.kind === "absent") return `absent:${dimension.reason.kind}`;
  const marker =
    dimension.field.freshness === "fresh"
      ? ""
      : ` (${dimension.field.freshness})`;
  return `${dimension.field.value}${marker}`;
}

function headerDetail(agent: AgentRecord): string {
  const dimensions = agent.statusDimensions;
  if (dimensions === undefined) return agent.status;
  return [
    `runtime=${dimensionHeader(dimensions.runtime)}`,
    `turn=${dimensionHeader(dimensions.turn)}`,
    `input=${dimensionHeader(dimensions.input)}`,
    `mail=${dimensionHeader(dimensions.mail)}`,
    `health=${dimensionHeader(dimensions.health)}`,
    `attention=${dimensionHeader(dimensions.attention)}`,
  ].join(" · ");
}

function paneFromWord(raw: string): WorkspacePanePresentation {
  switch (raw) {
    case "spawning":
    case "working":
    case "idle":
      return { kind: "running" };
    case "awaiting-approval":
      return { kind: "waiting", waitingKind: "approval" };
    case "control-paused":
    case "stuck":
      return { kind: "waiting", waitingKind: "userInput" };
    case "done":
      return { kind: "completed" };
    case "failed":
      return { kind: "failed" };
    case "dead":
    case "exited":
      return {
        kind: "disconnected",
        reason: `process reported ${raw}`,
        lastConfirmed: raw,
      };
    default:
      return { kind: "unknown" };
  }
}

function paneFromDimensions(
  dimensions: WorkspaceStatusDimensionsV1,
): WorkspacePanePresentation {
  const health = observed(dimensions.health);
  if (health === "disconnected") {
    const turn = observed(dimensions.turn) ?? "unknown";
    return {
      kind: "disconnected",
      reason: "health reported disconnected",
      lastConfirmed: `turn=${turn}`,
    };
  }
  const attention = observed(dimensions.attention);
  if (attention === "approval") {
    return { kind: "waiting", waitingKind: "approval" };
  }
  if (attention === "action") {
    return { kind: "waiting", waitingKind: "userInput" };
  }
  if (attention === "failure") return { kind: "failed" };
  switch (observed(dimensions.turn)) {
    case "ready":
    case "working":
    case "idle":
    case "queued":
    case "submitting":
    case "cancelling":
      return { kind: "running" };
    case "awaiting_approval":
      return { kind: "waiting", waitingKind: "approval" };
    case "awaiting_answer":
    case "paused":
    case "stuck":
      return { kind: "waiting", waitingKind: "userInput" };
    case "done":
      return { kind: "completed" };
    case "failed":
      return { kind: "failed" };
    default:
      return { kind: "unknown" };
  }
}

function activityFromWord(raw: string): WorkspaceAgentActivity {
  switch (raw) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "awaiting-approval":
    case "control-paused":
    case "stuck":
      return "needs-user";
    case "held":
      return "held";
    case "spawning":
      return "spawning";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "dead":
    case "exited":
      return "disconnected";
    default:
      return "unknown";
  }
}

function activityFromDimensions(
  dimensions: WorkspaceStatusDimensionsV1,
  pane: WorkspacePanePresentation,
): WorkspaceAgentActivity {
  if (pane.kind === "disconnected") return "disconnected";
  if (pane.kind === "failed") return "failed";
  if (pane.kind === "waiting") return "needs-user";
  if (pane.kind === "completed") return "done";
  switch (observed(dimensions.turn)) {
    case "working":
    case "queued":
    case "submitting":
    case "cancelling":
      return "working";
    case "ready":
    case "idle":
      return "idle";
    case "awaiting_approval":
    case "awaiting_answer":
    case "paused":
    case "stuck":
      return "needs-user";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      break;
  }
  switch (observed(dimensions.runtime)) {
    case "starting":
    case "connecting":
      return "spawning";
    case "disconnected":
    case "exited":
      return "disconnected";
    default:
      return "unknown";
  }
}

function attentionSeverity(
  raw: string,
  dimensions: WorkspaceStatusDimensionsV1 | undefined,
): WorkspaceAttentionPresentation["severity"] | null {
  if (dimensions !== undefined) {
    if (observed(dimensions.health) === "disconnected") return "disconnected";
    switch (observed(dimensions.attention)) {
      case "action":
      case "approval":
        return "waiting";
      case "failure":
        return "failed";
      default:
        return null;
    }
  }
  switch (raw) {
    case "awaiting-approval":
    case "control-paused":
    case "stuck":
      return "waiting";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "dead":
    case "exited":
      return "disconnected";
    default:
      return null;
  }
}

function statusLabel(pane: WorkspacePanePresentation): string {
  switch (pane.kind) {
    case "running":
      return "is running";
    case "waiting":
      return pane.waitingKind === "approval"
        ? "is awaiting approval"
        : "needs input";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "disconnected":
      return "disconnected";
    case "unknown":
      return "status is unknown";
  }
}

export function presentWorkspaceAgent(
  agent: AgentRecord,
): WorkspaceAgentPresentation {
  const paneStatus =
    agent.statusDimensions === undefined
      ? paneFromWord(agent.status)
      : paneFromDimensions(agent.statusDimensions);
  const activity =
    agent.statusDimensions === undefined
      ? activityFromWord(agent.status)
      : activityFromDimensions(agent.statusDimensions, paneStatus);
  const severity = attentionSeverity(agent.status, agent.statusDimensions);
  const label = statusLabel(paneStatus);
  const panePresence: WorkspaceAgentPresentation["panePresence"] =
    agent.closedAt !== undefined ||
    (agent.statusDimensions === undefined && agent.status === "dead")
      ? "closed"
      : "visible";
  const terminalState: WorkspaceAgentPresentation["terminalState"] =
    panePresence === "closed"
      ? "exited"
      : activity === "spawning"
        ? "pending"
        : paneStatus.kind === "failed"
          ? "failed"
          : paneStatus.kind === "disconnected"
            ? "reconnecting"
            : "live";
  return {
    panePresence,
    terminalState,
    headerDetail: headerDetail(agent),
    paneStatus,
    activity,
    attention:
      severity === null
        ? null
        : {
            id: `status-agent:${agent.name}`,
            severity,
            title: `${agent.name} ${label}`,
            detail: agent.taskDescription || label,
            raisedAt: Date.parse(agent.lastEventAt) / 1_000,
          },
  };
}

export function presentWorkspaceOrchestrator(
  snapshot: WorkspaceOrchestratorSnapshot,
): Omit<WorkspaceAgentPresentation, "attention"> {
  const raw =
    snapshot.host === "sessiond" && snapshot.hostState === "failed"
      ? "failed"
      : (snapshot.status ?? "unknown");
  const terminalState: WorkspaceAgentPresentation["terminalState"] =
    snapshot.host === "sessiond" && snapshot.hostState === "running"
      ? "live"
      : snapshot.host === "sessiond" && snapshot.hostState === "exited"
        ? "exited"
        : snapshot.host === "sessiond" && snapshot.hostState === "failed"
          ? "failed"
          : "pending";
  return {
    panePresence: "visible",
    terminalState,
    headerDetail: raw,
    paneStatus: paneFromWord(raw),
    activity: activityFromWord(raw),
  };
}
