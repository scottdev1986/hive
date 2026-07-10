import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../schemas";
import { formatQuotaStatus, formatStatusTable } from "./status";

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
      channelsEnabled: false,
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

describe("quota status", () => {
  test("shows capacity, reservations, confidence, freshness, and resets", () => {
    const output = formatQuotaStatus([{
      provider: "codex",
      account: "personal",
      pool: "agentic",
      models: ["*"],
      confidence: "reported",
      freshness: "fresh",
      source: "manual",
      fiveHour: {
        allowance: 100,
        used: 60,
        reserved: 10,
        remaining: 30,
        remainingPct: 0.3,
        resetsAt: "2026-07-09T18:00:00.000Z",
      },
      weekly: {
        allowance: 500,
        used: 100,
        reserved: 10,
        remaining: 390,
        remainingPct: 0.78,
        resetsAt: null,
      },
    }]);
    expect(output).toContain("codex/personal/agentic");
    expect(output).toContain("reported, fresh, manual");
    expect(output).toContain("30.0/100.0 remaining");
    expect(output).toContain("10.0 reserved");
    expect(output).toContain("reset unknown");
  });
});
