import { describe, expect, test } from "bun:test";
import { renderSession } from "../src/cli/agent-ui/run";
import { WakeReportQueue } from "../src/cli/agent-ui/wake-report-queue";
import { deriveWakeId } from "../src/schemas/mail-wake";
import { createAgentUiHarness } from "./agent-ui-harness";

describe("wake report queue", () => {
  test("a burst runs in order even when an earlier report is pending", async () => {
    const queue = new WakeReportQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await firstPending;
      order.push("first:end");
    });
    const second = queue.enqueue(async () => {
      order.push("second");
    });
    const third = queue.enqueue(async () => {
      order.push("third");
    });
    await Bun.sleep(0);
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  test("a failed report does not strand the reports behind it", async () => {
    const queue = new WakeReportQueue();
    const order: string[] = [];
    const failed = queue.enqueue(async () => {
      order.push("failed");
      throw new Error("refused");
    });
    const recovered = queue.enqueue(async () => {
      order.push("recovered");
    });

    expect(failed).rejects.toThrow("refused");
    await recovered;
    expect(order).toEqual(["failed", "recovered"]);
  });

  test("a pending wake report does not stall provider event rendering", async () => {
    let releaseAccepted: (() => void) | undefined;
    const acceptedPending = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const harness = await createAgentUiHarness({
      reportWake: async (report) => {
        if (report.kind === "wake-request-accepted") await acceptedPending;
      },
    });
    let rendering: Promise<void> | null = null;

    try {
      const itemId = "mit-pending-report";
      const delivery = harness.ui.onMailReady({
        wakeId: deriveWakeId("maya", "control", itemId),
        recipient: "maya",
        lane: "control",
        oldestItemId: itemId,
        backlogCount: 1,
        cursor: 1,
        brokerSeq: 1,
      });
      for (
        let attempts = 0;
        attempts < 20 && harness.driver.submissions.length === 0;
        attempts += 1
      ) {
        await Bun.sleep(1);
      }
      const submission = harness.driver.submissions[0];
      if (submission === undefined) throw new Error("wake was not submitted");

      rendering = renderSession(
        harness.ui,
        harness.driver,
        null,
        () => {},
        () => {},
      );
      harness.driver.emit({
        kind: "turn-started",
        turnId: "turn-1",
        clientInputId: submission.clientInputId,
      });
      harness.driver.emit({
        kind: "tool-started",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "Read",
        detail: "visible while the wake report is pending",
      });
      await Bun.sleep(10);
      await harness.testRenderer.flush();

      expect(harness.testRenderer.captureCharFrame()).toContain(
        "visible while the wake report is pending",
      );
      releaseAccepted?.();
      await delivery;
    } finally {
      releaseAccepted?.();
      await harness.close();
      await rendering;
    }
  });
});
