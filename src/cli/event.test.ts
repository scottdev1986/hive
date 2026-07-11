import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HookEventSchema } from "../schemas";
import { buildEventOptions } from "../cli";
import {
  buildHookEvent,
  parseHookStdin,
  readHookStdin,
  runHiveEvent,
  type EventFetcher,
} from "./event";

const timestamp = "2026-07-09T12:00:00.000Z";

describe("hive event", () => {
  test("merges recognized JSON payload fields with explicit CLI options", () => {
    expect(buildEventOptions({
      agent: "maya",
      payload: JSON.stringify({
        description: "Payload description",
        usage_units: 7,
        usage_source: "gateway",
        ignored: "value",
      }),
    })).toEqual({
      agent: "maya",
      description: "Payload description",
      usageUnits: 7,
      usageSource: "gateway",
    });
    expect(buildEventOptions({
      agent: "maya",
      description: "CLI description",
      payload: JSON.stringify({
        agentName: "payload-agent",
        description: "Payload description",
      }),
    })).toEqual({
      agent: "maya",
      description: "CLI description",
    });
  });

  test("rejects malformed recognized payload fields", () => {
    expect(() => buildEventOptions({ payload: "[]" })).toThrow(
      "Event payload must be a JSON object",
    );
    expect(() => buildEventOptions({
      payload: JSON.stringify({ usage_units: "seven" }),
    })).toThrow("Event payload usageUnits must be a nonnegative number");
  });

  test("builds every valid HookEvent kind and round-trips through the schema", () => {
    const events = [
      buildHookEvent("session-start", { agent: "maya" }, timestamp),
      buildHookEvent("turn-start", { agent: "maya" }, timestamp),
      buildHookEvent(
        "turn-end",
        {
          agent: "maya",
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
      usageUnits: 7,
      usageSource: "provider",
    });
    expect(events[4]).toMatchObject({
      kind: "approval-request",
      description: "Publish package",
    });
  });

  test("captures the tool session id and rides it on every event kind", () => {
    const event = buildHookEvent(
      "session-start",
      { agent: "maya", toolSessionId: "0189-session" },
      timestamp,
    );
    expect(HookEventSchema.parse(event)).toMatchObject({
      kind: "session-start",
      toolSessionId: "0189-session",
    });
    expect(buildHookEvent(
      "turn-end",
      { agent: "maya", toolSessionId: "0189-session" },
      timestamp,
    )).toMatchObject({ toolSessionId: "0189-session" });
  });

  test("extracts the Codex notify thread-id from the payload as the session id", () => {
    expect(buildEventOptions({
      agent: "maya",
      payload: JSON.stringify({
        "type": "agent-turn-complete",
        "thread-id": "019f-thread",
        "turn-id": "42",
        "cwd": "/repo/.hive/worktrees/maya",
        "last-assistant-message": "done",
      }),
    })).toEqual({ agent: "maya", toolSessionId: "019f-thread" });
    expect(() => buildEventOptions({
      payload: JSON.stringify({ "thread-id": 42 }),
    })).toThrow("Event payload session id must be a non-empty string");
  });

  test("parses the Claude hook stdin payload for session_id", () => {
    expect(parseHookStdin(JSON.stringify({
      session_id: "abc123",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      source: "resume",
    }))).toEqual({ toolSessionId: "abc123" });
    expect(parseHookStdin("not json")).toEqual({});
    expect(parseHookStdin(JSON.stringify({ session_id: "" }))).toEqual({});
    expect(parseHookStdin(JSON.stringify(null))).toEqual({});
  });

  test("reads hook stdin without ever stalling the agent turn", async () => {
    expect(await readHookStdin({
      isTTY: false,
      text: async () => JSON.stringify({ session_id: "abc" }),
    })).toEqual({ toolSessionId: "abc" });
    // A TTY is a human, not a hook runner.
    expect(await readHookStdin({
      isTTY: true,
      text: async () => JSON.stringify({ session_id: "abc" }),
    })).toEqual({});
    // A stream that never closes hits the timeout and yields nothing.
    expect(await readHookStdin({
      isTTY: false,
      text: () => new Promise<string>(() => {}),
    }, 20)).toEqual({});
    expect(await readHookStdin({
      isTTY: false,
      text: () => Promise.reject(new Error("closed")),
    })).toEqual({});
  });

  test("returns success when the daemon is down", async () => {
    const unavailableFetch: EventFetcher = () =>
      Promise.reject(new TypeError("connection refused"));
    expect(await runHiveEvent(
      "turn-end",
      4317,
      { agent: "maya" },
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
