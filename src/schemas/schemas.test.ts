import { describe, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  AgentRecordSchema,
  HandoffSchema,
  HiveConfigSchema,
  HookEventSchema,
  ORCHESTRATOR_NAME,
  ORCHESTRATOR_NAME_ALIASES,
  QuotaConfigSchema,
  RoutingPolicySchema,
  StatuslineReportSchema,
  attestationStateOf,
  canonicalOrchestratorName,
  compareObservedIdentity,
  isOrchestratorName,
  orchestratorRecipientNames,
  type AgentRecord,
  type AgentMessage,
  type HookEvent,
  emptyRoutingPolicy,
} from ".";

const timestamp = "2026-07-09T12:00:00.000Z";

const roundTrip = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

describe("HiveConfigSchema", () => {
  test("parses a valid round-trip", () => {
    const parsed = HiveConfigSchema.parse({});
    expect(HiveConfigSchema.parse(roundTrip(parsed))).toEqual({
      codex: { driver: "tui" },
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
    expect(() => HiveConfigSchema.parse({ terminal: "auto" })).toThrow();
    expect(() => HiveConfigSchema.parse({ headless: true })).toThrow();
    expect(() => HiveConfigSchema.parse({ layout: "auto" })).toThrow();
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
    readOnly: true,
    writeRevoked: false,
  } satisfies AgentRecord;

  test("parses a valid round-trip", () => {
    const parsed = AgentRecordSchema.parse(agent);
    expect(AgentRecordSchema.parse(roundTrip(parsed))).toEqual(agent);
  });

  test("rejects an invalid agent", () => {
    expect(() => AgentRecordSchema.parse({ ...agent, contextPct: 101 })).toThrow();
  });

  test("a misspelled safety field cannot fall through to its default", () => {
    expect(AgentRecordSchema.parse({ ...agent, readOnly: true }).readOnly).toBe(true);
    expect(() => AgentRecordSchema.parse({
      ...agent,
      readOnly: undefined,
      readonly: true,
    })).toThrow();
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

  test("rejects retired external-viewer state", () => {
    const retiredViewerState = ["terminal", "Handle"].join("");
    expect(() => AgentRecordSchema.parse({
      ...agent,
      [retiredViewerState]: { app: "external", sessionId: "session-uuid" },
    })).toThrow();
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
    expect(() => AgentMessageSchema.parse({
      ...message,
      priority: undefined,
      priorty: "critical",
    })).toThrow();
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
    expect(() => HookEventSchema.parse({
      ...withoutUsage,
      usage_units: 12,
    })).toThrow();
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

describe("StatuslineReportSchema", () => {
  const report = {
    agent: "agent-3",
    fiveHour: { usedPct: 37, resetsAt: timestamp },
    contextWindow: 1_000_000,
    contextUsedPct: 22,
    observedAt: timestamp,
  };

  test("preserves measured fields and rejects renamed ones", () => {
    expect(StatuslineReportSchema.parse(report)).toEqual(report);
    expect(() => StatuslineReportSchema.parse({
      ...report,
      contextWindow: undefined,
      context_window: 1_000_000,
    })).toThrow();
    expect(() => StatuslineReportSchema.parse({
      ...report,
      fiveHour: { usedPct: 37, resetsAt: undefined, resets_at: timestamp },
    })).toThrow();
  });
});

describe("QuotaConfigSchema", () => {
  test("migrates one legacy estimate key but rejects competing old and new keys", () => {
    expect(QuotaConfigSchema.parse({ estimates: { deep: 17 } })
      .estimates.complex_coding).toBe(17);
    expect(() => QuotaConfigSchema.parse({
      estimates: { deep: 17, complex_coding: 19 },
    })).toThrow();
    expect(() => QuotaConfigSchema.parse({
      estimatesPct: {
        deep: { fiveHour: 8, weekly: 1.5 },
        complex_coding: { fiveHour: 9, weekly: 2 },
      },
    })).toThrow();
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
    expect(() => RoutingPolicySchema.parse({
      ...policy,
      models: [row, { ...row, state: "disabled" }],
    })).toThrow();
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

describe("execution-identity attestation", () => {
  test("matching requires both model and effort to equal the launch identity", () => {
    const launch = { model: "gpt-5.6-sol", effort: "xhigh" };
    expect(
      compareObservedIdentity(launch, { model: "gpt-5.6-sol", effort: "xhigh" }),
    ).toEqual("matching");
    // Wrong model.
    expect(
      compareObservedIdentity(launch, { model: "gpt-5.6-luna", effort: "xhigh" }),
    ).toEqual("drift");
    // Right model, wrong effort — the exact Sam incident (Sol/xhigh -> Luna/low
    // would drift on model, but even a same-model effort change must drift).
    expect(
      compareObservedIdentity(launch, { model: "gpt-5.6-sol", effort: "low" }),
    ).toEqual("drift");
  });

  test("attestationStateOf reads an absent verdict as fail-closed unattested", () => {
    expect(attestationStateOf({ identityState: undefined })).toEqual(
      "unattested",
    );
    expect(attestationStateOf({ identityState: "matching" })).toEqual(
      "matching",
    );
    expect(attestationStateOf({ identityState: "drift" })).toEqual("drift");
  });

});
