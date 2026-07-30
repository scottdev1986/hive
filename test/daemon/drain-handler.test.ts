import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import {
  classifyVendorDrainError,
  DrainHandler,
  type ReplacementDrain,
} from "../../src/daemon/drain-handler";
import { drainedWindowFor, QuotaService } from "../../src/daemon/quota";
import { QuotaLedger } from "../../src/daemon/quota-ledger";
import type { QuotaProbe } from "../../src/daemon/quota-sources";
import type { AgentRecord } from "../../src/schemas";
import { QuotaConfigSchema } from "../../src/schemas";

/**
 * The drain handler: hold when a window resets within the hour,
 * handoff when it does not, wait-or-preserve when everything is drained, and
 * vendor rate-limit errors routed to drains instead of the crash quarantine.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

let now = new Date("2026-07-24T12:00:00.000Z");
const at = (minutesFromNow: number) =>
  new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "claude",
    model: "claude-opus-4-8",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build the server",
    worktreePath: "/tmp/worktree",
    branch: "hive/maya-server",
    contextPct: 40,
    createdAt: now.toISOString(),
    lastEventAt: now.toISOString(),
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "hive-drain-test",
      subject: { kind: "agent", agentId: overrides.id ?? "agent-maya" },
      generation: 1,
      sessionId:
        overrides.id === "agent-otto"
          ? "ses_018f1e90-7b5a-7cc0-8000-000000000302"
          : "ses_018f1e90-7b5a-7cc0-8000-000000000301",
      hostKind: "sessiond",
      engineBuildId: "engine-drain-test",
    },
    ...overrides,
  };
}

interface Harness {
  db: HiveDatabase;
  quota: QuotaService;
  sent: Array<{
    from: string;
    to: string;
    body: string;
    idempotencyKey: string | undefined;
  }>;
  paused: string[];
  resumed: string[];
  replacements: Array<{ name: string; drain: ReplacementDrain }>;
  memories: Array<{ agent: string | null; summary: string }>;
  drain: DrainHandler;
}

async function harness(
  pools: Array<{
    provider: QuotaProbe["provider"];
    fiveHourUsed: number;
    weeklyUsed: number;
    fiveHourResetAt?: string | null;
    weeklyResetAt?: string | null;
  }>,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "hive-drain-test-"));
  roots.push(root);
  const db = new HiveDatabase(join(root, "hive.db"));
  const ledger = new QuotaLedger(db);
  const quota = new QuotaService(
    ledger,
    QuotaConfigSchema.parse({ limits: [] }),
    () => now,
    pools.map((pool) => ({
      provider: pool.provider,
      read: async () => ({ status: "ok" as const, pools: [], catalog: [] }),
    })),
  );
  for (const pool of pools) {
    ledger.upsertDiscoveredPool({
      provider: pool.provider,
      account: "default",
      pool: "subscription",
      models: ["*"],
      label: null,
      fiveHourWindowMinutes: 300,
      weeklyWindowMinutes: 10_080,
      fiveHourMeterState: "metered",
      weeklyMeterState: "metered",
      discoveredAt: now.toISOString(),
      source: "provider",
    });
    await quota.observe({
      provider: pool.provider,
      account: "default",
      pool: "subscription",
      fiveHourUsed: pool.fiveHourUsed,
      weeklyUsed: pool.weeklyUsed,
      observedAt: now.toISOString(),
      fiveHourResetAt: pool.fiveHourResetAt ?? null,
      weeklyResetAt: pool.weeklyResetAt ?? null,
      source: "provider",
      confidence: "authoritative",
    });
  }
  const sent: Harness["sent"] = [];
  const paused: string[] = [];
  const resumed: string[] = [];
  const replacements: Harness["replacements"] = [];
  const memories: Harness["memories"] = [];
  const drain = new DrainHandler({
    db,
    quota,
    send: async (from, to, body, options) => {
      if (
        options?.idempotencyKey !== undefined &&
        sent.some(
          (message) => message.idempotencyKey === options.idempotencyKey,
        )
      ) {
        return;
      }
      sent.push({ from, to, body, idempotencyKey: options?.idempotencyKey });
    },
    pauseProvider: async (record) => {
      paused.push(record.name);
      return true;
    },
    resumeProvider: async (record) => {
      resumed.push(record.name);
      return true;
    },
    requestReplacement: async (record, drain) => {
      replacements.push({ name: record.name, drain });
    },
    remember: (event) => memories.push(event),
    clock: () => now,
  });
  return {
    db,
    quota,
    sent,
    paused,
    resumed,
    replacements,
    memories,
    drain,
  };
}

function insertRunningAgent(h: Harness, record: AgentRecord): void {
  h.db.insertAgent(record);
  if (record.status === "failed") return;
  const locator = record.sessionLocator!;
  h.db.insertProviderRun({
    runId:
      record.name === "otto"
        ? "018f1e90-7b5a-7cc0-8000-000000000312"
        : "018f1e90-7b5a-7cc0-8000-000000000311",
    agentId: record.id,
    terminal: locator,
    provider: record.tool,
    model: record.model,
    effort: null,
    conversationId: null,
    pid: record.name === "otto" ? 4_200 : 4_100,
    startToken: record.name === "otto" ? "4200:1" : "4100:1",
    foregroundProcessGroupId: record.name === "otto" ? 4_200 : 4_100,
    capabilityEpoch: record.capabilityEpoch,
    launchGrantId: `grant-${record.name}`,
    startedAt: now.toISOString(),
    endedAt: null,
    state: "running",
    exitReason: null,
  });
}

describe("the drain handler", () => {
  test("§R4: a drain resetting within the hour holds the agent, and the sweep pokes it past the reset", async () => {
    const h = await harness([
      {
        provider: "claude",
        fiveHourUsed: 100,
        weeklyUsed: 40,
        fiveHourResetAt: at(30),
      },
    ]);
    insertRunningAgent(h, agent());

    await h.drain.sweep();
    const held = h.db.getAgentById("agent-maya")!;
    expect(held.status).toBe("held");
    expect(held.holdReason).toContain("subscription");
    expect(held.holdReason).toContain(at(30));
    expect(held.holdResetAt).toBe(at(30));
    expect(h.paused).toEqual(["maya"]);
    expect(h.replacements).toHaveLength(0);

    // The same sweep before the reset does not poke.
    await h.drain.sweep();
    expect(h.sent).toHaveLength(0);

    // Past the reset, the existing sweep tells the agent to continue and
    // clears the hold — but only after exact run and epoch revalidation.
    now = new Date(now.getTime() + 31 * 60_000);
    await h.quota.observe({
      provider: "claude",
      account: "default",
      pool: "subscription",
      fiveHourUsed: 100,
      weeklyUsed: 40,
      observedAt: now.toISOString(),
      fiveHourResetAt: at(60),
      weeklyResetAt: null,
      source: "provider",
      confidence: "authoritative",
    });
    await h.drain.sweep();
    expect(h.resumed).toHaveLength(0);
    await h.quota.observe({
      provider: "claude",
      account: "default",
      pool: "subscription",
      fiveHourUsed: 10,
      weeklyUsed: 40,
      observedAt: now.toISOString(),
      fiveHourResetAt: at(60),
      weeklyResetAt: null,
      source: "provider",
      confidence: "authoritative",
    });
    h.db.upsertAgent({
      ...held,
      holdProviderRunId: "018f1e90-7b5a-7cc0-8000-000000000399",
    });
    await h.drain.sweep();
    expect(h.resumed).toHaveLength(0);
    h.db.upsertAgent({
      ...held,
      capabilityEpoch: 1,
    });
    await h.drain.sweep();
    expect(h.resumed).toHaveLength(0);
    h.db.upsertAgent(held);
    await h.drain.sweep();
    const freed = h.db.getAgentById("agent-maya")!;
    expect(freed.status).toBe("idle");
    expect(freed.holdReason).toBeNull();
    expect(freed.holdResetAt).toBeNull();
    expect(freed.holdProviderRunId).toBeNull();
    expect(h.resumed).toEqual(["maya"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.to).toBe("maya");
    expect(h.sent[0]?.body).toContain("reset");
    expect(h.sent[0]?.idempotencyKey).toBe(
      `quota-resume:${held.id}:${held.holdProviderRunId}:${held.holdResetAt}`,
    );
    await h.drain.sweep();
    expect(h.resumed).toEqual(["maya"]);
    expect(h.sent).toHaveLength(1);
  });

  test("overlapping reset sweeps produce one idempotent wake", async () => {
    const h = await harness([
      {
        provider: "claude",
        fiveHourUsed: 100,
        weeklyUsed: 40,
        fiveHourResetAt: at(30),
      },
    ]);
    insertRunningAgent(h, agent());
    await h.drain.sweep();
    const resetAt = h.db.getAgentById("agent-maya")!.holdResetAt;
    now = new Date(now.getTime() + 31 * 60_000);

    let resumeCalls = 0;
    let release!: () => void;
    const bothResuming = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = (
      h.drain as unknown as {
        deps: {
          resumeProvider: (record: AgentRecord) => Promise<boolean>;
        };
      }
    ).deps;
    deps.resumeProvider = async (record) => {
      h.resumed.push(record.name);
      resumeCalls += 1;
      if (resumeCalls === 2) release();
      await bothResuming;
      return true;
    };

    await Promise.all([h.drain.sweep(), h.drain.sweep()]);
    expect(resumeCalls).toBe(2);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.idempotencyKey).toBe(
      `quota-resume:agent-maya:018f1e90-7b5a-7cc0-8000-000000000311:${resetAt}`,
    );
  });

  test("§R5 seam: a distant reset freezes the source without destroying its terminal or worktree", async () => {
    const h = await harness([
      {
        provider: "claude",
        fiveHourUsed: 100,
        weeklyUsed: 40,
        fiveHourResetAt: at(180),
      },
      {
        provider: "codex",
        fiveHourUsed: 10,
        weeklyUsed: 20,
        fiveHourResetAt: at(200),
      },
    ]);
    insertRunningAgent(h, agent());

    await h.drain.sweep();
    // Freezing the source belongs to the seam, which pauses the exact run it
    // fenced; the handler does not pause on its way there.
    expect(h.paused).toEqual([]);
    expect(h.replacements).toEqual([
      {
        name: "maya",
        drain: {
          provider: "claude",
          pool: "subscription",
          resetsAt: at(180),
          reason: expect.stringContaining("spent"),
        },
      },
    ]);
    expect(h.db.getAgentById("agent-maya")).toMatchObject({
      worktreePath: "/tmp/worktree",
      branch: "hive/maya-server",
    });
  });

  test("a drain with no reset to wait for never leaves the agent held", async () => {
    const h = await harness([
      {
        provider: "claude",
        fiveHourUsed: 100,
        weeklyUsed: 40,
        fiveHourResetAt: at(180),
      },
      {
        provider: "codex",
        fiveHourUsed: 10,
        weeklyUsed: 20,
        fiveHourResetAt: at(200),
      },
    ]);
    insertRunningAgent(h, agent());

    await h.drain.sweep();
    // A `held` row with a null reset is a state the sweep's resume can never
    // act on: the agent would wait for a poke that cannot arrive. The seam
    // reports this agent instead of holding it.
    const row = h.db.getAgentById("agent-maya")!;
    expect({
      status: row.status,
      holdResetAt: row.holdResetAt ?? null,
    }).not.toEqual({ status: "held", holdResetAt: null });
    expect(h.replacements).toHaveLength(1);
  });

  test("§R6: when everything is drained, the agent waits for the nearest five-hour reset", async () => {
    const h = await harness([
      {
        provider: "claude",
        fiveHourUsed: 100,
        weeklyUsed: 100,
        fiveHourResetAt: at(240),
      },
      { provider: "codex", fiveHourUsed: 100, weeklyUsed: 100 },
      { provider: "grok", fiveHourUsed: 100, weeklyUsed: 100 },
      { provider: "kimi", fiveHourUsed: 100, weeklyUsed: 100 },
    ]);
    insertRunningAgent(h, agent());
    // The only unmetered route has errored too.
    const opencodeAgent = agent({
      id: "agent-otto",
      name: "otto",
      tool: "opencode",
      status: "failed",
      failedAt: now.toISOString(),
    });
    insertRunningAgent(h, opencodeAgent);
    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");

    expect(h.paused).toEqual(["maya"]);
    const held = h.db.getAgentById("agent-maya")!;
    expect(held.status).toBe("held");
    expect(held.holdReason).toContain("every provider is out of usage");
    expect(held.holdResetAt).toBe(at(240));
  });

  test("§R6: no near reset anywhere preserves the branch and writes the memory", async () => {
    const h = await harness([
      {
        provider: "claude",
        fiveHourUsed: 100,
        weeklyUsed: 100,
        fiveHourResetAt: null,
        weeklyResetAt: at(2 * 24 * 60),
      },
      { provider: "codex", fiveHourUsed: 100, weeklyUsed: 100 },
      { provider: "grok", fiveHourUsed: 100, weeklyUsed: 100 },
      { provider: "kimi", fiveHourUsed: 100, weeklyUsed: 100 },
    ]);
    insertRunningAgent(h, agent());
    const opencodeAgent = agent({
      id: "agent-otto",
      name: "otto",
      tool: "opencode",
      status: "failed",
      failedAt: now.toISOString(),
    });
    insertRunningAgent(h, opencodeAgent);
    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");

    // Both the errored (already down) agent and the still-live one are retained
    // with a memory each; building the replacement is not this handler's job.
    expect(h.memories).toHaveLength(2);
    expect(h.memories[0]?.summary).toContain("hive/maya-server");
    expect(h.memories[0]?.summary).toContain(
      "Resume it when any provider's usage returns",
    );
    expect(h.paused).toEqual([]);
    const retained = h.db.getAgentById("agent-maya")!;
    expect({
      status: retained.status,
      holdResetAt: retained.holdResetAt ?? null,
    }).not.toEqual({ status: "held", holdResetAt: null });
    expect(retained).toMatchObject({
      worktreePath: "/tmp/worktree",
      branch: "hive/maya-server",
    });
  });

  test("an unmetered provider's drain is never held — a rate-limit error hands off directly", async () => {
    const h = await harness([
      {
        provider: "codex",
        fiveHourUsed: 10,
        weeklyUsed: 20,
        fiveHourResetAt: at(200),
      },
    ]);
    const opencodeAgent = agent({
      id: "agent-otto",
      name: "otto",
      tool: "opencode",
      status: "failed",
      failedAt: now.toISOString(),
    });
    insertRunningAgent(h, opencodeAgent);

    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");
    expect(h.db.getAgentById("agent-otto")!.status).toBe("failed");
    // The agent is already terminal, so its work is retained and the
    // replacement seam is reported without inventing a handoff for it.
    expect(h.replacements).toHaveLength(1);
    expect(h.replacements[0]?.drain).toEqual({
      provider: "opencode",
      pool: null,
      resetsAt: null,
      reason: "a opencode rate-limit error: 429 Too Many Requests",
    });

    // A live start on the provider clears its drain error record.
    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");
    h.drain.noteProviderAlive("opencode");
    expect(h.replacements).toHaveLength(2);
  });

  test("a metered-but-undrained provider is not touched", async () => {
    const h = await harness([
      {
        provider: "claude",
        fiveHourUsed: 40,
        weeklyUsed: 60,
        fiveHourResetAt: at(30),
      },
    ]);
    insertRunningAgent(h, agent());
    await h.drain.sweep();
    expect(h.db.getAgentById("agent-maya")!.status).toBe("working");
    expect(h.paused).toHaveLength(0);
    expect(h.replacements).toHaveLength(0);
  });
});

describe("the vendor-error classifier", () => {
  test("rate-limit and billing text is a drain, per vendor", () => {
    expect(classifyVendorDrainError("claude", "429 rate_limit_error")).toBe(
      true,
    );
    expect(
      classifyVendorDrainError("claude", "Credit balance is too low"),
    ).toBe(true);
    expect(
      classifyVendorDrainError("codex", "Rate limit reached for gpt-5.6-sol"),
    ).toBe(true);
    expect(
      classifyVendorDrainError("kimi", "provider.rate_limit: quota exceeded"),
    ).toBe(true);
    expect(
      classifyVendorDrainError("grok", "quota exceeded for this account"),
    ).toBe(true);
    expect(
      classifyVendorDrainError("opencode", "429: rate limit exceeded"),
    ).toBe(true);
  });

  test("a crash is never a drain — it stays with the quarantine", () => {
    expect(classifyVendorDrainError("claude", "command not found")).toBe(false);
    expect(
      classifyVendorDrainError("codex", "process exited with status 1"),
    ).toBe(false);
    expect(
      classifyVendorDrainError("opencode", "Error: ENOENT no such file"),
    ).toBe(false);
    expect(classifyVendorDrainError("kimi", "connection refused")).toBe(false);
  });
});

describe("the R7 estimate boundary (drainedWindowFor)", () => {
  const windowStatus = (
    availability: "available" | "not-metered" | "unknown",
    remainingPct: number | null,
    resetsAt: string | null = null,
  ) => ({
    availability,
    unit: "percent" as const,
    allowance: availability === "available" ? 100 : null,
    used: availability === "available" ? 100 : null,
    reserved: null,
    reservedIsEstimate: null,
    remaining: availability === "available" ? 0 : null,
    remainingPct,
    resetsAt,
    confidence: "reported" as const,
    source: "provider" as const,
    observedAt: now.toISOString(),
    windowMinutes: 300,
  });

  test("a measured window at zero drains, an unknown or unmetered one never does", () => {
    const status = {
      provider: "claude" as const,
      account: "default",
      pool: "subscription",
      origin: "discovered" as const,
      overridesDiscovered: false,
      models: ["*"],
      label: null,
      routable: true,
      confidence: "reported" as const,
      freshness: "stale" as const,
      source: "provider" as const,
      fiveHour: windowStatus("available", 0, at(30)),
      weekly: windowStatus("unknown", null),
    };
    // A stale-but-measured window is an estimate the drain handler may use — and
    // an unknown window still cannot read as empty.
    expect(drainedWindowFor([status])).toEqual({
      pool: "subscription",
      window: "fiveHour",
      resetsAt: at(30),
    });
    expect(
      drainedWindowFor([
        {
          ...status,
          fiveHour: windowStatus("unknown", null),
          weekly: windowStatus("not-metered", null),
        },
      ]),
    ).toBeNull();
  });
});
