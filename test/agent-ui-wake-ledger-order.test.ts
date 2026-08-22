import { describe, expect, test } from "bun:test";
import { MailWakeReporter } from "../src/cli/agent-ui/mail-wake-reporter";
import { deliverMailReadyNotices } from "../src/cli/agent-ui/run";
import { HiveDatabase } from "../src/daemon/database/hive-database";
import { MailWakeLedger } from "../src/mail-service/wake-ledger";
import { MailWakeStore } from "../src/mail-service/wake-store";
import { isString } from "../src/shared/is-record";
import {
  deriveWakeId,
  type FrontendWakeReport,
} from "../src/schemas/mail-wake";
import { errorMessage } from "../src/shared/error-message";
import { createAgentUiHarness } from "./agent-ui-harness";

const ITEM_ID = "mit_one";
const WAKE_ID = deriveWakeId("maya", "control", ITEM_ID);
const NOTICE = {
  wakeId: WAKE_ID,
  recipient: "maya",
  lane: "control" as const,
  oldestItemId: ITEM_ID,
  backlogCount: 1,
  cursor: 1,
  brokerSeq: 7,
};

function reportBody(init?: RequestInit): FrontendWakeReport {
  if (!isString(init?.body)) throw new Error("missing report body");
  // SAFETY: The test owns this value and its fields.
  return JSON.parse(init.body) as FrontendWakeReport;
}

describe("the frontend and wake ledger keep one ordered evidence chain", () => {
  test("the reporter retries a transport failure", async () => {
    let calls = 0;
    const reporter = new MailWakeReporter({
      port: 8_888,
      subject: "maya",
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket closed");
        return new Response(null, { status: 204 });
      },
    });
    await reporter.report({
      kind: "wake-queued",
      schemaVersion: 1,
      wakeId: "wake",
      recipient: "maya",
      lane: "control",
      oldestItemId: ITEM_ID,
      at: "2026-08-05T11:37:39.469Z",
    });
    expect(calls).toBe(2);
  });
  test("a lost acceptance response is recovered before its turn is reported", async () => {
    const ledger = new MailWakeLedger(
      new MailWakeStore(new HiveDatabase(":memory:")),
    );
    ledger.publishReady({
      recipient: "maya",
      lane: "control",
      oldestItemId: ITEM_ID,
      backlogCount: 1,
      brokerSeq: 7,
      publishedItemId: ITEM_ID,
      at: "2026-08-05T11:37:39.469Z",
    });

    let loseFirstAcceptance = true;
    const reporter = new MailWakeReporter({
      port: 8_888,
      subject: "maya",
      fetch: async (_input, init) => {
        const report = reportBody(init);
        if (report.kind === "wake-request-accepted" && loseFirstAcceptance) {
          loseFirstAcceptance = false;
          throw new Error("The socket connection was closed unexpectedly.");
        }
        try {
          ledger.acceptWakeReport("maya", report);
          return new Response(null, { status: 204 });
        } catch (error) {
          return new Response(
            JSON.stringify({
              error: errorMessage(error),
            }),
            { status: 500 },
          );
        }
      },
    });
    const harness = await createAgentUiHarness({
      reportWake: (report) => reporter.report(report),
    });

    try {
      await deliverMailReadyNotices([NOTICE], harness.ui, {
        acknowledge: async (notice) => {
          ledger.acknowledge("maya", {
            recipient: "maya",
            cursor: notice.cursor,
            brokerSeq: notice.brokerSeq,
            at: "2026-08-05T11:37:39.470Z",
          });
        },
      });
      const submission = harness.driver.submissions[0];
      if (submission === undefined) throw new Error("wake was not dispatched");

      harness.ui.onProviderEvent(
        harness.driver.emit({
          kind: "turn-started",
          turnId: "turn-one",
          clientInputId: submission.clientInputId,
        }),
      );
      await harness.ui.pump();

      expect(ledger.deliveryChain(ITEM_ID).map((row) => row.state)).toEqual([
        "published",
        "frontend_notified",
        "wake_queued",
        "vendor_request_accepted",
        "turn_observed",
      ]);
      expect(harness.reportedWakes.map((report) => report.kind)).toEqual([
        "wake-queued",
        "wake-request-accepted",
        "wake-turn-observed",
      ]);
    } finally {
      await harness.close();
    }
  });
});
