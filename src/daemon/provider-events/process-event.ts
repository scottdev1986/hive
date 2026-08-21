import { logAlertDeliveryFailure } from "../observability/daemon-log";
import type { StatusService } from "../status-service/status-service";
import type { HiveDatabase } from "../database/hive-database";
import type { DrainHandler } from "../spawn/drain-handler";
import type { OrchestratorSessiondController } from "../orchestrator-host/sessiond-controller";
import { recordProviderHookEvent } from "./hook-event";
import type { QuotaService } from "../../usage-service/usage-quota";
import { requireSessiondAgentLocator } from "../session-host/hive-terminal-host";
import type { TokenUsageStore } from "../../usage-service/token-usage";
import type { SystemMailPublish } from "../../mail-service/service";
import {
  type AgentRecord,
  canonicalOrchestratorName,
  isOrchestratorName,
  ORCHESTRATOR_NAME,
} from "../../schemas/agent";
import { type HookEvent, HookEventSchema } from "../../schemas/event";
import { definedFields } from "../../shared/defined-fields";

const CLAUDE_PERMISSION_PROMPT = "permission_prompt";

const isPermissionPrompt = (event: HookEvent): boolean =>
  event.kind === "notification" &&
  event.notificationType === CLAUDE_PERMISSION_PROMPT;

/** Hook-event ingress, with its dependencies named. Second extraction of the `HiveDaemon` decomposition (audit §11). The teardown is typed as `Promise<void>` because this path awaits it for its effect and reads nothing back. */
export interface ProcessEventDeps {
  db: HiveDatabase;
  publish: SystemMailPublish;
  drainHandler: DrainHandler;
  orchestratorSessiond: OrchestratorSessiondController | null;
  quota: QuotaService | undefined;
  repoRoot: string;
  status: StatusService;
  tokenUsage: TokenUsageStore;
  killAgentTeardown: (
    agent: AgentRecord,
    options?: { at?: string },
  ) => Promise<void>;
}

export async function processEvent(
  deps: ProcessEventDeps,
  event: HookEvent,
): Promise<void> {
  const parsed = HookEventSchema.parse(event);
  const value = {
    ...parsed,
    agentName: canonicalOrchestratorName(parsed.agentName),
  };
  const eventAgent = deps.db.getAgentByName(value.agentName);
  const providerEvent =
    eventAgent === null
      ? null
      : recordProviderHookEvent(deps.db, eventAgent, value);
  if (value.providerRunId !== undefined && providerEvent === null) {
    // A run-bound hook speaks only for that exact active ProviderRun. The rejected binding fences it out of the status machine, approvals, quota, and delivery below — but the raw observation is still evidence that a process with this name is alive, so it lands in the events table and advances liveness before this returns. Discarding it entirely left every agent with a stale or missing run row reading as silent — frozen lastEventAt, "no turn events at all" deafness warnings — for its whole life. The event's session identity is exactly the claim that was rejected, so it must never rebind toolSessionId: a grok scheduled task spawns subagent sessions in the agent's worktree whose hooks carry the agent's run id with the subagent's own session id, and adopting that id makes the subagent session the crash-resume target and the model/context lookup key.
    if (value.kind !== "tool-boundary") deps.db.insertEvent(value);
    const rejected = deps.db.getAgentByName(value.agentName);
    if (
      rejected !== null &&
      rejected.status !== "dead" &&
      rejected.status !== "done"
    ) {
      const observedAt = new Date(value.timestamp).toISOString();
      deps.db.upsertAgent({ ...rejected, lastEventAt: observedAt });
      // The hook proves a turn happened under this agent's name and proves nothing about whose turn it was: the session identity that would have said so is the claim just refused, and a grok subagent's turn-end is not the agent's. So the observation is filed carrying no value. Without it a dimension that is refused on every hook is indistinguishable from one nothing ever reported, and an agent working behind an unbindable run reads exactly like an agent that never started.
      deps.status.observeHook(rejected, value, "rejected");
    }
    return;
  }
  if (
    value.agentName === ORCHESTRATOR_NAME &&
    value.toolSessionId !== undefined
  ) {
    deps.tokenUsage.registerOrchestratorProviderSession(
      value.toolSessionId,
      deps.repoRoot,
    );
  }
  if (value.kind === "tool-boundary") {
    // A deep agent fires this on every tool call — hundreds per turn — so it deliberately skips the events table and the quota machinery. It proves the process is alive mid-turn and marks the one safe moment to inject urgent traffic into a busy session.
    const agent = deps.db.getAgentByName(value.agentName);
    if (agent !== null && agent.status !== "dead" && agent.status !== "done") {
      const observedAt = new Date(value.timestamp).toISOString();
      deps.db.transaction(() => {
        // The boundary proves the popup was answered at the pane. Its exact approval generation is no longer eligible to inject into whatever prompt the vendor may render next.
        deps.db.stalePendingToolApprovals(value.agentName, observedAt);
        deps.db.upsertAgent({
          ...agent,
          lastEventAt: observedAt,
          // A tool ran to completion, so any native permission dialog that was holding this agent has been answered. This is the only honest way back out of `awaiting-approval` for a vendor-raised dialog: Hive cannot answer that dialog, so it must wait to OBSERVE it gone rather than assume. Left alone, a reader that a user unblocked at the pane would keep reporting "blocked" for the rest of its turn.
          ...definedFields({
            status:
              agent.status === "awaiting-approval" ? "working" : undefined,
            toolSessionId: value.toolSessionId,
          }),
        });
      });
    }
    return;
  }
  deps.db.transaction(() => {
    deps.db.insertEvent(value);

    const agent = deps.db.getAgentByName(value.agentName);
    if (agent !== null && agent.status !== "dead" && agent.status !== "done") {
      const updated: AgentRecord = {
        ...agent,
        status:
          agent.writeRevoked &&
          agent.controlMessageId !== undefined &&
          value.kind !== "dead"
            ? "control-paused"
            : value.kind === "dead"
              ? "dead"
              : value.kind === "turn-start"
                ? "working"
                : value.kind === "tool-start"
                  ? "working"
                  : value.kind === "approval-request"
                    ? "awaiting-approval"
                    : value.kind === "notification"
                      ? // The vendor's own dialog. Claude raises this hook when it is
                        // BLOCKED asking for permission. Do not hold the agent's status here: a session parked on a dialog would report "working" forever and tell nobody. Any other notification (notably idle_prompt, which an idle agent emits while doing nothing) still changes nothing.
                        isPermissionPrompt(value)
                        ? "awaiting-approval"
                        : agent.status
                      : value.kind === "session-start"
                        ? agent.status
                        : value.kind === "session-launch" ||
                            value.kind === "session-end" ||
                            value.kind === "compacted"
                          ? // Only the orchestrator supervisor emits this today. If a
                            // future worker reports either supervisor lifecycle event, process teardown remains the authority for that worker.
                            agent.status
                          : "idle",
        contextPct:
          value.kind === "turn-end" && value.contextPct !== undefined
            ? value.contextPct
            : agent.contextPct,
        lastEventAt: new Date(value.timestamp).toISOString(),
        ...definedFields({ toolSessionId: value.toolSessionId }),
        // A completed turn proves the process is genuinely healthy, so the crash-resume budget rearms.
      };
      deps.db.upsertAgent(updated);
    }

    if (value.kind === "approval-request") {
      // One hook is one prompt generation. Superseded rows remain durable as STALE audit history but can never authorize this fresh popup.
      deps.db.stalePendingToolApprovals(value.agentName, value.timestamp);
      deps.db.insertApproval({
        id: crypto.randomUUID(),
        agentName: value.agentName,
        // A tool's own permission prompt, relayed by the agent's hook: the description names what the tool wants to do. Never trimmed.
        kind: "tool-permission",
        description: value.description,
        status: "pending",
        createdAt: value.timestamp,
        resolvedAt: null,
      });
    }
  });

  const statusAgent = deps.db.getLiveAgentByName(value.agentName);
  if (statusAgent !== null) {
    deps.status.observeHook(statusAgent, value, "accepted");
  }

  if (value.kind === "dead") {
    const dead = deps.db.getAgentByName(value.agentName);
    if (dead !== null) {
      await deps.killAgentTeardown(dead, { at: value.timestamp });
    }
  }

  const agent = deps.db.getAgentByName(value.agentName);
  if (
    agent !== null &&
    (value.kind === "session-start" || value.kind === "turn-start")
  )
    deps.drainHandler.noteProviderAlive(agent.tool);
  const eventReservationId =
    agent?.controlQuotaReservationId ?? agent?.quotaReservationId;
  if (eventReservationId !== undefined) {
    if (value.kind === "session-start" || value.kind === "turn-start") {
      deps.quota?.markStarted(eventReservationId, value.timestamp);
    } else if (value.kind === "turn-end") {
      await deps.quota?.reconcile(
        eventReservationId,
        value.usageUnits,
        value.usageSource ?? "estimated",
        value.timestamp,
      );
    } else if (value.kind === "dead") {
      await deps.quota?.cancel(eventReservationId, value.timestamp);
    }
  }

  // Visibility is the whole point: a status nobody reads is not a fix. The agent cannot report this itself — it is blocked mid-turn, which is precisely why this went unnoticed — so the daemon speaks for it. Idempotent per agent per dialog: the hook fires once when the dialog opens, and re-notifying on a status Hive cannot clear on its own would spam the orchestrator.
  if (
    isPermissionPrompt(value) &&
    agent !== undefined &&
    agent !== null &&
    agent.name !== ORCHESTRATOR_NAME
  ) {
    await deps
      .publish(
        "hive-resources",
        ORCHESTRATOR_NAME,
        `${value.agentName} is BLOCKED on a Claude Code permission dialog in its terminal ` +
          `(session ${requireSessiondAgentLocator(agent).sessionId}) and cannot proceed until a user answers it. ` +
          `Hive can see this dialog but cannot answer it: the notification hook carries no request id, ` +
          `so there is no reply path back to the TUI. Someone must clear it in the Hive pane.\n` +
          `An agent under full autonomy should never reach this: it means the session launched ` +
          `without bypassPermissions, so check its spawn.`,
        {
          idempotencyKey: `permission-dialog:${agent.id}:${value.timestamp}`,
        },
      )
      .catch(logAlertDeliveryFailure);
  }

  if (
    isOrchestratorName(value.agentName) &&
    (value.kind === "turn-start" || value.kind === "turn-end")
  ) {
    deps.orchestratorSessiond?.markInputReady();
  }
}
