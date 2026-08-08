import type { AgentRecord } from "../../schemas/agent";
import type { HiveDatabase } from "../database/hive-database";
import type { GraphifyService } from "../graphify-service/graphify-service";
import { readGrokContextOccupancy } from "../../usage-service/context-occupancy";
import {
  countGraphifyFromProviderEvents,
  type GraphifyCallCursor,
} from "./tool-telemetry";

export interface ToolTelemetryRefreshDeps {
  db: HiveDatabase;
  graphify: GraphifyService | undefined;
  graphifyCalls: Map<string, GraphifyCallCursor>;
}

export async function refreshToolTelemetry(
  deps: ToolTelemetryRefreshDeps,
): Promise<void> {
  if (deps.graphify === undefined) {
    deps.graphifyCalls.clear();
  }
  for (const agent of deps.db.listAgents()) {
    if (agent.status === "dead" || agent.status === "done") {
      deps.graphifyCalls.delete(agent.id);
      continue;
    }
    if (deps.graphify !== undefined) {
      updateGraphifyCount(deps, agent);
    }
    if (agent.tool === "grok" && agent.worktreePath !== null) {
      await updateGrokOccupancy(deps, agent);
    }
  }
}

function updateGraphifyCount(
  deps: ToolTelemetryRefreshDeps,
  agent: AgentRecord,
): void {
  const count = countGraphifyFromProviderEvents(deps.db, agent);
  if (count === null) {
    deps.graphifyCalls.delete(agent.id);
    return;
  }
  deps.graphifyCalls.set(agent.id, {
    path: "protocol",
    offset: 0,
    count,
  });
}

async function updateGrokOccupancy(
  deps: ToolTelemetryRefreshDeps,
  agent: AgentRecord,
): Promise<void> {
  if (agent.worktreePath === null) return;
  const contextPct = await readGrokContextOccupancy(
    agent.worktreePath,
    agent.toolSessionId,
  ).catch(() => null);
  // Include a measured null so a stale percentage does not stand forever.
  const current = deps.db.getAgentById(agent.id);
  if (current === null || current.tool !== "grok") return;
  if (contextPct !== current.contextPct) {
    deps.db.upsertAgent({ ...current, contextPct });
  }
}
