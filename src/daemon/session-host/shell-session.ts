import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessiondStateRoot } from "../../hive-home/home";

export const TERMINAL_SHELL = "/bin/zsh";

/**
 * Bootstrap script that runs hive agent-ui on first prompt, then returns control to zsh.
 * Hive-owned .zshrc sourced from ZDOTDIR.
 */
const HIVE_ZSHRC = [
  "# Hive one-shot terminal init",
  "# Source user's real zshrc if it exists",
  'if [[ -f "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zshrc" ]]; then',
  '  source "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zshrc"',
  'elif [[ -f "$HOME/.zshrc" ]]; then',
  '  source "$HOME/.zshrc"',
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

/**
 * Forward to user's .zshenv if it exists.
 * Login zsh reads this from ZDOTDIR before any other files.
 */
const HIVE_ZSHENV = [
  "# Hive ZDOTDIR .zshenv - forward to user's file",
  'if [[ -f "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zshenv" ]]; then',
  '  source "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zshenv"',
  'elif [[ -f "$HOME/.zshenv" ]]; then',
  '  source "$HOME/.zshenv"',
  "fi",
].join("\n");

/**
 * Forward to user's .zprofile if it exists.
 * Login zsh reads this from ZDOTDIR before .zshrc.
 */
const HIVE_ZPROFILE = [
  "# Hive ZDOTDIR .zprofile - forward to user's file",
  'if [[ -f "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zprofile" ]]; then',
  '  source "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zprofile"',
  'elif [[ -f "$HOME/.zprofile" ]]; then',
  '  source "$HOME/.zprofile"',
  "fi",
].join("\n");

/**
 * Forward to user's .zlogin if it exists.
 * Login zsh reads this from ZDOTDIR after .zshrc.
 */
const HIVE_ZLOGIN = [
  "# Hive ZDOTDIR .zlogin - forward to user's file",
  'if [[ -f "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zlogin" ]]; then',
  '  source "${HIVE_USER_ZDOTDIR:+$HIVE_USER_ZDOTDIR/}.zlogin"',
  'elif [[ -f "$HOME/.zlogin" ]]; then',
  '  source "$HOME/.zlogin"',
  "fi",
].join("\n");

export type ShellSessionLaunch = Readonly<{
  argv: readonly [string, ...string[]];
  expectedExecutable: string;
  env: Record<string, string>;
}>;

/**
 * Prepare a Hive-owned ZDOTDIR for this session with init files that:
 * 1. Source the user's real zsh config files (.zshenv, .zprofile, .zshrc, .zlogin)
 * 2. Run `hive agent-ui` on first prompt (one-shot)
 * 3. Leave interactive zsh after agent-ui exits
 * 
 * Returns the ZDOTDIR path to set in environment.
 */
export async function prepareSessionZdotdir(
  sessionId: string,
  hiveHome?: string,
): Promise<string> {
  const zdotdir = join(sessiondStateRoot(hiveHome), "zdotdir", sessionId);
  await mkdir(zdotdir, { recursive: true, mode: 0o700 });
  
  await Promise.all([
    writeFile(join(zdotdir, ".zshenv"), HIVE_ZSHENV, { mode: 0o600 }),
    writeFile(join(zdotdir, ".zshrc"), HIVE_ZSHRC, { mode: 0o600 }),
    writeFile(join(zdotdir, ".zprofile"), HIVE_ZPROFILE, { mode: 0o600 }),
    writeFile(join(zdotdir, ".zlogin"), HIVE_ZLOGIN, { mode: 0o600 }),
  ]);
  
  return zdotdir;
}

/**
 * Spawn a conventional interactive login zsh as the PTY child.
 * The command (hive agent-ui) runs inside that zsh via HIVE_AGENT_UI_COMMAND.
 * When agent-ui exits, the user lands in the same interactive zsh session.
 * 
 * Implementation: Uses a Hive-owned ZDOTDIR with init files that source
 * the user's real config and then launch agent-ui. This keeps the PTY child
 * as a plain `/bin/zsh -l -i` without bootstrap gymnastics.
 * 
 * Caller must call prepareSessionZdotdir() and set ZDOTDIR + HIVE_USER_ZDOTDIR.
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
