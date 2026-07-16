import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shellJoin, shellQuote } from "../adapters/tmux";
import type { CodexSessionBootstrap } from "../adapters/tools/codex";
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

export interface CodexLaunchArtifacts {
  developerPath: string;
  userPath?: string;
}

export function codexDeveloperPromptPath(session: string): string {
  return join(getHiveHome(), "runtime", "prompts", `${session}.developer.toml`);
}

export function codexUserPromptPath(session: string): string {
  return join(getHiveHome(), "runtime", "prompts", `${session}.user.txt`);
}

async function preparePromptDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function writeCodexSessionBootstrap(
  session: string,
  bootstrap: CodexSessionBootstrap,
): Promise<CodexLaunchArtifacts> {
  const developerPath = codexDeveloperPromptPath(session);
  const userPath = codexUserPromptPath(session);
  await preparePromptDirectory(developerPath);
  await writeFile(
    developerPath,
    `developer_instructions=${JSON.stringify(bootstrap.developerInstructions)}`,
    { mode: 0o600 },
  );
  await chmod(developerPath, 0o600);
  if (bootstrap.initialUserPrompt === undefined) {
    await rm(userPath, { force: true });
    return { developerPath };
  }
  await writeFile(userPath, bootstrap.initialUserPrompt, { mode: 0o600 });
  await chmod(userPath, 0o600);
  return { developerPath, userPath };
}

export async function writeCodexUserPrompt(
  session: string,
  prompt: string,
): Promise<string> {
  const path = codexUserPromptPath(session);
  await preparePromptDirectory(path);
  await writeFile(path, prompt, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function readCodexDeveloperInstructions(
  path: string,
): Promise<string> {
  const parsed = Bun.TOML.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  const value = parsed.developer_instructions;
  if (typeof value !== "string") {
    throw new Error(`Invalid Codex developer instruction artifact: ${path}`);
  }
  return value;
}

export async function writeLaunchPrompt(
  session: string,
  prompt: string,
): Promise<string> {
  const path = launchPromptPath(session);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, prompt, { mode: 0o600 });
  return path;
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

/** One ordered Codex TUI carrier for fresh, fallback, control, and resume. */
export function buildCodexTuiShellCommand(
  optionArguments: readonly string[],
  artifacts: CodexLaunchArtifacts,
  positionalArguments: readonly string[] = [],
): string {
  return `${shellJoin([...optionArguments])} -c ${
    promptArgument(artifacts.developerPath)
  }${
    positionalArguments.length === 0
      ? ""
      : ` ${shellJoin([...positionalArguments])}`
  }${
    artifacts.userPath === undefined ? "" : ` ${promptArgument(artifacts.userPath)}`
  }`;
}
