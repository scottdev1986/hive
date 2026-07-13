import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  AgentRecordSchema,
  HandoffSchema,
  HiveConfigSchema,
  HookEventSchema,
  type AgentRecord,
  type AgentMessage,
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
      layout: "auto",
      codex: { driver: "tui" },
      channels: "auto",
      autonomy: "sandboxed",
      routingManifest: "auto",
      router: "derived",
      benchmarks: { mode: "live" },
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: 4_096,
      },
      lifecycle: {
        idleReap: true,
        idleReapMinutes: 10,
      },
    });
  });

  test("rejects an invalid config", () => {
    expect(() => HiveConfigSchema.parse({ terminal: "xterm" })).toThrow();
    expect(() => HiveConfigSchema.parse({ layout: "stack" })).toThrow();
    expect(() =>
      HiveConfigSchema.parse({ codex: { driver: "exec" } })
    ).toThrow();
    expect(() => HiveConfigSchema.parse({ autonomy: "yolo" })).toThrow();
    expect(() => HiveConfigSchema.parse({ terminl: "auto" })).toThrow();
    expect(() => HiveConfigSchema.parse({ codex: { driver: "tui", typo: true } })).toThrow();
    expect(() => HiveConfigSchema.parse({ resources: { typo: true } })).toThrow();
  });
});

describe("AgentRecordSchema", () => {
  const agent = {
    id: "018f",
    name: "agent-3",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "working",
    taskDescription: "Implement schemas",
    worktreePath: "/tmp/hive-agent-3",
    branch: "hive/agent-3-schemas",
    tmuxSession: "hive-agent-3",
    contextPct: 25,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
  } satisfies AgentRecord;

  test("parses a valid round-trip", () => {
    const parsed = AgentRecordSchema.parse(agent);
    expect(AgentRecordSchema.parse(roundTrip(parsed))).toEqual(agent);
  });

  test("rejects an invalid agent", () => {
    expect(() => AgentRecordSchema.parse({ ...agent, contextPct: 101 })).toThrow();
  });

  test("parses persisted spawn failure details", () => {
    const failed = {
      ...agent,
      status: "failed",
      failureReason: "Error: model not supported",
      failedAt: timestamp,
    } satisfies AgentRecord;
    expect(AgentRecordSchema.parse(roundTrip(failed))).toEqual(failed);
  });

  test("parses native terminal handles and remains compatible without one", () => {
    const itermAgent = {
      ...agent,
      terminalHandle: { app: "iterm2", sessionId: "session-uuid" },
    } satisfies AgentRecord;
    const terminalAgent = {
      ...agent,
      terminalHandle: {
        app: "terminal",
        processId: 4242,
        windowId: 42,
        tty: "/dev/ttys004",
      },
    } satisfies AgentRecord;

    expect(AgentRecordSchema.parse(roundTrip(itermAgent))).toEqual(itermAgent);
    expect(AgentRecordSchema.parse(roundTrip(terminalAgent))).toEqual(
      terminalAgent,
    );
    expect(AgentRecordSchema.parse(roundTrip(agent))).toEqual(agent);
    expect(() =>
      AgentRecordSchema.parse({
        ...agent,
        terminalHandle: {
          app: "terminal",
          processId: 0,
          windowId: 0,
          tty: "",
        },
      })
    ).toThrow();
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
    priority: "normal",
    intent: "instruction",
    state: "queued",
    injectedAt: null,
    acknowledgedAt: null,
    appliedAt: null,
    deadlineAt: null,
    alertAt: null,
    sequence: 0,
    idempotencyKey: null,
    capabilityEpoch: null,
  } satisfies AgentMessage;

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
    {
      kind: "effort-drift",
      agentName: "agent-3",
      timestamp,
      description: "Execution effort drifted from high to low",
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
