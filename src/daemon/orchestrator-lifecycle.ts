import type { AgentMessage, AgentRecord } from "../schemas";
import {
  OrchestratorMessageEnvelopeSchema,
  type OrchestratorMessageEnvelope,
} from "../schemas";
export { orchestratorTmuxSession } from "./tmux-sessions";

export const ORCHESTRATOR_ENVELOPE_MAX_BYTES = 2_048;
const MAX_METADATA_CODE_POINTS = 128;
const MAX_TASK_CODE_POINTS = 160;
const encoder = new TextEncoder();

export interface ActiveAgentSummary {
  name: string;
  tool: AgentRecord["tool"];
  model: string;
  /** Null when Hive has not observed this agent's context. The orchestrator's
   * reuse rule must read null as "not eligible", never as "plenty of room". */
  contextPct: number | null;
  status: AgentRecord["status"];
  task: string;
  lastEventAt: string;
}

const codePoints = (value: string): string[] => Array.from(value);

function truncateCodePoints(value: string, maximum: number): string {
  const points = codePoints(value);
  if (points.length <= maximum) {
    return value;
  }
  return `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function envelopeWithBody(
  message: AgentMessage,
  body: string,
  truncated: boolean,
): OrchestratorMessageEnvelope {
  const id = truncateCodePoints(message.id, MAX_METADATA_CODE_POINTS);
  return OrchestratorMessageEnvelopeSchema.parse({
    kind: "hive.message",
    id,
    from: truncateCodePoints(message.from, MAX_METADATA_CODE_POINTS),
    createdAt: message.createdAt,
    body,
    truncated,
    ref: `hive_read_message id=${JSON.stringify(id)}`,
  });
}

export function createOrchestratorEnvelope(
  message: AgentMessage,
): OrchestratorMessageEnvelope {
  const points = codePoints(message.body);
  let low = 0;
  let high = points.length;
  let best = envelopeWithBody(message, "", points.length > 0);

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = envelopeWithBody(
      message,
      points.slice(0, middle).join(""),
      middle < points.length,
    );
    const serialized = `📨 ${JSON.stringify(candidate)}`;
    if (encoder.encode(serialized).byteLength <= ORCHESTRATOR_ENVELOPE_MAX_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

export function formatOrchestratorWake(
  envelope: OrchestratorMessageEnvelope,
): string {
  const value = OrchestratorMessageEnvelopeSchema.parse(envelope);
  return `📨 ${JSON.stringify(value)}`;
}

export function compactActiveTeam(
  agents: AgentRecord[],
): ActiveAgentSummary[] {
  return agents
    .filter((agent) =>
      agent.status !== "dead" &&
      agent.status !== "done" &&
      agent.status !== "failed"
    )
    .map((agent) => ({
      name: agent.name,
      tool: agent.tool,
      // The model it is running, not the one it was spawned with — this is the
      // view the orchestrator routes off.
      model: agent.liveModel ?? agent.model,
      status: agent.status,
      contextPct: agent.contextPct === null
        ? null
        : Math.round(agent.contextPct),
      task: truncateCodePoints(
        agent.taskDescription.replaceAll(/\s+/g, " ").trim(),
        MAX_TASK_CODE_POINTS,
      ),
      lastEventAt: agent.lastEventAt,
    }));
}

const MAX_SPAWN_TASK_CODE_POINTS = 120;
const MAX_SEND_BODY_CODE_POINTS = 120;
const MAX_APPROVAL_DESCRIPTION_CODE_POINTS = 200;

export interface SpawnResultSummary {
  id: string;
  name: string;
  tool: AgentRecord["tool"];
  model: string;
  tier: AgentRecord["tier"];
  effort?: string;
  status: AgentRecord["status"];
  branch: string | null;
  worktreePath: string | null;
  contextPct: number | null;
  quotaReservationId?: string;
  taskDescription: string;
  taskDescriptionLength: number;
}

// hive_spawn's caller just wrote taskDescription itself — echoing the whole
// multi-kilobyte brief back doubles the cost of every spawn for no new
// information. hive_status still carries the full record for whoever needs
// to re-read it.
export function compactSpawnResult(agent: AgentRecord): SpawnResultSummary {
  return {
    id: agent.id,
    name: agent.name,
    tool: agent.tool,
    model: agent.model,
    tier: agent.tier,
    ...(agent.executionIdentity?.effort !== undefined
      ? { effort: agent.executionIdentity.effort }
      : {}),
    status: agent.status,
    branch: agent.branch,
    worktreePath: agent.worktreePath,
    contextPct: agent.contextPct,
    ...(agent.quotaReservationId !== undefined
      ? { quotaReservationId: agent.quotaReservationId }
      : {}),
    taskDescription: truncateCodePoints(
      agent.taskDescription,
      MAX_SPAWN_TASK_CODE_POINTS,
    ),
    taskDescriptionLength: codePoints(agent.taskDescription).length,
  };
}

export interface SendResultSummary {
  id: string;
  from: string;
  to: string;
  state: AgentMessage["state"];
  priority: AgentMessage["priority"];
  sequence: number;
  createdAt: string;
  deliveredAt: string | null;
  body: string;
  truncated: boolean;
}

// hive_send's caller just wrote body itself; echoing it back in full doubles
// the cost of every send. The recipient reads the full body through
// hive_inbox/hive_read_message, which is where a body is meant to be read.
export function compactSendResult(message: AgentMessage): SendResultSummary {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    state: message.state,
    priority: message.priority,
    sequence: message.sequence,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt,
    body: truncateCodePoints(message.body, MAX_SEND_BODY_CODE_POINTS),
    truncated: codePoints(message.body).length > MAX_SEND_BODY_CODE_POINTS,
  };
}

// hive_approvals is polled repeatedly while a request sits pending, and a
// long cost-consent or tool-permission paragraph does not change between
// polls — only the first ~200 characters are needed to recognize which
// request this is; the fuller decision-critical wording lives at the front of
// that description by convention (see cost-consent.ts, receiveChannelPermissionRequest).
export function compactApprovalDescription<T extends { description: string }>(
  approval: T,
): T & { truncated: boolean } {
  const points = codePoints(approval.description);
  return {
    ...approval,
    description: truncateCodePoints(
      approval.description,
      MAX_APPROVAL_DESCRIPTION_CODE_POINTS,
    ),
    truncated: points.length > MAX_APPROVAL_DESCRIPTION_CODE_POINTS,
  };
}
