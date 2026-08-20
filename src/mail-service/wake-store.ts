import type { MailLane } from "../schemas/mail";
import type {
  MailDeliveryState,
  MailEvidenceKind,
  MailReadyEvent,
} from "../schemas/mail-wake";
import type { DatabaseHost } from "../shared/database-host";

/** Durable rows behind the wake path: what the daemon told a frontend, what the frontend admitted hearing, which wakes are outstanding, and the evidence every delivery transition was written from. The mailbox itself is untouched. These tables observe it; they never decide whether an item exists or who may read it. */

export type MailWakeState =
  "queued" | "requested" | "observed" | "settled" | "dead_lettered";

export type MailWakeRow = Readonly<{
  wakeId: string;
  recipient: string;
  lane: MailLane;
  oldestItemId: string;
  state: MailWakeState;
  attempts: number;
  nextAttemptAt: string | null;
  clientInputId: string | null;
  turnEventId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type MailDeliveryRow = Readonly<{
  id: number;
  itemId: string;
  recipient: string;
  lane: MailLane | null;
  state: MailDeliveryState;
  evidenceKind: MailEvidenceKind;
  /** The row that proves it: an item id, lease handler, event id, receipt id. */
  evidenceRef: string;
  at: string;
}>;

const DELIVERY_COLUMNS = `id, itemId, recipient, lane, state, evidenceKind, evidenceRef, at`;

const TERMINAL_DELIVERY_STATES = [
  "completed",
  "deferred",
  "rejected",
  "dead_lettered",
  "delivery_unknown",
] as const;

const WAKE_COLUMNS = `wakeId, recipient, lane, oldestItemId, state, attempts,
  nextAttemptAt, clientInputId, turnEventId, createdAt, updatedAt`;

const MAIL_WAKE_SCHEMA_DDL = `
  -- The cursor is the notification's own number, not the mailbox's. They come
  -- apart whenever the same message is announced twice: settling one item makes
  -- an older one offerable without any new mail arriving, and that second
  -- announcement has to carry a number past whatever the frontend last
  -- acknowledged or a resume would step straight over it.
  --
  -- The uniqueness constraint is what keeps a repeat harmless: the same answer
  -- about the same message files nothing new, while a different answer about
  -- the same sequence is a second fact and gets its own row.
  CREATE TABLE IF NOT EXISTS mail_ready_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    brokerSeq INTEGER NOT NULL,
    lane TEXT NOT NULL,
    oldestItemId TEXT NOT NULL,
    backlogCount INTEGER NOT NULL,
    at TEXT NOT NULL,
    UNIQUE (recipient, brokerSeq, oldestItemId)
  );

  CREATE INDEX IF NOT EXISTS mail_ready_events_recipient
    ON mail_ready_events(recipient, cursor);

  CREATE TABLE IF NOT EXISTS mail_ready_acks (
    recipient TEXT PRIMARY KEY,
    brokerSeq INTEGER NOT NULL,
    at TEXT NOT NULL
  );

  -- oldestItemId is UNIQUE, which is the whole idempotency story: two wakes
  -- raised for the same waiting item collapse into the row that already exists
  -- rather than starting a second turn for one message.
  CREATE TABLE IF NOT EXISTS mail_wakes (
    wakeId TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    lane TEXT NOT NULL,
    oldestItemId TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    nextAttemptAt TEXT,
    clientInputId TEXT,
    turnEventId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS mail_wakes_pending
    ON mail_wakes(recipient, state, nextAttemptAt);

  -- Append-only. A transition is never rewritten, so the chain that survives is
  -- the evidence trail itself rather than a summary that outlived its proof.
  CREATE TABLE IF NOT EXISTS mail_delivery_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId TEXT NOT NULL,
    recipient TEXT NOT NULL,
    lane TEXT,
    state TEXT NOT NULL,
    evidenceKind TEXT NOT NULL,
    evidenceRef TEXT NOT NULL,
    at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS mail_delivery_events_item
    ON mail_delivery_events(itemId, id);
  CREATE INDEX IF NOT EXISTS mail_delivery_events_recipient
    ON mail_delivery_events(recipient, id);
`;

export class MailWakeStore {
  constructor(private readonly db: DatabaseHost) {
    db.transaction(() => {
      db.database.exec(MAIL_WAKE_SCHEMA_DDL);
    });
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation);
  }

  /** Files one mail-ready notification and returns it with its cursor. Repeating an announcement already on file returns the original's cursor rather than minting a second one, so a redelivered publish receipt leaves a resuming frontend exactly one thing to read. */
  recordReady(event: Omit<MailReadyEvent, "cursor">): MailReadyEvent {
    const row = this.db.database
      .query(
        `
        INSERT INTO mail_ready_events
          (recipient, brokerSeq, lane, oldestItemId, backlogCount, at)
        VALUES ($recipient, $brokerSeq, $lane, $oldestItemId, $backlogCount, $at)
        ON CONFLICT (recipient, brokerSeq, oldestItemId)
          DO UPDATE SET backlogCount = excluded.backlogCount
        RETURNING cursor
      `,
      )
      .get({
        $recipient: event.recipient,
        $brokerSeq: event.brokerSeq,
        $lane: event.lane,
        $oldestItemId: event.oldestItemId,
        $backlogCount: event.backlogCount,
        $at: event.at,
      }) as { cursor: number };
    return { ...event, cursor: row.cursor };
  }

  readySince(recipient: string, sinceCursor: number): MailReadyEvent[] {
    return this.readyRows(
      `WHERE recipient = ? AND cursor > ? ORDER BY cursor ASC`,
      recipient,
      sinceCursor,
    );
  }

  readyAt(recipient: string, cursor: number): MailReadyEvent | null {
    return (
      this.readyRows(
        `WHERE recipient = ? AND cursor = ? ORDER BY cursor ASC`,
        recipient,
        cursor,
      )[0] ?? null
    );
  }

  private readyRows(
    where: string,
    recipient: string,
    bound: number,
  ): MailReadyEvent[] {
    const rows = this.db.database
      .query(
        `SELECT cursor, recipient, brokerSeq, lane, oldestItemId, backlogCount, at
           FROM mail_ready_events ${where}`,
      )
      .all(recipient, bound) as Array<{
      cursor: number;
      recipient: string;
      brokerSeq: number;
      lane: string;
      oldestItemId: string;
      backlogCount: number;
      at: string;
    }>;
    return rows.map((row) => ({
      kind: "mail-ready",
      schemaVersion: 1,
      recipient: row.recipient,
      lane: row.lane as MailLane,
      oldestItemId: row.oldestItemId,
      backlogCount: row.backlogCount,
      brokerSeq: row.brokerSeq,
      cursor: row.cursor,
      at: row.at,
    }));
  }

  latestReadySeq(recipient: string): number | null {
    const row = this.db.database
      .query(
        "SELECT MAX(brokerSeq) AS seq FROM mail_ready_events WHERE recipient = ?",
      )
      .get(recipient) as { seq: number | null } | null;
    return row?.seq ?? null;
  }

  /** Retains the largest mailbox sequence among exact notification acks for
   * diagnostics. This is not a resume cursor or delivery proof; the ledger uses
   * the acknowledged event's cursor for those decisions. */
  recordAck(recipient: string, brokerSeq: number, at: string): void {
    this.db.database
      .query(
        `
        INSERT INTO mail_ready_acks (recipient, brokerSeq, at)
        VALUES ($recipient, $brokerSeq, $at)
        ON CONFLICT(recipient) DO UPDATE SET
          brokerSeq = MAX(brokerSeq, excluded.brokerSeq),
          at = CASE WHEN excluded.brokerSeq > brokerSeq THEN excluded.at ELSE at END
      `,
      )
      .run({ $recipient: recipient, $brokerSeq: brokerSeq, $at: at });
  }

  ack(recipient: string): { brokerSeq: number; at: string } | null {
    return (this.db.database
      .query("SELECT brokerSeq, at FROM mail_ready_acks WHERE recipient = ?")
      .get(recipient) ?? null) as { brokerSeq: number; at: string } | null;
  }

  /** Creates the wake row for a waiting item, or returns the one already there. Returning the existing row rather than raising is what makes a duplicated mail-ready harmless: callers do not have to know whether they are first. */
  insertWake(row: MailWakeRow): MailWakeRow {
    return this.db.transaction(() => {
      const existing = this.wakeByItem(row.oldestItemId);
      if (existing !== null) return existing;
      this.db.database
        .query(
          `
          INSERT INTO mail_wakes (${WAKE_COLUMNS})
          VALUES ($wakeId, $recipient, $lane, $oldestItemId, $state, $attempts,
                  $nextAttemptAt, $clientInputId, $turnEventId,
                  $createdAt, $updatedAt)
        `,
        )
        .run({
          $wakeId: row.wakeId,
          $recipient: row.recipient,
          $lane: row.lane,
          $oldestItemId: row.oldestItemId,
          $state: row.state,
          $attempts: row.attempts,
          $nextAttemptAt: row.nextAttemptAt,
          $clientInputId: row.clientInputId,
          $turnEventId: row.turnEventId,
          $createdAt: row.createdAt,
          $updatedAt: row.updatedAt,
        });
      return row;
    });
  }

  wake(wakeId: string): MailWakeRow | null {
    return (this.db.database
      .query(`SELECT ${WAKE_COLUMNS} FROM mail_wakes WHERE wakeId = ?`)
      .get(wakeId) ?? null) as MailWakeRow | null;
  }

  wakeByItem(oldestItemId: string): MailWakeRow | null {
    return (this.db.database
      .query(`SELECT ${WAKE_COLUMNS} FROM mail_wakes WHERE oldestItemId = ?`)
      .get(oldestItemId) ?? null) as MailWakeRow | null;
  }

  updateWake(
    wakeId: string,
    patch: Partial<
      Pick<
        MailWakeRow,
        "state" | "attempts" | "nextAttemptAt" | "clientInputId" | "turnEventId"
      >
    >,
    updatedAt: string,
  ): void {
    const assignments = Object.keys(patch).map(
      (column) => `${column} = $${column}`,
    );
    this.db.database
      .query(
        `UPDATE mail_wakes SET ${[...assignments, "updatedAt = $updatedAt"].join(", ")}
          WHERE wakeId = $wakeId`,
      )
      .run({
        ...Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            `$${key}`,
            value ?? null,
          ]),
        ),
        $updatedAt: updatedAt,
        $wakeId: wakeId,
      });
  }

  /** Wakes that still owe an attempt, oldest first. A dead-lettered or settled wake is never returned, and a retrying wake stays invisible until its backoff has elapsed. */
  pendingWakes(recipient: string, now: string): MailWakeRow[] {
    return this.db.database
      .query(
        `SELECT ${WAKE_COLUMNS} FROM mail_wakes
          WHERE recipient = ?
            AND state NOT IN ('settled', 'dead_lettered')
            AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
          ORDER BY createdAt ASC, wakeId ASC`,
      )
      .all(recipient, now) as MailWakeRow[];
  }

  /** This recipient's unsettled wakes, whether or not their backoff has elapsed. Scoped in the query rather than filtered afterwards: this runs on every delivery transition, and reading the whole fleet's wakes to answer a question about one mailbox gets more expensive the more agents there are. */
  openWakes(recipient: string): MailWakeRow[] {
    return this.db.database
      .query(
        `SELECT ${WAKE_COLUMNS} FROM mail_wakes
          WHERE recipient = ? AND state NOT IN ('settled', 'dead_lettered')
          ORDER BY createdAt ASC, wakeId ASC`,
      )
      .all(recipient) as MailWakeRow[];
  }

  appendDelivery(entry: Omit<MailDeliveryRow, "id">): MailDeliveryRow {
    return this.db.database
      .query(
        `
        INSERT INTO mail_delivery_events
          (itemId, recipient, lane, state, evidenceKind, evidenceRef, at)
        VALUES ($itemId, $recipient, $lane, $state, $evidenceKind, $evidenceRef, $at)
        RETURNING ${DELIVERY_COLUMNS}
      `,
      )
      .get({
        $itemId: entry.itemId,
        $recipient: entry.recipient,
        $lane: entry.lane,
        $state: entry.state,
        $evidenceKind: entry.evidenceKind,
        $evidenceRef: entry.evidenceRef,
        $at: entry.at,
      }) as MailDeliveryRow;
  }

  deliveryChain(itemId: string): MailDeliveryRow[] {
    return this.db.database
      .query(
        `SELECT ${DELIVERY_COLUMNS}
           FROM mail_delivery_events WHERE itemId = ? ORDER BY id ASC`,
      )
      .all(itemId) as MailDeliveryRow[];
  }

  latestDelivery(itemId: string): MailDeliveryRow | null {
    return (this.db.database
      .query(
        `SELECT ${DELIVERY_COLUMNS}
           FROM mail_delivery_events WHERE itemId = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(itemId) ?? null) as MailDeliveryRow | null;
  }

  /** The newest transition of every item this recipient still owes something on. "Newest" is by insertion id rather than by timestamp: two transitions can share a clock reading, and the order they were written in is the order they were proven in. */
  openDeliveries(recipient: string): MailDeliveryRow[] {
    const terminal = TERMINAL_DELIVERY_STATES.map(() => "?").join(", ");
    return this.db.database
      .query(
        `SELECT ${DELIVERY_COLUMNS} FROM mail_delivery_events
          WHERE recipient = ?
            AND id IN (SELECT MAX(id) FROM mail_delivery_events
                        WHERE recipient = ? GROUP BY itemId)
            AND state NOT IN (${terminal})
          ORDER BY id ASC`,
      )
      .all(
        recipient,
        recipient,
        ...TERMINAL_DELIVERY_STATES,
      ) as MailDeliveryRow[];
  }

  hasState(recipient: string, state: MailDeliveryState): boolean {
    const row = this.db.database
      .query(
        `SELECT 1 AS present FROM mail_delivery_events
          WHERE recipient = ? AND state = ? LIMIT 1`,
      )
      .get(recipient, state) as { present: number } | null;
    return row !== null;
  }

  hasDeliveries(recipient: string): boolean {
    const row = this.db.database
      .query(
        "SELECT 1 AS present FROM mail_delivery_events WHERE recipient = ? LIMIT 1",
      )
      .get(recipient) as { present: number } | null;
    return row !== null;
  }
}
