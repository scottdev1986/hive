import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sessiondStateRoot } from "../../hive-home/home";

export const TERMINAL_SHELL = "/bin/zsh";
export const SHELL_SESSION_TTY_READY_WAIT_MS = 2_000;

export type ShellSessionLaunch = Readonly<{
  argv: readonly [string, ...string[]];
  expectedExecutable: string;
  env: Record<string, string>;
  /** String Ghostty execs. Agent-ui first; user's shell after it exits. */
  ghosttyCommand: string;
}>;

function afterTuiShell(): string {
  return `exec "\${SHELL:-${TERMINAL_SHELL}}"`;
}

/**
 * Ghostty command: run `command` (agent-ui) immediately, then replace the
 * process with the user's shell. Empty command is a headless pane — just the
 * shell. No login zsh and no Hive ZDOTDIR.
 *
 * On macOS Ghostty wraps this as `exec -l <command>`. `exec -l` treats a
 * leading `VAR=value` as the program name, and spawned agents prefix
 * `HIVE_CAPABILITY_TOKEN="$(cat …)"`. `/usr/bin/env` is a real binary so
 * that assignment still reaches the child.
 */
export function shellSessionLaunch(command: string): ShellSessionLaunch {
  if (command.includes("\0")) {
    throw new Error("terminal command contains a NUL byte");
  }
  const ghosttyCommand =
    command === ""
      ? `"\${SHELL:-${TERMINAL_SHELL}}"`
      : `/usr/bin/env ${command}; ${afterTuiShell()}`;
  return {
    argv: ["/bin/sh", "-c", ghosttyCommand],
    expectedExecutable: "/bin/sh",
    env: {},
    ghosttyCommand,
  };
}

/** What Ghostty execs. Daemon prepares this; the Workspace pane is the only PTY. */
export const TerminalLaunchSpecSchema = z
  .strictObject({
    cwd: z.string().min(1),
    command: z.string().min(1),
    environment: z.record(z.string(), z.string()),
  })
  .readonly();

export type TerminalLaunchSpec = z.infer<typeof TerminalLaunchSpecSchema>;

function terminalLaunchPath(sessionId: string): string {
  return join(sessiondStateRoot(), "launch", `${sessionId}.json`);
}

export async function writeTerminalLaunchSpec(
  sessionId: string,
  spec: TerminalLaunchSpec,
): Promise<void> {
  const path = terminalLaunchPath(sessionId);
  await mkdir(join(sessiondStateRoot(), "launch"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
}

export function readTerminalLaunchSpec(
  sessionId: string,
): TerminalLaunchSpec | null {
  const path = terminalLaunchPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return TerminalLaunchSpecSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    );
  } catch {
    return null;
  }
}
