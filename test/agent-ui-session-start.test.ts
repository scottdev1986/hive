import { describe, expect, test } from "bun:test";
import { agentUiSessionStart } from "../src/cli/agent-ui/run";

describe("agent UI session posture", () => {
  test("a read-only Kimi spawn requests Kimi's manual-approval mode", () => {
    expect(
      agentUiSessionStart({
        provider: "kimi",
        model: "kimi-code/k3",
        effort: "max",
        readOnly: true,
      }),
    ).toEqual({
      model: "kimi-code/k3",
      effort: "max",
      mode: "default",
    });
  });

  test("Kimi writers and other read-only providers keep their adapter posture", () => {
    expect(agentUiSessionStart({ provider: "kimi", readOnly: false })).toEqual(
      {},
    );
    expect(
      agentUiSessionStart({ provider: "opencode", readOnly: true }),
    ).toEqual({});
  });
});
