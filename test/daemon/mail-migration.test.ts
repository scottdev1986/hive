import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  MailStore,
  migrateLegacyMessagesToMail,
} from "../../src/mail-service/store";
import { MAIL_CONTROL_LANE_CAPACITY } from "../../src/schemas/mail";
import { required } from "../required";
import type { JsonObject } from "../../src/shared/json";

type LegacyRow = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  state?: string;
  sequence?: number;
  idempotencyKey?: string | null;
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A database in the shape the daemon wrote before the mailbox existed.
 *
 * Written with raw SQL rather than by an older build, so the fixture keeps
 * working after the constructor stops creating these tables — which is the
 * point of the migration and would otherwise take its own test with it.
 */
const legacyDatabase = (rows: readonly LegacyRow[]): string => {
  const directory = mkdtempSync(join(tmpdir(), "hive-mail-migration-"));
  directories.push(directory);
  const path = join(directory, "hive.db");
  const database = new Database(path, { create: true });
  database.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      body TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      state TEXT NOT NULL DEFAULT 'queued',
      notifiedAt TEXT,
      acknowledgedAt TEXT,
      sequence INTEGER NOT NULL DEFAULT 0,
      idempotencyKey TEXT
    );
    CREATE TABLE message_attempts (
      attemptId TEXT PRIMARY KEY,
      messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL,
      recordJson TEXT NOT NULL
    );
  `);
  const insert = database.query(`
    INSERT INTO messages (
      id, "from", "to", body, createdAt, priority, state, sequence,
      idempotencyKey
    ) VALUES (?, ?, ?, ?, ?, 'normal', ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.from,
      row.to,
      row.body,
      row.createdAt,
      row.state ?? "queued",
      row.sequence ?? 0,
      row.idempotencyKey ?? null,
    );
  }
  database
    .query(
      "INSERT INTO message_attempts (attemptId, messageId, outcome, recordJson) VALUES (?, ?, ?, ?)",
    )
    .run("att_1", required(rows[0]?.id), "written", "{}");
  database.close();
  return path;
};

const MIGRATED_AT = "2026-08-01T18:00:00.000Z";

/** Opens a legacy database. Opening it IS the migration; the daemon boot has
 * no other step. */
const migrated = (path: string) => {
  const db = new HiveDatabase(path);
  return { db, report: db.legacyMailMigration };
};

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 7, 1, 12, minute, 0)).toISOString();

const items = (db: HiveDatabase) =>
  // SAFETY: The test owns this value and its fields.
  db.database
    .query(
      "SELECT itemId, recipient, sender, lane, topic, seq, state, recipientGeneration FROM mail_items ORDER BY recipient, seq",
    )
    .all() as Array<JsonObject>;

const events = (db: HiveDatabase) =>
  // SAFETY: The test owns this value and its fields.
  db.database
    .query(
      "SELECT itemId, kind, actor, idempotencyKey, fingerprint, detailJson FROM mail_events ORDER BY rowid",
    )
    .all() as Array<JsonObject>;

describe("the legacy messages migration", () => {
  test("moves unsettled rows into the control lane and drops the old tables", () => {
    const path = legacyDatabase([
      { id: "msg_a", from: "queen", to: "ada", body: "one", createdAt: at(1) },
      {
        id: "msg_b",
        from: "ada",
        to: "queen",
        body: "two",
        createdAt: at(2),
        state: "notified",
      },
      {
        id: "msg_done",
        from: "queen",
        to: "ada",
        body: "settled already",
        createdAt: at(0),
        state: "acknowledged",
      },
    ]);
    const { db, report } = migrated(path);

    expect(report).toEqual({ items: 2, recipients: 2 });
    expect(items(db)).toEqual([
      {
        itemId: "msg_a",
        recipient: "ada",
        sender: "queen",
        lane: "control",
        topic: "legacy",
        seq: 1,
        state: "available",
        recipientGeneration: null,
      },
      {
        itemId: "msg_b",
        recipient: "queen",
        sender: "ada",
        lane: "control",
        topic: "legacy",
        seq: 1,
        state: "available",
        recipientGeneration: null,
      },
    ]);
    expect(
      db.database
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('messages', 'message_attempts')",
        )
        .all(),
    ).toEqual([]);
    db.close();
  });

  test("carries the legacy id through so stored references still resolve", () => {
    const path = legacyDatabase([
      {
        id: "0198c0de-dead-7000-8000-00000000beef",
        from: "queen",
        to: "ada",
        body: "control instruction",
        createdAt: at(1),
      },
    ]);
    const { db } = migrated(path);

    const store = new MailStore(db);
    expect(
      required(store.getItem("0198c0de-dead-7000-8000-00000000beef")).body,
    ).toBe("control instruction");
    db.close();
  });

  test("renumbers each mailbox densely and seeds its counter", () => {
    const path = legacyDatabase([
      {
        id: "msg_1",
        from: "ada",
        to: "orchestrator",
        body: "a",
        createdAt: at(1),
        sequence: 7,
      },
      {
        id: "msg_2",
        from: "ada",
        to: "queen",
        body: "b",
        createdAt: at(2),
        sequence: 7,
      },
      {
        id: "msg_3",
        from: "ada",
        to: "queen",
        body: "c",
        createdAt: at(3),
        sequence: 9,
      },
    ]);
    const { db } = migrated(path);

    // Both root aliases counted their own sequences, so the legacy numbers
    // collide once the mailboxes merge; the migrated ones must not.
    expect(items(db).map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(
      db.database.query("SELECT recipient, lastSeq FROM mail_sequences").all(),
    ).toEqual([{ recipient: "queen", lastSeq: 3 }]);

    const store = new MailStore(db);
    expect(
      store.publish({
        recipient: "queen",
        sender: "ada",
        lane: "control",
        topic: "handoff",
        recipientGeneration: null,
        body: "after the cutover",
        idempotencyKey: "ada-post",
        ttlSeconds: null,
        expiresAt: null,
        now: at(10),
        controlLaneCapacity: MAIL_CONTROL_LANE_CAPACITY,
      }).seq,
    ).toBe(4);
    db.close();
  });

  test("canonicalises the sender so a root retry finds its own key", () => {
    const path = legacyDatabase([
      {
        id: "msg_1",
        from: "orchestrator",
        to: "ada",
        body: "instruction",
        createdAt: at(1),
        idempotencyKey: "spawn-ada",
      },
    ]);
    const { db } = migrated(path);

    const [event] = events(db);
    expect(required(event).actor).toBe("queen");
    expect(required(event).idempotencyKey).toBe("spawn-ada");
    const store = new MailStore(db);
    expect(store.itemIdForKey("queen", "spawn-ada")).toBe("msg_1");
    db.close();
  });

  test("gives a collided key to the older row and migrates the younger without one", () => {
    const path = legacyDatabase([
      {
        id: "msg_older",
        from: "orchestrator",
        to: "ada",
        body: "first",
        createdAt: at(5),
        idempotencyKey: "shared-key",
      },
      {
        id: "msg_younger",
        from: "queen",
        to: "ada",
        body: "second",
        createdAt: at(1),
        idempotencyKey: "shared-key",
      },
    ]);
    const { db } = migrated(path);

    // Both rows survive; only the key collapses, and it collapses onto the row
    // the legacy lookup would have returned.
    expect(items(db).map((item) => item.itemId)).toEqual([
      "msg_younger",
      "msg_older",
    ]);
    expect(
      events(db).map((event) => [event.itemId, event.idempotencyKey]),
    ).toEqual([
      ["msg_younger", null],
      ["msg_older", "shared-key"],
    ]);
    expect(new MailStore(db).itemIdForKey("queen", "shared-key")).toBe(
      "msg_older",
    );
    db.close();
  });

  test("records a receipt naming the item's migrated coordinates", () => {
    const path = legacyDatabase([
      {
        id: "msg_1",
        from: "ada",
        to: "queen",
        body: "report",
        createdAt: at(1),
        sequence: 42,
        idempotencyKey: "ada-report",
      },
    ]);
    const { db } = migrated(path);

    const [event] = events(db);
    expect(required(event).kind).toBe("migrated");
    expect(required(event).fingerprint).toEqual(expect.any(String));
    expect(JSON.parse(String(required(event).detailJson)).receipt).toEqual({
      itemId: "msg_1",
      lane: "control",
      topic: "legacy",
      outcome: "published",
      seq: 1,
      mergedCount: 0,
      acceptedAt: at(1),
    });
    db.close();
  });

  test("has nothing left to move once the old tables are gone", () => {
    const path = legacyDatabase([
      { id: "msg_1", from: "queen", to: "ada", body: "one", createdAt: at(1) },
    ]);
    const { db, report } = migrated(path);
    expect(required(report).items).toBe(1);

    // The dropped table is the fence, so a second boot finds nothing to do and
    // cannot duplicate what the first one moved.
    expect(migrateLegacyMessagesToMail(db, MIGRATED_AT)).toBeNull();
    db.close();
    const reopened = migrated(path);
    expect(reopened.report).toBeNull();
    expect(items(reopened.db)).toHaveLength(1);
    expect(events(reopened.db)).toHaveLength(1);
    reopened.db.close();
  });
});
