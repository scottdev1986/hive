import { createHash } from "node:crypto";
import { getAgentAdapter } from "../adapters/tools/agents/agent-factory";
import type { AgentRecord, HookEvent, ProviderEvent } from "../schemas";
import type { HiveDatabase } from "./db";

function eventKind(
  event: HookEvent,
): Pick<ProviderEvent, "kind" | "toolName"> | null {
  switch (event.kind) {
    case "session-start":
      return { kind: "run-started", toolName: null };
    case "session-end":
    case "dead":
      return { kind: "run-ended", toolName: null };
    case "turn-start":
      return { kind: "turn-started", toolName: null };
    case "turn-end":
      return { kind: "turn-idle", toolName: null };
    case "tool-boundary":
      return { kind: "tool-finished", toolName: event.toolName ?? null };
    case "approval-request":
      return { kind: "approval-waiting", toolName: null };
    case "notification":
      return event.notificationType === "permission_prompt"
        ? { kind: "approval-waiting", toolName: null }
        : event.notificationType === "idle_prompt"
          ? { kind: "turn-idle", toolName: null }
          : null;
    case "session-launch":
    case "effort-drift":
      return null;
  }
}

export function recordProviderHookEvent(
  db: HiveDatabase,
  agent: AgentRecord,
  event: HookEvent,
): ProviderEvent | null {
  const source = getAgentAdapter(agent.tool).communication.eventSource;
  if (source !== "hooks" && source !== "native") return null;
  const normalized = eventKind(event);
  if (normalized === null) return null;

  const active = db.getActiveProviderRunForAgent(agent.id);
  if (active === null) return null;
  const conversationId = event.toolSessionId ?? active.conversationId;
  const run =
    conversationId === null
      ? active
      : db.bindProviderRunConversation(active.runId, conversationId);
  if (run === null) return null;

  const value: ProviderEvent = {
    eventId: createHash("sha256")
      .update(
        JSON.stringify([
          run.runId,
          event.kind,
          event.timestamp,
          conversationId,
          normalized.toolName,
        ]),
      )
      .digest("hex"),
    providerRunId: run.runId,
    provider: run.provider,
    capabilityEpoch: run.capabilityEpoch,
    conversationId,
    kind: normalized.kind,
    occurredAt: event.timestamp,
    toolName: normalized.toolName,
    inputDigest: null,
  };
  db.insertProviderEvent(value);
  return value;
}
