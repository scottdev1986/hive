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
  afterObservation: number;
  reserved: number;
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
  now: string;
  expiresAt: string;
  fiveHourStart: string;
  weeklyStart: string;
  observationAt: string | null;
  supplementalFiveHourUsed: number;
  supplementalWeeklyUsed: number;
  fiveHourAllowance: number;
  weeklyAllowance: number;
  fiveHourFloor: number;
  weeklyFloor: number;
  purpose?: "agent" | "control";
  controlMessageId?: string;
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
    `);
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
    observationAt: string | null = null,
  ): UsageTotals {
    const row = z.object({
      fiveHour: z.number(),
      weekly: z.number(),
      afterObservation: z.number(),
    }).parse(this.db.database.query(`
      SELECT
        COALESCE(SUM(CASE WHEN occurredAt >= ? THEN units ELSE 0 END), 0) AS fiveHour,
        COALESCE(SUM(CASE WHEN occurredAt >= ? THEN units ELSE 0 END), 0) AS weekly,
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND occurredAt > ? THEN units ELSE 0 END), 0) AS afterObservation
      FROM quota_usage
      WHERE provider = ? AND account = ? AND pool = ?
    `).get(
      fiveHourStart,
      weeklyStart,
      observationAt,
      observationAt,
      scope.provider,
      scope.account,
      scope.pool,
    ));
    const reservation = z.object({ reserved: z.number() }).parse(
      this.db.database.query(`
        SELECT COALESCE(SUM(estimatedUnits), 0) AS reserved
        FROM quota_reservations
        WHERE provider = ? AND account = ? AND pool = ? AND status = 'active'
      `).get(scope.provider, scope.account, scope.pool),
    );
    return { ...row, reserved: reservation.reserved };
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
        input.observationAt,
      );
      const fiveHourCommitted = totals.fiveHour + totals.reserved +
        input.supplementalFiveHourUsed + input.estimatedUnits;
      const weeklyCommitted = totals.weekly + totals.reserved +
        input.supplementalWeeklyUsed + input.estimatedUnits;
      if (
        fiveHourCommitted > input.fiveHourAllowance - input.fiveHourFloor ||
        weeklyCommitted > input.weeklyAllowance - input.weeklyFloor
      ) {
        return null;
      }
      this.db.database.query(`
        INSERT INTO quota_reservations (
          id, agentName, provider, account, pool, model, tier,
          estimatedUnits, status, createdAt, expiresAt,
          startedAt, reconciledAt, actualUnits, source, purpose,
          controlMessageId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        input.id,
        input.agentName,
        input.provider,
        input.account,
        input.pool,
        input.model,
        input.tier,
        input.estimatedUnits,
        input.now,
        input.expiresAt,
        input.purpose ?? "agent",
        input.controlMessageId ?? null,
      );
      return this.getReservation(input.id);
    });
  }

  insertUnboundedReservation(input: Omit<ReserveQuotaInput,
    | "fiveHourStart" | "weeklyStart" | "observationAt"
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
          estimatedUnits, status, createdAt, expiresAt,
          startedAt, reconciledAt, actualUnits, source, purpose,
          controlMessageId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        input.id,
        input.agentName,
        input.provider,
        input.account,
        input.pool,
        input.model,
        input.tier,
        input.estimatedUnits,
        input.now,
        input.expiresAt,
        input.purpose ?? "agent",
        input.controlMessageId ?? null,
      );
      return this.getReservation(input.id)!;
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
          units, occurredAt, source, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        id,
        reservation.provider,
        reservation.account,
        reservation.pool,
        reservation.model,
        units,
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

  upsertObservation(observation: QuotaObservation): QuotaObservation {
    const value = QuotaObservationSchema.parse(observation);
    this.db.database.query(`
      INSERT INTO quota_observations (
        provider, account, pool, fiveHourUsed, weeklyUsed, observedAt,
        fiveHourResetAt, weeklyResetAt, source, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account, pool) DO UPDATE SET
        fiveHourUsed = excluded.fiveHourUsed,
        weeklyUsed = excluded.weeklyUsed,
        observedAt = excluded.observedAt,
        fiveHourResetAt = excluded.fiveHourResetAt,
        weeklyResetAt = excluded.weeklyResetAt,
        source = excluded.source,
        confidence = excluded.confidence
      WHERE excluded.observedAt >= quota_observations.observedAt
    `).run(
      value.provider,
      value.account,
      value.pool,
      value.fiveHourUsed,
      value.weeklyUsed,
      value.observedAt,
      value.fiveHourResetAt,
      value.weeklyResetAt,
      value.source,
      value.confidence,
    );
    return this.getObservation(value)!;
  }

  getObservation(scope: QuotaScope): QuotaObservation | null {
    const row = this.db.database.query(`
      SELECT * FROM quota_observations
      WHERE provider = ? AND account = ? AND pool = ?
    `).get(scope.provider, scope.account, scope.pool);
    if (row === null) return null;
    try {
      return QuotaObservationSchema.parse(row);
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
