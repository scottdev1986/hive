import {
  type ObservabilityEvent,
  ObservabilityEventSchema,
  type ObservabilityQuery,
} from "../../schemas/observability";
import type { DatabaseHost } from "../../shared/database-host";

interface ObservabilityRow {
  schemaVersion: number;
  eventId: string;
  occurredAt: string;
  recordedAt: string;
  severity: string;
  source: string;
  operation: string;
  reason: string;
  subject: string | null;
  agentId: string | null;
  provider: string | null;
  providerRunId: string | null;
  vendorSessionId: string | null;
  toolName: string | null;
  callId: string | null;
}

const SELECT_EVENT = `
  SELECT schemaVersion, eventId, occurredAt, recordedAt, severity, source,
         operation, reason, subject, agentId, provider, providerRunId,
         vendorSessionId, toolName, callId
  FROM observability_events
`;

/** SQLite ownership for the observability service. Policy remains in the
 * service; this store owns only schema installation and persistence queries. */
export class ObservabilityStore {
  constructor(private readonly db: DatabaseHost) {
    this.db.database.exec(`
      CREATE TABLE IF NOT EXISTS observability_events (
        eventId TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        occurredAt TEXT NOT NULL,
        recordedAt TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
        source TEXT NOT NULL,
        operation TEXT NOT NULL,
        reason TEXT NOT NULL,
        subject TEXT,
        agentId TEXT,
        provider TEXT,
        providerRunId TEXT,
        vendorSessionId TEXT,
        toolName TEXT,
        callId TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_observability_events_time
        ON observability_events(occurredAt DESC, eventId DESC);
      CREATE INDEX IF NOT EXISTS idx_observability_events_subject
        ON observability_events(subject, occurredAt DESC);
      CREATE INDEX IF NOT EXISTS idx_observability_events_session
        ON observability_events(providerRunId, vendorSessionId, occurredAt DESC);
      CREATE INDEX IF NOT EXISTS idx_observability_events_tool
        ON observability_events(toolName, occurredAt DESC);
    `);
  }

  insert(event: ObservabilityEvent): boolean {
    return (
      this.db.database
        .query(`
          INSERT OR IGNORE INTO observability_events (
            eventId, schemaVersion, occurredAt, recordedAt, severity, source,
            operation, reason, subject, agentId, provider, providerRunId,
            vendorSessionId, toolName, callId
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          event.eventId,
          event.schemaVersion,
          event.occurredAt,
          event.recordedAt,
          event.severity,
          event.source,
          event.operation,
          event.reason,
          event.subject,
          event.agentId,
          event.provider,
          event.providerRunId,
          event.vendorSessionId,
          event.toolName,
          event.callId,
        ).changes > 0
    );
  }

  list(query: ObservabilityQuery): ObservabilityEvent[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const equal = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    };
    if (query.since !== undefined) {
      clauses.push("occurredAt >= ?");
      parameters.push(query.since);
    }
    if (query.until !== undefined) {
      clauses.push("occurredAt <= ?");
      parameters.push(query.until);
    }
    equal("severity", query.severity);
    equal("source", query.source);
    equal("subject", query.subject);
    equal("toolName", query.tool);
    if (query.session !== undefined) {
      clauses.push("(providerRunId = ? OR vendorSessionId = ?)");
      parameters.push(query.session, query.session);
    }
    parameters.push(query.limit);
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return this.db.database
      .query<ObservabilityRow, Array<string | number>>(`
        ${SELECT_EVENT}
        ${where}
        ORDER BY occurredAt DESC, eventId DESC
        LIMIT ?
      `)
      .all(...parameters)
      .map((row) => ObservabilityEventSchema.parse(row));
  }

  get(eventId: string): ObservabilityEvent | null {
    const row = this.db.database
      .query<ObservabilityRow, [string]>(`
        ${SELECT_EVENT}
        WHERE eventId = ?
      `)
      .get(eventId);
    return row === null ? null : ObservabilityEventSchema.parse(row);
  }
}
