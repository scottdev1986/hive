import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatWakePrompt } from "../src/cli/agent-ui/wake-prompt";
import { PaneDaemonClient } from "../src/cli/agent-ui/pane-daemon-client";
import type { WakePayload } from "../src/schemas/wake-payload";
import {
  type AgentUiHarness,
  type AgentUiHarnessOptions,
  createAgentUiHarness,
} from "./agent-ui-harness";

let harness: AgentUiHarness;

afterEach(async () => {
  if (harness) await harness.close();
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
    harness = await createAgentUiHarness();
    await harness.ui.onMailReady(notice("w1", "item-abc-123", "control", 3));

    const submissions = harness.driver.submissions;
    expect(submissions.length).toBeGreaterThan(0);

    const wakeSubmission = submissions.find((s) =>
      s.text.includes("Hive mail wake"),
    );
    expect(wakeSubmission).toBeDefined();

    // Should have lane and backlogCount
    expect(wakeSubmission!.text).toContain("control lane");
    expect(wakeSubmission!.text).toContain("3 available");

    // Should NOT have oldestItemId or wakeId
    expect(wakeSubmission!.text).not.toContain("item-abc-123");
    expect(wakeSubmission!.text).not.toContain("w1");
    expect(wakeSubmission!.text).not.toContain("oldestItemId");
    expect(wakeSubmission!.text).not.toContain("wakeId");

    // Should have poll instruction
    expect(wakeSubmission!.text).toContain("hive_mail_poll");

    // Should NOT have memory section (fail-soft drops memory)
    expect(wakeSubmission!.text).not.toContain("Recent wiki");
    expect(wakeSubmission!.text).not.toContain("Memory");
  });

  test("daemon 5xx fail-soft → same fail-soft prompt", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ error: "internal" }), { status: 500 });

    const paneClient = new PaneDaemonClient({
      port: 4483,
      subject: "maya",
      fetch: fakeFetch,
      retries: 0,
    });

    const options: AgentUiHarnessOptions = { paneClient };
    harness = await createAgentUiHarness(options);
    await harness.ui.onMailReady(notice("w2", "item-xyz-456", "work", 5));

    const submissions = harness.driver.submissions;
    const wakeSubmission = submissions.find((s) =>
      s.text.includes("Hive mail wake"),
    );
    expect(wakeSubmission).toBeDefined();

    // Same fail-soft assertions: lane + backlogCount, no oldestItemId
    expect(wakeSubmission!.text).toContain("work lane");
    expect(wakeSubmission!.text).toContain("5 available");
    expect(wakeSubmission!.text).not.toContain("item-xyz-456");
    expect(wakeSubmission!.text).not.toContain("w2");
    expect(wakeSubmission!.text).toContain("hive_mail_poll");
    expect(wakeSubmission!.text).not.toContain("Recent wiki");
  });

  test("success path → formatWakePrompt output with counts and memory", async () => {
    const payload: WakePayload = {
      wakeId: "w3",
      oldestItemId: "item-success",
      lane: "control",
      mailCounts: {
        controlAvailable: 2,
        workAvailable: 1,
      },
      memoryDelta: {
        state: "ok",
        semantic: "disabled",
        pitfalls: [],
        articles: [
          {
            scope: "repo",
            topic: "test",
            id: "article-1",
            date: "2026-08-01",
            title: "Test article",
            snippet: "A test article snippet",
            status: "verified",
            flag: null,
            pitfall: false,
          },
        ],
        tokens: 50,
        budget: 300,
        truncated: false,
        omitted: 0,
        omittedPitfalls: 0,
        omittedArticles: 0,
      },
    };

    const fakeFetch = async () =>
      new Response(JSON.stringify(payload), { status: 200 });

    const paneClient = new PaneDaemonClient({
      port: 4483,
      subject: "maya",
      fetch: fakeFetch,
      retries: 0,
    });

    const options: AgentUiHarnessOptions = { paneClient };
    harness = await createAgentUiHarness(options);
    await harness.ui.onMailReady(notice("w3", "item-success", "control", 2));

    const submissions = harness.driver.submissions;
    const wakeSubmission = submissions.find((s) =>
      s.text.includes("Hive mail wake"),
    );
    expect(wakeSubmission).toBeDefined();

    // Should match formatWakePrompt output
    const expectedText = formatWakePrompt(payload);
    expect(wakeSubmission!.text).toBe(expectedText);

    // Sanity checks on the formatted text
    expect(wakeSubmission!.text).toContain("control lane");
    expect(wakeSubmission!.text).toContain("Control: 2 available");
    expect(wakeSubmission!.text).toContain("Work: 1 available");
    expect(wakeSubmission!.text).toContain("Recent wiki");
    expect(wakeSubmission!.text).toContain("Test article");
    expect(wakeSubmission!.text).not.toContain("item-success"); // No oldestItemId
    expect(wakeSubmission!.text).not.toContain("w3"); // No wakeId
  });
});
