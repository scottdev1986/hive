import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";
import type { JsonValue } from "../src/shared/json";
import { unsafeCast } from "../src/shared/unsafe-cast";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
});

afterEach(async () => {
  await harness.close();
});

async function settleRichContent(): Promise<void> {
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
  await Bun.sleep(60);
  await harness.testRenderer.flush();
}

describe("the agent pane reads as a conversation", () => {
  test("a dispatched prompt remains visible above the answer", async () => {
    await harness.testRenderer.mockInput.typeText("Polish the terminal UI");
    harness.testRenderer.mockInput.pressEnter();
    await settleRichContent();
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "The presentation layer is ready.",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await settleRichContent();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("> Polish the terminal UI");
    expect(frame).toContain("The presentation layer is ready.");
    expect(frame.indexOf("Polish the terminal UI")).toBeLessThan(
      frame.indexOf("The presentation layer is ready."),
    );
  });

  test("finished work is compact until ctrl+o opens its details", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "thought-delta",
        turnId: "t1",
        text: "Inspecting the renderer and its layout constraints.",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "edit-1",
        toolName: "apply_patch",
        detail: "Update the renderer",
        toolKind: "edit",
        locations: ["/repo/src/cli/agent-ui/agent-ui-exports.ts"],
        changes: [
          {
            path: "/repo/src/cli/agent-ui/agent-ui-exports.ts",
            oldText: "const dense = true;\n",
            newText: "const dense = false;\n",
          },
        ],
        output: "raw provider payload that should start collapsed",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-finished",
        turnId: "t1",
        toolCallId: "edit-1",
        status: "ok",
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await settleRichContent();

    const compact = harness.testRenderer.captureCharFrame();
    expect(compact).toContain("Worked");
    expect(compact).toContain("Edit");
    expect(compact).toContain("src/cli/agent-ui/agent-ui-exports.ts");
    expect(compact).toContain("+1 −1");
    // The edit's diff shows without a toggle; only thought text and raw
    // payloads wait behind ctrl+o.
    expect(compact).toContain("const dense = true");
    expect(compact).toContain("const dense = false");
    expect(compact).not.toContain("Inspecting the renderer");
    expect(compact).not.toContain("raw provider payload");

    harness.testRenderer.mockInput.pressKey("o", { ctrl: true });
    await settleRichContent();
    const expanded = harness.testRenderer.captureCharFrame();
    expect(expanded).toContain("Inspecting the renderer");
    expect(expanded).toContain("const dense = true");
    expect(expanded).toContain("const dense = false");
    expect(expanded).toContain("raw provider payload");
  });

  test("plan updates replace the prior plan instead of filling the transcript", () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "plan-updated",
        turnId: "t1",
        entries: ["Inspect"],
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "plan-updated",
        turnId: "t1",
        entries: ["Inspect", "Implement", "Verify"],
      }),
    );

    const plans = harness.ui
      .snapshot()
      .view.transcript.filter((entry) => entry.kind === "plan");
    expect(plans).toEqual([
      {
        kind: "plan",
        turnId: "t1",
        entries: ["Inspect", "Implement", "Verify"],
      },
    ]);
  });

  test("clicking a tool row opens the same details as ctrl+o", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "run-1",
        toolName: "exec_command",
        detail: "Run focused tests",
        toolKind: "execute",
        locations: [],
        changes: [],
        output: [
          "detail visible after a click",
          "line 2",
          "line 3",
          "line 4",
          "line 5",
          "line 6",
          "line 7",
          "line 8",
          "line 9",
        ].join("\n"),
      }),
    );
    await settleRichContent();
    const tool = harness.testRenderer.renderer.root.findDescendantById(
      "agent-ui-tool-run-1",
    );
    if (!(tool instanceof Renderable)) throw new Error("tool row missing");
    expect(harness.testRenderer.captureCharFrame()).not.toContain(
      "detail visible after a click",
    );

    await harness.testRenderer.mockMouse.click(tool.screenX + 1, tool.screenY);
    await settleRichContent();

    expect(harness.testRenderer.captureCharFrame()).toContain(
      "detail visible after a click",
    );
  });

  test("a copy drag can start on the margin or a blank line, not only on text", async () => {
    harness.testRenderer.resize(80, 24);
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "first paragraph of the reply\n\nsecond paragraph of the reply",
      }),
    );
    await settleRichContent();
    const lines = harness.testRenderer.captureCharFrame().split("\n");
    const first = lines.findIndex((line) => line.includes("first paragraph"));
    const second = lines.findIndex((line) => line.includes("second paragraph"));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);

    // From the left margin, across both paragraphs.
    await harness.testRenderer.mockMouse.drag(0, first, 40, second);
    await harness.testRenderer.flush();
    expect(
      harness.testRenderer.renderer.getSelection()?.getSelectedText() ?? "",
    ).toContain("first paragraph");

    // From the blank line between them.
    await harness.testRenderer.mockMouse.drag(3, first + 1, 40, second);
    await harness.testRenderer.flush();
    const fromBlank =
      harness.testRenderer.renderer.getSelection()?.getSelectedText() ?? "";
    expect(fromBlank).toContain("second paragraph of the reply");
  });

  test("drag-selecting across a tool row copies text without toggling details", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "run-2",
        toolName: "exec_command",
        detail: "Run the linter",
        toolKind: "execute",
        locations: [],
        changes: [],
        output: "hidden until details open",
      }),
    );
    await settleRichContent();
    const tool = harness.testRenderer.renderer.root.findDescendantById(
      "agent-ui-tool-run-2",
    );
    if (!(tool instanceof Renderable)) throw new Error("tool row missing");

    await harness.testRenderer.mockMouse.drag(
      tool.screenX + 1,
      tool.screenY,
      tool.screenX + 12,
      tool.screenY,
    );
    await settleRichContent();

    const selected =
      harness.testRenderer.renderer.getSelection()?.getSelectedText() ?? "";
    expect(selected).not.toBe("");
    expect(harness.ui.snapshot().view.showToolDetails).toBe(false);
  });
});

describe("the pane chrome stays quiet and responsive", () => {
  test("an 80-column pane shows a banner, one bordered composer, and a footer", async () => {
    harness.testRenderer.resize(80, 24);
    await settleRichContent();
    const frame = harness.testRenderer.captureCharFrame();
    const lines = frame.split("\n");

    expect(frame).toContain("Ask Kimi Code");
    expect(frame).toContain("kimi-k2");
    expect(frame).toContain("Kimi Code");
    expect(frame).not.toContain("AGENT");
    expect(frame).not.toContain("MODEL");
    // The footer keeps the smallest useful discoverability hints.
    expect(frame).toContain("ctrl+o details");
    expect(frame).not.toContain("esc interrupt");
    expect(frame).not.toContain("⏎ send");
    // The composer is the only bordered box while no picker or question is up.
    expect(lines.filter((line) => line.startsWith("╭"))).toHaveLength(1);
    expect(lines.filter((line) => line.trim().startsWith("╭"))).toHaveLength(1);
    // The footer is the last row: live state and shortcuts stay while the
    // provider/model banner scrolls away.
    const footer = frame.trimEnd().split("\n").at(-1) ?? "";
    expect(footer).toContain("connecting");
    expect(footer).toContain("context");
    expect(footer).not.toContain("kimi-k2");
  });

  test("typed text wraps inside the composer border", async () => {
    harness.testRenderer.resize(80, 24);
    await harness.testRenderer.mockInput.typeText("x".repeat(152));
    await settleRichContent();

    const lines = harness.testRenderer.captureCharFrame().split("\n");
    const composerTop = lines.findIndex((line) => line.startsWith("╭"));
    expect(composerTop).not.toBe(-1);
    expect(
      lines
        .slice(composerTop + 1, composerTop + 3)
        .every((line) => line.endsWith("│")),
    ).toBe(true);
  });

  test("an overflowing transcript scrolls without showing a scrollbar", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: Array.from({ length: 120 }, (_, index) => `filler ${index}`).join(
          "\n",
        ),
      }),
    );
    await settleRichContent();

    const transcript = harness.testRenderer.renderer.root.findDescendantById(
      "agent-ui-transcript",
    );
    if (!(transcript instanceof ScrollBoxRenderable)) {
      throw new Error("transcript missing");
    }
    const bar = transcript.verticalScrollBar;
    // The guard is meaningful only if the content genuinely overflows — the
    // bar shows itself on overflow unless manual visibility is latched.
    expect(bar.scrollSize).toBeGreaterThan(bar.viewportSize);
    expect(bar.visible).toBe(false);
  });

  test("a wide markdown table shrinks into the pane instead of flowing off it", async () => {
    harness.testRenderer.resize(80, 34);
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    const table = [
      "Comparison:",
      "",
      "| Vendor | Model identifier | Reasoning effort | Context window | Notes on the current integration state |",
      "| --- | --- | --- | --- | --- |",
      "| Claude Code | claude-opus-5 | xhigh | 200k | Streams thoughts and per-file diffs through stream-json |",
      "| Codex | gpt-5.6-sol | xhigh | 400k | Aggregates the whole turn into one unified diff itself |",
      "",
      "Done.",
    ].join("\n");
    // Streamed in two chunks: the overflow only appeared once a late chunk
    // widened the table past the pane, so the split is part of the repro.
    const middle = Math.floor(table.length / 2);
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: table.slice(0, middle),
      }),
    );
    await settleRichContent();
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: table.slice(middle),
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await settleRichContent();

    const frame = harness.testRenderer.captureCharFrame();
    // A table that fits closes its right border on screen; a clipped one
    // loses ┐ and ┘ past the pane edge.
    expect(frame).toContain("┐");
    expect(frame).toContain("┘");
    expect(frame).toContain("Vendor");
    expect(frame).toContain("Done.");
  });

  test("a streaming burst coalesces paints and still lands the full text", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "opening words ",
      }),
    );
    // A synchronous burst, the shape a fast token stream arrives in. The pane
    // reduces every delta before deriving one visible projection.
    for (let index = 0; index < 20; index += 1) {
      harness.ui.onProviderEvent(
        harness.driver.emit({
          kind: "message-delta",
          turnId: "t1",
          text: `chunk-${index} `,
        }),
      );
    }
    await harness.testRenderer.flush();
    const burstFrame = harness.testRenderer.captureCharFrame();
    expect(burstFrame).toContain("opening words");
    expect(burstFrame).toContain("chunk-19");

    // A later settled event reconciles Markdown immediately; the already exact
    // streaming projection needs no second parse while it remains unstable.
    await Bun.sleep(80);
    await harness.testRenderer.flush();
    expect(harness.testRenderer.captureCharFrame()).toContain("chunk-19");
    const entry = harness.ui
      .snapshot()
      .view.transcript.find((item) => item.kind === "agent");
    expect(entry?.kind === "agent" && entry.text).toContain("chunk-19");
  });

  test("streaming text appends plainly and parses Markdown once on settle", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "opening ",
      }),
    );
    await Bun.sleep(10);
    const stream = unsafeCast<{
      readonly textBuffer: {
        append(text: string): void;
        setStyledText(value: JsonValue): void;
      };
    }>(
      harness.testRenderer.renderer.root.findDescendantById(
        "agent-ui-stream-t1",
      ),
    );
    expect(stream).toBeDefined();
    const originalAppend = stream.textBuffer.append.bind(stream.textBuffer);
    const originalSetStyledText = stream.textBuffer.setStyledText.bind(
      stream.textBuffer,
    );
    let appends = 0;
    let replacements = 0;
    stream.textBuffer.append = (text) => {
      appends += 1;
      originalAppend(text);
    };
    stream.textBuffer.setStyledText = (value) => {
      replacements += 1;
      originalSetStyledText(value);
    };

    for (let index = 0; index < 20; index += 1) {
      harness.ui.onProviderEvent(
        harness.driver.emit({
          kind: "message-delta",
          turnId: "t1",
          text: `chunk-${index} `,
        }),
      );
    }
    await Bun.sleep(10);
    expect(appends).toBe(1);
    expect(replacements).toBe(0);
    expect(
      harness.testRenderer.renderer.root.findDescendantById(
        "agent-ui-markdown-t1",
      ),
    ).toBeUndefined();
    stream.textBuffer.append = originalAppend;
    stream.textBuffer.setStyledText = originalSetStyledText;

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
    );
    await Bun.sleep(10);
    expect(
      harness.testRenderer.renderer.root.findDescendantById(
        "agent-ui-stream-t1",
      ),
    ).toBeUndefined();
    expect(
      harness.testRenderer.renderer.root.findDescendantById(
        "agent-ui-markdown-t1",
      ),
    ).toBeDefined();
  });

  test("wide prose keeps a readable measure while tool details may use more room", async () => {
    harness.testRenderer.resize(160, 30);
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "message-delta",
        turnId: "t1",
        text: "A concise response with a deliberately recognizable ending marker.",
      }),
    );
    await settleRichContent();

    const response = harness.testRenderer
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("recognizable ending marker"));
    expect(response).toBeDefined();
    expect(response?.trimEnd().length).toBeLessThanOrEqual(108);
  });
});
