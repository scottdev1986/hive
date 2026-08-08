import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
  harness.driver.modelIds = ["default", "opus", "sonnet", "haiku"];
});

afterEach(async () => {
  await harness.close();
});

async function settle(): Promise<void> {
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
}

describe("/model switches the session's model", () => {
  test("bare /model opens the vendor catalog as a picker", async () => {
    await harness.testRenderer.mockInput.typeText("/model");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("opus");
    expect(frame).toContain("sonnet");
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);

    harness.testRenderer.mockInput.pressArrow("down");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.modelSwitches).toEqual([
      { vendorSessionId: "fake-session-1", model: "opus" },
    ]);
    expect(harness.ui.snapshot().view.modelPicker).toBeNull();
    expect(harness.driver.submissions).toEqual([]);
  });

  test("Option-P opens the same provider model picker", async () => {
    harness.testRenderer.mockInput.pressKey("p", { meta: true });
    await settle();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("Select model");
    expect(frame).toContain("1/4");
    expect(harness.ui.snapshot().draft).toBe("");
  });

  test("/model with an argument switches without a picker", async () => {
    await harness.testRenderer.mockInput.typeText("/model haiku");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.modelSwitches).toEqual([
      { vendorSessionId: "fake-session-1", model: "haiku" },
    ]);
    expect(harness.ui.snapshot().view.modelPicker).toBeNull();
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);
  });

  test("the picker shows provider metadata and selects reasoning effort", async () => {
    harness.driver.models = [
      {
        id: "kimi-k2",
        displayName: "Kimi K2",
        description: "Fast everyday coding",
        isDefault: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
      {
        id: "kimi-k3",
        displayName: "Kimi K3",
        description: "Best for difficult repository work",
        isDefault: false,
        supportedReasoningEfforts: [
          { id: "low", description: "Faster answers" },
          { id: "high", description: "Deeper reasoning" },
        ],
        defaultReasoningEffort: "high",
      },
    ];
    await harness.testRenderer.mockInput.typeText("/model");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    let frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("Select model");
    expect(frame).toContain("Kimi K3");
    expect(frame).toContain("Best for difficult repository work");

    harness.testRenderer.mockInput.pressArrow("down");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("reasoning effort");
    expect(frame).toContain("Deeper reasoning");

    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.driver.modelSwitches).toEqual([
      {
        vendorSessionId: "fake-session-1",
        model: "kimi-k3",
        effort: "high",
      },
    ]);
  });

  test("typing filters a long model catalog without editing the composer", async () => {
    harness.driver.models = [
      {
        id: "quality",
        displayName: "Quality",
        description: null,
        isDefault: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
      {
        id: "fast",
        displayName: "Fast",
        description: "Low-latency model",
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
    ];
    await harness.testRenderer.mockInput.typeText("/model");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    await harness.testRenderer.mockInput.typeText("fast");
    await settle();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("Search: fast");
    expect(frame).toContain("Low-latency model");
    expect(frame).not.toContain("Quality");
    expect(harness.ui.snapshot().draft).toBe("");
  });

  test("escape closes the picker without switching or interrupting", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("/model");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.ui.snapshot().view.modelPicker).not.toBeNull();

    harness.testRenderer.mockInput.pressEscape();
    await Bun.sleep(30);
    await settle();

    expect(harness.ui.snapshot().view.modelPicker).toBeNull();
    expect(harness.driver.modelSwitches).toEqual([]);
    expect(harness.driver.cancelledTurns).toEqual([]);
  });

  test("an empty catalog reports instead of opening an empty picker", async () => {
    harness.driver.modelIds = [];
    await harness.testRenderer.mockInput.typeText("/model");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.ui.snapshot().view.modelPicker).toBeNull();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "reports no model catalog",
    );
  });
});

describe("commands with protocol backing run as calls, not prompts", () => {
  test("a routed command triggers the vendor call and no submission", async () => {
    harness.driver.commandRoutes.add("compact");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact the thread" },
    ]);
    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.ranCommands).toEqual(["compact"]);
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);
  });

  test("a routed command receives its argument text without becoming a prompt", async () => {
    harness.driver.commandRoutes.add("review");
    harness.ui.replaceCommandCatalog([
      { name: "review", description: "Review changes" },
    ]);

    await harness.testRenderer.mockInput.typeText(
      "/review focus on authorization",
    );
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.ranCommandInputs).toEqual([
      {
        vendorSessionId: "fake-session-1",
        name: "review",
        arguments: "focus on authorization",
      },
    ]);
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);
  });

  test("an unrouted command still reaches the vendor as prompt text", async () => {
    harness.ui.replaceCommandCatalog([
      { name: "context", description: "Show context usage" },
    ]);
    await harness.testRenderer.mockInput.typeText("/context");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.ranCommands).toEqual([]);
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "/context",
    ]);
  });
});
