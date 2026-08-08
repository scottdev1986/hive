import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  hiveMailClaim,
  hiveMailComplete,
  hiveMailPublish,
  type MailBrokerDeps,
  type MailReadyNotifier,
} from "../../src/mail-service/service";
import { MailStore } from "../../src/mail-service/store";
import { MailWakeLedger } from "../../src/mail-service/wake-ledger";
import { MailWakeStore } from "../../src/mail-service/wake-store";
import { required } from "../required";

/**
 * The seam between the broker and the wake ledger.
 *
 * The broker's own contract is unchanged — publish still returns after a
 * durable commit and still means acceptance rather than delivery. What is new
 * is that the commit is followed by a recipient-scoped announcement, and these
 * tests pin what that announcement may and may not contain.
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");
const at = (secondsFromStart: number): Date =>
  new Date(NOW.getTime() + secondsFromStart * 1_000);

type Announcement = Parameters<MailReadyNotifier>[0];

const rig = () => {
  const db = new HiveDatabase(":memory:");
  const announced: Announcement[] = [];
  const ledger = new MailWakeLedger(new MailWakeStore(db));
  const deps: MailBrokerDeps = {
    store: new MailStore(db),
    recipients: (named) => ({ kind: "live", canonical: named }),
    notifyReady: (ready) => {
      announced.push(ready);
      ledger.publishReady(ready);
    },
  };
  return { deps, announced, ledger };
};

const publish = (
  deps: MailBrokerDeps,
  options: Partial<{
    to: string;
    lane: "control" | "work";
    body: string;
    key: string;
    topic: string;
    second: number;
  }> = {},
) =>
  hiveMailPublish(
    deps,
    { subject: "queen", agentGeneration: 3 },
    {
      from: "queen",
      to: options.to ?? "ada",
      lane: options.lane ?? "control",
      topic: options.topic ?? "handoff",
      body: options.body ?? "take ownership of the migration",
      idempotencyKey: options.key ?? "queen-1",
    },
    at(options.second ?? 0),
  );

describe("mail-ready after commit", () => {
  test("a publish announces a count and an id, never the body", () => {
    const { deps, announced } = rig();
    const receipt = publish(deps, { body: "the secret plan" });
    const ready = required(announced[0]);
    expect(ready).toEqual({
      recipient: "ada",
      lane: "control",
      publishedItemId: receipt.itemId,
      brokerSeq: receipt.seq,
      oldestItemId: receipt.itemId,
      backlogCount: 1,
      at: NOW.toISOString(),
    });
    expect(JSON.stringify(ready)).not.toContain("the secret plan");
  });

  test("the announcement names the oldest waiting item, not the newest", () => {
    const { deps, announced } = rig();
    const first = publish(deps, { key: "queen-1" });
    publish(deps, { key: "queen-2", second: 5 });
    const second = required(announced[1]);
    expect(second.oldestItemId).toBe(first.itemId);
    expect(second.backlogCount).toBe(2);
    expect(second.brokerSeq).toBe(2);
  });

  test("a busy control lane announces nothing rather than a second wake", () => {
    const { deps, announced } = rig();
    const first = publish(deps, { key: "queen-1" });
    hiveMailClaim(
      deps,
      { subject: "ada", agentGeneration: 0 },
      { recipient: "ada", itemId: first.itemId, handlerId: "ada-1" },
      at(1),
    );
    publish(deps, { key: "queen-2", second: 2 });
    // The agent is already holding an instruction; the lane withholds the next
    // one from a poll, so announcing it would ask the agent to interrupt itself.
    expect(announced).toHaveLength(1);
  });

  test("each recipient is announced only to itself", () => {
    const { deps, announced } = rig();
    publish(deps, { to: "ada", key: "queen-1" });
    publish(deps, { to: "bo", key: "queen-2", second: 1 });
    expect(announced.map((ready) => ready.recipient)).toEqual(["ada", "bo"]);
  });

  test("the ledger records published for the item the broker committed", () => {
    const { deps, ledger } = rig();
    const receipt = publish(deps);
    expect(ledger.deliveryState(receipt.itemId)).toBe("published");
    expect(required(ledger.deliveryChain(receipt.itemId)[0]).evidenceKind).toBe(
      "broker-publish-receipt",
    );
  });

  test("a retried publish leaves the frontend one thing to resume from", () => {
    const { deps, ledger } = rig();
    publish(deps, { key: "queen-1" });
    publish(deps, { key: "queen-1", second: 4 });
    // The retry is answered from the stored receipt, so the mailbox gained
    // nothing. The sequence it carries is the original's, and a resuming
    // frontend replays that one notification rather than two.
    const replayed = ledger.subscribe("ada", {
      kind: "mail-subscribe",
      schemaVersion: 1,
      sinceCursor: 0,
      recipient: "ada",
    });
    expect(replayed).toHaveLength(1);
  });

  test("a broker with no listener still accepts mail", () => {
    const db = new HiveDatabase(":memory:");
    const deps: MailBrokerDeps = {
      store: new MailStore(db),
      recipients: (named) => ({ kind: "live", canonical: named }),
    };
    expect(publish(deps).outcome).toBe("published");
  });

  test("a notifier that throws does not lose the message", () => {
    const db = new HiveDatabase(":memory:");
    const store = new MailStore(db);
    const deps: MailBrokerDeps = {
      store,
      recipients: (named) => ({ kind: "live", canonical: named }),
      notifyReady: () => {
        throw new Error("the frontend socket is gone");
      },
    };
    const receipt = publish(deps);
    // The sender already holds a durable receipt. Failing the publish to report
    // a failed wake would lose the message in order to protect the wake.
    expect(receipt.outcome).toBe("published");
    expect(store.getItem(receipt.itemId)).not.toBeNull();
  });
});

describe("mail-ready after a lane frees up", () => {
  const claim = (deps: MailBrokerDeps, itemId: string, second: number) =>
    hiveMailClaim(
      deps,
      { subject: "ada", agentGeneration: 0 },
      { recipient: "ada", itemId, handlerId: "ada-1" },
      at(second),
    );

  const settle = (deps: MailBrokerDeps, itemId: string, second: number) =>
    hiveMailComplete(
      deps,
      { subject: "ada", agentGeneration: 0 },
      {
        recipient: "ada",
        itemId,
        handlerId: "ada-1",
        disposition: "completed",
      },
      at(second),
    );

  test("the message a busy lane withheld is announced once it is offerable", () => {
    const { deps, announced, ledger } = rig();
    const first = publish(deps, { key: "queen-1" });
    claim(deps, first.itemId, 1);
    const second = publish(deps, { key: "queen-2", second: 2 });
    // Nothing was announced while the lane was busy. Without the settle-time
    // announcement this instruction would wait for unrelated mail to arrive
    // before anybody was woken for it.
    expect(announced).toHaveLength(1);
    settle(deps, first.itemId, 3);
    expect(announced.map((ready) => ready.oldestItemId)).toEqual([
      first.itemId,
      second.itemId,
    ]);
    expect(ledger.deliveryState(second.itemId)).toBe("published");
  });

  test("a frontend that acknowledged the old sequence still sees the new one", () => {
    const { deps, ledger } = rig();
    const first = publish(deps, { key: "queen-1" });
    const second = publish(deps, { key: "queen-2", second: 1 });
    const seen = ledger.subscribe("ada", {
      kind: "mail-subscribe",
      schemaVersion: 1,
      recipient: "ada",
      sinceCursor: 0,
    });
    // Both announcements so far named the first item: it was oldest each time.
    expect(seen.map((event) => event.oldestItemId)).toEqual([
      first.itemId,
      first.itemId,
    ]);
    const acknowledged = required(seen.at(-1));
    claim(deps, first.itemId, 2);
    settle(deps, first.itemId, 3);
    const resumed = ledger.subscribe("ada", {
      kind: "mail-subscribe",
      schemaVersion: 1,
      recipient: "ada",
      sinceCursor: acknowledged.cursor,
    });
    expect(resumed.map((event) => event.oldestItemId)).toEqual([second.itemId]);
    // This is why the cursor has to be its own number. The announcement that
    // just rescued the second message carries a MAILBOX sequence at or below
    // the one this frontend already acknowledged, so a resume keyed on that
    // number would step straight over it and the message would wait forever.
    // If this assertion ever stops holding, the hole cannot reopen quietly —
    // it means the two numbers no longer diverge and the test is telling you.
    expect(required(resumed[0]).brokerSeq).toBeLessThanOrEqual(
      acknowledged.brokerSeq,
    );
    expect(required(resumed[0]).cursor).toBeGreaterThan(acknowledged.cursor);
  });

  test("settling the last message announces nothing", () => {
    const { deps, announced } = rig();
    const only = publish(deps, { key: "queen-1" });
    claim(deps, only.itemId, 1);
    settle(deps, only.itemId, 2);
    expect(announced).toHaveLength(1);
  });

  test("an identical repeat files nothing new", () => {
    const { deps, ledger } = rig();
    const only = publish(deps, { key: "queen-1" });
    claim(deps, only.itemId, 1);
    // Deferring returns the item to the lane, so the settle-time announcement
    // names exactly what the publish already named.
    hiveMailComplete(
      deps,
      { subject: "ada", agentGeneration: 0 },
      {
        recipient: "ada",
        itemId: only.itemId,
        handlerId: "ada-1",
        disposition: "deferred",
        retryAfterSeconds: 1,
      },
      at(2),
    );
    expect(
      ledger.subscribe("ada", {
        kind: "mail-subscribe",
        schemaVersion: 1,
        recipient: "ada",
        sinceCursor: 0,
      }),
    ).toHaveLength(1);
  });
});
