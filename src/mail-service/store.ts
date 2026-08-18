import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseHost } from "../shared/database-host";
import { canonicalOrchestratorName } from "../schemas/agent";
import {
  type MailDeadLetter,
  MailDeadLetterSchema,
  type MailDisposition,
  type MailEvent,
  type MailEventKind,
  MailEventSchema,
  type MailItem,
  MailItemSchema,
  type MailLane,
  type MailLease,
  MailLeaseSchema,
  type MailPublishReceipt,
  MailPublishReceiptSchema,
} from "../schemas/mail";
import { errorMessage } from "../shared/error-message";

export const MAIL_CONTROL_LANE_FULL = "MAIL_CONTROL_LANE_FULL";
export const MAIL_IDEMPOTENCY_CONFLICT = "MAIL_IDEMPOTENCY_CONFLICT";
export const MAIL_ITEM_NOT_CLAIMABLE = "MAIL_ITEM_NOT_CLAIMABLE";
export const MAIL_CONTROL_BUSY = "MAIL_CONTROL_BUSY";
export const MAIL_LEASE_NOT_HELD = "MAIL_LEASE_NOT_HELD";

export class MailControlLaneFullError extends Error {
  readonly code = MAIL_CONTROL_LANE_FULL;

  constructor(recipient: string, capacity: number) {
    super(
      `${MAIL_CONTROL_LANE_FULL}: the control lane for ${recipient} already has ` +
        `${capacity} instructions waiting; this publish is refused rather than ` +
        "displacing one",
    );
    this.name = "MailControlLaneFullError";
  }
}

export class MailIdempotencyConflictError extends Error {
  readonly code = MAIL_IDEMPOTENCY_CONFLICT;

  constructor(sender: string, idempotencyKey: string) {
    super(
      `${MAIL_IDEMPOTENCY_CONFLICT}: ${sender} already published a different ` +
        `envelope under key ${idempotencyKey}; reusing a key for new content ` +
        "would silently discard it",
    );
    this.name = "MailIdempotencyConflictError";
  }
}

export class MailItemNotClaimableError extends Error {
  readonly code = MAIL_ITEM_NOT_CLAIMABLE;

  constructor(itemId: string) {
    super(
      `${MAIL_ITEM_NOT_CLAIMABLE}: ${itemId} is not available to lease right now`,
    );
    this.name = "MailItemNotClaimableError";
  }
}

export class MailControlBusyError extends Error {
  readonly code = MAIL_CONTROL_BUSY;

  constructor(itemId: string, heldItemId: string) {
    super(
      `${MAIL_CONTROL_BUSY}: cannot claim ${itemId} while control item ` +
        `${heldItemId} is leased. Fix: settle item ${heldItemId} first`,
    );
    this.name = "MailControlBusyError";
  }
}

export class MailLeaseNotHeldError extends Error {
  readonly code = MAIL_LEASE_NOT_HELD;

  constructor(itemId: string) {
    super(
      `${MAIL_LEASE_NOT_HELD}: the caller does not hold a live lease on ${itemId}`,
    );
    this.name = "MailLeaseNotHeldError";
  }
}

export type MailSettleResult = Readonly<{
  itemId: string;
  disposition: MailDisposition;
  reason: string | null;
  attempt: number;
  settledAt: string;
  replayed: boolean;
}>;

export type MailRelease = Readonly<{
  itemId: string;
  outcome: "redelivered" | "absorbed" | "dead-lettered" | "failed";
  reason: string;
}>;

export type MailPublishInput = Readonly<{
  recipient: string;
  sender: string;
  lane: MailLane;
  topic: string;
  recipientGeneration: number | null;
  body: string;
  idempotencyKey: string;
  ttlSeconds: number | null;
  expiresAt: string | null;
  now: string;
  controlLaneCapacity: number;
}>;

export type MailClaimInput = Readonly<{
  itemId: string;
  recipient: string;
  ownerGeneration: number;
  handlerId: string;
  leaseUntil: string;
  now: string;
  maxAttempts: number;
}>;

export type MailSettleInput = Readonly<{
  itemId: string;
  recipient: string;
  ownerGeneration: number;
  handlerId: string;
  disposition: MailDisposition;
  reason: string | null;
  retryAt: string | null;
  now: string;
  maxAttempts: number;
}>;

const ITEM_COLUMNS = `itemId, recipient, sender, lane, topic, body, seq, state,
  mergedCount, attempts, recipientGeneration, createdAt, updatedAt, expiresAt,
  notBefore`;

const LEASE_COLUMNS =
  "itemId, owner, ownerGeneration, handlerId, claimedAt, leaseUntil";

const DispositionDetailSchema = z.object({
  handlerId: z.string(),
  attempt: z.number().int(),
  reason: z.string().nullable(),
});

/** The digest of what a key was accepted for. The order is fixed here rather than taken from object key order, so the same envelope always digests the same way and a retry that changed a field always digests differently. The sender is deliberately absent: keys are already scoped to their actor, so adding it would only re-state what that scope decides. The lifetime enters as the requested seconds, never as the absolute deadline derived from it. A legitimate retry arrives later and would compute a different deadline for the same request, and digesting that would turn every honest retry into a conflict. */
const envelopeFingerprint = (
  input: Pick<
    MailPublishInput,
    | "recipient"
    | "lane"
    | "topic"
    | "recipientGeneration"
    | "body"
    | "ttlSeconds"
  >,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.recipient,
        input.lane,
        input.topic,
        // The work lane never addresses a generation, so it normalises to the same empty value rather than giving the digest two shapes.
        input.lane === "work" ? null : input.recipientGeneration,
        input.body,
        input.ttlSeconds,
      ]),
      "utf8",
    )
    .digest("hex");

const MAIL_SCHEMA_DDL = `
        -- Append-only. No UPDATE or DELETE statement exists for this table, so
        -- the events for an item are the record of what the broker did — and
        -- they outlive the item, which is what lets a settled message's
        -- idempotency key still answer its sender's retry.
        CREATE TABLE IF NOT EXISTS mail_events (
          eventId TEXT PRIMARY KEY,
          itemId TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          actorGeneration INTEGER,
          idempotencyKey TEXT,
          fingerprint TEXT,
          at TEXT NOT NULL,
          detailJson TEXT NOT NULL
        );
        -- The key's uniqueness lives here rather than on the item because a
        -- coalescing publish binds a second key to an item that already exists,
        -- and because a settled item is deleted while its key must still
        -- resolve to the id its sender was given.
        CREATE UNIQUE INDEX IF NOT EXISTS mail_events_sender_key
          ON mail_events(actor, idempotencyKey) WHERE idempotencyKey IS NOT NULL;
        -- SQLite refuses to index rowid, so the index carries itemId alone and
        -- the ordering comes from the ORDER BY, where rowid is legal.
        CREATE INDEX IF NOT EXISTS mail_events_item ON mail_events(itemId);

        CREATE TABLE IF NOT EXISTS mail_items (
          itemId TEXT PRIMARY KEY,
          recipient TEXT NOT NULL,
          sender TEXT NOT NULL,
          lane TEXT NOT NULL,
          topic TEXT NOT NULL,
          body TEXT NOT NULL,
          seq INTEGER NOT NULL,
          state TEXT NOT NULL,
          mergedCount INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          recipientGeneration INTEGER,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          expiresAt TEXT,
          notBefore TEXT,
          -- Work items never address a generation. Coalescing merges by
          -- recipient, sender and topic alone, so an addressed work item would
          -- let one generation's update be folded into another's envelope and
          -- read by whichever incarnation the item happened to be pinned to.
          CHECK (lane <> 'work' OR recipientGeneration IS NULL)
        );
        CREATE INDEX IF NOT EXISTS mail_items_recipient
          ON mail_items(recipient, lane, state, seq);
        -- The work lane's coalescing target is unique by construction, so
        -- "merge into the unread update" can never pick between two of them.
        CREATE UNIQUE INDEX IF NOT EXISTS mail_items_one_available_work_topic
          ON mail_items(recipient, sender, topic)
          WHERE lane = 'work' AND state = 'available';
        -- One control item in flight per recipient: an agent settles the
        -- instruction it took before it is handed another.
        CREATE UNIQUE INDEX IF NOT EXISTS mail_items_one_leased_control
          ON mail_items(recipient) WHERE lane = 'control' AND state = 'leased';

        CREATE TABLE IF NOT EXISTS mail_leases (
          itemId TEXT PRIMARY KEY REFERENCES mail_items(itemId) ON DELETE CASCADE,
          owner TEXT NOT NULL,
          ownerGeneration INTEGER NOT NULL,
          handlerId TEXT NOT NULL,
          claimedAt TEXT NOT NULL,
          leaseUntil TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mail_leases_expiry ON mail_leases(leaseUntil);

        CREATE TABLE IF NOT EXISTS mail_dead_letters (
          itemId TEXT PRIMARY KEY,
          recipient TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantinedAt TEXT NOT NULL,
          itemJson TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mail_dead_letters_recipient
          ON mail_dead_letters(recipient, quarantinedAt);

        -- The sequence a recipient's mailbox has reached. It is a durable
        -- counter rather than a MAX over live rows because settlement deletes
        -- rows: a MAX would hand the next publish a number already used, and a
        -- client still holding a cursor from before the drain would never be
        -- shown what arrived after it.
        CREATE TABLE IF NOT EXISTS mail_sequences (
          recipient TEXT PRIMARY KEY,
          lastSeq INTEGER NOT NULL
        );
`;

/** The durable half of the mailbox: four tables and the writes that move an item between them. Which lane an envelope belongs to, how big a poll may be, and who is allowed to ask are all decided a layer up. Three rules shape the SQL. Every public operation is one flat transaction and never calls another one — nested transactions become savepoints, and a caught inner failure would leave the outer writes committed. A guard that decides whether a write may happen lives in that statement's own WHERE clause and is read back from `changes`, never checked in a preceding SELECT the write no longer stands on. And the invariants that cannot be written that way are partial unique indexes, so the database refuses the second writer rather than trusting both to look first. Settled items leave `mail_items` entirely. The journal keeps their history and the dead-letter table keeps the frozen document of the ones that failed, so each fact lives in one place and every queue read stays an index walk. */
export class MailStore {
  constructor(private readonly db: DatabaseHost) {
    db.transaction(() => {
      db.database.exec(MAIL_SCHEMA_DDL);
    });
  }

  /** Accepts an envelope: item, journal entry and idempotency key in one commit. The receipt a sender is given is written into the journal entry that accepted its key, and a retry is answered with that stored receipt rather than with anything rebuilt from current state. The item may have been merged into since, absorbed into a successor, or settled and deleted; none of that changes what this sender was already told. */
  publish(input: MailPublishInput): MailPublishReceipt {
    const fingerprint = envelopeFingerprint(input);
    return this.db.transaction(() => {
      const prior = this.keyRecord(input.sender, input.idempotencyKey);
      if (prior !== null) {
        if (prior.fingerprint !== fingerprint) {
          throw new MailIdempotencyConflictError(
            input.sender,
            input.idempotencyKey,
          );
        }
        return prior.receipt;
      }
      if (input.lane === "work") {
        const merged = this.coalesceInTx(input, fingerprint);
        if (merged !== null) return merged;
      }
      const itemId = `mit_${Bun.randomUUIDv7()}`;
      const seq = this.nextSeq(input.recipient);
      const receipt: MailPublishReceipt = {
        itemId,
        lane: input.lane,
        topic: input.topic,
        outcome: "published",
        seq,
        mergedCount: 0,
        acceptedAt: input.now,
      };
      this.appendEventInTx({
        itemId,
        kind: "published",
        actor: input.sender,
        actorGeneration: null,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        receipt,
        at: input.now,
        detail: {
          recipient: input.recipient,
          lane: input.lane,
          topic: input.topic,
          seq,
          recipientGeneration: input.recipientGeneration,
        },
      });
      const inserted = this.db.database
        .query(`
        INSERT INTO mail_items (${ITEM_COLUMNS})
        SELECT $itemId, $recipient, $sender, $lane, $topic, $body, $seq,
               'available', 0, 0, $generation, $now, $now, $expiresAt, NULL
        WHERE $lane <> 'control'
           OR (SELECT COUNT(*) FROM mail_items
                 WHERE recipient = $recipient AND lane = 'control'
                   AND state = 'available') < $capacity
      `)
        .run({
          $itemId: itemId,
          $recipient: input.recipient,
          $sender: input.sender,
          $lane: input.lane,
          $topic: input.topic,
          $body: input.body,
          $seq: seq,
          $generation: input.recipientGeneration,
          $now: input.now,
          $expiresAt: input.expiresAt,
          $capacity: input.controlLaneCapacity,
        });
      if (inserted.changes === 0) {
        throw new MailControlLaneFullError(
          input.recipient,
          input.controlLaneCapacity,
        );
      }
      return receipt;
    });
  }

  /** Leases one item to a recipient generation and handler. Repeating the
   * claim by the same live handler renews it without spending another attempt.
   * An expired target is released inside this transaction before acquisition,
   * so correctness does not depend on the maintenance cadence. */
  claim(input: MailClaimInput): MailLease {
    return this.db.transaction(() => {
      const renewed = this.db.database
        .query(
          `UPDATE mail_leases SET leaseUntil = ?
           WHERE itemId = ? AND owner = ? AND ownerGeneration = ?
             AND handlerId = ? AND leaseUntil > ?`,
        )
        .run(
          input.leaseUntil,
          input.itemId,
          input.recipient,
          input.ownerGeneration,
          input.handlerId,
          input.now,
        );
      if (renewed.changes > 0) {
        this.db.database
          .query("UPDATE mail_items SET updatedAt = ? WHERE itemId = ?")
          .run(input.now, input.itemId);
        const item = this.requireItem(input.itemId);
        this.appendEventInTx({
          itemId: input.itemId,
          kind: "lease-renewed",
          actor: input.recipient,
          actorGeneration: input.ownerGeneration,
          idempotencyKey: null,
          fingerprint: null,
          at: input.now,
          detail: {
            handlerId: input.handlerId,
            attempt: item.attempts,
            leaseUntil: input.leaseUntil,
          },
        });
        return this.requireLease(input.itemId);
      }
      const existing = this.getLease(input.itemId);
      if (existing !== null && existing.leaseUntil <= input.now) {
        this.releaseOneLease(input.itemId, input.now, input.maxAttempts);
      }
      const candidate = this.getItem(input.itemId);
      if (candidate?.lane === "control") {
        let held = this.controlLeaseOtherThan(input.recipient, input.itemId);
        if (held !== null && held.leaseUntil <= input.now) {
          this.releaseOneLease(held.itemId, input.now, input.maxAttempts);
          held = this.controlLeaseOtherThan(input.recipient, input.itemId);
        }
        if (held !== null) {
          throw new MailControlBusyError(input.itemId, held.itemId);
        }
      }
      const taken = this.db.database
        .query(`
        UPDATE mail_items SET state = 'leased', attempts = attempts + 1, updatedAt = ?
        WHERE itemId = ? AND recipient = ? AND state = 'available'
          AND (recipientGeneration IS NULL OR recipientGeneration = ?)
          AND (notBefore IS NULL OR notBefore <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM mail_items busy
            WHERE busy.recipient = mail_items.recipient
              AND mail_items.lane = 'control'
              AND busy.lane = 'control' AND busy.state = 'leased'
          )
      `)
        .run(
          input.now,
          input.itemId,
          input.recipient,
          input.ownerGeneration,
          input.now,
        );
      if (taken.changes === 0) {
        const held = this.controlLeaseOtherThan(input.recipient, input.itemId);
        if (held !== null) {
          throw new MailControlBusyError(input.itemId, held.itemId);
        }
        throw new MailItemNotClaimableError(input.itemId);
      }
      const item = this.requireItem(input.itemId);
      this.db.database
        .query(
          `INSERT INTO mail_leases (${LEASE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.itemId,
          input.recipient,
          input.ownerGeneration,
          input.handlerId,
          input.now,
          input.leaseUntil,
        );
      this.appendEventInTx({
        itemId: input.itemId,
        kind: "claimed",
        actor: input.recipient,
        actorGeneration: input.ownerGeneration,
        idempotencyKey: null,
        fingerprint: null,
        at: input.now,
        detail: {
          handlerId: input.handlerId,
          attempt: item.attempts,
          leaseUntil: input.leaseUntil,
        },
      });
      return this.requireLease(input.itemId);
    });
  }

  /** Settles the lease this handler holds, or replays the settlement it already recorded. The DELETE is the ownership test: owner, generation, handler and the lease deadline all bind in its WHERE clause, so a handler whose lease lapsed while it worked cannot settle work another claimant now owns. Zero rows deleted means either a replay the journal can answer, or a refusal. */
  settle(input: MailSettleInput): MailSettleResult {
    return this.db.transaction(() => {
      const released = this.db.database
        .query(`
        DELETE FROM mail_leases
        WHERE itemId = ? AND owner = ? AND ownerGeneration = ? AND handlerId = ?
          AND leaseUntil > ?
      `)
        .run(
          input.itemId,
          input.recipient,
          input.ownerGeneration,
          input.handlerId,
          input.now,
        );
      if (released.changes === 0) {
        const replay = this.replayedDisposition(input);
        if (replay !== null) return replay;
        throw new MailLeaseNotHeldError(input.itemId);
      }
      const item = this.requireItem(input.itemId);
      this.appendEventInTx({
        itemId: input.itemId,
        kind: input.disposition,
        actor: input.recipient,
        actorGeneration: input.ownerGeneration,
        idempotencyKey: null,
        fingerprint: null,
        at: input.now,
        detail: {
          handlerId: input.handlerId,
          attempt: item.attempts,
          reason: input.reason,
        },
      });
      if (input.disposition === "completed") {
        this.deleteItemInTx(input.itemId);
      } else if (input.disposition === "rejected") {
        this.deadLetterInTx(item, "rejected", input.now, input.reason);
      } else {
        this.releaseInTx(item, input.now, input.maxAttempts, input.retryAt);
      }
      return {
        itemId: input.itemId,
        disposition: input.disposition,
        reason: input.reason,
        attempt: item.attempts,
        settledAt: input.now,
        replayed: false,
      };
    });
  }

  /** Returns every lapsed lease to the queue, or retires it once its attempts are spent. This runs on the daemon's sweep cadence rather than inside a read, so a diagnostic poll never repairs what it was measuring. */
  sweepExpiredLeases(now: string, maxAttempts: number): MailRelease[] {
    const lapsed = z
      .array(z.object({ itemId: z.string() }))
      .parse(
        this.db.database
          .query("SELECT itemId FROM mail_leases WHERE leaseUntil <= ?")
          .all(now),
      );
    const released: MailRelease[] = [];
    for (const lease of lapsed) {
      // One transaction per candidate. A shared one would let a single item that cannot be released roll back every sibling released before it, so one stuck message would keep a whole mailbox leased. Catching here is safe only because each iteration commits or rolls back alone.
      try {
        const release = this.db.transaction(() =>
          this.releaseOneLease(lease.itemId, now, maxAttempts),
        );
        if (release !== null) released.push(release);
      } catch (error) {
        released.push({
          itemId: lease.itemId,
          outcome: "failed",
          reason: errorMessage(error),
        });
      }
    }
    return released;
  }

  private releaseOneLease(
    itemId: string,
    now: string,
    maxAttempts: number,
  ): MailRelease | null {
    const closed = this.db.database
      .query("DELETE FROM mail_leases WHERE itemId = ? AND leaseUntil <= ?")
      .run(itemId, now);
    if (closed.changes === 0) return null;
    const item = this.getItem(itemId);
    if (item === null) return null;
    this.appendEventInTx({
      itemId: item.itemId,
      kind: "lease-expired",
      actor: item.recipient,
      actorGeneration: null,
      idempotencyKey: null,
      fingerprint: null,
      at: now,
      detail: { attempt: item.attempts },
    });
    return this.releaseInTx(item, now, maxAttempts, null);
  }

  /** Quarantines every queued item whose TTL has passed. An expired envelope is recorded rather than dropped: a sender that was told "accepted" is owed the reason its message was never handled. */
  sweepExpiredItems(now: string): MailRelease[] {
    const overdue = this.listItems(
      `SELECT ${ITEM_COLUMNS} FROM mail_items
         WHERE state = 'available' AND expiresAt IS NOT NULL AND expiresAt <= ?`,
      [now],
    );
    const quarantined: MailRelease[] = [];
    for (const item of overdue) {
      // Isolated per item for the same reason the lease sweep is.
      try {
        this.db.transaction(() => {
          this.deadLetterInTx(item, "ttl-expired", now, null);
        });
        quarantined.push({
          itemId: item.itemId,
          outcome: "dead-lettered",
          reason: "ttl-expired",
        });
      } catch (error) {
        quarantined.push({
          itemId: item.itemId,
          outcome: "failed",
          reason: errorMessage(error),
        });
      }
    }
    return quarantined;
  }

  /** Quarantines one queued item that can never be handled as addressed. */
  quarantine(itemId: string, reason: string, now: string): MailRelease | null {
    return this.db.transaction(() => {
      const item = this.getItem(itemId);
      if (item === null) return null;
      this.db.database
        .query("DELETE FROM mail_leases WHERE itemId = ?")
        .run(itemId);
      this.deadLetterInTx(item, reason, now, null);
      return { itemId, outcome: "dead-lettered" as const, reason };
    });
  }

  getItem(itemId: string): MailItem | null {
    const row = this.db.database
      .query(`SELECT ${ITEM_COLUMNS} FROM mail_items WHERE itemId = ?`)
      .get(itemId);
    return row === null ? null : MailItemSchema.parse(row);
  }

  /** Queued items in the order the lane promises: strict sequence, oldest first. Control items are withheld while any control item for that recipient is leased, because a lane that admits one in flight should not offer a second that the claim would only refuse. */
  listAvailable(
    recipient: string,
    lane: MailLane,
    afterSeq: number,
    limit: number,
    now: string,
  ): MailItem[] {
    return this.listItems(
      `SELECT ${ITEM_COLUMNS} FROM mail_items i
       WHERE i.recipient = ? AND i.lane = ? AND i.state = 'available' AND i.seq > ?
         AND (i.notBefore IS NULL OR i.notBefore <= ?)
         AND (i.lane <> 'control' OR NOT EXISTS (
               SELECT 1 FROM mail_items busy
               WHERE busy.recipient = i.recipient AND busy.lane = 'control'
                 AND busy.state = 'leased'))
       ORDER BY i.seq ASC LIMIT ?`,
      [recipient, lane, afterSeq, now, limit],
    );
  }

  getLease(itemId: string): MailLease | null {
    const row = this.db.database
      .query(`SELECT ${LEASE_COLUMNS} FROM mail_leases WHERE itemId = ?`)
      .get(itemId);
    return row === null ? null : MailLeaseSchema.parse(row);
  }

  controlLeaseOtherThan(recipient: string, itemId: string): MailLease | null {
    const row = this.db.database
      .query(
        `SELECT l.${LEASE_COLUMNS} FROM mail_leases l
         JOIN mail_items i ON i.itemId = l.itemId
         WHERE l.owner = ? AND i.lane = 'control' AND l.itemId <> ?`,
      )
      .get(recipient, itemId);
    return row === null ? null : MailLeaseSchema.parse(row);
  }

  listLeases(recipient: string): MailLease[] {
    return z
      .array(MailLeaseSchema)
      .parse(
        this.db.database
          .query(
            `SELECT ${LEASE_COLUMNS} FROM mail_leases WHERE owner = ? ORDER BY leaseUntil ASC`,
          )
          .all(recipient),
      );
  }

  countByState(recipient: string, lane: MailLane, state: string): number {
    return z.object({ total: z.number() }).parse(
      this.db.database
        .query(
          `SELECT COUNT(*) AS total FROM mail_items
             WHERE recipient = ? AND lane = ? AND state = ?`,
        )
        .get(recipient, lane, state),
    ).total;
  }

  unsettledMailCount(recipient: string): number {
    return z
      .object({ count: z.number() })
      .parse(
        this.db.database
          .query("SELECT COUNT(*) AS count FROM mail_items WHERE recipient = ?")
          .get(recipient),
      ).count;
  }

  oldestAvailable(recipient: string): MailItem | null {
    return (
      this.listItems(
        `SELECT ${ITEM_COLUMNS} FROM mail_items
         WHERE recipient = ? AND state = 'available' ORDER BY seq ASC LIMIT 1`,
        [recipient],
      ).at(0) ?? null
    );
  }

  /** Every mailbox whose oldest waiting control message is older than `seconds`. The item's own arrival time comes back with it, because that is what makes the alert about a breach window rather than about a moment: it does not move while the message waits, so the same window keeps producing the same alert key and the alert is rate-limited by the idempotency it already has. */
  staleControlMail(
    now: string,
    seconds: number,
  ): { recipient: string; itemId: string; waitingSince: string }[] {
    const cutoff = new Date(
      new Date(now).getTime() - seconds * 1_000,
    ).toISOString();
    return z
      .array(
        z.object({
          recipient: z.string(),
          itemId: z.string(),
          waitingSince: z.string(),
        }),
      )
      .parse(
        this.db.database
          .query(`
        SELECT recipient, itemId, createdAt AS waitingSince FROM mail_items
        WHERE lane = 'control' AND state = 'available' AND createdAt <= ?
          AND seq = (
            SELECT MIN(seq) FROM mail_items oldest
            WHERE oldest.recipient = mail_items.recipient
              AND oldest.lane = 'control' AND oldest.state = 'available'
          )
        ORDER BY recipient
      `)
          .all(cutoff),
      );
  }

  listDeadLetters(recipient: string): MailDeadLetter[] {
    const rows = z
      .array(
        z.object({
          itemId: z.string(),
          recipient: z.string(),
          reason: z.string(),
          quarantinedAt: z.string(),
          itemJson: z.string(),
        }),
      )
      .parse(
        this.db.database
          .query(
            `SELECT itemId, recipient, reason, quarantinedAt, itemJson
             FROM mail_dead_letters WHERE recipient = ?
             ORDER BY quarantinedAt ASC, rowid ASC`,
          )
          .all(recipient),
      );
    return rows.map(({ itemJson, ...rest }) =>
      MailDeadLetterSchema.parse({ ...rest, item: JSON.parse(itemJson) }),
    );
  }

  listEvents(itemId: string): MailEvent[] {
    return z.array(MailEventSchema).parse(
      this.db.database
        .query(
          `SELECT eventId, itemId, kind, actor, actorGeneration, idempotencyKey,
                    fingerprint, at, detailJson
             FROM mail_events WHERE itemId = ? ORDER BY rowid ASC`,
        )
        .all(itemId),
    );
  }

  itemIdForKey(sender: string, idempotencyKey: string): string | null {
    return this.keyRecord(sender, idempotencyKey)?.receipt.itemId ?? null;
  }

  /** What a sender's idempotency key was accepted for. The scope is the actor, so two publishers never share a collision domain — an internal publisher needs its own stable subject rather than a shared one, or their keys would compete. */
  private keyRecord(
    sender: string,
    idempotencyKey: string,
  ): { fingerprint: string | null; receipt: MailPublishReceipt } | null {
    const row = this.db.database
      .query(
        `SELECT fingerprint, detailJson FROM mail_events
         WHERE actor = ? AND idempotencyKey = ?`,
      )
      .get(sender, idempotencyKey) as {
      fingerprint: string | null;
      detailJson: string;
    } | null;
    if (row === null) return null;
    const detail = z
      .object({ receipt: MailPublishReceiptSchema })
      .parse(JSON.parse(row.detailJson));
    return { fingerprint: row.fingerprint, receipt: detail.receipt };
  }

  /** Folds a work update into the recipient's unread item on the same topic. `state = 'available'` is part of the UPDATE: an item claimed between the lookup and the write must not have its body swapped underneath the handler already reading it, and the zero changes that produces is what tells the caller to publish a fresh item instead. */
  private coalesceInTx(
    input: MailPublishInput,
    fingerprint: string,
  ): MailPublishReceipt | null {
    const target = this.db.database
      .query(
        `SELECT itemId FROM mail_items
         WHERE recipient = ? AND sender = ? AND lane = 'work' AND topic = ?
           AND state = 'available'`,
      )
      .get(input.recipient, input.sender, input.topic) as {
      itemId: string;
    } | null;
    if (target === null) return null;
    const updated = this.db.database
      .query(
        `UPDATE mail_items
         SET body = ?, mergedCount = mergedCount + 1, updatedAt = ?, expiresAt = ?
         WHERE itemId = ? AND state = 'available'`,
      )
      .run(input.body, input.now, input.expiresAt, target.itemId);
    if (updated.changes === 0) return null;
    const merged = this.requireItem(target.itemId);
    const receipt: MailPublishReceipt = {
      itemId: merged.itemId,
      lane: merged.lane,
      topic: merged.topic,
      outcome: "coalesced",
      seq: merged.seq,
      mergedCount: merged.mergedCount,
      acceptedAt: input.now,
    };
    this.appendEventInTx({
      itemId: target.itemId,
      kind: "coalesced",
      actor: input.sender,
      actorGeneration: null,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      receipt,
      at: input.now,
      detail: { topic: input.topic },
    });
    return receipt;
  }

  /** Returns an item to the queue after a lease ends without a completion. Attempts are the bound that stops a handler which dies on every read from being fed the same message forever. A work item whose topic acquired a fresher update while it was leased is absorbed into that update rather than returned beside it: two unread items on one topic is the state the lane exists to prevent, the newer body is the one that still means something, and the unique index on that pair would otherwise abort the sweep and strand every other lapsed lease behind it. `retryAt` holds a deferred item back until its window passes. Re-arming it as immediately claimable would let a handler that defers on sight spin through its whole attempt budget inside one safe point. */
  private releaseInTx(
    item: MailItem,
    now: string,
    maxAttempts: number,
    retryAt: string | null,
  ): MailRelease {
    if (item.attempts >= maxAttempts) {
      this.deadLetterInTx(item, "attempts-exhausted", now, null);
      return {
        itemId: item.itemId,
        outcome: "dead-lettered",
        reason: "attempts-exhausted",
      };
    }
    const successor =
      item.lane === "work"
        ? (this.db.database
            .query(
              `SELECT itemId FROM mail_items
               WHERE recipient = ? AND sender = ? AND topic = ? AND lane = 'work'
                 AND state = 'available' AND itemId <> ?`,
            )
            .get(item.recipient, item.sender, item.topic, item.itemId) as {
            itemId: string;
          } | null)
        : null;
    if (successor !== null) {
      this.db.database
        .query(
          `UPDATE mail_items SET mergedCount = mergedCount + ?, updatedAt = ?
           WHERE itemId = ?`,
        )
        .run(item.mergedCount + 1, now, successor.itemId);
      this.appendEventInTx({
        itemId: successor.itemId,
        kind: "coalesced",
        actor: item.sender,
        actorGeneration: null,
        idempotencyKey: null,
        fingerprint: null,
        at: now,
        detail: { absorbed: item.itemId, topic: item.topic },
      });
      this.deleteItemInTx(item.itemId);
      return {
        itemId: item.itemId,
        outcome: "absorbed",
        reason: successor.itemId,
      };
    }
    this.db.database
      .query(
        `UPDATE mail_items SET state = 'available', updatedAt = ?, notBefore = ?
         WHERE itemId = ?`,
      )
      .run(now, retryAt, item.itemId);
    return {
      itemId: item.itemId,
      outcome: "redelivered",
      reason: "lease-released",
    };
  }

  private deadLetterInTx(
    item: MailItem,
    reason: string,
    now: string,
    detail: string | null,
  ): void {
    this.db.database
      .query(
        `INSERT INTO mail_dead_letters (itemId, recipient, reason, quarantinedAt, itemJson)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        item.itemId,
        item.recipient,
        detail === null ? reason : `${reason}: ${detail}`,
        now,
        JSON.stringify(item),
      );
    this.appendEventInTx({
      itemId: item.itemId,
      kind: "dead-lettered",
      actor: item.recipient,
      actorGeneration: null,
      idempotencyKey: null,
      fingerprint: null,
      at: now,
      detail: {
        reason,
        attempts: item.attempts,
        sender: item.sender,
        recipientGeneration: item.recipientGeneration,
        idempotencyKey: this.publishKeyFor(item.itemId),
      },
    });
    this.deleteItemInTx(item.itemId);
  }

  private deleteItemInTx(itemId: string): void {
    this.db.database
      .query("DELETE FROM mail_items WHERE itemId = ?")
      .run(itemId);
  }

  /** The settlement this handler already recorded for the attempt it held, when this call is a retry of one whose response was lost. A deferred item is re-armed rather than deleted, so the attempt number is what separates a lost response from a genuine second settlement after a fresh claim. */
  private replayedDisposition(input: MailSettleInput): MailSettleResult | null {
    const row = this.db.database
      .query(
        `SELECT kind, at, detailJson FROM mail_events
         WHERE itemId = ? AND actor = ? AND kind IN ('completed', 'deferred', 'rejected')
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(input.itemId, input.recipient) as {
      kind: MailDisposition;
      at: string;
      detailJson: string;
    } | null;
    if (row === null || row.kind !== input.disposition) return null;
    const detail = DispositionDetailSchema.parse(JSON.parse(row.detailJson));
    if (detail.handlerId !== input.handlerId) return null;
    const item = this.getItem(input.itemId);
    if (item !== null && item.attempts !== detail.attempt) return null;
    return {
      itemId: input.itemId,
      disposition: row.kind,
      reason: detail.reason,
      attempt: detail.attempt,
      settledAt: row.at,
      replayed: true,
    };
  }

  /** The key this item was first accepted under, whichever kind of event bound it. Filtering on `published` alone would lose the key for the two items that never had one: a migrated row, whose key is on its `migrated` event, and an item created by a coalescing publish. Both would then be dead-lettered with no key recorded, which reads as "sent without one". The first key wins, because a coalesced item accumulates one per publish that merged into it and the annotation names the envelope that made it. */
  private publishKeyFor(itemId: string): string | null {
    const row = this.db.database
      .query(
        `SELECT idempotencyKey FROM mail_events
         WHERE itemId = ? AND idempotencyKey IS NOT NULL
         ORDER BY rowid LIMIT 1`,
      )
      .get(itemId) as { idempotencyKey: string | null } | null;
    return row === null ? null : row.idempotencyKey;
  }

  /** Advances the recipient's durable sequence and returns the number claimed. The counter is a row of its own so that it survives the items it numbered. Deriving the next sequence from the live rows instead would reissue numbers every time a mailbox drained, and a cursor taken before that drain would silently skip everything that arrived after it. The upsert both advances and reads in one statement, so two callers in flight cannot read the same value before either writes. */
  nextSeq(recipient: string): number {
    return z.object({ lastSeq: z.number() }).parse(
      this.db.database
        .query(
          `INSERT INTO mail_sequences (recipient, lastSeq) VALUES (?, 1)
             ON CONFLICT(recipient) DO UPDATE SET lastSeq = lastSeq + 1
             RETURNING lastSeq`,
        )
        .get(recipient),
    ).lastSeq;
  }

  private appendEventInTx(
    event: Readonly<{
      itemId: string;
      kind: MailEventKind;
      actor: string;
      actorGeneration: number | null;
      idempotencyKey: string | null;
      fingerprint: string | null;
      receipt?: MailPublishReceipt;
      at: string;
      detail: Record<string, unknown>;
    }>,
  ): void {
    this.db.database
      .query(
        `INSERT INTO mail_events (
           eventId, itemId, kind, actor, actorGeneration, idempotencyKey,
           fingerprint, at, detailJson
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `mev_${Bun.randomUUIDv7()}`,
        event.itemId,
        event.kind,
        event.actor,
        event.actorGeneration,
        event.idempotencyKey,
        event.fingerprint,
        event.at,
        JSON.stringify(
          event.receipt === undefined
            ? event.detail
            : { ...event.detail, receipt: event.receipt },
        ),
      );
  }

  private listItems(sql: string, parameters: unknown[]): MailItem[] {
    return z
      .array(MailItemSchema)
      .parse(this.db.database.query(sql).all(...(parameters as never[])));
  }

  private requireItem(itemId: string): MailItem {
    const item = this.getItem(itemId);
    if (item === null) throw new Error(`mail item ${itemId} does not exist`);
    return item;
  }

  private requireLease(itemId: string): MailLease {
    const lease = this.getLease(itemId);
    if (lease === null) throw new Error(`mail lease ${itemId} does not exist`);
    return lease;
  }
}

/** Creates the mailbox schema if it is not already there. Called from the database's own constructor so the tables exist on the database rather than on whoever happened to build a store first — a reader that opens the file and finds no mailbox cannot tell "empty" from "not built yet". */
export function ensureMailSchema(db: DatabaseHost): void {
  db.transaction(() => {
    db.database.exec(MAIL_SCHEMA_DDL);
  });
}

/** Topic every pre-mailbox message files under after the move. */
export const MAIL_LEGACY_TOPIC = "legacy";

export type LegacyMailMigration = Readonly<{
  items: number;
  recipients: number;
}>;

const LegacyMessageRowsSchema = z.array(
  z.object({
    rowid: z.number(),
    id: z.string(),
    sender: z.string(),
    recipient: z.string(),
    body: z.string(),
    createdAt: z.string(),
    sequence: z.number(),
    idempotencyKey: z.string().nullable(),
  }),
);

/** Moves the pre-mailbox `messages` table into the mailbox and drops it, once. The table's own existence is the fence. There is no meta flag that could disagree with the schema, and the drop happens in the same transaction as the copy, so after the first successful boot the fence is false forever and no later code can read the old rows even if someone writes a reader for them. Three choices are load-bearing: A migrated item keeps its legacy id. `agents.controlMessageId` and `quota_reservations.controlMessageId` point at those ids, and preserving them keeps every stored reference valid without rewriting two tables in lockstep. Sequences are not preserved. The root answers to two names whose sequence spaces were counted separately, so carrying the old numbers across would collide the moment they merge. Each mailbox is renumbered densely in the order its messages were created, and its counter seeded to match. Senders are canonicalised the way delivery canonicalised them, so a retry arriving after the cutover under the root's preferred name still finds the key that a message sent under its synonym recorded. Where that collapse makes two rows share one key, the older row keeps it and the younger migrates without one, which is the first-writer rule the legacy lookup already applied. */
export function migrateLegacyMessagesToMail(
  db: DatabaseHost,
  now: string,
): LegacyMailMigration | null {
  return db.transaction(() => {
    const legacy = db.database
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
      )
      .get();
    if (legacy === null) return null;
    db.database.exec(MAIL_SCHEMA_DDL);
    const rows = LegacyMessageRowsSchema.parse(
      db.database
        .query(`
        SELECT rowid AS rowid, id, "from" AS sender, "to" AS recipient, body,
               createdAt, sequence, idempotencyKey
        FROM messages
        WHERE state <> 'acknowledged'
        ORDER BY createdAt, sequence, rowid
      `)
        .all(),
    );

    const keyOwner = new Map<string, number>();
    for (const row of rows) {
      if (row.idempotencyKey === null) continue;
      const scope = keyScope(row.sender, row.idempotencyKey);
      const held = keyOwner.get(scope);
      if (held === undefined || row.rowid < held)
        keyOwner.set(scope, row.rowid);
    }

    const insertItem = db.database.query(`
      INSERT INTO mail_items (${ITEM_COLUMNS})
      VALUES (?, ?, ?, 'control', ?, ?, ?, 'available', 0, 0, NULL, ?, ?, NULL, NULL)
    `);
    const insertEvent = db.database.query(
      `INSERT INTO mail_events (
         eventId, itemId, kind, actor, actorGeneration, idempotencyKey,
         fingerprint, at, detailJson
       ) VALUES (?, ?, 'migrated', ?, NULL, ?, ?, ?, ?)`,
    );
    const lastSeq = new Map<string, number>();
    for (const row of rows) {
      const recipient = canonicalOrchestratorName(row.recipient);
      const actor = canonicalOrchestratorName(row.sender);
      const seq = (lastSeq.get(recipient) ?? 0) + 1;
      lastSeq.set(recipient, seq);
      const key =
        row.idempotencyKey !== null &&
        keyOwner.get(keyScope(row.sender, row.idempotencyKey)) === row.rowid
          ? row.idempotencyKey
          : null;
      // The receipt is written with the item's new coordinates rather than its legacy ones, so a sender retrying its key after the cutover is told where the message actually is.
      const receipt: MailPublishReceipt = {
        itemId: row.id,
        lane: "control",
        topic: MAIL_LEGACY_TOPIC,
        outcome: "published",
        seq,
        mergedCount: 0,
        acceptedAt: row.createdAt,
      };
      insertEvent.run(
        `mev_${Bun.randomUUIDv7()}`,
        row.id,
        actor,
        key,
        key === null
          ? null
          : envelopeFingerprint({
              recipient,
              lane: "control",
              topic: MAIL_LEGACY_TOPIC,
              recipientGeneration: null,
              body: row.body,
              ttlSeconds: null,
            }),
        now,
        JSON.stringify({
          recipient,
          lane: "control",
          topic: MAIL_LEGACY_TOPIC,
          seq,
          recipientGeneration: null,
          receipt,
        }),
      );
      insertItem.run(
        row.id,
        recipient,
        row.sender,
        MAIL_LEGACY_TOPIC,
        row.body,
        seq,
        row.createdAt,
        row.createdAt,
      );
    }
    const seedSeq = db.database.query(
      "INSERT INTO mail_sequences (recipient, lastSeq) VALUES (?, ?)",
    );
    for (const [recipient, seq] of lastSeq) seedSeq.run(recipient, seq);

    db.database.exec("DROP TABLE message_attempts");
    db.database.exec("DROP TABLE messages");
    return { items: rows.length, recipients: lastSeq.size };
  });
}

const keyScope = (sender: string, idempotencyKey: string): string =>
  `${canonicalOrchestratorName(sender)}\u0000${idempotencyKey}`;
