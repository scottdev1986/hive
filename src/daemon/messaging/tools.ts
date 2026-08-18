import { createHash } from "node:crypto";
import { z } from "zod";
import { type MailToolDeps, MailTools } from "../../mail-service/mail-tools";
import type { SystemMailPublish } from "../../mail-service/service";
import { ORCHESTRATOR_NAME } from "../../schemas/agent";
import { HandoffSchema } from "../../schemas/handoff-schema";
import {
  AgentMailPublishRequestSchema,
  MailClaimRequestSchema,
  MailCompleteRequestSchema,
  MailPollRequestSchema,
  MailPublishRequestSchema,
  MailStatusRequestSchema,
} from "../../schemas/mail";
import { formatlessString } from "../../schemas/wire-schema";
import { toolResult } from "../../shared/mcp-tool-result";
import type {
  Action,
  Capability,
} from "../authorization/authorization-service";
import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import type { HiveDatabase } from "../database/hive-database";
import type { MachineMutationCoordinator } from "../mutation-lease";
import type { StatusService } from "../status-service/status-service";

export const EscalationRequestSchema = z.object({
  agent: z.string().min(1),
  reason: z.string().min(1),
  goal: z.string().min(1),
  done: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  failedApproaches: z.array(z.string().min(1)).min(1),
});

export const PickupHandoffRequestSchema = z.object({
  agent: z.string().min(1),
  handoffId: formatlessString(z.string().uuid()),
});

/** The agent-to-agent messaging tool surface, with its dependencies named. Third tool-group extraction out of `createMcpServer` (audit §11). `memoryPressure` crosses as a **getter**, not a value: this surface reads it to refuse sends while the machine is under pressure, and the resource sweep writes it on its own schedule — a boolean copied at registration time would pin the answer to whatever was true when the MCP server was built. */
export interface MessagingToolDeps {
  db: HiveDatabase;
  status: StatusService;
  machineMutations: Pick<MachineMutationCoordinator, "beginOperation"> | null;
  memoryPressure: () => boolean;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  publish: SystemMailPublish;
}

export function registerMailTools(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: MailToolDeps,
): void {
  const mail = new MailTools(deps);
  const rootCaller =
    capability.role === "orchestrator" || capability.role === "user";
  const publishInputSchema = rootCaller
    ? MailPublishRequestSchema
    : AgentMailPublishRequestSchema;
  const statusInputSchema =
    capability.role === "user"
      ? MailStatusRequestSchema
      : z.strictObject({
          recipient: z.literal(capability.subject).optional(),
        });

  server.registerTool(
    "hive_mail_publish",
    {
      title: "Publish a message to a mailbox",
      description:
        "Durably accept one message for a recipient. The control lane carries " +
        "instructions and escalations that must each be handled and settled. " +
        "The work lane carries status and progress that may safely merge, so " +
        "repeated updates from the same sender on the same topic collapse into " +
        "the newest one — completions, measurements, and 'ready' reports to " +
        "the orchestrator belong here, not on control. Returns once the " +
        "message is committed, not once it is read. Reusing an idempotencyKey " +
        "returns the original receipt; reusing one for different content is " +
        "refused rather than silently dropped.",
      inputSchema: publishInputSchema,
    },
    async (request) => mail.publish(capability, request),
  );

  server.registerTool(
    "hive_mail_poll",
    {
      title: "Look at your mailbox",
      description:
        "Read what is waiting: at most one control message with its full body, " +
        "a bounded digest of work-lane updates, and backlog counts. Call it at " +
        "safe points — after finishing a unit of work, before reporting, on " +
        "resume — never in a tight loop. Polling changes nothing and takes " +
        "nothing; claim what you intend to handle.",
      inputSchema: MailPollRequestSchema,
    },
    async (request) => mail.poll(capability, request),
  );

  server.registerTool(
    "hive_mail_claim",
    {
      title: "Take a message to handle",
      description:
        "Lease one message so no other handler works it at the same time. The " +
        "lease is time-bounded: repeat the same claim before leaseUntil to " +
        "renew long-running work without spending another attempt. If you do " +
        "not settle or renew it, the message returns to the queue for another " +
        "attempt. Take at most the one control message and settle it before " +
        "resuming.",
      inputSchema: MailClaimRequestSchema,
    },
    async (request) => mail.claim(capability, request),
  );

  server.registerTool(
    "hive_mail_complete",
    {
      title: "Settle a claimed message",
      description:
        "Finish with a claimed message: completed when it is handled, deferred " +
        "with a retryAfterSeconds when you cannot handle it yet, rejected when " +
        "you never will. Completing an owner or user control message to queen " +
        "is refused until a repo memory article cites that itemId in evidence " +
        "or body — memory_write the ruling first. Settling is what releases " +
        "the lane for the next instruction, so a claimed message that is never " +
        "settled blocks the ones behind it.",
      inputSchema: MailCompleteRequestSchema,
    },
    async (request) => mail.complete(capability, request),
  );

  server.registerTool(
    "hive_mail_status",
    {
      title: "Mailbox health",
      description:
        "Report a mailbox's queue depth by lane, the age of its oldest waiting " +
        "message, any live lease, and its dead letters with reasons. Reads " +
        "only; it delivers nothing and notifies no one.",
      inputSchema: statusInputSchema,
    },
    async (request: { readonly recipient?: string }) =>
      mail.status(capability, {
        recipient:
          "recipient" in request
            ? (request.recipient ?? capability.subject)
            : capability.subject,
      }),
  );
}

export function registerMessagingTools(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: MessagingToolDeps,
): void {
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
      const prior = deps.db.countEscalationsForAgent(record.id);
      const escalation = deps.db.insertEscalation({
        id: crypto.randomUUID(),
        agentId: record.id,
        agentName: agent,
        model: record.model,
        category: record.category,
        reason,
        createdAt: now,
      });
      await deps.publish(
        "hive-escalation",
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
        { idempotencyKey: `escalation:${escalation.id}` },
      );
      return toolResult(
        { escalation, handoff, priorEscalations: prior },
        "escalation",
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
}
