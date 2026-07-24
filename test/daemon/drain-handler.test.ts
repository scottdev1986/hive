import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord, CapabilityProvider } from "../../src/schemas";
import { QuotaConfigSchema } from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import { QuotaLedger } from "../../src/daemon/quota-ledger";
import { QuotaService } from "../../src/daemon/quota";
import { drainedWindowFor } from "../../src/daemon/quota";
import type { QuotaProbe } from "../../src/daemon/quota-sources";
import {
  classifyVendorDrainError,
  DrainHandler,
} from "../../src/daemon/drain-handler";
import type { SpawnRequest } from "../../src/daemon/spawner";

/**
 * The drain handler (§R4–R7): hold when a window resets within the hour,
 * handoff when it does not, wait-or-preserve when everything is drained, and
 * vendor rate-limit errors routed to drains instead of the crash quarantine.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
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
    ...overrides,
  };
}

interface Harness {
  db: HiveDatabase;
  quota: QuotaService;
  sent: Array<{ from: string; to: string; body: string }>;
  closed: Array<{ name: string; reason: string }>;
  spawned: SpawnRequest[];
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
  const closed: Harness["closed"] = [];
  const spawned: SpawnRequest[] = [];
  const memories: Harness["memories"] = [];
  const drain = new DrainHandler({
    db,
    quota,
    send: async (from, to, body) => {
      sent.push({ from, to, body });
    },
    closeAgent: async (record, reason) => {
      closed.push({ name: record.name, reason });
      return { preserved: { branch: record.branch ?? "", ref: "refs/hive/preserved/x" } };
    },
    spawn: async (request) => {
      spawned.push(request);
      return agent();
    },
    remember: (event) => memories.push(event),
    clock: () => now,
  });
  return { db, quota, sent, closed, spawned, memories, drain };
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
    h.db.insertAgent(agent());

    await h.drain.sweep();
    const held = h.db.getAgentById("agent-maya")!;
    expect(held.status).toBe("held");
    expect(held.holdReason).toContain("subscription");
    expect(held.holdReason).toContain(at(30));
    expect(held.holdResetAt).toBe(at(30));
    expect(h.closed).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);

    // The same sweep before the reset does not poke.
    await h.drain.sweep();
    expect(h.sent).toHaveLength(0);

    // Past the reset, the existing sweep tells the agent to continue and
    // clears the hold — no new timers.
    now = new Date(now.getTime() + 31 * 60_000);
    await h.drain.sweep();
    const freed = h.db.getAgentById("agent-maya")!;
    expect(freed.status).toBe("idle");
    expect(freed.holdReason).toBeNull();
    expect(freed.holdResetAt).toBeNull();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.to).toBe("maya");
    expect(h.sent[0]?.body).toContain("reset");
  });

  test("§R5: a drain resetting further out closes the drained agent and respawns the branch elsewhere", async () => {
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
    h.db.insertAgent(agent());

    await h.drain.sweep();
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]?.name).toBe("maya");
    expect(h.closed[0]?.reason).toContain("spent");
    expect(h.spawned).toHaveLength(1);
    const request = h.spawned[0]!;
    expect(request.task).toContain("hive/maya-server");
    expect(request.task).toContain("continues maya's work");
    expect(request.tool).toBe("codex");
    expect(request.category).toBe("simple_coding");
    expect(h.db.getAgentById("agent-maya")!.status).not.toBe("held");
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
    h.db.insertAgent(agent());
    // The only unmetered route has errored too.
    const opencodeAgent = agent({ id: "agent-otto", name: "otto", tool: "opencode", status: "failed", failedAt: now.toISOString() });
    h.db.insertAgent(opencodeAgent);
    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");

    expect(h.spawned).toHaveLength(0);
    expect(h.closed).toHaveLength(0);
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
    h.db.insertAgent(agent());
    const opencodeAgent = agent({ id: "agent-otto", name: "otto", tool: "opencode", status: "failed", failedAt: now.toISOString() });
    h.db.insertAgent(opencodeAgent);
    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");

    expect(h.spawned).toHaveLength(0);
    // Both the errored (already down) agent and the still-live one are
    // preserved with a memory each.
    expect(h.memories).toHaveLength(2);
    expect(h.memories[0]?.summary).toContain("hive/maya-server");
    expect(h.memories[0]?.summary).toContain("Resume it when any provider's usage returns");
    expect(h.closed.map((entry) => entry.name)).toEqual(["maya"]);
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
    const opencodeAgent = agent({ id: "agent-otto", name: "otto", tool: "opencode", status: "failed", failedAt: now.toISOString() });
    h.db.insertAgent(opencodeAgent);

    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");
    expect(h.db.getAgentById("agent-otto")!.status).toBe("failed");
    // The agent was already terminal: nothing closes it twice, and the
    // replacement goes to a metered provider with room.
    expect(h.closed).toHaveLength(0);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.tool).toBe("codex");

    // A live start on the provider clears its drain error record.
    await h.drain.onVendorError(opencodeAgent, "429 Too Many Requests");
    h.drain.noteProviderAlive("opencode");
    expect(h.spawned).toHaveLength(2);
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
    h.db.insertAgent(agent());
    await h.drain.sweep();
    expect(h.db.getAgentById("agent-maya")!.status).toBe("working");
    expect(h.closed).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
  });
});

describe("the vendor-error classifier", () => {
  test("rate-limit and billing text is a drain, per vendor", () => {
    expect(classifyVendorDrainError("claude", "429 rate_limit_error")).toBe(true);
    expect(classifyVendorDrainError("claude", "Credit balance is too low")).toBe(true);
    expect(classifyVendorDrainError("codex", "Rate limit reached for gpt-5.6-sol")).toBe(true);
    expect(classifyVendorDrainError("kimi", "provider.rate_limit: quota exceeded")).toBe(true);
    expect(classifyVendorDrainError("grok", "quota exceeded for this account")).toBe(true);
    expect(classifyVendorDrainError("opencode", "429: rate limit exceeded")).toBe(true);
  });

  test("a crash is never a drain — it stays with the quarantine", () => {
    expect(classifyVendorDrainError("claude", "command not found")).toBe(false);
    expect(classifyVendorDrainError("codex", "process exited with status 1")).toBe(false);
    expect(classifyVendorDrainError("opencode", "Error: ENOENT no such file")).toBe(false);
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
    // §R7: the stale-but-measured window is the estimate the drain handler
    // may use — and an unknown window still cannot read as empty.
    expect(drainedWindowFor([status])).toEqual({
      pool: "subscription",
      window: "fiveHour",
      resetsAt: at(30),
    });
    expect(
      drainedWindowFor([{
        ...status,
        fiveHour: windowStatus("unknown", null),
        weekly: windowStatus("not-metered", null),
      }]),
    ).toBeNull();
  });
});
