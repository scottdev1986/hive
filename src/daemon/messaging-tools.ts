import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Action, Capability } from "./capabilities";
import type { HiveDatabase } from "./db";
import { type MessageDelivery, queuedDeliveryNote } from "./delivery";
import type { MachineMutationCoordinator } from "./mutation-lease";
import type { Spawner, SpawnRequest } from "./spawner";
import { compactSendResult } from "./orchestrator-lifecycle";
import type { StatusStore } from "./status-store";
import { toolResult } from "./tool-result";
import {
  type AgentRecord,
  ControlIntentSchema,
  HandoffSchema,
  isOrchestratorName,
  MessagePrioritySchema,
  ORCHESTRATOR_NAME,
} from "../schemas";

export function inferLegacyControl(body: string): {
  priority: "critical";
  intent: "pause" | "stop" | "cancel" | "restrict-writes";
} | null {
  const value = body.trim().toLowerCase();
  if (/^cancel(?:\s+(?:this task|work|now))?[.!]?$/.test(value)) {
    return { priority: "critical", intent: "cancel" };
  }
  if (/^stop(?:\s+(?:this task|work|now|working))?[.!]?$/.test(value)) {
    return { priority: "critical", intent: "stop" };
  }
  if (
    /^(?:pause before (?:coding|writing|modifying)|pause work)\b/.test(value)
  ) {
    return { priority: "critical", intent: "pause" };
  }
  if (/^(?:do not|don't) (?:modify|write|edit)\b/.test(value)) {
    return { priority: "critical", intent: "restrict-writes" };
  }
  return null;
}

export const SendRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  priority: MessagePrioritySchema.optional(),
  intent: ControlIntentSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  deadlineMs: z.number().int().positive().optional(),
});

export const MessageAcknowledgementSchema = z.object({
  agent: z.string().min(1),
  messageId: z.string().min(1),
  capabilityEpoch: z.number().int().nonnegative().optional(),
  applied: z.boolean().optional().default(false),
});

export const EscalationRequestSchema = z.object({
  agent: z.string().min(1),
  reason: z.string().min(1),
  goal: z.string().min(1),
  done: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  failedApproaches: z.array(z.string().min(1)).min(1),
});

export const InboxRequestSchema = z.object({
  agent: z.string().min(1),
});

export const ReadMessageRequestSchema = z.object({
  id: z.string().min(1),
});

export const PickupHandoffRequestSchema = z.object({
  agent: z.string().min(1),
  handoffId: z.string().uuid(),
});

/**
 * The agent-to-agent messaging tool surface, with its dependencies named.
 *
 * Third tool-group extraction out of `createMcpServer` (audit §11).
 * `memoryPressure` crosses as a **getter**, not a value: this surface reads it
 * to refuse sends while the machine is under pressure, and the resource sweep
 * writes it on its own schedule — a boolean copied at registration time would
 * pin the answer to whatever was true when the MCP server was built.
 */
export interface MessagingToolDeps {
  db: HiveDatabase;
  delivery: MessageDelivery;
  spawner: Spawner;
  status: StatusStore;
  machineMutations: Pick<MachineMutationCoordinator, "beginOperation"> | null;
  memoryPressure: () => boolean;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  acknowledgeControlMessage: (
    agentName: string,
    messageId: string,
    capabilityEpoch: number | undefined,
    applied: boolean,
  ) => Promise<unknown>;
}

export function registerMessagingTools(
  server: McpServer,
  capability: Capability,
  deps: MessagingToolDeps,
): void {
  server.registerTool(
    "hive_send",
    {
      title: "Send agent message",
      description:
        'Send a durable message and return its real lifecycle state. normal is ordinary guidance and lands at a turn boundary. steer is prompt, NON-DESTRUCTIVE guidance: Claude and Codex receive it mid-turn at the next tool boundary without cancellation; Grok, OpenCode, and Kimi expose no Hive-wired mid-turn steer boundary, so steer degrades to the next turn. urgent is Codex-only: with a live native Codex control it cancels the exact in-flight turn, waits for turn/completed, then starts the urgent instruction; Claude, Grok, OpenCode, Kimi, queen, and Codex without a live native control fail without queuing because Hive cannot prove cancellation. To stop a runaway agent on any vendor, use critical: it revokes write and landing authority, applies the typed control to the verified provider run, and restarts the target read-only; unsupported or unverified control surfaces fail loudly. "queued" means not delivered, "injected" means handed to the vendor, and "applied" means receipt measured on the vendor\'s own boundary/transcript surface; queued/injected is SENT, not RECEIVED and not STOPPED. Never report a target as informed from enqueue or transport silence. Recipient queen wakes the root (preferred name; synonym "orchestrator" remains accepted). The returned body is a short head-and-tail preview; read the durable message for the full body.',
      inputSchema: SendRequestSchema,
    },
    async ({ from, to, body, ...requested }) => {
      // `from` is a claim about identity, so it is checked against the bound
      // subject rather than trusted. No agent can forge a message from another.
      deps.authorizeTool(capability, "hive_send", "message:send", from, false);
      const inferred =
        requested.priority === undefined && requested.intent === undefined
          ? inferLegacyControl(body)
          : null;
      const message = await deps.delivery.send(from, to, body, {
        ...requested,
        ...(inferred ?? {}),
      });
      // A send that left the message queued tells the sender what queued means
      // for THIS recipient right now — measured from its row, not implied by
      // the state name. "Queued" read as "delivered" is how an agent shipped a
      // migration without the safety requirements sent nine minutes earlier.
      const note = queuedDeliveryNote(
        message,
        isOrchestratorName(to) ? null : deps.db.getAgentByName(to),
      );
      return toolResult(
        note === undefined
          ? compactSendResult(message)
          : { ...compactSendResult(message), delivery: note },
        "message",
      );
    },
  );

  server.registerTool(
    "hive_escalate",
    {
      title: "Escalate: wrong model for this task",
      description:
        "Raise a typed capability escalation: this task exceeds the model you were launched on. " +
        "Carry evidence (why, and at least one concrete failed approach) plus a handoff " +
        "(goal, done, remaining, decisions) the replacement resumes from. Commit your WIP " +
        "to your branch FIRST — the handoff points at it. The orchestrator decides: it may " +
        "respawn the task on a stronger route with your handoff, or tell you to continue. " +
        "Keep working until it answers. Escalations are recorded and measured per model " +
        "and category; escalate once per genuine wall, not to shop for a bigger model.",
      inputSchema: EscalationRequestSchema,
    },
    async ({
      agent,
      reason,
      goal,
      done,
      remaining,
      decisions,
      failedApproaches,
    }) => {
      // The claimed identity is checked, not trusted, exactly as in hive_send:
      // an escalation is a structured send plus a telemetry row.
      deps.authorizeTool(
        capability,
        "hive_escalate",
        "message:send",
        agent,
        false,
      );
      const record = deps.db.getAgentByName(agent);
      if (record === null) {
        throw new Error(`Cannot escalate: no agent named ${agent} exists`);
      }
      if (record.branch === null) {
        throw new Error(
          `Cannot escalate: ${agent} has no branch to hand off. Only spawned ` +
            "writer agents with a worktree can escalate",
        );
      }
      const now = new Date().toISOString();
      const handoff = HandoffSchema.parse({
        agentName: agent,
        goal,
        done,
        remaining,
        decisions,
        failedApproaches,
        branch: record.branch,
        timestamp: now,
      });
      // Measured BEFORE this row lands, so the message reports prior attempts.
      const prior = deps.db.countEscalationsForAgent(record.id);
      const escalation = deps.db.insertEscalation({
        id: crypto.randomUUID(),
        agentId: record.id,
        agentName: agent,
        // The launch identity: the row must join the routing decision that
        // produced it, and that decision chose the launch model.
        model: record.model,
        category: record.category,
        reason,
        createdAt: now,
      });
      const message = await deps.delivery.send(
        agent,
        ORCHESTRATOR_NAME,
        [
          `CAPABILITY ESCALATION from ${agent} (category=${record.category}, model=${record.model}` +
            `${prior > 0 ? `; escalation #${prior + 1} from this agent` : ""}): ${reason}`,
          `Tried and failed: ${failedApproaches.join("; ")}`,
          `HANDOFF — goal: ${goal}`,
          `  done: ${done.join("; ") || "nothing yet"}`,
          `  remaining: ${remaining.join("; ") || "unstated"}`,
          `  decisions: ${decisions.join("; ") || "none recorded"}`,
          `  branch: ${record.branch} (WIP committed by the agent before escalating)`,
          "You decide: respawn the task with a stronger chain or model and this handoff, " +
            `kill ${agent} once the replacement confirms pickup — or tell ${agent} ` +
            "to continue. Do not leave it unanswered; it keeps working meanwhile.",
        ].join("\n"),
      );
      return toolResult(
        { escalation, handoff, priorEscalations: prior, message },
        "escalation",
      );
    },
  );

  server.registerTool(
    "hive_ack_message",
    {
      title: "Acknowledge a control message",
      description:
        "Acknowledge an injected urgent or critical control using its capability epoch; optionally confirm it has been applied.",
      inputSchema: MessageAcknowledgementSchema,
    },
    async ({ agent, messageId, capabilityEpoch, applied }) => {
      deps.authorizeTool(capability, "hive_ack_message", "message:ack", agent);
      const message = await deps.acknowledgeControlMessage(
        agent,
        messageId,
        capabilityEpoch,
        applied,
      );
      return toolResult(message, "message");
    },
  );

  server.registerTool(
    "hive_inbox",
    {
      title: "Read agent inbox",
      description:
        'Read and atomically acknowledge queued messages. Recipient queen returns bounded envelopes (synonym "orchestrator" is still accepted).',
      inputSchema: InboxRequestSchema,
    },
    async ({ agent }) => {
      // The global root inbox is reachable only by naming queen (or the
      // accepted synonym), which only the root's own capability may do.
      deps.authorizeTool(capability, "hive_inbox", "inbox:read", agent, false);
      return toolResult(
        isOrchestratorName(agent)
          ? await deps.delivery.orchestratorInbox()
          : await deps.delivery.inbox(agent),
        "messages",
      );
    },
  );

  server.registerTool(
    "hive_pickup_handoff",
    {
      title: "Pick up a durable handoff",
      description:
        "Read the exact durable handoff named in a replacement launch and record that this agent picked it up. Pickup never marks the task complete.",
      inputSchema: PickupHandoffRequestSchema,
    },
    async ({ agent, handoffId }) => {
      deps.authorizeTool(
        capability,
        "hive_pickup_handoff",
        "status:read",
        agent,
        false,
      );
      const replacement = deps.db.getAgentByName(agent);
      if (replacement === null) {
        throw new Error(`Cannot pick up handoff: no agent named ${agent}`);
      }
      const stored = deps.db.getHandoff(handoffId);
      if (stored === null) {
        throw new Error(`Handoff not found: ${handoffId}`);
      }
      if (stored.bundle.originalTaskRef.agentId === replacement.id) {
        throw new Error("A source agent cannot acknowledge its own handoff");
      }
      if (
        stored.bundle.originalTaskRef.digest !==
        createHash("sha256").update(replacement.taskDescription).digest("hex")
      ) {
        throw new Error(
          `Handoff ${handoffId} does not carry ${agent}'s exact task`,
        );
      }
      const pickup = deps.db.acknowledgeHandoffPickup(
        handoffId,
        replacement.id,
        new Date().toISOString(),
      );
      if (pickup === null) {
        throw new Error(`Handoff ${handoffId} was picked up by another agent`);
      }
      return toolResult({ handoff: stored.bundle, pickup }, "handoff");
    },
  );

  server.registerTool(
    "hive_read_message",
    {
      title: "Read exact durable message",
      description:
        "Read one byte-complete message by the id referenced in a bounded projection or orchestrator envelope. Agents may read only messages addressed to themselves.",
      inputSchema: ReadMessageRequestSchema,
    },
    async ({ id }) => {
      deps.authorizeTool(
        capability,
        "hive_read_message",
        "message:read",
        capability.subject,
        false,
      );
      const message =
        capability.role === "operator" || capability.role === "orchestrator"
          ? deps.delivery.readOrchestratorMessage(id)
          : deps.db.getMessage(id);
      if (
        message !== null &&
        capability.role !== "operator" &&
        capability.role !== "orchestrator" &&
        message.to !== capability.subject
      ) {
        throw new Error(`Message not found for ${capability.subject}: ${id}`);
      }
      if (message === null) {
        throw new Error(`Message not found for ${capability.subject}: ${id}`);
      }
      return toolResult(message, "message");
    },
  );
}
