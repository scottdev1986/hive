/** Connected-session protocol events → agent-row facts and token readings. Statusline and transcript scrapers are gone. Live model, context window, and occupancy reach Hive only through normalized protocol events. A field the vendor never named stays absent: null is not zero. */
import type { NormalizedProviderEvent } from "../adapters/providers/protocol/types";
import type { TokenUsageEventIngest } from "../schemas/token-usage-schema";
import { clampPct } from "./context-occupancy";
import { protocolTokenEvent } from "./token-usage";

export type AgentSessionFactPatch = {
  liveModel?: string;
  contextWindow?: number;
  contextPct?: number;
  effort?: string;
};

/** One protocol event's contribution to the agent row. Empty object means the event carried nothing this path stores. Never writes a zero window or a zero occupancy for a missing measurement. */
export function agentFactsFromProtocolEvent(
  event: NormalizedProviderEvent,
): AgentSessionFactPatch {
  switch (event.kind) {
    case "config-updated": {
      const patch: AgentSessionFactPatch = {};
      if (event.model !== null && event.model.length > 0) {
        patch.liveModel = event.model;
      }
      if (event.effort !== null && event.effort.length > 0) {
        patch.effort = event.effort;
      }
      return patch;
    }
    case "usage-updated": {
      const patch: AgentSessionFactPatch = {};
      if (
        typeof event.contextWindow === "number" &&
        Number.isFinite(event.contextWindow) &&
        event.contextWindow > 0
      ) {
        patch.contextWindow = Math.floor(event.contextWindow);
      }
      if (
        typeof event.contextPercent === "number" &&
        Number.isFinite(event.contextPercent)
      ) {
        patch.contextPct = clampPct(event.contextPercent);
      }
      return patch;
    }
    default:
      return {};
  }
}

export function tokenEventsFromProtocol(
  events: readonly NormalizedProviderEvent[],
): TokenUsageEventIngest[] {
  const out: TokenUsageEventIngest[] = [];
  for (const event of events) {
    if (event.kind !== "usage-updated") continue;
    const mapped = protocolTokenEvent(event);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}
