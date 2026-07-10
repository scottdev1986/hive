import type { TerminalHandle } from "../schemas";
import type { Frame } from "./layout";
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

// The window is located through the globally unique session id — the same
// identity the close script trusts — so bounds can never land on an
// unrelated window.
export function buildITerm2SetBoundsOsascript(
  sessionId: string,
  frame: Frame,
): string {
  const escapedSessionId = appleScriptString(sessionId);
  const bounds = `{${frame.x}, ${frame.y}, ${frame.x + frame.width}, ${
    frame.y + frame.height
  }}`;
  return [
    'tell application "iTerm2"',
    "  if not running then return",
    "  repeat with agentWindow in windows",
    "    repeat with agentTab in tabs of agentWindow",
    "      repeat with agentSession in sessions of agentTab",
    `        if (unique id of agentSession as text) is "${escapedSessionId}" then`,
    `          set bounds of agentWindow to ${bounds}`,
    "          return",
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    "end tell",
  ].join("\n");
}

export function buildITerm2FindSessionByTtyOsascript(tty: string): string {
  const escapedTty = appleScriptString(tty);
  return [
    'tell application "iTerm2"',
    '  if not running then return ""',
    "  repeat with candidateWindow in windows",
    "    repeat with candidateTab in tabs of candidateWindow",
    "      repeat with candidateSession in sessions of candidateTab",
    `        if (tty of candidateSession as text) is "${escapedTty}" then`,
    "          return unique id of candidateSession as text",
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    "end tell",
    'return ""',
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

  async setWindowBounds(handle: TerminalHandle, frame: Frame): Promise<void> {
    if (handle.app !== "iterm2") {
      return;
    }
    await runOsascript(
      buildITerm2SetBoundsOsascript(handle.sessionId, frame),
      "position iTerm2 window",
    );
  }

  async captureWindowByTty(tty: string): Promise<TerminalHandle | null> {
    const sessionId = await runOsascript(
      buildITerm2FindSessionByTtyOsascript(tty),
      "find iTerm2 window",
    );
    return sessionId.length === 0 ? null : { app: "iterm2", sessionId };
  }
}
