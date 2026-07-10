import type { TerminalHandle } from "../schemas";
import type { Frame } from "./layout";
import { appleScriptString, runOsascript, shellQuote } from "./osascript";
import type { TerminalAdapter } from "./terminal";

export const TERMINAL_APP_PROFILE_PATH =
  `${import.meta.dir}/hive-agent-v1.terminal`;
export const TERMINAL_APP_PROFILE_NAME = "hive-agent-v1";

export function buildTerminalAppOsascript(
  tmuxSession: string,
  title: string,
  profilePath = TERMINAL_APP_PROFILE_PATH,
  profileName = TERMINAL_APP_PROFILE_NAME,
): string {
  const command = `tmux attach -t ${shellQuote(`=${tmuxSession}`)}`;

  return [
    'tell application "Terminal"',
    "  activate",
    `  if exists settings set "${appleScriptString(profileName)}" then`,
    '    set agentTab to do script ""',
    "    set agentWindow to first window whose selected tab is agentTab",
    `    set current settings of agentTab to settings set "${appleScriptString(profileName)}"`,
    "  else",
    "    set existingWindowIds to id of every window",
    `    open POSIX file "${appleScriptString(profilePath)}"`,
    "    set agentWindow to missing value",
    "    repeat 100 times",
    "      delay 0.05",
    "      repeat with candidateWindow in every window",
    "        if id of candidateWindow is not in existingWindowIds and (count tabs of candidateWindow) > 0 then",
    "          set agentWindow to candidateWindow",
    "          exit repeat",
    "        end if",
    "      end repeat",
    "      if agentWindow is not missing value then exit repeat",
    "    end repeat",
    "    if agentWindow is missing value then error \"could not identify created Terminal window\"",
    "    set agentTab to selected tab of agentWindow",
    "  end if",
    `  do script "${appleScriptString(command)}" in agentTab`,
    `  set custom title of agentTab to "${appleScriptString(title)}"`,
    "  set title displays custom title of agentTab to true",
    // Terminal activates windows asynchronously. The newly created tab is not
    // guaranteed to belong to `front window` yet, particularly when several
    // agents launch close together or the user changes focus during launch.
    // Associate the window through the exact tab object returned by `do script`.
    "  set agentWindow to first window whose selected tab is agentTab",
    "  set agentWindowId to id of agentWindow as text",
    "  set agentTty to tty of agentTab",
    "end tell",
    'set terminalProcessId to do shell script "/usr/bin/pgrep -x Terminal"',
    "return terminalProcessId & (ASCII character 9) & agentWindowId & (ASCII character 9) & agentTty",
  ].join("\n");
}

export const buildTerminalAppScript = buildTerminalAppOsascript;

export function buildTerminalAppCloseOsascript(
  processId: number,
  windowId: number,
  tty: string,
): string {
  return [
    'if application "Terminal" is not running then return',
    'set terminalProcessId to do shell script "/usr/bin/pgrep -x Terminal"',
    `if terminalProcessId is not "${processId}" then return`,
    'tell application "Terminal"',
    "  try",
    `    set agentWindow to first window whose id is ${windowId}`,
    "  on error",
    "    return",
    "  end try",
    "  if (count of tabs of agentWindow) is not 1 then return",
    `  if (tty of selected tab of agentWindow) is not "${appleScriptString(tty)}" then return`,
    "  close agentWindow",
    "end tell",
  ].join("\n");
}

// Positioning uses the same identity triple as closing (app PID, window id,
// TTY) so a recycled window id can never move an unrelated window. Unlike
// closing it accepts extra tabs: any tab on the recorded TTY proves identity,
// and moving a window the user added tabs to is harmless.
export function buildTerminalAppSetBoundsOsascript(
  processId: number,
  windowId: number,
  tty: string,
  frame: Frame,
): string {
  const bounds = `{${frame.x}, ${frame.y}, ${frame.x + frame.width}, ${
    frame.y + frame.height
  }}`;
  return [
    'if application "Terminal" is not running then return',
    'set terminalProcessId to do shell script "/usr/bin/pgrep -x Terminal"',
    `if terminalProcessId is not "${processId}" then return`,
    'tell application "Terminal"',
    "  try",
    `    set agentWindow to first window whose id is ${windowId}`,
    "  on error",
    "    return",
    "  end try",
    `  if (count of (tabs of agentWindow whose tty is "${
      appleScriptString(tty)
    }")) is 0 then return`,
    `  set bounds of agentWindow to ${bounds}`,
    "end tell",
  ].join("\n");
}

export function buildTerminalAppFindWindowByTtyOsascript(tty: string): string {
  return [
    'if application "Terminal" is not running then return ""',
    'set terminalProcessId to do shell script "/usr/bin/pgrep -x Terminal"',
    'tell application "Terminal"',
    "  repeat with candidateWindow in windows",
    "    repeat with candidateTab in tabs of candidateWindow",
    `      if (tty of candidateTab as text) is "${
      appleScriptString(tty)
    }" then`,
    "        return terminalProcessId & (ASCII character 9) & (id of candidateWindow as text)",
    "      end if",
    "    end repeat",
    "  end repeat",
    "end tell",
    'return ""',
  ].join("\n");
}

export class TerminalAppAdapter implements TerminalAdapter {
  async openWindow(
    tmuxSession: string,
    title: string,
  ): Promise<TerminalHandle> {
    const output = await runOsascript(
      buildTerminalAppOsascript(tmuxSession, title),
      "open Terminal.app window",
    );
    const [processIdText, windowIdText, tty, ...extra] = output.split("\t");
    const processId = Number(processIdText);
    const windowId = Number(windowIdText);
    if (
      !Number.isSafeInteger(processId) || processId <= 0 ||
      !Number.isSafeInteger(windowId) || windowId <= 0 || tty === undefined ||
      tty.length === 0 || extra.length > 0
    ) {
      throw new Error(
        "could not open Terminal.app window: invalid window handle returned",
      );
    }
    return { app: "terminal", processId, windowId, tty };
  }

  async closeWindow(handle: TerminalHandle): Promise<void> {
    if (handle.app !== "terminal") {
      return;
    }
    await runOsascript(
      buildTerminalAppCloseOsascript(
        handle.processId,
        handle.windowId,
        handle.tty,
      ),
      "close Terminal.app window",
    );
  }

  async setWindowBounds(handle: TerminalHandle, frame: Frame): Promise<void> {
    if (handle.app !== "terminal") {
      return;
    }
    await runOsascript(
      buildTerminalAppSetBoundsOsascript(
        handle.processId,
        handle.windowId,
        handle.tty,
        frame,
      ),
      "position Terminal.app window",
    );
  }

  async captureWindowByTty(tty: string): Promise<TerminalHandle | null> {
    const output = await runOsascript(
      buildTerminalAppFindWindowByTtyOsascript(tty),
      "find Terminal.app window",
    );
    if (output.length === 0) {
      return null;
    }
    const [processIdText, windowIdText, ...extra] = output.split("\t");
    const processId = Number(processIdText);
    const windowId = Number(windowIdText);
    if (
      !Number.isSafeInteger(processId) || processId <= 0 ||
      !Number.isSafeInteger(windowId) || windowId <= 0 || extra.length > 0
    ) {
      return null;
    }
    return { app: "terminal", processId, windowId, tty };
  }
}
