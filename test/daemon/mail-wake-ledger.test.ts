import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  MailEvidenceError,
  MailWakeAclError,
  MailWakeLedger,
} from "../../src/mail-service/wake-ledger";
import { MailWakeStore } from "../../src/mail-service/wake-store";
import {
  MAIL_CONTROL_CLAIM_SLO_SECONDS,
  MAIL_FRONTEND_SILENT_BREACH_SECONDS,
  MAIL_WAKE_BACKOFF_MAX_SECONDS,
  MAIL_WAKE_MAX_ATTEMPTS,
} from "../../src/schemas/mail-wake";
import { required } from "../required";

const T0 = new Date("2026-08-02T12:00:00.000Z");
const at = (secondsFromStart: number): string =>
  new Date(T0.getTime() + secondsFromStart * 1_000).toISOString();

const rig = (): MailWakeLedger =>
  new MailWakeLedger(new MailWakeStore(new HiveDatabase(":memory:")));

/**
 * Stands in for a vendor session the way the protocol frontend sees one.
 *
 * It answers a prompt request with an id, and separately emits a lifecycle
 * event with a different id. Keeping the two apart is the point: a test that
 * let one id serve both purposes could not tell an acknowledgement from an
 * observation, which is exactly the confusion the ledger has to reject.
 */
class FakeProvider {
  private requests = 0;
  private turns = 0;
  turnActive = false;
  /** When false the turn runs but the agent never touches its mailbox. */
  claimsMail = true;

  submit(): string {
    this.requests += 1;
    return `req-${this.requests}`;
  }

  startTurn(): string {
    this.turnActive = true;
    this.turns += 1;
    return `evt-${this.turns}`;
  }

  endTurn(): void {
    this.turnActive = false;
  }
}

const publish = (
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
  const lane = options.lane ?? "control";
  const itemId = options.itemId ?? "mit_one";
  const brokerSeq = options.brokerSeq ?? 1;
  return ledger.publishReady({
    recipient,
    lane,
    oldestItemId: itemId,
    backlogCount: 1,
    brokerSeq,
    publishedItemId: itemId,
    at: at(options.second ?? 0),
  });
};

/** Publish, notify a live frontend, and open the wake row. */
const woken = (
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
  const event = publish(ledger, options);
  ledger.acknowledge(recipient, {
    recipient,
    cursor: event.cursor,
    brokerSeq: event.brokerSeq,
    at: at((options.second ?? 0) + 1),
  });
  return ledger.queueWake({
    recipient,
    lane: event.lane,
    oldestItemId: event.oldestItemId,
    at: at((options.second ?? 0) + 1),
  });
};

describe("mail-ready notification", () => {
  test("carries a count and an id, never a body", () => {
    const ledger = rig();
    const event = publish(ledger);
    expect(Object.keys(event).sort()).toEqual([
      "at",
      "backlogCount",
      "brokerSeq",
      "cursor",
      "kind",
      "lane",
      "oldestItemId",
      "recipient",
      "schemaVersion",
    ]);
    expect(JSON.stringify(event)).not.toContain("body");
  });

  /**
   * The event and the `published` row are one fact. Filing the event and then
   * losing the row was the half-applied transition behind the 2026-08-03
   * mailbox wedge, so the two writes commit together or not at all.
   */
  test("a failed published-row write takes the ready event down with it", () => {
    class FailingAppendStore extends MailWakeStore {
      override appendDelivery(): never {
        throw new Error("append failed for the test");
      }
    }
    const store = new FailingAppendStore(new HiveDatabase(":memory:"));
    const ledger = new MailWakeLedger(store);
    expect(() => publish(ledger)).toThrow("append failed for the test");
    expect(store.readySince("ada", 0)).toEqual([]);
    expect(store.deliveryChain("mit_one")).toEqual([]);
  });

  test("a frontend resumes its own mailbox from a cursor", () => {
    const ledger = rig();
    publish(ledger, { itemId: "mit_one", brokerSeq: 1 });
    publish(ledger, { itemId: "mit_two", brokerSeq: 2, second: 5 });
    publish(ledger, { itemId: "mit_three", brokerSeq: 3, second: 9 });
    const replayed = ledger.subscribe("ada", {
      kind: "mail-subscribe",
      schemaVersion: 1,
      sinceCursor: 1,
      recipient: "ada",
    });
    expect(replayed.map((event) => event.brokerSeq)).toEqual([2, 3]);
  });

  test("subscribing from now replays nothing that already happened", () => {
    const ledger = rig();
    publish(ledger);
    expect(
      ledger.subscribe("ada", {
        kind: "mail-subscribe",
        schemaVersion: 1,
        sinceCursor: null,
        recipient: "ada",
      }),
    ).toEqual([]);
  });

  test("a subject cannot watch another subject's mailbox", () => {
    const ledger = rig();
    publish(ledger);
    // Positive control: the reader works, so the refusal below is the ACL and
    // not an empty ledger.
    expect(
      ledger.subscribe("ada", {
        kind: "mail-subscribe",
        schemaVersion: 1,
        sinceCursor: 0,
        recipient: "ada",
      }),
    ).toHaveLength(1);
    expect(() =>
      ledger.subscribe("queen", {
        kind: "mail-subscribe",
        schemaVersion: 1,
        sinceCursor: 0,
        recipient: "ada",
      }),
    ).toThrow(MailWakeAclError);
    expect(() =>
      ledger.acknowledge("queen", {
        recipient: "ada",
        cursor: 1,
        brokerSeq: 1,
        at: at(1),
      }),
    ).toThrow(MailWakeAclError);
  });

  test("an acknowledgement certifies only the notification it identifies", () => {
    const ledger = rig();
    const first = publish(ledger, { brokerSeq: 1 });
    const second = publish(ledger, {
      itemId: "mit_two",
      brokerSeq: 2,
      second: 2,
    });
    ledger.acknowledge("ada", {
      recipient: "ada",
      cursor: second.cursor,
      brokerSeq: 2,
      at: at(3),
    });
    expect(ledger.deliveryState("mit_one")).toBe("published");
    expect(ledger.deliveryState("mit_two")).toBe("frontend_notified");
    ledger.acknowledge("ada", {
      recipient: "ada",
      cursor: first.cursor,
      brokerSeq: 1,
      at: at(4),
    });
    expect(ledger.deliveryState("mit_one")).toBe("frontend_notified");
  });

  test("an acknowledgement still writes frontend_notified after a poll has presented", () => {
    const ledger = rig();
    const event = publish(ledger);
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "hive_mail_poll:seq:1",
      at: at(1),
    });
    expect(ledger.deliveryState("mit_one")).toBe("mail_presented");
    ledger.acknowledge("ada", {
      recipient: "ada",
      cursor: event.cursor,
      brokerSeq: event.brokerSeq,
      at: at(2),
    });
    expect(ledger.deliveryChain("mit_one").map((row) => row.state)).toEqual([
      "published",
      "mail_presented",
      "frontend_notified",
    ]);
    ledger.queueWake({
      recipient: "ada",
      lane: "control",
      oldestItemId: "mit_one",
      at: at(3),
    });
    expect(ledger.deliveryState("mit_one")).toBe("wake_queued");
  });
});

describe("wake scheduling", () => {
  test("an idle recipient's wake is submittable immediately", () => {
    const ledger = rig();
    const provider = new FakeProvider();
    woken(ledger);
    const schedule = ledger.nextWake("ada", {
      turnActive: provider.turnActive,
      now: at(1),
    });
    expect(schedule.kind).toBe("submit");
  });

  test("a wake raised during an active turn waits for the boundary", () => {
    const ledger = rig();
    const provider = new FakeProvider();
    provider.startTurn();
    woken(ledger);
    const duringTurn = ledger.nextWake("ada", {
      turnActive: provider.turnActive,
      now: at(1),
    });
    expect(duringTurn).toMatchObject({ kind: "defer", reason: "turn-active" });
    provider.endTurn();
    const atBoundary = ledger.nextWake("ada", {
      turnActive: provider.turnActive,
      now: at(2),
    });
    expect(atBoundary.kind).toBe("submit");
  });

  test("a control wake outranks a work wake without editing either", () => {
    const ledger = rig();
    const work = woken(ledger, {
      lane: "work",
      itemId: "mit_work",
      brokerSeq: 1,
    });
    const control = woken(ledger, {
      lane: "control",
      itemId: "mit_control",
      brokerSeq: 2,
      second: 10,
    });
    const schedule = ledger.nextWake("ada", {
      turnActive: false,
      now: at(20),
    });
    expect(schedule).toMatchObject({ kind: "submit", priority: 2 });
    expect(schedule.kind === "submit" && schedule.wake.wakeId).toBe(
      control.wakeId,
    );
    // The work wake is still queued exactly as it was, merely not chosen.
    expect(ledger.deliveryState(work.oldestItemId)).toBe("wake_queued");
  });

  test("a duplicate wake for the same item is harmless", () => {
    const ledger = rig();
    const first = woken(ledger);
    const second = ledger.queueWake({
      recipient: "ada",
      lane: "control",
      oldestItemId: "mit_one",
      at: at(3),
    });
    expect(second.wakeId).toBe(first.wakeId);
    expect(
      ledger
        .deliveryChain("mit_one")
        .filter((row) => row.state === "wake_queued"),
    ).toHaveLength(1);
  });

  test("nothing is submittable while a retry is still backing off", () => {
    const ledger = rig();
    woken(ledger);
    ledger.recordWakeIgnored("mit_one", at(10));
    expect(
      ledger.nextWake("ada", { turnActive: false, now: at(10) }).kind,
    ).toBe("wait");
    expect(
      ledger.nextWake("ada", { turnActive: false, now: at(60) }).kind,
    ).toBe("submit");
  });

  test("an empty mailbox schedules nothing", () => {
    const ledger = rig();
    expect(ledger.nextWake("ada", { turnActive: false, now: at(0) })).toEqual({
      kind: "idle",
    });
  });
});

describe("evidence, not acts", () => {
  test("a request acknowledgement can never become turn_observed", () => {
    const ledger = rig();
    const provider = new FakeProvider();
    const wake = woken(ledger);
    const requestId = provider.submit();
    ledger.applyWakeReport({
      kind: "wake-request-accepted",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: requestId,
      at: at(2),
    });
    expect(ledger.deliveryState("mit_one")).toBe("vendor_request_accepted");
    expect(() =>
      ledger.applyWakeReport({
        kind: "wake-turn-observed",
        schemaVersion: 1,
        wakeId: wake.wakeId,
        clientInputId: requestId,
        vendorSessionId: "ses-1",
        eventSequence: 1,
        turnId: requestId,
        turnClientInputId: null,
        at: at(3),
      }),
    ).toThrow(MailEvidenceError);
    expect(ledger.deliveryState("mit_one")).toBe("vendor_request_accepted");
    // Positive control: a real lifecycle event with its own id is accepted.
    ledger.applyWakeReport({
      kind: "wake-turn-observed",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: requestId,
      vendorSessionId: "ses-1",
      eventSequence: 1,
      turnId: provider.startTurn(),
      turnClientInputId: null,
      at: at(3),
    });
    expect(ledger.deliveryState("mit_one")).toBe("turn_observed");
  });

  test("a turn cannot be observed for a request that was never accepted", () => {
    const ledger = rig();
    const wake = woken(ledger);
    expect(() =>
      ledger.applyWakeReport({
        kind: "wake-turn-observed",
        schemaVersion: 1,
        wakeId: wake.wakeId,
        clientInputId: "req-1",
        vendorSessionId: "ses-1",
        eventSequence: 1,
        turnId: "evt-1",
        turnClientInputId: null,
        at: at(2),
      }),
    ).toThrow(MailEvidenceError);
    const stillQueued = ledger.nextWake("ada", {
      turnActive: false,
      now: at(3),
    });
    expect(stillQueued.kind).toBe("submit");
    expect(stillQueued.kind === "submit" && stillQueued.wake).toEqual(
      expect.objectContaining({ state: "queued", turnEventId: null }),
    );
  });

  test("replaying a request receipt neither duplicates nor rewinds it", () => {
    const ledger = rig();
    const wake = woken(ledger);
    const accepted = {
      kind: "wake-request-accepted" as const,
      schemaVersion: 1 as const,
      wakeId: wake.wakeId,
      clientInputId: "req-1",
      at: at(2),
    };
    ledger.applyWakeReport(accepted);
    ledger.applyWakeReport(accepted);

    expect(
      ledger
        .deliveryChain("mit_one")
        .filter((row) => row.state === "vendor_request_accepted"),
    ).toHaveLength(1);
    ledger.applyWakeReport({
      kind: "wake-turn-observed",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: "req-1",
      vendorSessionId: "ses-1",
      eventSequence: 1,
      turnId: "evt-1",
      turnClientInputId: "req-1",
      at: at(3),
    });
    ledger.applyWakeReport(accepted);
    expect(ledger.nextWake("ada", { turnActive: false, now: at(4) })).toEqual(
      expect.objectContaining({
        wake: expect.objectContaining({ state: "observed" }),
      }),
    );
  });

  test("a claim without a presentation behind it is refused", () => {
    const ledger = rig();
    publish(ledger);
    expect(() =>
      ledger.recordClaimed({
        itemId: "mit_one",
        recipient: "ada",
        handlerId: "ada-1",
        at: at(5),
      }),
    ).toThrow(MailEvidenceError);
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(6),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(7),
    });
    expect(ledger.deliveryState("mit_one")).toBe("mail_claimed");
  });

  test("a settlement without a claim behind it is refused", () => {
    const ledger = rig();
    publish(ledger);
    expect(() =>
      ledger.recordSettled({
        itemId: "mit_one",
        recipient: "ada",
        disposition: "completed",
        at: at(5),
      }),
    ).toThrow(MailEvidenceError);
  });

  test("a wake cannot be queued before a frontend admitted hearing", () => {
    const ledger = rig();
    publish(ledger);
    expect(() =>
      ledger.queueWake({
        recipient: "ada",
        lane: "control",
        oldestItemId: "mit_one",
        at: at(1),
      }),
    ).toThrow(MailEvidenceError);
  });

  test("a claimed item carries the whole chain that proves it", () => {
    const ledger = rig();
    const provider = new FakeProvider();
    const wake = woken(ledger);
    ledger.applyWakeReport({
      kind: "wake-request-accepted",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: provider.submit(),
      at: at(2),
    });
    ledger.applyWakeReport({
      kind: "wake-turn-observed",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: "req-1",
      vendorSessionId: "ses-1",
      eventSequence: 1,
      turnId: provider.startTurn(),
      turnClientInputId: null,
      at: at(3),
    });
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(4),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(5),
    });
    ledger.recordSettled({
      itemId: "mit_one",
      recipient: "ada",
      disposition: "completed",
      at: at(6),
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
    expect(
      ledger.deliveryChain("mit_one").map((row) => row.evidenceKind),
    ).toEqual([
      "broker-publish-receipt",
      "frontend-ack",
      "wake-row",
      "protocol-response",
      "turn-lifecycle-event",
      "poll-response",
      "broker-lease",
      "broker-settlement",
    ]);
  });
});

describe("retry policy", () => {
  test("an ignored wake retries idempotently against the same item", () => {
    const ledger = rig();
    const provider = new FakeProvider();
    provider.claimsMail = false;
    const wake = woken(ledger);
    ledger.applyWakeReport({
      kind: "wake-request-accepted",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: provider.submit(),
      at: at(2),
    });
    ledger.applyWakeReport({
      kind: "wake-turn-observed",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: "req-1",
      vendorSessionId: "ses-1",
      eventSequence: 1,
      turnId: provider.startTurn(),
      turnClientInputId: null,
      at: at(3),
    });
    provider.endTurn();
    ledger.recordWakeIgnored("mit_one", at(4));
    expect(ledger.deliveryState("mit_one")).toBe("retrying");
    const next = ledger.nextWake("ada", { turnActive: false, now: at(120) });
    expect(next.kind === "submit" && next.wake.wakeId).toBe(wake.wakeId);
    expect(next.kind === "submit" && next.wake.attempts).toBe(1);
    // The retry re-attempts one wake row, so nothing about the mailbox item
    // duplicated while the agent kept not answering.
    expect(
      ledger
        .deliveryChain("mit_one")
        .filter((row) => row.state === "wake_queued"),
    ).toHaveLength(1);
  });

  /**
   * The branch that had never run in production. Exhausting a wake is the one
   * case where the item stays in the mailbox and nothing is left to announce
   * it, so silence here is indistinguishable from a mailbox nobody wrote to.
   */
  test("an exhausted wake says so, with enough to act on", () => {
    const announced: {
      recipient: string;
      oldestItemId: string;
      attempts: number;
      lane: string;
    }[] = [];
    const ledger = new MailWakeLedger(
      new MailWakeStore(new HiveDatabase(":memory:")),
      () => undefined,
      (exhausted) => {
        announced.push({
          recipient: exhausted.recipient,
          oldestItemId: exhausted.oldestItemId,
          attempts: exhausted.attempts,
          lane: exhausted.lane,
        });
      },
    );
    woken(ledger);

    for (let attempt = 1; attempt <= MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      ledger.recordWakeIgnored("mit_one", at(attempt * 1_000));
    }

    expect(announced).toEqual([
      {
        recipient: "ada",
        oldestItemId: "mit_one",
        attempts: MAIL_WAKE_MAX_ATTEMPTS,
        lane: "control",
      },
    ]);
    expect(ledger.deliveryState("mit_one")).toBe("dead_lettered");
  });

  test("a wake short of its limit announces nothing", () => {
    let announcements = 0;
    const ledger = new MailWakeLedger(
      new MailWakeStore(new HiveDatabase(":memory:")),
      () => undefined,
      () => {
        announcements += 1;
      },
    );
    woken(ledger);

    for (let attempt = 1; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      ledger.recordWakeIgnored("mit_one", at(attempt * 1_000));
    }

    expect(announcements).toBe(0);
  });

  test("backoff lengthens and the item dead-letters when policy is exhausted", () => {
    const ledger = rig();
    woken(ledger);
    const waits: number[] = [];
    for (let attempt = 1; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      ledger.recordWakeIgnored("mit_one", at(attempt * 1_000));
      const schedule = ledger.nextWake("ada", {
        turnActive: false,
        now: at(attempt * 1_000),
      });
      expect(schedule.kind).toBe("wait");
      if (schedule.kind !== "wait") continue;
      waits.push(
        (Date.parse(schedule.readyAt) - Date.parse(at(attempt * 1_000))) /
          1_000,
      );
    }
    expect(waits).toEqual([2, 4, 8, 16]);
    ledger.recordWakeIgnored("mit_one", at(9_000));
    expect(ledger.deliveryState("mit_one")).toBe("dead_lettered");
    expect(required(ledger.deliveryChain("mit_one").at(-1)).evidenceKind).toBe(
      "wake-policy-exhausted",
    );
    expect(
      ledger.nextWake("ada", { turnActive: false, now: at(99_999) }),
    ).toEqual({ kind: "idle" });
  });

  test("a settled item stops being woken", () => {
    const ledger = rig();
    woken(ledger);
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(4),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(5),
    });
    ledger.recordSettled({
      itemId: "mit_one",
      recipient: "ada",
      disposition: "completed",
      at: at(6),
    });
    expect(ledger.nextWake("ada", { turnActive: false, now: at(600) })).toEqual(
      {
        kind: "idle",
      },
    );
  });

  test("a pending retry is retired when its item is no longer offerable", () => {
    const ledger = new MailWakeLedger(
      new MailWakeStore(new HiveDatabase(":memory:")),
      () => undefined,
      () => undefined,
      () => false,
    );
    woken(ledger);
    ledger.recordWakeIgnored("mit_one", at(4));

    expect(
      ledger.nextWake("ada", {
        turnActive: false,
        now: at(600),
      }),
    ).toEqual({ kind: "idle" });
  });
});

describe("ambiguous user submission", () => {
  test("delivery_unknown is never woken automatically", () => {
    const ledger = rig();
    ledger.recordDeliveryUnknown({
      clientInputId: "cli_one",
      recipient: "ada",
      reason: "transport closed before the acknowledgement",
      at: at(0),
    });
    expect(ledger.deliveryState("cli_one")).toBe("delivery_unknown");
    expect(ledger.isAutoRetryable("cli_one")).toBe(false);
    expect(() =>
      ledger.queueWake({
        recipient: "ada",
        lane: "control",
        oldestItemId: "cli_one",
        at: at(1),
      }),
    ).toThrow(MailEvidenceError);
    expect(
      ledger.nextWake("ada", { turnActive: false, now: at(3_600) }),
    ).toEqual({ kind: "idle" });
    // Positive control: a normal mail item is auto-retryable.
    publish(ledger, { itemId: "mit_one" });
    expect(ledger.isAutoRetryable("mit_one")).toBe(true);
  });
});

describe("latency and SLO", () => {
  test("latency joins broker and protocol rows with no hook timestamps", () => {
    const ledger = rig();
    const wake = woken(ledger);
    ledger.applyWakeReport({
      kind: "wake-request-accepted",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: "req-1",
      at: at(2),
    });
    ledger.applyWakeReport({
      kind: "wake-turn-observed",
      schemaVersion: 1,
      wakeId: wake.wakeId,
      clientInputId: "req-1",
      vendorSessionId: "ses-1",
      eventSequence: 1,
      turnId: "evt-1",
      turnClientInputId: null,
      at: at(4),
    });
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(5),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(6),
    });
    expect(ledger.latency("mit_one")).toMatchObject({
      lane: "control",
      frontendNotifiedMs: 1_000,
      requestAcceptedMs: 2_000,
      turnObservedMs: 4_000,
      claimedMs: 6_000,
      settledMs: null,
    });
  });

  test("an unobserved item measures nothing rather than zero", () => {
    const ledger = rig();
    publish(ledger);
    expect(ledger.latency("mit_one")).toMatchObject({
      frontendNotifiedMs: null,
      turnObservedMs: null,
      claimedMs: null,
    });
    expect(ledger.latency("mit_absent")).toBeNull();
  });

  test("no live frontend breaches outside the stalled mailbox", () => {
    const ledger = rig();
    publish(ledger);
    expect(
      ledger
        .sloBreaches("ada", at(MAIL_FRONTEND_SILENT_BREACH_SECONDS - 1))
        .map((breach) => breach.kind),
    ).not.toContain("no-live-frontend");
    const breaches = ledger.sloBreaches(
      "ada",
      at(MAIL_FRONTEND_SILENT_BREACH_SECONDS),
    );
    const silent = required(
      breaches.find((breach) => breach.kind === "no-live-frontend"),
    );
    expect(silent.destinations).toEqual(["workspace-attention", "queen-feed"]);
    expect(silent.destinations).not.toContain("mailbox");
    expect(silent.recipient).toBe("ada");
  });

  test("a control item unclaimed past its target breaches even with a frontend", () => {
    const ledger = rig();
    woken(ledger);
    const breaches = ledger.sloBreaches(
      "ada",
      at(MAIL_CONTROL_CLAIM_SLO_SECONDS),
    );
    expect(breaches.map((breach) => breach.kind)).toEqual([
      "control-claim-slo",
    ]);
    expect(required(breaches[0]).destinations).toEqual([
      "workspace-attention",
      "queen-feed",
    ]);
  });

  test("a claimed item stops breaching", () => {
    const ledger = rig();
    woken(ledger);
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(5),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(6),
    });
    expect(ledger.sloBreaches("ada", at(100))).toHaveLength(0);
  });

  test("the 600 second incident threshold still fires", () => {
    const ledger = rig();
    publish(ledger);
    expect(
      ledger.sloBreaches("ada", at(600)).map((breach) => breach.kind),
    ).toContain("mail-incident");
  });
});

describe("mail status dimension", () => {
  test("a recipient the ledger has never seen is unknown, not none", () => {
    const ledger = rig();
    expect(ledger.mailStatus("ada")).toBeNull();
    publish(ledger);
    expect(ledger.mailStatus("ada")).toBe("waiting");
  });

  test("the dimension tracks the wake through to settlement", () => {
    const ledger = rig();
    woken(ledger);
    expect(ledger.mailStatus("ada")).toBe("waking");
    ledger.recordWakeIgnored("mit_one", at(10));
    expect(ledger.mailStatus("ada")).toBe("retrying");
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(20),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(21),
    });
    expect(ledger.mailStatus("ada")).toBe("claimed");
    ledger.recordSettled({
      itemId: "mit_one",
      recipient: "ada",
      disposition: "completed",
      at: at(22),
    });
    expect(ledger.mailStatus("ada")).toBe("none");
  });

  test("one recipient's mail never appears in another's status", () => {
    const ledger = rig();
    publish(ledger, { recipient: "ada", itemId: "mit_ada" });
    expect(ledger.mailStatus("bo")).toBeNull();
    expect(ledger.sloBreaches("bo", at(3_600))).toHaveLength(0);
  });
});

describe("edges", () => {
  test("backoff stops lengthening at the cap", () => {
    const ledger = rig();
    woken(ledger);
    const waits: number[] = [];
    for (let attempt = 1; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      const now = at(attempt * 10_000);
      ledger.recordWakeIgnored("mit_one", now);
      const schedule = ledger.nextWake("ada", { turnActive: false, now });
      if (schedule.kind !== "wait") continue;
      waits.push((Date.parse(schedule.readyAt) - Date.parse(now)) / 1_000);
    }
    expect(waits.every((wait) => wait <= MAIL_WAKE_BACKOFF_MAX_SECONDS)).toBe(
      true,
    );
  });

  test("a dead-lettered item stops breaching instead of alerting forever", () => {
    const ledger = rig();
    woken(ledger);
    for (let attempt = 0; attempt < MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
      ledger.recordWakeIgnored("mit_one", at(attempt * 1_000));
    }
    expect(ledger.deliveryState("mit_one")).toBe("dead_lettered");
    // A visible terminal failure is reported once by its own state; repeating
    // it as an SLO breach every sweep would bury the breaches that are still
    // actionable.
    expect(ledger.sloBreaches("ada", at(99_999))).toHaveLength(0);
    expect(ledger.mailStatus("ada")).toBe("dead_lettered");
  });

  test("a transition in the same millisecond measures zero, not nothing", () => {
    const ledger = rig();
    publish(ledger);
    ledger.recordPresented({
      itemId: "mit_one",
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: at(0),
    });
    ledger.recordClaimed({
      itemId: "mit_one",
      recipient: "ada",
      handlerId: "ada-1",
      at: at(0),
    });
    expect(ledger.latency("mit_one")?.claimedMs).toBe(0);
  });

  test("resuming past the end of the log replays nothing", () => {
    const ledger = rig();
    publish(ledger);
    expect(
      ledger.subscribe("ada", {
        kind: "mail-subscribe",
        schemaVersion: 1,
        recipient: "ada",
        sinceCursor: 9_999,
      }),
    ).toEqual([]);
  });

  test("acknowledging an unknown notification is refused", () => {
    const ledger = rig();
    expect(() =>
      ledger.acknowledge("ada", {
        recipient: "ada",
        cursor: 1,
        brokerSeq: 1,
        at: at(0),
      }),
    ).toThrow("does not match a retained mail-ready event");
    expect(ledger.mailStatus("ada")).toBeNull();
  });

  test("a second item is woken independently of the first", () => {
    const ledger = rig();
    const first = woken(ledger, { itemId: "mit_one", brokerSeq: 1 });
    const second = woken(ledger, {
      itemId: "mit_two",
      brokerSeq: 2,
      second: 10,
    });
    expect(second.wakeId).not.toBe(first.wakeId);
    ledger.recordWakeIgnored("mit_one", at(20));
    // Retrying one message must not push the other's attempt count, or a
    // stubborn message would dead-letter the ones queued behind it.
    const schedule = ledger.nextWake("ada", { turnActive: false, now: at(21) });
    expect(schedule).toMatchObject({ kind: "submit" });
    expect(schedule.kind === "submit" && schedule.wake.oldestItemId).toBe(
      "mit_two",
    );
    expect(schedule.kind === "submit" && schedule.wake.attempts).toBe(0);
  });
});
