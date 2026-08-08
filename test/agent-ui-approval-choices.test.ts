import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
});

afterEach(async () => {
  await harness.close();
});

async function settle(): Promise<void> {
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
  await Bun.sleep(40);
  await harness.testRenderer.flush();
}

/** Claude sends a tool approval with no option list of its own. */
function askApproval(): void {
  harness.ui.onProviderEvent(
    harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
  );
  harness.ui.onProviderEvent(
    harness.driver.emit({
      kind: "approval-waiting",
      requestId: "perm-1",
      turnId: "t1",
      toolName: "Bash",
      summary: "Claude requests Bash",
      detail: "rm -rf build",
      options: [],
    }),
  );
}

describe("an approval the vendor gives no options for is still answerable", () => {
  test("the command and a verdict for each outcome are on screen", async () => {
    askApproval();
    await settle();
    const frame = harness.testRenderer.captureCharFrame();

    expect(frame).toContain("rm -rf build");
    expect(frame).toContain("Yes, once");
    expect(frame).toContain("Yes, and stop asking");
    expect(frame).toContain("No");
  });

  test("Enter allows once", async () => {
    askApproval();
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "perm-1", outcome: "allow" },
    ]);
  });

  test("the second verdict allows for the whole session", async () => {
    askApproval();
    await settle();
    await harness.testRenderer.mockInput.typeText("2");
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "perm-1", outcome: "allow", scope: "session" },
    ]);
  });

  test("the third verdict denies", async () => {
    askApproval();
    await settle();
    await harness.testRenderer.mockInput.typeText("3");
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "perm-1", outcome: "deny" },
    ]);
  });

  test("Hive's verdict ids are never sent to the vendor as option ids", async () => {
    askApproval();
    await settle();
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    for (const decision of harness.driver.permissionDecisions) {
      expect(decision.optionId).toBeUndefined();
    }
  });
});
