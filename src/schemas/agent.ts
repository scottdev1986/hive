import { z } from "zod";
import { RoutingTierSchema } from "./routing";

// Reserved recipient name for the root orchestrator. It is not a spawned
// agent and has no row in the agents table; delivery routes it through the
// dedicated root wake bridge instead of ordinary agent liveness checks.
export const ORCHESTRATOR_NAME = "orchestrator";

export const TerminalHandleSchema = z.discriminatedUnion("app", [
  z.object({
    app: z.literal("iterm2"),
    sessionId: z.string().min(1),
  }).strict(),
  z.object({
    app: z.literal("terminal"),
    processId: z.number().int().positive(),
    windowId: z.number().int().positive(),
    tty: z.string().min(1),
  }).strict(),
]);

export type TerminalHandle = z.infer<typeof TerminalHandleSchema>;

// A control restart must be able to reproduce the process that was actually
// launched without reading a routing table or a mutable tool default. Keep
// only immutable launch choices here; daemon ports, paths, permissions, and
// hook configuration remain dynamic and are rebuilt for the read-only run.
export const ExecutionIdentitySchema = z.discriminatedUnion("tool", [
  z.strictObject({
    tool: z.literal("claude"),
    model: z.string().min(1),
  }),
  z.strictObject({
    tool: z.literal("codex"),
    model: z.string().min(1),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
  }),
]);

export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;

// A closed agent is done with the world: it holds no tmux session, accepts no
// messages, and its name is free to be issued again. Every other status —
// including `spawning`, `control-paused`, and `stuck` — is a live holder that
// still owns its name.
export const TERMINAL_AGENT_STATUSES = ["done", "dead", "failed"] as const;

export type TerminalAgentStatus = (typeof TERMINAL_AGENT_STATUSES)[number];

export function isTerminalAgentStatus(
  status: string,
): status is TerminalAgentStatus {
  return (TERMINAL_AGENT_STATUSES as readonly string[]).includes(status);
}

export const AgentRecordSchema = z.object({
  // The AgentUUID: distinct per holder of a name, for the lifetime of the Hive.
  // Two agents that share a name across time never share an id, so history can
  // always tell them apart.
  id: z.string().min(1),
  name: z.string().min(1),
  tool: z.enum(["claude", "codex"]),
  model: z.string().min(1),
  tier: RoutingTierSchema,
  status: z.enum([
    "spawning",
    "working",
    "idle",
    "awaiting-approval",
    "control-paused",
    "stuck",
    "done",
    "dead",
    "failed",
  ]),
  failureReason: z.string().optional(),
  failedAt: z.iso.datetime().optional(),
  // When this holder closed. Stamped once, the first time the agent reaches a
  // terminal status, and cleared if crash recovery brings the same agent back.
  // Absent means the holder is live. This is what makes a name safe to reissue:
  // the daemon can always say which agent closed and when.
  closedAt: z.iso.datetime().optional(),
  quotaReservationId: z.string().min(1).optional(),
  controlQuotaReservationId: z.string().min(1).optional(),
  controlMessageId: z.string().min(1).optional(),
  executionIdentity: ExecutionIdentitySchema.optional(),
  taskDescription: z.string(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  tmuxSession: z.string().min(1),
  // The tool-level conversation identity (Claude session id, Codex thread id)
  // captured from hook traffic, so a crashed process can be relaunched with
  // its native resume instead of respawned from a blank prompt.
  toolSessionId: z.string().min(1).optional(),
  recoveryAttempts: z.number().int().nonnegative().default(0),
  terminalHandle: TerminalHandleSchema.optional(),
  contextPct: z.number().min(0).max(100),
  createdAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime(),
  capabilityEpoch: z.number().int().nonnegative().default(0),
  writeRevoked: z.boolean().default(false),
  // True only when hive launched this agent's CLI with the Channels research
  // preview enabled; channel delivery is never trusted for other sessions.
  channelsEnabled: z.boolean().default(false),
});

export type AgentRecord = z.infer<typeof AgentRecordSchema>;

/** A closed holder: keeps its row and its history, owns nothing. */
export function isClosedAgent(agent: Pick<AgentRecord, "status">): boolean {
  return isTerminalAgentStatus(agent.status);
}

/** The live holder of a name. Exactly one may exist at a time. */
export function isLiveAgent(agent: Pick<AgentRecord, "status">): boolean {
  return !isTerminalAgentStatus(agent.status);
}

/**
 * How an agent is named wherever history and live agents are shown together.
 * A bare `sarah` always means the agent answering to that name right now; a
 * past holder is always marked, `sarah (closed 14:11)`. Without this, a reused
 * name puts two indistinguishable `sarah` rows in front of the user — the
 * ambiguity the naming rules exist to prevent.
 *
 * Falls back to the record's own clock for rows written before Hive tracked
 * closure durably.
 */
export function describeAgentName(
  agent: Pick<
    AgentRecord,
    "name" | "status" | "closedAt" | "failedAt" | "lastEventAt"
  >,
): string {
  if (isLiveAgent(agent)) return agent.name;
  const closedAt = agent.closedAt ?? agent.failedAt ?? agent.lastEventAt;
  return `${agent.name} (closed ${closedAt.slice(11, 16)})`;
}
