import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  AgentMessageSchema,
  AgentRecordSchema,
  HookEventSchema,
  ExecutionIdentitySchema,
  TerminalHandleSchema,
  isTerminalAgentStatus,
  type AgentMessage,
  type AgentRecord,
  type HookEvent,
  type TerminalHandle,
} from "../schemas";

const StoredCapabilitySchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  role: z.enum(["operator", "orchestrator", "writer", "reader"]),
  epoch: z.number().int().nonnegative(),
  secretHash: z.string().min(1),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  revokedAt: z.string().nullable(),
});

const CapabilityRowSchema = StoredCapabilitySchema;

export type CapabilityRow = Omit<
  z.infer<typeof StoredCapabilitySchema>,
  "secretHash"
>;

export const AuditRowSchema = z.object({
  at: z.string().min(1),
  route: z.string().min(1),
  action: z.string().nullable(),
  callerSubject: z.string().nullable(),
  callerRole: z.string().nullable(),
  capabilityId: z.string().nullable(),
  requestedSubject: z.string().nullable(),
  epoch: z.number().int().nullable(),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().nullable(),
});

export type AuditRow = z.infer<typeof AuditRowSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  agentName: z.string().min(1),
  description: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  createdAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type Approval = z.infer<typeof ApprovalSchema>;

const AgentDatabaseRowSchema = AgentRecordSchema.extend({
  failureReason: z.string().nullable(),
  failedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  // Null on every row written before the model was observed separately from the
  // model it was launched with, and on every agent Hive has not observed yet.
  liveModel: z.string().nullable().default(null),
  quotaReservationId: z.string().nullable(),
  controlQuotaReservationId: z.string().nullable(),
  controlMessageId: z.string().nullable(),
  executionIdentity: z.string().nullable(),
  terminalHandle: z.string().nullable(),
  toolSessionId: z.string().nullable(),
  recoveryAttempts: z.number().int().nonnegative().default(0),
  capabilityEpoch: z.number().int().nonnegative().default(0),
  writeRevoked: z.union([z.boolean(), z.number().int()]).default(0),
  channelsEnabled: z.union([z.boolean(), z.number().int()]).default(0),
});

function parseAgentRow(row: unknown): AgentRecord {
  const value = AgentDatabaseRowSchema.parse(row);
  return AgentRecordSchema.parse({
    ...value,
    failureReason: value.failureReason ?? undefined,
    failedAt: value.failedAt ?? undefined,
    closedAt: value.closedAt ?? undefined,
    liveModel: value.liveModel ?? undefined,
    quotaReservationId: value.quotaReservationId ?? undefined,
    controlQuotaReservationId: value.controlQuotaReservationId ?? undefined,
    controlMessageId: value.controlMessageId ?? undefined,
    toolSessionId: value.toolSessionId ?? undefined,
    executionIdentity: value.executionIdentity === null
      ? undefined
      : ExecutionIdentitySchema.parse(JSON.parse(value.executionIdentity)),
    terminalHandle: value.terminalHandle === null
      ? undefined
      : TerminalHandleSchema.parse(JSON.parse(value.terminalHandle)),
    writeRevoked: value.writeRevoked === true || value.writeRevoked === 1,
    channelsEnabled: value.channelsEnabled === true ||
      value.channelsEnabled === 1,
  });
}

export function getHiveHome(): string {
  return process.env.HIVE_HOME ?? join(homedir(), ".hive");
}

export function getDatabasePath(): string {
  return join(getHiveHome(), "hive.db");
}

function parseEventRow(row: unknown): HookEvent {
  const value = z.object({
    kind: z.string(),
    agentName: z.string(),
    timestamp: z.string(),
    contextPct: z.number().nullable(),
    description: z.string().nullable(),
    usageUnits: z.number().nullable(),
    usageSource: z.string().nullable(),
  }).parse(row);

  if (value.kind === "turn-end") {
    return HookEventSchema.parse({
      kind: value.kind,
      agentName: value.agentName,
      timestamp: value.timestamp,
      ...(value.contextPct === null ? {} : { contextPct: value.contextPct }),
      ...(value.usageUnits === null ? {} : { usageUnits: value.usageUnits }),
      ...(value.usageSource === null ? {} : { usageSource: value.usageSource }),
    });
  }
  if (value.kind === "approval-request") {
    return HookEventSchema.parse({
      kind: value.kind,
      agentName: value.agentName,
      timestamp: value.timestamp,
      description: value.description,
    });
  }
  return HookEventSchema.parse({
    kind: value.kind,
    agentName: value.agentName,
    timestamp: value.timestamp,
  });
}

/**
 * The `agents` table, in one place.
 *
 * SQLite cannot relax a NOT NULL column in place, so a schema change like
 * "contextPct must be able to say *unknown*" is a table rebuild: create, copy,
 * drop, rename. There were three hand-maintained copies of this DDL — the
 * constructor's and two rebuilds — and a column added to one and forgotten in
 * another is silently dropped the next time a rebuild runs. One definition, used
 * by all three, is the only version of this that stays correct.
 */
function agentsTableDdl(table: string, ifNotExists = false): string {
  return `
    CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
      id TEXT PRIMARY KEY,
      -- Deliberately not UNIQUE: a name may be held by many agents across
      -- time, one at a time. agents_one_live_holder enforces the "one at a
      -- time" half; the row per holder preserves the closure history that a
      -- UNIQUE name would overwrite.
      name TEXT NOT NULL,
      tool TEXT NOT NULL,
      model TEXT NOT NULL,
      liveModel TEXT,
      tier TEXT NOT NULL,
      status TEXT NOT NULL,
      taskDescription TEXT NOT NULL,
      worktreePath TEXT,
      branch TEXT,
      tmuxSession TEXT NOT NULL,
      terminalHandle TEXT,
      -- Nullable on purpose: null is "not observed", which is a different fact
      -- from 0%, and 0% is the one that gets an agent overloaded.
      contextPct REAL,
      createdAt TEXT NOT NULL,
      lastEventAt TEXT NOT NULL,
      failureReason TEXT,
      failedAt TEXT,
      quotaReservationId TEXT,
      controlQuotaReservationId TEXT,
      controlMessageId TEXT,
      executionIdentity TEXT,
      toolSessionId TEXT,
      recoveryAttempts INTEGER NOT NULL DEFAULT 0,
      capabilityEpoch INTEGER NOT NULL DEFAULT 0,
      writeRevoked INTEGER NOT NULL DEFAULT 0,
      channelsEnabled INTEGER NOT NULL DEFAULT 0,
      closedAt TEXT
    )
  `;
}

/** One column as SQLite itself describes it, which is all a rebuild can know
 * about a column no version of this code has ever heard of. */
const AgentColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  /** The raw SQL text of the default, e.g. `'us-east-1'` or `0`. */
  dflt_value: z.union([z.string(), z.number()]).nullable(),
});
type AgentColumn = z.infer<typeof AgentColumnSchema>;

const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

/**
 * Recreate a column Hive's DDL does not define, as faithfully as SQLite's own
 * description of it allows.
 *
 * `NOT NULL` is kept only where a default comes with it, because SQLite refuses
 * `ADD COLUMN ... NOT NULL` without one — which is also the only way such a
 * column could have reached the old table. If one somehow did, the values are
 * worth more than the constraint: carrying them into a nullable column loses
 * nothing, and failing the migration would strand the whole table.
 */
const columnDefinition = (column: AgentColumn): string => {
  const type = column.type === "" ? "BLOB" : column.type;
  const hasDefault = column.dflt_value !== null;
  const notNull = column.notnull === 1 && hasDefault ? " NOT NULL" : "";
  const dflt = hasDefault ? ` DEFAULT ${column.dflt_value}` : "";
  return `${quoteIdentifier(column.name)} ${type}${notNull}${dflt}`;
};

export class HiveDatabase {
  readonly path: string;
  readonly database: Database;

  constructor(path = getDatabasePath()) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(agentsTableDdl("agents", true));
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        body TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        deliveredAt TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        intent TEXT NOT NULL DEFAULT 'instruction',
        state TEXT NOT NULL DEFAULT 'queued',
        injectedAt TEXT,
        acknowledgedAt TEXT,
        appliedAt TEXT,
        deadlineAt TEXT,
        alertAt TEXT,
        sequence INTEGER NOT NULL DEFAULT 0,
        idempotencyKey TEXT,
        capabilityEpoch INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_recipient_delivery
        ON messages("to", deliveredAt, createdAt);
      CREATE TABLE IF NOT EXISTS agent_name_reservations (
        name TEXT PRIMARY KEY,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        agentName TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        contextPct REAL,
        description TEXT,
        usageUnits REAL,
        usageSource TEXT
      );
      CREATE INDEX IF NOT EXISTS events_agent_timestamp
        ON events(agentName, timestamp);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        agentName TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        resolvedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_status_created
        ON approvals(status, createdAt);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- Only sha256(secret) is stored, so a database or WAL leak yields no
      -- usable credential. The id is a lookup key, not a secret.
      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        role TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        secretHash TEXT NOT NULL,
        issuedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        revokedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS capabilities_subject ON capabilities(subject);
      -- A one-shot right is spent by inserting its row; the primary key makes
      -- the spend atomic, so two concurrent lands cannot both succeed.
      CREATE TABLE IF NOT EXISTS capability_consumptions (
        capabilityId TEXT NOT NULL,
        action TEXT NOT NULL,
        consumedAt TEXT NOT NULL,
        PRIMARY KEY (capabilityId, action)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        route TEXT NOT NULL,
        action TEXT,
        callerSubject TEXT,
        callerRole TEXT,
        capabilityId TEXT,
        requestedSubject TEXT,
        epoch INTEGER,
        decision TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
    `);
    const agentColumns = z.array(z.object({ name: z.string() })).parse(
      this.database.query("PRAGMA table_info(agents)").all(),
    );
    const agentColumnNames = new Set(agentColumns.map((column) => column.name));
    if (!agentColumnNames.has("failureReason")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN failureReason TEXT");
    }
    if (!agentColumnNames.has("failedAt")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN failedAt TEXT");
    }
    if (!agentColumnNames.has("terminalHandle")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN terminalHandle TEXT");
    }
    if (!agentColumnNames.has("quotaReservationId")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN quotaReservationId TEXT");
    }
    if (!agentColumnNames.has("controlQuotaReservationId")) {
      this.database.exec(
        "ALTER TABLE agents ADD COLUMN controlQuotaReservationId TEXT",
      );
    }
    if (!agentColumnNames.has("controlMessageId")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN controlMessageId TEXT");
    }
    if (!agentColumnNames.has("executionIdentity")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN executionIdentity TEXT");
    }
    if (!agentColumnNames.has("toolSessionId")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN toolSessionId TEXT");
    }
    if (!agentColumnNames.has("recoveryAttempts")) {
      this.database.exec(
        "ALTER TABLE agents ADD COLUMN recoveryAttempts INTEGER NOT NULL DEFAULT 0",
      );
    }
    const eventColumns = z.array(z.object({ name: z.string() })).parse(
      this.database.query("PRAGMA table_info(events)").all(),
    );
    const eventColumnNames = new Set(eventColumns.map((column) => column.name));
    if (!eventColumnNames.has("usageUnits")) {
      this.database.exec("ALTER TABLE events ADD COLUMN usageUnits REAL");
    }
    if (!eventColumnNames.has("usageSource")) {
      this.database.exec("ALTER TABLE events ADD COLUMN usageSource TEXT");
    }
    if (!agentColumnNames.has("capabilityEpoch")) {
      this.database.exec(
        "ALTER TABLE agents ADD COLUMN capabilityEpoch INTEGER NOT NULL DEFAULT 0",
      );
    }
    // The model an agent is *observed* running, which is a different fact from
    // `model` — the immutable launch identity decision 6 records so a control
    // restart reproduces the launch it is interrupting. A user who types `/model`
    // mid-session changes the first and must not touch the second. They were one
    // column, and the cost of conflating them was that quota was charged to a
    // model nobody was running and `hive status` reported it back as truth.
    // Null means "not observed", never "same as spawn".
    if (!agentColumnNames.has("liveModel")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN liveModel TEXT");
    }
    if (!agentColumnNames.has("writeRevoked")) {
      this.database.exec(
        "ALTER TABLE agents ADD COLUMN writeRevoked INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!agentColumnNames.has("channelsEnabled")) {
      this.database.exec(
        "ALTER TABLE agents ADD COLUMN channelsEnabled INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!agentColumnNames.has("closedAt")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN closedAt TEXT");
      // Backfill closure for holders that terminated before Hive tracked it.
      // failedAt is the only recorded terminal instant; lastEventAt is the
      // honest approximation for agents that died or finished.
      this.database.exec(`
        UPDATE agents SET closedAt = COALESCE(failedAt, lastEventAt)
        WHERE closedAt IS NULL AND status IN ('done', 'dead', 'failed')
      `);
    }
    this.dropLegacyUniqueAgentName();
    this.relaxContextPctNullability();
    this.database.exec(`
      -- The mechanical guarantee behind "a name means exactly one agent": at
      -- most one non-terminal row per name. A second spawn onto a live name
      -- fails on this index rather than on a check that raced.
      CREATE UNIQUE INDEX IF NOT EXISTS agents_one_live_holder
        ON agents(name) WHERE status NOT IN ('done', 'dead', 'failed');
      CREATE INDEX IF NOT EXISTS agents_name_history
        ON agents(name, createdAt);
    `);
    const messageColumns = z.array(z.object({ name: z.string() })).parse(
      this.database.query("PRAGMA table_info(messages)").all(),
    );
    const messageColumnNames = new Set(
      messageColumns.map((column) => column.name),
    );
    const messageMigrations = [
      ["priority", "TEXT NOT NULL DEFAULT 'normal'"],
      ["intent", "TEXT NOT NULL DEFAULT 'instruction'"],
      ["state", "TEXT NOT NULL DEFAULT 'queued'"],
      ["injectedAt", "TEXT"],
      ["acknowledgedAt", "TEXT"],
      ["appliedAt", "TEXT"],
      ["deadlineAt", "TEXT"],
      ["alertAt", "TEXT"],
      ["sequence", "INTEGER NOT NULL DEFAULT 0"],
      ["idempotencyKey", "TEXT"],
      ["capabilityEpoch", "INTEGER"],
    ] as const;
    for (const [name, definition] of messageMigrations) {
      if (!messageColumnNames.has(name)) {
        this.database.exec(
          `ALTER TABLE messages ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_idempotency
      ON messages("from", idempotencyKey)
      WHERE idempotencyKey IS NOT NULL
    `);
    // Created after the column migrations above: on a legacy database the
    // priority/state/sequence columns do not exist until they run. Critical-
    // control recovery hits this on every session-start and maintenance tick
    // and must never pay for the full message history.
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS messages_queued_critical
      ON messages(sequence) WHERE priority = 'critical' AND state = 'queued'
    `);
    this.database.exec(`
      UPDATE messages
      SET state = 'applied', injectedAt = COALESCE(injectedAt, deliveredAt)
      WHERE deliveredAt IS NOT NULL AND state = 'queued'
    `);
    const recoveredAt = new Date().toISOString();
    this.database.transaction(() => {
      // Older daemons incorrectly turned every informational notification
      // into a blocking approval. Preserve those rows as resolved history,
      // then release agents that have no genuine escalation outstanding.
      this.database.query(`
        UPDATE approvals SET status = 'approved', resolvedAt = ?
        WHERE status = 'pending'
          AND description = 'Notification from ' || agentName
      `).run(recoveredAt);
      this.database.query(`
        UPDATE agents SET status = 'idle', lastEventAt = ?
        WHERE status = 'awaiting-approval' AND writeRevoked = 0
          AND NOT EXISTS (
            SELECT 1 FROM approvals
            WHERE approvals.agentName = agents.name
              AND approvals.status = 'pending'
          )
      `).run(recoveredAt);
    })();
  }

  /**
   * Hive originally declared `name TEXT NOT NULL UNIQUE`, which forced a
   * respawn onto a recycled name to overwrite the dead holder's row — the very
   * closure history the daemon now has to show. SQLite cannot drop a table
   * constraint in place, so the table is rebuilt once, without it. Existing
   * rows are safe to copy: a UNIQUE name means there was never more than one
   * holder to collide.
   */
  private dropLegacyUniqueAgentName(): void {
    const indexes = z.array(
      z.object({ name: z.string(), unique: z.number(), origin: z.string() }),
    ).parse(this.database.query("PRAGMA index_list(agents)").all());
    const legacy = indexes.find((index) => {
      if (index.unique !== 1 || index.origin !== "u") return false;
      const columns = z.array(z.object({ name: z.string() })).parse(
        this.database.query(`PRAGMA index_info(${index.name})`).all(),
      );
      return columns.length === 1 && columns[0]!.name === "name";
    });
    if (legacy === undefined) return;

    this.rebuildAgentsTable("contextPct");
  }

  /** Everything the live `agents` table declares, column by column. */
  private agentColumns(): AgentColumn[] {
    return z.array(AgentColumnSchema).parse(
      this.database.query("PRAGMA table_info(agents)").all(),
    );
  }

  /** The columns the live `agents` table actually has. */
  private agentColumnNames(): Set<string> {
    return new Set(this.agentColumns().map((column) => column.name));
  }

  /**
   * Rebuild `agents` onto the current DDL — the only way SQLite lets a column
   * stop being NOT NULL. `contextPctExpression` is the SQL that produces the new
   * `contextPct`: `"contextPct"` preserves it, `"NULL"` discards it.
   *
   * Every column the old table had is carried across, including ones this build
   * has never heard of. A rebuild that copied only a hand-maintained list of
   * known columns would permanently drop the rest and their values with them — a
   * newer Hive's column erased by an older one, or a hand-added column erased by
   * any of them — and it had already started doing exactly that to `liveModel`.
   * So neither table is described from memory: the old one's columns come from
   * SQLite, the new one's come from SQLite, and any column the new table lacks is
   * recreated on it from the old one's own declaration. Dropping a column has to
   * be a decision somebody made, never a side effect of not recognising it.
   *
   * The rebuild runs before the agents indexes are created, so dropping the table
   * takes no index of Hive's with it.
   */
  private rebuildAgentsTable(contextPctExpression: string): void {
    const columns = this.agentColumns();
    const targets = columns
      .map((column) => quoteIdentifier(column.name))
      .join(", ");
    const sources = columns
      .map((column) =>
        column.name === "contextPct"
          ? `${contextPctExpression} AS contextPct`
          : quoteIdentifier(column.name)
      )
      .join(", ");
    // Restore enforcement to whatever it was, even if the rebuild throws. A
    // connection that silently stops enforcing foreign keys for the rest of its
    // life is a worse outcome than the failed migration that caused it, and it
    // would never announce itself.
    const enforced = z.array(z.object({ foreign_keys: z.number() })).parse(
      this.database.query("PRAGMA foreign_keys").all(),
    )[0]?.foreign_keys ?? 1;
    this.database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.database.transaction(() => {
        this.database.exec(agentsTableDdl("agents_rebuilt"));
        const defined = new Set(
          z.array(z.object({ name: z.string() })).parse(
            this.database.query("PRAGMA table_info(agents_rebuilt)").all(),
          ).map((column) => column.name),
        );
        for (const column of columns) {
          if (defined.has(column.name)) continue;
          this.database.exec(
            `ALTER TABLE agents_rebuilt ADD COLUMN ${columnDefinition(column)}`,
          );
        }
        this.database.exec(
          `INSERT INTO agents_rebuilt (${targets}) SELECT ${sources} FROM agents`,
        );
        this.database.exec("DROP TABLE agents");
        this.database.exec("ALTER TABLE agents_rebuilt RENAME TO agents");
      })();
    } finally {
      this.database.exec(
        `PRAGMA foreign_keys = ${enforced === 0 ? "OFF" : "ON"}`,
      );
    }
  }

  /**
   * Make "unknown" storable. `contextPct` was `REAL NOT NULL`, so an agent Hive
   * could not observe had nowhere to say so and kept its 0% spawn default — and
   * 0% does not mean "empty", it means "no idea", while reading like an invitation
   * to load more work on.
   *
   * Every existing value is discarded rather than carried across, and that is a
   * deliberate backfill decision, not laziness: those numbers were computed
   * against a hardcoded 200k window while agents ran 1M ones, so they are wrong
   * by up to 5x — the reason two agents sat pinned at 100% while actually near
   * 22%. Migrating known-wrong numbers forward would preserve exactly the lie
   * this column is being reshaped to stop telling. Null is honest, and the next
   * telemetry sweep re-observes every agent it can see.
   */
  private relaxContextPctNullability(): void {
    const notNull = z.array(z.object({ name: z.string(), notnull: z.number() }))
      .parse(this.database.query("PRAGMA table_info(agents)").all())
      .some((column) => column.name === "contextPct" && column.notnull === 1);
    if (!notNull) return;
    this.rebuildAgentsTable("NULL");
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  upsertAgent(agent: AgentRecord): AgentRecord {
    const value = AgentRecordSchema.parse(agent);
    const closedAt = this.resolveClosedAt(value);
    this.database.query(`
      INSERT INTO agents (
        id, name, tool, model, liveModel, tier, status, taskDescription,
        worktreePath, branch, tmuxSession, terminalHandle, contextPct,
        createdAt, lastEventAt, failureReason, failedAt,
        quotaReservationId, controlQuotaReservationId, controlMessageId,
        executionIdentity, toolSessionId, recoveryAttempts,
        capabilityEpoch, writeRevoked, channelsEnabled, closedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        tool = excluded.tool,
        model = excluded.model,
        liveModel = excluded.liveModel,
        tier = excluded.tier,
        status = excluded.status,
        taskDescription = excluded.taskDescription,
        worktreePath = excluded.worktreePath,
        branch = excluded.branch,
        tmuxSession = excluded.tmuxSession,
        terminalHandle = excluded.terminalHandle,
        contextPct = excluded.contextPct,
        createdAt = excluded.createdAt,
        lastEventAt = excluded.lastEventAt,
        failureReason = excluded.failureReason,
        failedAt = excluded.failedAt,
        quotaReservationId = excluded.quotaReservationId,
        controlQuotaReservationId = excluded.controlQuotaReservationId,
        controlMessageId = excluded.controlMessageId,
        executionIdentity = excluded.executionIdentity,
        toolSessionId = excluded.toolSessionId,
        recoveryAttempts = excluded.recoveryAttempts,
        capabilityEpoch = excluded.capabilityEpoch,
        writeRevoked = excluded.writeRevoked,
        channelsEnabled = excluded.channelsEnabled,
        closedAt = excluded.closedAt
    `).run(
      value.id,
      value.name,
      value.tool,
      value.model,
      value.liveModel ?? null,
      value.tier,
      value.status,
      value.taskDescription,
      value.worktreePath,
      value.branch,
      value.tmuxSession,
      value.terminalHandle === undefined
        ? null
        : JSON.stringify(value.terminalHandle),
      value.contextPct,
      value.createdAt,
      value.lastEventAt,
      value.failureReason ?? null,
      value.failedAt ?? null,
      value.quotaReservationId ?? null,
      value.controlQuotaReservationId ?? null,
      value.controlMessageId ?? null,
      value.executionIdentity === undefined
        ? null
        : JSON.stringify(value.executionIdentity),
      value.toolSessionId ?? null,
      value.recoveryAttempts,
      value.capabilityEpoch,
      value.writeRevoked ? 1 : 0,
      value.channelsEnabled ? 1 : 0,
      closedAt,
    );
    return this.getAgentById(value.id)!;
  }

  /**
   * Closure is stamped by the database, not by callers, because every path
   * that can close an agent (kill, crash sweep, done event, failed spawn)
   * would otherwise have to remember. It is written once — a later write that
   * keeps the agent terminal must not slide the timestamp forward — and
   * cleared when crash recovery returns this same id to a live status.
   */
  private resolveClosedAt(value: AgentRecord): string | null {
    if (!isTerminalAgentStatus(value.status)) return null;
    if (value.closedAt !== undefined) return value.closedAt;
    const existing = this.database.query(
      "SELECT closedAt FROM agents WHERE id = ?",
    ).get(value.id) as { closedAt: string | null } | null;
    return existing?.closedAt ?? value.failedAt ?? value.lastEventAt;
  }

  insertAgent(agent: AgentRecord): AgentRecord {
    return this.upsertAgent(agent);
  }

  attachTerminalHandle(
    agentId: string,
    handle: TerminalHandle,
  ): AgentRecord | null {
    const value = TerminalHandleSchema.parse(handle);
    const updated = this.database.query(`
      UPDATE agents
      SET terminalHandle = ?
      WHERE id = ? AND status NOT IN ('dead', 'done', 'failed')
    `).run(JSON.stringify(value), agentId);
    return updated.changes === 0 ? null : this.getAgentById(agentId);
  }

  markAgentDeadAndDetachTerminal(
    agentId: string,
    timestamp: string,
    failureReason?: string,
  ): { agent: AgentRecord; terminalHandle: TerminalHandle | undefined } | null {
    return this.transaction(() => {
      const current = this.getAgentById(agentId);
      if (current === null) {
        return null;
      }
      const terminalHandle = current.terminalHandle;
      const agent = this.upsertAgent({
        ...current,
        status: "dead",
        terminalHandle: undefined,
        failureReason: failureReason ?? current.failureReason,
        lastEventAt: timestamp,
      });
      return { agent, terminalHandle };
    });
  }

  // The orchestrator is not a spawned agent and has no agents-table row; its
  // viewer window handle lives in the meta table so the layout engine can
  // keep the root window central across daemon restarts.
  setOrchestratorTerminal(handle: TerminalHandle): void {
    const value = TerminalHandleSchema.parse(handle);
    this.database.query(`
      INSERT INTO meta (key, value) VALUES ('orchestratorTerminal', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(value));
  }

  getOrchestratorTerminal(): TerminalHandle | null {
    const row = this.database.query(
      "SELECT value FROM meta WHERE key = 'orchestratorTerminal'",
    ).get();
    if (row === null) {
      return null;
    }
    try {
      const { value } = z.object({ value: z.string() }).parse(row);
      return TerminalHandleSchema.parse(JSON.parse(value));
    } catch {
      return null;
    }
  }

  clearOrchestratorTerminal(): void {
    this.database.query(
      "DELETE FROM meta WHERE key = 'orchestratorTerminal'",
    ).run();
  }

  getAgentById(id: string): AgentRecord | null {
    const row = this.database.query("SELECT * FROM agents WHERE id = ?").get(id);
    return row === null ? null : parseAgentRow(row);
  }

  /**
   * The agent a bare name refers to: the live holder if there is one, else the
   * most recent closed holder. Callers that reject terminal agents (message
   * delivery, control) therefore keep rejecting exactly as before, and a name
   * whose holder is closed never resolves to an older ghost of itself.
   */
  getAgentByName(name: string): AgentRecord | null {
    const row = this.database.query(`
      SELECT * FROM agents WHERE name = ?
      ORDER BY (status IN ('done', 'dead', 'failed')) ASC, createdAt DESC
      LIMIT 1
    `).get(name);
    return row === null ? null : parseAgentRow(row);
  }

  /** The one live holder of a name, or null when the name is free. */
  getLiveAgentByName(name: string): AgentRecord | null {
    const row = this.database.query(`
      SELECT * FROM agents
      WHERE name = ? AND status NOT IN ('done', 'dead', 'failed')
      LIMIT 1
    `).get(name);
    return row === null ? null : parseAgentRow(row);
  }

  listAgents(): AgentRecord[] {
    return this.database.query("SELECT * FROM agents ORDER BY createdAt, name")
      .all()
      .map(parseAgentRow);
  }

  reserveAgentName(name: string, createdAt = new Date().toISOString()): boolean {
    return this.database.query(`
      INSERT OR IGNORE INTO agent_name_reservations (name, createdAt)
      VALUES (?, ?)
    `).run(name, createdAt).changes === 1;
  }

  isAgentNameReserved(name: string): boolean {
    return this.database.query(`
      SELECT 1 FROM agent_name_reservations WHERE name = ?
    `).get(name) !== null;
  }

  releaseAgentName(name: string): boolean {
    return this.database.query(`
      DELETE FROM agent_name_reservations WHERE name = ?
    `).run(name).changes === 1;
  }

  // Name reservations are transient bookkeeping for spawns in flight inside
  // one daemon process. A daemon crash strands them, and a stranded
  // reservation makes its spawning agent look forever in-flight to crash
  // recovery, so daemon startup clears the table wholesale.
  clearAgentNameReservations(): number {
    return this.database.query("DELETE FROM agent_name_reservations")
      .run().changes;
  }

  insertMessage(message: AgentMessage): AgentMessage {
    const value = AgentMessageSchema.parse(message);
    this.database.query(`
      INSERT INTO messages (
        id, "from", "to", body, createdAt, deliveredAt, priority, intent,
        state, injectedAt, acknowledgedAt, appliedAt, deadlineAt, alertAt,
        sequence, idempotencyKey, capabilityEpoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.id,
      value.from,
      value.to,
      value.body,
      value.createdAt,
      value.deliveredAt,
      value.priority,
      value.intent,
      value.state,
      value.injectedAt,
      value.acknowledgedAt,
      value.appliedAt,
      value.deadlineAt,
      value.alertAt,
      value.sequence,
      value.idempotencyKey,
      value.capabilityEpoch,
    );
    return this.getMessage(value.id)!;
  }

  getMessage(id: string): AgentMessage | null {
    const row = this.database.query("SELECT * FROM messages WHERE id = ?").get(id);
    return row === null ? null : AgentMessageSchema.parse(row);
  }

  listMessages(): AgentMessage[] {
    return this.database.query("SELECT * FROM messages ORDER BY rowid")
      .all()
      .map((row) => AgentMessageSchema.parse(row));
  }

  listQueuedCriticalMessages(): AgentMessage[] {
    return this.database.query(`
      SELECT * FROM messages
      WHERE priority = 'critical' AND state = 'queued'
      ORDER BY sequence, rowid
    `).all().map((row) => AgentMessageSchema.parse(row));
  }

  findMessageByIdempotency(
    from: string,
    idempotencyKey: string,
  ): AgentMessage | null {
    const row = this.database.query(`
      SELECT * FROM messages WHERE "from" = ? AND idempotencyKey = ?
    `).get(from, idempotencyKey);
    return row === null ? null : AgentMessageSchema.parse(row);
  }

  nextMessageSequence(agentName: string): number {
    const row = this.database.query(`
      SELECT COALESCE(MAX(sequence), 0) AS value FROM messages WHERE "to" = ?
    `).get(agentName) as { value: number };
    return row.value + 1;
  }

  transitionMessage(
    id: string,
    state: AgentMessage["state"],
    timestamp: string,
  ): AgentMessage | null {
    const current = this.getMessage(id);
    if (current === null) return null;
    const rank = ["queued", "injected", "agent-acknowledged", "applied"];
    if (rank.indexOf(state) <= rank.indexOf(current.state)) return current;
    const field = state === "injected"
      ? "injectedAt"
      : state === "agent-acknowledged"
        ? "acknowledgedAt"
        : "appliedAt";
    this.database.query(`
      UPDATE messages SET state = ?, ${field} = ?,
        deliveredAt = CASE WHEN ? = 'injected' THEN ? ELSE deliveredAt END
      WHERE id = ?
    `).run(state, timestamp, state, timestamp, id);
    return this.getMessage(id);
  }

  /**
   * The last turn this recipient finished, read from the events table.
   *
   * A spawned agent carries its own `lastEventAt` on its row, so it never needs
   * this. The orchestrator does: it is not a spawned agent and has no agents-row
   * at all (see `setOrchestratorTerminal`), so `getAgentByName("orchestrator")`
   * is null and anything that asks a row for the root's turn boundary gets
   * silence back and mistakes it for "never took one". The root's boundaries are
   * here, in the events its own hooks post, and this is the only place they
   * exist. Delivery reconciliation reads it to answer the one question that
   * decides whether a message reached a mind (see delivery.ts).
   */
  latestTurnEndAt(agentName: string): string | null {
    const row = this.database.query(`
      SELECT MAX(timestamp) AS value FROM events
      WHERE agentName = ? AND kind = 'turn-end'
    `).get(agentName) as { value: string | null };
    return row.value;
  }

  /**
   * The last moment the agent actually started or finished a turn.
   *
   * Delivery used to ask for `lastEventAt` and call it a turn boundary, but
   * that is the newest event of *any* kind — and `notification` is an event.
   * An idle agent emits notifications while doing nothing at all, so a paste
   * that the TUI never submitted could be "confirmed" by the recipient sitting
   * there. Only turn-start and turn-end mean the model actually ran.
   */
  latestTurnBoundaryAt(agentName: string): string | null {
    const row = this.database.query(`
      SELECT MAX(timestamp) AS value FROM events
      WHERE agentName = ? AND kind IN ('turn-start', 'turn-end')
    `).get(agentName) as { value: string | null };
    return row.value;
  }

  /** Handed to a recipient, but not yet confirmed to have reached its mind. */
  listInjectedUnapplied(): AgentMessage[] {
    return this.database.query(`
      SELECT * FROM messages
      WHERE state = 'injected' AND appliedAt IS NULL AND injectedAt IS NOT NULL
      ORDER BY injectedAt, sequence, rowid
    `).all().map((row) => AgentMessageSchema.parse(row));
  }

  /**
   * Re-anchor a control's acknowledgement deadline to the moment it was actually
   * injected. Anchoring it to send time charged the recipient for however long
   * the message spent queued — in one observed case seventeen minutes — so it
   * could expire before the agent could physically see it.
   */
  setMessageDeadline(id: string, deadlineAt: string): AgentMessage | null {
    this.database.query(`UPDATE messages SET deadlineAt = ? WHERE id = ?`)
      .run(deadlineAt, id);
    return this.getMessage(id);
  }

  markMessageAlerted(id: string, timestamp: string): AgentMessage | null {
    this.database.query(`
      UPDATE messages SET alertAt = COALESCE(alertAt, ?) WHERE id = ?
    `).run(timestamp, id);
    return this.getMessage(id);
  }

  assignMessageCapabilityEpoch(
    id: string,
    capabilityEpoch: number,
  ): AgentMessage | null {
    this.database.query(`
      UPDATE messages SET capabilityEpoch = COALESCE(capabilityEpoch, ?)
      WHERE id = ?
    `).run(capabilityEpoch, id);
    return this.getMessage(id);
  }

  listExpiredUnacknowledged(now: string): AgentMessage[] {
    return this.database.query(`
      SELECT * FROM messages
      WHERE priority IN ('urgent', 'critical')
        AND deadlineAt IS NOT NULL AND deadlineAt <= ?
        AND state IN ('queued', 'injected') AND alertAt IS NULL
      ORDER BY deadlineAt, sequence, rowid
    `).all(now).map((row) => AgentMessageSchema.parse(row));
  }

  revokeAgentCapabilities(name: string, timestamp: string): AgentRecord | null {
    return this.transaction(() => {
      this.database.query(`
        UPDATE agents SET capabilityEpoch = capabilityEpoch + 1,
          writeRevoked = 1, status = 'control-paused', lastEventAt = ?
        WHERE name = ? AND status NOT IN ('dead', 'done', 'failed')
      `).run(timestamp, name);
      this.database.query(`
        UPDATE approvals SET status = 'denied', resolvedAt = ?
        WHERE agentName = ? AND status = 'pending'
      `).run(timestamp, name);
      return this.getAgentByName(name);
    });
  }

  getUndeliveredMessages(agentName: string): AgentMessage[] {
    return this.database.query(`
      SELECT * FROM messages
      WHERE "to" = ? AND deliveredAt IS NULL
      ORDER BY CASE priority
        WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
        sequence, rowid
    `).all(agentName).map((row) => AgentMessageSchema.parse(row));
  }

  claimUndeliveredMessages(
    agentName: string,
    deliveredAt: string,
  ): AgentMessage[] {
    return this.transaction(() => {
      const claimed: AgentMessage[] = [];
      for (const message of this.getUndeliveredMessages(agentName)) {
        const result = this.database.query(`
          UPDATE messages SET deliveredAt = ?
          WHERE id = ? AND deliveredAt IS NULL
        `).run(deliveredAt, message.id);
        if (result.changes === 1) {
          claimed.push(AgentMessageSchema.parse({ ...message, deliveredAt }));
        }
      }
      return claimed;
    });
  }

  // Returns the row only when this call actually claimed it: a message some
  // other path already delivered comes back null, exactly like a missing one,
  // so a push path cannot report a fresh delivery for a duplicate.
  markMessageDelivered(id: string, deliveredAt: string): AgentMessage | null {
    const result = this.database.query(`
      UPDATE messages SET deliveredAt = ?
      WHERE id = ? AND deliveredAt IS NULL
    `).run(deliveredAt, id);
    return result.changes === 1 ? this.getMessage(id) : null;
  }

  insertEvent(event: HookEvent): HookEvent {
    const value = HookEventSchema.parse(event);
    this.database.query(`
      INSERT INTO events (
        kind, agentName, timestamp, contextPct, description,
        usageUnits, usageSource
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.kind,
      value.agentName,
      value.timestamp,
      value.kind === "turn-end" ? value.contextPct ?? null : null,
      value.kind === "approval-request" ? value.description : null,
      value.kind === "turn-end" ? value.usageUnits ?? null : null,
      value.kind === "turn-end" ? value.usageSource ?? null : null,
    );
    return value;
  }

  listEvents(agentName?: string): HookEvent[] {
    const rows = agentName === undefined
      ? this.database.query(`
          SELECT kind, agentName, timestamp, contextPct, description,
                 usageUnits, usageSource
          FROM events ORDER BY id
        `).all()
      : this.database.query(`
          SELECT kind, agentName, timestamp, contextPct, description,
                 usageUnits, usageSource
          FROM events WHERE agentName = ? ORDER BY id
        `).all(agentName);
    return rows.map(parseEventRow);
  }

  insertCapability(capability: CapabilityRow, secretHash: string): void {
    this.database.query(`
      INSERT INTO capabilities (
        id, subject, role, epoch, secretHash, issuedAt, expiresAt, revokedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      capability.id,
      capability.subject,
      capability.role,
      capability.epoch,
      secretHash,
      capability.issuedAt,
      capability.expiresAt,
      capability.revokedAt,
    );
  }

  getCapability(
    id: string,
  ): { capability: CapabilityRow; secretHash: string } | null {
    const row = this.database.query("SELECT * FROM capabilities WHERE id = ?")
      .get(id);
    if (row === null) return null;
    const parsed = CapabilityRowSchema.parse(row);
    const { secretHash, ...capability } = parsed;
    return { capability, secretHash };
  }

  /** Atomic: the primary key means the first inserter wins and every later
   * spend of the same right is a replay. */
  consumeOneShot(
    capabilityId: string,
    action: string,
    consumedAt: string,
  ): boolean {
    const result = this.database.query(`
      INSERT OR IGNORE INTO capability_consumptions (
        capabilityId, action, consumedAt
      ) VALUES (?, ?, ?)
    `).run(capabilityId, action, consumedAt);
    return result.changes === 1;
  }

  releaseOneShot(capabilityId: string, action: string): void {
    this.database.query(`
      DELETE FROM capability_consumptions
      WHERE capabilityId = ? AND action = ?
    `).run(capabilityId, action);
  }

  // Re-arms a spent one-shot for whatever live capability the subject holds —
  // the approval path knows the agent, not the capability id the spend was
  // recorded under. Revoked capabilities stay spent forever.
  releaseOneShotForSubject(subject: string, action: string): number {
    return this.database.query(`
      DELETE FROM capability_consumptions
      WHERE action = ? AND capabilityId IN (
        SELECT id FROM capabilities WHERE subject = ? AND revokedAt IS NULL
      )
    `).run(action, subject).changes;
  }

  isOneShotConsumed(capabilityId: string, action: string): boolean {
    const row = this.database.query(`
      SELECT 1 AS present FROM capability_consumptions
      WHERE capabilityId = ? AND action = ?
    `).get(capabilityId, action);
    return row !== null;
  }

  revokeCapabilitiesForSubject(subject: string, timestamp: string): number {
    return this.database.query(`
      UPDATE capabilities SET revokedAt = ?
      WHERE subject = ? AND revokedAt IS NULL
    `).run(timestamp, subject).changes;
  }

  insertAuditEntry(entry: AuditRow): void {
    this.database.query(`
      INSERT INTO audit_log (
        at, route, action, callerSubject, callerRole, capabilityId,
        requestedSubject, epoch, decision, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.at,
      entry.route,
      entry.action,
      entry.callerSubject,
      entry.callerRole,
      entry.capabilityId,
      entry.requestedSubject,
      entry.epoch,
      entry.decision,
      entry.reason,
    );
  }

  insertApproval(approval: Approval): Approval {
    const value = ApprovalSchema.parse(approval);
    this.database.query(`
      INSERT INTO approvals (
        id, agentName, description, status, createdAt, resolvedAt
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      value.id,
      value.agentName,
      value.description,
      value.status,
      value.createdAt,
      value.resolvedAt,
    );
    return this.getApproval(value.id)!;
  }

  getApproval(id: string): Approval | null {
    const row = this.database.query("SELECT * FROM approvals WHERE id = ?").get(id);
    return row === null ? null : ApprovalSchema.parse(row);
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    const rows = status === undefined
      ? this.database.query("SELECT * FROM approvals ORDER BY createdAt, id").all()
      : this.database.query(`
          SELECT * FROM approvals WHERE status = ? ORDER BY createdAt, id
        `).all(status);
    return rows.map((row) => ApprovalSchema.parse(row));
  }

  resolveApproval(
    id: string,
    status: "approved" | "denied",
    resolvedAt: string,
  ): Approval | null {
    const result = this.database.query(`
      UPDATE approvals SET status = ?, resolvedAt = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, resolvedAt, id);
    return result.changes === 0 ? null : this.getApproval(id);
  }

  /**
   * Drop settled history older than the retention window. Events, applied
   * messages, and resolved approvals are audit trail, not operating state, so
   * the daemon prunes them on its maintenance tick rather than letting the
   * tables (and every full-table scan over them) grow for the life of the
   * install. Pending approvals and undelivered/unacknowledged messages are
   * never touched.
   */
  pruneHistory(
    now: string,
    keepDays = 14,
  ): { events: number; messages: number; approvals: number } {
    const cutoff = new Date(Date.parse(now) - keepDays * 86_400_000)
      .toISOString();
    return this.transaction(() => ({
      events: this.database
        .query("DELETE FROM events WHERE timestamp < ?")
        .run(cutoff).changes,
      messages: this.database
        .query("DELETE FROM messages WHERE state = 'applied' AND createdAt < ?")
        .run(cutoff).changes,
      approvals: this.database
        .query("DELETE FROM approvals WHERE status != 'pending' AND createdAt < ?")
        .run(cutoff).changes,
    }));
  }
}
