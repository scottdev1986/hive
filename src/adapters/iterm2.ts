import type { TerminalAdapter } from "./terminal";

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const appleScriptString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");

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
    "  end tell",
    "end tell",
  ].join("\n");
}

export const buildITerm2Script = buildITerm2Osascript;

export class ITerm2Adapter implements TerminalAdapter {
  async openWindow(tmuxSession: string, title: string): Promise<void> {
    const process = Bun.spawn(
      ["osascript", "-e", buildITerm2Osascript(tmuxSession, title)],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `could not open iTerm2 window: ${stderr.trim() || `exit code ${exitCode}`}`,
      );
    }
  }
}
