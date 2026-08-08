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
}

async function pressEscape(): Promise<void> {
  harness.testRenderer.mockInput.pressEscape();
  await Bun.sleep(30);
  await settle();
}

describe("OpenTUI owns Agent UI input", () => {
  test("typing, movement, and deletion edit the focused textarea", async () => {
    await harness.testRenderer.mockInput.typeText("hi there");
    harness.testRenderer.mockInput.pressArrow("left");
    harness.testRenderer.mockInput.pressBackspace();
    await settle();

    expect(harness.ui.snapshot().draft).toBe("hi thee");
    expect(harness.testRenderer.renderer.currentFocusedRenderable?.id).toBe(
      "agent-ui-input",
    );
  });

  test("bracketed paste inserts a multiline payload without submitting it", async () => {
    await harness.testRenderer.mockInput.pasteBracketedText(
      "line one\nline two",
    );
    await settle();

    expect(harness.ui.snapshot().draft).toBe("line one\nline two");
    expect(harness.driver.submissions).toEqual([]);
  });

  test("Enter persists, clears, and submits the draft", async () => {
    await harness.testRenderer.mockInput.typeText("refactor the parser");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.ui.snapshot().draft).toBe("");
    expect(harness.journal.all()[0]?.text).toBe("refactor the parser");
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "refactor the parser",
    ]);
  });

  test("Up and Down browse submitted messages from an empty draft", async () => {
    await harness.testRenderer.mockInput.typeText("first message");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("second message");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    harness.testRenderer.mockInput.pressArrow("up");
    await settle();
    expect(harness.ui.snapshot().draft).toBe("second message");

    harness.testRenderer.mockInput.pressArrow("up");
    await settle();
    expect(harness.ui.snapshot().draft).toBe("first message");

    harness.testRenderer.mockInput.pressArrow("down");
    await settle();
    expect(harness.ui.snapshot().draft).toBe("second message");

    harness.testRenderer.mockInput.pressArrow("down");
    await settle();
    expect(harness.ui.snapshot().draft).toBe("");
  });

  test("Up remains textarea cursor movement while editing a draft", async () => {
    await harness.testRenderer.mockInput.typeText("submitted message");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    await harness.testRenderer.mockInput.typeText("line one");
    harness.testRenderer.mockInput.pressEnter({ shift: true });
    await harness.testRenderer.mockInput.typeText("line two");

    harness.testRenderer.mockInput.pressArrow("up");
    await settle();

    expect(harness.ui.snapshot().draft).toBe("line one\nline two");
  });

  test("Shift-Enter inserts a newline", async () => {
    await harness.testRenderer.mockInput.typeText("first");
    harness.testRenderer.mockInput.pressEnter({ shift: true });
    await harness.testRenderer.mockInput.typeText("second");
    await settle();

    expect(harness.ui.snapshot().draft).toBe("first\nsecond");
    expect(harness.driver.submissions).toEqual([]);
  });

  test("Ctrl-J inserts a newline instead of submitting", async () => {
    await harness.testRenderer.mockInput.typeText("first");
    await harness.testRenderer.mockInput.pressKeys(["LINEFEED"]);
    await harness.testRenderer.mockInput.typeText("second");
    await settle();

    expect(harness.ui.snapshot().draft).toBe("first\nsecond");
    expect(harness.driver.submissions).toEqual([]);
  });

  test("the input is two rows high and exposes OpenTUI's cursor", async () => {
    await harness.testRenderer.mockInput.typeText("abcd");
    await settle();

    const input =
      harness.testRenderer.renderer.root.findDescendantById("agent-ui-input");
    expect(input?.height).toBe(2);
    expect(harness.testRenderer.captureSpans().cursor).not.toEqual([-1, -1]);
  });
});

describe("slash commands and contextual keys", () => {
  test("the menu filters the provider catalog and keeps fixed columns", async () => {
    const longCommand = "a-command-name-that-is-far-too-long-to-fit";
    harness.ui.replaceCommandCatalog([
      { name: "short", description: "Short command" },
      { name: longCommand, description: "Long command" },
      { name: "status", description: "Show session status" },
    ]);
    await harness.testRenderer.mockInput.typeText("/");
    await settle();

    const frame = harness.testRenderer.captureCharFrame();
    const short = frame
      .split("\n")
      .find((line) => line.includes("Short command"));
    const long = frame
      .split("\n")
      .find((line) => line.includes("Long command"));
    if (short === undefined || long === undefined)
      throw new Error("menu missing");
    expect(short.indexOf("Short command") - short.indexOf("/short")).toBe(33);
    expect(long.indexOf("Long command")).toBe(short.indexOf("Short command"));
    expect(frame).not.toContain(`/${longCommand}`);
    expect(frame).toContain("…");
    expect(frame).toContain("/quit");
    expect(frame).toContain("/exit");

    await harness.testRenderer.mockInput.typeText("sta");
    await settle();
    const filtered = harness.testRenderer.captureCharFrame();
    expect(filtered).toContain("/status");
    expect(filtered).not.toContain("/short");
  });

  test("arrows select and the first Enter completes before the second submits", async () => {
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact the conversation" },
      { name: "status", description: "Show session status" },
    ]);
    await harness.testRenderer.mockInput.typeText("/");
    harness.testRenderer.mockInput.pressArrow("down");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.ui.snapshot().draft).toBe("/status");
    expect(harness.driver.submissions).toEqual([]);

    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "/status",
    ]);
  });

  test("Escape closes the command menu before interrupting the turn", async () => {
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("/");
    await pressEscape();

    expect(harness.driver.cancelledTurns).toEqual([]);
    expect(harness.testRenderer.captureCharFrame()).not.toContain(
      "Compact context",
    );

    await pressEscape();
    expect(harness.driver.cancelledTurns).toEqual(["t1"]);
  });

  test("Escape interrupts without losing an unsent user draft", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("do this next");
    await settle();
    await harness.ui.onMailReady({
      wakeId: "w1",
      recipient: "maya",
      lane: "control",
      oldestItemId: "m1",
      backlogCount: 1,
      cursor: 1,
      brokerSeq: 1,
    });

    expect(harness.driver.cancelledTurns).toEqual([]);
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.ui.snapshot().draft).toBe("do this next");

    await pressEscape();
    expect(harness.driver.cancelledTurns).toEqual(["t1"]);

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "interrupted", turnId: "t1" }),
    );
    await harness.ui.pump();

    // Still composing: interrupt does not submit or clear the draft.
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.ui.snapshot().draft).toBe("do this next");

    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "do this next",
    ]);
  });

  test("Enter mid-turn queues the draft and clears the composer", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("do this next");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.submissions).toEqual([]);
    expect(harness.ui.snapshot().draft).toBe("");
    expect(harness.journal.all().map((row) => row.text)).toEqual([
      "do this next",
    ]);

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "interrupted", turnId: "t1" }),
    );
    await harness.ui.pump();

    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "do this next",
    ]);
  });

  test("Cmd-C with a selection copies when the terminal forwards it", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "words a mac user copies with the command key",
      }),
    );
    await settle();
    await Bun.sleep(60);
    await settle();
    const row = harness.testRenderer
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("mac user copies"));
    expect(row).toBeGreaterThan(-1);
    await harness.testRenderer.mockMouse.drag(6, row, 30, row);
    await settle();

    const copied: string[] = [];
    harness.testRenderer.renderer.copyToClipboardOSC52 = (text: string) => {
      copied.push(text);
      return true;
    };
    harness.testRenderer.mockInput.pressKey("c", { super: true });
    await settle();

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("mac user copies");
    expect(harness.driver.cancelledTurns).toEqual([]);
  });

  test("Ctrl-C with a selection copies — a refused clipboard never interrupts", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "some words worth copying out of the pane",
      }),
    );
    await settle();
    await Bun.sleep(60);
    await settle();
    const frame = harness.testRenderer.captureCharFrame();
    const row = frame
      .split("\n")
      .findIndex((line) => line.includes("worth copying"));
    expect(row).toBeGreaterThan(-1);
    await harness.testRenderer.mockMouse.drag(6, row, 30, row);
    await settle();
    expect(
      harness.testRenderer.renderer.getSelection()?.getSelectedText() ?? "",
    ).not.toBe("");

    // The terminal refusing OSC 52 must surface as a diagnostic, not as an
    // interrupt of the active turn.
    harness.testRenderer.renderer.copyToClipboardOSC52 = () => false;
    harness.testRenderer.mockInput.pressCtrlC();
    await settle();

    expect(harness.driver.cancelledTurns).toEqual([]);
    expect(harness.testRenderer.captureCharFrame()).toContain("copy failed");
  });

  test("Ctrl-C interrupts an active turn without clearing the draft", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    await harness.testRenderer.mockInput.typeText("keep this draft");
    harness.testRenderer.mockInput.pressCtrlC();
    await settle();

    expect(harness.driver.cancelledTurns).toEqual(["t1"]);
    expect(harness.ui.snapshot().draft).toBe("keep this draft");
  });

  test("a nonempty Enter queues text instead of answering an approval", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "approval-waiting",
        requestId: "allow-1",
        turnId: "t1",
        toolName: "bash",
        summary: "run tests",
      }),
    );
    await harness.testRenderer.mockInput.typeText("keep this draft");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    // Enter never means allow when the composer has text.
    expect(harness.driver.permissionDecisions).toEqual([]);
    expect(harness.ui.snapshot().draft).toBe("");
    expect(harness.journal.all().map((row) => row.text)).toEqual([
      "keep this draft",
    ]);
    // Still mid-turn: the prompt is journaled and waiting, not sent yet.
    expect(harness.driver.submissions).toEqual([]);
  });

  test("an empty Enter explicitly approves, while Escape interrupts", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "turn-started",
        turnId: "t1",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "approval-waiting",
        requestId: "allow-1",
        turnId: "t1",
        toolName: "bash",
        summary: "run tests",
      }),
    );
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.driver.permissionDecisions).toEqual([
      { requestId: "allow-1", outcome: "allow" },
    ]);

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "approval-waiting",
        requestId: "pending-2",
        turnId: "t1",
        toolName: "bash",
        summary: "delete files",
      }),
    );
    await pressEscape();
    expect(harness.driver.cancelledTurns).toEqual(["t1"]);
    expect(harness.driver.permissionDecisions).toHaveLength(1);
  });

  test.each(["/quit", "/exit"])(
    "%s closes the provider without submitting a prompt",
    async (command) => {
      await harness.testRenderer.mockInput.typeText(command);
      harness.testRenderer.mockInput.pressEnter();
      await settle();

      expect(harness.driver.closed).toBe(true);
      expect(harness.driver.submissions).toEqual([]);
      expect(harness.journal.all()).toEqual([]);
    },
  );

  test("Ctrl-D exits from an empty composer", async () => {
    harness.testRenderer.mockInput.pressKey("d", { ctrl: true });
    await settle();

    expect(harness.driver.closed).toBe(true);
    expect(harness.driver.submissions).toEqual([]);
  });
});
