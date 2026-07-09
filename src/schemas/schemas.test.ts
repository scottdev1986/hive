import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  AgentRecordSchema,
  DEFAULT_ROUTING,
  HandoffSchema,
  HiveConfigSchema,
  HookEventSchema,
  RoutingTableSchema,
  type AgentRecord,
  type HookEvent,
} from ".";

const timestamp = "2026-07-09T12:00:00.000Z";

const roundTrip = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

describe("HiveConfigSchema", () => {
  test("parses a valid round-trip", () => {
    const parsed = HiveConfigSchema.parse({});
    expect(HiveConfigSchema.parse(roundTrip(parsed))).toEqual({
      terminal: "auto",
      headless: false,
    });
  });

  test("rejects an invalid config", () => {
    expect(() => HiveConfigSchema.parse({ terminal: "xterm" })).toThrow();
  });
});

describe("RoutingTableSchema", () => {
  test("parses a valid round-trip", () => {
    const parsed = RoutingTableSchema.parse(DEFAULT_ROUTING);
    expect(RoutingTableSchema.parse(roundTrip(parsed))).toEqual(DEFAULT_ROUTING);
  });

  test("rejects an invalid routing table", () => {
    expect(() =>
      RoutingTableSchema.parse({
        ...DEFAULT_ROUTING,
        deep: { tool: "gemini", model: "pro" },
      }),
    ).toThrow();
  });
});

describe("AgentRecordSchema", () => {
  const agent = {
    id: "018f",
    name: "agent-3",
    tool: "codex",
    model: "gpt-5-codex",
    tier: "standard",
    status: "working",
    taskDescription: "Implement schemas",
    worktreePath: "/tmp/hive-agent-3",
    branch: "hive/agent-3-schemas",
    tmuxSession: "hive-agent-3",
    contextPct: 25,
    createdAt: timestamp,
    lastEventAt: timestamp,
  } satisfies AgentRecord;

  test("parses a valid round-trip", () => {
    const parsed = AgentRecordSchema.parse(agent);
    expect(AgentRecordSchema.parse(roundTrip(parsed))).toEqual(agent);
  });

  test("rejects an invalid agent", () => {
    expect(() => AgentRecordSchema.parse({ ...agent, contextPct: 101 })).toThrow();
  });
});

describe("AgentMessageSchema", () => {
  const message = {
    id: "message-1",
    from: "agent-1",
    to: "agent-3",
    body: "The interface is ready.",
    createdAt: timestamp,
    deliveredAt: null,
  };

  test("parses a valid round-trip", () => {
    const parsed = AgentMessageSchema.parse(message);
    expect(AgentMessageSchema.parse(roundTrip(parsed))).toEqual(message);
  });

  test("rejects an invalid message", () => {
    expect(() =>
      AgentMessageSchema.parse({ ...message, deliveredAt: 123 }),
    ).toThrow();
  });
});

describe("HookEventSchema", () => {
  const events = [
    { kind: "session-start", agentName: "agent-3", timestamp },
    { kind: "turn-start", agentName: "agent-3", timestamp },
    { kind: "turn-end", agentName: "agent-3", timestamp, contextPct: 25 },
    { kind: "notification", agentName: "agent-3", timestamp },
    {
      kind: "approval-request",
      agentName: "agent-3",
      timestamp,
      description: "Run a network install",
    },
    { kind: "dead", agentName: "agent-3", timestamp },
  ] satisfies HookEvent[];

  test("parses a valid round-trip", () => {
    for (const event of events) {
      const parsed = HookEventSchema.parse(event);
      expect(HookEventSchema.parse(roundTrip(parsed))).toEqual(event);
    }
  });

  test("accepts an offset timestamp", () => {
    const event = {
      kind: "session-start",
      agentName: "agent-3",
      timestamp: "2026-07-09T12:00:00+02:00",
    } satisfies HookEvent;

    expect(HookEventSchema.parse(event)).toEqual(event);
  });

  test("rejects an invalid event", () => {
    expect(() =>
      HookEventSchema.parse({
        kind: "approval-request",
        agentName: "agent-3",
        timestamp,
      }),
    ).toThrow();
  });

  test("rejects an unknown event kind", () => {
    expect(() =>
      HookEventSchema.parse({
        kind: "heartbeat",
        agentName: "agent-3",
        timestamp,
      }),
    ).toThrow();
  });
});

describe("HandoffSchema", () => {
  const handoff = {
    agentName: "agent-3",
    goal: "Implement schemas",
    done: ["Added config schema"],
    remaining: ["Run tests"],
    decisions: ["Use ISO timestamps"],
    failedApproaches: [],
    branch: "hive/agent-3-schemas",
    timestamp,
  };

  test("parses a valid round-trip", () => {
    const parsed = HandoffSchema.parse(handoff);
    expect(HandoffSchema.parse(roundTrip(parsed))).toEqual(handoff);
  });

  test("rejects an invalid handoff", () => {
    expect(() => HandoffSchema.parse({ ...handoff, remaining: "tests" })).toThrow();
  });
});
