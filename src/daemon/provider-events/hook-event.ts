import { createHash } from "node:crypto";
import { getAgentAdapter } from "../../adapters/providers/provider-registry";
import type { AgentRecord } from "../../schemas/agent";
import type { CapabilityProvider } from "../../schemas/capability";
import type { HookEvent } from "../../schemas/event";
import type { ProviderEvent } from "../../schemas/provider-communication";
import type { HiveDatabase } from "../database/hive-database";

function eventKind(
  event: HookEvent,
): Pick<ProviderEvent, "kind" | "toolName" | "inputDigest"> | null {
  switch (event.kind) {
    case "session-start":
      return { kind: "run-started", toolName: null, inputDigest: null };
    case "session-end":
    case "dead":
      return { kind: "run-ended", toolName: null, inputDigest: null };
    case "turn-start":
      return { kind: "turn-started", toolName: null, inputDigest: null };
    case "turn-end":
      return { kind: "turn-idle", toolName: null, inputDigest: null };
    case "turn-failure":
      return { kind: "turn-failed", toolName: null, inputDigest: null };
    case "tool-start":
      return {
        kind: "tool-started",
        toolName: event.toolName ?? null,
        inputDigest: event.inputDigest ?? null,
      };
    case "tool-boundary":
      return {
        kind: "tool-finished",
        toolName: event.toolName ?? null,
        inputDigest: event.inputDigest ?? null,
      };
    case "compacted":
      return { kind: "compacted", toolName: null, inputDigest: null };
    case "approval-request":
      return { kind: "approval-waiting", toolName: null, inputDigest: null };
    case "notification":
      return event.notificationType === "permission_prompt"
        ? { kind: "approval-waiting", toolName: null, inputDigest: null }
        : event.notificationType === "idle_prompt"
          ? { kind: "turn-idle", toolName: null, inputDigest: null }
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
  if (
    active === null ||
    active.capabilityEpoch !== agent.capabilityEpoch ||
    (event.providerRunId !== undefined &&
      event.providerRunId !== active.runId) ||
    (agent.tool === "grok" && event.providerRunId === undefined) ||
    Date.parse(event.timestamp) < Date.parse(active.startedAt)
  ) {
    return null;
  }
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
          normalized.inputDigest,
        ]),
      )
      .digest("hex"),
    providerRunId: run.runId,
    // getActiveProviderRunForAgent is agent-scoped, so this is always a worker run and ProviderRunSchema's refinement guarantees a non-null provider for it.
    provider: run.provider as CapabilityProvider,
    capabilityEpoch: run.capabilityEpoch,
    conversationId,
    kind: normalized.kind,
    occurredAt: event.timestamp,
    toolName: normalized.toolName,
    inputDigest: normalized.inputDigest,
  };
  db.insertProviderEvent(value);
  return value;
}
