import type { TerminalHandle } from "../schemas";
import { appleScriptString, runOsascript, shellQuote } from "./osascript";
import type { TerminalAdapter } from "./terminal";

export function buildITerm2Osascript(
  tmuxSession: string,
  title: string,
): string {
  const command = `tmux attach -t ${shellQuote(`=${tmuxSession}`)}`;

  return [
    'tell application "iTerm2"',
    "  activate",
    "  set agentWindow to (create window with default profile)",
    "  tell current session of agentWindow",
    `    set name to "${appleScriptString(title)}"`,
    `    write text "${appleScriptString(command)}"`,
    "    set agentSessionId to unique id",
    "  end tell",
    "  return agentSessionId",
    "end tell",
  ].join("\n");
}

export const buildITerm2Script = buildITerm2Osascript;

export function buildITerm2CloseOsascript(sessionId: string): string {
  const escapedSessionId = appleScriptString(sessionId);
  return [
    'tell application "iTerm2"',
    "  if not running then return",
    "  repeat with agentWindow in windows",
    "    repeat with agentTab in tabs of agentWindow",
    "      repeat with agentSession in sessions of agentTab",
    `        if (unique id of agentSession as text) is "${escapedSessionId}" then`,
    "          close agentSession",
    "          return",
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    "end tell",
  ].join("\n");
}

export class ITerm2Adapter implements TerminalAdapter {
  async openWindow(
    tmuxSession: string,
    title: string,
  ): Promise<TerminalHandle> {
    const sessionId = await runOsascript(
      buildITerm2Osascript(tmuxSession, title),
      "open iTerm2 window",
    );
    if (sessionId.length === 0) {
      throw new Error("could not open iTerm2 window: no session id returned");
    }
    return { app: "iterm2", sessionId };
  }

  async closeWindow(handle: TerminalHandle): Promise<void> {
    if (handle.app !== "iterm2") {
      return;
    }
    await runOsascript(
      buildITerm2CloseOsascript(handle.sessionId),
      "close iTerm2 window",
    );
  }
}
