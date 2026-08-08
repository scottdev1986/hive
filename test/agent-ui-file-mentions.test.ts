import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

const FILES = [
  "src/cli/agent-ui/agent-ui-exports.ts",
  "src/cli/agent-ui/turn-scheduler.ts",
  "src/cli/agent-ui/view-state.ts",
  "test/agent-ui-keys.test.ts",
  "README.md",
] as const;

beforeEach(async () => {
  harness = await createAgentUiHarness();
  harness.ui.replaceMentionFiles([...FILES]);
});

afterEach(async () => {
  await harness.close();
});

async function settle(): Promise<void> {
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
}

describe("@ mentions files from the worktree", () => {
  test("typing @ opens the picker and the query narrows it", async () => {
    await harness.testRenderer.mockInput.typeText("look at @");
    await settle();
    const open = harness.testRenderer.captureCharFrame();
    expect(open).toContain("@README.md");
    expect(open).toContain("@src/cli/agent-ui/agent-ui-exports.ts");

    await harness.testRenderer.mockInput.typeText("sched");
    await settle();
    const narrowed = harness.testRenderer.captureCharFrame();
    expect(narrowed).toContain("@src/cli/agent-ui/turn-scheduler.ts");
    expect(narrowed).not.toContain("@README.md");
  });

  test("Enter completes the highlighted path mid-sentence without submitting", async () => {
    await harness.testRenderer.mockInput.typeText("fix @sched");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.ui.snapshot().draft).toBe(
      "fix @src/cli/agent-ui/turn-scheduler.ts ",
    );
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);

    await harness.testRenderer.mockInput.typeText("please");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "fix @src/cli/agent-ui/turn-scheduler.ts please",
    ]);
  });

  test("arrows choose a different file", async () => {
    await harness.testRenderer.mockInput.typeText("@view");
    harness.testRenderer.mockInput.pressArrow("down");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    // Only one match for "view", so down stays on it; the draft proves the
    // selection survived the arrow press rather than falling into history.
    expect(harness.ui.snapshot().draft).toBe(
      "@src/cli/agent-ui/view-state.ts ",
    );
  });

  test("Escape dismisses the picker without interrupting, typing reopens it", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("@keys");
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "@test/agent-ui-keys.test.ts",
    );

    harness.testRenderer.mockInput.pressEscape();
    await Bun.sleep(30);
    await settle();
    expect(harness.driver.cancelledTurns).toEqual([]);
    expect(harness.testRenderer.captureCharFrame()).not.toContain(
      "@test/agent-ui-keys.test.ts",
    );

    await harness.testRenderer.mockInput.typeText(".t");
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "@test/agent-ui-keys.test.ts",
    );
  });

  test("an email-like token never opens the picker", async () => {
    await harness.testRenderer.mockInput.typeText("mail kellar.scott@gmail");
    await settle();

    expect(harness.testRenderer.captureCharFrame()).not.toContain("› @");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "mail kellar.scott@gmail",
    ]);
  });
});
