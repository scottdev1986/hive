import { describe, expect, test } from "bun:test";
import { PaneEventsReporter } from "../src/cli/agent-ui/pane-events-reporter";

interface Sent {
  readonly path: string;
  readonly body: {
    readonly events: readonly {
      occurredAt: string;
      kind: string;
      data: unknown;
    }[];
  };
}

function fakeClient(statuses: number[] = []) {
  const sent: Sent[] = [];
  let calls = 0;
  return {
    sent,
    client: {
      async request(path: string, init?: RequestInit) {
        const body = JSON.parse(String(init?.body));
        sent.push({ path, body });
        const status = statuses[calls] ?? 200;
        calls += 1;
        return new Response("{}", { status });
      },
    },
  };
}

describe("pane events reporter", () => {
  test("events batch into one report, and a coalesce key keeps only the latest", async () => {
    const { client, sent } = fakeClient();
    const failures: string[] = [];
    const reporter = new PaneEventsReporter({
      client,
      onFailure: (detail) => failures.push(detail),
      flushAfterMs: 5,
    });
    reporter.record({
      occurredAt: "2026-08-30T12:00:00.000Z",
      kind: "pane.tool.started",
      data: { toolName: "Edit" },
    });
    reporter.record({
      occurredAt: "2026-08-30T12:00:01.000Z",
      kind: "pane.turn.changes",
      coalesceKey: "changes:t1",
      data: { files: 1 },
    });
    reporter.record({
      occurredAt: "2026-08-30T12:00:02.000Z",
      kind: "pane.turn.changes",
      coalesceKey: "changes:t1",
      data: { files: 2 },
    });
    await reporter.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe("/pane-events");
    expect(sent[0]?.body.events.map((event) => event.kind)).toEqual([
      "pane.tool.started",
      "pane.turn.changes",
    ]);
    expect(sent[0]?.body.events[1]?.data).toEqual({ files: 2 });
    expect(failures).toEqual([]);
  });

  test("a refusal is reported once and later batches still go out", async () => {
    const { client, sent } = fakeClient([503, 503, 200]);
    const failures: string[] = [];
    const reporter = new PaneEventsReporter({
      client,
      onFailure: (detail) => failures.push(detail),
      flushAfterMs: 5,
    });
    for (const kind of [
      "pane.turn.started",
      "pane.turn.ended",
      "pane.tool.started",
    ]) {
      reporter.record({
        occurredAt: "2026-08-30T12:00:00.000Z",
        kind,
        data: {},
      });
      await reporter.flush();
    }
    expect(sent).toHaveLength(3);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("503");
  });

  test("an unparseable timestamp is replaced rather than sent", async () => {
    const { client, sent } = fakeClient();
    const reporter = new PaneEventsReporter({
      client,
      onFailure: () => {},
      flushAfterMs: 5,
    });
    reporter.record({
      occurredAt: "not a time",
      kind: "pane.turn.started",
      data: {},
    });
    await reporter.flush();
    const event = sent[0]?.body.events[0];
    expect(Number.isFinite(Date.parse(event?.occurredAt ?? ""))).toBe(true);
  });
});
