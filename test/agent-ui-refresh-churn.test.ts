import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";
import type { JsonValue } from "../src/shared/json";
import { unsafeCast } from "../src/shared/unsafe-cast";

interface InstrumentedTextBuffer {
  setStyledText(value: JsonValue): void;
}

interface InstrumentedTextRenderable {
  readonly textBuffer: InstrumentedTextBuffer;
}

interface AgentUiTextInternals {
  readonly bannerText: InstrumentedTextRenderable;
  readonly queueStatus: InstrumentedTextRenderable;
  readonly commands: InstrumentedTextRenderable;
  readonly footerStatus: InstrumentedTextRenderable;
  readonly footerHints: InstrumentedTextRenderable;
}

interface AgentUiRefreshInternals {
  refresh(): void;
}

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
});

afterEach(async () => {
  await harness.close();
});

describe("Agent UI refresh dirtiness", () => {
  test("an unchanged refresh performs no text FFI writes or render request", () => {
    const internals = unsafeCast<AgentUiTextInternals>(harness.ui);
    const renderables = [
      internals.bannerText,
      internals.queueStatus,
      internals.commands,
      internals.footerStatus,
      internals.footerHints,
    ];
    let styledTextWrites = 0;
    const restores = renderables.map(({ textBuffer }) => {
      const original = textBuffer.setStyledText.bind(textBuffer);
      textBuffer.setStyledText = (value) => {
        styledTextWrites += 1;
        original(value);
      };
      return () => {
        textBuffer.setStyledText = original;
      };
    });
    const renderer = harness.testRenderer.renderer;
    const originalRequestRender = renderer.requestRender.bind(renderer);
    let renderRequests = 0;
    renderer.requestRender = () => {
      renderRequests += 1;
      originalRequestRender();
    };

    try {
      harness.ui.draw();
      expect(styledTextWrites).toBe(0);
      expect(renderRequests).toBe(0);
    } finally {
      renderer.requestRender = originalRequestRender;
      for (const restore of restores) restore();
    }
  });

  test("a synchronous provider burst paints its final projection once", async () => {
    const internals = unsafeCast<AgentUiRefreshInternals>(harness.ui);
    const originalRefresh = internals.refresh.bind(internals);
    let refreshes = 0;
    internals.refresh = () => {
      refreshes += 1;
      originalRefresh();
    };

    try {
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
      );
      for (const text of ["one ", "two ", "three"]) {
        harness.ui.onProviderEvent(
          harness.driver.emit({ kind: "message-delta", turnId: "t1", text }),
        );
      }
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "turn-idle", turnId: "t1" }),
      );

      expect(refreshes).toBe(0);
      await Bun.sleep(10);
      expect(refreshes).toBe(1);
      expect(harness.ui.snapshot().view.transcript).toContainEqual({
        kind: "agent",
        turnId: "t1",
        text: "one two three",
        streaming: false,
      });
    } finally {
      internals.refresh = originalRefresh;
    }
  });
});
