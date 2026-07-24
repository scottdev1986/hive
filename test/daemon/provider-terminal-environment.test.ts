import { describe, expect, test } from "bun:test";
import { providerTerminalEnvironment } from "../../src/daemon/provider-terminal-environment";

describe("providerTerminalEnvironment", () => {
  test("keeps launcher NO_COLOR out of the interactive provider terminal", () => {
    expect(providerTerminalEnvironment({
      PATH: "/bin",
      NO_COLOR: "1",
      EMPTY: undefined,
    })).toEqual({ PATH: "/bin" });
  });
});
