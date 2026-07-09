import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildITerm2Osascript,
  ITerm2Adapter,
} from "./iterm2";
import {
  buildTerminalAppOsascript,
  TerminalAppAdapter,
} from "./terminal-app";
import { resolveTerminal } from "./terminal";

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
  });

  test("shell-quotes tmux session names", () => {
    const script = buildITerm2Osascript("agent'five", "Agent Five");
    expect(script.includes("'=agent'\\\\''five'")).toEqual(true);
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
