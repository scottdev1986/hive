import { describe, expect, test } from "bun:test";
import type { MailReadyNotice } from "../src/cli/agent-ui/agent-ui-exports";
import { deliverMailReadyNotices } from "../src/cli/agent-ui/run";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { MailWakeLedger } from "../src/mail-service/wake-ledger";
import { MailWakeStore } from "../src/mail-service/wake-store";
import { deriveWakeId } from "../src/schemas/mail-wake";

/**
 * Drives the real order the watcher runs in, against a real ledger.
 *
 * Each side of this was already covered and each side was already right: the
 * frontend tests mock the reporter and never reach the ledger, and the ledger
 * tests acknowledge before they report. The defect lived only in the order the
 * two are composed in, which is why it needs a test that owns both ends.
 */
const NOTICE: MailReadyNotice = {
  wakeId: deriveWakeId("ada", "control", "mit_one"),
  recipient: "ada",
  lane: "control",
  oldestItemId: "mit_one",
  backlogCount: 1,
  cursor: 1,
  brokerSeq: 7,
};

const rig = (): MailWakeLedger =>
  new MailWakeLedger(new MailWakeStore(new HiveDatabase(":memory:")));

/** The published item the notice is about, as the broker would have left it. */
function announced(ledger: MailWakeLedger): void {
  ledger.publishReady({
    recipient: "ada",
    lane: "control",
    oldestItemId: "mit_one",
    backlogCount: 1,
    brokerSeq: 7,
    publishedItemId: "mit_one",
    at: "2026-08-02T12:00:00.000Z",
  });
}

describe("the mail-ready notice reaches the ledger in a writable order", () => {
  test("a queued wake lands, because the ack that permits it went first", async () => {
    const ledger = rig();
    announced(ledger);

    await deliverMailReadyNotices(
      [NOTICE],
      {
        onMailReadyBatch: async ([notice]) => {
          if (notice === undefined) throw new Error("notice missing");
          ledger.acceptWakeReport("ada", {
            kind: "wake-queued",
            schemaVersion: 1,
            wakeId: notice.wakeId,
            recipient: notice.recipient,
            lane: notice.lane,
            oldestItemId: notice.oldestItemId,
            at: "2026-08-02T12:00:02.000Z",
          });
        },
      },
      {
        acknowledge: async (notice) => {
          ledger.acknowledge("ada", {
            recipient: "ada",
            cursor: notice.cursor,
            brokerSeq: notice.brokerSeq,
            at: "2026-08-02T12:00:01.000Z",
          });
        },
      },
    );

    expect(ledger.deliveryChain("mit_one").map((row) => row.state)).toEqual([
      "published",
      "frontend_notified",
      "wake_queued",
    ]);
  });

  test("a burst is acknowledged in order before one UI handoff", async () => {
    const second = {
      ...NOTICE,
      wakeId: deriveWakeId("ada", "control", "mit_two"),
      oldestItemId: "mit_two",
      brokerSeq: 8,
    };
    const order: string[] = [];

    await deliverMailReadyNotices(
      [NOTICE, second],
      {
        onMailReadyBatch: async (notices) => {
          order.push(
            `batch:${notices.map((notice) => notice.wakeId).join(",")}`,
          );
        },
      },
      {
        acknowledge: async (notice) => {
          order.push(`ack:${notice.cursor}:${notice.brokerSeq}`);
        },
      },
    );

    expect(order).toEqual([
      "ack:1:7",
      "ack:1:8",
      `batch:${NOTICE.wakeId},${second.wakeId}`,
    ]);
  });

  /**
   * The orphan is what made the original defect permanent rather than noisy:
   * the wake row committed on its own, so every later report found a wake whose
   * queued transition had never been written and could never be repaired.
   */
  test("a wake whose transition is refused leaves no row behind", () => {
    const ledger = rig();
    announced(ledger);

    // No acknowledgement, so wake_queued has no prerequisite and is refused.
    expect(() =>
      ledger.acceptWakeReport("ada", {
        kind: "wake-queued",
        schemaVersion: 1,
        wakeId: NOTICE.wakeId,
        recipient: "ada",
        lane: "control",
        oldestItemId: "mit_one",
        at: "2026-08-02T12:00:02.000Z",
      }),
    ).toThrow("frontend_notified");

    // Acknowledging late must still leave the wake reportable rather than
    // stranded behind a row that outlived its own failure.
    ledger.acknowledge("ada", {
      recipient: "ada",
      cursor: NOTICE.cursor,
      brokerSeq: 7,
      at: "2026-08-02T12:00:03.000Z",
    });
    ledger.acceptWakeReport("ada", {
      kind: "wake-queued",
      schemaVersion: 1,
      wakeId: NOTICE.wakeId,
      recipient: "ada",
      lane: "control",
      oldestItemId: "mit_one",
      at: "2026-08-02T12:00:04.000Z",
    });

    expect(ledger.deliveryChain("mit_one").map((row) => row.state)).toEqual([
      "published",
      "frontend_notified",
      "wake_queued",
    ]);
  });
});
