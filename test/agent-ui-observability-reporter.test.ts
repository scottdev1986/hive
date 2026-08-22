import { describe, expect, test } from "bun:test";
import { PaneObservabilityReporter } from "../src/cli/agent-ui/observability-reporter";
import { PaneDaemonClient } from "../src/cli/agent-ui/pane-daemon-client";
import type { JsonObject } from "../src/shared/json";

const AT = "2026-08-11T12:00:00.000Z";

function providerEvent<T extends object>(event: T, sequence: number) {
  return { ...event, sequence, occurredAt: AT, raw: {} };
}

describe("pane observability reporter", () => {
  test("tool failures remain agent activity rather than provider incidents", async () => {
    const reports: Array<JsonObject> = [];
    const client = new PaneDaemonClient({
      port: 1,
      subject: "clay",
      retries: 0,
      fetch: async (_input, init) => {
        // SAFETY: The test owns this value and its fields.
        const report = JSON.parse(String(init?.body)) as JsonObject;
        reports.push(report);
        return Response.json({ event: { ...report, recordedAt: AT } });
      },
    });
    const reporter = new PaneObservabilityReporter({
      client,
      subject: "clay",
      provider: "codex",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000901",
      vendorSessionId: "codex-session-1",
      now: () => AT,
    });

    expect(
      await reporter.observeProviderEvent(
        providerEvent(
          {
            kind: "tool-started" as const,
            turnId: "turn-1",
            toolCallId: "call-1",
            toolName: "Hive task update",
            detail: '{"freshForSeconds":900}',
          },
          1,
        ),
      ),
    ).toBeNull();
    const failure = await reporter.observeProviderEvent(
      providerEvent(
        {
          kind: "tool-finished" as const,
          turnId: "turn-1",
          toolCallId: "call-1",
          status: "error" as const,
          reason: "agent clay holds no live hierarchy binding",
        },
        2,
      ),
    );

    expect(failure).toBeNull();
    expect(reports).toHaveLength(0);
  });

  test("does not duplicate a Hive MCP failure already owned by the daemon", async () => {
    const reports: Array<JsonObject> = [];
    const client = new PaneDaemonClient({
      port: 1,
      subject: "clay",
      retries: 0,
      fetch: async (_input, init) => {
        // SAFETY: The test owns this value and its fields.
        const report = JSON.parse(String(init?.body)) as JsonObject;
        reports.push(report);
        return Response.json({ event: { ...report, recordedAt: AT } });
      },
    });
    const reporter = new PaneObservabilityReporter({
      client,
      subject: "clay",
      provider: "claude",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000901",
      vendorSessionId: "claude-session-1",
      now: () => AT,
    });

    await reporter.observeProviderEvent(
      providerEvent(
        {
          kind: "tool-started" as const,
          turnId: "turn-1",
          toolCallId: "call-1",
          toolName: "mcp__hive__hive_mail_complete",
          detail: '{"itemId":"mit_1"}',
        },
        1,
      ),
    );
    expect(
      await reporter.observeProviderEvent(
        providerEvent(
          {
            kind: "tool-finished" as const,
            turnId: "turn-1",
            toolCallId: "call-1",
            status: "error" as const,
            reason: "MAIL_LEASE_NOT_HELD",
          },
          2,
        ),
      ),
    ).toBeNull();
    expect(reports).toHaveLength(0);
  });

  test("still records a failed provider turn", async () => {
    const reports: Array<JsonObject> = [];
    const reporter = new PaneObservabilityReporter({
      client: new PaneDaemonClient({
        port: 1,
        subject: "clay",
        retries: 0,
        fetch: async (_input, init) => {
          // SAFETY: The test owns this value and its fields.
          const report = JSON.parse(String(init?.body)) as JsonObject;
          reports.push(report);
          return Response.json({ event: { ...report, recordedAt: AT } });
        },
      }),
      subject: "clay",
      provider: "codex",
      providerRunId: "018f1e90-7b5a-7cc0-8000-000000000901",
      vendorSessionId: "codex-session-1",
      now: () => AT,
    });

    expect(
      await reporter.observeProviderEvent(
        providerEvent(
          {
            kind: "turn-failed" as const,
            turnId: "turn-1",
            reason: "provider lost the turn",
          },
          1,
        ),
      ),
    ).toMatchObject({ operation: "provider-turn", severity: "error" });
    expect(reports).toHaveLength(1);
  });
});
