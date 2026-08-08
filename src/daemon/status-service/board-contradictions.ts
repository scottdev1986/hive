import type { AgentRecord } from "../../schemas/agent";
import type { TaskDetail } from "../../schemas/task-detail";

export type BoardContradiction = {
  agent: string;
  taskId: string;
  taskState: TaskDetail["state"];
};

export function findBoardContradictions(
  agents: readonly AgentRecord[],
  tasks: readonly TaskDetail[],
): BoardContradiction[] {
  return agents.flatMap((agent) => {
    const task = tasks.find((candidate) =>
      candidate.blockers.some((blocker) =>
        blocker.startsWith(
          `IN PROGRESS. Assignee: ${agent.name} (${agent.id}).`,
        ),
      ),
    );
    return task !== undefined && task.state !== "in-progress"
      ? [{ agent: agent.name, taskId: task.taskId, taskState: task.state }]
      : [];
  });
}
