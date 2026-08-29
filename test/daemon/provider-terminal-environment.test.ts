import { describe, expect, test } from "bun:test";
import { providerTerminalEnvironment } from "../../src/daemon/session-host/provider-terminal-environment";

describe("providerTerminalEnvironment", () => {
  test("keeps launcher NO_COLOR out of the interactive provider terminal", () => {
    const env = providerTerminalEnvironment({
      PATH: "/bin",
      NO_COLOR: "1",
      EMPTY: undefined,
    });
    expect(env.PATH).toBe("/bin");
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.EMPTY).toBeUndefined();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  test("does not inherit a launcher TERMINFO database", () => {
    const env = providerTerminalEnvironment({
      PATH: "/bin",
      TERM: "xterm-ghostty",
      TERMINFO: "/Applications/Ghostty.app/Contents/Resources/terminfo",
      TERMINFO_DIRS: "/opt/share/terminfo",
    });
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TERMINFO).toBeUndefined();
    expect(env.TERMINFO_DIRS).toBeUndefined();
  });
});
