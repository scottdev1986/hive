import { describe, expect, test } from "bun:test";
import {
  type AgentRecord,
  AgentRecordSchema,
  canonicalOrchestratorName,
  isOrchestratorName,
  ORCHESTRATOR_NAME,
  ORCHESTRATOR_NAME_ALIASES,
  orchestratorRecipientNames,
} from "../../src/schemas/agent";
import {
  emptyRoutingPolicy,
  RoutingPolicySchema,
} from "../../src/schemas/routing-policy";
import { ApprovalSchema } from "../../src/schemas/approval";
import { HandoffSchema } from "../../src/schemas/handoff-schema";
import { HiveConfigSchema } from "../../src/schemas/config-schema";
import { type HookEvent, HookEventSchema } from "../../src/schemas/event";
import { ProtocolSessionFactsReportSchema } from "../../src/schemas/token-usage-schema";

const timestamp = "2026-07-09T12:00:00.000Z";

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("HiveConfigSchema", () => {
  test("parses a valid round-trip", () => {
    const parsed = HiveConfigSchema.parse({});
    expect(HiveConfigSchema.parse(roundTrip(parsed))).toEqual({
      autonomy: "sandboxed",
      routingManifest: "auto",
      router: "derived",
      benchmarks: { mode: "live" },
      resources: {
        enabled: true,
        perProcessMemoryMb: 12_288,
        minSystemAvailableMb: 4_096,
      },
      artifacts: { retention_days: 90 },
      mail: { max_attempts: 5, slo_breach_seconds: 600 },
      memory: {
        retention: {
          events_hot_days: 30,
          stale_after_days: 90,
          sweep_interval_hours: 24,
        },
        wake_budget_tokens: 300,
        embedding_provider: "local",
        embedding_model: "bge-small-en-v1.5",
      },
    });
  });

  test("rejects an invalid config", () => {
    expect(() => HiveConfigSchema.parse({ terminal: "auto" })).toThrow();
    expect(() => HiveConfigSchema.parse({ headless: true })).toThrow();
    expect(() => HiveConfigSchema.parse({ layout: "auto" })).toThrow();
    expect(() => HiveConfigSchema.parse({ autonomy: "yolo" })).toThrow();
    expect(() => HiveConfigSchema.parse({ terminl: "auto" })).toThrow();
    expect(() => HiveConfigSchema.parse({ codex: {} })).toThrow();
    expect(() =>
      HiveConfigSchema.parse({ resources: { typo: true } }),
    ).toThrow();
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
    contextPct: 25,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  } satisfies AgentRecord;

  test("parses a valid round-trip", () => {
    const parsed = AgentRecordSchema.parse(agent);
    expect(AgentRecordSchema.parse(roundTrip(parsed))).toEqual(agent);
  });

  test("rejects an invalid agent", () => {
    expect(() =>
      AgentRecordSchema.parse({ ...agent, contextPct: 101 }),
    ).toThrow();
  });

  test("a misspelled safety field cannot fall through to its default", () => {
    expect(AgentRecordSchema.parse({ ...agent, readOnly: true }).readOnly).toBe(
      true,
    );
    expect(() =>
      AgentRecordSchema.parse({
        ...agent,
        readOnly: undefined,
        readonly: true,
      }),
    ).toThrow();
  });

  test("rejects retired external-viewer state", () => {
    const result = AgentRecordSchema.safeParse({
      ...agent,
      terminalHandle: { app: "external", sessionId: "session-uuid" },
    });
    expect(result.success).toBe(false);
  });
});

describe("ApprovalSchema", () => {
  const approval = {
    id: "approval-1",
    agentName: "agent-3",
    description: "Run a network install",
    status: "pending",
    createdAt: timestamp,
    resolvedAt: null,
  };

  test("defaults only a missing legacy kind", () => {
    expect(ApprovalSchema.parse(approval).kind).toBe("tool-permission");
    expect(
      ApprovalSchema.safeParse({ ...approval, kind: "future-kind" }).success,
    ).toBe(false);
  });

  test("rejects unknown fields", () => {
    expect(ApprovalSchema.safeParse({ ...approval, typo: true }).success).toBe(
      false,
    );
  });
});

describe("HookEventSchema", () => {
  const events = [
    { kind: "session-start", agentName: "agent-3", timestamp },
    { kind: "session-launch", agentName: "agent-3", timestamp },
    { kind: "session-end", agentName: "agent-3", timestamp },
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

  test("reads positive usage fields and rejects a renamed key", () => {
    const event = {
      kind: "turn-end",
      agentName: "agent-3",
      timestamp,
      usageUnits: 12,
      usageSource: "provider",
    } satisfies HookEvent;
    expect(HookEventSchema.parse(event)).toEqual(event);
    const { usageUnits: _, ...withoutUsage } = event;
    expect(() =>
      HookEventSchema.parse({
        ...withoutUsage,
        usage_units: 12,
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
    expect(() =>
      HandoffSchema.parse({ ...handoff, remaining: "tests" }),
    ).toThrow();
  });
});

describe("ProtocolSessionFactsReportSchema", () => {
  const report = {
    agent: "agent-3",
    model: "claude-opus-5",
    contextWindow: 1_000_000,
    contextPercent: 22,
    observedAt: timestamp,
  };

  test("preserves measured fields and rejects renamed ones", () => {
    expect(ProtocolSessionFactsReportSchema.parse(report)).toEqual(report);
    expect(() =>
      ProtocolSessionFactsReportSchema.parse({
        ...report,
        contextWindow: undefined,
        context_window: 1_000_000,
      }),
    ).toThrow();
    expect(() =>
      ProtocolSessionFactsReportSchema.parse({
        ...report,
        contextPercent: undefined,
        context_used_pct: 22,
      }),
    ).toThrow();
  });
});

describe("RoutingPolicySchema", () => {
  test("accepts one model row and rejects contradictory duplicates", () => {
    const row = {
      provider: "claude" as const,
      model: "claude-opus-4-8",
      state: "enabled" as const,
      effort: { mode: "never-configured" as const },
    };
    const policy = { ...emptyRoutingPolicy(timestamp), models: [row] };
    expect(RoutingPolicySchema.parse(policy)).toEqual(policy);
    expect(() =>
      RoutingPolicySchema.parse({
        ...policy,
        models: [row, { ...row, state: "disabled" }],
      }),
    ).toThrow();
  });
});

describe("root orchestrator naming", () => {
  test("queen is the preferred address; orchestrator remains a synonym", () => {
    expect(ORCHESTRATOR_NAME).toEqual("queen");
    expect(ORCHESTRATOR_NAME_ALIASES).toContain("orchestrator");
    expect(orchestratorRecipientNames()).toEqual(["queen", "orchestrator"]);
    expect(isOrchestratorName("queen")).toBe(true);
    expect(isOrchestratorName("Queen")).toBe(true);
    expect(isOrchestratorName("orchestrator")).toBe(true);
    expect(isOrchestratorName("Orchestrator")).toBe(true);
    expect(isOrchestratorName("ORCHESTRATOR")).toBe(true);
    expect(isOrchestratorName("maya")).toBe(false);
    expect(canonicalOrchestratorName("orchestrator")).toEqual("queen");
    expect(canonicalOrchestratorName("Orchestrator")).toEqual("queen");
    expect(canonicalOrchestratorName("ORCHESTRATOR")).toEqual("queen");
    expect(canonicalOrchestratorName("Queen")).toEqual("queen");
    expect(canonicalOrchestratorName("queen")).toEqual("queen");
    expect(canonicalOrchestratorName("maya")).toEqual("maya");
  });
});
