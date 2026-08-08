import { afterEach, describe, expect, test } from "bun:test";
import { QUEEN_PIN } from "../src/daemon/queen-provider-service/queen-pin";
import { type AgentUiHarness, createAgentUiHarness } from "./agent-ui-harness";

let harness: AgentUiHarness;

afterEach(async () => {
  await harness.close();
});

describe("queen compact reload", () => {
  test("after compact, the queen pane submits the daemon pin and board", async () => {
    const reload = `${QUEEN_PIN}\n\n## Live board\nauthority: system-fact\ntask_1`;
    harness = await createAgentUiHarness({
      identity: {
        agentName: "queen",
        vendorName: "Claude Code",
        vendorId: "claude",
        model: "test-model",
      },
      loadCompactReload: async () => reload,
    });

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "compacted", turnId: "compact-1" }),
    );
    await harness.ui.pump();

    expect(harness.driver.submissions).toEqual([
      expect.objectContaining({ text: reload }),
    ]);
  });

  test("a worker pane does not submit a compact reload", async () => {
    harness = await createAgentUiHarness({
      identity: {
        agentName: "maya",
        vendorName: "Claude Code",
        vendorId: "claude",
        model: "test-model",
      },
    });
    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "compacted", turnId: "compact-1" }),
    );
    await harness.ui.pump();
    expect(harness.driver.submissions).toEqual([]);
  });

  test("a failed board fetch still submits the pin", async () => {
    harness = await createAgentUiHarness({
      identity: {
        agentName: "queen",
        vendorName: "Claude Code",
        vendorId: "claude",
        model: "test-model",
      },
      loadCompactReload: async () => {
        throw new Error("daemon unreachable");
      },
    });

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "compacted", turnId: "compact-1" }),
    );
    await harness.ui.pump();

    expect(harness.driver.submissions).toHaveLength(1);
    expect(harness.driver.submissions[0]?.text).toContain(QUEEN_PIN);
    expect(harness.driver.submissions[0]?.text).toContain("daemon unreachable");
  });

  test("a reload that dropped the pin has it restored before submit", async () => {
    harness = await createAgentUiHarness({
      identity: {
        agentName: "queen",
        vendorName: "Claude Code",
        vendorId: "claude",
        model: "test-model",
      },
      loadCompactReload: async () => "Hive compact: rewritten without the pin",
    });

    harness.ui.onProviderEvent(
      harness.driver.emit({ kind: "compacted", turnId: "compact-1" }),
    );
    await harness.ui.pump();

    expect(harness.driver.submissions[0]?.text).toContain(QUEEN_PIN);
    expect(harness.driver.submissions[0]?.text).toContain(
      "rewritten without the pin",
    );
  });
});
