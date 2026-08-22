import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SystemMailPublish } from "../../mail-service/service";
import type { Approval } from "../../schemas/approval";
import {
  type ProviderPermissionDecision,
  ProviderPermissionSettlementSchema,
} from "../../schemas/provider-permission";
import { toolError, toolResult } from "../../shared/mcp-tool-result";
import type { Clock } from "../../shared/clock";
import type {
  Action,
  Capability,
  CapabilityStore,
  RouteAuthorization,
} from "../authorization/authorization-service";
import { logAlertDeliveryFailure } from "../observability/daemon-log";
import type { HiveDatabase } from "../database/hive-database";
import type { HiveToolServer } from "../authorization/mcp-tool-policy";
import { compactApprovalDescription } from "../orchestrator-host/orchestrator-projections";
import type {
  ReadLandReadiness,
  SpentLandGrantDecision,
} from "../landing/landing-service";

export type { Approval };

export const AUTO_REARM_BUDGET = 3;
export const AUTO_REARM_REASON = "capability.auto-rearm";

const LAND_REARM_PREFIX = "Re-arm landing";

const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});

export interface ApprovalServiceDependencies {
  db: HiveDatabase;
  capabilities: CapabilityStore;
  repoRoot: string;
  readLandReadiness: ReadLandReadiness;
  clock: Clock;
  publish: SystemMailPublish;
  authorizeRoute: (
    request: Request,
    route: string,
    action: Action,
    options?: Readonly<{ withSubject?: boolean; auditAllow?: boolean }>,
  ) => RouteAuthorization;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
}

type VendorPromptAnswer =
  | { outcome: "answered" | "not-applicable" | "stale" }
  | { outcome: "delivery-failed"; reason: string };

const json = <T>(value: T, init?: ResponseInit): Response =>
  Response.json(value, init);

export class ApprovalService {
  private readonly providerPermissionRequests = new Map<
    string,
    { agentName: string; requestId: string }
  >();
  private readonly providerPermissionDecisions = new Map<
    string,
    ProviderPermissionDecision[]
  >();
  private readonly resolvingApprovals = new Set<string>();

  constructor(private readonly deps: ApprovalServiceDependencies) {}

  registerTools(server: HiveToolServer, capability: Capability): void {
    server.registerTool(
      "hive_approvals",
      {
        title: "List pending approvals",
        description:
          "List approval requests currently waiting for a decision. Each carries " +
          "a kind: tool-permission approvals (a command or tool call an agent " +
          "wants to run) return their description IN FULL — that text is what you " +
          "are deciding on. The boilerplate land-rearm kind is " +
          "truncated to ~200 characters, since the same pending requests are " +
          "re-listed on every poll; truncated is true when the text was cut.",
        inputSchema: z.object({}),
      },
      async () => {
        this.deps.authorizeTool(
          capability,
          "hive_approvals",
          "approval:read",
          undefined,
          false,
        );
        return toolResult(
          this.deps.db.listApprovals("pending").map(compactApprovalDescription),
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
        const stored = this.deps.db.getApproval(id);
        this.deps.authorizeTool(
          capability,
          "hive_approve",
          "approval:decide",
          stored?.agentName,
        );
        if (stored === null) {
          throw new Error(`Pending approval not found: ${id}`);
        }
        if (stored.status !== "pending") {
          return toolResult(
            { ...stored, outcome: "stale" as const },
            "approval",
          );
        }
        if (this.resolvingApprovals.has(stored.id)) {
          return toolResult(
            { ...stored, outcome: "in-progress" as const },
            "approval",
          );
        }
        this.resolvingApprovals.add(stored.id);
        try {
          const approved = decision === "approve";
          const vendorAnswer = await this.answerVendorPrompt(stored, approved);

          if (vendorAnswer.outcome === "stale") {
            const stale =
              this.deps.db.staleApproval(
                stored.id,
                this.deps.clock().toISOString(),
              ) ??
              this.deps.db.getApproval(stored.id) ??
              stored;
            return toolResult(
              { ...stale, outcome: "stale" as const },
              "approval",
            );
          }
          if (vendorAnswer.outcome === "delivery-failed") {
            const current = this.deps.db.getApproval(stored.id);
            if (current?.status !== "pending") {
              return toolResult(
                { ...(current ?? stored), outcome: "stale" as const },
                "approval",
              );
            }
            const agent = this.deps.db.getAgentByName(stored.agentName);
            if (
              agent !== null &&
              agent.status !== "dead" &&
              agent.status !== "done"
            ) {
              this.deps.db.upsertAgent({
                ...agent,
                status: agent.writeRevoked
                  ? "control-paused"
                  : "awaiting-approval",
              });
            }
            return toolError(vendorAnswer.reason);
          }

          const approval = this.deps.db.resolveApproval(
            stored.id,
            approved ? "approved" : "denied",
            this.deps.clock().toISOString(),
          );
          if (approval === null) {
            const stale = this.deps.db.getApproval(stored.id) ?? stored;
            return toolResult(
              { ...stale, outcome: "stale" as const },
              "approval",
            );
          }
          if (approved && approval.description.startsWith(LAND_REARM_PREFIX)) {
            this.deps.capabilities.rearmOneShot(
              approval.agentName,
              "branch:land",
            );
          }
          const agent = this.deps.db.getAgentByName(approval.agentName);
          const stillAwaitingApproval = this.deps.db
            .listApprovals("pending")
            .some((candidate) => candidate.agentName === approval.agentName);
          if (agent?.status === "awaiting-approval" && !stillAwaitingApproval) {
            this.deps.db.upsertAgent({
              ...agent,
              status: vendorAnswer.outcome === "answered" ? "working" : "idle",
            });
          }
          // A resolution the requesting agent is never told about is a resolution it cannot act on: an agent whose land-rearm approval was silently granted has no reason to retry hive_land, so it just sits idle until a user notices and prods it with an urgent message. Every resolution — approve or deny — gets an explicit envelope naming the approval and the outcome, independent of whatever status-flush path above already applies.
          const resolutionBody =
            decision === "approve"
              ? approval.description.startsWith(LAND_REARM_PREFIX)
                ? `Your approval request "${approval.description}" was approved — re-arm granted, retry hive_land now.`
                : `Your approval request "${approval.description}" was approved.`
              : `Your approval request "${approval.description}" was denied — do not retry it; report back with the blocker instead.`;
          // Not awaited: delivery may wait for a terminal turn boundary, and hive_approve's response must not hang on that. The message row itself is written synchronously before send() reaches its first await, so it is durable the instant this call is made.
          void this.deps
            .publish("hive-approvals", approval.agentName, resolutionBody, {
              idempotencyKey: `approval-resolved:${approval.id}`,
            })
            .catch(logAlertDeliveryFailure);
          return toolResult(
            { ...approval, outcome: "resolved" as const },
            "approval",
          );
        } finally {
          this.resolvingApprovals.delete(stored.id);
        }
      },
    );
  }

  async decideSpentLandGrant(
    capability: Capability,
    branch: string | null,
    mayAutoRearm: boolean,
  ): Promise<SpentLandGrantDecision> {
    if (branch === null) {
      return { kind: "ask", reason: "branch-unknown", readiness: null };
    }
    const readiness = await this.deps
      .readLandReadiness(this.deps.repoRoot, branch)
      .catch(() => ({
        pending: null,
        rebased: null,
        targetBranch: null,
        targetHead: null,
        baseSha: null,
      }));
    // A detached primary has no landing target at all, so every other readiness answer is measured against a position, not a branch — including pending: 0, which would report work "already on main" that has never touched it. This check stays ahead of every other verdict.
    if (readiness.targetBranch === null && readiness.targetHead !== null) {
      return { kind: "ask", reason: "target-detached", readiness };
    }
    if (readiness.pending === 0) return { kind: "nothing-to-land" };
    if (!mayAutoRearm) {
      return { kind: "ask", reason: "rearm-not-permitted", readiness };
    }
    if (readiness.pending === null || readiness.rebased === null) {
      return { kind: "ask", reason: "readiness-unreadable", readiness };
    }
    if (readiness.rebased === false) {
      return { kind: "ask", reason: "target-moved", readiness };
    }
    const spent = this.deps.db.countAuditEntries(
      capability.subject,
      "branch:land",
      AUTO_REARM_REASON,
    );
    if (spent >= AUTO_REARM_BUDGET) {
      return { kind: "ask", reason: "rearm-budget-exhausted", readiness };
    }
    this.deps.capabilities.rearmOneShot(capability.subject, "branch:land");
    this.deps.capabilities.audit({
      route: "/mcp:hive_land",
      action: "branch:land",
      callerSubject: capability.subject,
      callerRole: capability.role,
      capabilityId: capability.id,
      requestedSubject: capability.subject,
      epoch: capability.epoch,
      decision: "allow",
      reason: AUTO_REARM_REASON,
    });
    return { kind: "rearmed" };
  }

  fileLandRearmApproval(subject: string): void {
    const alreadyPending = this.deps.db
      .listApprovals("pending")
      .some(
        (approval) =>
          approval.agentName === subject &&
          approval.description.startsWith(LAND_REARM_PREFIX),
      );
    if (alreadyPending) return;
    this.deps.db.insertApproval({
      id: randomUUID(),
      agentName: subject,
      kind: "land-rearm",
      description:
        `${LAND_REARM_PREFIX}: the one-shot branch:land grant for ${subject} is spent. ` +
        "Approving grants exactly one more landing for this agent.",
      status: "pending",
      createdAt: this.deps.clock().toISOString(),
      resolvedAt: null,
    });
  }

  queueProviderApproval(
    agentName: string,
    requestId: string,
    description: string,
  ): string {
    const id = randomUUID();
    const createdAt = this.deps.clock().toISOString();
    this.deps.db.transaction(() => {
      this.deps.db.stalePendingToolApprovals(agentName, createdAt);
      this.deps.db.insertApproval({
        id,
        agentName,
        // The description is the command Codex wants to run. Never trimmed.
        kind: "tool-permission",
        description,
        status: "pending",
        createdAt,
        resolvedAt: null,
      });
      const agent = this.deps.db.getAgentByName(agentName);
      if (
        agent !== null &&
        agent.status !== "dead" &&
        agent.status !== "done"
      ) {
        this.deps.db.upsertAgent({
          ...agent,
          status: agent.writeRevoked ? "control-paused" : "awaiting-approval",
          lastEventAt: createdAt,
        });
      }
    });
    this.providerPermissionRequests.set(id, { agentName, requestId });
    return id;
  }

  async providerPermissionPromptEndpoint(request: Request): Promise<Response> {
    const route = "/provider-permission/prompt";
    const authorized = this.deps.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const parsed = z
      .object({
        requestId: z.string().min(1),
        description: z.string(),
      })
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: "Invalid provider permission prompt" },
        { status: 400 },
      );
    }
    const approvalId = this.queueProviderApproval(
      subject,
      parsed.data.requestId,
      parsed.data.description,
    );
    return json({ approvalId });
  }

  providerPermissionDecisionsEndpoint(request: Request): Response {
    const route = "/provider-permission/decisions";
    const authorized = this.deps.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    return json({
      decisions: this.providerPermissionDecisions.get(subject) ?? [],
    });
  }

  /** Retires a prompt the provider settled before the daemon delivered its answer. Without this handshake, a local answer or provider timeout leaves a second authority offering the same decision forever. */
  async providerPermissionSettledEndpoint(request: Request): Promise<Response> {
    const route = "/provider-permission/settled";
    const authorized = this.deps.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const parsed = ProviderPermissionSettlementSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        { error: "Invalid provider permission settlement" },
        { status: 400 },
      );
    }

    const approvalIds = new Set<string>();
    for (const [approvalId, pending] of this.providerPermissionRequests) {
      if (
        pending.agentName === subject &&
        pending.requestId === parsed.data.requestId
      ) {
        approvalIds.add(approvalId);
        this.providerPermissionRequests.delete(approvalId);
      }
    }
    const queued = this.providerPermissionDecisions.get(subject) ?? [];
    this.providerPermissionDecisions.set(
      subject,
      queued.filter((entry) => !approvalIds.has(entry.approvalId)),
    );

    const settledAt = this.deps.clock().toISOString();
    for (const approvalId of approvalIds) {
      if (parsed.data.outcome === "allow") {
        this.deps.db.resolveApproval(approvalId, "approved", settledAt);
      } else if (parsed.data.outcome === "deny") {
        this.deps.db.resolveApproval(approvalId, "denied", settledAt);
      } else {
        this.deps.db.staleApproval(approvalId, settledAt);
      }
    }

    const agent = this.deps.db.getAgentByName(subject);
    const stillPending = this.deps.db
      .listApprovals("pending")
      .some((approval) => approval.agentName === subject);
    if (agent?.status === "awaiting-approval" && !stillPending) {
      this.deps.db.upsertAgent({
        ...agent,
        status: agent.writeRevoked
          ? "control-paused"
          : parsed.data.outcome === "cancelled"
            ? "idle"
            : "working",
        lastEventAt: settledAt,
      });
    }
    return json({ settled: approvalIds.size });
  }

  async providerPermissionAckEndpoint(request: Request): Promise<Response> {
    const route = "/provider-permission/ack";
    const authorized = this.deps.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const parsed = z
      .object({ approvalId: z.string().min(1) })
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: "Invalid provider permission acknowledgement" },
        { status: 400 },
      );
    }
    const queued = this.providerPermissionDecisions.get(subject) ?? [];
    const remaining = queued.filter(
      (entry) => entry.approvalId !== parsed.data.approvalId,
    );
    this.providerPermissionDecisions.set(subject, remaining);
    this.providerPermissionRequests.delete(parsed.data.approvalId);
    return json({ acknowledged: parsed.data.approvalId });
  }

  private async answerVendorPrompt(
    approval: Approval,
    approved: boolean,
  ): Promise<VendorPromptAnswer> {
    if (approval.kind !== "tool-permission") {
      return { outcome: "not-applicable" };
    }
    if (this.deps.db.getApproval(approval.id)?.status !== "pending") {
      return { outcome: "stale" };
    }
    const request = this.providerPermissionRequests.get(approval.id);
    if (request === undefined) {
      return {
        outcome: "delivery-failed",
        reason: "the provider permission is not attached to a live frontend",
      };
    }
    const decisions =
      this.providerPermissionDecisions.get(request.agentName) ?? [];
    decisions.push({
      approvalId: approval.id,
      requestId: request.requestId,
      outcome: approved ? "allow" : "deny",
    });
    this.providerPermissionDecisions.set(request.agentName, decisions);
    return { outcome: "answered" };
  }
}
