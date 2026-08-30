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
  // Diff and markdown renderables lay out asynchronously once their content
  // has been parsed, so a frame captured on the same tick is still empty.
  await Bun.sleep(60);
  await harness.testRenderer.flush();
}

describe("code changes show in the live line and the events view", () => {
  test("an edit shows live while it runs and as an events row afterwards", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "call-1",
        toolName: "Edit",
        detail: "src/app.ts",
        toolKind: "edit",
        locations: ["src/app.ts"],
        changes: [
          {
            path: "src/app.ts",
            oldText: "const port = 3000;\n",
            newText: "const port = 8080;\n",
          },
        ],
      }),
    );
    await settle();
    const live = harness.testRenderer.captureCharFrame();

    // While it runs, the live line names the tool and the file; the chat
    // itself carries no tool row and no diff.
    expect(live).toContain("Edit");
    expect(live).toContain("src/app.ts");
    expect(live).not.toContain("const port");

    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-finished",
        turnId: "t1",
        toolCallId: "call-1",
        status: "ok",
      }),
    );
    await settle();
    expect(harness.testRenderer.captureCharFrame()).not.toContain("src/app.ts");

    harness.testRenderer.mockInput.pressKey("o", { ctrl: true });
    await settle();
    const events = harness.testRenderer.captureCharFrame();
    expect(events).toContain("✓ Edit");
    expect(events).toContain("src/app.ts");
    expect(events).toContain("1 file");
  });

  test("a turn-level diff replaces the previous one instead of stacking", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    for (const value of ["1", "2"]) {
      harness.ui.onProviderEvent(
        harness.driver.emit({
          kind: "turn-diff-updated",
          turnId: "t1",
          diff: [
            "--- a/x.ts",
            "+++ b/x.ts",
            "@@ -1 +1 @@",
            "-const x = 0;",
            `+const x = ${value};`,
            "",
          ].join("\n"),
        }),
      );
    }
    await settle();
    expect(harness.testRenderer.captureCharFrame()).not.toContain("Changes");

    harness.testRenderer.mockInput.pressKey("o", { ctrl: true });
    await settle();
    const events = harness.testRenderer.captureCharFrame();
    // One Changes row for the turn, carrying the latest aggregate.
    expect(events.split("Changes").length - 1).toBe(1);
    expect(events).toContain("1 file");
    expect(events).toContain("+1 −1");
    const diffs = harness.ui
      .snapshot()
      .view.transcript.filter((entry) => entry.kind === "diff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.kind === "diff" ? diffs[0].diff : "").toContain(
      "+const x = 2;",
    );
  });

  test("a tool call names the file it is touching", async () => {
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "t1" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "call-2",
        toolName: "Read",
        detail: null,
        toolKind: "read",
        locations: ["/repo/src/deep/module.ts"],
        changes: [],
      }),
    );
    await settle();

    expect(harness.testRenderer.captureCharFrame()).toContain("module.ts");
  });

  test("a pathological edit renders pending while input remains available", async () => {
    const oldText = Array.from(
      { length: 5_000 },
      (_, index) => `old line ${index}`,
    ).join("\n");
    const newText = Array.from(
      { length: 5_000 },
      (_, index) => `new line ${index}`,
    ).join("\n");
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "tool-started",
        turnId: "t1",
        toolCallId: "call-large",
        toolName: "Edit",
        detail: "large.txt",
        toolKind: "edit",
        changes: [{ path: "large.txt", oldText, newText }],
      }),
    );
    await harness.testRenderer.flush();

    expect(harness.testRenderer.captureCharFrame()).toContain("large.txt");
    harness.testRenderer.mockInput.typeText("still responsive");
    await harness.ui.settleInput();
    await harness.testRenderer.flush();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "still responsive",
    );
  });
});
