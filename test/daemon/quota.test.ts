import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { hiveInstanceSuffix } from "../../src/hive-home/home";
import {
  type QuotaConfig,
  QuotaConfigSchema,
  type QuotaLimit,
  type QuotaObservation,
  QuotaObservationSchema,
} from "../../src/schemas/quota";
import {
  migrateDefaultQuotaLedger,
  QuotaDatabase,
} from "../../src/usage-service/quota-ledger";
import { QuotaLedgerUnknownError } from "../../src/usage-service/quota-ledger-records";
import { mergeObservationWindows } from "../../src/usage-service/quota-observation-merge";
import { calendarWeekBounds } from "../../src/usage-service/quota-windows";
import { QuotaService } from "../../src/usage-service/usage-quota";
import { required } from "../required";
import {
  authorizeForQuotaTest,
  CatalogedQuotaLedger as QuotaLedger,
} from "./authorized-launch.test-support";

const roots: string[] = [];
const originalDefaultHome = process.env.HIVE_DEFAULT_HOME;

afterEach(async () => {
  if (originalDefaultHome === undefined) delete process.env.HIVE_DEFAULT_HOME;
  else process.env.HIVE_DEFAULT_HOME = originalDefaultHome;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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
const CLAUDE_CANDIDATE = required(AUTHORIZED_CANDIDATES[0]);
const CODEX_CANDIDATE = required(AUTHORIZED_CANDIDATES[1]);

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
    expect(exact && !("configured" in exact) && exact.fiveHour.used).toEqual(
      10,
    );
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
    expect(
      db.database
        .query(`
      SELECT usageRows, reservationRows, nextUsageSeq
      FROM quota_ledger_integrity WHERE id = 0
    `)
        .get(),
    ).toEqual({
      usageRows: 1,
      reservationRows: 0,
      nextUsageSeq: 1,
    });

    // The reinstalled trigger makes that same write path safe.
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
    expect(
      db.database
        .query(`
      SELECT usageRows, reservationRows, nextUsageSeq
      FROM quota_ledger_integrity WHERE id = 0
    `)
        .get(),
    ).toEqual({
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
    expect(
      ledger.usageTotals(
        scope,
        "2026-07-09T07:00:00.000Z",
        "2026-07-02T12:00:00.000Z",
      ),
    ).toMatchObject({ fiveHour: 0, weekly: 0, reserved: 0 });

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

    expect(() =>
      ledger.usageTotals(
        scope,
        "2026-07-09T07:00:00.000Z",
        "2026-07-02T12:00:00.000Z",
      ),
    ).toThrow(QuotaLedgerUnknownError);
    const service = new QuotaService(
      ledger,
      config([limit("claude")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    expect(() =>
      service.reserveLaunch("maya", CLAUDE_CANDIDATE, "simple_coding"),
    ).toThrow("quota ledger history is unknown");
    expect(ledger.getActiveReservationForAgent("maya")).toBeNull();
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
      (
        db.database
          .query("PRAGMA table_info(quota_reservations)")
          .all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    expect(columns.has("purpose")).toEqual(true);
    expect(columns.has("controlMessageId")).toEqual(true);
    db.close();
  });

  test("shares reservations across instance databases without aliasing same-repo agent names", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-quota-shared-instances-"));
    roots.push(root);
    const path = join(root, "quota.db");
    const firstDb = new QuotaDatabase(path);
    const secondDb = new QuotaDatabase(path);
    const firstLedger = new QuotaLedger(firstDb, "instance-a", join(root, "a"));
    const secondLedger = new QuotaLedger(
      secondDb,
      "instance-b",
      join(root, "b"),
    );
    const quotaConfig = config([limit("claude", 100)]);
    const clock = () => new Date("2026-07-09T12:00:00.000Z");
    const first = new QuotaService(firstLedger, quotaConfig, clock);
    const second = new QuotaService(secondLedger, quotaConfig, clock);

    const firstReservation = first.reserveLaunch(
      "maya",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );
    const secondReservation = second.reserveLaunch(
      "maya",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );

    expect(firstLedger.activeReservations().map((row) => row.id)).toEqual([
      firstReservation.id,
    ]);
    expect(secondLedger.activeReservations().map((row) => row.id)).toEqual([
      secondReservation.id,
    ]);
    expect(
      firstLedger.getReservation(secondReservation.id)?.instanceId,
    ).toEqual("instance-b");
    expect(
      secondLedger.getReservation(firstReservation.id)?.instanceId,
    ).toEqual("instance-a");
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
      liveness.get(instanceId) ?? ("unknown" as const);
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
    // Usage never refuses a spawn, so both siblings book; what this test pins is
    // the liveness-aware expiry below.
    const owned = required(services[0]).reserveLaunch(
      "maya",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );
    required(services[1]).reserveLaunch(
      "sam",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );

    const owner = owned.instanceId;
    const sibling =
      owner === "instance-a" ? required(services[1]) : required(services[0]);
    expect(
      await sibling.recoverExpired(new Date("2026-07-09T12:02:00.000Z")),
    ).toEqual(0);
    expect(firstLedger.getReservation(owned.id)?.status).toEqual("active");

    liveness.set(owner, "dead");
    expect(
      await sibling.recoverExpired(new Date("2026-07-09T12:02:00.000Z")),
    ).toEqual(1);
    expect(firstLedger.getReservation(owned.id)?.status).toEqual("released");
    const replacement = sibling.reserveLaunch(
      "replacement",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );
    expect(replacement.status).toEqual("active");
    firstDb.close();
    secondDb.close();
  });

  test("migrates the default instance's intact quota history into quota.db once", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-quota-migration-"));
    roots.push(root);
    process.env.HIVE_DEFAULT_HOME = root;
    const legacyPath = join(root, "hive.db");
    const legacyDb = new HiveDatabase(legacyPath);
    const defaultInstance = hiveInstanceSuffix(root);
    const defaultHome = root;
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

    const quotaDb = new QuotaDatabase();
    const migrated = new QuotaLedger(quotaDb, "instance-b");
    migrateDefaultQuotaLedger(quotaDb);
    migrateDefaultQuotaLedger(quotaDb);
    expect(migrated.getReservation(reservation.id)).toMatchObject({
      instanceId: defaultInstance,
      status: "reconciled",
      actualUnits: 7,
    });
    expect(
      migrated.usageTotals(
        { provider: "claude", account: "personal", pool: "claude-premium" },
        "2026-07-09T11:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ).fiveHour,
    ).toEqual(7);
    quotaDb.close();
  });

  test("gives a control restart its own idempotent reservation without double-counting the interrupted run", async () => {
    const { path, db } = await fileDatabase("control-reservation");
    const quotaConfig = config([limit("codex", 30, { weeklyAllowance: 300 })]);
    const now = () => new Date("2026-07-09T12:00:00.000Z");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(ledger, quotaConfig, now);
    const original = service.reserveLaunch(
      "maya",
      CODEX_CANDIDATE,
      "simple_coding",
    );
    service.markStarted(original.id);
    await service.cancel(original.id);

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
    expect(ledger.getReservation(original.id)).toMatchObject({
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
    expect(
      ledger.activeReservations().filter((row) => row.agentName === "maya"),
    ).toHaveLength(2);
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
    const unstarted = service.reserveLaunch(
      "maya",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );
    await service.cancel(unstarted.id);
    expect(ledger.getReservation(unstarted.id)?.status).toEqual("released");

    const started = service.reserveLaunch(
      "sam",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );
    service.markStarted(started.id);
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
    expect(restartedLedger.getReservation(started.id)).toMatchObject({
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
    const reservation = service.reserveLaunch(
      "maya",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );
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
      quotaReservationId: reservation.id,
      createdAt: "2026-07-09T12:00:00.000Z",
      lastEventAt: "2026-07-09T12:00:00.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    });
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: {
        async spawn() {
          throw new Error("unused");
        },
      },
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
    expect(ledger.getReservation(reservation.id)).toMatchObject({
      status: "reconciled",
      actualUnits: 7,
      source: "gateway",
    });
    db.close();
  });
});

describe("unmetered booking", () => {
  test("books an unmetered launch against its unconfigured pool without warning", async () => {
    const { db } = await fileDatabase("missing");
    const alerts: string[] = [];
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(
      ledger,
      config([]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    service.setAlertSink(async (body) => {
      alerts.push(body);
    });
    const first = service.reserveLaunch(
      "maya",
      CLAUDE_CANDIDATE,
      "simple_coding",
    );
    expect(first).toMatchObject({
      pool: "unconfigured:claude-model",
      estimatedUnits: 10,
      status: "active",
    });
    await service.cancel(first.id);
    service.reserveLaunch("sam", CLAUDE_CANDIDATE, "simple_coding");
    expect(ledger.getActiveReservationForAgent("sam")).not.toBeNull();
    // Compatibility mode is gone: an unmetered route is the normal case now,
    // so nothing warns.
    expect(alerts).toHaveLength(0);
    db.close();
  });
});

describe("quota telemetry and alerts", () => {
  test("records Codex app-server windows as authoritative configured-pool observations", async () => {
    const { db } = await fileDatabase("codex-app-server");
    const ledger = new QuotaLedger(db);
    const service = new QuotaService(
      ledger,
      config([
        limit("codex", 200, {
          pool: "codex",
          weeklyAllowance: 1_000,
        }),
      ]),
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
    expect(
      ledger.getObservation({
        provider: "codex",
        account: "personal",
        pool: "codex",
      }),
    ).toMatchObject({
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
    expect(
      await service.observeCodexRateLimits("codex-model", {
        rateLimits: {
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: null,
          },
          secondary: null,
        },
      }),
    ).toEqual(null);
    expect(ledger.getObservation(limit("codex"))).toEqual(null);
    db.close();
  });

  test("fails closed before reservation when persisted telemetry is corrupt", async () => {
    const { db } = await fileDatabase("corrupt");
    const ledger = new QuotaLedger(db);
    db.database
      .query(`
      INSERT INTO quota_observations (
        provider, account, pool, fiveHourUsed, weeklyUsed, observedAt,
        fiveHourResetAt, weeklyResetAt, source, confidence
      ) VALUES ('claude', 'personal', 'claude-premium', 10, 10,
        'not-a-date', NULL, NULL, 'manual', 'reported')
    `)
      .run();
    const service = new QuotaService(
      ledger,
      config([limit("claude")]),
      () => new Date("2026-07-09T12:00:00.000Z"),
    );
    expect(() =>
      service.reserveLaunch("maya", CLAUDE_CANDIDATE, "simple_coding"),
    ).toThrow("Corrupt quota observation");
    expect(ledger.getActiveReservationForAgent("maya")).toEqual(null);
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
    const status = required(service.statuses()[0]);
    expect("configured" in status).toEqual(false);
    if (!("configured" in status)) {
      expect(status.confidence).toEqual("stale");
      expect(status.freshness).toEqual("stale");
      expect(status.fiveHour.remaining).toEqual(40);
    }
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

  const report = (
    ledger: QuotaLedger,
    weeklyUsed: number,
    at: string,
  ): void => {
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

describe("a window the reading did not gauge", () => {
  const scope = {
    provider: "claude" as const,
    account: "personal",
    pool: "claude-premium",
  };
  const gaugedAt = "2026-07-11T14:00:00.000Z";
  const priorAt = "2026-07-10T14:00:00.000Z";

  // A reading that gauges only the weekly window. The five-hour window keeps
  // its never-observed nulls, so its Used field is dead weight: what lands is
  // decided by the merge, not by what the caller put there.
  const weeklyOnlyReading = (fiveHourUsed: number): QuotaObservation =>
    QuotaObservationSchema.parse({
      ...scope,
      fiveHourUsed,
      weeklyUsed: 11,
      observedAt: gaugedAt,
      source: "provider",
      confidence: "authoritative",
      weeklyObservedAt: gaugedAt,
      weeklySource: "provider",
      weeklyConfidence: "authoritative",
    });

  // Guards the deletion of recordDiscoveredReading's carry-forward pre-fill,
  // which read the prior row outside the upsert's transaction only to copy its
  // ungauged windows into the incoming row. The ungauged window's null
  // ObservedAt can never win the merge's recency check, so the copy never
  // survived to the stored row.
  test("an ungauged window keeps the prior row's own number whether the incoming row pre-filled it or zeroed it", () => {
    const prior = QuotaObservationSchema.parse({
      ...scope,
      fiveHourUsed: 42,
      weeklyUsed: 7,
      observedAt: priorAt,
      source: "provider",
      confidence: "authoritative",
      fiveHourObservedAt: priorAt,
      fiveHourSource: "provider",
      fiveHourConfidence: "authoritative",
      weeklyObservedAt: priorAt,
      weeklySource: "provider",
      weeklyConfidence: "authoritative",
    });
    const preFilled = mergeObservationWindows(prior, weeklyOnlyReading(42));
    const zeroed = mergeObservationWindows(prior, weeklyOnlyReading(0));
    expect(preFilled).toEqual(zeroed);
    // Pin what they equal, so the equivalence cannot pass on a shared wrong
    // answer: the prior measurement and its provenance survive for the
    // ungauged window, and the gauged weekly window advances.
    expect(zeroed.fiveHourUsed).toBe(42);
    expect(zeroed.fiveHourObservedAt).toBe(priorAt);
    expect(zeroed.weeklyUsed).toBe(11);
    expect(zeroed.weeklyObservedAt).toBe(gaugedAt);
  });

  test("with no prior row the ungauged window lands as never-observed", () => {
    const merged = mergeObservationWindows(null, weeklyOnlyReading(0));
    expect(merged.fiveHourUsed).toBe(0);
    expect(merged.fiveHourObservedAt).toBeNull();
  });
});
