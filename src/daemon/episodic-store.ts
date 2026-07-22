// The per-project episodic store (HiveMemory HM-1 WP1): the daemon's typed
// record of what happened and what is currently believed, for exactly one
// project. The store file lives under the per-project state directory keyed by
// the project registry's hiveUuid, so two projects can never share a store and
// no caller ever names the project a query runs against — isolation is the
// directory layout, not a parameter.
//
// Facts are bi-temporal and immutable: a contradiction is a new row plus an
// `invalid_at` stamp on the old one with a `supersedes_id` pointer between
// them. There is deliberately no delete path — `invalid_at IS NULL` is the
// "currently believed" filter and everything else is history.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { projectStateDir } from "./project-state";

const SCHEMA_VERSION = "1";

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const EpisodicFactKindSchema = z.enum(["fact", "decision"]);
export type EpisodicFactKind = z.infer<typeof EpisodicFactKindSchema>;

export const EpisodicFactSchema = z.object({
  id: z.string().min(1),
  kind: EpisodicFactKindSchema,
  topic: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1),
  createdAt: IsoTimestampSchema,
  validAt: IsoTimestampSchema,
  invalidAt: IsoTimestampSchema.nullable(),
  expiredAt: IsoTimestampSchema.nullable(),
  supersedesId: z.string().min(1).nullable(),
});
export type EpisodicFact = z.infer<typeof EpisodicFactSchema>;

export const NewEpisodicFactSchema = z.object({
  kind: EpisodicFactKindSchema.default("fact"),
  topic: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  /** When this belief became true; defaults to the record instant. */
  validAt: IsoTimestampSchema.optional(),
  /** Recording this fact contradicts the currently-valid fact with this id:
   * the old row is stamped invalid in the same transaction that inserts the
   * new one. */
  supersedesId: z.string().min(1).optional(),
});
export type NewEpisodicFact = z.input<typeof NewEpisodicFactSchema>;

export const EpisodicEventSchema = z.object({
  id: z.number().int().positive(),
  ts: IsoTimestampSchema,
  agent: z.string().min(1).nullable(),
  type: z.string().min(1),
  summary: z.string(),
  /** JSON: pointers back to the primary record this event was projected from
   * (status event id/seq, entity, source). */
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

const FactRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  topic: z.string(),
  title: z.string(),
  body: z.string(),
  source: z.string(),
  confidence: z.number(),
  created_at: z.string(),
  valid_at: z.string(),
  invalid_at: z.string().nullable(),
  expired_at: z.string().nullable(),
  supersedes_id: z.string().nullable(),
});

const EventRowSchema = z.object({
  id: z.number(),
  ts: z.string(),
  agent: z.string().nullable(),
  type: z.string(),
  summary: z.string(),
  provenance: z.string(),
});

function parseFactRow(row: unknown): EpisodicFact {
  const stored = FactRowSchema.parse(row);
  return EpisodicFactSchema.parse({
    id: stored.id,
    kind: stored.kind,
    topic: stored.topic,
    title: stored.title,
    body: stored.body,
    source: stored.source,
    confidence: stored.confidence,
    createdAt: stored.created_at,
    validAt: stored.valid_at,
    invalidAt: stored.invalid_at,
    expiredAt: stored.expired_at,
    supersedesId: stored.supersedes_id,
  });
}

export class EpisodicStore {
  readonly path: string;
  private readonly database: Database;

  /** The store for the project `root` belongs to, at the per-project state
   * directory the project registry's identity resolves to. This is the only
   * way production code opens a store: the location is derived from the
   * daemon's own project identity, never from a caller-supplied scope. */
  static forProjectRoot(root: string): EpisodicStore {
    return new EpisodicStore(join(projectStateDir(root), "episodic.db"));
  }

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new Database(path, { create: true });
    // Same connection posture as the daemon's own database (db.ts).
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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
        -- NULL means currently believed. Contradiction stamps this; rows are
        -- never deleted, so history is always reconstructible.
        invalid_at TEXT,
        expired_at TEXT,
        supersedes_id TEXT REFERENCES facts(id)
      );
      CREATE INDEX IF NOT EXISTS facts_current_topic
        ON facts(topic) WHERE invalid_at IS NULL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        agent TEXT,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        provenance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_agent_ts ON events(agent, ts);
      -- Placeholder for WP4's session digests: the table exists now so later
      -- work adds rows, not schema.
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT,
        session_id TEXT,
        compiled_at TEXT NOT NULL,
        body TEXT NOT NULL,
        provenance TEXT NOT NULL
      );
    `);
    this.database.query(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('schemaVersion', ?)",
    ).run(SCHEMA_VERSION);
  }

  recordFact(rawInput: NewEpisodicFact): EpisodicFact {
    const input = NewEpisodicFactSchema.parse(rawInput);
    const createdAt = new Date().toISOString();
    const fact = EpisodicFactSchema.parse({
      id: crypto.randomUUID(),
      kind: input.kind,
      topic: input.topic,
      title: input.title,
      body: input.body,
      source: input.source,
      confidence: input.confidence,
      createdAt,
      validAt: input.validAt ?? createdAt,
      invalidAt: null,
      expiredAt: null,
      supersedesId: input.supersedesId ?? null,
    });
    this.database.transaction(() => {
      if (input.supersedesId !== undefined) {
        // The contradiction: the superseded belief stops being current at the
        // instant its replacement becomes valid. The row itself stays.
        this.database.query(`
          UPDATE facts SET invalid_at = ?
          WHERE id = ? AND invalid_at IS NULL
        `).run(fact.validAt, input.supersedesId);
      }
      this.insertFact(fact);
    })();
    return fact;
  }

  private insertFact(fact: EpisodicFact): void {
    this.database.query(`
      INSERT INTO facts (
        id, kind, topic, title, body, source, confidence,
        created_at, valid_at, invalid_at, expired_at, supersedes_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fact.id,
      fact.kind,
      fact.topic,
      fact.title,
      fact.body,
      fact.source,
      fact.confidence,
      fact.createdAt,
      fact.validAt,
      fact.invalidAt,
      fact.expiredAt,
      fact.supersedesId,
    );
  }

  /** Stamp a currently-valid fact as no longer believed. When `supersededBy`
   * names the fact that replaces it, that row's pointer is linked back here.
   * Returns the invalidated row, or null when nothing currently-valid matches. */
  invalidateFact(
    id: string,
    options: { supersededBy?: string; at?: string } = {},
  ): EpisodicFact | null {
    const at = options.at ?? new Date().toISOString();
    return this.database.transaction(() => {
      const current = this.database.query(`
        SELECT * FROM facts WHERE id = ? AND invalid_at IS NULL
      `).get(id);
      if (current === null) return null;
      this.database.query(`
        UPDATE facts SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL
      `).run(at, id);
      if (options.supersededBy !== undefined) {
        this.database.query(`
          UPDATE facts SET supersedes_id = ? WHERE id = ?
        `).run(id, options.supersededBy);
      }
      return parseFactRow(
        this.database.query("SELECT * FROM facts WHERE id = ?").get(id),
      );
    })();
  }

  /** The beliefs held now: every fact never contradicted or expired. */
  currentFacts(): EpisodicFact[] {
    return this.database.query(`
      SELECT * FROM facts WHERE invalid_at IS NULL ORDER BY created_at, id
    `).all().map(parseFactRow);
  }

  /** The beliefs held at `ts`: valid by then and not yet contradicted. */
  factsAsOf(ts: string): EpisodicFact[] {
    const at = IsoTimestampSchema.parse(ts);
    return this.database.query(`
      SELECT * FROM facts
      WHERE valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)
      ORDER BY valid_at, id
    `).all(at, at).map(parseFactRow);
  }

  appendEvent(rawInput: NewEpisodicEvent): EpisodicEvent {
    const input = NewEpisodicEventSchema.parse(rawInput);
    const ts = input.ts ?? new Date().toISOString();
    const provenance = JSON.stringify(input.provenance);
    this.database.query(`
      INSERT INTO events (ts, agent, type, summary, provenance)
      VALUES (?, ?, ?, ?, ?)
    `).run(ts, input.agent, input.type, input.summary, provenance);
    const row = this.database.query(`
      SELECT * FROM events WHERE id = last_insert_rowid()
    `).get();
    return EpisodicEventSchema.parse(EventRowSchema.parse(row));
  }

  /** Row counts per table, for cheap staleness checks by derived readers
   * (the L1 search index rebuilds only when these move). */
  rowCounts(): { events: number; facts: number } {
    const events = z.object({ count: z.number() }).parse(
      this.database.query("SELECT COUNT(*) AS count FROM events").get(),
    ).count;
    const facts = z.object({ count: z.number() }).parse(
      this.database.query("SELECT COUNT(*) AS count FROM facts").get(),
    ).count;
    return { events, facts };
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
    return this.database.query(
      `SELECT * FROM events${where} ORDER BY id`,
    ).all(...params).map((row) =>
      EpisodicEventSchema.parse(EventRowSchema.parse(row))
    );
  }

  /** Raw provenance JSON of every digest row (HiveMemory HM-2 WP3): the
   * retention sweep parses these to learn which event rows are still a
   * digest's drill-down target and must survive the hot-tier cutoff. */
  digestProvenanceBlobs(): string[] {
    return this.database.query("SELECT provenance FROM digests ORDER BY id")
      .all()
      .map((row) => z.object({ provenance: z.string() }).parse(row).provenance);
  }

  /** Delete `events` rows older than `cutoff` (ISO timestamp; the column's
   * format sorts lexicographically) except the ids in `keepIds` — a
   * digest-referenced event is a drill-down target, not garbage. Returns the
   * number of rows actually deleted. Facts and digests are never swept: that
   * is an invariant, so there is deliberately no parameter for them. */
  sweepEvents(cutoff: string, keepIds: ReadonlySet<number>): number {
    const at = IsoTimestampSchema.parse(cutoff);
    const candidates = this.database.query(
      "SELECT id FROM events WHERE ts < ?",
    ).all(at).map((row) => z.object({ id: z.number() }).parse(row).id);
    const deletable = candidates.filter((id) => !keepIds.has(id));
    if (deletable.length === 0) return 0;
    const placeholders = deletable.map(() => "?").join(", ");
    this.database.query(
      `DELETE FROM events WHERE id IN (${placeholders})`,
    ).run(...deletable);
    return deletable.length;
  }

  close(): void {
    this.database.close();
  }
}
