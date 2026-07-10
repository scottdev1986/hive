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
  status: AgentRecord["status"];
  contextPct: number;
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
      model: agent.model,
      status: agent.status,
      contextPct: Math.round(agent.contextPct),
      task: truncateCodePoints(
        agent.taskDescription.replaceAll(/\s+/g, " ").trim(),
        MAX_TASK_CODE_POINTS,
      ),
      lastEventAt: agent.lastEventAt,
    }));
}
