import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../schemas";
import { formatStatusTable } from "./status";

const timestamp = "2026-07-09T12:00:00.000Z";

describe("status table", () => {
  test("formats the requested columns and truncates long tasks", () => {
    const agents: AgentRecord[] = [{
      id: "agent-maya",
      name: "maya",
      tool: "codex",
      model: "gpt-test",
      tier: "standard",
      status: "working",
      failureReason: "A deliberately long startup failure explaining that the selected model is not supported",
      taskDescription: "Implement a deliberately long task description that cannot fit in the status table without truncation",
      worktreePath: "/tmp/maya",
      branch: "hive/maya-task",
      tmuxSession: "hive-maya",
      contextPct: 37.6,
      createdAt: timestamp,
      lastEventAt: timestamp,
      capabilityEpoch: 0,
      writeRevoked: false,
    }];

    const table = formatStatusTable(agents);
    const [header, row] = table.split("\n");
    expect(header).toContain("NAME");
    expect(header).toContain("TOOL");
    expect(header).toContain("MODEL");
    expect(header).toContain("STATUS");
    expect(header).toContain("CONTEXT");
    expect(header).toContain("TASK");
    expect(header).toContain("FAILURE");
    expect(row).toContain("maya");
    expect(row).toContain("codex");
    expect(row).toContain("gpt-test");
    expect(row).toContain("working");
    expect(row).toContain("38%");
    expect(row).not.toContain("without truncation");
    expect(row).toEndWith("…");
    expect(row).not.toContain("selected model is not supported");
  });
});
