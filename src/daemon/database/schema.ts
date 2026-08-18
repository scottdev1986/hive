import type { Database } from "bun:sqlite";
import { z } from "zod";
import { getHiveHome, hiveInstanceSuffix } from "../../hive-home/home";
import type { DatabaseHost } from "../../shared/database-host";
import { mintSessionLocator } from "../session-host/locators";

function agentsTableDdl(table: string, ifNotExists = false): string {
  return `
    CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tool TEXT NOT NULL,
      model TEXT NOT NULL,
      liveModel TEXT,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      taskDescription TEXT NOT NULL,
      worktreePath TEXT,
      branch TEXT,
      sessionLocator TEXT NOT NULL,
      contextPct REAL,
      contextWindow INTEGER,
      createdAt TEXT NOT NULL,
      lastEventAt TEXT NOT NULL,
      landedCommit TEXT,
      landedAt TEXT,
      quotaReservationId TEXT,
      controlQuotaReservationId TEXT,
      controlMessageId TEXT,
      executionIdentity TEXT,
      toolSessionId TEXT,
      capabilityEpoch INTEGER NOT NULL DEFAULT 0,
      readOnly INTEGER NOT NULL DEFAULT 0,
      writeRevoked INTEGER NOT NULL DEFAULT 0,
      closedAt TEXT
    )
  `;
}

const AgentColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  dflt_value: z.union([z.string(), z.number()]).nullable(),
});
type AgentColumn = z.infer<typeof AgentColumnSchema>;

const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

const columnDefinition = (column: AgentColumn): string => {
  const type = column.type === "" ? "BLOB" : column.type;
  const hasDefault = column.dflt_value !== null;
  const notNull = column.notnull === 1 && hasDefault ? " NOT NULL" : "";
  const dflt = hasDefault ? ` DEFAULT ${column.dflt_value}` : "";
  return `${quoteIdentifier(column.name)} ${type}${notNull}${dflt}`;
};

function migrateTierColumn(database: Database, table: string): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "tier")) return;
  database.exec(`ALTER TABLE ${table} RENAME COLUMN tier TO category`);
  database.exec(`
    UPDATE ${table} SET category = CASE category
      WHEN 'deep' THEN 'complex_coding'
      WHEN 'review' THEN 'code_review'
      WHEN 'standard' THEN 'simple_coding'
      WHEN 'cheap' THEN 'summarization'
      ELSE category END
  `);
}

class HiveSchemaMigrator {
  constructor(private readonly host: DatabaseHost) {}

  private get database() {
    return this.host.database;
  }

  install(): string {
    this.database.exec(agentsTableDdl("agents", true));
    this.database.exec(`
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
        kind TEXT NOT NULL DEFAULT 'tool-permission',
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        resolvedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_status_created
        ON approvals(status, createdAt);
      CREATE TABLE IF NOT EXISTS escalations (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        agentName TEXT NOT NULL,
        model TEXT NOT NULL,
        category TEXT NOT NULL,
        reason TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS escalations_agent ON escalations(agentId);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terminal_host_bindings (
        locatorInstanceId TEXT NOT NULL,
        locatorSessionId TEXT NOT NULL,
        locatorGeneration INTEGER NOT NULL CHECK (locatorGeneration > 0),
        locatorJson TEXT NOT NULL,
        visibilityJson TEXT NOT NULL,
        createEvidenceJson TEXT,
        terminationAuditJson TEXT,
        terminationEvidenceJson TEXT,
        PRIMARY KEY (locatorInstanceId, locatorSessionId, locatorGeneration)
      );
      CREATE TABLE IF NOT EXISTS provider_runs (
        runId TEXT PRIMARY KEY,
        agentId TEXT,
        terminalInstanceId TEXT NOT NULL,
        terminalSessionId TEXT NOT NULL,
        terminalGeneration INTEGER NOT NULL CHECK (terminalGeneration > 0),
        state TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provider_runs_one_active_terminal
        ON provider_runs (
          terminalInstanceId, terminalSessionId, terminalGeneration
        ) WHERE state = 'running';
      CREATE INDEX IF NOT EXISTS provider_runs_agent
        ON provider_runs (agentId);
      CREATE TABLE IF NOT EXISTS run_outcomes (
        providerRunId TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        endedAt TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_outcomes_outcome_ended
        ON run_outcomes (outcome, endedAt);
      CREATE TABLE IF NOT EXISTS incident_exposures (
        exposureId TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        observedAt TEXT NOT NULL,
        outcome TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incident_exposures_signature_observed
        ON incident_exposures (signature, observedAt);
      CREATE TABLE IF NOT EXISTS provider_events (
        eventId TEXT PRIMARY KEY,
        providerRunId TEXT NOT NULL,
        occurredAt TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_events_run
        ON provider_events (providerRunId, occurredAt);
      CREATE TABLE IF NOT EXISTS handoffs (
        handoffId TEXT PRIMARY KEY,
        sourceRunId TEXT NOT NULL UNIQUE,
        recordJson TEXT NOT NULL,
        replacementAgentId TEXT,
        pickedUpAt TEXT
      );
      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        role TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        constraints TEXT,
        subjects TEXT,
        secretHash TEXT NOT NULL,
        issuedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        revokedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS capabilities_subject ON capabilities(subject);
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

    this.rekeyTerminalHostBindingsOnLocator();
    this.relaxProviderRunAgentIdNullability();
    this.addTerminalHostBindingEvidenceColumns();
    this.migrateCapabilities();
    this.migrateAgents();
    this.migrateEvents();
    this.migrateApprovals();
    this.retireTaskFailureFields();
    this.closeSupersededProviderRuns();

    const recoveredAt = new Date().toISOString();
    this.recoverLegacyNotificationApprovals(recoveredAt);
    return recoveredAt;
  }

  private migrateCapabilities(): void {
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(this.database.query("PRAGMA table_info(capabilities)").all());
    if (!columns.some((column) => column.name === "constraints")) {
      this.database.exec(
        "ALTER TABLE capabilities ADD COLUMN constraints TEXT",
      );
    }
    if (!columns.some((column) => column.name === "subjects")) {
      this.database.exec("ALTER TABLE capabilities ADD COLUMN subjects TEXT");
    }
  }

  private migrateAgents(): void {
    for (const table of ["agents", "escalations", "quota_reservations"]) {
      migrateTierColumn(this.database, table);
    }
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(this.database.query("PRAGMA table_info(agents)").all());
    const names = new Set(columns.map((column) => column.name));
    const add = (name: string, sql: string): void => {
      if (!names.has(name)) this.database.exec(sql);
    };
    add(
      "quotaReservationId",
      "ALTER TABLE agents ADD COLUMN quotaReservationId TEXT",
    );
    add(
      "controlQuotaReservationId",
      "ALTER TABLE agents ADD COLUMN controlQuotaReservationId TEXT",
    );
    add(
      "controlMessageId",
      "ALTER TABLE agents ADD COLUMN controlMessageId TEXT",
    );
    add(
      "executionIdentity",
      "ALTER TABLE agents ADD COLUMN executionIdentity TEXT",
    );
    add("toolSessionId", "ALTER TABLE agents ADD COLUMN toolSessionId TEXT");
    add("sessionLocator", "ALTER TABLE agents ADD COLUMN sessionLocator TEXT");
    this.retireLegacySessions();
    add("contextWindow", "ALTER TABLE agents ADD COLUMN contextWindow INTEGER");
    add(
      "capabilityEpoch",
      "ALTER TABLE agents ADD COLUMN capabilityEpoch INTEGER NOT NULL DEFAULT 0",
    );
    add("holdReason", "ALTER TABLE agents ADD COLUMN holdReason TEXT");
    add("holdResetAt", "ALTER TABLE agents ADD COLUMN holdResetAt TEXT");
    add(
      "holdProviderRunId",
      "ALTER TABLE agents ADD COLUMN holdProviderRunId TEXT",
    );
    add("liveModel", "ALTER TABLE agents ADD COLUMN liveModel TEXT");
    add("landedCommit", "ALTER TABLE agents ADD COLUMN landedCommit TEXT");
    add("landedAt", "ALTER TABLE agents ADD COLUMN landedAt TEXT");
    add(
      "writeRevoked",
      "ALTER TABLE agents ADD COLUMN writeRevoked INTEGER NOT NULL DEFAULT 0",
    );
    if (!names.has("readOnly")) {
      this.database.exec(
        "ALTER TABLE agents ADD COLUMN readOnly INTEGER NOT NULL DEFAULT 0",
      );
      this.database.exec(`
        UPDATE agents
        SET readOnly = 1,
            writeRevoked = 0,
            status = CASE WHEN status = 'control-paused' THEN 'idle' ELSE status END
        WHERE writeRevoked = 1 AND capabilityEpoch = 0 AND controlMessageId IS NULL
      `);
    }
    if (!names.has("closedAt")) {
      this.database.exec("ALTER TABLE agents ADD COLUMN closedAt TEXT");
      this.database.exec(`
        UPDATE agents SET closedAt = lastEventAt
        WHERE closedAt IS NULL AND status IN ('done', 'dead', 'failed')
      `);
    }
    this.database.exec(
      "UPDATE agents SET status = 'dead' WHERE status = 'failed'",
    );
    this.relaxContextPctNullability();
    this.dropLegacyUniqueAgentName();
    const retiredViewerColumn = ["terminal", "Handle"].join("");
    const retiredColumns = new Set([
      retiredViewerColumn,
      "failureReason",
      "failedAt",
      "recoveryAttempts",
    ]);
    if (
      [...this.agentColumnNames()].some((column) => retiredColumns.has(column))
    ) {
      this.rebuildAgentsTable("contextPct", retiredColumns);
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS agents_one_live_holder
        ON agents(name) WHERE status NOT IN ('done', 'dead');
      CREATE INDEX IF NOT EXISTS agents_name_history
        ON agents(name, createdAt);
    `);
  }

  private retireLegacySessions(): void {
    const rows = z
      .array(z.object({ id: z.string().min(1) }))
      .parse(
        this.database
          .query("SELECT id FROM agents WHERE sessionLocator IS NULL")
          .all(),
      );
    if (rows.length === 0) return;
    const instanceId = hiveInstanceSuffix(getHiveHome());
    this.database.transaction(() => {
      const update = this.database.query(
        "UPDATE agents SET sessionLocator = ? WHERE id = ? AND sessionLocator IS NULL",
      );
      for (const row of rows) {
        update.run(
          JSON.stringify(
            mintSessionLocator(
              instanceId,
              { kind: "agent", agentId: row.id },
              1,
              "retired",
            ),
          ),
          row.id,
        );
        this.database
          .query(`
            UPDATE agents
            SET status = 'dead'
            WHERE id = ?
          `)
          .run(row.id);
      }
    })();
  }

  private migrateEvents(): void {
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(this.database.query("PRAGMA table_info(events)").all());
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("usageUnits")) {
      this.database.exec("ALTER TABLE events ADD COLUMN usageUnits REAL");
    }
    if (!names.has("usageSource")) {
      this.database.exec("ALTER TABLE events ADD COLUMN usageSource TEXT");
    }
  }

  private migrateApprovals(): void {
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(this.database.query("PRAGMA table_info(approvals)").all());
    if (!columns.some((column) => column.name === "kind")) {
      this.database.exec(
        "ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool-permission'",
      );
    }
  }

  private retireTaskFailureFields(): void {
    const exists = this.database
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hierarchy_records'",
      )
      .get();
    if (exists === null) return;
    this.database.exec(`
      UPDATE hierarchy_records
      SET document = json_remove(
        document,
        '$.terminationReason',
        '$.retryCount',
        '$.recoveryCount'
      )
      WHERE kind = 'task'
    `);
  }

  /**
   * One-time repair of rows left at 'running' by a teardown that could never
   * close them. Until 3e82b7568 the gate that ended a provider run demanded a
   * termination state of exactly "terminated", which a process-tree target
   * cannot produce, so a run whose process was gone kept its row. For the root
   * that is a false accept rather than untidy data: getActiveRootProviderRun
   * reads state alone, so a dead run reads as the ACTIVE root and a bootstrap
   * binds to it.
   *
   * The predicate is SUPERSESSION, and it is a proof rather than an estimate.
   * The system runs one root per instance and one live run per agent, so a
   * strictly newer run for the same subject does not suggest the older one
   * probably ended — it contradicts the older one still being live. It is
   * derivable from rows already in the table, needs nothing outside the
   * database, and gives the identical answer on every replay. Liveness of the
   * NEWEST run for a subject is not decidable here and is not guessed at: those
   * rows are left open.
   *
   * endedAt is the superseding run's startedAt, which is the honest bound —
   * the older run cannot have outlived the start of the run that replaced it.
   */
  private closeSupersededProviderRuns(): void {
    const exists = this.database
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_runs'",
      )
      .get();
    if (exists === null) return;
    // Root supersession is per instance and ordered by generation; agent
    // supersession is per agentId and ordered by rowid, which is the same
    // recency signal getActiveProviderRunForAgent already reads.
    const superseded = this.database
      .query(`
      SELECT p.runId AS runId, p.recordJson AS recordJson,
             (SELECT json_extract(q.recordJson, '$.startedAt')
                FROM provider_runs q
               WHERE (p.agentId IS NULL
                        AND q.agentId IS NULL
                        AND q.terminalInstanceId = p.terminalInstanceId
                        AND q.terminalGeneration > p.terminalGeneration)
                  OR (p.agentId IS NOT NULL
                        AND q.agentId = p.agentId
                        AND q.rowid > p.rowid)
               ORDER BY json_extract(q.recordJson, '$.startedAt')
               LIMIT 1) AS supersededAt
        FROM provider_runs p
       WHERE p.state = 'running'
         AND EXISTS (
               SELECT 1 FROM provider_runs q
                WHERE (p.agentId IS NULL
                         AND q.agentId IS NULL
                         AND q.terminalInstanceId = p.terminalInstanceId
                         AND q.terminalGeneration > p.terminalGeneration)
                   OR (p.agentId IS NOT NULL
                         AND q.agentId = p.agentId
                         AND q.rowid > p.rowid))
    `)
      .all() as { runId: string; recordJson: string; supersededAt: string }[];
    if (superseded.length === 0) return;
    this.database.transaction(() => {
      for (const row of superseded) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(row.recordJson) as Record<string, unknown>;
        } catch {
          continue;
        }
        record.state = "exited";
        record.endedAt = row.supersededAt;
        record.exitReason = "superseded-by-newer-run";
        this.database
          .query(
            "UPDATE provider_runs SET state = 'exited', recordJson = ? WHERE runId = ? AND state = 'running'",
          )
          .run(JSON.stringify(record), row.runId);
      }
    })();
  }

  private recoverLegacyNotificationApprovals(recoveredAt: string): void {
    this.database.transaction(() => {
      this.database
        .query(`
        UPDATE approvals SET status = 'approved', resolvedAt = ?
        WHERE status = 'pending'
          AND description = 'Notification from ' || agentName
      `)
        .run(recoveredAt);
      this.database
        .query(`
        UPDATE agents SET status = 'idle', lastEventAt = ?
        WHERE status = 'awaiting-approval' AND writeRevoked = 0
          AND NOT EXISTS (
            SELECT 1 FROM approvals
            WHERE approvals.agentName = agents.name
              AND approvals.status = 'pending'
          )
      `)
        .run(recoveredAt);
    })();
  }

  private dropLegacyUniqueAgentName(): void {
    const indexes = z
      .array(
        z.object({ name: z.string(), unique: z.number(), origin: z.string() }),
      )
      .parse(this.database.query("PRAGMA index_list(agents)").all());
    const legacy = indexes.find((index) => {
      if (index.unique !== 1 || index.origin !== "u") return false;
      const columns = z
        .array(z.object({ name: z.string() }))
        .parse(this.database.query(`PRAGMA index_info(${index.name})`).all());
      return columns.length === 1 && columns[0]?.name === "name";
    });
    if (legacy !== undefined) this.rebuildAgentsTable("contextPct");
  }

  private agentColumns(): AgentColumn[] {
    return z
      .array(AgentColumnSchema)
      .parse(this.database.query("PRAGMA table_info(agents)").all());
  }

  private agentColumnNames(): Set<string> {
    return new Set(this.agentColumns().map((column) => column.name));
  }

  private rebuildAgentsTable(
    contextPctExpression: string,
    droppedColumns: ReadonlySet<string> = new Set(),
  ): void {
    const columns = this.agentColumns().filter(
      (column) => !droppedColumns.has(column.name),
    );
    const targets = columns
      .map((column) => quoteIdentifier(column.name))
      .join(", ");
    const sources = columns
      .map((column) =>
        column.name === "contextPct"
          ? `${contextPctExpression} AS contextPct`
          : quoteIdentifier(column.name),
      )
      .join(", ");
    const enforced =
      z
        .array(z.object({ foreign_keys: z.number() }))
        .parse(this.database.query("PRAGMA foreign_keys").all())[0]
        ?.foreign_keys ?? 1;
    this.database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.database.transaction(() => {
        this.database.exec(agentsTableDdl("agents_rebuilt"));
        const defined = new Set(
          z
            .array(z.object({ name: z.string() }))
            .parse(
              this.database.query("PRAGMA table_info(agents_rebuilt)").all(),
            )
            .map((column) => column.name),
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

  private relaxContextPctNullability(): void {
    const notNull = z
      .array(z.object({ name: z.string(), notnull: z.number() }))
      .parse(this.database.query("PRAGMA table_info(agents)").all())
      .some((column) => column.name === "contextPct" && column.notnull === 1);
    if (notNull) this.rebuildAgentsTable("NULL");
  }

  private rekeyTerminalHostBindingsOnLocator(): void {
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(
        this.database.query("PRAGMA table_info(terminal_host_bindings)").all(),
      );
    if (!columns.some((column) => column.name === "sessionKey")) return;
    this.host.transaction(() => {
      this.database.exec(`
        ALTER TABLE terminal_host_bindings RENAME TO terminal_host_bindings_neutral_ref;
        CREATE TABLE terminal_host_bindings (
          locatorInstanceId TEXT NOT NULL,
          locatorSessionId TEXT NOT NULL,
          locatorGeneration INTEGER NOT NULL CHECK (locatorGeneration > 0),
          locatorJson TEXT NOT NULL,
          visibilityJson TEXT NOT NULL,
          PRIMARY KEY (locatorInstanceId, locatorSessionId, locatorGeneration)
        );
        INSERT INTO terminal_host_bindings (
          locatorInstanceId, locatorSessionId, locatorGeneration,
          locatorJson, visibilityJson
        ) SELECT
          locatorInstanceId, locatorSessionId, locatorGeneration,
          locatorJson, visibilityJson
        FROM terminal_host_bindings_neutral_ref;
        DROP TABLE terminal_host_bindings_neutral_ref;
      `);
    });
  }

  private relaxProviderRunAgentIdNullability(): void {
    const columns = z
      .array(z.object({ name: z.string(), notnull: z.number() }))
      .parse(this.database.query("PRAGMA table_info(provider_runs)").all());
    const agentId = columns.find((column) => column.name === "agentId");
    if (agentId?.notnull === 0) return;
    this.host.transaction(() => {
      this.database.exec(`
        DROP INDEX IF EXISTS provider_runs_one_active_terminal;
        DROP INDEX IF EXISTS provider_runs_agent;
        ALTER TABLE provider_runs RENAME TO provider_runs_old_agent_id;
        CREATE TABLE provider_runs (
          runId TEXT PRIMARY KEY,
          agentId TEXT,
          terminalInstanceId TEXT NOT NULL,
          terminalSessionId TEXT NOT NULL,
          terminalGeneration INTEGER NOT NULL CHECK (terminalGeneration > 0),
          state TEXT NOT NULL,
          recordJson TEXT NOT NULL
        );
        INSERT INTO provider_runs (
          runId, agentId, terminalInstanceId, terminalSessionId,
          terminalGeneration, state, recordJson
        ) SELECT
          runId, agentId, terminalInstanceId, terminalSessionId,
          terminalGeneration, state, recordJson
        FROM provider_runs_old_agent_id;
        DROP TABLE provider_runs_old_agent_id;
        CREATE UNIQUE INDEX provider_runs_one_active_terminal
          ON provider_runs (
            terminalInstanceId, terminalSessionId, terminalGeneration
          ) WHERE state = 'running';
        CREATE INDEX provider_runs_agent ON provider_runs (agentId);
      `);
    });
  }

  private addTerminalHostBindingEvidenceColumns(): void {
    const columns = new Set(
      z
        .array(z.object({ name: z.string() }))
        .parse(
          this.database
            .query("PRAGMA table_info(terminal_host_bindings)")
            .all(),
        )
        .map((column) => column.name),
    );
    if (!columns.has("createEvidenceJson")) {
      this.database.exec(
        "ALTER TABLE terminal_host_bindings ADD COLUMN createEvidenceJson TEXT",
      );
    }
    if (!columns.has("terminationAuditJson")) {
      this.database.exec(
        "ALTER TABLE terminal_host_bindings ADD COLUMN terminationAuditJson TEXT",
      );
    }
    if (!columns.has("terminationEvidenceJson")) {
      this.database.exec(
        "ALTER TABLE terminal_host_bindings ADD COLUMN terminationEvidenceJson TEXT",
      );
    }
  }
}

export function installHiveSchema(host: DatabaseHost): string {
  return new HiveSchemaMigrator(host).install();
}
