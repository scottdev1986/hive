import { z } from "zod";
import { RoutingCategorySchema } from "./routing-policy";
import { CapabilityProviderSchema, EffortLevelSchema } from "./capability";

// Preferred user-facing name of the root orchestrator. It is not a spawned
// agent and has no row in the agents table; delivery routes it through the
// dedicated root delivery path instead of ordinary agent liveness checks.
// The architectural role word remains "orchestrator"; this is the address.
export const ORCHESTRATOR_NAME = "queen";

// Compatibility synonym still accepted for addressing. Not removed: callers
// and memories that say "orchestrator" must keep working.
export const ORCHESTRATOR_NAME_ALIASES = ["orchestrator"] as const;

/** Every accepted root recipient name: preferred first, then synonyms. */
export function orchestratorRecipientNames(): readonly string[] {
  return [ORCHESTRATOR_NAME, ...ORCHESTRATOR_NAME_ALIASES];
}

/** True when `name` addresses the root (preferred or synonym), case-insensitive. */
export function isOrchestratorName(name: string): boolean {
  const normalized = name.toLowerCase();
  return orchestratorRecipientNames().includes(normalized);
}

/** Collapse any accepted root name to the preferred form; leave others alone. */
export function canonicalOrchestratorName(name: string): string {
  return isOrchestratorName(name) ? ORCHESTRATOR_NAME : name;
}

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

// The provider surface an observation of the *running* identity was read from.
// Codex is the only vendor Hive attests today; Claude and Grok keep their
// existing `liveModel` reconciliation path untouched.
export const ObservedIdentitySourceSchema = z.enum([
  // Newest main-thread `source=cli` `turn_context` in the Codex TUI rollout.
  "codex-rollout",
  // A native Codex app-server thread/turn notification.
  "codex-app-server",
]);

export type ObservedIdentitySource = z.infer<typeof ObservedIdentitySourceSchema>;

// What Hive has *observed* the process running, with the provenance of the
// observation. This is never synthesized from the launch request: an absent
// `observedIdentity` means "not observed", never "the same as launch". It is
// the richer companion of `liveModel`/`liveEffort`, which stay for wire
// compatibility.
export const ObservedIdentitySchema = z.strictObject({
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
  // The provider-native session id the observation came from (Codex rollout
  // session id / app-server thread id), so a stale predecessor's artifact can
  // never be mistaken for this agent's identity.
  sessionId: z.string().min(1).optional(),
  // The provider-native turn id the identity was read from.
  turnId: z.string().min(1).optional(),
  source: ObservedIdentitySourceSchema,
  observedAt: z.iso.datetime(),
});

export type ObservedIdentity = z.infer<typeof ObservedIdentitySchema>;

// How the observed identity relates to the immutable launch identity. A Codex
// writer may only reach a mutating tool while this is `matching`; every other
// value fails closed.
// - `unattested`: never observed — the spawn default, before any turn boundary
//   has produced an identity record. Also the reset value on app-server->TUI
//   fallback.
// - `matching`: observed model AND effort equal the launch identity.
// - `drift`: a complete observation differs from the launch identity.
// - `unknown`: an observation was attempted but the artifact was missing or
//   unparseable, or was incomplete (e.g. model without effort). Unknown is not
//   matching; it blocks writer mutation exactly like drift, without asserting a
//   deliberate change occurred.
export const IdentityStateSchema = z.enum([
  "unattested",
  "matching",
  "drift",
  "unknown",
]);

export type IdentityState = z.infer<typeof IdentityStateSchema>;

/** The immutable launch identity — decision 6's execution identity. The durable
 * field is `executionIdentity`; `hive status` surfaces it as `launchIdentity`
 * beside `observedIdentity` so a reader never confuses intent with observation.
 * This function names that concept without duplicating the stored field. */
export function launchIdentityOf(
  agent: Pick<AgentRecord, "executionIdentity">,
): ExecutionIdentity | undefined {
  return agent.executionIdentity;
}

/** Compare a *complete* observation against the launch intent. Both model and
 * effort must match. A caller that could not read both fields must record
 * `unknown` instead of calling this — a missing observation is never a match. */
export function compareObservedIdentity(
  launch: Pick<ExecutionIdentity, "model" | "effort">,
  observed: Pick<ObservedIdentity, "model" | "effort">,
): "matching" | "drift" {
  const modelMatches = observed.model === launch.model;
  const effortMatches = (launch.effort ?? undefined) ===
    (observed.effort ?? undefined);
  return modelMatches && effortMatches ? "matching" : "drift";
}

/** The attestation state of an agent, reading an absent field as the
 * fail-closed `unattested`. Every consumer must go through this rather than
 * touching `identityState` directly, so a null column can never be mistaken
 * for a permissive value. */
export function attestationStateOf(
  agent: Pick<AgentRecord, "identityState">,
): IdentityState {
  return agent.identityState ?? "unattested";
}

/** A Codex writer may only reach a mutating tool while attestation is
 * `matching`. Every other state — including the `unattested` spawn default and
 * an `unknown` unreadable observation — fails closed. Exported so the guard,
 * the maintenance backstop, and the tests share one definition of "safe". */
export function identityStatePermitsMutation(state: IdentityState): boolean {
  return state === "matching";
}

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
  /** The effort this agent is *observed* running — the effort sibling of
   * `liveModel`, kept separate from the immutable launch `executionIdentity.effort`
   * for the same reason. Codex reads it from the newest `turn_context`; Claude
   * and Grok leave it unset. Absent means "not observed", never "same as launch". */
  liveEffort: z.string().min(1).optional(),
  /** Provider-native observation of the running execution identity, with its
   * provenance and timestamp. Distinct from `executionIdentity` (the immutable
   * launch intent) and never synthesized from it. Populated for Codex only. */
  observedIdentity: ObservedIdentitySchema.optional(),
  /** Attestation verdict comparing `observedIdentity` to the launch identity.
   * A Codex writer may only reach a mutating tool while this is `matching`;
   * `unattested`/`unknown`/`drift` all fail closed. Absent is read through
   * `attestationStateOf` as `unattested` — the fail-closed spawn default and
   * the reset value on an app-server->TUI fallback. */
  identityState: IdentityStateSchema.optional(),
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
   * Hive has no automatic recycle actuator. The orchestrator may use this as
   * one input to reuse, and must treat null as "not eligible", never as room.
   */
  contextPct: z.number().min(0).max(100).nullable(),
  // The context window Claude Code reported for this session via the
  // statusLine payload's `context_window_size` — 200000, or 1000000 where the
  // account's plan upgrades it. Absent until a statusline report has ever
  // carried it. This is the measured denominator the telemetry sweep divides
  // the transcript's token count by; it is never defaulted, because a guessed
  // 200k once reported agents at ~22% of a 1M window as 100% full.
  contextWindow: z.number().int().positive().optional(),
  // Per-session graph-tool adoption observed from the agent's provider
  // artifacts. Present only on hive_status rows when graphify is configured;
  // null means no trustworthy observation, never zero calls.
  graphifyCalls: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime(),
  capabilityEpoch: z.number().int().nonnegative().default(0),
  // Durable launch posture. A reader was intentionally launched without
  // write/land authority; that is distinct from a writer whose authority was
  // later revoked by critical control.
  readOnly: z.boolean().default(false),
  writeRevoked: z.boolean().default(false),
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
