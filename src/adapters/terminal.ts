import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HiveConfig } from "../schemas";
import { ITerm2Adapter } from "./iterm2";
import { TerminalAppAdapter } from "./terminal-app";

export interface TerminalAdapter {
  openWindow(tmuxSession: string, title: string): Promise<void>;
}

export function buildAgentTerminalTitle(name: string, model: string): string {
  return `${name} — ${model}`;
}

export function resolveTerminal(
  config: Pick<HiveConfig, "terminal">,
): TerminalAdapter {
  if (config.terminal === "iterm2") {
    return new ITerm2Adapter();
  }
  if (config.terminal === "terminal") {
    return new TerminalAppAdapter();
  }

  return existsSync("/Applications/iTerm.app") ||
    existsSync(join(homedir(), "Applications", "iTerm.app"))
    ? new ITerm2Adapter()
    : new TerminalAppAdapter();
}

export { ITerm2Adapter, TerminalAppAdapter };
