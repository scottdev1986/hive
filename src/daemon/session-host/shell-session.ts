export const TERMINAL_SHELL = "/bin/zsh";

/**
 * Bootstrap script to run `hive agent-ui` on startup, then remain as interactive zsh.
 * Written into a one-shot ZDOTDIR init file so it runs automatically without
 * clobbering the user's real zshrc. After agent-ui exits, the user lands in the
 * same interactive zsh session.
 */
const HIVE_ZSHRC_INIT = [
  "# Hive one-shot terminal init",
  "# Source user's real zshrc if it exists",
  'if [[ -f "${HIVE_USER_ZDOTDIR:-$HOME}/.zshrc" ]]; then',
  '  source "${HIVE_USER_ZDOTDIR:-$HOME}/.zshrc"',
  "fi",
  "",
  "# Run hive agent-ui on first prompt (one-shot)",
  'if [[ "${HIVE_TUI_LAUNCHED:-}" != "1" ]]; then',
  "  export HIVE_TUI_LAUNCHED=1",
  '  if [[ -n "${HIVE_AGENT_UI_COMMAND:-}" ]]; then',
  '    eval "$HIVE_AGENT_UI_COMMAND"',
  "  fi",
  "fi",
].join("\n");

export type ShellSessionLaunch = Readonly<{
  argv: readonly [string, ...string[]];
  expectedExecutable: string;
  env: Record<string, string>;
}>;

/**
 * Spawn a conventional interactive login zsh as the PTY child.
 * The command (hive agent-ui) runs inside that zsh via HIVE_AGENT_UI_COMMAND.
 * When agent-ui exits, the user lands in the same interactive zsh session.
 * 
 * Implementation: Uses a Hive-owned ZDOTDIR with a one-shot .zshrc that sources
 * the user's real zshrc and then launches agent-ui. This keeps the PTY child
 * as a plain `/bin/zsh -l -i` without bootstrap gymnastics.
 */
export function shellSessionLaunch(command: string): ShellSessionLaunch {
  if (command.includes("\0")) {
    throw new Error("terminal command contains a NUL byte");
  }
  return {
    argv: [TERMINAL_SHELL, "-l", "-i"],
    expectedExecutable: TERMINAL_SHELL,
    env: {
      HIVE_AGENT_UI_COMMAND: command,
      HIVE_TUI_LAUNCHED: "0",
    },
  };
}
