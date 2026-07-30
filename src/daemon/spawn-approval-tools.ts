import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action, Capability, CapabilityStore } from "./capabilities";
import type { Approval, HiveDatabase } from "./db";
import type { MessageDelivery } from "./delivery";
import { logAlertDeliveryFailure } from "./alert-log";
import {
  compactApprovalDescription,
  compactSpawnResult,
} from "./orchestrator-lifecycle";
import {
  type SpawnBatchRequest,
  SpawnBatchRequestSchema,
  type SpawnRequest,
  SpawnRequestSchema,
} from "./spawner";
import { toolResult } from "./tool-result";
import type { AgentRecord } from "../schemas";

export const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});

/**
 * The spawn-and-approval tool surface, with its dependencies named.
 *
 * `spawnAgent` crosses as a dependency rather than moving: it is a closure over
 * the daemon that the lifecycle tools share, and duplicating it here would give
 * two surfaces two different memory-pressure gates.
 *
 * `resolvingApprovals` crosses **by reference** — it is the in-flight set that
 * stops two operators resolving one approval twice, so a copy would defeat the
 * only thing it exists for.
 */
export interface SpawnApprovalToolDeps {
  db: HiveDatabase;
  delivery: MessageDelivery;
  capabilities: CapabilityStore;
  resolvingApprovals: Set<string>;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  answerVendorPrompt: (
    approval: Approval,
    approved: boolean,
  ) => Promise<
    | { outcome: "answered" | "not-applicable" | "stale" }
    | { outcome: "delivery-failed"; reason: string }
  >;
  spawnAgent: (request: SpawnRequest) => Promise<AgentRecord>;
}

export const LAND_REARM_PREFIX = "Re-arm landing";

export function registerSpawnApprovalTools(
  server: McpServer,
  capability: Capability,
  deps: SpawnApprovalToolDeps,
): void {
  server.registerTool(
    "hive_spawn",
    {
      title: "Spawn Hive agent",
      description:
        "Start a new Hive agent for a delegated task. Name the task's category " +
        "— complex_coding (multi-file builds, hard changes), simple_coding " +
        "(small mechanical edits), debugging (root-causing a defect), " +
        "code_review (independent review), planning (design before code), " +
        "heavy_research (deep investigation), light_research (quick lookups), " +
        "summarization (condensing text) — and the user's routing policy " +
        "chain for that category decides the model: first enabled link that " +
        "clears the launch gate runs. Optional: tool/model pin an explicit " +
        "user choice (never substituted); minContextTokens filters links for " +
        "long-context work (any category); effort overrides the link's. " +
        "The admitted agent returns immediately with status=spawning while " +
        "provider startup is verified in the background. For two or more " +
        "independent tasks, use hive_spawn_many. " +
        "Returns identity and state, not the task brief you just wrote — " +
        "taskDescription comes back truncated (taskDescriptionLength carries " +
        "the full count); read it in full via hive_status if ever needed.",
      inputSchema: SpawnRequestSchema,
    },
    async (request: SpawnRequest) => {
      deps.authorizeTool(capability, "hive_spawn", "agent:spawn");
      return toolResult(
        compactSpawnResult(await deps.spawnAgent(request)),
        "agent",
      );
    },
  );

  server.registerTool(
    "hive_spawn_many",
    {
      title: "Spawn multiple Hive agents",
      description:
        "Admit 1–32 independent Hive agents concurrently. Each returns " +
        "immediately with status=spawning while provider startup and readiness " +
        "verification continue in the background. Results are independent, so " +
        "one refused request does not hide agents already admitted. Use one " +
        "request per non-overlapping delegated task.",
      inputSchema: SpawnBatchRequestSchema,
    },
    async ({ requests }: SpawnBatchRequest) => {
      deps.authorizeTool(capability, "hive_spawn_many", "agent:spawn");
      const results = await Promise.all(
        requests.map(async (request) => {
          try {
            return {
              ok: true as const,
              agent: compactSpawnResult(await deps.spawnAgent(request)),
            };
          } catch (error) {
            return {
              ok: false as const,
              error:
                error instanceof Error ? error.message : "Agent spawn failed",
            };
          }
        }),
      );
      return toolResult(results, "results");
    },
  );

  server.registerTool(
    "hive_approvals",
    {
      title: "List pending approvals",
      description:
        "List approval requests currently waiting for a decision. Each carries " +
        "a kind: tool-permission approvals (a command or tool call an agent " +
        "wants to run) return their description IN FULL — that text is what you " +
        "are deciding on. Boilerplate kinds (cost-consent, land-rearm) are " +
        "truncated to ~200 characters, since the same pending requests are " +
        "re-listed on every poll; truncated is true when the text was cut.",
      inputSchema: z.object({}),
    },
    async () => {
      deps.authorizeTool(
        capability,
        "hive_approvals",
        "approval:read",
        undefined,
        false,
      );
      return toolResult(
        deps.db.listApprovals("pending").map(compactApprovalDescription),
        "approvals",
      );
    },
  );

  server.registerTool(
    "hive_approve",
    {
      title: "Resolve agent approval",
      description:
        "Approve or deny a pending Hive agent approval request. Returns a " +
        "typed resolved, stale, in-progress, or delivery-failed outcome.",
      inputSchema: ApprovalDecisionSchema,
    },
    async ({ id, decision }) => {
      // The approval names an agent only indirectly, through its id, so the
      // subject is resolved from the record before it is authorized against.
      const stored = deps.db.getApproval(id);
      deps.authorizeTool(
        capability,
        "hive_approve",
        "approval:decide",
        stored?.agentName,
      );
      if (stored === null) {
        throw new Error(`Pending approval not found: ${id}`);
      }
      if (stored.status !== "pending") {
        return toolResult({ ...stored, outcome: "stale" as const }, "approval");
      }
      if (deps.resolvingApprovals.has(stored.id)) {
        return toolResult(
          { ...stored, outcome: "in-progress" as const },
          "approval",
        );
      }
      deps.resolvingApprovals.add(stored.id);
      try {
        const approved = decision === "approve";
        const vendorAnswer = await deps.answerVendorPrompt(stored, approved);

        if (vendorAnswer.outcome === "stale") {
          const stale =
            deps.db.staleApproval(stored.id, new Date().toISOString()) ??
            deps.db.getApproval(stored.id) ??
            stored;
          return toolResult(
            { ...stale, outcome: "stale" as const },
            "approval",
          );
        }
        if (vendorAnswer.outcome === "delivery-failed") {
          const current = deps.db.getApproval(stored.id);
          if (current?.status !== "pending") {
            return toolResult(
              { ...(current ?? stored), outcome: "stale" as const },
              "approval",
            );
          }
          const agent = deps.db.getAgentByName(stored.agentName);
          if (
            agent !== null &&
            agent.status !== "dead" &&
            agent.status !== "done" &&
            agent.status !== "failed"
          ) {
            deps.db.upsertAgent({
              ...agent,
              status: agent.writeRevoked
                ? "control-paused"
                : "awaiting-approval",
            });
          }
          return toolResult(
            {
              ...current,
              outcome: "delivery-failed" as const,
              reason: vendorAnswer.reason,
            },
            "approval",
          );
        }

        const approval = deps.db.resolveApproval(
          stored.id,
          approved ? "approved" : "denied",
          new Date().toISOString(),
        );
        if (approval === null) {
          const stale = deps.db.getApproval(stored.id) ?? stored;
          return toolResult(
            { ...stale, outcome: "stale" as const },
            "approval",
          );
        }
        if (approved && approval.description.startsWith(LAND_REARM_PREFIX)) {
          deps.capabilities.rearmOneShot(approval.agentName, "branch:land");
        }
        const agent = deps.db.getAgentByName(approval.agentName);
        const stillAwaitingApproval = deps.db
          .listApprovals("pending")
          .some((candidate) => candidate.agentName === approval.agentName);
        if (agent?.status === "awaiting-approval" && !stillAwaitingApproval) {
          deps.db.upsertAgent({
            ...agent,
            // An answered vendor prompt hands the turn straight back to the
            // model, so the agent is working, not idle: calling it idle invites
            // the wake loop to paste queued mail into a busy pane.
            status: vendorAnswer.outcome === "answered" ? "working" : "idle",
          });
          await deps.delivery.flushQueued(approval.agentName);
        }
        // A resolution the requesting agent is never told about is a resolution
        // it cannot act on: an agent whose land-rearm approval was silently
        // granted has no reason to retry hive_land, so it just sits idle until a
        // human notices and prods it with an urgent message. Every resolution —
        // approve or deny — gets an explicit envelope naming the approval and
        // the outcome, independent of whatever status-flush path
        // above already applies.
        const resolutionBody =
          decision === "approve"
            ? approval.description.startsWith(LAND_REARM_PREFIX)
              ? `Your approval request "${approval.description}" was approved — re-arm granted, retry hive_land now.`
              : `Your approval request "${approval.description}" was approved.`
            : `Your approval request "${approval.description}" was denied — do not retry it; report back with the blocker instead.`;
        // Not awaited: delivery may wait for a terminal turn boundary, and
        // hive_approve's response must not hang on that. The message row itself
        // is written synchronously before send() reaches its first await, so it
        // is durable the instant this call is made.
        void deps.delivery
          .send("hive-approvals", approval.agentName, resolutionBody, {
            idempotencyKey: `approval-resolved:${approval.id}`,
          })
          .catch(logAlertDeliveryFailure);
        return toolResult(
          { ...approval, outcome: "resolved" as const },
          "approval",
        );
      } finally {
        deps.resolvingApprovals.delete(stored.id);
      }
    },
  );
}
