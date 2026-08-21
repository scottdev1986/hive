import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { NormalizedProviderEvent } from "../adapters/providers/protocol/types";
import type { DatabaseHost } from "../shared/database-host";
import { definedFields } from "../shared/defined-fields";
import { type AgentRecord, isLiveAgent } from "../schemas/agent";
import {
  type TokenUsageBreakdown,
  type TokenUsageEventIngest,
  TokenUsageRoleSchema,
  type TokenUsageSession,
  type TokenUsageSnapshot,
  TokenUsageSnapshotSchema,
  type TokenUsageSubject,
} from "../schemas/token-usage-schema";

interface TokenUsageDatabase extends DatabaseHost {
  listAgents(): AgentRecord[];
}

const SubjectRowSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  agentId: z.string().nullable(),
  name: z.string(),
  role: TokenUsageRoleSchema,
  provider: z.string(),
  model: z.string().nullable(),
  cwd: z.string(),
  providerSessionId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  unknownReason: z.string().nullable(),
});
type SubjectRow = z.infer<typeof SubjectRowSchema>;

const EventRowSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  observedAt: z.string(),
  source: z.string(),
});

const observedCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;

/** The same reading an artifact scanner would have found, taken from the live protocol stream instead. A reading the vendor did not name cannot be told apart from the next one after a reconnect, so it stays display-only and is never attributed; counting it would add the same tokens twice. */
export function protocolTokenEvent(
  event: Extract<NormalizedProviderEvent, { kind: "usage-updated" }>,
): TokenUsageEventIngest | null {
  const key = event.usageKey;
  if (key == null || key === "") return null;
  const input = observedCount(event.inputTokens);
  const output = observedCount(event.outputTokens);
  if (input === null || output === null) return null;
  return {
    key,
    counts: {
      inputTokens: input,
      cachedInputTokens: observedCount(event.cachedInputTokens),
      cacheCreationInputTokens: observedCount(event.cacheCreationInputTokens),
      outputTokens: output,
      reasoningTokens: observedCount(event.reasoningTokens),
    },
    observedAt: event.observedAt ?? new Date().toISOString(),
    source: event.source ?? "protocol",
    ...definedFields({
      cumulative: event.cumulative === true ? true : undefined,
    }),
  };
}

export class TokenUsageStore {
  private readonly database: Database;

  constructor(private readonly db: TokenUsageDatabase) {
    this.database = db.database;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS token_usage_sessions (
        id TEXT PRIMARY KEY,
        repoRoot TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        endedAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS token_usage_one_active_repo
        ON token_usage_sessions(repoRoot) WHERE endedAt IS NULL;
      CREATE TABLE IF NOT EXISTS token_usage_subjects (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES token_usage_sessions(id),
        agentId TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('orchestrator', 'worker')),
        provider TEXT NOT NULL,
        model TEXT,
        cwd TEXT NOT NULL,
        providerSessionId TEXT,
        startedAt TEXT NOT NULL,
        endedAt TEXT,
        unknownReason TEXT
      );
      CREATE TABLE IF NOT EXISTS token_usage_artifacts (
        subjectId TEXT NOT NULL REFERENCES token_usage_subjects(id),
        path TEXT NOT NULL,
        cursorBytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(subjectId, path)
      );
      CREATE TABLE IF NOT EXISTS token_usage_events (
        subjectId TEXT NOT NULL REFERENCES token_usage_subjects(id),
        eventKey TEXT NOT NULL,
        cumulative INTEGER NOT NULL DEFAULT 0,
        inputTokens INTEGER NOT NULL,
        cachedInputTokens INTEGER,
        cacheCreationInputTokens INTEGER,
        outputTokens INTEGER NOT NULL,
        reasoningTokens INTEGER,
        observedAt TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY(subjectId, eventKey)
      );
    `);
    this.migrateSubjects();
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS token_usage_one_subject_per_agent
        ON token_usage_subjects(sessionId, agentId) WHERE agentId IS NOT NULL;
    `);
  }

  /** Bring a profiler-shaped database to the current schema. Drops any profiler subjects (and their child artifacts/events) and rebuilds the table to the narrowed CHECK without `profileRunId`. SQLite cannot ALTER a CHECK constraint or drop a column on every supported build, so the table is rebuilt (build, copy, drop, rename). Keyed on the column's presence so it runs at most once. Foreign keys are disabled around the rebuild because artifacts/events reference this table, and restored in a finally even if it throws. Non-profiler rows are copied through untouched. */
  private migrateSubjects(): void {
    const hasProfileRunId = z
      .object({ name: z.string() })
      .array()
      .parse(
        this.database.query("PRAGMA table_info(token_usage_subjects)").all(),
      )
      .some((column) => column.name === "profileRunId");
    if (!hasProfileRunId) return;
    const enforced =
      z
        .array(z.object({ foreign_keys: z.number() }))
        .parse(this.database.query("PRAGMA foreign_keys").all())[0]
        ?.foreign_keys ?? 1;
    this.database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.database.transaction(() => {
        this.database.exec(`
          DELETE FROM token_usage_events WHERE subjectId IN (
            SELECT id FROM token_usage_subjects WHERE role = 'profiler'
          );
          DELETE FROM token_usage_artifacts WHERE subjectId IN (
            SELECT id FROM token_usage_subjects WHERE role = 'profiler'
          );
          DELETE FROM token_usage_subjects WHERE role = 'profiler';
          CREATE TABLE token_usage_subjects_rebuilt (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL REFERENCES token_usage_sessions(id),
            agentId TEXT,
            name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('orchestrator', 'worker')),
            provider TEXT NOT NULL,
            model TEXT,
            cwd TEXT NOT NULL,
            providerSessionId TEXT,
            startedAt TEXT NOT NULL,
            endedAt TEXT,
            unknownReason TEXT
          );
          INSERT INTO token_usage_subjects_rebuilt (
            id, sessionId, agentId, name, role, provider, model, cwd,
            providerSessionId, startedAt, endedAt, unknownReason
          )
          SELECT id, sessionId, agentId, name, role, provider, model, cwd,
            providerSessionId, startedAt, endedAt, unknownReason
          FROM token_usage_subjects;
          DROP TABLE token_usage_subjects;
          ALTER TABLE token_usage_subjects_rebuilt RENAME TO token_usage_subjects;
        `);
      })();
    } finally {
      this.database.exec(
        `PRAGMA foreign_keys = ${enforced === 0 ? "OFF" : "ON"}`,
      );
    }
  }

  private activeSession(
    repoRoot?: string,
  ): { id: string; repoRoot: string; startedAt: string } | null {
    const row =
      repoRoot === undefined
        ? this.database
            .query(
              `
          SELECT id, repoRoot, startedAt FROM token_usage_sessions
          WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1
        `,
            )
            .get()
        : this.database
            .query(
              `
          SELECT id, repoRoot, startedAt FROM token_usage_sessions
          WHERE repoRoot = ? AND endedAt IS NULL LIMIT 1
        `,
            )
            .get(repoRoot);
    return z
      .object({ id: z.string(), repoRoot: z.string(), startedAt: z.string() })
      .nullable()
      .parse(row);
  }

  async startSession(
    repoRoot: string,
    at = new Date().toISOString(),
  ): Promise<string> {
    const active = this.activeSession(repoRoot);
    if (active !== null && this.db.listAgents().some(isLiveAgent))
      return active.id;
    if (active !== null) await this.endSession(active.id, at);
    const id = crypto.randomUUID();
    this.database
      .query(
        `
      INSERT INTO token_usage_sessions (id, repoRoot, startedAt, endedAt)
      VALUES (?, ?, ?, NULL)
    `,
      )
      .run(id, repoRoot, at);
    await this.syncWorkers(id);
    return id;
  }

  async endSession(id: string, at = new Date().toISOString()): Promise<void> {
    await this.refreshSession(id);
    this.database
      .query(
        `
      UPDATE token_usage_sessions SET endedAt = COALESCE(endedAt, ?)
      WHERE id = ?
    `,
      )
      .run(at, id);
  }

  startOrchestrator(
    sessionId: string,
    provider: string,
    cwd: string,
    at = new Date().toISOString(),
  ): string {
    const id = crypto.randomUUID();
    this.database
      .query(
        `
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, model, cwd,
        providerSessionId, startedAt, endedAt, unknownReason
      ) VALUES (?, ?, NULL, 'Orchestrator', 'orchestrator', ?, NULL, ?, NULL, ?, NULL, NULL)
    `,
      )
      .run(id, sessionId, provider, cwd, at);
    return id;
  }

  async endSubject(id: string, at = new Date().toISOString()): Promise<void> {
    await this.refreshSubject(id);
    this.database
      .query(
        `
      UPDATE token_usage_subjects SET endedAt = COALESCE(endedAt, ?) WHERE id = ?
    `,
      )
      .run(at, id);
  }

  registerOrchestratorProviderSession(
    providerSessionId: string,
    repoRoot: string,
  ): void {
    const active = this.activeSession(repoRoot);
    if (active === null) return;
    this.database
      .query(
        `
      UPDATE token_usage_subjects SET providerSessionId = ?
      WHERE id = (
        SELECT id FROM token_usage_subjects
        WHERE sessionId = ? AND role = 'orchestrator' AND endedAt IS NULL
        ORDER BY startedAt DESC LIMIT 1
      )
    `,
      )
      .run(providerSessionId, active.id);
  }

  private async syncWorkers(sessionId: string): Promise<void> {
    const session = z
      .object({ startedAt: z.string() })
      .parse(
        this.database
          .query("SELECT startedAt FROM token_usage_sessions WHERE id = ?")
          .get(sessionId),
      );
    for (const agent of this.db.listAgents()) {
      if (agent.createdAt < session.startedAt && !isLiveAgent(agent)) continue;
      const cwd = agent.worktreePath;
      if (cwd === null) continue;
      this.database
        .query(
          `
        INSERT OR IGNORE INTO token_usage_subjects (
          id, sessionId, agentId, name, role, provider, model, cwd,
          providerSessionId, startedAt, endedAt, unknownReason
        ) VALUES (?, ?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, NULL)
      `,
        )
        .run(
          crypto.randomUUID(),
          sessionId,
          agent.id,
          agent.name,
          agent.tool,
          agent.liveModel ?? agent.model,
          cwd,
          agent.toolSessionId ?? null,
          agent.createdAt,
          agent.closedAt ?? null,
        );
      this.database
        .query(
          `
        UPDATE token_usage_subjects SET
          providerSessionId = COALESCE(?, providerSessionId),
          model = COALESCE(?, model),
          endedAt = COALESCE(?, endedAt)
        WHERE sessionId = ? AND agentId = ?
      `,
        )
        .run(
          agent.toolSessionId ?? null,
          agent.liveModel ?? agent.model,
          agent.closedAt ?? null,
          sessionId,
          agent.id,
        );
    }
  }

  async refreshCurrent(repoRoot?: string): Promise<void> {
    const active = this.activeSession(repoRoot);
    if (active !== null) await this.refreshSession(active.id);
  }

  async refreshSession(sessionId: string): Promise<void> {
    await this.syncWorkers(sessionId);
  }

  /** Attribute readings taken from a live protocol stream. Replaying the same reading (a reconnect) upserts the same row rather than adding a second one. Clears the subject's unknown reason once a reading has actually arrived. */
  recordProtocolUsage(
    subjectId: string,
    events: readonly TokenUsageEventIngest[],
  ): void {
    if (events.length === 0) return;
    this.database.transaction(() => {
      for (const event of events) this.upsertEvent(subjectId, event);
      this.database
        .query(
          "UPDATE token_usage_subjects SET unknownReason = NULL WHERE id = ?",
        )
        .run(subjectId);
    })();
  }

  subjectIdForAgent(agentId: string, repoRoot?: string): string | null {
    const active = this.activeSession(repoRoot);
    if (active === null) return null;
    const row = z
      .object({ id: z.string() })
      .nullable()
      .parse(
        this.database
          .query(
            `
          SELECT id FROM token_usage_subjects
          WHERE sessionId = ? AND agentId = ? AND endedAt IS NULL
          ORDER BY startedAt DESC LIMIT 1
        `,
          )
          .get(active.id, agentId),
      );
    return row?.id ?? null;
  }

  /** Map protocol usage-updated events onto a subject and attribute them. Returns how many events were attributed (display-only readings omit a key and do not count). */
  ingestProtocolUsage(
    subjectId: string,
    events: readonly Extract<
      NormalizedProviderEvent,
      { kind: "usage-updated" }
    >[],
  ): number {
    const mapped = events.flatMap((event) => {
      const reading = protocolTokenEvent(event);
      return reading === null ? [] : [reading];
    });
    this.recordProtocolUsage(subjectId, mapped);
    return mapped.length;
  }

  recordProtocolUsageForAgent(
    agentId: string,
    events: readonly TokenUsageEventIngest[],
    model?: string,
    repoRoot?: string,
  ): void {
    if (events.length === 0) return;
    const subjectId = this.subjectIdForAgent(agentId, repoRoot);
    if (subjectId === null) return;
    if (model !== undefined) {
      this.database
        .query("UPDATE token_usage_subjects SET model = ? WHERE id = ?")
        .run(model, subjectId);
    }
    this.recordProtocolUsage(subjectId, events);
  }

  async refreshSubject(id: string): Promise<void> {
    const subject = SubjectRowSchema.nullable().parse(
      this.database
        .query("SELECT * FROM token_usage_subjects WHERE id = ?")
        .get(id),
    );
    if (subject === null) return;
    await this.syncWorkers(subject.sessionId);
  }

  private upsertEvent(subjectId: string, event: TokenUsageEventIngest): void {
    const values = [
      subjectId,
      event.key,
      event.cumulative === true ? 1 : 0,
      event.counts.inputTokens,
      event.counts.cachedInputTokens,
      event.counts.cacheCreationInputTokens,
      event.counts.outputTokens,
      event.counts.reasoningTokens,
      event.observedAt,
      event.source,
    ];
    if (event.cumulative === true) {
      this.database
        .query(
          `
        INSERT INTO token_usage_events (
          subjectId, eventKey, cumulative, inputTokens, cachedInputTokens,
          cacheCreationInputTokens, outputTokens, reasoningTokens, observedAt, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subjectId, eventKey) DO UPDATE SET
          inputTokens = MAX(inputTokens, excluded.inputTokens),
          cachedInputTokens = CASE
            WHEN excluded.cachedInputTokens IS NULL THEN NULL
            WHEN cachedInputTokens IS NULL THEN excluded.cachedInputTokens
            ELSE MAX(cachedInputTokens, excluded.cachedInputTokens) END,
          cacheCreationInputTokens = excluded.cacheCreationInputTokens,
          outputTokens = MAX(outputTokens, excluded.outputTokens),
          reasoningTokens = CASE
            WHEN excluded.reasoningTokens IS NULL THEN NULL
            WHEN reasoningTokens IS NULL THEN excluded.reasoningTokens
            ELSE MAX(reasoningTokens, excluded.reasoningTokens) END,
          observedAt = MAX(observedAt, excluded.observedAt),
          source = excluded.source
      `,
        )
        .run(...values);
      return;
    }
    this.database
      .query(
        `
      INSERT INTO token_usage_events (
        subjectId, eventKey, cumulative, inputTokens, cachedInputTokens,
        cacheCreationInputTokens, outputTokens, reasoningTokens, observedAt, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subjectId, eventKey) DO UPDATE SET
        inputTokens = MAX(inputTokens, excluded.inputTokens),
        cachedInputTokens = CASE
          WHEN cachedInputTokens IS NULL OR excluded.cachedInputTokens IS NULL THEN NULL
          ELSE MAX(cachedInputTokens, excluded.cachedInputTokens) END,
        cacheCreationInputTokens = CASE
          WHEN cacheCreationInputTokens IS NULL OR excluded.cacheCreationInputTokens IS NULL THEN NULL
          ELSE MAX(cacheCreationInputTokens, excluded.cacheCreationInputTokens) END,
        outputTokens = MAX(outputTokens, excluded.outputTokens),
        reasoningTokens = CASE
          WHEN reasoningTokens IS NULL OR excluded.reasoningTokens IS NULL THEN NULL
          ELSE MAX(reasoningTokens, excluded.reasoningTokens) END,
        observedAt = MAX(observedAt, excluded.observedAt),
        source = excluded.source
    `,
      )
      .run(...values);
  }

  private subjectReading(subject: SubjectRow): TokenUsageSubject {
    const rows = EventRowSchema.array().parse(
      this.database
        .query(
          `
        SELECT inputTokens, cachedInputTokens, cacheCreationInputTokens,
          outputTokens, reasoningTokens, observedAt, source
        FROM token_usage_events WHERE subjectId = ?
      `,
        )
        .all(subject.id),
    );
    if (rows.length === 0 || subject.unknownReason !== null) {
      return {
        id: subject.id,
        name: subject.name,
        role: subject.role,
        provider: subject.provider,
        model: subject.model,
        startedAt: subject.startedAt,
        endedAt: subject.endedAt,
        reading: {
          state: "unknown",
          reason:
            subject.unknownReason ??
            "No provider token reading has been observed",
        },
      };
    }
    const nullableSum = (
      key: "cachedInputTokens" | "cacheCreationInputTokens" | "reasoningTokens",
    ): number | null =>
      rows.every((row) => row[key] !== null)
        ? rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)
        : null;
    const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
    const first = rows[0];
    if (first === undefined) {
      throw new Error(`Token usage rows disappeared for ${subject.id}`);
    }
    const observedAt = rows.reduce(
      (latest, row) => (row.observedAt > latest ? row.observedAt : latest),
      first.observedAt,
    );
    return {
      id: subject.id,
      name: subject.name,
      role: subject.role,
      provider: subject.provider,
      model: subject.model,
      startedAt: subject.startedAt,
      endedAt: subject.endedAt,
      reading: {
        state: "measured",
        counts: {
          inputTokens,
          cachedInputTokens: nullableSum("cachedInputTokens"),
          cacheCreationInputTokens: nullableSum("cacheCreationInputTokens"),
          outputTokens,
          reasoningTokens: nullableSum("reasoningTokens"),
          totalTokens: inputTokens + outputTokens,
        },
        source: [...new Set(rows.map((row) => row.source))].join(","),
        observedAt,
      },
    };
  }

  private breakdown(subjects: TokenUsageSubject[]): TokenUsageBreakdown {
    const measured = subjects.filter(
      (subject) => subject.reading.state === "measured",
    );
    const aggregateNullable = (
      key: "cachedInputTokens" | "cacheCreationInputTokens" | "reasoningTokens",
    ): number | null =>
      measured.every(
        (subject) =>
          subject.reading.state === "measured" &&
          subject.reading.counts[key] !== null,
      )
        ? measured.reduce(
            (sum, subject) =>
              sum +
              (subject.reading.state === "measured"
                ? (subject.reading.counts[key] ?? 0)
                : 0),
            0,
          )
        : null;
    const inputTokens = measured.reduce(
      (sum, subject) =>
        sum +
        (subject.reading.state === "measured"
          ? subject.reading.counts.inputTokens
          : 0),
      0,
    );
    const outputTokens = measured.reduce(
      (sum, subject) =>
        sum +
        (subject.reading.state === "measured"
          ? subject.reading.counts.outputTokens
          : 0),
      0,
    );
    return {
      subjectCount: measured.length,
      counts:
        measured.length === 0
          ? null
          : {
              inputTokens,
              cachedInputTokens: aggregateNullable("cachedInputTokens"),
              cacheCreationInputTokens: aggregateNullable(
                "cacheCreationInputTokens",
              ),
              outputTokens,
              reasoningTokens: aggregateNullable("reasoningTokens"),
              totalTokens: inputTokens + outputTokens,
            },
    };
  }

  private readSession(id: string): TokenUsageSession {
    const session = z
      .object({
        id: z.string().uuid(),
        repoRoot: z.string(),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
      })
      .parse(
        this.database
          .query(
            "SELECT id, repoRoot, startedAt, endedAt FROM token_usage_sessions WHERE id = ?",
          )
          .get(id),
      );
    const subjects = SubjectRowSchema.array()
      .parse(
        this.database
          .query(
            `
        SELECT * FROM token_usage_subjects WHERE sessionId = ? ORDER BY startedAt
      `,
          )
          .all(id),
      )
      .map((subject) => this.subjectReading(subject));
    const unknownSubjects = subjects
      .filter((subject) => subject.reading.state === "unknown")
      .map((subject) => `${subject.name} (${subject.provider})`);
    return {
      ...session,
      complete: unknownSubjects.length === 0,
      unknownSubjects,
      fleet: this.breakdown(subjects),
      hiveControl: this.breakdown(
        subjects.filter((subject) => subject.role === "orchestrator"),
      ),
      workerSessions: this.breakdown(
        subjects.filter((subject) => subject.role === "worker"),
      ),
      subjects,
    };
  }

  spendTotals(filter: { agentId?: string; since?: string } = {}): Array<{
    agentId: string | null;
    name: string;
    role: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    lastObservedAt: string | null;
  }> {
    const clauses: string[] = [];
    const params: string[] = [];
    let joinCondition = "event.subjectId = subject.id";
    if (filter.since !== undefined) {
      joinCondition += " AND event.observedAt >= ?";
      params.push(filter.since);
    }
    if (filter.agentId !== undefined) {
      clauses.push("subject.agentId = ?");
      params.push(filter.agentId);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.database
      .query(
        `
      SELECT subject.agentId AS agentId, subject.name AS name,
        subject.role AS role, subject.provider AS provider,
        COALESCE(SUM(event.inputTokens), 0) AS inputTokens,
        COALESCE(SUM(event.outputTokens), 0) AS outputTokens,
        MAX(event.observedAt) AS lastObservedAt,
        COUNT(event.eventKey) AS eventCount
      FROM token_usage_subjects AS subject
      LEFT JOIN token_usage_events AS event ON ${joinCondition}
      ${where}
      GROUP BY subject.id
      ORDER BY inputTokens + outputTokens DESC, subject.startedAt
    `,
      )
      .all(...params);
    return z
      .object({
        agentId: z.string().nullable(),
        name: z.string(),
        role: z.string(),
        provider: z.string(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        lastObservedAt: z.string().nullable(),
        eventCount: z.number(),
      })
      .array()
      .parse(rows)
      .filter((row) => row.eventCount > 0)
      .map(({ eventCount: _eventCount, ...row }) => ({
        ...row,
        totalTokens: row.inputTokens + row.outputTokens,
      }));
  }

  async snapshot(repoRoot?: string, limit = 20): Promise<TokenUsageSnapshot> {
    await this.refreshCurrent(repoRoot);
    const rows = z
      .object({ id: z.string() })
      .array()
      .parse(
        repoRoot === undefined
          ? this.database
              .query(
                `
            SELECT id FROM token_usage_sessions ORDER BY startedAt DESC LIMIT ?
          `,
              )
              .all(limit)
          : this.database
              .query(
                `
            SELECT id FROM token_usage_sessions WHERE repoRoot = ?
            ORDER BY startedAt DESC LIMIT ?
          `,
              )
              .all(repoRoot, limit),
      );
    return TokenUsageSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      currentSessionId: this.activeSession(repoRoot)?.id ?? null,
      sessions: rows.map((row) => this.readSession(row.id)),
      attribution: "control-lower-bound",
    });
  }
}
