import { describe, expect, test } from "bun:test";
import { findBoardContradictions } from "../../src/daemon/status-service/board-contradictions";
import type { AgentRecord } from "../../src/schemas/agent";
import type { TaskDetail } from "../../src/schemas/task-detail";

describe("board contradiction detector", () => {
  test("fires on a live agent whose task is not in progress and goes quiet when corrected", () => {
    const taskId = "task_019fec14-1023-7000-8000-000000000123";
    const agent = {
      id: "agent-luke",
      name: "luke",
    } as AgentRecord;
    const task = {
      taskId,
      state: "planned",
      blockers: ["IN PROGRESS. Assignee: luke (agent-luke)."],
    } as TaskDetail;

    expect(findBoardContradictions([agent], [task])).toEqual([
      { agent: "luke", taskId, taskState: "planned" },
    ]);
    expect(
      findBoardContradictions(
        [agent],
        [
          {
            ...task,
            state: "in-progress",
          },
        ],
      ),
    ).toEqual([]);
  });
});
