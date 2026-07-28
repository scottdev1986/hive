export const TERMINAL_SHELL = "/bin/zsh";

const SHELL_BOOTSTRAP = [
  'hive_terminal_command="$1"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: This is a literal zsh expression.
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

/** Quote unconditionally. Use when the result is compared byte-for-byte
 * later — an entry Hive writes and then recognises again — because a value
 * that starts safe and later gains a space would otherwise change spelling
 * and stop matching what is already on disk. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quote only when the value needs it. Use for text a human reads: an agent's
 * settings file and its hook commands are opened and edited by hand, and
 * quoting every already-safe path makes them harder to read for no gain. */
export function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return shellQuote(value);
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

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
