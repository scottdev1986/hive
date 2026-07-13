import { z } from "zod";
import { RoutingCategorySchema } from "./routing-policy";
import { CapabilityProviderSchema, EffortLevelSchema } from "./capability";

// Reserved recipient name for the root orchestrator. It is not a spawned
// agent and has no row in the agents table; delivery routes it through the
// dedicated root wake bridge instead of ordinary agent liveness checks.
export const ORCHESTRATOR_NAME = "orchestrator";

// A control restart must be able to reproduce the process that was actually
// launched without reading a routing table or a mutable tool default. Keep
// only immutable launch choices here; daemon ports, paths, permissions, and
// hook configuration remain dynamic and are rebuilt for the read-only run.
export const ExecutionIdentitySchema = z.discriminatedUnion("tool", [
  z.strictObject({
    tool: z.literal("claude"),
    model: z.string().min(1),
    // Optional only for the short launch window before Claude's first
    // statusLine render, and for legacy rows. Once observed it is immutable.
    effort: EffortLevelSchema.optional(),
  }),
  z.strictObject({
    tool: z.literal("codex"),
    model: z.string().min(1),
    effort: EffortLevelSchema,
  }),
  z.strictObject({
    tool: z.literal("grok"),
    model: z.string().min(1),
    effort: EffortLevelSchema.optional(),
    cliVersion: z.string().min(1),
    cliBuildHash: z.string().min(1),
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

const RETIRED_VIEWER_FIELD = ["terminal", "Handle"].join("");

const AgentRecordShape = {
  // The AgentUUID: distinct per holder of a name, for the lifetime of the Hive.
  // Two agents that share a name across time never share an id, so history can
  // always tell them apart.
  id: z.string().min(1),
  name: z.string().min(1),
  tool: CapabilityProviderSchema,
  /** The model this agent was *launched* with — decision 6's immutable execution
   * identity, which a control restart replays to reproduce the launch it is
   * interrupting. It is an intention, and it never changes. */
  model: z.string().min(1),
  /** The model this agent is *observed* running, read from its transcript. A
   * user who types `/model` mid-session changes this and not `model`. Absent
   * means "no observation" — never "the same as spawn", because a guess is what
   * this field exists to stop. Quota accounting and `hive status` read it first. */
  liveModel: z.string().min(1).optional(),
  /** The task category this agent was spawned under (was `tier` before the
   * 2026-07-13 cutover; existing rows are migrated at database open). */
  category: RoutingCategorySchema,
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
  /**
   * How full this agent's context is, or **null when Hive has not observed it**.
   *
   * Null is the whole point of the field being shaped this way. It used to be a
   * plain number, so "unknown" was unrepresentable and every unobserved agent
   * fell back to the spawn default of 0 — which does not mean "empty", it means
   * "we have no idea", and it lies in the *flattering* direction: 0% invites the
   * orchestrator to pile more work onto an agent it can see nothing about. A
   * live Codex agent that had done real work sat at 0% for exactly this reason.
   *
   * Decision 7's recycle line and the orchestrator's reuse rule both read this,
   * and both must treat null as "not eligible", never as "plenty of room".
   */
  contextPct: z.number().min(0).max(100).nullable(),
  // The context window Claude Code reported for this session via the
  // statusLine payload's `context_window_size` — 200000, or 1000000 where the
  // account's plan upgrades it. Absent until a statusline report has ever
  // carried it. This is the measured denominator the telemetry sweep divides
  // the transcript's token count by; it is never defaulted, because a guessed
  // 200k once reported agents at ~22% of a 1M window as 100% full.
  contextWindow: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime(),
  capabilityEpoch: z.number().int().nonnegative().default(0),
  // Durable launch posture. A reader was intentionally launched without
  // write/land authority; that is distinct from a writer whose authority was
  // later revoked by critical control.
  readOnly: z.boolean().default(false),
  writeRevoked: z.boolean().default(false),
  // True only when hive launched this agent's CLI with the Channels research
  // preview enabled; channel delivery is never trusted for other sessions.
  channelsEnabled: z.boolean().default(false),
} as const;

export const AgentRecordObjectSchema = z.object(AgentRecordShape);

export const AgentRecordSchema = z.preprocess((value) => {
  if (
    typeof value === "object" && value !== null &&
    RETIRED_VIEWER_FIELD in value
  ) {
    throw new Error("retired external-viewer state is not accepted");
  }
  return value;
}, z.strictObject(AgentRecordShape));

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
