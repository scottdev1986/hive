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

describe("code changes are visible in the pane", () => {
  test("an edit renders as a diff with its added and removed lines", async () => {
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
    const compact = harness.testRenderer.captureCharFrame();

    expect(compact).toContain("Edit");
    expect(compact).toContain("src/app.ts");
    expect(compact).toContain("+1 −1");
    // The diff is the point of watching an edit: it shows without ctrl+o.
    expect(compact).toContain("- const port = 3000;");
    expect(compact).toContain("+ const port = 8080;");

    harness.testRenderer.mockInput.pressKey("o", { ctrl: true });
    await settle();
    const expanded = harness.testRenderer.captureCharFrame();

    expect(expanded).toContain("- const port = 3000;");
    expect(expanded).toContain("+ const port = 8080;");
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
    const compact = harness.testRenderer.captureCharFrame();

    expect(compact).toContain("Changes · 1 file · +1 −1");
    // The aggregate diff shows inline like per-tool diffs, and it is the
    // latest aggregate: the superseded turn diff is gone, not stacked.
    expect(compact).toContain("+ const x = 2;");
    expect(compact).not.toContain("+ const x = 1;");

    harness.testRenderer.mockInput.pressKey("o", { ctrl: true });
    await settle();
    const expanded = harness.testRenderer.captureCharFrame();

    expect(expanded).toContain("+ const x = 2;");
    expect(expanded).not.toContain("+ const x = 1;");
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

    expect(harness.testRenderer.captureCharFrame()).toContain("preparing diff");
    harness.testRenderer.mockInput.typeText("still responsive");
    await harness.ui.settleInput();
    await harness.testRenderer.flush();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "still responsive",
    );
  });
});
