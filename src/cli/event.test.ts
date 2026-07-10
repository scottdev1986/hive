import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HookEventSchema } from "../schemas";
import { buildEventOptions } from "../cli";
import {
  buildHookEvent,
  runHiveEvent,
  type EventFetcher,
} from "./event";

const timestamp = "2026-07-09T12:00:00.000Z";

describe("hive event", () => {
  test("merges recognized JSON payload fields with explicit CLI options", () => {
    expect(buildEventOptions({
      agent: "maya",
      payload: JSON.stringify({
        contextPct: 64,
        description: "Payload description",
        usage_units: 7,
        usage_source: "gateway",
        ignored: "value",
      }),
    })).toEqual({
      agent: "maya",
      contextPct: 64,
      description: "Payload description",
      usageUnits: 7,
      usageSource: "gateway",
    });
    expect(buildEventOptions({
      agent: "maya",
      contextPct: "72",
      description: "CLI description",
      payload: JSON.stringify({
        agentName: "payload-agent",
        contextPct: 64,
        description: "Payload description",
      }),
    })).toEqual({
      agent: "maya",
      contextPct: 72,
      description: "CLI description",
    });
  });

  test("rejects malformed or invalid recognized payload fields", () => {
    expect(() => buildEventOptions({ payload: "[]" })).toThrow(
      "Event payload must be a JSON object",
    );
    expect(() => buildEventOptions({
      payload: JSON.stringify({ contextPct: "64" }),
    })).toThrow("Event payload contextPct must be a number");
  });

  test("builds every valid HookEvent kind and round-trips through the schema", () => {
    const events = [
      buildHookEvent("session-start", { agent: "maya" }, timestamp),
      buildHookEvent("turn-start", { agent: "maya" }, timestamp),
      buildHookEvent(
        "turn-end",
        {
          agent: "maya",
          contextPct: 42,
          usageUnits: 7,
          usageSource: "provider",
        },
        timestamp,
      ),
      buildHookEvent("notification", { agent: "maya" }, timestamp),
      buildHookEvent(
        "approval-request",
        { agent: "maya", description: "Publish package" },
        timestamp,
      ),
      buildHookEvent("dead", { agent: "maya" }, timestamp),
    ];

    for (const event of events) {
      const encoded = JSON.stringify(event);
      expect(HookEventSchema.parse(JSON.parse(encoded))).toEqual(event);
    }
    expect(events[2]).toMatchObject({
      kind: "turn-end",
      contextPct: 42,
      usageUnits: 7,
      usageSource: "provider",
    });
    expect(events[4]).toMatchObject({
      kind: "approval-request",
      description: "Publish package",
    });
  });

  test("returns success when the daemon is down", async () => {
    const unavailableFetch: EventFetcher = () =>
      Promise.reject(new TypeError("connection refused"));
    expect(await runHiveEvent(
      "turn-end",
      4317,
      { agent: "maya", contextPct: 8 },
      unavailableFetch,
    )).toEqual(0);
  });

  test("the CLI event process exits zero when delivery fails", async () => {
    const child = Bun.spawn([
      Bun.which("bun") ?? globalThis.process.execPath,
      "src/cli.ts",
      "event",
      "turn-start",
      "--agent",
      "maya",
      "--port",
      "1",
    ], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toEqual(0);

    const malformed = Bun.spawn([
      Bun.which("bun") ?? globalThis.process.execPath,
      "src/cli.ts",
      "event",
      "turn-start",
      "--agent",
    ], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await malformed.exited).toEqual(0);
  });
});
