import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildITerm2CloseOsascript,
  buildITerm2Osascript,
  ITerm2Adapter,
} from "./iterm2";
import {
  buildTerminalAppCloseOsascript,
  buildTerminalAppOsascript,
  TerminalAppAdapter,
} from "./terminal-app";
import { buildAgentTerminalTitle, resolveTerminal } from "./terminal";

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
    const script = buildTerminalAppOsascript("hive-agent-4", "Agent Four");

    expect(script.includes('tell application "Terminal"')).toEqual(true);
    expect(script.includes("tmux attach -t '=hive-agent-4'")).toEqual(true);
    expect(
      script.includes('set agentTab to do script "tmux attach'),
    ).toEqual(true);
    expect(
      script.includes('set custom title of agentTab to "Agent Four"'),
    ).toEqual(true);
    expect(
      script.includes(
        "return terminalProcessId & (ASCII character 9) & agentWindowId & (ASCII character 9) & agentTty",
      ),
    ).toEqual(true);
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
