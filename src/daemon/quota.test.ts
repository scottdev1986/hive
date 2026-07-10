import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QuotaConfigSchema,
  type QuotaConfig,
  type QuotaLimit,
} from "../schemas";
import { HiveDatabase } from "./db";
import type { TmuxSender } from "./delivery";
import { HiveDaemon } from "./server";
import { QuotaLedger } from "./quota-ledger";
import {
  calendarWeekBounds,
  QuotaExhaustedError,
  QuotaService,
} from "./quota";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function limit(
  provider: "claude" | "codex",
  allowance = 100,
  overrides: Partial<QuotaLimit> = {},
): QuotaLimit {
  return {
    provider,
    account: "personal",
    pool: `${provider}-premium`,
    models: [`${provider}-model`],
    fiveHourAllowance: allowance,
    weeklyAllowance: allowance * 10,
    weeklyWindow: "rolling",
    timezone: "UTC",
    resetWeekday: 1,
    resetHour: 0,
    resetMinute: 0,
    observationMaxAgeMinutes: 60,
    ...overrides,
  };
}

function config(
  limits: QuotaLimit[],
  overrides: Partial<QuotaConfig> = {},
): QuotaConfig {
  return QuotaConfigSchema.parse({
    limits,
    reserveFiveHourPct: 0,
    reserveWeeklyPct: 0,
    estimates: { deep: 20, standard: 10, cheap: 4, review: 8 },
    ...overrides,
  });
}

async function fileDatabase(name: string): Promise<{
  root: string;
  path: string;
  db: HiveDatabase;
}> {
  const root = await mkdtemp(join(tmpdir(), `hive-quota-${name}-`));
  roots.push(root);
  const path = join(root, "hive.db");
  return { root, path, db: new HiveDatabase(path) };
}

function candidates() {
  return [
    { tool: "claude" as const, model: "claude-model" },
    { tool: "codex" as const, model: "codex-model" },
  ];
}

describe("quota windows", () => {
  test("uses timezone-aware calendar week boundaries across UTC offsets", () => {
    const bounds = calendarWeekBounds(
      new Date("2026-07-09T12:00:00.000Z"),
      limit("claude", 100, {
        weeklyWindow: "calendar",
        timezone: "America/New_York",
        resetWeekday: 1,
        resetHour: 0,
      }),
    );
    expect(bounds).toEqual({
      start: "2026-07-06T04:00:00.000Z",
      end: "2026-07-13T04:00:00.000Z",
    });
  });

  test("moves a nonexistent daylight-saving reset minute to the first valid local minute", () => {
    const bounds = calendarWeekBounds(
      new Date("2026-03-10T12:00:00.000Z"),
      limit("claude", 100, {
        weeklyWindow: "calendar",
        timezone: "America/New_York",
        resetWeekday: 0,
        resetHour: 2,
        resetMinute: 30,
      }),
    );
    expect(bounds.start).toEqual("2026-03-08T07:00:00.000Z");
  });

  test("includes the exact rolling boundary and expires it just after", async () => {
    const { db } = await fileDatabase("boundary");
    const ledger = new QuotaLedger(db);
    const reservation = ledger.insertUnboundedReservation({
      id: "old-run",
      agentName: "maya",
      provider: "claude",
      account: "personal",
      pool: "claude-premium",
      model: "claude-model",
      tier: "standard",
      estimatedUnits: 10,
      now: "2026-07-09T07:00:00.000Z",
      expiresAt: "2026-07-10T00:00:00.000Z",
    });
    ledger.reconcile(
      reservation.id,
      10,
      "estimated",
      "2026-07-09T07:00:00.000Z",
    );
    let now = new Date("2026-07-09T12:00:00.000Z");
    const service = new QuotaService(
      ledger,
      config([limit("claude")]),
      () => now,
    );
    const exact = service.statuses()[0];
    expect(exact && !("configured" in exact) && exact.fiveHour.used).toEqual(10);
    now = new Date("2026-07-09T12:00:00.001Z");
    const after = service.statuses()[0];
    expect(after && !("configured" in after) && after.fiveHour.used).toEqual(0);
    db.close();
  });
});

describe("quota persistence and reservations", () => {
  test("migrates legacy reservation ledgers without control-run columns", async () => {
    const { db } = await fileDatabase("legacy-control-columns");
    db.database.exec(`
      CREATE TABLE quota_reservations (
        id TEXT PRIMARY KEY,
        agentName TEXT NOT NULL,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        pool TEXT NOT NULL,
        model TEXT NOT NULL,
        tier TEXT NOT NULL,
        estimatedUnits REAL NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        startedAt TEXT,
        reconciledAt TEXT,
        actualUnits REAL,
        source TEXT
      )
    `);
    new QuotaLedger(db);
    const columns = new Set(
      (db.database.query("PRAGMA table_info(quota_reservations)").all() as Array<{
        name: string;
      }>).map((column) => column.name),
    );
    expect(columns.has("purpose")).toEqual(true);
    expect(columns.has("controlMessageId")).toEqual(true);
    db.close();
  });

  test("atomically prevents two database connections from reserving the same headroom", async () => {
    const { path, db } = await fileDatabase("concurrency");
    const secondDb = new HiveDatabase(path);
    const quotaConfig = config([
      limit("claude", 15, { weeklyAllowance: 100 }),
    ]);
    const now = () => new Date("2026-07-09T12:00:00.000Z");
    const services = [
      new QuotaService(new QuotaLedger(db), quotaConfig, now),
      new QuotaService(new QuotaLedger(secondDb), quotaConfig, now),
    ];
    const results = await Promise.allSettled(services.map((service, index) =>
      service.routeAndReserve({
        agentName: index === 0 ? "maya" : "sam",
        tier: "standard",
        preferredTool: "claude",
        explicitTool: "claude",
        candidates: candidates(),
      })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    secondDb.close();
    db.close();
  });

  test("gives a control restart its own idempotent reservation without double-counting the interrupted run", async () => {
    const { path, db } = await fileDatabase("control-reservation");
    const quotaConfig = config([
      limit("codex", 30, { weeklyAllowance: 300 }),
    ]);
    const now = () => new Date("2026-07-09T12:00:00.000Z");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(ledger, quotaConfig, now);
    const original = await service.routeAndReserve({
      agentName: "maya",
      tier: "standard",
      preferredTool: "codex",
      explicitTool: "codex",
      candidates: candidates(),
    });
    service.markStarted(original.reservation.id);
    await service.cancel(original.reservation.id);

    const control = await service.reserveControlRun({
      agentName: "maya",
      tier: "standard",
      tool: "codex",
      model: "codex-model",
      controlMessageId: "control-1",
    });
    expect(control).toMatchObject({
      purpose: "control",
      controlMessageId: "control-1",
      status: "active",
    });
    expect(ledger.getReservation(original.reservation.id)).toMatchObject({
      status: "reconciled",
      actualUnits: 10,
    });
    const status = service.statuses()[0];
    expect(status).toMatchObject({
      fiveHour: { used: 10, reserved: 10, remaining: 10 },
      weekly: { used: 10, reserved: 10, remaining: 280 },
    });

    db.close();
    const restartedDb = new HiveDatabase(path);
    const restarted = new QuotaService(
      new QuotaLedger(restartedDb),
      quotaConfig,
      now,
    );
    const recovered = await restarted.reserveControlRun({
      agentName: "maya",
      tier: "standard",
      tool: "codex",
      model: "codex-model",
      controlMessageId: "control-1",
    });
    expect(recovered.id).toEqual(control.id);
    restartedDb.close();
  });

  test("atomically prevents concurrent control restarts from overcommitting headroom", async () => {
    const { path, db } = await fileDatabase("control-concurrency");
    const secondDb = new HiveDatabase(path);
    const quotaConfig = config([
      limit("claude", 15, { weeklyAllowance: 100 }),
    ]);
    const now = () => new Date("2026-07-09T12:00:00.000Z");
    const services = [
      new QuotaService(new QuotaLedger(db), quotaConfig, now),
      new QuotaService(new QuotaLedger(secondDb), quotaConfig, now),
    ];
    const results = await Promise.allSettled(services.map((service, index) =>
      service.reserveControlRun({
        agentName: index === 0 ? "maya" : "sam",
        tier: "standard",
        tool: "claude",
        model: "claude-model",
        controlMessageId: `control-${index}`,
      })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      QuotaExhaustedError,
    );
    secondDb.close();
    db.close();
  });

  test("persists reconciliation, releases unstarted cancellations, and conservatively recovers started reservations", async () => {
    const { path, db } = await fileDatabase("recovery");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(
      ledger,
      config([limit("claude")], { reservationTtlMinutes: 1 }),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const unstarted = await service.routeAndReserve({
      agentName: "maya",
      tier: "standard",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: candidates(),
    });
    await service.cancel(unstarted.reservation.id);
    expect(ledger.getReservation(unstarted.reservation.id)?.status).toEqual(
      "released",
    );

    const started = await service.routeAndReserve({
      agentName: "sam",
      tier: "standard",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: candidates(),
    });
    service.markStarted(started.reservation.id);
    db.close();

    const restartedDb = new HiveDatabase(path);
    const restartedLedger = new QuotaLedger(restartedDb);
    const restarted = new QuotaService(
      restartedLedger,
      service.config,
      () => new Date("2026-07-09T12:02:00.000Z"),
    );
    expect(await restarted.recoverExpired()).toEqual(1);
    expect(restartedLedger.getReservation(started.reservation.id)).toMatchObject({
      status: "reconciled",
      actualUnits: 10,
      source: "estimated",
    });
    restartedDb.close();
  });

  test("reconciles a lifecycle turn with reported usage and remains idempotent", async () => {
    const { db } = await fileDatabase("lifecycle");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(
      ledger,
      config([limit("claude")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const decision = await service.routeAndReserve({
      agentName: "maya",
      tier: "standard",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: candidates(),
    });
    db.insertAgent({
      id: "maya-id",
      name: "maya",
      tool: "claude",
      model: "claude-model",
      tier: "standard",
      status: "spawning",
      taskDescription: "test",
      worktreePath: "/tmp/maya",
      branch: "hive/maya-test",
      tmuxSession: "hive-maya",
      contextPct: 0,
      quotaReservationId: decision.reservation.id,
      createdAt: "2026-07-09T12:00:00.000Z",
      lastEventAt: "2026-07-09T12:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      writeRevoked: false,
      channelsEnabled: false,
    });
    const daemon = new HiveDaemon({
      db,
      spawner: { async spawn() { throw new Error("unused"); } },
      tmuxSender: { async sendMessage() {} },
      quota: service,
    });
    await daemon.processEvent({
      kind: "session-start",
      agentName: "maya",
      timestamp: "2026-07-09T12:00:01.000Z",
    });
    await daemon.processEvent({
      kind: "turn-end",
      agentName: "maya",
      timestamp: "2026-07-09T12:01:00.000Z",
      usageUnits: 7,
      usageSource: "gateway",
    });
    await daemon.processEvent({
      kind: "turn-end",
      agentName: "maya",
      timestamp: "2026-07-09T12:02:00.000Z",
      usageUnits: 99,
      usageSource: "gateway",
    });
    expect(ledger.getReservation(decision.reservation.id)).toMatchObject({
      status: "reconciled",
      actualUnits: 7,
      source: "gateway",
    });
    db.close();
  });
});

describe("quota-aware routing", () => {
  test("chooses the candidate with the strongest worst-window headroom", async () => {
    const { db } = await fileDatabase("routing");
    const ledger = new QuotaLedger(db);
    const now = new Date("2026-07-09T12:00:00.000Z");
    const service = new QuotaService(
      ledger,
      config([limit("claude", 100), limit("codex", 200)]),
      () => now,
    );
    const decision = await service.routeAndReserve({
      agentName: "maya",
      tier: "deep",
      preferredTool: "claude",
      candidates: candidates(),
    });
    expect(decision.tool).toEqual("codex");
    db.close();
  });

  test("preserves deep capacity for cheap work and recommends a verified cross-vendor fallback for an unsafe explicit choice", async () => {
    const { db } = await fileDatabase("explicit");
    const service = new QuotaService(
      new QuotaLedger(db),
      config(
        [limit("claude", 6), limit("codex", 100)],
        { reserveFiveHourPct: 0.5, reserveWeeklyPct: 0.5 },
      ),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    let error: unknown;
    try {
      await service.routeAndReserve({
        agentName: "maya",
        tier: "cheap",
        preferredTool: "claude",
        explicitTool: "claude",
        candidates: candidates(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).fallback).toEqual({
      tool: "codex",
      model: "codex-model",
    });
    expect((error as Error).message).toContain("Recommended fallback");
    db.close();
  });

  test("routes review to the other vendor when quota is equally healthy", async () => {
    const { db } = await fileDatabase("review");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude"), limit("codex")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const decision = await service.routeAndReserve({
      agentName: "maya",
      tier: "review",
      preferredTool: "claude",
      reviewOfTool: "claude",
      candidates: candidates(),
    });
    expect(decision.tool).toEqual("codex");
    db.close();
  });

  test("keeps legacy routing with explicit missing-confidence diagnostics when no limits are configured", async () => {
    const { db } = await fileDatabase("missing");
    const alerts: string[] = [];
    const service = new QuotaService(
      new QuotaLedger(db),
      config([]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    service.setAlertSink(async (body) => {
      alerts.push(body);
    });
    const first = await service.routeAndReserve({
      agentName: "maya",
      tier: "standard",
      preferredTool: "codex",
      candidates: candidates(),
    });
    await service.cancel(first.reservation.id);
    await service.routeAndReserve({
      agentName: "sam",
      tier: "standard",
      preferredTool: "codex",
      candidates: candidates(),
    });
    expect(first.tool).toEqual("codex");
    expect(first.status).toMatchObject({ configured: false, confidence: "missing" });
    expect(alerts).toHaveLength(1);
    db.close();
  });
});

describe("quota telemetry and alerts", () => {
  test("records Codex app-server windows as authoritative configured-pool observations", async () => {
    const { db } = await fileDatabase("codex-app-server");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(
      ledger,
      config([limit("codex", 200, {
        pool: "codex",
        weeklyAllowance: 1_000,
      })]),
      () => new Date("2026-07-10T12:00:00.000Z"),
    );
    const reading = await service.observeCodexRateLimits("codex-model", {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 40,
          windowDurationMins: 10_080,
          resetsAt: 1_800_500_000,
        },
      },
    });
    expect(reading).toEqual({ fiveHourUsed: 50, weeklyUsed: 400 });
    expect(ledger.getObservation({
      provider: "codex",
      account: "personal",
      pool: "codex",
    })).toMatchObject({
      fiveHourUsed: 50,
      weeklyUsed: 400,
      source: "provider",
      confidence: "authoritative",
    });
    expect(service.statuses()[0]).toMatchObject({
      confidence: "authoritative",
      freshness: "fresh",
      source: "provider",
    });
    db.close();
  });

  test("does not invent an authoritative weekly value from a partial Codex snapshot", async () => {
    const { db } = await fileDatabase("codex-partial");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(
      ledger,
      config([limit("codex")]),
      () => new Date("2026-07-10T12:00:00.000Z"),
    );
    expect(await service.observeCodexRateLimits("codex-model", {
      rateLimits: {
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
      },
    })).toEqual(null);
    expect(ledger.getObservation(limit("codex"))).toEqual(null);
    db.close();
  });

  test("fails closed before reservation when persisted telemetry is corrupt", async () => {
    const { db } = await fileDatabase("corrupt");
    const ledger = new QuotaLedger(db);
    db.database.query(`
      INSERT INTO quota_observations (
        provider, account, pool, fiveHourUsed, weeklyUsed, observedAt,
        fiveHourResetAt, weeklyResetAt, source, confidence
      ) VALUES ('claude', 'personal', 'claude-premium', 10, 10,
        'not-a-date', NULL, NULL, 'manual', 'reported')
    `).run();
    const service = new QuotaService(
      ledger,
      config([limit("claude")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    await expect(service.routeAndReserve({
      agentName: "maya",
      tier: "standard",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: candidates(),
    })).rejects.toThrow("Corrupt quota observation");
    expect(ledger.getActiveReservationForAgent("maya")).toEqual(null);
    db.close();
  });

  test("delivers threshold alerts through the durable orchestrator message path", async () => {
    const { db } = await fileDatabase("alert-delivery");
    const sender: TmuxSender & { calls: string[] } = {
      calls: [],
      async sendMessage(_session, text) {
        this.calls.push(text);
      },
    };
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude", 20, { weeklyAllowance: 1_000 })], {
        estimates: { deep: 20, standard: 10, cheap: 4, review: 8 },
      }),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    new HiveDaemon({
      db,
      spawner: { async spawn() { throw new Error("unused"); } },
      tmuxSender: sender,
      quota: service,
    });
    await service.routeAndReserve({
      agentName: "maya",
      tier: "deep",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: candidates(),
    });
    expect(db.listMessages()).toMatchObject([{
      from: "hive-quota",
      to: "orchestrator",
      deliveredAt: null,
    }]);
    expect(sender.calls).toEqual([]);
    db.close();
  });

  test("marks old provider observations stale and takes the conservative maximum", async () => {
    const { db } = await fileDatabase("stale");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    await service.observe({
      provider: "claude",
      account: "personal",
      pool: "claude-premium",
      fiveHourUsed: 60,
      weeklyUsed: 70,
      observedAt: "2026-07-09T10:00:00.000Z",
      fiveHourResetAt: "2026-07-09T13:00:00.000Z",
      weeklyResetAt: "2026-07-13T00:00:00.000Z",
      source: "provider",
      confidence: "authoritative",
    });
    const status = service.statuses()[0]!;
    expect("configured" in status).toEqual(false);
    if (!("configured" in status)) {
      expect(status.confidence).toEqual("stale");
      expect(status.freshness).toEqual("stale");
      expect(status.fiveHour.remaining).toEqual(40);
    }
    db.close();
  });

  test("deduplicates warning and critical alerts and rearms after a reset plus hysteresis", async () => {
    const { db } = await fileDatabase("alerts");
    let now = new Date("2026-07-09T12:00:00.000Z");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude", 100, { weeklyAllowance: 1_000 })], {
        estimates: { deep: 10, standard: 20, cheap: 20, review: 10 },
      }),
      () => now,
    );
    const alerts: string[] = [];
    service.setAlertSink(async (body) => {
      alerts.push(body);
    });
    for (let index = 0; index < 4; index += 1) {
      const decision = await service.routeAndReserve({
        agentName: `agent-${index}`,
        tier: "standard",
        preferredTool: "claude",
        explicitTool: "claude",
        candidates: candidates(),
      });
      await service.reconcile(decision.reservation.id);
    }
    expect(alerts.filter((body) => body.includes("five-hour"))).toHaveLength(1);
    const critical = await service.routeAndReserve({
      agentName: "critical",
      tier: "deep",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: candidates(),
    });
    await service.reconcile(critical.reservation.id);
    expect(alerts.filter((body) => body.includes("five-hour"))).toHaveLength(2);
    await service.reconcile(critical.reservation.id);
    expect(alerts.filter((body) => body.includes("five-hour"))).toHaveLength(2);

    now = new Date("2026-07-09T18:00:00.000Z");
    const rearm = await service.routeAndReserve({
      agentName: "rearm",
      tier: "standard",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: candidates(),
    });
    await service.cancel(rearm.reservation.id);
    for (let index = 0; index < 4; index += 1) {
      const decision = await service.routeAndReserve({
        agentName: `again-${index}`,
        tier: "standard",
        preferredTool: "claude",
        explicitTool: "claude",
        candidates: candidates(),
      });
      await service.reconcile(decision.reservation.id);
    }
    expect(alerts.filter((body) => body.includes("five-hour"))).toHaveLength(3);
    db.close();
  });
});
