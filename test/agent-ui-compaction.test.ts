import { afterEach, describe, expect, test } from "bun:test";
import type { CapabilityProvider } from "../src/schemas/capability";
import { fakeCapabilities } from "../src/adapters/providers/protocol/fake-driver";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

afterEach(async () => {
  await harness.close();
});

async function settle(): Promise<void> {
  await harness.ui.settleInput();
  await harness.testRenderer.flush();
}

async function createProviderHarness(
  provider: CapabilityProvider,
  compact: "supported" | "command" | "unavailable",
): Promise<AgentUiHarness> {
  const capabilities = fakeCapabilities({
    provider,
    measured: {
      ...fakeCapabilities().measured,
      commandCatalog: "supported",
      ...(compact === "supported" ? { compact: "supported" as const } : {}),
    },
    ...(compact === "unavailable"
      ? {
          absences: {
            compact: {
              reason: "OpenCode ACP does not expose compaction",
              citation: "test evidence",
            },
          },
        }
      : {}),
  });
  return await createAgentUiHarness({
    capabilities,
    identity: {
      agentName: "queen",
      vendorName: provider,
      vendorId: provider,
      model: "test-model",
    },
  });
}

describe("professional compaction lifecycle", () => {
  test.each([
    ["kimi", "Kimi"],
    ["grok", "Grok"],
  ] as const)(
    "%s renders its command lifecycle instead of a sending prompt",
    async (provider) => {
      harness = await createProviderHarness(provider, "command");
      harness.ui.replaceCommandCatalog([
        {
          name: "compact",
          description: "Compact context",
          argumentHint: "optional preservation instructions",
        },
      ]);

      await harness.testRenderer.mockInput.typeText(
        "/compact preserve the current plan",
      );
      harness.testRenderer.mockInput.pressEnter();
      await settle();

      const frame = harness.testRenderer.captureCharFrame();
      expect(frame).toContain("/compact preserve the current plan");
      expect(frame).toContain("Compaction command completed");
      expect(frame).not.toContain("· sending");
      expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
        "/compact preserve the current plan",
      ]);
    },
  );

  test("Claude remains visibly compacting until compact_boundary", async () => {
    harness = await createProviderHarness("claude", "supported");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Compacting context",
    );

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "compacted", turnId: "turn-1" }),
    );
    harness.ui.draw();
    await harness.testRenderer.flush();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("Context compacted");
    expect(frame).not.toContain("Compacting context");
  });

  test("Codex uses its direct command and deduplicates completion events", async () => {
    harness = await createProviderHarness("codex", "supported");
    harness.driver.commandRoutes.add("compact");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Compacting context",
    );

    for (let sequence = 0; sequence < 2; sequence += 1) {
      harness.ui.onProviderEvent(
        harness.driver.emit({ kind: "compacted", turnId: "compact-turn" }),
      );
    }
    harness.ui.draw();
    await harness.testRenderer.flush();

    expect(
      harness.ui
        .snapshot()
        .view.transcript.filter((entry) => entry.kind === "compaction"),
    ).toHaveLength(1);
    expect(harness.driver.ranCommands).toEqual(["compact"]);
    expect(harness.driver.submissions).toEqual([]);
  });

  test("OpenCode refuses an unavailable compact command without sending prose", async () => {
    harness = await createProviderHarness("opencode", "unavailable");

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    const frame = harness.testRenderer.captureCharFrame();
    expect(frame).toContain("Compaction unavailable");
    expect(frame).toContain("OpenCode ACP does not expose compaction");
    expect(harness.driver.submissions).toEqual([]);
    expect(harness.journal.all()).toEqual([]);
  });

  test("measured context is included only when it changes", async () => {
    harness = await createProviderHarness("claude", "supported");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "usage-updated",
        turnId: "prior",
        contextPercent: 81,
        inputTokens: null,
        outputTokens: null,
      }),
    );

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "compacted", turnId: "compact-turn" }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "usage-updated",
        turnId: "compact-turn",
        contextPercent: 19,
        inputTokens: null,
        outputTokens: null,
      }),
    );
    harness.ui.draw();
    await harness.testRenderer.flush();

    expect(harness.testRenderer.captureCharFrame()).toContain("81% → 19%");
  });

  test("a compact command queues behind an active turn", async () => {
    harness = await createProviderHarness("kimi", "command");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-started", turnId: "active-turn" }),
    );

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Compaction queued",
    );
    expect(harness.driver.submissions).toEqual([]);

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "active-turn" }),
    );
    await harness.ui.pump();
    harness.ui.draw();
    await harness.testRenderer.flush();

    expect(harness.driver.submissions.map((entry) => entry.text)).toEqual([
      "/compact",
    ]);
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Compaction command completed",
    );
  });

  test.each([
    ["rejected", "Compaction failed"],
    ["unknown", "Compaction outcome unknown"],
  ] as const)("a %s command receipt stays distinct", async (outcome, label) => {
    harness = await createProviderHarness("grok", "command");
    harness.driver.submitOutcome = outcome;
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();

    expect(harness.testRenderer.captureCharFrame()).toContain(label);
    expect(harness.testRenderer.captureCharFrame()).not.toContain("· sending");
  });

  test("an interrupted compact turn is shown as cancelled", async () => {
    harness = await createProviderHarness("claude", "supported");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    const clientInputId = harness.journal.all()[0]?.clientInputId;
    if (clientInputId === undefined) throw new Error("missing compact row");
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "turn-started",
        turnId: "compact-turn",
        clientInputId,
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "interrupted", turnId: "compact-turn" }),
    );
    harness.ui.draw();
    await harness.testRenderer.flush();

    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Compaction cancelled",
    );
  });

  test("a supported command cannot remain active after an unconfirmed boundary", async () => {
    harness = await createProviderHarness("claude", "supported");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);

    await harness.testRenderer.mockInput.typeText("/compact");
    harness.testRenderer.mockInput.pressEnter();
    await settle();
    const clientInputId = harness.journal.all()[0]?.clientInputId;
    if (clientInputId === undefined) throw new Error("missing compact row");
    harness.ui.onProviderEvent(
      harness.driver.emit({
        kind: "turn-started",
        turnId: "compact-turn",
        clientInputId,
      }),
    );
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "turn-idle", turnId: "compact-turn" }),
    );
    harness.ui.draw();
    await harness.testRenderer.flush();

    expect(harness.testRenderer.captureCharFrame()).toContain(
      "Compaction outcome unknown",
    );
    expect(harness.ui.snapshot().view.foregroundOperation).toBeNull();
  });

  test("a second compact command cannot replace the active operation", async () => {
    harness = await createProviderHarness("codex", "supported");
    harness.driver.commandRoutes.add("compact");
    harness.ui.replaceCommandCatalog([
      { name: "compact", description: "Compact context" },
    ]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await harness.testRenderer.mockInput.typeText("/compact");
      harness.testRenderer.mockInput.pressEnter();
      await settle();
    }

    expect(harness.driver.ranCommands).toEqual(["compact"]);
    expect(harness.testRenderer.captureCharFrame()).toContain(
      "compaction is already in progress",
    );
    expect(
      harness.ui
        .snapshot()
        .view.transcript.filter((entry) => entry.kind === "compaction"),
    ).toHaveLength(1);
  });
});
