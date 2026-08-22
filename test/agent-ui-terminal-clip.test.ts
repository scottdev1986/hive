import { describe, expect, test } from "bun:test";
import {
  clipTerminalText,
  type TerminalTextClip,
} from "../src/cli/agent-ui/terminal-clip";
import {
  applyProviderEvent,
  commandMenuEntries,
  initialView,
} from "../src/cli/agent-ui/view-state";
import type { NormalizedProviderEvent } from "../src/adapters/providers/protocol/types";
import type { JsonObject } from "../src/shared/json";

const ESC = "\u001b";

let sequence = 0;

function providerEvent(
  event: JsonObject & { readonly kind: string },
): NormalizedProviderEvent {
  sequence += 1;
  // SAFETY: The test owns this value and its fields.
  return {
    ...event,
    sequence,
    occurredAt: new Date(sequence).toISOString(),
    raw: event,
  } as NormalizedProviderEvent;
}

function expectEscapeAtomic(clip: TerminalTextClip): void {
  // ESC is the subject under test; build the pattern so the lint rule does not
  // treat a control character embedded in a regex literal as a mistake.
  const incompleteEscAtom = new RegExp(
    `${String.fromCharCode(0x1b)}(?:\\[|\\]|P|X|\\^|_)?$`,
  );
  expect(clip.text).not.toMatch(incompleteEscAtom);
}

describe("terminal text clipping", () => {
  test("clips by terminal cells without splitting a wide grapheme", () => {
    const clip = clipTerminalText("ab界cd", {
      maxCells: 5,
      inline: true,
    });

    expect(clip.text).toBe("ab界…");
    expect(clip.cells).toBe(5);
    expect(clip.clipped).toBe(true);
  });

  test("keeps complete ANSI atoms and closes a clipped style", () => {
    const clip = clipTerminalText(`abc${ESC}[38;5;196mdef`, {
      maxCells: 5,
      inline: true,
    });

    expect(clip.text).toBe(`abc${ESC}[38;5;196md${ESC}[39m…`);
    expectEscapeAtomic(clip);
  });

  test("drops a hostile incomplete escape instead of exposing a fragment", () => {
    const clip = clipTerminalText(`safe${ESC}[38;5;`, {
      maxCells: 20,
      inline: true,
    });

    expect(clip.text).toBe("safe");
    expectEscapeAtomic(clip);
  });

  test("closes a clipped OSC hyperlink after a wide cell", () => {
    const open = `${ESC}]8;;https://example.test${ESC}\\`;
    const close = `${ESC}]8;;${ESC}\\`;
    const clip = clipTerminalText(`${open}界abc${close}`, {
      maxCells: 4,
      inline: true,
    });

    expect(clip.text).toBe(`${open}界a${close}…`);
    expect(clip.cells).toBe(4);
    expectEscapeAtomic(clip);
  });

  test("line clipping cannot strand an opener from tool output", () => {
    const clip = clipTerminalText(`${ESC}[31mfirst\nsecond\nthird${ESC}[0m`, {
      maxLines: 2,
      edge: "head",
    });

    expect(clip.text).toBe(`${ESC}[31mfirst\nsecond${ESC}[39m`);
    expect(clip.omittedLines).toBe(1);
    expectEscapeAtomic(clip);
  });
});

describe("terminal clipping at view-state ingress", () => {
  test("command labels are clipped once while their protocol name stays intact", () => {
    let view = initialView();
    view = applyProviderEvent(
      view,
      providerEvent({
        kind: "commands-updated",
        commands: [
          {
            name: `abcdefghijklmnopqrst${ESC}[31muvwxyz${ESC}[0m`,
            description: "Hostile command",
          },
        ],
      }),
    );

    const entry = commandMenuEntries(view, "/")[0];
    expect(entry?.name).toBe(`abcdefghijklmnopqrst${ESC}[31muvwxyz${ESC}[0m`);
    expect(entry?.menuColumn).toContain(`${ESC}[39m…`);
    expect(entry?.menuColumn).toEndWith("…");
    expect(Bun.stringWidth(entry?.menuColumn ?? "")).toBe(24);
  });

  test("a streaming thought caches one cell-bounded summary", () => {
    const text = `${ESC}[31m${"界".repeat(60)}${ESC}[0m`;
    const view = applyProviderEvent(
      initialView(),
      providerEvent({ kind: "thought-delta", turnId: "turn-1", text }),
    );
    const entry = view.transcript[0];
    if (entry?.kind !== "thought") throw new Error("thought entry missing");

    expect(entry.text).toBe(text);
    expect(entry.summary.cellClipped).toBe(true);
    expect(entry.summary.cells).toBeLessThanOrEqual(92);
    expect(entry.summary.text).toContain(`${ESC}[39m…`);
  });

  test("an unchanged tool payload reuses its safe projections", () => {
    const output = `${ESC}[31m${Array.from(
      { length: 41 },
      (_, index) => `line-${index + 1}`,
    ).join("\n")}${ESC}[0m`;
    let view = initialView();
    view = applyProviderEvent(
      view,
      providerEvent({
        kind: "tool-started",
        turnId: "turn-1",
        toolCallId: "tool-1",
        toolName: "exec",
        detail: `detail ${ESC}[31mred${ESC}[0m`,
        output,
      }),
    );
    const first = view.transcript[0];
    if (first?.kind !== "tool") throw new Error("tool entry missing");
    expect(first.presentation).toBeDefined();
    expect(first.presentation.output?.head).toContain(
      `${ESC}[39m\n… 1 more lines`,
    );

    view = applyProviderEvent(
      view,
      providerEvent({
        kind: "tool-updated",
        turnId: "turn-1",
        toolCallId: "tool-1",
        detail: first.detail,
        output: first.output,
      }),
    );
    const second = view.transcript[0];
    if (second?.kind !== "tool") throw new Error("tool entry missing");

    expect(second).toBe(first);
    expect(second.presentation).toBe(first.presentation);
  });
});
