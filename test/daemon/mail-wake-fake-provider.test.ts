import { describe, expect, test } from "bun:test";
import {
  FakeProviderAdapter,
  type FakeProviderSession,
} from "../../src/adapters/providers/protocol/fake-driver";
import type { VendorSessionRef } from "../../src/adapters/providers/protocol/types";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { MailWakeLedger } from "../../src/mail-service/wake-ledger";
import { MailWakeStore } from "../../src/mail-service/wake-store";
import { required } from "../required";

/**
 * The wake path driven end to end against the protocol fake provider.
 *
 * The unit tests pin each transition's evidence rule in isolation. This file
 * asks the other question: when a real `ProviderSession` answers submissions
 * and emits its own lifecycle events, does the ledger still write only what
 * happened? Everything the ledger learns here comes from the driver's own
 * receipts and events rather than from the test asserting it directly.
 */

const T0 = new Date("2026-08-02T12:00:00.000Z");
const at = (secondsFromStart: number): string =>
  new Date(T0.getTime() + secondsFromStart * 1_000).toISOString();

/**
 * Stands in for the frontend scheduler that owns the provider session.
 *
 * It does exactly what the frontend contract promises and nothing else: it
 * submits through the protocol, it never touches a terminal, and it only picks
 * a wake when the provider is between turns.
 */
class Scheduler {
  turnActive = false;
  private submissions = 0;
  private readonly turns = new Map<string, string>();

  constructor(
    private readonly ledger: MailWakeLedger,
    private readonly session: FakeProviderSession,
    private readonly vendorSession: VendorSessionRef,
    private readonly recipient: string,
  ) {}

  /** Attempt one wake. Returns what the scheduler decided to do. */
  async tick(now: string): Promise<string> {
    const schedule = this.ledger.nextWake(this.recipient, {
      turnActive: this.turnActive,
      now,
    });
    if (schedule.kind !== "submit") return schedule.kind;
    this.submissions += 1;
    const clientInputId = `input-${this.submissions}`;
    const receipt = await this.session.submit({
      session: this.vendorSession,
      clientInputId,
      // The wake prompt carries the item id for correlation and no body; the
      // agent still has to poll its own mailbox to read anything.
      text: `poll your mailbox and settle ${schedule.wake.oldestItemId}`,
    });
    if (receipt.outcome === "unknown") {
      this.ledger.applyWakeReport({
        kind: "wake-delivery-unknown",
        schemaVersion: 1,
        wakeId: schedule.wake.wakeId,
        clientInputId: receipt.clientInputId,
        at: now,
      });
      return "delivery-unknown";
    }
    if (receipt.outcome === "rejected") {
      this.ledger.applyWakeReport({
        kind: "wake-failed",
        schemaVersion: 1,
        wakeId: schedule.wake.wakeId,
        reason: "provider rejected the submission",
        at: now,
      });
      return "rejected";
    }
    this.ledger.applyWakeReport({
      kind: "wake-request-accepted",
      schemaVersion: 1,
      wakeId: schedule.wake.wakeId,
      clientInputId: receipt.clientInputId,
      at: now,
    });
    this.turns.set(clientInputId, schedule.wake.wakeId);
    return "submitted";
  }

  /**
   * Drain whatever the provider has emitted so far and report each turn start.
   *
   * The stream is the only place a turn state comes from — the receipt above
   * carried a null `turnId` by construction, so nothing before this point could
   * have proved a turn began.
   */
  async drain(count: number, now: string): Promise<void> {
    const iterator = this.session.events[Symbol.asyncIterator]();
    for (let read = 0; read < count; read += 1) {
      const next = await iterator.next();
      if (next.done === true) return;
      const event = next.value;
      if (event.kind === "turn-started") {
        this.turnActive = true;
        const wakeId =
          event.clientInputId === undefined
            ? undefined
            : this.turns.get(event.clientInputId);
        if (wakeId !== undefined && event.clientInputId !== undefined) {
          this.ledger.applyWakeReport({
            kind: "wake-turn-observed",
            schemaVersion: 1,
            wakeId,
            clientInputId: event.clientInputId,
            vendorSessionId: this.vendorSession.vendorSessionId,
            eventSequence: event.sequence,
            turnId: event.turnId,
            turnClientInputId: event.clientInputId,
            at: now,
          });
        }
      }
      if (event.kind === "turn-idle" || event.kind === "turn-failed") {
        this.turnActive = false;
      }
    }
  }
}

const rig = async (recipient = "ada") => {
  const ledger = new MailWakeLedger(
    new MailWakeStore(new HiveDatabase(":memory:")),
  );
  const adapter = new FakeProviderAdapter();
  await adapter.connect({
    provider: "claude",
    executable: "/fake/provider",
    argv: [],
    cwd: "/fake/cwd",
    env: {},
  });
  const session = required(adapter.session);
  const vendorSession = await session.newSession({ cwd: "/fake/cwd" });
  return {
    ledger,
    session,
    scheduler: new Scheduler(ledger, session, vendorSession, recipient),
  };
};

/** Publish, notify the frontend, and open the wake row. */
const arrive = (
  ledger: MailWakeLedger,
  options: Partial<{
    recipient: string;
    lane: "control" | "work";
    itemId: string;
    brokerSeq: number;
    second: number;
  }> = {},
) => {
  const recipient = options.recipient ?? "ada";
  const second = options.second ?? 0;
  const event = ledger.publishReady({
    recipient,
    lane: options.lane ?? "control",
    oldestItemId: options.itemId ?? "mit_one",
    backlogCount: 1,
    brokerSeq: options.brokerSeq ?? 1,
    publishedItemId: options.itemId ?? "mit_one",
    at: at(second),
  });
  ledger.acknowledge(recipient, {
    recipient,
    cursor: event.cursor,
    brokerSeq: event.brokerSeq,
    at: at(second),
  });
  return ledger.queueWake({
    recipient,
    lane: event.lane,
    oldestItemId: event.oldestItemId,
    at: at(second),
  });
};

describe("wake against the fake provider", () => {
  test("an idle session takes the wake and the turn proves itself", async () => {
    const { ledger, session, scheduler } = await rig();
    arrive(ledger);
    expect(await scheduler.tick(at(1))).toBe("submitted");
    expect(ledger.deliveryState("mit_one")).toBe("vendor_request_accepted");
    // The submission the provider actually received carried no message body.
    expect(required(session.submissions[0]).text).not.toContain("body");
    session.emit({
      kind: "turn-started",
      turnId: "t1",
      clientInputId: "input-1",
    });
    await scheduler.drain(1, at(2));
    expect(ledger.deliveryState("mit_one")).toBe("turn_observed");
  });

  test("a wake raised mid-turn waits for the provider's own boundary", async () => {
    const { ledger, session, scheduler } = await rig();
    session.emit({ kind: "turn-started", turnId: "user-turn" });
    await scheduler.drain(1, at(0));
    expect(scheduler.turnActive).toBe(true);
    arrive(ledger, { second: 1 });
    expect(await scheduler.tick(at(2))).toBe("defer");
    expect(session.submissions).toHaveLength(0);
    expect(ledger.deliveryState("mit_one")).toBe("wake_queued");
    session.emit({ kind: "turn-idle", turnId: "user-turn" });
    await scheduler.drain(1, at(3));
    expect(await scheduler.tick(at(4))).toBe("submitted");
  });

  test("an agent that never claims is re-woken, once per attempt", async () => {
    const { ledger, session, scheduler } = await rig();
    arrive(ledger);
    await scheduler.tick(at(1));
    session.emit({
      kind: "turn-started",
      turnId: "t1",
      clientInputId: "input-1",
    });
    session.emit({ kind: "turn-idle", turnId: "t1" });
    await scheduler.drain(2, at(2));
    // The turn ended and the item is still available: the agent was asked and
    // did not answer, which is a retry rather than a delivery.
    ledger.recordWakeIgnored("mit_one", at(3));
    expect(ledger.deliveryState("mit_one")).toBe("retrying");
    expect(await scheduler.tick(at(3))).toBe("wait");
    expect(await scheduler.tick(at(60))).toBe("submitted");
    expect(session.submissions).toHaveLength(2);
    expect(
      ledger
        .deliveryChain("mit_one")
        .filter((row) => row.state === "wake_queued"),
    ).toHaveLength(1);
  });

  test("a lost acknowledgement retries the wake instead of stalling", async () => {
    const { ledger, session, scheduler } = await rig();
    arrive(ledger);
    session.submitOutcome = "unknown";
    expect(await scheduler.tick(at(1))).toBe("delivery-unknown");
    // A mail wake is keyed on the item, so repeating it costs one empty poll.
    // It is the user outbound row that may never be replayed on this outcome.
    expect(ledger.deliveryState("mit_one")).toBe("retrying");
    expect(ledger.isAutoRetryable("mit_one")).toBe(true);
    session.submitOutcome = "accepted";
    expect(await scheduler.tick(at(60))).toBe("submitted");
  });

  test("the whole chain survives a claim and settles", async () => {
    const { ledger, session, scheduler } = await rig();
    arrive(ledger);
    await scheduler.tick(at(1));
    session.emit({
      kind: "turn-started",
      turnId: "t1",
      clientInputId: "input-1",
    });
    await scheduler.drain(1, at(2));
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(3),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(4),
    });
    ledger.recordSettled({
      itemId: "mit_one",
      recipient: "ada",
      disposition: "completed",
      at: at(5),
    });
    expect(ledger.deliveryChain("mit_one").map((row) => row.state)).toEqual([
      "published",
      "frontend_notified",
      "wake_queued",
      "vendor_request_accepted",
      "turn_observed",
      "mail_presented",
      "mail_claimed",
      "completed",
    ]);
    expect(await scheduler.tick(at(6))).toBe("idle");
    expect(ledger.mailStatus("ada")).toBe("none");
  });

  test("a turn started by something else never proves our wake", async () => {
    const { ledger, session, scheduler } = await rig();
    arrive(ledger);
    await scheduler.tick(at(1));
    // No clientInputId: the vendor said nothing about whose turn this is.
    // Unknown correlation is not evidence, so the state does not advance.
    session.emit({ kind: "turn-started", turnId: "t-other" });
    await scheduler.drain(1, at(2));
    expect(ledger.deliveryState("mit_one")).toBe("vendor_request_accepted");
  });

  test("a live frontend keeps the no-frontend breach quiet", async () => {
    const { ledger, scheduler } = await rig();
    arrive(ledger);
    await scheduler.tick(at(1));
    expect(
      ledger.sloBreaches("ada", at(90)).map((breach) => breach.kind),
    ).not.toContain("no-live-frontend");
    // Positive control: an item nobody acknowledged does breach.
    ledger.publishReady({
      recipient: "bo",
      lane: "control",
      oldestItemId: "mit_bo",
      backlogCount: 1,
      brokerSeq: 1,
      publishedItemId: "mit_bo",
      at: at(0),
    });
    expect(
      ledger.sloBreaches("bo", at(90)).map((breach) => breach.kind),
    ).toContain("no-live-frontend");
  });

  test("a closed provider leaves the wake owed, not delivered", async () => {
    const { ledger, session, scheduler } = await rig();
    arrive(ledger);
    await scheduler.tick(at(1));
    await session.close();
    await scheduler.drain(1, at(2));
    expect(ledger.deliveryState("mit_one")).toBe("vendor_request_accepted");
    expect(ledger.mailStatus("ada")).toBe("waking");
    const breaches = ledger.sloBreaches("ada", at(120));
    expect(breaches.map((breach) => breach.kind)).toContain(
      "control-claim-slo",
    );
    expect(required(breaches[0]).destinations).toEqual([
      "workspace-attention",
      "queen-feed",
    ]);
  });
});
