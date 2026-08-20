import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  MailControlLaneFullError,
  MailItemNotClaimableError,
  MailStore,
} from "../../src/mail-service/store";
import {
  MAIL_CONTROL_LANE_CAPACITY,
  MAIL_MAX_ATTEMPTS,
} from "../../src/schemas/mail";
import { required } from "../required";

const T0 = new Date("2026-08-01T12:00:00.000Z");
const at = (seconds: number): string =>
  new Date(T0.getTime() + seconds * 1_000).toISOString();

const envelope = (overrides: Record<string, unknown> = {}) => ({
  recipient: "ada",
  sender: "queen",
  lane: "control" as const,
  topic: "handoff",
  recipientGeneration: null,
  body: "take ownership",
  idempotencyKey: "queen-1",
  ttlSeconds: null,
  expiresAt: null,
  now: at(0),
  controlLaneCapacity: MAIL_CONTROL_LANE_CAPACITY,
  ...overrides,
});

const rig = (): { db: HiveDatabase; store: MailStore } => {
  const db = new HiveDatabase(":memory:");
  return { db, store: new MailStore(db) };
};

const claim = (
  store: MailStore,
  itemId: string,
  handlerId: string,
  second: number,
  ownerGeneration = 4,
) =>
  store.claim({
    itemId,
    recipient: "ada",
    ownerGeneration,
    handlerId,
    leaseUntil: at(second + 120),
    now: at(second),
    maxAttempts: MAIL_MAX_ATTEMPTS,
  });

const settle = (
  store: MailStore,
  itemId: string,
  handlerId: string,
  disposition: "completed" | "deferred" | "rejected",
  second: number,
  ownerGeneration = 4,
) =>
  store.settle({
    itemId,
    recipient: "ada",
    ownerGeneration,
    handlerId,
    disposition,
    reason: null,
    retryAt: at(second + 120),
    now: at(second),
    maxAttempts: MAIL_MAX_ATTEMPTS,
  });

describe("mail_events", () => {
  test("records the lifecycle in order and never rewrites a row", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    claim(store, receipt.itemId, "h1", 1);
    const afterClaim = store.listEvents(receipt.itemId);
    store.sweepExpiredLeases(at(200), MAIL_MAX_ATTEMPTS);
    claim(store, receipt.itemId, "h2", 210);
    settle(store, receipt.itemId, "h2", "completed", 211);
    const events = store.listEvents(receipt.itemId);
    expect(events.map((event) => event.kind)).toEqual([
      "published",
      "claimed",
      "lease-expired",
      "claimed",
      "completed",
    ]);
    // The rows written earlier read back byte-identical now.
    expect(events.slice(0, afterClaim.length)).toEqual(afterClaim);
  });

  test("the journal outlives the item it describes", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    claim(store, receipt.itemId, "h1", 1);
    settle(store, receipt.itemId, "h1", "completed", 2);
    expect(store.getItem(receipt.itemId)).toBeNull();
    expect(store.listEvents(receipt.itemId)).toHaveLength(3);
    expect(store.itemIdForKey("queen", "queen-1")).toBe(receipt.itemId);
  });

  test("the same live handler renews without spending another attempt", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    claim(store, receipt.itemId, "h1", 1);

    const renewed = claim(store, receipt.itemId, "h1", 100);

    expect(renewed.leaseUntil).toBe(at(220));
    expect(required(store.getItem(receipt.itemId)).attempts).toBe(1);
    expect(store.listEvents(receipt.itemId).map((event) => event.kind)).toEqual(
      ["published", "claimed", "lease-renewed"],
    );
  });

  test("a claim reclaims its expired target without waiting for the sweep", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    claim(store, receipt.itemId, "h1", 1);

    const reclaimed = claim(store, receipt.itemId, "h2", 122);

    expect(reclaimed.handlerId).toBe("h2");
    expect(required(store.getItem(receipt.itemId)).attempts).toBe(2);
    expect(store.listEvents(receipt.itemId).map((event) => event.kind)).toEqual(
      ["published", "claimed", "lease-expired", "claimed"],
    );
  });

  test("a claim releases an expired control sibling before taking the lane", () => {
    const { store } = rig();
    const first = store.publish(envelope());
    const second = store.publish(
      envelope({ idempotencyKey: "queen-2", body: "next instruction" }),
    );
    claim(store, first.itemId, "h1", 1);

    const taken = claim(store, second.itemId, "h2", 122);

    expect(taken.itemId).toBe(second.itemId);
    expect(required(store.getItem(first.itemId)).state).toBe("available");
    expect(store.getLease(first.itemId)).toBeNull();
  });

  test("a coalesced publish appends its own event carrying its own key", () => {
    const { store } = rig();
    const first = store.publish(
      envelope({ lane: "work", topic: "progress", idempotencyKey: "k1" }),
    );
    const merged = store.publish(
      envelope({
        lane: "work",
        topic: "progress",
        idempotencyKey: "k2",
        body: "20%",
        now: at(1),
      }),
    );
    expect(merged.itemId).toBe(first.itemId);
    expect(merged.outcome).toBe("coalesced");
    const events = store.listEvents(first.itemId);
    expect(events.map((event) => event.kind)).toEqual([
      "published",
      "coalesced",
    ]);
    expect(events.map((event) => event.idempotencyKey)).toEqual(["k1", "k2"]);
    expect(events.every((event) => event.fingerprint !== null)).toBe(true);
  });

  test("a refused publish leaves no trace of itself", () => {
    const { store, db } = rig();
    for (let index = 0; index < MAIL_CONTROL_LANE_CAPACITY; index += 1) {
      store.publish(envelope({ idempotencyKey: `queen-${index}` }));
    }
    const before = db.database
      .query("SELECT COUNT(*) AS total FROM mail_events")
      .get() as { total: number };
    expect(() =>
      store.publish(envelope({ idempotencyKey: "queen-overflow" })),
    ).toThrow(MailControlLaneFullError);
    const after = db.database
      .query("SELECT COUNT(*) AS total FROM mail_events")
      .get() as { total: number };
    expect(after.total).toBe(before.total);
    expect(store.itemIdForKey("queen", "queen-overflow")).toBeNull();
  });
});

describe("invariants the database enforces", () => {
  test("the same key from the same sender cannot be recorded twice", () => {
    const { store, db } = rig();
    const receipt = store.publish(envelope());
    expect(() =>
      db.database
        .query(
          `INSERT INTO mail_events (
             eventId, itemId, kind, actor, actorGeneration, idempotencyKey,
             fingerprint, at, detailJson
           ) VALUES (?, ?, 'published', 'queen', NULL, 'queen-1', NULL, ?, '{}')`,
        )
        .run("mev_forced", receipt.itemId, at(9)),
    ).toThrow();
  });

  test("one item may hold only one lease", () => {
    const { store, db } = rig();
    const receipt = store.publish(envelope());
    claim(store, receipt.itemId, "h1", 1);
    expect(() =>
      db.database
        .query(
          `INSERT INTO mail_leases (
             itemId, owner, ownerGeneration, handlerId, claimedAt, leaseUntil
           ) VALUES (?, 'ada', 4, 'h2', ?, ?)`,
        )
        .run(receipt.itemId, at(2), at(200)),
    ).toThrow();
    expect(required(store.getLease(receipt.itemId)).handlerId).toBe("h1");
  });

  test("one recipient may hold only one leased control item", () => {
    const { store, db } = rig();
    const first = store.publish(envelope());
    const second = store.publish(envelope({ idempotencyKey: "queen-2" }));
    claim(store, first.itemId, "h1", 1);
    expect(() =>
      db.database
        .query("UPDATE mail_items SET state = 'leased' WHERE itemId = ?")
        .run(second.itemId),
    ).toThrow();
  });

  test("a work item may not carry an addressed generation", () => {
    const { db } = rig();
    expect(() =>
      db.database
        .query(
          `INSERT INTO mail_items (
             itemId, recipient, sender, lane, topic, body, seq, state,
             mergedCount, attempts, recipientGeneration, createdAt, updatedAt,
             expiresAt, notBefore
           ) VALUES ('mit_forced', 'ada', 'queen', 'work', 'progress', 'x', 1,
                     'available', 0, 0, 3, ?, ?, NULL, NULL)`,
        )
        .run(at(1), at(1)),
    ).toThrow();
  });

  test("a claim leases the item it named and leaves its siblings alone", () => {
    const { store } = rig();
    const target = store.publish(
      envelope({ lane: "work", topic: "progress", idempotencyKey: "k1" }),
    );
    const sibling = store.publish(
      envelope({ lane: "work", topic: "other", idempotencyKey: "k2" }),
    );
    claim(store, target.itemId, "h1", 1);
    expect(required(store.getItem(target.itemId)).state).toBe("leased");
    // The claim names one item. A guard that matched on the recipient alone
    // would lease every queued item that agent had, each without a lease row.
    expect(required(store.getItem(sibling.itemId)).state).toBe("available");
    expect(required(store.getItem(sibling.itemId)).attempts).toBe(0);
    expect(store.getLease(sibling.itemId)).toBeNull();
  });

  test("the claim refuses a recipient that does not own the item", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    expect(() =>
      store.claim({
        itemId: receipt.itemId,
        recipient: "bo",
        ownerGeneration: 4,
        handlerId: "h1",
        leaseUntil: at(200),
        now: at(1),
        maxAttempts: MAIL_MAX_ATTEMPTS,
      }),
    ).toThrow(MailItemNotClaimableError);
    expect(store.getLease(receipt.itemId)).toBeNull();
    expect(required(store.getItem(receipt.itemId)).attempts).toBe(0);
    expect(required(store.getItem(receipt.itemId)).state).toBe("available");
  });

  test("one recipient and sender may hold only one queued item per work topic", () => {
    const { store, db } = rig();
    store.publish(envelope({ lane: "work", topic: "progress" }));
    expect(() =>
      db.database
        .query(
          `INSERT INTO mail_items (
             itemId, recipient, sender, lane, topic, body, seq, state,
             mergedCount, attempts, recipientGeneration, createdAt, updatedAt,
             expiresAt, notBefore
           ) VALUES ('mit_forced', 'ada', 'queen', 'work', 'progress', 'x', 99,
                     'available', 0, 0, NULL, ?, ?, NULL, NULL)`,
        )
        .run(at(5), at(5)),
    ).toThrow();
  });
});

describe("settlement replay", () => {
  test("a re-claim after a defer settles its own attempt, not the replay", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    for (const attempt of [1, 2]) {
      const second = attempt * 500;
      claim(store, receipt.itemId, "h1", second);
      const result = settle(
        store,
        receipt.itemId,
        "h1",
        "deferred",
        second + 1,
      );
      expect(result.replayed).toBe(false);
      expect(result.attempt).toBe(attempt);
    }
    expect(required(store.getItem(receipt.itemId)).attempts).toBe(2);
  });

  test("a stale settlement from an earlier attempt is refused, not replayed", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    claim(store, receipt.itemId, "h1", 1);
    settle(store, receipt.itemId, "h1", "deferred", 2);
    // The same handler takes the item again and then dies, so its lease lapses
    // and there is no live lease to settle against.
    claim(store, receipt.itemId, "h1", 400);
    store.sweepExpiredLeases(at(600), MAIL_MAX_ATTEMPTS);
    expect(required(store.getItem(receipt.itemId)).attempts).toBe(2);
    // A retry of the FIRST deferral now arrives. It settled a different
    // attempt, so answering it as a replay would report work as handled that
    // this handler never finished.
    expect(() =>
      settle(store, receipt.itemId, "h1", "deferred", 601),
    ).toThrow();
  });

  test("a replay of a different disposition is refused, not answered", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    claim(store, receipt.itemId, "h1", 1);
    settle(store, receipt.itemId, "h1", "deferred", 2);
    expect(() => settle(store, receipt.itemId, "h1", "completed", 3)).toThrow();
    expect(required(store.getItem(receipt.itemId)).state).toBe("available");
  });
});

describe("sweep isolation", () => {
  test("a candidate that cannot be released does not hold back its siblings", () => {
    const { store, db } = rig();
    const stuck = store.publish(envelope());
    const healthy = store.publish(
      envelope({ recipient: "bo", idempotencyKey: "queen-2" }),
    );
    // Spend the stuck item's attempts so its release must quarantine it, then
    // occupy the dead-letter row it would need. Its release now fails.
    db.database
      .query("UPDATE mail_items SET attempts = ? WHERE itemId = ?")
      .run(MAIL_MAX_ATTEMPTS, stuck.itemId);
    db.database
      .query(
        `INSERT INTO mail_dead_letters (itemId, recipient, reason, quarantinedAt, itemJson)
         VALUES (?, 'ada', 'occupied', ?, '{}')`,
      )
      .run(stuck.itemId, at(0));
    claim(store, stuck.itemId, "h1", 1);
    store.claim({
      itemId: healthy.itemId,
      recipient: "bo",
      ownerGeneration: 4,
      handlerId: "h2",
      leaseUntil: at(121),
      now: at(1),
      maxAttempts: MAIL_MAX_ATTEMPTS,
    });

    const released = store.sweepExpiredLeases(at(500), MAIL_MAX_ATTEMPTS);
    expect(
      released.find((entry) => entry.itemId === stuck.itemId)?.outcome,
    ).toBe("failed");
    expect(
      released.find((entry) => entry.itemId === healthy.itemId)?.outcome,
    ).toBe("redelivered");
    // The sibling really was released, not merely reported as such.
    expect(required(store.getItem(healthy.itemId)).state).toBe("available");
    expect(store.getLease(healthy.itemId)).toBeNull();
    // The failed candidate rolled back whole: its lease survives untouched.
    expect(required(store.getLease(stuck.itemId)).handlerId).toBe("h1");
    expect(required(store.getItem(stuck.itemId)).state).toBe("leased");
  });
});

describe("mail_dead_letters", () => {
  test("a second quarantine neither duplicates the row nor rewrites the reason", () => {
    const { store } = rig();
    const receipt = store.publish(envelope());
    expect(
      store.quarantine(receipt.itemId, "first-reason", at(1)),
    ).not.toBeNull();
    expect(store.quarantine(receipt.itemId, "second-reason", at(2))).toBeNull();
    const letters = store.listDeadLetters("ada");
    expect(letters).toHaveLength(1);
    expect(required(letters[0]).reason).toBe("first-reason");
    expect(required(letters[0]).quarantinedAt).toBe(at(1));
  });

  test("the frozen document keeps what the item was when it failed", () => {
    const { store } = rig();
    const receipt = store.publish(
      envelope({ recipientGeneration: 3, body: "the poison" }),
    );
    claim(store, receipt.itemId, "h1", 1, 3);
    store.quarantine(receipt.itemId, "expired-task-generation", at(2));
    const letter = required(store.listDeadLetters("ada")[0]);
    expect(letter.item).toMatchObject({
      itemId: receipt.itemId,
      recipient: "ada",
      sender: "queen",
      lane: "control",
      topic: "handoff",
      body: "the poison",
      recipientGeneration: 3,
      attempts: 1,
    });
    expect(store.getLease(receipt.itemId)).toBeNull();
  });
});

describe("standing conditions", () => {
  const standing = (overrides: Record<string, unknown> = {}) =>
    envelope({
      sender: "hive-quota",
      lane: "work",
      topic: "quota",
      body: "kimi /usages answered HTTP 401",
      conditionId: "quota:kimi:live-probe",
      condition: "HTTP 401",
      ...overrides,
    });

  test("an acknowledged condition does not re-enqueue; a changed one does", () => {
    const { store } = rig();
    const first = store.publish(standing({ idempotencyKey: "q1" }));
    expect(first.outcome).toBe("published");
    claim(store, first.itemId, "h1", 1);
    settle(store, first.itemId, "h1", "completed", 2);
    expect(store.listAvailable("ada", "work", 0, 10, at(3))).toHaveLength(0);

    const repeat = store.publish(
      standing({
        idempotencyKey: "q2",
        body: "kimi /usages answered HTTP 401 (again)",
        now: at(4),
        recipientLiveGeneration: 4,
      }),
    );
    expect(repeat.outcome).toBe("restated");
    expect(repeat.itemId).toBe(first.itemId);
    expect(store.listAvailable("ada", "work", 0, 10, at(5))).toHaveLength(0);

    const changed = store.publish(
      standing({
        idempotencyKey: "q3",
        condition: "HTTP 403",
        body: "kimi /usages answered HTTP 403",
        now: at(6),
      }),
    );
    expect(changed.outcome).toBe("published");
    expect(changed.itemId).not.toBe(first.itemId);
    expect(store.listAvailable("ada", "work", 0, 10, at(7))).toHaveLength(1);
  });

  test("clearing an acknowledged condition lets the same fact interrupt again", () => {
    const { store } = rig();
    const first = store.publish(standing({ idempotencyKey: "c1" }));
    claim(store, first.itemId, "h1", 1);
    settle(store, first.itemId, "h1", "completed", 2);
    store.clearStandingCondition("ada", "hive-quota", "quota:kimi:live-probe");
    const again = store.publish(standing({ idempotencyKey: "c2", now: at(3) }));
    expect(again.outcome).toBe("published");
    expect(store.listAvailable("ada", "work", 0, 10, at(4))).toHaveLength(1);
  });

  test("an ack from an earlier incarnation does not suppress the next one", () => {
    const { store } = rig();
    const first = store.publish(standing({ idempotencyKey: "g1" }));
    claim(store, first.itemId, "h1", 1, 15);
    settle(store, first.itemId, "h1", "completed", 2, 15);
    const next = store.publish(
      standing({
        idempotencyKey: "g2",
        now: at(3),
        recipientLiveGeneration: 16,
      }),
    );
    expect(next.outcome).toBe("published");
    expect(next.itemId).not.toBe(first.itemId);
    expect(store.listAvailable("ada", "work", 0, 10, at(4))).toHaveLength(1);
  });
});
