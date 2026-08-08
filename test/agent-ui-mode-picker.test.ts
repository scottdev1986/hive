import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
  harness.driver.permissionModes = ["default", "plan", "auto", "yolo"];
});

afterEach(async () => {
  await harness.close();
});

async function settle(): Promise<void> {
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
}

describe("/mode switches provider behavior", () => {
  test("bare /mode opens a one-Enter picker and applies the selected mode", async () => {
    await harness.testRenderer.mockInput.typeText("/mode");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("Select mode");
    expect(frame).toContain("default");
    expect(frame).toContain("plan");
    expect(harness.driver.modeSwitches).toEqual([]);

    harness.testRenderer.mockInput.pressArrow("down");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.modeSwitches).toEqual(["plan"]);
    expect(harness.ui.snapshot().view.permissionMode).toBe("plan");
    expect(harness.journal.all()).toEqual([]);
  });

  test("/mode with an argument applies directly", async () => {
    await harness.testRenderer.mockInput.typeText("/mode auto");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.modeSwitches).toEqual(["auto"]);
    expect(harness.ui.snapshot().view.permissionMode).toBe("auto");
  });

  test("Shift-Tab cycles the provider's permission modes", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "config-updated",
        model: null,
        effort: null,
        mode: "default",
      }),
    );
    harness.testRenderer.mockInput.pressTab({ shift: true });
    await settle();

    expect(harness.driver.modeSwitches).toEqual(["plan"]);
    expect(harness.ui.snapshot().view.permissionMode).toBe("plan");
  });

  test("Escape closes the mode picker without interrupting", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("/mode");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    harness.testRenderer.mockInput.pressEscape();
    await settle();

    expect(harness.ui.snapshot().view.modePicker).toBeNull();
    expect(harness.driver.modeSwitches).toEqual([]);
    expect(harness.driver.cancelledTurns).toEqual([]);
  });
});
