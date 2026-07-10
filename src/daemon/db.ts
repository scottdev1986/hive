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
  type AgentMessage,
  type AgentRecord,
  type HookEvent,
  type TerminalHandle,
} from "../schemas";

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
  quotaReservationId: z.string().nullable(),
  controlQuotaReservationId: z.string().nullable(),
  controlMessageId: z.string().nullable(),
  executionIdentity: z.string().nullable(),
  terminalHandle: z.string().nullable(),
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
    quotaReservationId: value.quotaReservationId ?? undefined,
    controlQuotaReservationId: value.controlQuotaReservationId ?? undefined,
    controlMessageId: value.controlMessageId ?? undefined,
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
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        tool TEXT NOT NULL,
        model TEXT NOT NULL,
        tier TEXT NOT NULL,
        status TEXT NOT NULL,
        taskDescription TEXT NOT NULL,
        worktreePath TEXT,
        branch TEXT,
        tmuxSession TEXT NOT NULL,
        terminalHandle TEXT,
        contextPct REAL NOT NULL,
        createdAt TEXT NOT NULL,
        lastEventAt TEXT NOT NULL,
        failureReason TEXT,
        failedAt TEXT,
        quotaReservationId TEXT,
        controlQuotaReservationId TEXT,
        controlMessageId TEXT,
        executionIdentity TEXT,
        capabilityEpoch INTEGER NOT NULL DEFAULT 0,
        writeRevoked INTEGER NOT NULL DEFAULT 0
      );
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

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  upsertAgent(agent: AgentRecord): AgentRecord {
    const value = AgentRecordSchema.parse(agent);
    this.database.query(`
      INSERT INTO agents (
        id, name, tool, model, tier, status, taskDescription,
        worktreePath, branch, tmuxSession, terminalHandle, contextPct,
        createdAt, lastEventAt, failureReason, failedAt,
        quotaReservationId, controlQuotaReservationId, controlMessageId,
        executionIdentity, capabilityEpoch, writeRevoked, channelsEnabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        tool = excluded.tool,
        model = excluded.model,
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
        capabilityEpoch = excluded.capabilityEpoch,
        writeRevoked = excluded.writeRevoked,
        channelsEnabled = excluded.channelsEnabled
    `).run(
      value.id,
      value.name,
      value.tool,
      value.model,
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
      value.capabilityEpoch,
      value.writeRevoked ? 1 : 0,
      value.channelsEnabled ? 1 : 0,
    );
    return this.getAgentById(value.id)!;
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

  getAgentByName(name: string): AgentRecord | null {
    const row = this.database.query("SELECT * FROM agents WHERE name = ?").get(name);
    return row === null ? null : parseAgentRow(row);
  }

  listAgents(): AgentRecord[] {
    return this.database.query("SELECT * FROM agents ORDER BY createdAt, name")
      .all()
      .map(parseAgentRow);
  }

  deleteAgent(id: string): boolean {
    return this.database.query("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
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

  acknowledgeMessage(id: string, deliveredAt: string): AgentMessage | null {
    const result = this.database.query(`
      UPDATE messages SET deliveredAt = ?
      WHERE id = ? AND deliveredAt IS NULL
    `).run(deliveredAt, id);
    return result.changes === 1 ? this.getMessage(id) : null;
  }

  markMessageDelivered(id: string, deliveredAt: string): AgentMessage | null {
    this.database.query(`
      UPDATE messages SET deliveredAt = ?
      WHERE id = ? AND deliveredAt IS NULL
    `).run(deliveredAt, id);
    return this.getMessage(id);
  }

  deleteMessage(id: string): boolean {
    return this.database.query("DELETE FROM messages WHERE id = ?").run(id).changes > 0;
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

  deleteEvents(agentName?: string): number {
    if (agentName === undefined) {
      return this.database.query("DELETE FROM events").run().changes;
    }
    return this.database.query("DELETE FROM events WHERE agentName = ?")
      .run(agentName).changes;
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

  deleteApproval(id: string): boolean {
    return this.database.query("DELETE FROM approvals WHERE id = ?").run(id).changes > 0;
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
