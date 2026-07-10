import type { TerminalHandle } from "../schemas";
import { appleScriptString, runOsascript, shellQuote } from "./osascript";
import type { TerminalAdapter } from "./terminal";

export function buildTerminalAppOsascript(
  tmuxSession: string,
  title: string,
): string {
  const command = `tmux attach -t ${shellQuote(`=${tmuxSession}`)}`;

  return [
    'tell application "Terminal"',
    "  activate",
    `  set agentTab to do script "${appleScriptString(command)}"`,
    `  set custom title of agentTab to "${appleScriptString(title)}"`,
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
}
