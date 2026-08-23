import type { HiveDatabase } from "../database/hive-database";

/**
 * P0: Load or synthesize handoff for EVERY specialist spawn.
 * Returns null if unsynthable (no task/assignment) - fail-closed.
 *
 * This is the production handoff loading logic used by HiveSpawner.spawn.
 */
export function loadHandoffText(
  db: Pick<HiveDatabase, "getHandoff">,
  handoffId: string | undefined,
  agentName: string,
  taskDescription: string | undefined,
): string | null {
  if (handoffId !== undefined) {
    const stored = db.getHandoff(handoffId);
    if (stored !== null) {
      const summary = stored.bundle.summary;
      if (summary !== null) {
        const sections: string[] = [
          `Handoff ${handoffId} from run ${stored.bundle.sourceRunId}`,
          `Reason: ${stored.bundle.reason}`,
          `Branch: ${stored.bundle.branch.name}`,
          "",
          `**Goal**: ${summary.goal}`,
        ];

        if (summary.done.length > 0) {
          sections.push("\n**Done**:");
          summary.done.forEach((item) => sections.push(`- ${item}`));
        }

        if (summary.remaining.length > 0) {
          sections.push("\n**Remaining**:");
          summary.remaining.forEach((item) => sections.push(`- ${item}`));
        }

        if (summary.decisions.length > 0) {
          sections.push("\n**Decisions**:");
          summary.decisions.forEach((item) => sections.push(`- ${item}`));
        }

        if (summary.nextAction !== null) {
          sections.push(`\n**Next Action**: ${summary.nextAction}`);
        }

        return sections.join("\n");
      }
    }
  }

  // P0: Fail-closed when synthesis is impossible (no task/assignment)
  if (
    taskDescription === undefined ||
    taskDescription.trim() === "" ||
    agentName.trim() === ""
  ) {
    return null;
  }

  // Synthesize handoff from task assignment
  return [
    "No durable handoff found. Synthesized handoff from assignment:",
    "",
    `**Task**: ${taskDescription}`,
    `**Agent**: ${agentName}`,
    "",
    "**Goal**: Complete the assigned task.",
    "**Remaining**: All work from the task description above.",
    "",
    "Proceed with the task as assigned.",
  ].join("\n");
}
