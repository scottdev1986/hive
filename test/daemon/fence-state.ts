import type { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { AgentBindingRef } from "../../src/schemas/hierarchy-node";

// Fence-refusal tests need stored fence state that disagrees with what the
// caller presents. hierarchyRevision has no production on-demand door, so
// tests write the divergent fence directly. capabilityEpoch is the flat
// AgentRecord counter — bumping it here is the same rotation handoff does.

export function bumpCapabilityEpoch(
  db: HiveDatabase,
  binding: AgentBindingRef,
): void {
  const agent = db.getAgentById(binding.agentId);
  if (agent === null) {
    throw new Error(`no flat agent ${binding.agentId} for capability epoch`);
  }
  db.upsertAgent({
    ...agent,
    capabilityEpoch: agent.capabilityEpoch + 1,
  });
}

export function bumpHierarchyRevision(db: HiveDatabase, runId: string): void {
  // SAFETY: The test owns this value and its fields.
  const row = db.database
    .query("SELECT hierarchyRevision FROM hierarchy_fences WHERE runId = ?")
    .get(runId) as { hierarchyRevision: string } | null;
  if (row === null) throw new Error(`no fences for ${runId}`);
  db.database
    .query("UPDATE hierarchy_fences SET hierarchyRevision = ? WHERE runId = ?")
    .run((BigInt(row.hierarchyRevision) + 1n).toString(), runId);
}
