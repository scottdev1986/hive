import { z } from "zod";
import { CapabilityProviderSchema, EffortLevelSchema } from "./capability";
import { RoutingCategorySchema } from "./routing-policy";
import { SessionLocatorSchema } from "./session-protocol";
import { WorkspaceStatusDimensionsV1Schema } from "./status-envelope";

export const ORCHESTRATOR_NAME = "queen";
/** The Queen has no agent record, so her events are filed under the root subject — the same id the Workspace feed gives her session. */
export const ORCHESTRATOR_EVENT_ENTITY_ID = "root";

export const ORCHESTRATOR_NAME_ALIASES = ["orchestrator"] as const;

export function orchestratorRecipientNames(): readonly string[] {
  return [ORCHESTRATOR_NAME, ...ORCHESTRATOR_NAME_ALIASES];
}

export function isOrchestratorName(name: string): boolean {
  const normalized = name.toLowerCase();
  return orchestratorRecipientNames().includes(normalized);
}

export function canonicalOrchestratorName(name: string): string {
  return isOrchestratorName(name) ? ORCHESTRATOR_NAME : name;
}

export const ExecutionIdentitySchema = z.discriminatedUnion("tool", [
  z.strictObject({
    tool: z.literal("claude"),
    model: z.string().min(1),
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
  z.strictObject({
    tool: z.literal("kimi"),
    model: z.string().min(1),
    effort: EffortLevelSchema.optional(),
  }),
  z.strictObject({
    tool: z.literal("opencode"),
    model: z.string().min(1),
    effort: EffortLevelSchema.optional(),
  }),
]);

export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;

export const TERMINAL_AGENT_STATUSES = ["done", "dead"] as const;

export type TerminalAgentStatus = (typeof TERMINAL_AGENT_STATUSES)[number];

export function isTerminalAgentStatus(
  status: string,
): status is TerminalAgentStatus {
  // SAFETY: The surrounding code already established this contract.
  return (TERMINAL_AGENT_STATUSES as readonly string[]).includes(status);
}

const AgentRecordFields = {
  // The AgentUUID: distinct per holder of a name, for the lifetime of the Hive. Two agents that share a name across time never share an id, so history can always tell them apart.
  id: z.string().min(1),
  name: z.string().min(1),
  tool: CapabilityProviderSchema,
  /** The model this agent was *launched* with. A control restart replays this immutable execution identity to reproduce the launch it is interrupting. It is an intention, and it never changes. */
  model: z.string().min(1),
  /** The model this agent is *observed* running, read from its transcript. A user who types `/model` mid-session changes this and not `model`. Absent means "no observation" — never "the same as spawn", because a guess is what this field exists to stop. Quota accounting and `hive status` read it first. */
  liveModel: z.string().min(1).optional(),
  category: RoutingCategorySchema,
  status: z.enum([
    "spawning",
    "working",
    "idle",
    "unknown",
    "awaiting-approval",
    "control-paused",
    /** Held by the quota drain handler when its provider's window is spent and resets soon; the 30s sweep pokes it past the reset. */
    "held",
    "stuck",
    "done",
    "dead",
  ]),
  // A hive_status-only projection. The flat word above stays during the migration window, but it cannot substitute for any dimensional fact.
  statusDimensions: WorkspaceStatusDimensionsV1Schema.optional(),
  /** Why the drain handler is holding this agent (pool + window + reset). */
  holdReason: z.string().nullable().optional(),
  holdResetAt: z.iso.datetime().nullable().optional(),
  holdProviderRunId: z.string().uuid().nullable().optional(),
  closedAt: z.iso.datetime().optional(),
  quotaReservationId: z.string().min(1).optional(),
  controlQuotaReservationId: z.string().min(1).optional(),
  controlMessageId: z.string().min(1).optional(),
  executionIdentity: ExecutionIdentitySchema.optional(),
  taskDescription: z.string(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  sessionLocator: SessionLocatorSchema.optional(),
  toolSessionId: z.string().min(1).optional(),
  /** How full this agent's context is, or **null when Hive has not observed it**. Do not substitute zero for null: zero means an empty observed context, while null means Hive has no evidence. Treating null as zero can invite more work onto an agent whose context Hive cannot inspect. Hive has no automatic recycle actuator. The orchestrator may use this as one input to reuse, and must treat null as "not eligible", never as room. */
  contextPct: z.number().min(0).max(100).nullable(),
  // The context window Claude Code reported for this session via the statusLine payload's `context_window_size` — 200000, or 1000000 where the account's plan upgrades it. Absent until a protocol session fact has ever carried it. This is the measured denominator the telemetry sweep divides the transcript's token count by; it is never defaulted, because a guessed A guessed denominator can substantially overstate context use.
  contextWindow: z.number().int().positive().optional(),
  // Per-session graph-tool adoption observed from the agent's provider artifacts. Present only on hive_status rows when graphify is configured; null means no trustworthy observation, never zero calls.
  graphifyCalls: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime(),
  landedCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  landedAt: z.iso.datetime().optional(),
  capabilityEpoch: z.number().int().nonnegative().default(0),
  readOnly: z.boolean().default(false),
  writeRevoked: z.boolean().default(false),
} as const;

export const AgentRecordObjectSchema = z.object(AgentRecordFields);

export const AgentRecordSchema = z.strictObject(AgentRecordFields);

export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export function isLiveAgent(agent: Pick<AgentRecord, "status">): boolean {
  return !isTerminalAgentStatus(agent.status);
}

/** How an agent is named wherever history and live agents are shown together. A bare `sarah` always means the agent answering to that name right now; a past holder is always marked, `sarah (closed 14:11)`. Without this, a reused name puts two indistinguishable `sarah` rows in front of the user — the ambiguity the naming rules exist to prevent. Falls back to the record's own clock when durable closure time is absent. */
export function describeAgentName(
  agent: Pick<AgentRecord, "name" | "status" | "closedAt" | "lastEventAt">,
): string {
  if (isLiveAgent(agent)) return agent.name;
  const closedAt = agent.closedAt ?? agent.lastEventAt;
  return `${agent.name} (closed ${closedAt.slice(11, 16)})`;
}
