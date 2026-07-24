import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { shellQuote } from "./session-host/tmux-host";
import { getHiveHome } from "./db";

/**
 * Hand the agent its brief through a file, not the tmux command line.
 *
 * tmux carries a command to its server in a single imsg and refuses anything
 * much past 16KB with "command too long" — measured against tmux 3.7b, which
 * accepts 16000 bytes and rejects 20000. That ceiling sits 64x below the 1MB
 * ARG_MAX the design assumed, and Hive's briefs cross it by construction rather
 * than by accident: doc sections are extracted and embedded with file:line
 * pointers, so a brief grows with the repo it describes.
 *
 * Reading the prompt in the launch shell keeps the tmux command a few hundred
 * bytes whatever the brief weighs, and leaves ARG_MAX as the only ceiling. It is
 * the idiom the launch shell already uses to keep a Codex capability token off
 * the command line (wrapCodexSpawnWithCapabilityEnv).
 *
 * The file lives under HIVE_HOME, never in the worktree: a launch must not write
 * into the repository it is about to hand to an agent. One file per tmux session,
 * overwritten on respawn, so prompts cannot accumulate without bound.
 */
export function launchPromptPath(session: string): string {
  return join(getHiveHome(), "runtime", "prompts", `${session}.txt`);
}

export async function writeLaunchPrompt(
  session: string,
  prompt: string,
): Promise<string> {
  const path = launchPromptPath(session);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, prompt, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export function codexInstructionProfileName(session: string): string {
  const safe = session.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  return safe.startsWith("hive-") ? safe : `hive-${safe}`;
}

export function codexHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
}

export function codexInstructionProfilePath(
  session: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(
    codexHome(env),
    `${codexInstructionProfileName(session)}.config.toml`,
  );
}

export async function writeCodexInstructionProfile(
  session: string,
  prompt: string,
): Promise<string> {
  const source = join(
    getHiveHome(),
    "runtime",
    "prompts",
    `${session}.codex.config.toml`,
  );
  await mkdir(dirname(source), { recursive: true, mode: 0o700 });
  await mkdir(codexHome(), { recursive: true, mode: 0o700 });
  await writeFile(
    source,
    `developer_instructions = ${JSON.stringify(prompt)}\n`,
    { mode: 0o600 },
  );
  await chmod(source, 0o600);
  return source;
}

/**
 * Codex profiles must live directly under CODEX_HOME. Install the Hive-owned
 * profile only for the lifetime of this invocation, then remove it. The source
 * remains under HIVE_HOME, so the same shell command can be recalled to launch
 * the TUI again without leaking the instructions into shell history.
 */
export function wrapCodexWithInstructionProfile(
  command: string,
  session: string,
): string {
  const source = join(
    getHiveHome(),
    "runtime",
    "prompts",
    `${session}.codex.config.toml`,
  );
  const destination = codexInstructionProfilePath(session);
  return `install -m 600 ${shellQuote(source)} ${shellQuote(destination)} && (` +
    `trap ${shellQuote(`rm -f ${shellQuote(destination)}`)} EXIT INT TERM; ` +
    `${command})`;
}

/**
 * Expands in the launch shell to exactly one argument, newlines and all.
 *
 * The double quotes are load-bearing: unquoted, the shell would split the brief
 * on whitespace and hand the CLI a few thousand arguments instead of a prompt.
 */
export function promptArgument(path: string): string {
  return `"$(cat ${shellQuote(path)})"`;
}

/** Keep Grok's rules out of the visible shell command while still handing
 * them to the vendor's native --rules system layer. */
export function wrapGrokWithRulesFile(
  command: string,
  path: string,
  initialPrompt?: string,
): string {
  return `exec ${command} --rules ${promptArgument(path)}${
    initialPrompt === undefined ? "" : ` ${shellQuote(initialPrompt)}`
  }`;
}
