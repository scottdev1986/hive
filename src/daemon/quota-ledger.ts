import { z } from "zod";
import {
  QuotaObservationSchema,
  RoutingTierSchema,
  type QuotaObservation,
  type QuotaScope,
  type RoutingTier,
} from "../schemas";
import type { HiveDatabase } from "./db";

const ReservationSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  provider: z.enum(["claude", "codex"]),
  account: z.string(),
  pool: z.string(),
  model: z.string(),
  tier: RoutingTierSchema,
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
  provider: z.enum(["claude", "codex"]),
  account: z.string(),
  pool: z.string(),
  /** Empty means the pool is informational: it never matches a routing model. */
  models: z.array(z.string()),
  /** The provider's own name for the pool, e.g. a plan or metered limit name. */
  label: z.string().nullable(),
  fiveHourWindowMinutes: z.number().nullable(),
  weeklyWindowMinutes: z.number().nullable(),
  discoveredAt: z.string(),
  source: z.enum(["provider", "statusline"]),
});
export type DiscoveredQuotaPool = z.infer<typeof DiscoveredPoolSchema>;

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

/**
 * Each window is observed on its own schedule, so each carries its own cutoff.
 * Using one row-level timestamp for both would drop every unit spent between an
 * older weekly reading and a newer five-hour one, and that spend is exactly the
 * headroom a concurrent spawn would then overcommit.
 */
export interface ObservationCutoffs {
  fiveHourObservedAt: string | null;
  weeklyObservedAt: string | null;
}

export interface UnconfiguredQuotaScope extends QuotaScope {
  model: string;
}

export interface ReserveQuotaInput extends QuotaScope {
  id: string;
  agentName: string;
  model: string;
  tier: RoutingTier;
  estimatedUnits: number;
  estimatedWeeklyUnits?: number;
  now: string;
  expiresAt: string;
  fiveHourStart: string;
  weeklyStart: string;
  fiveHourObservedAt: string | null;
  weeklyObservedAt: string | null;
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
  constructor(private readonly db: HiveDatabase) {
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
        confidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quota_usage_scope_time
        ON quota_usage(provider, account, pool, occurredAt);
      CREATE TABLE IF NOT EXISTS quota_reservations (
        id TEXT PRIMARY KEY,
        agentName TEXT NOT NULL,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        pool TEXT NOT NULL,
        model TEXT NOT NULL,
        tier TEXT NOT NULL,
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
        discoveredAt TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY(provider, account, pool)
      );
    `);
    const observationColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_observations)").all(),
    );
    const observationColumnNames = new Set(
      observationColumns.map((column) => column.name),
    );
    for (
      const column of [
        "fiveHourObservedAt",
        "fiveHourSource",
        "fiveHourConfidence",
        "weeklyObservedAt",
        "weeklySource",
        "weeklyConfidence",
      ]
    ) {
      if (observationColumnNames.has(column)) continue;
      this.db.database.exec(
        `ALTER TABLE quota_observations ADD COLUMN ${column} TEXT`,
      );
    }
    const reservationColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_reservations)").all(),
    );
    const reservationColumnNames = new Set(
      reservationColumns.map((column) => column.name),
    );
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
    const usageColumns = z.array(z.object({ name: z.string() })).parse(
      this.db.database.query("PRAGMA table_info(quota_usage)").all(),
    );
    if (!usageColumns.some((column) => column.name === "weeklyUnits")) {
      this.db.database.exec(
        "ALTER TABLE quota_usage ADD COLUMN weeklyUnits REAL",
      );
    }
    this.db.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS quota_reservations_active_control
      ON quota_reservations(controlMessageId)
      WHERE controlMessageId IS NOT NULL AND status = 'active'
    `);
  }

  private immediate<T>(operation: () => T): T {
    return this.db.database.transaction(operation).immediate();
  }

  usageTotals(
    scope: QuotaScope,
    fiveHourStart: string,
    weeklyStart: string,
    cutoffs: ObservationCutoffs = {
      fiveHourObservedAt: null,
      weeklyObservedAt: null,
    },
  ): UsageTotals {
    // A run consumes a different fraction of each window, so its weekly cost is
    // recorded alongside its five-hour cost rather than inferred from it. Rows
    // written before that distinction existed carry only `units` and fall back
    // to it, which is precisely their old behaviour.
    const row = z.object({
      fiveHour: z.number(),
      weekly: z.number(),
      afterFiveHourObservation: z.number(),
      afterWeeklyObservation: z.number(),
    }).parse(this.db.database.query(`
      SELECT
        COALESCE(SUM(CASE WHEN occurredAt >= ? THEN units ELSE 0 END), 0) AS fiveHour,
        COALESCE(SUM(CASE WHEN occurredAt >= ? THEN COALESCE(weeklyUnits, units) ELSE 0 END), 0) AS weekly,
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND occurredAt > ? THEN units ELSE 0 END), 0) AS afterFiveHourObservation,
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND occurredAt > ? THEN COALESCE(weeklyUnits, units) ELSE 0 END), 0) AS afterWeeklyObservation
      FROM quota_usage
      WHERE provider = ? AND account = ? AND pool = ?
    `).get(
      fiveHourStart,
      weeklyStart,
      cutoffs.fiveHourObservedAt,
      cutoffs.fiveHourObservedAt,
      cutoffs.weeklyObservedAt,
      cutoffs.weeklyObservedAt,
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
      provider: z.enum(["claude", "codex"]),
      account: z.string(),
      pool: z.string(),
      model: z.string(),
    }).parse(row));
  }

  tryReserve(input: ReserveQuotaInput): QuotaReservation | null {
    return this.immediate(() => {
      if (input.controlMessageId !== undefined) {
        const existing = this.getActiveControlReservation(input.controlMessageId);
        if (existing !== null) return existing;
      }
      const totals = this.usageTotals(
        input,
        input.fiveHourStart,
        input.weeklyStart,
        input,
      );
      const weeklyEstimate = input.estimatedWeeklyUnits ?? input.estimatedUnits;
      const fiveHourCommitted = totals.fiveHour + totals.reserved +
        input.supplementalFiveHourUsed + input.estimatedUnits;
      const weeklyCommitted = totals.weekly + totals.reservedWeekly +
        input.supplementalWeeklyUsed + weeklyEstimate;
      if (
        fiveHourCommitted > input.fiveHourAllowance - input.fiveHourFloor ||
        weeklyCommitted > input.weeklyAllowance - input.weeklyFloor
      ) {
        return null;
      }
      this.db.database.query(`
        INSERT INTO quota_reservations (
          id, agentName, provider, account, pool, model, tier,
          estimatedUnits, estimatedWeeklyUnits, status, createdAt, expiresAt,
          startedAt, reconciledAt, actualUnits, source, purpose,
          controlMessageId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        input.id,
        input.agentName,
        input.provider,
        input.account,
        input.pool,
        input.model,
        input.tier,
        input.estimatedUnits,
        input.estimatedWeeklyUnits ?? null,
        input.now,
        input.expiresAt,
        input.purpose ?? "agent",
        input.controlMessageId ?? null,
      );
      return this.getReservation(input.id);
    });
  }

  insertUnboundedReservation(input: Omit<ReserveQuotaInput,
    | "fiveHourStart" | "weeklyStart"
    | "fiveHourObservedAt" | "weeklyObservedAt"
    | "supplementalFiveHourUsed" | "supplementalWeeklyUsed"
    | "fiveHourAllowance" | "weeklyAllowance"
    | "fiveHourFloor" | "weeklyFloor"
  >): QuotaReservation {
    return this.immediate(() => {
      if (input.controlMessageId !== undefined) {
        const existing = this.getActiveControlReservation(input.controlMessageId);
        if (existing !== null) return existing;
      }
      this.db.database.query(`
        INSERT INTO quota_reservations (
          id, agentName, provider, account, pool, model, tier,
          estimatedUnits, estimatedWeeklyUnits, status, createdAt, expiresAt,
          startedAt, reconciledAt, actualUnits, source, purpose,
          controlMessageId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        input.id,
        input.agentName,
        input.provider,
        input.account,
        input.pool,
        input.model,
        input.tier,
        input.estimatedUnits,
        input.estimatedWeeklyUnits ?? null,
        input.now,
        input.expiresAt,
        input.purpose ?? "agent",
        input.controlMessageId ?? null,
      );
      return this.getReservation(input.id)!;
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
        weeklyWindowMinutes, discoveredAt, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account, pool) DO UPDATE SET
        models = excluded.models,
        label = excluded.label,
        fiveHourWindowMinutes = excluded.fiveHourWindowMinutes,
        weeklyWindowMinutes = excluded.weeklyWindowMinutes,
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
      WHERE agentName = ? AND status = 'active'
      ORDER BY createdAt DESC LIMIT 1
    `).get(agentName);
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

  markStarted(id: string, startedAt: string): QuotaReservation | null {
    this.db.database.query(`
      UPDATE quota_reservations SET startedAt = COALESCE(startedAt, ?)
      WHERE id = ? AND status = 'active'
    `).run(startedAt, id);
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
      const reservation = this.getReservation(id);
      if (reservation === null || reservation.status !== "active") {
        return reservation;
      }
      this.db.database.query(`
        UPDATE quota_reservations
        SET status = 'reconciled', reconciledAt = ?, actualUnits = ?, source = ?
        WHERE id = ? AND status = 'active'
      `).run(occurredAt, units, source, id);
      this.db.database.query(`
        INSERT OR IGNORE INTO quota_usage (
          id, reservationId, provider, account, pool, model,
          units, weeklyUnits, occurredAt, source, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        id,
        reservation.provider,
        reservation.account,
        reservation.pool,
        reservation.model,
        units,
        weeklyUnits,
        occurredAt,
        source,
        source === "estimated" ? "estimated" : "authoritative",
      );
      return this.getReservation(id);
    });
  }

  release(id: string, releasedAt: string): QuotaReservation | null {
    this.db.database.query(`
      UPDATE quota_reservations
      SET status = 'released', reconciledAt = ?, actualUnits = 0, source = 'released'
      WHERE id = ? AND status = 'active'
    `).run(releasedAt, id);
    return this.getReservation(id);
  }

  expired(now: string): QuotaReservation[] {
    return this.db.database.query(`
      SELECT * FROM quota_reservations
      WHERE status = 'active' AND expiresAt <= ?
      ORDER BY expiresAt, id
    `).all(now).map((row) => ReservationSchema.parse(row));
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
      this.db.database.query(`
        INSERT INTO quota_observations (
          provider, account, pool, fiveHourUsed, weeklyUsed, observedAt,
          fiveHourResetAt, weeklyResetAt, source, confidence,
          fiveHourObservedAt, fiveHourSource, fiveHourConfidence,
          weeklyObservedAt, weeklySource, weeklyConfidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          weeklyConfidence = excluded.weeklyConfidence
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
      );
      return this.getObservation(merged)!;
    });
  }

  getObservation(scope: QuotaScope): QuotaObservation | null {
    const row = this.db.database.query(`
      SELECT * FROM quota_observations
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
