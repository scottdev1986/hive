import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getHiveHome } from "../../hive-home/home";
import { shellQuote } from "../../shared/shell-quote";

function launchPromptDirectory(): string {
  return join(getHiveHome(), "runtime", "prompts");
}

/** Hand the agent its brief through a file, not the provider command line. Reading the prompt from a private file keeps the launch command small whatever the brief weighs and leaves ARG_MAX as the only ceiling. It is the idiom the launch shell already uses to keep a Codex capability token off the command line (wrapCodexSpawnWithCapabilityEnv). The file lives under HIVE_HOME, never in the worktree: a launch must not write into the repository it is about to hand to an agent. One file per session, overwritten on respawn, so prompts cannot accumulate without bound. */
export function launchPromptPath(session: string): string {
  return join(launchPromptDirectory(), `${session}.txt`);
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
  const source = join(launchPromptDirectory(), `${session}.codex.config.toml`);
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

export function promptArgument(path: string): string {
  return `"$(cat ${shellQuote(path)})"`;
}

export function wrapGrokWithRulesFile(
  command: string,
  path: string,
  initialPrompt?: string,
): string {
  return `${command} --rules ${promptArgument(path)}${
    initialPrompt === undefined ? "" : ` ${shellQuote(initialPrompt)}`
  }`;
}
