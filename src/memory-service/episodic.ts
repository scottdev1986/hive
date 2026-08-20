// The per-project episodic store: the daemon's typed record of what happened and what is currently believed, for exactly one project. The store file lives under the per-project state directory keyed by the project registry's hiveUuid, so two projects can never share a store and no caller ever names the project a query runs against — isolation is the directory layout, not a parameter. Facts are bi-temporal and immutable: a contradiction is a new row plus an `invalid_at` stamp on the old one with a `supersedes_id` pointer between them. There is deliberately no delete path — `invalid_at IS NULL` is the "currently believed" filter and everything else is history.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { projectStateDir } from "../daemon/project-identity-core/state";

const SCHEMA_VERSION = "3";

const ADMISSION_REJECTED_TOTAL_KEY = "memoryAdmission.rejectedTotal";
const ADMISSION_LAST_REJECTED_AT_KEY = "memoryAdmission.lastRejectedAt";

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const EpisodicEventSchema = z.object({
  id: z.number().int().positive(),
  ts: IsoTimestampSchema,
  agent: z.string().min(1).nullable(),
  type: z.string().min(1),
  summary: z.string(),
  provenance: z.string(),
});
export type EpisodicEvent = z.infer<typeof EpisodicEventSchema>;

export const NewEpisodicEventSchema = z.object({
  ts: IsoTimestampSchema.optional(),
  agent: z.string().min(1).nullable().default(null),
  type: z.string().min(1),
  summary: z.string(),
  provenance: z.record(z.string(), z.unknown()).default({}),
});
export type NewEpisodicEvent = z.input<typeof NewEpisodicEventSchema>;

export interface MemoryAdmissionStats {
  seenCandidates: number;
  rejectedTotal: number;
  lastRejectedAt: string | null;
}

const EventRowSchema = z.object({
  id: z.number(),
  ts: z.string(),
  agent: z.string().nullable(),
  type: z.string(),
  summary: z.string(),
  provenance: z.string(),
});

export interface MemoryEmbeddingRow {
  kind: "article" | "fact";
  scope: string;
  sourceId: string;
  model: string;
  dimensions: number;
  vector: Float32Array;
  embeddedAt: string;
}

const EmbeddingRowSchema = z.object({
  kind: z.enum(["article", "fact"]),
  scope: z.string(),
  source_id: z.string(),
  model: z.string(),
  dimensions: z.number().int().positive(),
  vector: z.instanceof(Uint8Array),
  embedded_at: z.string(),
});

function parseEmbeddingRow(row: unknown): MemoryEmbeddingRow {
  const stored = EmbeddingRowSchema.parse(row);
  const bytes = stored.vector;
  return {
    kind: stored.kind,
    scope: stored.scope,
    sourceId: stored.source_id,
    model: stored.model,
    dimensions: stored.dimensions,
    vector: new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4,
    ),
    embeddedAt: stored.embedded_at,
  };
}

export class EpisodicStore {
  readonly path: string;
  private readonly database: Database;

  /** The store for the project `root` belongs to, at the per-project state directory the project registry's identity resolves to. This is the only way production code opens a store: the location is derived from the daemon's own project identity, never from a caller-supplied scope. */
  static forProjectRoot(root: string): EpisodicStore {
    return new EpisodicStore(join(projectStateDir(root), "episodic.db"));
  }

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- Row presence is the doorkeeper's one bit. The first observation
      -- inserts it; every later observation finds it already set.
      CREATE TABLE IF NOT EXISTS memory_doorkeeper (
        signature TEXT PRIMARY KEY
      );
      -- Retired: nothing writes the facts or digests tables any more. They
      -- are still created so every store has the same shape as the ones
      -- already holding rows, and so the health readout can count what is at
      -- rest.
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision')),
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        valid_at TEXT NOT NULL,
        invalid_at TEXT,
        expired_at TEXT,
        supersedes_id TEXT REFERENCES facts(id)
      );
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT,
        session_id TEXT,
        compiled_at TEXT NOT NULL,
        body TEXT NOT NULL,
        provenance TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        agent TEXT,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        provenance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_agent_ts ON events(agent, ts);
      -- The semantic recall leg's vector store:
      -- one row per embedded source — a wiki article (kind 'article', scope
      -- repo/global) or an episodic fact (kind 'fact', scope ''). The vector
      -- is the model's Float32 embedding as raw bytes; corpora are small, so
      -- search is brute-force cosine in JS and no sqlite-vec native
      -- dependency is taken. Rows are a disposable projection maintained on
      -- the write paths and pruned when their source disappears.
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        kind TEXT NOT NULL CHECK (kind IN ('article', 'fact')),
        scope TEXT NOT NULL,
        source_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (kind, scope, source_id)
      );
    `);
    this.database
      .query(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('schemaVersion', ?)",
      )
      .run(SCHEMA_VERSION);
    this.database
      .query(
        "UPDATE meta SET value = ? WHERE key = 'schemaVersion' AND value != ?",
      )
      .run(SCHEMA_VERSION, SCHEMA_VERSION);
  }

  appendEvent(rawInput: NewEpisodicEvent): EpisodicEvent {
    const input = NewEpisodicEventSchema.parse(rawInput);
    const ts = input.ts ?? new Date().toISOString();
    const provenance = JSON.stringify(input.provenance);
    this.database
      .query(
        `
      INSERT INTO events (ts, agent, type, summary, provenance)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(ts, input.agent, input.type, input.summary, provenance);
    const row = this.database
      .query(
        `
      SELECT * FROM events WHERE id = last_insert_rowid()
    `,
      )
      .get();
    return EpisodicEventSchema.parse(EventRowSchema.parse(row));
  }

  rowCounts(): { events: number; facts: number; digests: number } {
    const count = (sql: string): number =>
      z.object({ count: z.number() }).parse(this.database.query(sql).get())
        .count;
    return {
      events: count("SELECT COUNT(*) AS count FROM events"),
      facts: count("SELECT COUNT(*) AS count FROM facts"),
      digests: count("SELECT COUNT(*) AS count FROM digests"),
    };
  }

  eventsFor(filter: { agent?: string; since?: string } = {}): EpisodicEvent[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.agent !== undefined) {
      clauses.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(IsoTimestampSchema.parse(filter.since));
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    return this.database
      .query(`SELECT * FROM events${where} ORDER BY id`)
      .all(...params)
      .map((row) => EpisodicEventSchema.parse(EventRowSchema.parse(row)));
  }

  readMeta(key: string): string | null {
    const row = this.database
      .query("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | null;
    return row === null ? null : row.value;
  }

  writeMeta(key: string, value: string): void {
    this.database
      .query(
        `
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
      )
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.database.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  metaKeys(prefix: string): string[] {
    const rows = this.database
      .query("SELECT key FROM meta WHERE key LIKE ? ORDER BY key")
      .all(`${prefix}%`) as Array<{ key: string }>;
    return rows.map((row) => row.key);
  }

  observeMemoryCandidate(input: {
    signature: string;
    observedAt: string;
    firstObservationReceipt: { key: string; value: string };
  }): "rejected" | "admitted" {
    const observedAt = IsoTimestampSchema.parse(input.observedAt);
    return this.database.transaction(() => {
      const inserted = this.database
        .query(
          `INSERT INTO memory_doorkeeper (signature) VALUES (?)
           ON CONFLICT(signature) DO NOTHING
           RETURNING signature`,
        )
        .get(input.signature);
      if (inserted === null) return "admitted";
      this.writeMeta(
        input.firstObservationReceipt.key,
        input.firstObservationReceipt.value,
      );
      const rejected = Number(this.readMeta(ADMISSION_REJECTED_TOTAL_KEY));
      this.writeMeta(
        ADMISSION_REJECTED_TOTAL_KEY,
        String(Number.isInteger(rejected) && rejected >= 0 ? rejected + 1 : 1),
      );
      this.writeMeta(ADMISSION_LAST_REJECTED_AT_KEY, observedAt);
      return "rejected";
    })();
  }

  memoryAdmissionStats(): MemoryAdmissionStats {
    const count = this.database
      .query("SELECT COUNT(*) AS count FROM memory_doorkeeper")
      .get() as { count: number };
    const rejected = Number(this.readMeta(ADMISSION_REJECTED_TOTAL_KEY));
    return {
      seenCandidates: count.count,
      rejectedTotal: Number.isInteger(rejected) && rejected >= 0 ? rejected : 0,
      lastRejectedAt: this.readMeta(ADMISSION_LAST_REJECTED_AT_KEY),
    };
  }

  eventsByIds(ids: readonly number[]): EpisodicEvent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.database
      .query(`SELECT * FROM events WHERE id IN (${placeholders})`)
      .all(...ids)
      .map((row) => EpisodicEventSchema.parse(EventRowSchema.parse(row)));
    const byId = new Map(rows.map((event) => [event.id, event]));
    return ids.flatMap((id) => {
      const event = byId.get(id);
      return event === undefined ? [] : [event];
    });
  }

  /** Delete `events` rows older than `cutoff` (ISO timestamp; the column's format sorts lexicographically) except the ids in `keepIds` — a digest-referenced event is a drill-down target, not garbage. Returns the number of rows actually deleted. Facts and digests are never swept: that is an invariant, so there is deliberately no parameter for them. */
  sweepEvents(cutoff: string, keepIds: ReadonlySet<number>): number {
    const at = IsoTimestampSchema.parse(cutoff);
    const candidates = this.database
      .query("SELECT id FROM events WHERE ts < ?")
      .all(at)
      .map((row) => z.object({ id: z.number() }).parse(row).id);
    const deletable = candidates.filter((id) => !keepIds.has(id));
    if (deletable.length === 0) return 0;
    const placeholders = deletable.map(() => "?").join(", ");
    this.database
      .query(`DELETE FROM events WHERE id IN (${placeholders})`)
      .run(...deletable);
    return deletable.length;
  }

  upsertMemoryEmbedding(input: {
    kind: "article" | "fact";
    scope: string;
    sourceId: string;
    model: string;
    vector: Float32Array;
    embeddedAt?: string;
  }): void {
    const embeddedAt = input.embeddedAt ?? new Date().toISOString();
    IsoTimestampSchema.parse(embeddedAt);
    this.database
      .query(
        `
      INSERT INTO memory_embeddings (
        kind, scope, source_id, model, dimensions, vector, embedded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, scope, source_id) DO UPDATE SET
        model = excluded.model,
        dimensions = excluded.dimensions,
        vector = excluded.vector,
        embedded_at = excluded.embedded_at
    `,
      )
      .run(
        input.kind,
        input.scope,
        input.sourceId,
        input.model,
        input.vector.length,
        new Uint8Array(
          input.vector.buffer,
          input.vector.byteOffset,
          input.vector.byteLength,
        ),
        embeddedAt,
      );
  }

  removeMemoryEmbedding(
    kind: "article" | "fact",
    scope: string,
    sourceId: string,
  ): void {
    this.database
      .query(
        `
      DELETE FROM memory_embeddings
      WHERE kind = ? AND scope = ? AND source_id = ?
    `,
      )
      .run(kind, scope, sourceId);
  }

  memoryEmbeddings(
    filter: { kind?: "article" | "fact" } = {},
  ): MemoryEmbeddingRow[] {
    const rows =
      filter.kind === undefined
        ? this.database
            .query(
              "SELECT * FROM memory_embeddings ORDER BY kind, scope, source_id",
            )
            .all()
        : this.database
            .query(
              "SELECT * FROM memory_embeddings WHERE kind = ? " +
                "ORDER BY kind, scope, source_id",
            )
            .all(filter.kind);
    return rows.map(parseEmbeddingRow);
  }

  memoryEmbeddingCounts(): { articles: number; facts: number } {
    const rows = this.database
      .query(
        "SELECT kind, COUNT(*) AS count FROM memory_embeddings GROUP BY kind",
      )
      .all() as Array<{ kind: string; count: number }>;
    return {
      articles: rows.find((row) => row.kind === "article")?.count ?? 0,
      facts: rows.find((row) => row.kind === "fact")?.count ?? 0,
    };
  }

  /** Delete vector rows whose source no longer exists: an article not in `keep.articles` ("scope:id" keys) or a fact not in `keep.facts` (ids of currently-believed facts — an invalidated fact's vector is stale too). Returns the number of rows deleted. */
  pruneMemoryEmbeddings(keepArticles: ReadonlySet<string>): number {
    const stale = this.memoryEmbeddings().filter(
      (row) =>
        row.kind === "article" &&
        !keepArticles.has(`${row.scope}:${row.sourceId}`),
    );
    for (const row of stale) {
      this.removeMemoryEmbedding(row.kind, row.scope, row.sourceId);
    }
    return stale.length;
  }

  close(): void {
    this.database.close();
  }
}
