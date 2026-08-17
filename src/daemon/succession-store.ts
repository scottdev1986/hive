import {
  digestCheckpointContent,
  digestRunCheckpoint,
  type QueenSuccession,
  QueenSuccessionSchema,
  type RunCheckpoint,
  type RunCheckpointInput,
  RunCheckpointInputSchema,
  RunCheckpointSchema,
} from "../schemas/run-checkpoint";
import type { DatabaseHost } from "../shared/database-host";
import { liftStoredSpec } from "./hierarchy-store";

/** What loading the latest checkpoint can find. A corrupt checkpoint is a first-class outcome — the successor converges without it and the contradiction stays on the record — so it is never thrown away here. */
export type CheckpointLoad =
  | { kind: "valid"; checkpoint: RunCheckpoint }
  | { kind: "corrupt"; detail: string }
  | { kind: "absent" };

export type CheckpointRead =
  | {
      state: "present";
      digestVerified: true;
      checkpoint: RunCheckpoint;
    }
  | { state: "absent"; revision: string | "latest" }
  | {
      state: "digest-mismatch";
      revision: string;
      storedDigest: string | null;
      detail: string;
    };

/** A succession-state transition was attempted out of order: replies for a succession that is not open, or an attestation that fails validation. The message says exactly which check refused. */
export class SuccessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuccessionStateError";
  }
}

type DocumentRow = { revision: string; document: string };
type StoredDocumentRow = { rowid: number; document: string };

function migrateBootCapsuleDigest(db: DatabaseHost): void {
  const rows = db.database
    .query(
      `SELECT rowid, document FROM queen_successions
       WHERE document LIKE '%"briefDigest"%'`,
    )
    .all() as StoredDocumentRow[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.document);
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const document = parsed as Record<string, unknown>;
    if (typeof document.briefDigest !== "string") {
      continue;
    }
    document.bootCapsuleDigest ??= document.briefDigest;
    delete document.briefDigest;
    db.database
      .query("UPDATE queen_successions SET document = ? WHERE rowid = ?")
      .run(JSON.stringify(document), row.rowid);
  }
}

type StoredCheckpointRow = {
  instanceId: string;
  revision: string;
  document: string;
};

/** Older checkpoints named the spec `approvedSpec` and stored a leftover `gates` object. The current schema rejects both, so a leftover row loads as corrupt. Rewrite the hierarchy onto `spec`, drop the leftover keys, and recompute the digest so the row verifies. Point any succession that named the old digest at the new one. */
function migrateCheckpointSpec(db: DatabaseHost): void {
  const rows = db.database
    .query(
      `SELECT instanceId, revision, document FROM run_checkpoints
       WHERE document LIKE '%"approvedSpec"%'
          OR document LIKE '%"g1"%'
          OR document LIKE '%"g2"%'
          OR document LIKE '%"gates"%'
          OR document LIKE '%"gate-transition"%'`,
    )
    .all() as StoredCheckpointRow[];
  for (const row of rows) {
    const document = parseJsonObject(row.document);
    if (document === null) continue;
    let changed = false;
    if (document.reason === "gate-transition") {
      document.reason = "run-control";
      changed = true;
    }
    const hierarchy = asRecord(document.hierarchy);
    if (hierarchy !== null && typeof hierarchy.runId === "string") {
      const lifted = liftStoredSpec(hierarchy, db, hierarchy.runId);
      const hadGates = "gates" in hierarchy;
      delete hierarchy.gates;
      if (hierarchy.spec !== null && hierarchy.spec !== undefined) {
        changed = changed || lifted || hadGates;
      }
    }
    if (!changed) continue;
    const previousDigest = document.digest;
    const unsigned = { ...document };
    delete unsigned.digest;
    const digest = digestCheckpointContent(unsigned);
    document.digest = digest;
    db.database
      .query(
        `UPDATE run_checkpoints SET document = ?
         WHERE instanceId = ? AND revision = ?`,
      )
      .run(JSON.stringify(document), row.instanceId, row.revision);
    if (typeof previousDigest === "string" && previousDigest !== digest) {
      retargetSuccessionDigests(
        db,
        row.instanceId,
        row.revision,
        previousDigest,
        digest,
      );
    }
  }
}

function retargetSuccessionDigests(
  db: DatabaseHost,
  instanceId: string,
  checkpointRevision: string,
  from: string,
  to: string,
): void {
  const rows = db.database
    .query(
      `SELECT revision, document FROM queen_successions WHERE instanceId = ?`,
    )
    .all(instanceId) as { revision: string; document: string }[];
  for (const row of rows) {
    const document = parseJsonObject(row.document);
    if (document === null) continue;
    let changed = false;
    const proof = asRecord(document.proof);
    const ref = proof === null ? null : asRecord(proof.ref);
    if (
      proof?.kind === "checkpoint" &&
      ref !== null &&
      ref.revision === checkpointRevision &&
      ref.digest === from
    ) {
      ref.digest = to;
      changed = true;
    }
    const attestation = asRecord(document.attestation);
    if (attestation !== null && attestation.checkpointDigest === from) {
      attestation.checkpointDigest = to;
      changed = true;
    }
    if (!changed) continue;
    db.database
      .query(
        `UPDATE queen_successions SET document = ?
         WHERE instanceId = ? AND revision = ?`,
      )
      .run(JSON.stringify(document), instanceId, row.revision);
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return asRecord(parsed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function latestRow(
  db: DatabaseHost,
  table: "run_checkpoints" | "queen_successions",
  instanceId: string,
): DocumentRow | null {
  return db.database
    .query(
      `SELECT revision, document FROM ${table}
       WHERE instanceId = ?
       ORDER BY CAST(revision AS INTEGER) DESC LIMIT 1`,
    )
    .get(instanceId) as DocumentRow | null;
}

function checkpointRow(
  db: DatabaseHost,
  instanceId: string,
  revision?: string,
): DocumentRow | null {
  if (revision === undefined) {
    return latestRow(db, "run_checkpoints", instanceId);
  }
  return db.database
    .query(
      `SELECT revision, document FROM run_checkpoints
       WHERE instanceId = ? AND revision = ?`,
    )
    .get(instanceId, revision) as DocumentRow | null;
}

function parseCheckpointRow(row: DocumentRow):
  | { kind: "valid"; checkpoint: RunCheckpoint }
  | {
      kind: "invalid";
      read: Extract<CheckpointRead, { state: "digest-mismatch" }>;
    } {
  let json: unknown;
  try {
    json = JSON.parse(row.document);
  } catch {
    return {
      kind: "invalid",
      read: {
        state: "digest-mismatch",
        revision: row.revision,
        storedDigest: null,
        detail: "checkpoint document is not readable JSON",
      },
    };
  }
  const parsed = RunCheckpointSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "invalid",
      read: {
        state: "digest-mismatch",
        revision: row.revision,
        storedDigest: null,
        detail: `checkpoint document fails its schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      },
    };
  }
  return { kind: "valid", checkpoint: parsed.data };
}

function nextRevision(row: DocumentRow | null): string {
  return row === null ? "1" : (BigInt(row.revision) + 1n).toString();
}

/** Persistence for the succession record kinds. Both record tables are append-only per instance; the store assigns revisions inside the same transaction as the insert, so a concurrent writer cannot slip a revision between the read and the write. */
export class SuccessionStore {
  constructor(private readonly db: DatabaseHost) {
    db.database.exec(`
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        instanceId TEXT NOT NULL,
        revision TEXT NOT NULL,
        recordedAt TEXT NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (instanceId, revision)
      );
      CREATE TABLE IF NOT EXISTS queen_successions (
        instanceId TEXT NOT NULL,
        revision TEXT NOT NULL,
        successionId TEXT NOT NULL,
        recordedAt TEXT NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (instanceId, revision)
      );
      CREATE TABLE IF NOT EXISTS queen_succession_reads (
        successionId TEXT NOT NULL,
        kind TEXT NOT NULL,
        capabilityId TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (successionId, kind, capabilityId)
      )
    `);
    migrateBootCapsuleDigest(db);
    migrateCheckpointSpec(db);
  }

  /** Run a load-and-decide and its record write as one atomic step. The proof a succession declares names the checkpoint the same transaction loaded — without the shared boundary a concurrent checkpoint write could supersede it in between. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  /** Append one checkpoint. Revision, creation time, and digest are assigned here — provenance is fixed at creation and immutable after. The input is parsed at the door, so a caller-supplied spine (a revision, a digest, a creation time) is refused, never silently overwritten. */
  writeCheckpoint(input: RunCheckpointInput, at: string): RunCheckpoint {
    const parsedInput = RunCheckpointInputSchema.parse(input);
    return this.db.transaction(() => {
      const revision = nextRevision(
        latestRow(this.db, "run_checkpoints", parsedInput.instanceId),
      );
      const unsigned = { ...parsedInput, revision, createdAt: at };
      const record = RunCheckpointSchema.parse({
        ...unsigned,
        digest: digestRunCheckpoint(unsigned),
      });
      this.db.database
        .query(
          `INSERT INTO run_checkpoints (instanceId, revision, recordedAt, document)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          record.instanceId,
          record.revision,
          record.createdAt,
          JSON.stringify(record),
        );
      return record;
    });
  }

  readCheckpoint(instanceId: string, revision?: string): CheckpointRead {
    const row = checkpointRow(this.db, instanceId, revision);
    if (row === null) {
      return { state: "absent", revision: revision ?? "latest" };
    }
    const parsed = parseCheckpointRow(row);
    if (parsed.kind === "invalid") return parsed.read;
    const checkpoint = parsed.checkpoint;
    const { digest, ...unsigned } = checkpoint;
    if (digestRunCheckpoint(unsigned) !== digest) {
      return {
        state: "digest-mismatch",
        revision: row.revision,
        storedDigest: digest,
        detail: "checkpoint digest does not match its content",
      };
    }
    return {
      state: "present",
      digestVerified: true,
      checkpoint,
    };
  }

  loadLatestCheckpoint(instanceId: string): CheckpointLoad {
    const read = this.readCheckpoint(instanceId);
    if (read.state === "absent") return { kind: "absent" };
    if (read.state === "digest-mismatch") {
      const detail = read.detail.includes("digest does not match")
        ? "fails digest verification"
        : read.detail
            .replace("checkpoint document is", "is")
            .replace("checkpoint document fails", "fails");
      return {
        kind: "corrupt",
        detail: `checkpoint revision ${read.revision} ${detail}`,
      };
    }
    return { kind: "valid", checkpoint: read.checkpoint };
  }

  successionForRequest(
    instanceId: string,
    requestId: string,
  ): QueenSuccession | null {
    const row = this.db.database
      .query(
        `SELECT document FROM queen_successions WHERE instanceId = ?
         ORDER BY CAST(revision AS INTEGER) DESC`,
      )
      .all(instanceId) as { document: string }[];
    return (
      row
        .map((entry) => QueenSuccessionSchema.parse(JSON.parse(entry.document)))
        .find((record) => record.launchRequestId === requestId) ?? null
    );
  }

  /** Append a freshly declared succession, attestation still open. */
  appendSuccession(record: Omit<QueenSuccession, "revision">): QueenSuccession {
    return this.db.transaction(() => {
      const revision = nextRevision(
        latestRow(this.db, "queen_successions", record.instanceId),
      );
      const parsed = QueenSuccessionSchema.parse({ ...record, revision });
      this.db.database
        .query(
          `INSERT INTO queen_successions (instanceId, revision, successionId, recordedAt, document)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.instanceId,
          parsed.revision,
          parsed.successionId,
          parsed.createdAt,
          JSON.stringify(parsed),
        );
      return parsed;
    });
  }

  /** The newest succession, or null. Daemon-written rows are parsed strictly: a succession record that does not parse is daemon damage, not a recoverable input, and it fails loudly. */
  latestSuccession(instanceId: string): QueenSuccession | null {
    const row = latestRow(this.db, "queen_successions", instanceId);
    if (row === null) return null;
    return QueenSuccessionSchema.parse(JSON.parse(row.document));
  }

  priorSuccessionId(instanceId: string, revision: string): string | null {
    const row = this.db.database
      .query(
        `SELECT successionId FROM queen_successions
         WHERE instanceId = ? AND CAST(revision AS INTEGER) < CAST(? AS INTEGER)
         ORDER BY CAST(revision AS INTEGER) DESC LIMIT 1`,
      )
      .get(instanceId, revision) as { successionId: string } | null;
    return row?.successionId ?? null;
  }

  /** Every succession still waiting for its attestation. */
  listOpenSuccessions(instanceId: string): QueenSuccession[] {
    const rows = this.db.database
      .query(
        `SELECT document FROM queen_successions WHERE instanceId = ?
         ORDER BY CAST(revision AS INTEGER) ASC`,
      )
      .all(instanceId) as { document: string }[];
    return rows
      .map((row) => QueenSuccessionSchema.parse(JSON.parse(row.document)))
      .filter((record) => record.attestation === null);
  }

  /** Record the measured replies on the open row. Alongside the attestation this is the record's only defined update path: written at declaration, replies appended as they are measured, completed exactly once. */
  recordReplies(record: QueenSuccession): void {
    if (record.attestation !== null) {
      throw new SuccessionStateError(
        "cannot record replies on an attested succession",
      );
    }
    this.db.database
      .query(
        `UPDATE queen_successions SET document = ?
         WHERE instanceId = ? AND revision = ?`,
      )
      .run(JSON.stringify(record), record.instanceId, record.revision);
  }

  /** Record the attestation on the open row. This completes the record: it is never rewritten after. */
  completeSuccession(record: QueenSuccession): void {
    if (record.attestation === null) {
      throw new SuccessionStateError(
        "cannot complete a succession without an attestation",
      );
    }
    this.db.database
      .query(
        `UPDATE queen_successions SET document = ?
         WHERE instanceId = ? AND revision = ?`,
      )
      .run(JSON.stringify(record), record.instanceId, record.revision);
  }

  /** Record one measured re-read by the successor, idempotently. */
  recordRead(
    successionId: string,
    kind: "status" | "inbox" | "board" | "checkpoint",
    capabilityId: string,
    at: string,
  ): void {
    this.db.database
      .query(
        `INSERT INTO queen_succession_reads (successionId, kind, capabilityId, at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(successionId, kind, capabilityId) DO NOTHING`,
      )
      .run(successionId, kind, capabilityId, at);
  }

  /** Which re-read kinds ONE credential has measured for one succession. */
  readsFor(successionId: string, capabilityId: string): ReadonlySet<string> {
    const rows = this.db.database
      .query(
        `SELECT kind FROM queen_succession_reads
         WHERE successionId = ? AND capabilityId = ?`,
      )
      .all(successionId, capabilityId) as { kind: string }[];
    return new Set(rows.map((row) => row.kind));
  }
}
