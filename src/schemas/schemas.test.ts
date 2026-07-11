import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  AgentRecordSchema,
  ClaudeRouteSchema,
  DEFAULT_ROUTING,
  defaultRoutingTable,
  FABLE_AUTO_ROUTING_CUTOFF,
  HandoffSchema,
  HiveConfigSchema,
  HookEventSchema,
  RouteSchema,
  RoutingTableSchema,
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
      autonomy: "dangerous",
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

describe("RoutingTableSchema", () => {
  test("parses a valid round-trip", () => {
    const parsed = RoutingTableSchema.parse(DEFAULT_ROUTING);
    expect(RoutingTableSchema.parse(roundTrip(parsed))).toEqual(DEFAULT_ROUTING);
  });

  test("accepts the CLI account default while preserving pinned models", () => {
    expect(
      RoutingTableSchema.parse(DEFAULT_ROUTING).standard.codex.model,
    ).toEqual("default");
    expect(RoutingTableSchema.parse({
      ...DEFAULT_ROUTING,
      standard: {
        ...DEFAULT_ROUTING.standard,
        codex: {
          model: "gpt-pinned",
          effort: "medium",
        },
      },
    }).standard.codex.model).toEqual("gpt-pinned");
  });

  test("accepts minimal effort", () => {
    expect(RouteSchema.parse({
      ...DEFAULT_ROUTING.standard,
      codex: {
        ...DEFAULT_ROUTING.standard.codex,
        effort: "minimal",
      },
    }).codex.effort).toEqual("minimal");
  });

  test("rejects a pre-migration flat route", () => {
    expect(() =>
      RoutingTableSchema.parse({
        cheap: { tool: "codex", model: "x" },
      })
    ).toThrow(/unrecognized key.*model/i);
  });

  test("rejects a misspelled Claude route key", () => {
    expect(() =>
      RoutingTableSchema.parse({
        ...DEFAULT_ROUTING,
        cheap: {
          ...DEFAULT_ROUTING.cheap,
          claude: { model: "haiku", modle: "typo" },
        },
      })
    ).toThrow(/unrecognized key.*modle/i);
  });

  test("rejects effort on a Claude route", () => {
    expect(() =>
      ClaudeRouteSchema.parse({ model: "sonnet", effort: "high" })
    ).toThrow(/unrecognized key.*effort/i);
  });

  test("rejects a route missing the codex sub-table", () => {
    const { codex: _codex, ...withoutCodex } = DEFAULT_ROUTING.standard;
    expect(() => RouteSchema.parse(withoutCodex)).toThrow();
  });

  test("rejects an invalid routing table", () => {
    expect(() =>
      RoutingTableSchema.parse({
        ...DEFAULT_ROUTING,
        deep: { ...DEFAULT_ROUTING.deep, tool: "gemini" },
      }),
    ).toThrow();
  });
});

describe("defaultRoutingTable", () => {
  const cutoff = new Date(FABLE_AUTO_ROUTING_CUTOFF);

  test("keeps the deep tier on the best alias before the Fable cutoff", () => {
    const justBefore = new Date(cutoff.getTime() - 1);
    expect(defaultRoutingTable(justBefore)).toEqual(DEFAULT_ROUTING);
    expect(defaultRoutingTable(justBefore).deep.claude.model).toEqual("best");
  });

  test("stops auto-selecting Fable for the deep tier on/after the cutoff", () => {
    expect(defaultRoutingTable(cutoff).deep.claude.model).toEqual(
      "claude-opus-4-8",
    );
    const justAfter = new Date(cutoff.getTime() + 1);
    expect(defaultRoutingTable(justAfter).deep.claude.model).toEqual(
      "claude-opus-4-8",
    );
  });

  test("changes nothing but the deep tier's claude model across the cutoff", () => {
    const before = defaultRoutingTable(new Date(cutoff.getTime() - 1));
    const after = defaultRoutingTable(cutoff);
    expect(after.deep.codex).toEqual(before.deep.codex);
    expect(after.standard).toEqual(before.standard);
    expect(after.cheap).toEqual(before.cheap);
    expect(after.review).toEqual(before.review);
  });

  test("produces a schema-valid table on both sides of the cutoff", () => {
    expect(() =>
      RoutingTableSchema.parse(defaultRoutingTable(new Date(cutoff.getTime() - 1)))
    ).not.toThrow();
    expect(() => RoutingTableSchema.parse(defaultRoutingTable(cutoff)))
      .not.toThrow();
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
