import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { AGENT_UI_CONSOLE_OPTIONS } from "../src/cli/agent-ui/run";

describe("agent UI console diagnostics", () => {
  test("captures ACP SDK errors without painting or opening an overlay", async () => {
    const originalConsole = global.console;
    const harness = await createTestRenderer({
      width: 80,
      height: 24,
      ...AGENT_UI_CONSOLE_OPTIONS,
    });

    try {
      console.error("Got response to unknown request", "skills-reload");

      const diagnostics = harness.renderer.console.getCachedLogs();
      expect(diagnostics).toContain("Got response to unknown request");
      expect(diagnostics).toContain("skills-reload");
      expect(harness.renderer.console.visible).toBe(false);
    } finally {
      harness.renderer.destroy();
    }

    expect(global.console).toBe(originalConsole);
  });
});
