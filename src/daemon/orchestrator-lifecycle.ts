import type { AgentMessage, AgentRecord, IdentityState } from "../schemas";
import type { ApprovalKind } from "./db";
import {
  attestationStateOf,
  OrchestratorMessageEnvelopeSchema,
  type OrchestratorMessageEnvelope,
} from "../schemas";
export { orchestratorTmuxSession } from "./tmux-sessions";

/**
 * How much of an agent's message rides into the orchestrator's context.
 *
 * 2KB was a prefix budget, and a prefix is the worst possible thing to keep: a
 * report opens with preamble and closes with the finding, so the cut landed on
 * the punchline — four times in one session, once literally on the line "THREE
 * FINDINGS THAT CHANGE DESIGN:", losing all three. Every one of those cost a
 * follow-up hive_read_message that pulled the WHOLE body into the root anyway,
 * so the small cap did not save the context it was protecting; it spent 2KB and
 * then spent the rest a turn later. Doubling it is what makes the common report
 * arrive whole and the follow-up read unnecessary. Combined with the head-and-
 * tail policy below, a message that still does not fit loses its middle rather
 * than its conclusion.
 */
export const ORCHESTRATOR_ENVELOPE_MAX_BYTES = 4_096;
const MAX_METADATA_CODE_POINTS = 128;
const MAX_TASK_CODE_POINTS = 160;
const encoder = new TextEncoder();

export interface ActiveAgentSummary {
  name: string;
  readOnly: boolean;
  tool: AgentRecord["tool"];
  /** The immutable launch model — what the agent was *spawned* with. */
  model: string;
  /** The observed running model, or null when Hive has not observed it. Never
   * the launch model: presenting the requested identity as the observed one is
   * exactly what this separation prevents. */
  liveModel: string | null;
  /** The observed running effort (Codex), null when unobserved. */
  liveEffort?: string | null;
  /** Codex execution-identity attestation verdict, present for Codex agents so
   * drift between the launch and observed identity is explicit rather than
   * hidden behind a single conflated model field. */
  identityState?: IdentityState;
  /** Null when Hive has not observed this agent's context. The orchestrator's
   * reuse rule must read null as "not eligible", never as "plenty of room". */
  contextPct: number | null;
  status: AgentRecord["status"];
  task: string;
  instructionCount: number;
  latestInstruction?: string;
  observedFiles: string[];
  overlaps: string[];
  graphifyCalls?: number | null;
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

/** Of what survives the cut, how much is head. The rest is tail. A report's
 * opening carries what it was about; its close carries what it found, the
 * merge hash, the blocker, the ask. Neither can be dropped, so both are kept
 * and the middle — the working-out — is what goes. */
const ENVELOPE_HEAD_SHARE = 0.6;

/** The body with its middle removed, keeping `keep` code points in total. The
 * marker is inside the measured budget, and it says how much is missing so the
 * reader can size the gap rather than guess at it. */
function elideMiddle(points: string[], keep: number): string {
  const head = Math.ceil(keep * ENVELOPE_HEAD_SHARE);
  const tail = keep - head;
  const marker = `\n…[${points.length - keep} characters elided; read the full body with ref]…\n`;
  return points.slice(0, head).join("") + marker +
    (tail > 0 ? points.slice(points.length - tail).join("") : "");
}

/**
 * The message as the orchestrator first sees it: bounded, honestly flagged, and
 * cut in the one place that costs least.
 *
 * The bound is real — an unbounded wake would let one agent's essay evict the
 * root's working context — but WHERE it cuts is a choice, and cutting the tail
 * off was the wrong one. So the binary search now sizes a head-and-tail body:
 * the largest head+tail that still fits the byte budget, with the middle
 * replaced by a marker naming what is missing. `truncated` stays exactly what
 * it always was (true iff something was dropped) and the full body stays
 * retrievable by id through `ref` — the preview is just no longer blind to the
 * end of the message it is previewing.
 */
export function createOrchestratorEnvelope(
  message: AgentMessage,
): OrchestratorMessageEnvelope {
  const points = codePoints(message.body);
  const whole = envelopeWithBody(message, message.body, false);
  if (fits(whole)) return whole;

  let low = 0;
  let high = points.length - 1;
  let best = envelopeWithBody(message, "", points.length > 0);

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = envelopeWithBody(
      message,
      elideMiddle(points, middle),
      true,
    );
    if (fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function fits(envelope: OrchestratorMessageEnvelope): boolean {
  const serialized = `📨 ${JSON.stringify(envelope)}`;
  return encoder.encode(serialized).byteLength <=
    ORCHESTRATOR_ENVELOPE_MAX_BYTES;
}

export function formatOrchestratorWake(
  envelope: OrchestratorMessageEnvelope,
): string {
  const value = OrchestratorMessageEnvelopeSchema.parse(envelope);
  return `📨 ${JSON.stringify(value)}`;
}

export function compactActiveTeam(
  agents: AgentRecord[],
  evidence: Map<string, { instructions: string[]; files: string[] }> = new Map(),
): ActiveAgentSummary[] {
  return agents
    .filter((agent) =>
      agent.status !== "dead" &&
      agent.status !== "done" &&
      agent.status !== "failed"
    )
    .map((agent) => {
      const observed = evidence.get(agent.name) ?? {
        instructions: [],
        files: [],
      };
      const overlaps = agents.filter((other) =>
        other.name !== agent.name &&
        !["dead", "done", "failed"].includes(other.status) &&
        (evidence.get(other.name)?.files ?? []).some((path) =>
          observed.files.includes(path)
        )
      )
        .map((other) => other.name);
      return {
      name: agent.name,
      readOnly: agent.readOnly,
      tool: agent.tool,
      // Launch and observed identity, kept separate. `model` is the immutable
      // launch model; `liveModel` is what was actually observed running, and it
      // stays null when unobserved rather than falling back to the launch model
      // — a fallback would present the requested identity as the observed one.
      model: agent.model,
      liveModel: agent.liveModel ?? null,
      // Attestation is a Codex concern; surfacing it only there keeps a truthful
      // "unattested" for Claude/Grok from reading as a problem where none exists.
      // `identitySource` carries the observation's provenance — "codex-rollout"
      // is a process-time scan (display grade), "codex-app-server" is the
      // process-bound attestation surface — so a reader of this row can tell
      // which claim it is looking at.
      ...(agent.tool === "codex"
        ? {
          liveEffort: agent.liveEffort ?? null,
          identityState: attestationStateOf(agent),
          identitySource: agent.observedIdentity?.source ?? null,
        }
        : {}),
      status: agent.status,
      contextPct: agent.contextPct === null
        ? null
        : Math.round(agent.contextPct),
      task: truncateCodePoints(
        agent.taskDescription.replaceAll(/\s+/g, " ").trim(),
        MAX_TASK_CODE_POINTS,
      ),
      instructionCount: observed.instructions.length,
      ...(observed.instructions.at(-1) === undefined ? {} : {
        latestInstruction: truncateCodePoints(
          observed.instructions.at(-1)!.replaceAll(/\s+/g, " ").trim(),
          MAX_TASK_CODE_POINTS,
        ),
      }),
      observedFiles: observed.files,
      overlaps,
      ...(Object.hasOwn(agent, "graphifyCalls")
        ? {
          graphifyCalls:
            (agent as AgentRecord & { graphifyCalls: number | null })
              .graphifyCalls,
        }
        : {}),
      lastEventAt: agent.lastEventAt,
      };
    });
}

const MAX_SPAWN_TASK_CODE_POINTS = 120;
const MAX_SEND_BODY_CODE_POINTS = 120;
const MAX_APPROVAL_DESCRIPTION_CODE_POINTS = 200;

export interface SpawnResultSummary {
  id: string;
  name: string;
  tool: AgentRecord["tool"];
  model: string;
  category: AgentRecord["category"];
  effort?: string;
  status: AgentRecord["status"];
  branch: string | null;
  worktreePath: string | null;
  contextPct: number | null;
  readOnly: boolean;
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
    category: agent.category,
    ...(agent.executionIdentity?.effort !== undefined
      ? { effort: agent.executionIdentity.effort }
      : {}),
    status: agent.status,
    branch: agent.branch,
    worktreePath: agent.worktreePath,
    contextPct: agent.contextPct,
    readOnly: agent.readOnly,
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
  /** Present exactly when the send left the message queued at a live agent:
   * the recipient's measured state and what it means for when — or whether —
   * this message can be heard (queuedDeliveryNote). */
  delivery?: string;
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

/**
 * hive_approvals is polled repeatedly while a request sits pending, so a long
 * description is re-sent unchanged on every poll. Trimming it is worth real
 * context — but only where the description carries no decision content.
 *
 * IT IS TRIMMED BY KIND, NEVER BY LENGTH. A `tool-permission` description IS
 * the thing being approved (the shell command Codex wants to run, the tool
 * call and its input preview): cutting its tail would let an approver approve
 * a command whose tail they never saw, which is a security failure wearing a
 * cosmetic justification. Those come back whole, however long they are. Only
 * the boilerplate kinds — `cost-consent`, `land-rearm`, whose text is a fixed
 * paragraph around an id the caller already has — are cut, and an unclassified
 * row defaults to `tool-permission` and is left whole (see `ApprovalKind`).
 */
export function compactApprovalDescription<
  T extends { description: string; kind: ApprovalKind },
>(approval: T): T & { truncated: boolean } {
  if (approval.kind === "tool-permission") {
    return { ...approval, truncated: false };
  }
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
