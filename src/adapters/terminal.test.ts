import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildITerm2CloseOsascript,
  buildITerm2FindSessionByTtyOsascript,
  buildITerm2Osascript,
  buildITerm2SetBoundsOsascript,
  ITerm2Adapter,
} from "./iterm2";
import {
  buildTerminalAppCloseOsascript,
  buildTerminalAppFindWindowByTtyOsascript,
  buildTerminalAppOsascript,
  buildTerminalAppSetBoundsOsascript,
  TerminalAppAdapter,
} from "./terminal-app";
import { buildAgentTerminalTitle, resolveTerminal } from "./terminal";
import { osascriptFailure } from "./osascript";

const previousHiveHome = Bun.env.HIVE_HOME;
Bun.env.HIVE_HOME = `/private/tmp/hive-terminal-${crypto.randomUUID()}`;

afterAll(() => {
  if (previousHiveHome === undefined) {
    delete Bun.env.HIVE_HOME;
  } else {
    Bun.env.HIVE_HOME = previousHiveHome;
  }
});

describe("terminal osascript builders", () => {
  test("turns macOS automation denials into actionable errors", () => {
    const error = osascriptFailure(
      "position Terminal.app window",
      "Not authorized to send Apple events. (-1743)",
    );

    expect(error.message).toContain(
      "System Settings > Privacy & Security > Automation",
    );
    expect(error.message).toContain("hive stop");
  });

  test("builds an iTerm2 window command without executing it", () => {
    const script = buildITerm2Osascript("hive-agent-3", 'Agent "Three"');

    expect(script.includes('tell application "iTerm2"')).toEqual(true);
    expect(script.includes("create window with default profile")).toEqual(true);
    expect(script.includes("tmux attach -t '=hive-agent-3'")).toEqual(true);
    expect(script.includes('set name to "Agent \\"Three\\""')).toEqual(true);
    expect(script.includes("set agentSessionId to unique id")).toEqual(true);
    expect(script.includes("return agentSessionId")).toEqual(true);
  });

  test("builds a Terminal.app window command without executing it", () => {
    const script = buildTerminalAppOsascript(
      "hive-agent-4",
      "Agent Four",
      "/tmp/Hive Agent.terminal",
      "Hive Agent Test",
    );

    expect(script.includes('tell application "Terminal"')).toEqual(true);
    expect(script.includes("tmux attach -t '=hive-agent-4'")).toEqual(true);
    expect(script).toContain('if exists settings set "Hive Agent Test" then');
    expect(script).toContain(
      'set current settings of agentTab to settings set "Hive Agent Test"',
    );
    expect(script).toContain(
      "set agentWindow to first window whose selected tab is agentTab",
    );
    expect(
      script.includes('open POSIX file "/tmp/Hive Agent.terminal"'),
    ).toEqual(true);
    expect(script).toContain("set existingWindowIds to id of every window");
    expect(script).toContain(
      "if id of candidateWindow is not in existingWindowIds",
    );
    expect(script).toContain('do script "tmux attach');
    expect(
      script.includes('set custom title of agentTab to "Agent Four"'),
    ).toEqual(true);
    expect(script).toContain("set title displays custom title of agentTab to true");
    expect(script).toContain("set previousBounds to bounds of agentWindow");
    expect(script).toContain("if stableSamples is 2 then exit repeat");
    expect(
      script.includes(
        "set agentWindow to first window whose selected tab is agentTab",
      ),
    ).toEqual(true);
    expect(script).not.toContain("set agentWindow to front window");
    expect(
      script.includes(
        "return terminalProcessId & (ASCII character 9) & agentWindowId & (ASCII character 9) & agentTty",
      ),
    ).toEqual(true);
  });

  test("uses the bundled profile's exact settings-set name", () => {
    const script = buildTerminalAppOsascript("hive-maya", "maya — stub");

    expect(script).toContain('if exists settings set "hive-agent-v2" then');
    expect(script).toContain("/hive-agent-v2.terminal");
  });

  test("ships a Terminal.app profile that suppresses generated title components", async () => {
    const profile = await Bun.file(
      join(import.meta.dir, "hive-agent-v2.terminal"),
    ).text();
    const generatedTitleKeys = [
      "ShowComponentsWhenTabHasCustomTitle",
      "ShowActiveProcessArgumentsInTabTitle",
      "ShowActiveProcessArgumentsInTitle",
      "ShowActiveProcessInTabTitle",
      "ShowActiveProcessInTitle",
      "ShowCommandKeyInTitle",
      "ShowDimensionsInTitle",
      "ShowRepresentedURLInTabTitle",
      "ShowRepresentedURLInTitle",
      "ShowRepresentedURLPathInTabTitle",
      "ShowRepresentedURLPathInTitle",
      "ShowShellCommandInTitle",
      "ShowTTYNameInTabTitle",
      "ShowTTYNameInTitle",
      "ShowWindowSettingsNameInTitle",
    ];

    for (const key of generatedTitleKeys) {
      expect(profile).toContain(`<key>${key}</key>\n  <false/>`);
    }
    expect(profile).toContain("<string>hive-agent-v2</string>");
    expect(profile).toContain("<key>BackgroundColor</key>");
  });

  test("shell-quotes tmux session names", () => {
    const script = buildITerm2Osascript("agent'five", "Agent Five");
    expect(script.includes("'=agent'\\\\''five'")).toEqual(true);
  });

  test("closes only the exact iTerm2 session id and safely escapes it", () => {
    const script = buildITerm2CloseOsascript('session-1"\\\nreturn');

    expect(script).toContain("repeat with agentSession in sessions of agentTab");
    expect(script).toContain(
      'if (unique id of agentSession as text) is "session-1\\"\\\\\\nreturn" then',
    );
    expect(script).toContain("close agentSession");
    expect(script).not.toContain("name of agentSession");
    expect(script).not.toContain("tmux");
  });

  test("closes only an exact Terminal.app window and TTY pair", () => {
    const script = buildTerminalAppCloseOsascript(
      4242,
      731,
      '/dev/ttys009"\\\nclose every window',
    );

    expect(script).toContain('if terminalProcessId is not "4242" then return');
    expect(script).toContain("first window whose id is 731");
    expect(script).toContain("if (count of tabs of agentWindow) is not 1 then return");
    expect(script).toContain(
      'if (tty of selected tab of agentWindow) is not "/dev/ttys009\\"\\\\\\nclose every window" then return',
    );
    expect(script).toContain("close agentWindow");
    expect(script).not.toContain("custom title");
    expect(script).not.toContain("tmux");
  });
});

describe("terminal layout osascript builders", () => {
  test("positions only an identity-verified Terminal.app window", () => {
    const script = buildTerminalAppSetBoundsOsascript(
      4242,
      731,
      "/dev/ttys009",
      { x: 100, y: 25, width: 800, height: 600 },
    );

    expect(script).toContain('if terminalProcessId is not "4242" then return');
    expect(script).toContain("first window whose id is 731");
    expect(script).toContain(
      'if (count of (tabs of agentWindow whose tty is "/dev/ttys009")) is 0 then return',
    );
    expect(script).toContain(
      "set bounds of agentWindow to {100, 25, 900, 625}",
    );
    expect(script).not.toContain("close");
    expect(script).not.toContain("activate");
  });

  test("positions only the exact iTerm2 session's window", () => {
    const script = buildITerm2SetBoundsOsascript('session-1"\\', {
      x: 0,
      y: 33,
      width: 640,
      height: 480,
    });

    expect(script).toContain(
      'if (unique id of agentSession as text) is "session-1\\"\\\\" then',
    );
    expect(script).toContain("set bounds of agentWindow to {0, 33, 640, 513}");
    expect(script).not.toContain("close");
    expect(script).not.toContain("activate");
  });

  test("finds a Terminal.app window by TTY and returns its identity", () => {
    const script = buildTerminalAppFindWindowByTtyOsascript("/dev/ttys003");

    expect(script).toContain('if application "Terminal" is not running then return ""');
    expect(script).toContain('if (tty of candidateTab as text) is "/dev/ttys003" then');
    expect(script).toContain(
      "return terminalProcessId & (ASCII character 9) & (id of candidateWindow as text)",
    );
    expect(script).not.toContain("close");
  });

  test("finds an iTerm2 session by TTY and returns its unique id", () => {
    const script = buildITerm2FindSessionByTtyOsascript("/dev/ttys003");

    expect(script).toContain('if (tty of candidateSession as text) is "/dev/ttys003" then');
    expect(script).toContain("return unique id of candidateSession as text");
    expect(script).not.toContain("close");
  });

  test("bounds setters ignore handles from the other emulator", async () => {
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    // Wrong-app handles return without running osascript, so these resolve
    // instantly even with no emulator installed.
    await new TerminalAppAdapter().setWindowBounds(
      { app: "iterm2", sessionId: "session-1" },
      frame,
    );
    await new ITerm2Adapter().setWindowBounds(
      { app: "terminal", processId: 1, windowId: 2, tty: "/dev/ttys000" },
      frame,
    );
  });
});

describe("agent terminal titles", () => {
  test("contain only the human name and routed model", () => {
    const title = buildAgentTerminalTitle("maya", "gpt-5-codex");

    expect(title).toEqual("maya — gpt-5-codex");
    expect(title).not.toContain("hive-");
    expect(title).not.toContain("standard");
    expect(title).not.toContain("Build auth API");
    expect(title).not.toContain("/worktrees/");
    expect(title).not.toContain("tmux");
  });
});

describe("resolveTerminal", () => {
  test("honors explicit terminal settings", () => {
    expect(resolveTerminal({ terminal: "iterm2" }) instanceof ITerm2Adapter).toEqual(
      true,
    );
    expect(
      resolveTerminal({ terminal: "terminal" }) instanceof TerminalAppAdapter,
    ).toEqual(true);
  });

  test("auto prefers iTerm2 when it is installed", () => {
    const resolved = resolveTerminal({ terminal: "auto" });
    const expectedName =
      existsSync("/Applications/iTerm.app") ||
      existsSync(join(homedir(), "Applications", "iTerm.app"))
      ? "ITerm2Adapter"
      : "TerminalAppAdapter";
    expect(resolved.constructor.name).toEqual(expectedName);
  });
});
