import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { ObservabilityService } from "../../src/daemon/observability/observability-service";

const databases: HiveDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function service(
  options: { log?: (line: string) => void } = {},
): ObservabilityService {
  const database = new HiveDatabase(":memory:");
  databases.push(database);
  return new ObservabilityService(database, {
    clock: () => new Date("2026-08-11T12:00:00.000Z"),
    ...options,
  });
}

describe("ObservabilityService", () => {
  test("redacts, persists, mirrors, and idempotently accepts a retried event", () => {
    const lines: string[] = [];
    const observability = service({ log: (line) => lines.push(line) });
    const eventId = randomUUID();
    const report = {
      schemaVersion: 1 as const,
      eventId,
      occurredAt: "2026-08-11T11:59:00.000Z",
      severity: "error" as const,
      source: "background" as const,
      operation: "mail-ready-poll",
      reason: "request failed: Bearer secret-token-value",
      subject: "clay",
      agentId: null,
      provider: "codex" as const,
      providerRunId: null,
      vendorSessionId: "session-1",
      toolName: null,
      callId: "poll-1",
    };

    const first = observability.ingest(report);
    const retry = observability.ingest(report);

    expect(retry).toEqual(first);
    expect(first.reason).toBe("request failed: [REDACTED]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"source":"background"');
    expect(lines[0]).not.toContain("secret-token-value");
    expect(observability.list({ limit: 100 })).toEqual([first]);
  });

  test("separates expected MCP refusals from runtime faults", async () => {
    const observability = service();

    await observability.observeMcpTool(
      { toolName: "hive_task_update", subject: "clay", callId: "17" },
      () => ({
        content: [
          {
            type: "text" as const,
            text: "agent clay holds no live hierarchy binding",
          },
        ],
        isError: true,
      }),
    );
    await expect(
      observability.observeMcpTool(
        { toolName: "hive_update_status", subject: "clay", callId: "19" },
        () => {
          z.strictObject({ state: z.string() }).parse({ state: 4 });
          throw new Error("unreachable");
        },
      ),
    ).rejects.toThrow();
    await expect(
      observability.observeMcpTool(
        { toolName: "hive_update_status", subject: "clay", callId: "20" },
        () => {
          throw Object.assign(new Error("assignment no longer matches"), {
            code: "STATUS_ASSIGNMENT_MISMATCH",
          });
        },
      ),
    ).rejects.toThrow("assignment no longer matches");
    await expect(
      observability.observeMcpTool(
        { toolName: "hive_mail_poll", subject: "clay", callId: "18" },
        () => {
          throw new Error("mailbox authorization failed");
        },
      ),
    ).rejects.toThrow("mailbox authorization failed");

    const events = observability.list({
      source: "mcp-tool",
      subject: "clay",
      limit: 100,
    });
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.reason)).toContain(
      "agent clay holds no live hierarchy binding",
    );
    expect(events.map((event) => event.reason)).toContain(
      "mailbox authorization failed",
    );
    expect(
      events.find((event) => event.toolName === "hive_task_update")?.severity,
    ).toBe("warning");
    expect(
      events.find((event) => event.toolName === "hive_mail_poll")?.severity,
    ).toBe("error");
    expect(
      events
        .filter((event) => event.toolName === "hive_update_status")
        .map((event) => event.severity),
    ).toEqual(["warning", "warning"]);
  });

  test("filters by session, tool, severity, subject, and time", () => {
    const observability = service();
    observability.record({
      occurredAt: "2026-08-11T10:00:00.000Z",
      severity: "warning",
      source: "session",
      operation: "quota-warning",
      reason: "quota is low",
      subject: "maya",
      vendorSessionId: "session-a",
    });
    const expected = observability.record({
      occurredAt: "2026-08-11T11:00:00.000Z",
      source: "mcp-tool",
      operation: "hive_task_update",
      reason: "stale generation",
      subject: "clay",
      vendorSessionId: "session-b",
      toolName: "hive_task_update",
    });

    expect(
      observability.list({
        since: "2026-08-11T10:30:00.000Z",
        severity: "error",
        subject: "clay",
        session: "session-b",
        tool: "hive_task_update",
        limit: 10,
      }),
    ).toEqual([expected]);
  });
});
