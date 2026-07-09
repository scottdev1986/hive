import type { TerminalAdapter } from "./terminal";

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const appleScriptString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");

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
    "end tell",
  ].join("\n");
}

export const buildTerminalAppScript = buildTerminalAppOsascript;

export class TerminalAppAdapter implements TerminalAdapter {
  async openWindow(tmuxSession: string, title: string): Promise<void> {
    const process = Bun.spawn(
      ["osascript", "-e", buildTerminalAppOsascript(tmuxSession, title)],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `could not open Terminal.app window: ${stderr.trim() || `exit code ${exitCode}`}`,
      );
    }
  }
}
