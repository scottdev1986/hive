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
      category: "simple_coding",
      status: "working",
      failureReason: "A deliberately long startup failure explaining that the selected model is not supported",
      taskDescription: "Implement a deliberately long task description that cannot fit in the status table without truncation",
      worktreePath: "/tmp/maya",
      branch: "hive/maya-task",
      tmuxSession: "hive-maya",
      contextPct: 37.6,
      createdAt: timestamp,
      lastEventAt: timestamp,
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: false,
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

  test("marks a closed holder so a reused name is never ambiguous", () => {
    const base = {
      tool: "codex",
      model: "gpt-test",
      category: "simple_coding",
      taskDescription: "crash matrix",
      worktreePath: "/tmp/maya",
      branch: "hive/maya-task",
      tmuxSession: "hive-maya",
      contextPct: 0,
      createdAt: timestamp,
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } as const;
    const agents: AgentRecord[] = [
      {
        ...base,
        id: "agent-maya",
        name: "maya",
        status: "dead",
        lastEventAt: "2026-07-09T14:11:00.000Z",
        closedAt: "2026-07-09T14:11:00.000Z",
      },
      {
        ...base,
        id: "agent-maya-2",
        name: "maya",
        status: "working",
        lastEventAt: timestamp,
      },
    ];

    const [, closed, live] = formatStatusTable(agents).split("\n");
    expect(closed).toContain("maya (closed 14:11)");
    // The live holder wears the bare name, and only the live holder.
    expect(live).toMatch(/^maya\s/);
    expect(live).not.toContain("closed");
  });
});

describe("quota status", () => {
  test("shows capacity, reservations, confidence, freshness, and resets", () => {
    const output = formatQuotaStatus([{
      provider: "codex",
      account: "personal",
      pool: "agentic",
      origin: "manual",
      overridesDiscovered: false,
      models: ["*"],
      label: null,
      routable: true,
      confidence: "reported",
      freshness: "fresh",
      source: "manual",
      fiveHour: {
        availability: "available",
        unit: "units",
        allowance: 100,
        used: 60,
        reserved: 10,
        reservedIsEstimate: true,
        remaining: 30,
        remainingPct: 0.3,
        resetsAt: "2026-07-09T18:00:00.000Z",
        confidence: "reported",
        source: "manual",
        observedAt: "2026-07-09T12:00:00.000Z",
        windowMinutes: 300,
      },
      weekly: {
        availability: "available",
        unit: "units",
        allowance: 500,
        used: 100,
        reserved: 10,
        reservedIsEstimate: true,
        remaining: 390,
        remainingPct: 0.78,
        resetsAt: null,
        confidence: "reported",
        source: "manual",
        observedAt: "2026-07-09T12:00:00.000Z",
        windowMinutes: 10_080,
      },
    }]);
    expect(output).toContain("codex/personal/agentic");
    expect(output).toContain("manual");
    expect(output).toContain("30.0 of 100.0 remaining");
    expect(output).toContain("10.0 reserved (est)");
    expect(output).toContain("reset unknown");
  });

  test("renders an unmeasured window as unknown rather than as a number", () => {
    const output = formatQuotaStatus([{
      provider: "claude",
      account: "default",
      pool: "subscription",
      origin: "discovered",
      overridesDiscovered: false,
      models: ["*"],
      label: "max",
      routable: true,
      confidence: "missing",
      freshness: "missing",
      source: "none",
      fiveHour: {
        availability: "available",
        unit: "percent",
        allowance: 100,
        used: 6,
        reserved: 8,
        reservedIsEstimate: true,
        remaining: 86,
        remainingPct: 0.86,
        resetsAt: "2026-07-10T19:00:00.000Z",
        confidence: "reported",
        source: "provider",
        observedAt: "2026-07-10T14:00:00.000Z",
        windowMinutes: 300,
      },
      weekly: {
        availability: "unknown",
        unit: "percent",
        allowance: null,
        used: null,
        reserved: 1.5,
        reservedIsEstimate: true,
        remaining: null,
        remainingPct: null,
        resetsAt: null,
        confidence: "missing",
        source: "none",
        observedAt: null,
        windowMinutes: null,
      },
    }]);
    expect(output).toContain("86.0% of 100.0% remaining");
    expect(output).toContain("week: unknown remaining");
    expect(output).not.toMatch(/week: [\d.]/);
  });

  test("names a provider gap without blaming a missing config file", () => {
    const output = formatQuotaStatus([{
      provider: "claude",
      model: "*",
      configured: false,
      confidence: "missing",
      reason: "Live limits from claude are unavailable: not signed in",
      probeError: "not signed in",
      reserved: 0,
      fiveHourRecorded: 4,
      weeklyRecorded: 12,
      recordedIsLocalEstimate: true,
    }]);
    expect(output).toContain("LIMITS UNKNOWN");
    expect(output).toContain("not signed in");
    expect(output).toContain("not the account's usage");
    expect(output).not.toContain("quota.toml");
  });
});
