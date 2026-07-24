export const TERMINAL_SHELL = "/bin/zsh";

const SHELL_BOOTSTRAP = [
  'hive_terminal_command="$1"',
  'if [[ -n "${HISTFILE:-}" ]]; then',
  '  print -s -- "$hive_terminal_command"',
  '  fc -AI "$HISTFILE" 2>/dev/null || true',
  "fi",
  'eval "$hive_terminal_command"',
  `exec ${TERMINAL_SHELL} -l -i`,
].join("\n");

export type ShellSessionLaunch = Readonly<{
  argv: readonly [string, ...string[]];
  expectedExecutable: string;
  initialInput: Uint8Array;
}>;

/** Run the provider from login zsh, then leave an ordinary login zsh behind. */
export function shellSessionLaunch(command: string): ShellSessionLaunch {
  if (command.includes("\0")) {
    throw new Error("terminal command contains a NUL byte");
  }
  return {
    argv: [
      TERMINAL_SHELL,
      "-l",
      "-i",
      "-c",
      SHELL_BOOTSTRAP,
      "hive-terminal",
      command,
    ],
    expectedExecutable: TERMINAL_SHELL,
    initialInput: new Uint8Array(),
  };
}
