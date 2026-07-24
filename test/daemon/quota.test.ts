import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_QUOTA_CONFIG,
  QuotaConfigSchema,
  type QuotaConfig,
  type QuotaLimit,
} from "../../src/schemas";
import { HiveDatabase } from "../../src/daemon/db";
import type { RootProtocolDeliverer } from "../../src/daemon/delivery";
import { HiveDaemon } from "../../src/daemon/server";
import {
  migrateDefaultQuotaLedger,
  QuotaDatabase,
  QuotaLedgerUnknownError,
} from "../../src/daemon/quota-ledger";
import { hiveInstanceSuffix } from "../../src/daemon/instance-identity";
import {
  calendarWeekBounds,
  QuotaExhaustedError,
  QuotaService,
} from "../../src/daemon/quota";
import {
  authorizeForQuotaTest,
  CatalogedQuotaLedger as QuotaLedger,
} from "./authorized-launch.test-support";

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

const AUTHORIZED_CANDIDATES = await authorizeForQuotaTest([
    { tool: "claude" as const, model: "claude-model" },
    { tool: "codex" as const, model: "codex-model" },
]);

function candidates() {
  return [...AUTHORIZED_CANDIDATES];
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
      category: "simple_coding",
      estimatedUnits: 10,
      now: "2026-07-09T07:00:00.000Z",
      expiresAt: "2026-07-10T00:00:00.000Z",
    });
    ledger.reconcile(
      reservation.id,
      10,
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
  test("unknown-ledger recovery names the quota database", () => {
    const error = new QuotaLedgerUnknownError("test corruption");

    expect(error.message).toContain("restore the intact quota.db");
    expect(error.message).not.toContain("hive.db");
  });

  test("repairs an intact usage tail from an older daemon and protects later writes", async () => {
    const { db } = await fileDatabase("mixed-version-integrity");
    new QuotaLedger(db);

    // Reproduce the upgrade window: a pre-integrity daemon writes after the
    // new build has checkpointed the ledger, but before insert triggers exist.
    db.database.exec(`
      DROP TRIGGER IF EXISTS quota_usage_integrity_insert;
      UPDATE quota_usage_sequence SET next = 1 WHERE id = 0;
      INSERT INTO quota_usage (
        id, reservationId, provider, account, pool, model,
        units, weeklyUnits, occurredAt, source, confidence, seq
      ) VALUES (
        'old-daemon-usage-1', NULL, 'codex', 'personal', 'codex',
        'codex-model', 4, 1, '2026-07-13T14:09:01.602Z',
        'estimated', 'estimated', 1
      );
    `);

    expect(() => new QuotaLedger(db)).not.toThrow();
    expect(db.database.query(`
      SELECT usageRows, reservationRows, nextUsageSeq
      FROM quota_ledger_integrity WHERE id = 0
    `).get()).toEqual({
      usageRows: 1,
      reservationRows: 0,
      nextUsageSeq: 1,
    });

    // The reinstalled trigger makes the same old write path safe from now on.
    db.database.exec(`
      UPDATE quota_usage_sequence SET next = 2 WHERE id = 0;
      INSERT INTO quota_usage (
        id, reservationId, provider, account, pool, model,
        units, weeklyUnits, occurredAt, source, confidence, seq
      ) VALUES (
        'old-daemon-usage-2', NULL, 'codex', 'personal', 'codex',
        'codex-model', 4, 1, '2026-07-13T14:10:01.602Z',
        'estimated', 'estimated', 2
      );
      INSERT INTO quota_reservations (
        id, agentName, provider, account, pool, model, category,
        estimatedUnits, status, createdAt, expiresAt
      ) VALUES (
        'old-daemon-reservation', 'maya', 'codex', 'personal', 'codex',
        'codex-model', 'simple_coding', 4, 'active',
        '2026-07-13T14:11:01.602Z', '2026-07-13T15:11:01.602Z'
      );
    `);
    expect(db.database.query(`
      SELECT usageRows, reservationRows, nextUsageSeq
      FROM quota_ledger_integrity WHERE id = 0
    `).get()).toEqual({
      usageRows: 2,
      reservationRows: 1,
      nextUsageSeq: 2,
    });
    db.close();
  });

  test("refuses to repair non-contiguous usage growth", async () => {
    const { db } = await fileDatabase("mixed-version-integrity-gap");
    new QuotaLedger(db);
    db.database.exec(`
      DROP TRIGGER IF EXISTS quota_usage_integrity_insert;
      UPDATE quota_usage_sequence SET next = 2 WHERE id = 0;
      INSERT INTO quota_usage (
        id, reservationId, provider, account, pool, model,
        units, weeklyUnits, occurredAt, source, confidence, seq
      ) VALUES (
        'old-daemon-usage-2', NULL, 'codex', 'personal', 'codex',
        'codex-model', 4, 1, '2026-07-13T14:10:01.602Z',
        'estimated', 'estimated', 2
      );
    `);

    expect(() => new QuotaLedger(db)).toThrow(QuotaLedgerUnknownError);
    db.close();
  });

  test("distinguishes a genuine zero ledger from truncated spend and refuses a new reservation", async () => {
    const { db } = await fileDatabase("truncated-ledger");
    const ledger = new QuotaLedger(db);
    const scope = {
      provider: "claude" as const,
      account: "personal",
      pool: "claude-premium",
    };
    expect(ledger.usageTotals(
      scope,
      "2026-07-09T07:00:00.000Z",
      "2026-07-02T12:00:00.000Z",
    )).toMatchObject({ fiveHour: 0, weekly: 0, reserved: 0 });

    ledger.insertUnboundedReservation({
      id: "spent-run",
      agentName: "spent",
      ...scope,
      model: "claude-model",
      category: "simple_coding",
      estimatedUnits: 10,
      now: "2026-07-09T11:00:00.000Z",
      expiresAt: "2026-07-09T13:00:00.000Z",
    });
    ledger.reconcile(
      "spent-run",
      10,
      10,
      "estimated",
      "2026-07-09T11:30:00.000Z",
    );
    db.database.exec("DELETE FROM quota_usage");

    expect(() => ledger.usageTotals(
      scope,
      "2026-07-09T07:00:00.000Z",
      "2026-07-02T12:00:00.000Z",
    )).toThrow(QuotaLedgerUnknownError);
    const service = new QuotaService(
      ledger,
      config([limit("claude")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    await expect(service.routeAndReserve({
      agentName: "maya",
      category: "simple_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    })).rejects.toThrow("quota ledger history is unknown");
    expect(ledger.getActiveReservationForAgent("maya")).toBeNull();
    db.close();
  });

  test("final launch revalidation refuses a released reservation", async () => {
    const { db } = await fileDatabase("adapter-revalidation");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("codex")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const decision = await service.routeAndReserve({
      agentName: "maya",
      category: "simple_coding",
      selection: "spread",
      explicitTool: "codex",
      candidates: candidates(),
    });
    expect(() => service.requireActiveReservation(decision.reservation.id))
      .not.toThrow();
    await service.cancel(decision.reservation.id);
    expect(() => service.requireActiveReservation(decision.reservation.id))
      .toThrow("no longer active at launch");
    db.close();
  });

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
        category: "simple_coding",
        selection: "strict",
        explicitTool: "claude",
        candidates: candidates(),
      })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    secondDb.close();
    db.close();
  });

  test("shares reservations across instance databases without aliasing same-repo agent names", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-quota-shared-instances-"));
    roots.push(root);
    const path = join(root, "quota.db");
    const firstDb = new QuotaDatabase(path);
    const secondDb = new QuotaDatabase(path);
    const firstLedger = new QuotaLedger(firstDb, "instance-a", join(root, "a"));
    const secondLedger = new QuotaLedger(secondDb, "instance-b", join(root, "b"));
    const quotaConfig = config([limit("claude", 100)]);
    const clock = () => new Date("2026-07-09T12:00:00.000Z");
    const first = new QuotaService(firstLedger, quotaConfig, clock);
    const second = new QuotaService(secondLedger, quotaConfig, clock);

    const [firstRoute, secondRoute] = await Promise.all([
      first.routeAndReserve({
        agentName: "maya",
        category: "simple_coding",
        selection: "strict",
        explicitTool: "claude",
        candidates: candidates(),
      }),
      second.routeAndReserve({
        agentName: "maya",
        category: "simple_coding",
        selection: "strict",
        explicitTool: "claude",
        candidates: candidates(),
      }),
    ]);

    expect(firstLedger.activeReservations().map((row) => row.id))
      .toEqual([firstRoute.reservation.id]);
    expect(secondLedger.activeReservations().map((row) => row.id))
      .toEqual([secondRoute.reservation.id]);
    expect(firstLedger.getReservation(secondRoute.reservation.id)?.instanceId)
      .toEqual("instance-b");
    expect(secondLedger.getReservation(firstRoute.reservation.id)?.instanceId)
      .toEqual("instance-a");
    firstDb.close();
    secondDb.close();
  });

  test("a sibling preserves a live owner's hold and reclaims it once that owner dies", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-quota-shared-admission-"));
    roots.push(root);
    const path = join(root, "quota.db");
    const firstDb = new QuotaDatabase(path);
    const secondDb = new QuotaDatabase(path);
    const liveness = new Map<string, "live" | "dead" | "unknown">([
      ["instance-a", "live"],
      ["instance-b", "live"],
    ]);
    const probe = async (_home: string, instanceId: string) =>
      liveness.get(instanceId) ?? "unknown" as const;
    const firstLedger = new QuotaLedger(
      firstDb,
      "instance-a",
      join(root, "a"),
      probe,
    );
    const secondLedger = new QuotaLedger(
      secondDb,
      "instance-b",
      join(root, "b"),
      probe,
    );
    const quotaConfig = config([limit("claude", 15)], {
      reservationTtlMinutes: 1,
    });
    const clock = () => new Date("2026-07-09T12:00:00.000Z");
    const services = [
      new QuotaService(firstLedger, quotaConfig, clock),
      new QuotaService(secondLedger, quotaConfig, clock),
    ];
    const results = await Promise.allSettled(services.map((service, index) =>
      service.routeAndReserve({
        agentName: index === 0 ? "maya" : "sam",
        category: "simple_coding",
        selection: "strict",
        explicitTool: "claude",
        candidates: candidates(),
      })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const accepted = results.find((result) => result.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("missing accepted reservation");

    const owner = accepted.value.reservation.instanceId;
    const sibling = owner === "instance-a" ? services[1]! : services[0]!;
    expect(await sibling.recoverExpired(new Date("2026-07-09T12:02:00.000Z")))
      .toEqual(0);
    expect(firstLedger.getReservation(accepted.value.reservation.id)?.status)
      .toEqual("active");

    liveness.set(owner, "dead");
    expect(await sibling.recoverExpired(new Date("2026-07-09T12:02:00.000Z")))
      .toEqual(1);
    expect(firstLedger.getReservation(accepted.value.reservation.id)?.status)
      .toEqual("released");
    const replacement = await sibling.routeAndReserve({
      agentName: "replacement",
      category: "simple_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    });
    expect(replacement.reservation.status).toEqual("active");
    firstDb.close();
    secondDb.close();
  });

  test("migrates the default instance's intact quota history into quota.db once", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-quota-migration-"));
    roots.push(root);
    const legacyPath = join(root, "hive.db");
    const legacyDb = new HiveDatabase(legacyPath);
    const defaultInstance = hiveInstanceSuffix(join(homedir(), ".hive"));
    const defaultHome = join(homedir(), ".hive");
    const legacy = new QuotaLedger(legacyDb, defaultInstance, defaultHome);
    const reservation = legacy.insertUnboundedReservation({
      id: "legacy-reservation",
      agentName: "maya",
      provider: "claude",
      account: "personal",
      pool: "claude-premium",
      model: "claude-model",
      category: "simple_coding",
      estimatedUnits: 10,
      now: "2026-07-09T12:00:00.000Z",
      expiresAt: "2026-07-09T13:00:00.000Z",
    });
    legacy.reconcile(
      reservation.id,
      7,
      7,
      "estimated",
      "2026-07-09T12:05:00.000Z",
    );
    legacyDb.close();

    const quotaDb = new QuotaDatabase(join(root, "quota.db"));
    const migrated = new QuotaLedger(quotaDb, "instance-b");
    migrateDefaultQuotaLedger(quotaDb, legacyPath);
    migrateDefaultQuotaLedger(quotaDb, legacyPath);
    expect(migrated.getReservation(reservation.id)).toMatchObject({
      instanceId: defaultInstance,
      status: "reconciled",
      actualUnits: 7,
    });
    expect(migrated.usageTotals(
      { provider: "claude", account: "personal", pool: "claude-premium" },
      "2026-07-09T11:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ).fiveHour).toEqual(7);
    quotaDb.close();
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
      category: "simple_coding",
      selection: "strict",
      explicitTool: "codex",
      candidates: candidates(),
    });
    service.markStarted(original.reservation.id);
    await service.cancel(original.reservation.id);

    const control = await service.reserveControlRun({
      agentName: "maya",
      category: "simple_coding",
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
      category: "simple_coding",
      tool: "codex",
      model: "codex-model",
      controlMessageId: "control-1",
    });
    expect(recovered.id).toEqual(control.id);
    restartedDb.close();
  });

  test("idempotently reserves a multi-pool critical control run", async () => {
    const { db } = await fileDatabase("multi-pool-control");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(
      ledger,
      config([
        limit("codex", 100, { pool: "general", models: ["*"] }),
        limit("codex", 100, { pool: "model", models: ["codex-model"] }),
      ]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const request = {
      agentName: "maya",
      category: "simple_coding" as const,
      tool: "codex" as const,
      model: "codex-model",
      controlMessageId: "control-multi-pool",
    };
    const reservation = await service.reserveControlRun(request);
    const retried = await service.reserveControlRun(request);
    expect(retried.id).toEqual(reservation.id);
    expect(ledger.activeReservations().filter((row) => row.agentName === "maya"))
      .toHaveLength(2);
    db.close();
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
        category: "simple_coding",
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
    const { root, path, db } = await fileDatabase("recovery");
    const ledger = new QuotaLedger(db, "instance-a", join(root, "a"));
    const service = new QuotaService(
      ledger,
      config([limit("claude")], { reservationTtlMinutes: 1 }),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const unstarted = await service.routeAndReserve({
      agentName: "maya",
      category: "simple_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    });
    await service.cancel(unstarted.reservation.id);
    expect(ledger.getReservation(unstarted.reservation.id)?.status).toEqual(
      "released",
    );

    const started = await service.routeAndReserve({
      agentName: "sam",
      category: "simple_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    });
    service.markStarted(started.reservation.id);
    db.close();

    const restartedDb = new HiveDatabase(path);
    const restartedLedger = new QuotaLedger(
      restartedDb,
      "instance-b",
      join(root, "b"),
      async () => "dead" as const,
    );
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
      category: "simple_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    });
    db.insertAgent({
      id: "maya-id",
      name: "maya",
      tool: "claude",
      model: "claude-model",
      category: "simple_coding",
      status: "spawning",
      taskDescription: "test",
      worktreePath: "/tmp/maya",
      branch: "hive/maya-test",
      contextPct: 0,
      quotaReservationId: decision.reservation.id,
      createdAt: "2026-07-09T12:00:00.000Z",
      lastEventAt: "2026-07-09T12:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    });
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: { async spawn() { throw new Error("unused"); } },
      sessionSender: { async sendSessionMessage() {} },
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
  test("fair dispatch starts with the stable primary instead of comparing unlike headroom windows", async () => {
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
      category: "complex_coding",
      selection: "spread",
      candidates: candidates(),
    });
    expect(decision.tool).toEqual("claude");
    db.close();
  });

  test("fair dispatch ignores small cross-provider headroom differences", async () => {
    const { db } = await fileDatabase("deadband-primary");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude", 88.5), limit("codex", 89.3)]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const decision = await service.routeAndReserve({
      agentName: "primary-wins",
      category: "complex_coding",
      selection: "spread",
      candidates: candidates(),
    });
    expect(decision.tool).toBe("claude");
    db.close();
  });

  test("AUTO excludes unreadable quota while an affordable measured candidate exists", async () => {
    const { db } = await fileDatabase("unknown-headroom");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude", 100)]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const [grok, claude] = await authorizeForQuotaTest([
      { tool: "grok", model: "grok-4.5" },
      { tool: "claude", model: "claude-model" },
    ]);
    const decision = await service.routeAndReserve({
      agentName: "measured-wins",
      category: "complex_coding",
      selection: "spread",
      candidates: [grok!, claude!],
    });
    expect(decision.tool).toBe("claude");
    db.close();
  });

  test("atomic fair dispatch gives concurrent spawns different providers", async () => {
    const { db } = await fileDatabase("reservations-spread");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude"), limit("codex")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const [first, second] = await Promise.all([
      service.routeAndReserve({
        agentName: "first",
        category: "complex_coding",
        selection: "spread",
        candidates: candidates(),
      }),
      service.routeAndReserve({
        agentName: "second",
        category: "complex_coding",
        selection: "spread",
        candidates: candidates(),
      }),
    ]);
    expect([first.tool, second.tool]).toEqual(["claude", "codex"]);
    db.close();
  });

  test("sole-capable assignments create no fairness debt", async () => {
    const { db } = await fileDatabase("fair-eligible-set");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude"), limit("codex")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const [claude] = candidates();
    await service.routeAndReserve({
      agentName: "only-claude",
      category: "complex_coding",
      selection: "spread",
      candidates: [claude!],
    });
    const firstRealChoice = await service.routeAndReserve({
      agentName: "choice",
      category: "complex_coding",
      selection: "spread",
      candidates: candidates(),
    });
    expect(firstRealChoice.tool).toBe("claude");
    db.close();
  });

  test("strict mode preserves chain order despite unequal headroom", async () => {
    const { db } = await fileDatabase("strict-order");
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude", 25), limit("codex", 100)]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    const decision = await service.routeAndReserve({
      agentName: "strict",
      category: "complex_coding",
      selection: "strict",
      candidates: candidates(),
    });
    expect(decision.tool).toBe("claude");
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
        category: "summarization",
        selection: "strict",
        explicitTool: "claude",
        candidates: candidates(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).fallback).toMatchObject({
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
      category: "code_review",
      selection: "strict",
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
      category: "simple_coding",
      selection: "strict",
      candidates: candidates(),
    });
    await service.cancel(first.reservation.id);
    await service.routeAndReserve({
      agentName: "sam",
      category: "simple_coding",
      selection: "strict",
      candidates: candidates(),
    });
    expect(first.tool).toEqual("claude");
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
      category: "simple_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    })).rejects.toThrow("Corrupt quota observation");
    expect(ledger.getActiveReservationForAgent("maya")).toEqual(null);
    db.close();
  });

  test("delivers threshold alerts through the durable orchestrator message path", async () => {
    const { db } = await fileDatabase("alert-delivery");
    const sender: RootProtocolDeliverer & { calls: string[] } = {
      calls: [],
      async deliverMessage(text: string) {
        this.calls.push(text);
        return true;
      },
      isLive: () => true,
    };
    const service = new QuotaService(
      new QuotaLedger(db),
      config([limit("claude", 20, { weeklyAllowance: 1_000 })], {
        estimates: { ...DEFAULT_QUOTA_CONFIG.estimates, complex_coding: 20, simple_coding: 10, summarization: 4, code_review: 8 },
      }),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: { async spawn() { throw new Error("unused"); } },
      rootProtocol: sender,
      quota: service,
    });
    await service.routeAndReserve({
      agentName: "maya",
      category: "complex_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    });
    expect(db.listMessages()).toMatchObject([{
      from: "hive-quota",
      to: "queen",
      state: "injected",
      deliveredAt: expect.any(String),
    }]);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toContain("Hive quota critical:");
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
        estimates: { ...DEFAULT_QUOTA_CONFIG.estimates, complex_coding: 10, simple_coding: 20, summarization: 20, code_review: 10 },
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
        category: "simple_coding",
        selection: "strict",
        explicitTool: "claude",
        candidates: candidates(),
      });
      await service.reconcile(decision.reservation.id);
    }
    expect(alerts.filter((body) => body.includes("five-hour"))).toHaveLength(1);
    const critical = await service.routeAndReserve({
      agentName: "critical",
      category: "complex_coding",
      selection: "strict",
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
      category: "simple_coding",
      selection: "strict",
      explicitTool: "claude",
      candidates: candidates(),
    });
    await service.cancel(rearm.reservation.id);
    for (let index = 0; index < 4; index += 1) {
      const decision = await service.routeAndReserve({
        agentName: `again-${index}`,
        category: "simple_coding",
        selection: "strict",
        explicitTool: "claude",
        candidates: candidates(),
      });
      await service.reconcile(decision.reservation.id);
    }
    expect(alerts.filter((body) => body.includes("five-hour"))).toHaveLength(3);
    db.close();
  });
});

/**
 * A wall clock cannot order two events that share a millisecond, so it must not
 * be asked to. Spend that lands in the same millisecond as a provider reading is
 * in neither the reading nor the "spend since" it is added to — it simply
 * vanishes, and it vanishes in the dangerous direction: Hive under-counts, and
 * admits a spawn past a limit the user has really already hit.
 */
describe("spend is ordered against a reading by sequence, not by the clock", () => {
  const scope = {
    provider: "claude" as const,
    account: "personal",
    pool: "claude-premium",
  };
  const windowStart = "2026-07-04T00:00:00.000Z";
  const observedAt = "2026-07-11T14:00:00.123Z";

  const settle = (ledger: QuotaLedger, id: string, at: string): void => {
    ledger.insertUnboundedReservation({
      id,
      agentName: "maya",
      ...scope,
      model: "claude-model",
      category: "simple_coding",
      estimatedUnits: 1,
      estimatedWeeklyUnits: 1,
      now: at,
      expiresAt: "2026-07-12T00:00:00.000Z",
    });
    ledger.reconcile(id, 1, 1, "estimated", at);
  };

  const report = (ledger: QuotaLedger, weeklyUsed: number, at: string): void => {
    ledger.upsertObservation({
      ...scope,
      fiveHourUsed: 0,
      weeklyUsed,
      observedAt: at,
      fiveHourResetAt: null,
      weeklyResetAt: null,
      source: "provider",
      confidence: "authoritative",
      fiveHourObservedAt: at,
      fiveHourSource: "provider",
      fiveHourConfidence: "authoritative",
      weeklyObservedAt: at,
      weeklySource: "provider",
      weeklyConfidence: "authoritative",
    });
  };

  const after = (ledger: QuotaLedger): number =>
    ledger.usageTotals(scope, windowStart, windowStart).afterWeeklyObservation;

  // The provider reports 99% at an instant; a turn settles one unit immediately
  // after and is handed that same instant by the clock. The reading cannot
  // contain it. Hive must not report 99.
  test("a spend at the reading's own millisecond is counted, not dropped", async () => {
    const { db } = await fileDatabase("same-ms");
    const ledger = new QuotaLedger(db);
    report(ledger, 99, observedAt);
    settle(ledger, "run-1", observedAt);
    expect(after(ledger)).toBe(1);
    db.close();
  });

  // The other write order. Widening the comparison to `>=` would have counted
  // the first case and double-counted this one; a sequence gets both right.
  test("and it is counted exactly once, whichever landed first", async () => {
    const { db } = await fileDatabase("same-ms-reversed");
    const ledger = new QuotaLedger(db);
    settle(ledger, "run-1", observedAt);
    report(ledger, 99, observedAt);
    expect(after(ledger)).toBe(1);
    db.close();
  });

  // The rule this fix must not undo: a measurement beats an estimate. Everything
  // the provider had already seen when it measured stays inside its number.
  test("spend the reading already saw is not added on top of it", async () => {
    const { db } = await fileDatabase("already-measured");
    const ledger = new QuotaLedger(db);
    settle(ledger, "run-1", "2026-07-11T13:00:00.000Z");
    settle(ledger, "run-2", "2026-07-11T13:30:00.000Z");
    report(ledger, 0, observedAt);
    // Codex really did report 0% while Hive's own estimates summed to 12%. The
    // estimates lose: they are guesses, and the reading is a measurement.
    expect(after(ledger)).toBe(0);
    db.close();
  });

  // A boundary is pinned when the reading lands and never moved. Recomputing it
  // later would let an old reading grow forward and swallow spend it never saw.
  test("re-reporting the same instant does not swallow the spend since", async () => {
    const { db } = await fileDatabase("same-instant-repeat");
    const ledger = new QuotaLedger(db);
    report(ledger, 99, observedAt);
    settle(ledger, "run-1", observedAt);
    report(ledger, 99, observedAt);
    expect(after(ledger)).toBe(1);
    db.close();
  });
});
