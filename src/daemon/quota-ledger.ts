import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CAPABILITY_PROVIDERS,
  CapabilityProviderSchema,
  QuotaMeterStateSchema,
  QuotaObservationSchema,
  splitVariant,
  type CapabilityProvider,
  type ModelVendorVerdict,
  RoutingCategorySchema,
  type QuotaObservation,
  type QuotaScope,
  type RoutingCategory,
} from "../schemas";
import type { HiveDatabase } from "./db";
import { modelVendor } from "../adapters/tools/models";
import {
  daemonInstanceLiveness,
  type DaemonInstanceLiveness,
} from "./lifecycle";
import { hiveInstanceSuffix, resolveHiveHome } from "./tmux-sessions";

type LedgerDatabase = Pick<HiveDatabase, "database">;

export function getQuotaDatabasePath(): string {
  return join(homedir(), ".hive", "quota.db");
}

/** The quota ledger is the one machine-wide writable SQLite database. */
export class QuotaDatabase implements LedgerDatabase {
  readonly database: Database;

  constructor(readonly path = getQuotaDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  close(): void {
    this.database.close();
  }
}

const QUOTA_MIGRATION_META_KEY = "defaultHiveQuotaMigrationV1";
const SHARED_QUOTA_TABLES = [
  "quota_observations",
  "quota_fair_dispatch",
  "quota_alerts",
  "quota_pools",
  "quota_model_catalog",
  "quota_route_health",
] as const;

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Copy the default instance's pre-cutover ledger once. Call this only after a
 * QuotaLedger has installed the destination schema and integrity triggers.
 */
export function migrateDefaultQuotaLedger(
  target: QuotaDatabase,
  legacyPath = join(homedir(), ".hive", "hive.db"),
): void {
  if (
    target.database.query("SELECT 1 FROM meta WHERE key = ?")
      .get(QUOTA_MIGRATION_META_KEY) !== null
  ) return;
  if (!existsSync(legacyPath) || legacyPath === target.path) {
    target.database.query("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run(QUOTA_MIGRATION_META_KEY, "no legacy database");
    return;
  }

  target.database.query("ATTACH DATABASE ? AS legacy").run(legacyPath);
  try {
    target.database.transaction(() => {
      if (
        target.database.query("SELECT 1 FROM meta WHERE key = ?")
          .get(QUOTA_MIGRATION_META_KEY) !== null
      ) return;
      const sourceHas = (table: string): boolean =>
        target.database.query(
          "SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table) !== null;
      const commonColumns = (table: string): string[] => {
        const source = new Set(
          (target.database.query(`PRAGMA legacy.table_info(${quoted(table)})`).all() as
            Array<{ name: string }>).map((column) => column.name),
        );
        return (target.database.query(`PRAGMA main.table_info(${quoted(table)})`).all() as
          Array<{ name: string }>).map((column) => column.name)
          .filter((column) => source.has(column));
      };
      const copy = (table: string): void => {
        if (!sourceHas(table)) return;
        const columns = commonColumns(table);
        if (columns.length === 0) return;
        const list = columns.map(quoted).join(", ");
        target.database.exec(
          `INSERT OR IGNORE INTO ${quoted(table)} (${list}) ` +
            `SELECT ${list} FROM legacy.${quoted(table)}`,
        );
      };

      if (sourceHas("quota_usage")) {
        const columns = commonColumns("quota_usage");
        const list = columns.map(quoted).join(", ");
        const rows = target.database.query(
          "SELECT id, seq FROM legacy.quota_usage ORDER BY seq",
        ).all() as Array<{ id: string; seq: number }>;
        for (const row of rows) {
          target.database.query(
            "UPDATE quota_usage_sequence SET next = ? WHERE id = 0",
          ).run(row.seq);
          target.database.query(
            `INSERT OR IGNORE INTO quota_usage (${list}) ` +
              `SELECT ${list} FROM legacy.quota_usage WHERE id = ?`,
          ).run(row.id);
        }
      }
      copy("quota_reservations");
      target.database.query(
        "UPDATE quota_reservations SET instanceId = ? WHERE instanceId = ''",
      ).run(hiveInstanceSuffix(join(homedir(), ".hive")));
      target.database.query(
        "UPDATE quota_reservations SET instanceHome = ? WHERE instanceHome = ''",
      ).run(resolveHiveHome(join(homedir(), ".hive")));
      for (const table of SHARED_QUOTA_TABLES) copy(table);
      target.database.query("INSERT INTO meta (key, value) VALUES (?, ?)")
        .run(QUOTA_MIGRATION_META_KEY, legacyPath);
    }).immediate();
  } finally {
    target.database.exec("DETACH DATABASE legacy");
  }
}

const ReservationSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  instanceHome: z.string(),
  /**
   * The reservation this one settles with. A run gated by more than one pool
   * holds a row per pool, all sharing the primary row's id as their group, so
   * starting, reconciling, or releasing the run settles every pool it touched.
   * Null on rows written before groups existed: those are their own group.
   */
  groupId: z.string().nullable().default(null),
  agentName: z.string(),
  provider: CapabilityProviderSchema,
  account: z.string(),
  pool: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  category: RoutingCategorySchema,
  estimatedUnits: z.number(),
  // A percent-denominated (discovered) pool debits a different fraction of the
  // five-hour and weekly windows for the same run, because a week does not hold
  // proportionally more capacity than a five-hour bucket. Unit-denominated
  // (manual) pools leave this null and debit `estimatedUnits` from both.
  estimatedWeeklyUnits: z.number().nullable(),
  status: z.enum(["active", "reconciled", "released"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  startedAt: z.string().nullable(),
  reconciledAt: z.string().nullable(),
  actualUnits: z.number().nullable(),
  source: z.string().nullable(),
  purpose: z.enum(["agent", "control"]),
  controlMessageId: z.string().nullable(),
});

export type QuotaReservation = z.infer<typeof ReservationSchema>;

/**
 * A quota pool Hive learned about from the provider itself rather than from a
 * human-written `quota.toml`. The provider reports *percentages consumed*, never
 * an absolute capacity, so a discovered pool is denominated in percent: its
 * allowance is 100 by construction and every usage figure is a percent of the
 * window. Window durations are recorded as the provider reported them.
 */
const DiscoveredPoolSchema = z.object({
  provider: CapabilityProviderSchema,
  account: z.string(),
  pool: z.string(),
  /** Empty means the pool is informational: it never matches a routing model. */
  models: z.array(z.string()),
  /** The provider's own name for the pool, e.g. a plan or metered limit name. */
  label: z.string().nullable(),
  fiveHourWindowMinutes: z.number().nullable(),
  weeklyWindowMinutes: z.number().nullable(),
  fiveHourMeterState: QuotaMeterStateSchema,
  weeklyMeterState: QuotaMeterStateSchema,
  discoveredAt: z.string(),
  source: z.enum(["provider", "statusline"]),
});
export type DiscoveredQuotaPool = z.infer<typeof DiscoveredPoolSchema>;

/**
 * One row of a provider's own model catalog: which display name a model answers
 * to. This is what binds a metered sub-pool to the models it meters — the quota
 * payloads name their pools ("Fable", "GPT-5.3-Codex-Spark") but never carry a
 * model id, and the catalog is where the provider publishes both.
 *
 * It is stored rather than resolved on the fly because the free live feeds — the
 * Codex app-server's push notifications and Claude's statusLine — refresh pool
 * *usage* without carrying a catalog. Binding at read time from the stored
 * catalog means a usage update can never silently unbind a pool.
 */
const ModelCatalogSchema = z.object({
  provider: CapabilityProviderSchema,
  modelId: z.string(),
  displayName: z.string(),
  discoveredAt: z.string(),
});
export type ModelCatalogRow = z.infer<typeof ModelCatalogSchema>;

/**
 * Whether a route actually starts, learned from what happened when Hive tried.
 *
 * Headroom is not eligibility. A route can have all the quota in the world and
 * still be incapable of producing a working agent — deep-category Codex was exactly
 * this on 2026-07-11 — and a gate that refuses an exhausted model only to hand
 * the work to a route that cannot start has protected nothing. So a launch that
 * never proves life is recorded against its route, and a route that recently
 * failed to start is not offered as an automatic choice.
 *
 * This is an observation, never a belief. Nothing here names a vendor or encodes
 * "codex deep is broken" — that fact expires the moment someone fixes it. A
 * success clears the route instantly, and the quarantine lapses on its own, so
 * the guard stops guarding the moment the route starts working again. That
 * expiry is not a nicety: a route excluded forever can never produce the success
 * that would clear it, and the guard would quietly become the outage.
 */
const RouteHealthSchema = z.object({
  provider: CapabilityProviderSchema,
  model: z.string(),
  effort: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastFailureAt: z.string().nullable(),
  lastFailureReason: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
});
export type RouteHealth = z.infer<typeof RouteHealthSchema>;

const AlertStateSchema = z.object({
  provider: z.string(),
  account: z.string(),
  pool: z.string(),
  window: z.enum(["five-hour", "weekly", "data"]),
  level: z.enum(["normal", "warning", "critical", "unknown"]),
  notifiedAt: z.string().nullable(),
  boundaryAt: z.string().nullable(),
});
export type QuotaAlertState = z.infer<typeof AlertStateSchema>;

export interface UsageTotals {
  fiveHour: number;
  weekly: number;
  /** Ledger spend recorded after each window's *own* observation was taken. */
  afterFiveHourObservation: number;
  afterWeeklyObservation: number;
  reserved: number;
  reservedWeekly: number;
}

const LedgerIntegritySchema = z.object({
  usageRows: z.number().int().nonnegative(),
  reservationRows: z.number().int().nonnegative(),
  nextUsageSeq: z.number().int().nonnegative(),
});

const QUOTA_LEDGER_INTEGRITY_META_KEY = "quotaLedgerIntegrityV1";

export class QuotaLedgerUnknownError extends Error {
  constructor(reason: string) {
    super(
      `The quota ledger history is unknown (${reason}). Refusing to report fresh ` +
        "headroom or reserve more quota; restore the intact quota.db before launching.",
    );
    this.name = "QuotaLedgerUnknownError";
  }
}

/**
 * The last spend each window's own reading had already been able to see. Each
 * window is observed on its own schedule, so each carries its own boundary:
 * one row-level boundary for both would drop every unit spent between an older
 * weekly reading and a newer five-hour one, and that spend is exactly the
 * headroom a concurrent spawn would then overcommit.
 *
 * These are ledger sequence numbers, not timestamps — see `usageWatermark`.
 * Null means the window was never observed, and there is nothing to be "after".
 */
interface ObservationWatermarks {
  fiveHour: number | null;
  weekly: number | null;
}

export interface UnconfiguredQuotaScope extends QuotaScope {
  model: string;
}

export interface ReserveQuotaInput extends QuotaScope {
  id: string;
  agentName: string;
  model: string;
  effort?: string | null;
  category: RoutingCategory;
  estimatedUnits: number;
  estimatedWeeklyUnits?: number;
  now: string;
  expiresAt: string;
  fiveHourStart: string;
  weeklyStart: string;
  supplementalFiveHourUsed: number;
  supplementalWeeklyUsed: number;
  fiveHourAllowance: number;
  weeklyAllowance: number;
  fiveHourFloor: number;
  weeklyFloor: number;
  purpose?: "agent" | "control";
  controlMessageId?: string;
}

const newer = (left: string | null, right: string | null): boolean =>
  left !== null && (right === null || left >= right);

/**
 * Fold an incoming observation into the stored one, one window at a time. The
 * caller stamps `*ObservedAt` on exactly the windows it actually read; the rest
 * keep whatever provenance they already had.
 */
export function mergeObservationWindows(
  prior: QuotaObservation | null,
  incoming: QuotaObservation,
): QuotaObservation {
  if (prior === null) return incoming;
  const five = newer(incoming.fiveHourObservedAt, prior.fiveHourObservedAt)
    ? incoming
    : prior;
  const week = newer(incoming.weeklyObservedAt, prior.weeklyObservedAt)
    ? incoming
    : prior;
  // The row-level provenance mirrors whichever window was read most recently,
  // so a reader that ignores per-window fields still sees a timestamp that some
  // real observation actually produced.
  const fiveLeads = newer(five.fiveHourObservedAt, week.weeklyObservedAt);
  const lead = fiveLeads
    ? {
      observedAt: five.fiveHourObservedAt,
      source: five.fiveHourSource ?? five.source,
      confidence: five.fiveHourConfidence ?? five.confidence,
    }
    : {
      observedAt: week.weeklyObservedAt,
      source: week.weeklySource ?? week.source,
      confidence: week.weeklyConfidence ?? week.confidence,
    };
  return {
    ...incoming,
    fiveHourUsed: five.fiveHourUsed,
    fiveHourResetAt: five.fiveHourResetAt,
    fiveHourObservedAt: five.fiveHourObservedAt,
    fiveHourSource: five.fiveHourSource,
    fiveHourConfidence: five.fiveHourConfidence,
    weeklyUsed: week.weeklyUsed,
    weeklyResetAt: week.weeklyResetAt,
    weeklyObservedAt: week.weeklyObservedAt,
    weeklySource: week.weeklySource,
    weeklyConfidence: week.weeklyConfidence,
    observedAt: lead.observedAt ?? incoming.observedAt,
    source: lead.source,
    confidence: lead.confidence,
  };
}

export class QuotaLedger {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly instanceId = hiveInstanceSuffix(),
    private readonly instanceHome = resolveHiveHome(),
    private readonly instanceLiveness: (
      hiveHome: string,
      instanceId: string,
    ) => Promise<DaemonInstanceLiveness> = daemonInstanceLiveness,
  ) {
    const integrityInstalled = this.db.database.query(
      "SELECT value FROM meta WHERE key = ?",
    ).get(QUOTA_LEDGER_INTEGRITY_META_KEY) !== null;
    this.db.database.exec(`
      CREATE TABLE IF NOT EXISTS quota_usage (
        id TEXT PRIMARY KEY,
        reservationId TEXT UNIQUE,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        pool TEXT NOT NULL,
        model TEXT NOT NULL,
        units REAL NOT NULL CHECK(units >= 0),
        occurredAt TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        -- The order these rows were committed in, which is the only ordering
        -- they actually have. occurredAt is a wall clock, and a wall clock
        -- cannot say which of two things that share a millisecond came first.
        seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS quota_usage_scope_time
        ON quota_usage(provider, account, pool, occurredAt);
      -- The sequence outlives the rows: it is only ever incremented, so a number
      -- cannot be handed out twice even if usage is one day pruned. A watermark
      -- pointing at a recycled sequence would mark a *new* spend as already
      -- measured — precisely the failure the sequence exists to prevent.
      CREATE TABLE IF NOT EXISTS quota_usage_sequence (
        id INTEGER PRIMARY KEY CHECK(id = 0),
        next INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_ledger_integrity (
        id INTEGER PRIMARY KEY CHECK(id = 0),
        usageRows INTEGER NOT NULL CHECK(usageRows >= 0),
        reservationRows INTEGER NOT NULL CHECK(reservationRows >= 0),
        nextUsageSeq INTEGER NOT NULL CHECK(nextUsageSeq >= 0)
      );
      CREATE TABLE IF NOT EXISTS quota_reservations (
        id TEXT PRIMARY KEY,
        instanceId TEXT NOT NULL DEFAULT '',
        instanceHome TEXT NOT NULL DEFAULT '',
        agentName TEXT NOT NULL,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        pool TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        category TEXT NOT NULL,
        estimatedUnits REAL NOT NULL CHECK(estimatedUnits >= 0),
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        startedAt TEXT,
        reconciledAt TEXT,
        actualUnits REAL,
        source TEXT,
        purpose TEXT NOT NULL DEFAULT 'agent',
        controlMessageId TEXT
      );
      CREATE INDEX IF NOT EXISTS quota_reservations_scope_status
        ON quota_reservations(provider, account, pool, status);
      CREATE INDEX IF NOT EXISTS quota_reservations_agent
        ON quota_reservations(agentName, status);
      CREATE TABLE IF NOT EXISTS quota_fair_dispatch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        selectedAt TEXT NOT NULL,
        selectedProvider TEXT NOT NULL,
        eligibleProviders TEXT NOT NULL,
        reservationId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_observations (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        pool TEXT NOT NULL,
        fiveHourUsed REAL NOT NULL,
        weeklyUsed REAL NOT NULL,
        observedAt TEXT NOT NULL,
        fiveHourResetAt TEXT,
        weeklyResetAt TEXT,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        PRIMARY KEY(provider, account, pool)
      );
      CREATE TABLE IF NOT EXISTS quota_alerts (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        pool TEXT NOT NULL,
        window TEXT NOT NULL,
        level TEXT NOT NULL,
        notifiedAt TEXT,
        boundaryAt TEXT,
        PRIMARY KEY(provider, account, pool, window)
      );
      CREATE TABLE IF NOT EXISTS quota_pools (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        pool TEXT NOT NULL,
        models TEXT NOT NULL,
        label TEXT,
        fiveHourWindowMinutes REAL,
        weeklyWindowMinutes REAL,
        fiveHourMeterState TEXT NOT NULL DEFAULT 'unknown',
        weeklyMeterState TEXT NOT NULL DEFAULT 'unknown',
        discoveredAt TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY(provider, account, pool)
      );
      CREATE TABLE IF NOT EXISTS quota_model_catalog (
        provider TEXT NOT NULL,
        modelId TEXT NOT NULL,
        displayName TEXT NOT NULL,
        discoveredAt TEXT NOT NULL,
        PRIMARY KEY(provider, modelId, displayName)
      );
      CREATE TABLE IF NOT EXISTS quota_route_health (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT '',
        consecutiveFailures INTEGER NOT NULL DEFAULT 0,
        lastFailureAt TEXT,
        lastFailureReason TEXT,
        lastSuccessAt TEXT,
        PRIMARY KEY(provider, model, effort)
      );
    `);
    const poolColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_pools)").all(),
    );
    const poolColumnNames = new Set(poolColumns.map((column) => column.name));
    for (
      const [column, duration] of [
        ["fiveHourMeterState", "fiveHourWindowMinutes"],
        ["weeklyMeterState", "weeklyWindowMinutes"],
      ] as const
    ) {
      if (poolColumnNames.has(column)) continue;
      this.db.database.exec(
        `ALTER TABLE quota_pools ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'unknown'`,
      );
      // A stored duration proves the window was metered. A legacy null proves
      // nothing, so it remains unknown until a provider explicitly says more.
      this.db.database.exec(
        `UPDATE quota_pools SET ${column} = 'metered' WHERE ${duration} IS NOT NULL`,
      );
    }
    const observationColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_observations)").all(),
    );
    const observationColumnNames = new Set(
      observationColumns.map((column) => column.name),
    );
    for (
      const [column, type] of [
        ["fiveHourObservedAt", "TEXT"],
        ["fiveHourSource", "TEXT"],
        ["fiveHourConfidence", "TEXT"],
        ["weeklyObservedAt", "TEXT"],
        ["weeklySource", "TEXT"],
        ["weeklyConfidence", "TEXT"],
        // Which spend each window's reading already accounts for. Hive's own
        // bookkeeping, not the provider's fact, which is why it lives here and
        // not on `QuotaObservation`.
        ["fiveHourUsageSeq", "INTEGER"],
        ["weeklyUsageSeq", "INTEGER"],
      ] as const
    ) {
      if (observationColumnNames.has(column)) continue;
      this.db.database.exec(
        `ALTER TABLE quota_observations ADD COLUMN ${column} ${type}`,
      );
    }
    const reservationColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_reservations)").all(),
    );
    const reservationColumnNames = new Set(
      reservationColumns.map((column) => column.name),
    );
    if (!reservationColumnNames.has("instanceId")) {
      this.db.database.exec(
        "ALTER TABLE quota_reservations ADD COLUMN instanceId TEXT NOT NULL DEFAULT ''",
      );
      this.db.database.query(
        "UPDATE quota_reservations SET instanceId = ? WHERE instanceId = ''",
      ).run(this.instanceId);
    }
    if (!reservationColumnNames.has("instanceHome")) {
      this.db.database.exec(
        "ALTER TABLE quota_reservations ADD COLUMN instanceHome TEXT NOT NULL DEFAULT ''",
      );
      this.db.database.query(
        "UPDATE quota_reservations SET instanceHome = ? WHERE instanceHome = ''",
      ).run(this.instanceHome);
    }
    if (!reservationColumnNames.has("purpose")) {
      this.db.database.exec(
        "ALTER TABLE quota_reservations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'agent'",
      );
    }
    if (!reservationColumnNames.has("controlMessageId")) {
      this.db.database.exec(
        "ALTER TABLE quota_reservations ADD COLUMN controlMessageId TEXT",
      );
    }
    if (!reservationColumnNames.has("estimatedWeeklyUnits")) {
      this.db.database.exec(
        "ALTER TABLE quota_reservations ADD COLUMN estimatedWeeklyUnits REAL",
      );
    }
    if (!reservationColumnNames.has("effort")) {
      this.db.database.exec(
        "ALTER TABLE quota_reservations ADD COLUMN effort TEXT",
      );
    }
    const healthColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_route_health)").all(),
    );
    if (!healthColumns.some((column) => column.name === "effort")) {
      this.db.database.exec(`
        ALTER TABLE quota_route_health RENAME TO quota_route_health_legacy;
        CREATE TABLE quota_route_health (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          effort TEXT NOT NULL DEFAULT '',
          consecutiveFailures INTEGER NOT NULL DEFAULT 0,
          lastFailureAt TEXT,
          lastFailureReason TEXT,
          lastSuccessAt TEXT,
          PRIMARY KEY(provider, model, effort)
        );
        INSERT INTO quota_route_health (
          provider, model, effort, consecutiveFailures, lastFailureAt,
          lastFailureReason, lastSuccessAt
        )
        SELECT provider, model, '', consecutiveFailures, lastFailureAt,
               lastFailureReason, lastSuccessAt
        FROM quota_route_health_legacy;
        DROP TABLE quota_route_health_legacy;
      `);
    }
    // A run that spends from two pools at once — the account-wide one and the
    // model's own cap — holds a reservation in each, and they must settle
    // together or a released run would keep hold of the sub-pool forever. Rows
    // written before groups existed are their own group, which is exactly what
    // a single-pool reservation is.
    if (!reservationColumnNames.has("groupId")) {
      this.db.database.exec(
        "ALTER TABLE quota_reservations ADD COLUMN groupId TEXT",
      );
      this.db.database.exec(
        "UPDATE quota_reservations SET groupId = id WHERE groupId IS NULL",
      );
    }
    this.db.database.exec(
      "CREATE INDEX IF NOT EXISTS quota_reservations_group ON quota_reservations(groupId)",
    );
    const usageColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_usage)").all(),
    );
    if (!usageColumns.some((column) => column.name === "weeklyUnits")) {
      this.db.database.exec(
        "ALTER TABLE quota_usage ADD COLUMN weeklyUnits REAL",
      );
    }
    if (!usageColumns.some((column) => column.name === "seq")) {
      this.db.database.exec("ALTER TABLE quota_usage ADD COLUMN seq INTEGER");
    }
    // Spend written before Hive kept a sequence still has one: SQLite's rowid is
    // the order those rows were inserted, which is the fact the sequence records.
    this.db.database.exec(
      "UPDATE quota_usage SET seq = rowid WHERE seq IS NULL",
    );
    this.db.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS quota_usage_seq ON quota_usage(seq);
      CREATE INDEX IF NOT EXISTS quota_usage_scope_seq
        ON quota_usage(provider, account, pool, seq);
    `);
    this.db.database.exec(`
      INSERT OR IGNORE INTO quota_usage_sequence (id, next)
      VALUES (0, (SELECT COALESCE(MAX(seq), 0) FROM quota_usage))
    `);
    this.immediate(() => {
      if (!integrityInstalled) {
        this.db.database.exec(`
          INSERT OR IGNORE INTO quota_ledger_integrity (
            id, usageRows, reservationRows, nextUsageSeq
          ) SELECT 0,
            (SELECT COUNT(*) FROM quota_usage),
            (SELECT COUNT(*) FROM quota_reservations),
            (SELECT next FROM quota_usage_sequence WHERE id = 0)
        `);
        this.db.database.query(
          "INSERT OR IGNORE INTO meta (key, value) VALUES (?, 'installed')",
        ).run(QUOTA_LEDGER_INTEGRITY_META_KEY);
      }
      // These triggers are part of the migration boundary, not merely the new
      // writer. A daemon from before the integrity checkpoint can keep serving
      // an already-running session during an upgrade; its inserts must advance
      // the checkpoint too. Installing the checkpoint and triggers under one
      // write lock leaves no unprotected window between them.
      this.db.database.exec(`
        CREATE TRIGGER IF NOT EXISTS quota_usage_integrity_insert
        AFTER INSERT ON quota_usage
        BEGIN
          SELECT CASE
            WHEN (SELECT COUNT(*) FROM quota_ledger_integrity WHERE id = 0) != 1
              THEN RAISE(ABORT, 'quota ledger integrity checkpoint unavailable')
            WHEN NEW.seq IS NULL
              OR NEW.seq != (SELECT nextUsageSeq + 1 FROM quota_ledger_integrity WHERE id = 0)
              OR NEW.seq != (SELECT next FROM quota_usage_sequence WHERE id = 0)
              THEN RAISE(ABORT, 'quota usage sequence is not contiguous')
          END;
          UPDATE quota_ledger_integrity
          SET usageRows = usageRows + 1, nextUsageSeq = NEW.seq
          WHERE id = 0;
        END;
        CREATE TRIGGER IF NOT EXISTS quota_reservation_integrity_insert
        AFTER INSERT ON quota_reservations
        BEGIN
          SELECT CASE
            WHEN (SELECT COUNT(*) FROM quota_ledger_integrity WHERE id = 0) != 1
              THEN RAISE(ABORT, 'quota ledger integrity checkpoint unavailable')
          END;
          UPDATE quota_ledger_integrity
          SET reservationRows = reservationRows + 1
          WHERE id = 0;
        END;
      `);
      this.repairIntactUsageGrowth();
      this.requireIntegrity();
    });
    this.db.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS quota_reservations_active_control
      ON quota_reservations(controlMessageId)
      WHERE controlMessageId IS NOT NULL AND status = 'active'
    `);
    this.backfillObservationWatermarks();
  }

  private requireIntegrity(): void {
    const expected = LedgerIntegritySchema.safeParse(
      this.db.database.query(`
        SELECT usageRows, reservationRows, nextUsageSeq
        FROM quota_ledger_integrity WHERE id = 0
      `).get(),
    );
    if (!expected.success) {
      throw new QuotaLedgerUnknownError("its integrity checkpoint is missing or unreadable");
    }
    const actual = LedgerIntegritySchema.safeParse(
      this.db.database.query(`
        SELECT
          (SELECT COUNT(*) FROM quota_usage) AS usageRows,
          (SELECT COUNT(*) FROM quota_reservations) AS reservationRows,
          (SELECT next FROM quota_usage_sequence WHERE id = 0) AS nextUsageSeq
      `).get(),
    );
    if (!actual.success) {
      throw new QuotaLedgerUnknownError("its spend sequence is missing or unreadable");
    }
    if (
      expected.data.usageRows !== actual.data.usageRows ||
      expected.data.reservationRows !== actual.data.reservationRows ||
      expected.data.nextUsageSeq !== actual.data.nextUsageSeq
    ) {
      throw new QuotaLedgerUnknownError(
        `checkpoint expected ${expected.data.usageRows} usage rows, ` +
          `${expected.data.reservationRows} reservation rows, and sequence ` +
          `${expected.data.nextUsageSeq}; found ${actual.data.usageRows}, ` +
          `${actual.data.reservationRows}, and sequence ${actual.data.nextUsageSeq}`,
      );
    }
  }

  /**
   * Repair the one state an older writer can leave behind: an intact,
   * contiguous suffix committed after this checkpoint was first installed.
   * Anything missing from the checkpointed prefix, any sequence gap or jump,
   * and any reservation-count disagreement still refuses startup.
   */
  private repairIntactUsageGrowth(): void {
    const state = z.object({
      expectedUsageRows: z.number().int().nonnegative(),
      expectedReservationRows: z.number().int().nonnegative(),
      expectedNextUsageSeq: z.number().int().nonnegative(),
      actualUsageRows: z.number().int().nonnegative(),
      actualReservationRows: z.number().int().nonnegative(),
      actualNextUsageSeq: z.number().int().nonnegative(),
      prefixUsageRows: z.number().int().nonnegative(),
      appendedUsageRows: z.number().int().nonnegative(),
    }).safeParse(this.db.database.query(`
      SELECT
        integrity.usageRows AS expectedUsageRows,
        integrity.reservationRows AS expectedReservationRows,
        integrity.nextUsageSeq AS expectedNextUsageSeq,
        (SELECT COUNT(*) FROM quota_usage) AS actualUsageRows,
        (SELECT COUNT(*) FROM quota_reservations) AS actualReservationRows,
        sequence.next AS actualNextUsageSeq,
        (SELECT COUNT(*) FROM quota_usage
          WHERE seq <= integrity.nextUsageSeq) AS prefixUsageRows,
        (SELECT COUNT(*) FROM quota_usage
          WHERE seq > integrity.nextUsageSeq AND seq <= sequence.next) AS appendedUsageRows
      FROM quota_ledger_integrity AS integrity
      JOIN quota_usage_sequence AS sequence ON sequence.id = 0
      WHERE integrity.id = 0
    `).get());
    if (!state.success) return;

    const value = state.data;
    if (
      value.actualReservationRows !== value.expectedReservationRows ||
      value.actualUsageRows <= value.expectedUsageRows ||
      value.actualNextUsageSeq <= value.expectedNextUsageSeq
    ) return;
    const appendedRows = value.actualUsageRows - value.expectedUsageRows;
    const appendedSequences = value.actualNextUsageSeq - value.expectedNextUsageSeq;
    if (
      value.prefixUsageRows !== value.expectedUsageRows ||
      value.appendedUsageRows !== appendedRows ||
      appendedRows !== appendedSequences
    ) return;

    this.db.database.query(`
      UPDATE quota_ledger_integrity
      SET usageRows = ?, nextUsageSeq = ?
      WHERE id = 0 AND usageRows = ? AND reservationRows = ? AND nextUsageSeq = ?
    `).run(
      value.actualUsageRows,
      value.actualNextUsageSeq,
      value.expectedUsageRows,
      value.expectedReservationRows,
      value.expectedNextUsageSeq,
    );
  }

  /**
   * An observation stored before Hive sequenced its spend knows only *when* it
   * was taken. Reconstruct its boundary once, from that timestamp, so the read
   * path never has to compare a wall clock again. Old rows keep the meaning they
   * were written with; new ones get the ordering the timestamp could not give.
   */
  private backfillObservationWatermarks(): void {
    const stale = z.array(z.object({
      provider: CapabilityProviderSchema,
      account: z.string(),
      pool: z.string(),
      fiveHourObservedAt: z.string().nullable(),
      weeklyObservedAt: z.string().nullable(),
    })).parse(this.db.database.query(`
      SELECT
        provider, account, pool,
        COALESCE(fiveHourObservedAt, observedAt) AS fiveHourObservedAt,
        COALESCE(weeklyObservedAt, observedAt) AS weeklyObservedAt
      FROM quota_observations
      WHERE fiveHourUsageSeq IS NULL OR weeklyUsageSeq IS NULL
    `).all());
    for (const row of stale) {
      this.db.database.query(`
        UPDATE quota_observations
        SET fiveHourUsageSeq = COALESCE(fiveHourUsageSeq, ?),
            weeklyUsageSeq = COALESCE(weeklyUsageSeq, ?)
        WHERE provider = ? AND account = ? AND pool = ?
      `).run(
        this.usageWatermark(row, row.fiveHourObservedAt),
        this.usageWatermark(row, row.weeklyObservedAt),
        row.provider,
        row.account,
        row.pool,
      );
    }
  }

  /** The next number in the ledger's commit order. Never rewound, never reused. */
  private nextUsageSeq(): number {
    return z.object({ next: z.number() }).parse(
      this.db.database.query(
        "UPDATE quota_usage_sequence SET next = next + 1 WHERE id = 0 RETURNING next",
      ).get(),
    ).next;
  }

  /**
   * The last spend a reading taken at `observedAt` could already have counted.
   *
   * This is a prefix of the ledger's own commit sequence, not a timestamp
   * comparison, because a wall clock is not a happens-before relation: two events
   * that share a millisecond have no order in it at all. The boundary is the last
   * row before the first spend the reading cannot have seen — anything bearing the
   * reading's own instant or later — and everything committed afterwards falls
   * outside it by construction, whatever timestamp it carries.
   *
   * Ties therefore go to "not covered": a spend that lands in the same
   * millisecond as a reading is counted on top of it. The two directions of error
   * are not symmetric. Over-counting refuses a spawn that would have fit, and the
   * next observation takes the refusal back minutes later. Under-counting spends
   * quota the user does not have, admits the spawn past a real limit, and nothing
   * downstream ever corrects it. Hive pays the cheap error.
   */
  private usageWatermark(scope: QuotaScope, observedAt: string | null): number | null {
    if (observedAt === null) return null;
    return z.object({ watermark: z.number() }).parse(
      this.db.database.query(`
        SELECT COALESCE(MAX(seq), 0) AS watermark FROM quota_usage
        WHERE provider = ? AND account = ? AND pool = ?
          AND seq < COALESCE((
            SELECT MIN(seq) FROM quota_usage
            WHERE provider = ? AND account = ? AND pool = ? AND occurredAt >= ?
          ), 9223372036854775807)
      `).get(
        scope.provider,
        scope.account,
        scope.pool,
        scope.provider,
        scope.account,
        scope.pool,
        observedAt,
      ),
    ).watermark;
  }

  /** Each window's stored boundary, or null for a window nobody ever measured. */
  private watermarks(scope: QuotaScope): ObservationWatermarks {
    const row = this.db.database.query(`
      SELECT fiveHourUsageSeq, weeklyUsageSeq FROM quota_observations
      WHERE provider = ? AND account = ? AND pool = ?
    `).get(scope.provider, scope.account, scope.pool);
    if (row === null) return { fiveHour: null, weekly: null };
    const parsed = z.object({
      fiveHourUsageSeq: z.number().nullable(),
      weeklyUsageSeq: z.number().nullable(),
    }).parse(row);
    return {
      fiveHour: parsed.fiveHourUsageSeq,
      weekly: parsed.weeklyUsageSeq,
    };
  }

  private immediate<T>(operation: () => T): T {
    return this.db.database.transaction(operation).immediate();
  }

  usageTotals(
    scope: QuotaScope,
    fiveHourStart: string,
    weeklyStart: string,
  ): UsageTotals {
    this.requireIntegrity();
    // Which window a spend falls in is a question about the clock, and the clock
    // answers it. Whether a *reading* already counted that spend is a question
    // about order, and only the sequence answers that — hence the two different
    // comparisons below, on purpose.
    //
    // A run consumes a different fraction of each window, so its weekly cost is
    // recorded alongside its five-hour cost rather than inferred from it. Rows
    // written before that distinction existed carry only `units` and fall back
    // to it, which is precisely their old behaviour.
    const watermarks = this.watermarks(scope);
    const row = z.object({
      fiveHour: z.number(),
      weekly: z.number(),
      afterFiveHourObservation: z.number(),
      afterWeeklyObservation: z.number(),
    }).parse(this.db.database.query(`
      SELECT
        COALESCE(SUM(CASE WHEN occurredAt >= ? THEN units ELSE 0 END), 0) AS fiveHour,
        COALESCE(SUM(CASE WHEN occurredAt >= ? THEN COALESCE(weeklyUnits, units) ELSE 0 END), 0) AS weekly,
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND seq > ? THEN units ELSE 0 END), 0) AS afterFiveHourObservation,
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND seq > ? THEN COALESCE(weeklyUnits, units) ELSE 0 END), 0) AS afterWeeklyObservation
      FROM quota_usage
      WHERE provider = ? AND account = ? AND pool = ?
    `).get(
      fiveHourStart,
      weeklyStart,
      watermarks.fiveHour,
      watermarks.fiveHour,
      watermarks.weekly,
      watermarks.weekly,
      scope.provider,
      scope.account,
      scope.pool,
    ));
    const reservation = z.object({
      reserved: z.number(),
      reservedWeekly: z.number(),
    }).parse(
      this.db.database.query(`
        SELECT
          COALESCE(SUM(estimatedUnits), 0) AS reserved,
          COALESCE(SUM(COALESCE(estimatedWeeklyUnits, estimatedUnits)), 0) AS reservedWeekly
        FROM quota_reservations
        WHERE provider = ? AND account = ? AND pool = ? AND status = 'active'
      `).get(scope.provider, scope.account, scope.pool),
    );
    return {
      ...row,
      reserved: reservation.reserved,
      reservedWeekly: reservation.reservedWeekly,
    };
  }

  earliestUsageAt(scope: QuotaScope, since: string): string | null {
    const row = z.object({ occurredAt: z.string().nullable() }).parse(
      this.db.database.query(`
        SELECT MIN(occurredAt) AS occurredAt FROM quota_usage
        WHERE provider = ? AND account = ? AND pool = ? AND occurredAt >= ?
      `).get(scope.provider, scope.account, scope.pool, since),
    );
    return row.occurredAt;
  }

  unconfiguredScopes(): UnconfiguredQuotaScope[] {
    return this.db.database.query(`
      SELECT provider, account, pool, model FROM quota_reservations
      WHERE pool LIKE 'unconfigured:%'
      UNION
      SELECT provider, account, pool, model FROM quota_usage
      WHERE pool LIKE 'unconfigured:%'
      ORDER BY provider, account, pool, model
    `).all().map((row) => z.object({
      provider: CapabilityProviderSchema,
      account: z.string(),
      pool: z.string(),
      model: z.string(),
    }).parse(row));
  }

  /**
   * Does this pool have room for the run, once everything already committed
   * against it is counted? A pool that would be pushed past its allowance (less
   * whatever floor the caller is protecting) has no room, and the run must not
   * be admitted onto it.
   */
  private fits(input: ReserveQuotaInput): boolean {
    const totals = this.usageTotals(
      input,
      input.fiveHourStart,
      input.weeklyStart,
    );
    const weeklyEstimate = input.estimatedWeeklyUnits ?? input.estimatedUnits;
    const fiveHourCommitted = totals.fiveHour + totals.reserved +
      input.supplementalFiveHourUsed + input.estimatedUnits;
    const weeklyCommitted = totals.weekly + totals.reservedWeekly +
      input.supplementalWeeklyUsed + weeklyEstimate;
    return fiveHourCommitted <= input.fiveHourAllowance - input.fiveHourFloor &&
      weeklyCommitted <= input.weeklyAllowance - input.weeklyFloor;
  }

  /**
   * A spend belongs to the vendor whose model produced it. Anything else is not
   * a small error to be tolerated, it is an impossible fact.
   *
   * The ledger holds one such row today: agent `oscar`, `pool=codex`,
   * `model=claude-opus-4-8` — a Claude model's usage billed against the Codex
   * meter, written when category routing picked `tool=codex` while the caller had
   * pinned a Claude model. The spawner refuses that pairing now, but the ledger
   * took it without ever asking whether the pair could exist, and a ledger that
   * accepts an incoherent fact will accept the next one too. Cross-vendor billing
   * corruption stays small until it doesn't.
   *
   * The stored catalog is the authority, because a model's vendor is a fact the
   * vendor publishes — not something to be inferred from how the name is spelt.
   * This guard used to ask `modelVendor()`, a regex over the model string, and
   * treat its null ("I cannot place this name") as PERMISSION: an unplaceable
   * model's spend was billed to whatever meter it arrived on. Unknown read as
   * yes, in the one guard whose whole purpose is to refuse.
   *
   * So the states are kept apart. Every catalog read and none of them lists the
   * model: that is a MEASUREMENT, and it refuses. No catalog read at all: that
   * is no evidence, and absence of evidence may not be converted into either a
   * yes or a no — Hive falls back to the name's shape, which can still prove a
   * contradiction (a `claude-` model on the Codex meter) but can never grant
   * permission, and says out loud when it cannot vouch for the pairing at all.
   */
  private requireCoherent(provider: CapabilityProvider, model: string): void {
    const verdict = this.modelVendorFromCatalog(model);
    if (verdict.state === "claimed") {
      if (verdict.provider !== provider) {
        throw new Error(
          `Refusing to bill ${verdict.provider} model "${model}" to the ${provider} meter: ` +
            "a spend belongs to the vendor whose model produced it, and Hive will " +
            "not guess which pool an impossible pairing should be charged to.",
        );
      }
      return;
    }
    if (verdict.state === "unclaimed") {
      throw new Error(
        `Refusing to bill unidentifiable model "${model}" to the ${provider} meter: ` +
          "every vendor's catalog has been read and not one of them lists it. A " +
          "model nobody claims is not evidence that it belongs here.",
      );
    }
    // No catalog to answer with. The name's shape may still expose an
    // impossible pair; it may never be read as a licence.
    const named = modelVendor(model);
    if (named !== null && named !== provider) {
      throw new Error(
        `Refusing to bill ${named} model "${model}" to the ${provider} meter: ` +
          "a spend belongs to the vendor whose model produced it, and Hive will " +
          "not guess which pool an impossible pairing should be charged to.",
      );
    }
    if (named === null) {
      console.warn(
        `Hive cannot verify that model "${model}" belongs to the ${provider} meter ` +
          `(${verdict.reason}); billing it as asked. This is an unverified pairing, ` +
          "not a confirmed one.",
      );
    }
  }

  /**
   * Which vendor's own catalog claims this model. `unclaimed` is only ever
   * returned when EVERY vendor's catalog has actually been read — otherwise the
   * honest answer is that it cannot be read, and the caller must not mistake a
   * missing catalog for a missing model.
   */
  modelVendorFromCatalog(model: string): ModelVendorVerdict {
    const rows = this.modelCatalog();
    const read = new Set(rows.map((row) => row.provider));
    const unread = CAPABILITY_PROVIDERS.filter(
      (provider) => !read.has(provider),
    );
    const wanted = splitVariant(model.trim()).base.toLowerCase();
    const claims = [
      ...new Set(
        rows.filter((row) =>
          row.modelId.trim().toLowerCase() === wanted ||
          row.displayName.trim().toLowerCase() === wanted
        ).map((row) => row.provider),
      ),
    ];
    if (claims.length === 1) return { state: "claimed", provider: claims[0]! };
    if (claims.length > 1) {
      return {
        state: "unreadable",
        reason: `${claims.join(" and ")} both list ${JSON.stringify(model)}`,
      };
    }
    if (unread.length > 0) {
      return {
        state: "unreadable",
        reason: `no model catalog has been read for ${unread.join(" or ")}`,
      };
    }
    return { state: "unclaimed" };
  }

  private insert(input: ReserveQuotaInput, groupId: string): void {
    this.requireIntegrity();
    this.requireCoherent(input.provider, input.model);
    this.db.database.query(`
      INSERT INTO quota_reservations (
        id, groupId, instanceId, instanceHome, agentName, provider, account, pool, model, effort, category,
        estimatedUnits, estimatedWeeklyUnits, status, createdAt, expiresAt,
        startedAt, reconciledAt, actualUnits, source, purpose,
        controlMessageId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      input.id,
      groupId,
      this.instanceId,
      this.instanceHome,
      input.agentName,
      input.provider,
      input.account,
      input.pool,
      input.model,
      input.effort ?? null,
      input.category,
      input.estimatedUnits,
      input.estimatedWeeklyUnits ?? null,
      input.now,
      input.expiresAt,
      input.purpose ?? "agent",
      input.controlMessageId ?? null,
    );
  }

  tryReserve(input: ReserveQuotaInput): QuotaReservation | null {
    const result = this.tryReserveGroup([input]);
    return result.ok ? result.reservations[0]! : null;
  }

  /**
   * Reserve one run against every pool that meters it, all or nothing.
   *
   * A model with its own cap spends from two meters at once — the account-wide
   * pool and its own — and a run is only safe when *both* have room. Taking the
   * pools one at a time would admit a run that fits the general pool and blows
   * the model's cap, which is exactly how two deep-category agents landed on a model
   * whose weekly pool was already at 99%. The tightest pool governs, and the
   * caller is told which one refused so it can say so out loud.
   */
  tryReserveGroup(inputs: ReserveQuotaInput[]):
    | { ok: true; reservations: QuotaReservation[] }
    | { ok: false; blockedBy: ReserveQuotaInput }
  {
    if (inputs.length === 0) {
      throw new Error("a reservation must name at least one pool");
    }
    return this.immediate(() => {
      const primary = inputs[0]!;
      if (primary.controlMessageId !== undefined) {
        const existing = this.getActiveControlReservation(
          primary.controlMessageId,
        );
        if (existing !== null) {
          return { ok: true as const, reservations: [existing] };
        }
      }
      // Every pool is checked before any row is written, so a refusal leaves the
      // ledger exactly as it found it.
      for (const input of inputs) {
        if (!this.fits(input)) return { ok: false as const, blockedBy: input };
      }
      for (const input of inputs) this.insert(input, primary.id);
      return {
        ok: true as const,
        reservations: inputs.map((input) => this.getReservation(input.id)!),
      };
    });
  }

  /**
   * Atomically choose and reserve by weighted-fair deficit over Hive-observed
   * assignments. Every historical dispatch credits each provider that was
   * eligible an equal share and charges the selected provider one unit. A
   * sole-capable dispatch therefore creates no debt. Quota percentages never
   * enter this comparison, so unlike windows are never compared and a
   * not-metered provider needs no fabricated headroom score.
   */
  tryReserveFairGroups(candidates: Array<{
    provider: CapabilityProvider;
    inputs: ReserveQuotaInput[];
  }>):
    | { ok: true; candidateIndex: number; reservations: QuotaReservation[] }
    | { ok: false; blocked: Array<{ candidateIndex: number; blockedBy: ReserveQuotaInput }> }
  {
    if (candidates.length === 0) throw new Error("fair dispatch requires a candidate");
    return this.immediate(() => {
      const active = candidates.map((candidate, candidateIndex) => ({
        ...candidate,
        candidateIndex,
      }));
      const blocked: Array<{ candidateIndex: number; blockedBy: ReserveQuotaInput }> = [];
      while (active.length > 0) {
        const providers = [...new Set(active.map((candidate) => candidate.provider))];
        const deficit = new Map(providers.map((provider) => [provider, 0]));
        const rows = (this.db.database.query(`
          SELECT selectedProvider, eligibleProviders
          FROM quota_fair_dispatch ORDER BY id DESC LIMIT 1000
        `).all() as Array<{ selectedProvider: string; eligibleProviders: string }>).reverse();
        for (const row of rows) {
          let eligible: CapabilityProvider[];
          let selected: CapabilityProvider;
          try {
            eligible = z.array(CapabilityProviderSchema).parse(
              JSON.parse(row.eligibleProviders),
            );
            selected = CapabilityProviderSchema.parse(row.selectedProvider);
          } catch {
            throw new QuotaLedgerUnknownError("its fair-dispatch history is unreadable");
          }
          const relevant = eligible.filter((provider) => deficit.has(provider));
          if (relevant.length === 0) continue;
          for (const provider of relevant) {
            deficit.set(
              provider,
              deficit.get(provider)! + 1 / relevant.length,
            );
          }
          if (deficit.has(selected)) {
            deficit.set(selected, deficit.get(selected)! - 1);
          }
        }
        for (const provider of providers) {
          deficit.set(provider, deficit.get(provider)! + 1 / providers.length);
        }
        const providerOrder = [...providers].sort((left, right) =>
          deficit.get(right)! - deficit.get(left)! ||
          providers.indexOf(left) - providers.indexOf(right)
        );
        const chosen = providerOrder.flatMap((provider) =>
          active.filter((candidate) => candidate.provider === provider)
        )[0]!;
        const blockedInput = chosen.inputs.find((input) => !this.fits(input));
        if (blockedInput !== undefined) {
          blocked.push({
            candidateIndex: chosen.candidateIndex,
            blockedBy: blockedInput,
          });
          active.splice(active.indexOf(chosen), 1);
          continue;
        }
        const primary = chosen.inputs[0]!;
        for (const input of chosen.inputs) this.insert(input, primary.id);
        this.db.database.query(`
          INSERT INTO quota_fair_dispatch
            (selectedAt, selectedProvider, eligibleProviders, reservationId)
          VALUES (?, ?, ?, ?)
        `).run(primary.now, chosen.provider, JSON.stringify(providers), primary.id);
        return {
          ok: true as const,
          candidateIndex: chosen.candidateIndex,
          reservations: chosen.inputs.map((input) => this.getReservation(input.id)!),
        };
      }
      return { ok: false as const, blocked };
    });
  }

  insertUnboundedReservation(input: Omit<ReserveQuotaInput,
    | "fiveHourStart" | "weeklyStart"
    | "supplementalFiveHourUsed" | "supplementalWeeklyUsed"
    | "fiveHourAllowance" | "weeklyAllowance"
    | "fiveHourFloor" | "weeklyFloor"
  >): QuotaReservation {
    return this.immediate(() => {
      if (input.controlMessageId !== undefined) {
        const existing = this.getActiveControlReservation(input.controlMessageId);
        if (existing !== null) return existing;
      }
      this.insert(
        {
          ...input,
          fiveHourStart: input.now,
          weeklyStart: input.now,
          supplementalFiveHourUsed: 0,
          supplementalWeeklyUsed: 0,
          fiveHourAllowance: 0,
          weeklyAllowance: 0,
          fiveHourFloor: 0,
          weeklyFloor: 0,
        },
        input.id,
      );
      return this.getReservation(input.id)!;
    });
  }

  /** Replace one provider's catalog as one snapshot, never a mix of two reads. */
  replaceModelCatalog(
    provider: CapabilityProvider,
    entries: ModelCatalogRow[],
  ): void {
    this.immediate(() => {
      this.db.database.query(
        "DELETE FROM quota_model_catalog WHERE provider = ?",
      ).run(provider);
      for (const entry of entries) {
        const value = ModelCatalogSchema.parse(entry);
        if (value.provider !== provider) {
          throw new Error(
            `Cannot store ${value.provider} catalog row in ${provider} snapshot`,
          );
        }
        this.db.database.query(`
          INSERT INTO quota_model_catalog (
            provider, modelId, displayName, discoveredAt
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(provider, modelId, displayName) DO UPDATE SET
            discoveredAt = excluded.discoveredAt
        `).run(
          value.provider,
          value.modelId,
          value.displayName,
          value.discoveredAt,
        );
      }
    });
  }

  /** A launch that never proved life. The route is suspect until one does. */
  recordLaunchFailure(
    provider: CapabilityProvider,
    model: string,
    effort: string | null,
    reason: string,
    at: string,
  ): void {
    this.db.database.query(`
      INSERT INTO quota_route_health (
        provider, model, effort, consecutiveFailures, lastFailureAt, lastFailureReason,
        lastSuccessAt
      ) VALUES (?, ?, ?, 1, ?, ?, NULL)
      ON CONFLICT(provider, model, effort) DO UPDATE SET
        consecutiveFailures = quota_route_health.consecutiveFailures + 1,
        lastFailureAt = excluded.lastFailureAt,
        lastFailureReason = excluded.lastFailureReason
    `).run(provider, model, effort ?? "", at, reason);
  }

  /**
   * An agent came up on this route. That is proof, and it wipes the slate: one
   * working launch says more about a route than any number of old failures, and
   * it is what lets the guard release the route the instant it is fixed.
   */
  recordLaunchSuccess(
    provider: CapabilityProvider,
    model: string,
    effort: string | null,
    at: string,
  ): void {
    this.db.database.query(`
      INSERT INTO quota_route_health (
        provider, model, effort, consecutiveFailures, lastFailureAt, lastFailureReason,
        lastSuccessAt
      ) VALUES (?, ?, ?, 0, NULL, NULL, ?)
      ON CONFLICT(provider, model, effort) DO UPDATE SET
        consecutiveFailures = 0,
        lastFailureAt = NULL,
        lastFailureReason = NULL,
        lastSuccessAt = excluded.lastSuccessAt
    `).run(provider, model, effort ?? "", at);
  }

  routeHealth(
    provider: CapabilityProvider,
    model: string,
    effort: string | null = null,
  ): RouteHealth | null {
    const row = this.db.database.query(
      "SELECT provider, model, NULLIF(effort, '') AS effort, consecutiveFailures, lastFailureAt, lastFailureReason, lastSuccessAt FROM quota_route_health WHERE provider = ? AND model = ? AND effort = ?",
    ).get(provider, model, effort ?? "");
    return row === null ? null : RouteHealthSchema.parse(row);
  }

  modelCatalog(): ModelCatalogRow[] {
    return this.db.database.query(
      "SELECT * FROM quota_model_catalog ORDER BY provider, modelId, displayName",
    ).all().map((row) => ModelCatalogSchema.parse(row));
  }

  /**
   * Book a run against its pools without asking whether they have room.
   *
   * This is for a run that is *already happening* — an agent whose model changed
   * under Hive after it launched. Refusing the booking would not stop the agent;
   * it would only mean the capacity it is visibly burning goes unrecorded, which
   * is the exact blindness the quota gate exists to end. So the spend is written,
   * the pool may go over, and the alert says so.
   */
  reserveGroupUnchecked(inputs: ReserveQuotaInput[]): QuotaReservation[] {
    if (inputs.length === 0) return [];
    return this.immediate(() => {
      const primary = inputs[0]!;
      for (const input of inputs) this.insert(input, primary.id);
      return inputs.map((input) => this.getReservation(input.id)!);
    });
  }

  /**
   * Record a pool the provider told us about. Discovery is idempotent and
   * additive: re-probing refreshes window durations and the model list without
   * disturbing observations, reservations, or alert state keyed to the scope.
   */
  upsertDiscoveredPool(pool: DiscoveredQuotaPool): DiscoveredQuotaPool {
    const value = DiscoveredPoolSchema.parse(pool);
    this.db.database.query(`
      INSERT INTO quota_pools (
        provider, account, pool, models, label, fiveHourWindowMinutes,
        weeklyWindowMinutes, fiveHourMeterState, weeklyMeterState,
        discoveredAt, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account, pool) DO UPDATE SET
        models = excluded.models,
        label = excluded.label,
        fiveHourWindowMinutes = CASE
          WHEN excluded.fiveHourMeterState = 'unknown'
            THEN quota_pools.fiveHourWindowMinutes
          ELSE excluded.fiveHourWindowMinutes
        END,
        weeklyWindowMinutes = CASE
          WHEN excluded.weeklyMeterState = 'unknown'
            THEN quota_pools.weeklyWindowMinutes
          ELSE excluded.weeklyWindowMinutes
        END,
        fiveHourMeterState = excluded.fiveHourMeterState,
        weeklyMeterState = excluded.weeklyMeterState,
        discoveredAt = excluded.discoveredAt,
        source = excluded.source
    `).run(
      value.provider,
      value.account,
      value.pool,
      JSON.stringify(value.models),
      value.label,
      value.fiveHourWindowMinutes,
      value.weeklyWindowMinutes,
      value.fiveHourMeterState,
      value.weeklyMeterState,
      value.discoveredAt,
      value.source,
    );
    return value;
  }

  discoveredPools(): DiscoveredQuotaPool[] {
    return this.db.database.query(
      "SELECT * FROM quota_pools ORDER BY provider, account, pool",
    ).all().map((row) => {
      const record = z.object({ models: z.string() }).passthrough().parse(row);
      return DiscoveredPoolSchema.parse({
        ...record,
        models: z.array(z.string()).parse(JSON.parse(record.models)),
      });
    });
  }

  getReservation(id: string): QuotaReservation | null {
    const row = this.db.database.query(
      "SELECT * FROM quota_reservations WHERE id = ?",
    ).get(id);
    return row === null ? null : ReservationSchema.parse(row);
  }

  getActiveReservationForAgent(agentName: string): QuotaReservation | null {
    const row = this.db.database.query(`
      SELECT * FROM quota_reservations
      WHERE instanceId = ? AND agentName = ? AND status = 'active'
      ORDER BY createdAt DESC LIMIT 1
    `).get(this.instanceId, agentName);
    return row === null ? null : ReservationSchema.parse(row);
  }

  getActiveControlReservation(controlMessageId: string): QuotaReservation | null {
    const row = this.db.database.query(`
      SELECT * FROM quota_reservations
      WHERE controlMessageId = ? AND status = 'active'
      ORDER BY createdAt DESC LIMIT 1
    `).get(controlMessageId);
    return row === null ? null : ReservationSchema.parse(row);
  }

  /**
   * Every row a run holds. A run gated by two pools settles both together;
   * settling only the row whose id the caller happens to hold would strand the
   * other pool's reservation until its TTL expired, quietly withholding headroom
   * from every spawn in between.
   */
  private group(id: string): QuotaReservation[] {
    return this.db.database.query(`
      SELECT * FROM quota_reservations
      WHERE groupId = COALESCE(
        (SELECT groupId FROM quota_reservations WHERE id = ?), ?
      ) OR id = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, pool
    `).all(id, id, id, id).map((row) => ReservationSchema.parse(row));
  }

  markStarted(id: string, startedAt: string): QuotaReservation | null {
    this.db.database.query(`
      UPDATE quota_reservations SET startedAt = COALESCE(startedAt, ?)
      WHERE groupId = COALESCE(
        (SELECT groupId FROM quota_reservations WHERE id = ?), ?
      ) AND status = 'active'
    `).run(startedAt, id, id);
    return this.getReservation(id);
  }

  reconcile(
    id: string,
    units: number,
    weeklyUnits: number,
    source: "provider" | "gateway" | "estimated",
    occurredAt: string,
  ): QuotaReservation | null {
    return this.immediate(() => {
      this.requireIntegrity();
      for (const reservation of this.group(id)) {
        if (reservation.status !== "active") continue;
        this.db.database.query(`
          UPDATE quota_reservations
          SET status = 'reconciled', reconciledAt = ?, actualUnits = ?, source = ?
          WHERE id = ? AND status = 'active'
        `).run(occurredAt, units, source, reservation.id);
        // The spend lands in each pool the run drew from. Both are percent of
        // their own window, so the same figure is the honest debit for each.
        const seq = this.nextUsageSeq();
        const inserted = this.db.database.query(`
          INSERT OR IGNORE INTO quota_usage (
            id, reservationId, provider, account, pool, model,
            units, weeklyUnits, occurredAt, source, confidence, seq
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `).get(
          crypto.randomUUID(),
          reservation.id,
          reservation.provider,
          reservation.account,
          reservation.pool,
          reservation.model,
          units,
          weeklyUnits,
          occurredAt,
          source,
          source === "estimated" ? "estimated" : "authoritative",
          seq,
        );
        if (inserted === null) {
          throw new QuotaLedgerUnknownError(
            `the spend for reservation ${reservation.id} could not be recorded exactly once`,
          );
        }
      }
      return this.getReservation(id);
    });
  }

  release(id: string, releasedAt: string): QuotaReservation | null {
    this.db.database.query(`
      UPDATE quota_reservations
      SET status = 'released', reconciledAt = ?, actualUnits = 0, source = 'released'
      WHERE groupId = COALESCE(
        (SELECT groupId FROM quota_reservations WHERE id = ?), ?
      ) AND status = 'active'
    `).run(releasedAt, id, id);
    return this.getReservation(id);
  }

  activeReservations(): QuotaReservation[] {
    return this.db.database.query(
      "SELECT * FROM quota_reservations WHERE instanceId = ? AND status = 'active' ORDER BY createdAt, id",
    ).all(this.instanceId).map((row) => ReservationSchema.parse(row));
  }

  async expired(_now: string): Promise<QuotaReservation[]> {
    const rows = this.db.database.query(`
      SELECT * FROM quota_reservations
      WHERE status = 'active'
      ORDER BY expiresAt, id
    `).all().map((row) => ReservationSchema.parse(row));
    const reclaimable: QuotaReservation[] = [];
    for (const row of rows) {
      const liveness = await this.instanceLiveness(row.instanceHome, row.instanceId);
      if (liveness === "dead") {
        reclaimable.push(row);
      }
      // Unknown ownership is preserved. In particular, a daemon between lock
      // acquisition and handshake publication must never lose a reservation.
      // A live daemon owns its reservation until it settles it. Wall-clock TTL
      // is not authority to cancel work a sibling positively proves is alive.
    }
    return reclaimable;
  }

  /**
   * Merge an observation window-by-window. A payload that reports only the
   * five-hour window leaves the stored weekly fact — and its older timestamp —
   * exactly as it was, so a partial report can never make a stale number look
   * fresh. Each window advances only when the incoming reading is newer.
   */
  upsertObservation(observation: QuotaObservation): QuotaObservation {
    const value = QuotaObservationSchema.parse(observation);
    return this.immediate(() => {
      const prior = this.getObservation(value);
      const merged = mergeObservationWindows(prior, value);
      const stored = this.watermarks(value);
      /**
       * A reading's boundary is pinned the moment it lands, and never moved
       * again. Only a window whose reading is *strictly* newer than the stored
       * one gets a fresh boundary; a repeat of the same instant is the same
       * measurement and keeps the boundary it already had. Recomputing an old
       * reading's boundary against rows written since would let it grow forward
       * and swallow — stop counting — spend it never saw, which is the very
       * under-count this whole mechanism exists to prevent.
       */
      const pin = (
        incomingAt: string | null,
        priorAt: string | null,
        priorSeq: number | null,
        mergedAt: string | null,
      ): number | null => {
        if (incomingAt !== null && (priorAt === null || incomingAt > priorAt)) {
          return this.usageWatermark(value, incomingAt);
        }
        return priorSeq ?? this.usageWatermark(value, mergedAt);
      };
      this.db.database.query(`
        INSERT INTO quota_observations (
          provider, account, pool, fiveHourUsed, weeklyUsed, observedAt,
          fiveHourResetAt, weeklyResetAt, source, confidence,
          fiveHourObservedAt, fiveHourSource, fiveHourConfidence,
          weeklyObservedAt, weeklySource, weeklyConfidence,
          fiveHourUsageSeq, weeklyUsageSeq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, account, pool) DO UPDATE SET
          fiveHourUsed = excluded.fiveHourUsed,
          weeklyUsed = excluded.weeklyUsed,
          observedAt = excluded.observedAt,
          fiveHourResetAt = excluded.fiveHourResetAt,
          weeklyResetAt = excluded.weeklyResetAt,
          source = excluded.source,
          confidence = excluded.confidence,
          fiveHourObservedAt = excluded.fiveHourObservedAt,
          fiveHourSource = excluded.fiveHourSource,
          fiveHourConfidence = excluded.fiveHourConfidence,
          weeklyObservedAt = excluded.weeklyObservedAt,
          weeklySource = excluded.weeklySource,
          weeklyConfidence = excluded.weeklyConfidence,
          fiveHourUsageSeq = excluded.fiveHourUsageSeq,
          weeklyUsageSeq = excluded.weeklyUsageSeq
      `).run(
        merged.provider,
        merged.account,
        merged.pool,
        merged.fiveHourUsed,
        merged.weeklyUsed,
        merged.observedAt,
        merged.fiveHourResetAt,
        merged.weeklyResetAt,
        merged.source,
        merged.confidence,
        merged.fiveHourObservedAt,
        merged.fiveHourSource,
        merged.fiveHourConfidence,
        merged.weeklyObservedAt,
        merged.weeklySource,
        merged.weeklyConfidence,
        pin(
          value.fiveHourObservedAt,
          prior?.fiveHourObservedAt ?? null,
          stored.fiveHour,
          merged.fiveHourObservedAt,
        ),
        pin(
          value.weeklyObservedAt,
          prior?.weeklyObservedAt ?? null,
          stored.weekly,
          merged.weeklyObservedAt,
        ),
      );
      return this.getObservation(merged)!;
    });
  }

  getObservation(scope: QuotaScope): QuotaObservation | null {
    // Named, not `*`: an observation is what the provider said, and the usage
    // watermarks alongside it are Hive's own bookkeeping. Selecting them here
    // would smuggle them into a fact that is supposed to be the provider's.
    const row = this.db.database.query(`
      SELECT
        provider, account, pool, fiveHourUsed, weeklyUsed, observedAt,
        fiveHourResetAt, weeklyResetAt, source, confidence,
        fiveHourObservedAt, fiveHourSource, fiveHourConfidence,
        weeklyObservedAt, weeklySource, weeklyConfidence
      FROM quota_observations
      WHERE provider = ? AND account = ? AND pool = ?
    `).get(scope.provider, scope.account, scope.pool);
    if (row === null) return null;
    try {
      const parsed = QuotaObservationSchema.parse(row);
      // Rows written before per-window provenance existed carry real readings
      // for both windows under a single row-level stamp. Absent that backfill
      // they would read as "never observed" and discard a true measurement.
      if (
        parsed.fiveHourObservedAt === null && parsed.weeklyObservedAt === null
      ) {
        return {
          ...parsed,
          fiveHourObservedAt: parsed.observedAt,
          fiveHourSource: parsed.source,
          fiveHourConfidence: parsed.confidence,
          weeklyObservedAt: parsed.observedAt,
          weeklySource: parsed.source,
          weeklyConfidence: parsed.confidence,
        };
      }
      return parsed;
    } catch (error) {
      throw new Error(
        `Corrupt quota observation for ${scope.provider}/${scope.account}/${scope.pool}: ${
          error instanceof Error ? error.message : "invalid row"
        }`,
      );
    }
  }

  getAlertState(
    scope: QuotaScope,
    window: QuotaAlertState["window"],
  ): QuotaAlertState | null {
    const row = this.db.database.query(`
      SELECT * FROM quota_alerts
      WHERE provider = ? AND account = ? AND pool = ? AND window = ?
    `).get(scope.provider, scope.account, scope.pool, window);
    return row === null ? null : AlertStateSchema.parse(row);
  }

  setAlertState(state: QuotaAlertState): QuotaAlertState {
    const value = AlertStateSchema.parse(state);
    this.db.database.query(`
      INSERT INTO quota_alerts (
        provider, account, pool, window, level, notifiedAt, boundaryAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account, pool, window) DO UPDATE SET
        level = excluded.level,
        notifiedAt = excluded.notifiedAt,
        boundaryAt = excluded.boundaryAt
    `).run(
      value.provider,
      value.account,
      value.pool,
      value.window,
      value.level,
      value.notifiedAt,
      value.boundaryAt,
    );
    return value;
  }
}
