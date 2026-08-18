import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentUiHarness,
  createAgentUiHarness,
} from "./agent-ui-harness";

let harness: AgentUiHarness;

beforeEach(async () => {
  // Create harness without daemon port to test fail-soft
  harness = await createAgentUiHarness();
});

afterEach(async () => {
  await harness.close();
});

const notice = (
  wakeId: string,
  oldestItemId: string,
  lane: "control" | "work",
  backlogCount: number,
) => ({
  wakeId,
  recipient: "maya",
  lane,
  oldestItemId,
  backlogCount,
  cursor: 1,
  brokerSeq: 1,
});

/**
 * When daemonPort is missing or /wake-payload fails, the frontend still
 * injects lane + backlogCount from the MailReadyNotice. Only memory drops.
 * The fail-soft text must not contain oldestItemId or wakeId.
 */
describe("wake fail-soft (no daemon or /wake-payload failure)", () => {
  test("no daemonPort → submit text has lane + backlogCount, no oldestItemId", async () => {
    await harness.ui.onMailReady(notice("w1", "item-abc-123", "control", 3));

    // Wait for the wake to be dispatched
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The driver records all submitted text
    const submissions = harness.driver.submissions;
    expect(submissions.length).toBeGreaterThan(0);

    const wakeSubmission = submissions.find((s) =>
      s.text.includes("Hive mail wake"),
    );
    expect(wakeSubmission).toBeDefined();

    if (wakeSubmission) {
      // Should have lane and backlogCount
      expect(wakeSubmission.text).toContain("control lane");
      expect(wakeSubmission.text).toContain("3 available");

      // Should NOT have oldestItemId or wakeId
      expect(wakeSubmission.text).not.toContain("item-abc-123");
      expect(wakeSubmission.text).not.toContain("w1");
      expect(wakeSubmission.text).not.toContain("oldestItemId");
      expect(wakeSubmission.text).not.toContain("wakeId");

      // Should have poll instruction
      expect(wakeSubmission.text).toContain("hive_mail_poll");

      // Should NOT have memory section (fail-soft drops memory)
      expect(wakeSubmission.text).not.toContain("Recent wiki");
      expect(wakeSubmission.text).not.toContain("Memory");
    }
  });

  test("work lane fail-soft shows work count only", async () => {
    await harness.ui.onMailReady(notice("w2", "item-xyz-456", "work", 5));

    // Wait for the wake to be dispatched
    await new Promise((resolve) => setTimeout(resolve, 100));

    const submissions = harness.driver.submissions;
    const wakeSubmission = submissions.find((s) =>
      s.text.includes("Hive mail wake"),
    );

    if (wakeSubmission) {
      expect(wakeSubmission.text).toContain("work lane");
      expect(wakeSubmission.text).toContain("5 available");
      expect(wakeSubmission.text).not.toContain("item-xyz-456");
      expect(wakeSubmission.text).not.toContain("w2");
    }
  });

  test("fail-soft does not include mail body", async () => {
    // Even though the notice might reference a mail item with a body,
    // the fail-soft prompt should never include that body
    await harness.ui.onMailReady(
      notice("w3", "item-with-secret-body", "control", 1),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const submissions = harness.driver.submissions;
    const wakeSubmission = submissions.find((s) =>
      s.text.includes("Hive mail wake"),
    );

    if (wakeSubmission) {
      // Should not contain any mail body text
      expect(wakeSubmission.text).not.toContain("secret");
      expect(wakeSubmission.text).not.toContain("body");
    }
  });
});
