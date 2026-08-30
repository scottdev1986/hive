import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import {
  applyDiagnostic,
  type ViewState,
} from "../src/cli/agent-ui/view-state";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";
import { unsafeCast } from "../src/shared/unsafe-cast";

let harness: AgentUiHarness;

beforeEach(async () => {
  harness = await createAgentUiHarness();
});

afterEach(async () => {
  await harness.close();
});

describe("transcript render window", () => {
  test("bounds OpenTUI children and pages to older transcript entries", async () => {
    const internal = unsafeCast<{ view: ViewState }>(harness.ui);
    let view = internal.view;
    for (let index = 0; index < 1_000; index += 1) {
      view = applyDiagnostic(view, `mail-${index}`, "warning");
    }
    internal.view = view;
    harness.ui.draw();
    await harness.testRenderer.flush();

    const found = harness.testRenderer.renderer.root.findDescendantById(
      "agent-ui-transcript",
    );
    if (!(found instanceof ScrollBoxRenderable)) {
      throw new Error("transcript scrollbox is missing");
    }
    expect(found.content.getChildren().length).toBeLessThanOrEqual(322);
    expect(harness.testRenderer.captureCharFrame()).toContain("mail-999");

    harness.ui.scrollBy(-1_000_000);
    await harness.testRenderer.flush();
    harness.ui.scrollBy(-1_000_000);
    await harness.testRenderer.flush();
    expect(found.content.getChildren().length).toBeLessThanOrEqual(322);
    expect(harness.testRenderer.captureCharFrame()).not.toContain("mail-999");
    expect(harness.testRenderer.captureCharFrame()).toContain("mail-743");

    harness.ui.scrollBy(1_000_000);
    await harness.testRenderer.flush();
    expect(harness.testRenderer.captureCharFrame()).toContain("mail-744");
    harness.ui.scrollBy(1_000_000);
    await harness.testRenderer.flush();
    expect(harness.testRenderer.captureCharFrame()).toContain("mail-999");
  });

  test("a spinner tick does not reconcile the transcript", () => {
    const internal = unsafeCast<{
      spinnerTick: number;
      refresh(): void;
      transcriptView: {
        update(...args: unknown[]): void;
      };
    }>(harness.ui);
    const original = internal.transcriptView.update.bind(
      internal.transcriptView,
    );
    let updates = 0;
    internal.transcriptView.update = (...args) => {
      updates += 1;
      original(...args);
    };

    internal.spinnerTick += 1;
    internal.refresh();

    expect(updates).toBe(0);
  });
});
