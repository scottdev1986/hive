import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";
import { MAIL_WAKE_MAX_ATTEMPTS } from "../src/schemas/mail-wake";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
});

afterEach(async () => {
  await harness.close();
});

const notice = (wakeId: string, oldestItemId: string) => ({
  wakeId,
  recipient: "maya",
  lane: "control" as const,
  oldestItemId,
  backlogCount: 1,
  cursor: 1,
  brokerSeq: 1,
});

/**
 * The daemon can see that it announced mail and later that the mailbox was
 * polled. Everything between those two points is a decision only the frontend
 * observes, and without it a wake that named a settled item cannot be told
 * apart from one held across a turn.
 */
describe("the frontend reports what it did with a wake", () => {
  test("a burst queues wake reports in notice order before dispatch", async () => {
    await harness.ui.onMailReadyBatch([
      notice("w1", "mit_one"),
      { ...notice("w2", "mit_two"), brokerSeq: 2, cursor: 2 },
    ]);

    expect(
      harness.reportedWakes
        .filter((report) => report.kind === "wake-queued")
        .map((report) => report.wakeId),
    ).toEqual(["w1", "w2"]);
    expect(harness.reportedWakes.at(2)?.kind).toBe("wake-request-accepted");
  });

  test("a delivered wake reports queued, accepted, then the turn that proves it", async () => {
    await harness.ui.onMailReady(notice("w1", "mit_one"));
    const accepted = harness.reportedWakes.find(
      (report) => report.kind === "wake-request-accepted",
    );
    if (accepted?.kind !== "wake-request-accepted") {
      throw new Error("expected an acceptance report");
    }
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "turn-started",
        turnId: "t1",
        clientInputId: accepted.clientInputId,
      }),
    );
    // Production drains reports on the next pump, so the test does too.
    await harness.ui.pump();

    expect(harness.reportedWakes.map((report) => report.kind)).toEqual([
      "wake-queued",
      "wake-request-accepted",
      "wake-turn-observed",
    ]);
  });

  test("the turn report carries the evidence the ledger refuses to infer", async () => {
    await harness.ui.onMailReady(notice("w1", "mit_one"));
    const accepted = harness.reportedWakes.find(
      (report) => report.kind === "wake-request-accepted",
    );
    if (accepted?.kind !== "wake-request-accepted") {
      throw new Error("expected an acceptance report");
    }
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "turn-started",
        turnId: "t1",
        clientInputId: accepted.clientInputId,
      }),
    );
    await harness.ui.pump();

    const observed = harness.reportedWakes.at(-1);
    if (observed?.kind !== "wake-turn-observed") {
      throw new Error("expected a turn-observed report");
    }
    expect(observed.turnId).toBe("t1");
    expect(observed.turnClientInputId).toBe(accepted.clientInputId);
    expect(observed.eventSequence).toBeGreaterThan(0);
    // The ledger rejects a turn identified by the submission key, because that
    // is the acknowledgement wearing a lifecycle event's name.
    expect(observed.turnId).not.toBe(observed.clientInputId);
  });

  test("a turn nobody correlated closes no wake", async () => {
    await harness.ui.onMailReady(notice("w1", "mit_one"));
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );

    expect(
      harness.reportedWakes.some(
        (report) => report.kind === "wake-turn-observed",
      ),
    ).toBe(false);
  });

  test("a rejected submission reports the wake as failed", async () => {
    harness.driver.submitOutcome = "rejected";
    await harness.ui.onMailReady(notice("w1", "mit_one"));

    expect(harness.reportedWakes.map((report) => report.kind)).toEqual([
      "wake-queued",
      "wake-failed",
    ]);
  });

  /**
   * A refused notice opens no wake row, so reporting one would leave the ledger
   * holding a wake queued for a submission this frontend already declined.
   */
  test("a notice refused on spent attempts opens no wake row", async () => {
    harness.driver.submitOutcome = "rejected";
    for (let attempt = 0; attempt < MAIL_WAKE_MAX_ATTEMPTS + 3; attempt += 1) {
      await harness.ui.onMailReady(notice("w1", "mit_one"));
    }

    expect(
      harness.reportedWakes.filter((report) => report.kind === "wake-queued"),
    ).toHaveLength(MAIL_WAKE_MAX_ATTEMPTS);
  });
});
