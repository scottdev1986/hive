import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../../shared/shell-quote";
import { HIVE_CAPABILITY_TOKEN_ENV } from "./shared/capability-env";
import {
  GRAPHIFY_HOOK_SCRIPT,
  graphifyHookPath,
  writeGraphifyHook,
} from "./shared/graphify-hook";
import { daemonMcpUrl } from "./shared/mcp-scope";
import { isRecord, readProjectConfig } from "./shared/project-config";
import { resolveProviderExecutable } from "./shared/provider-executable";
export interface KimiSpawnOptions {
  model: string;
  readOnly: boolean;
  dangerous: boolean;
  executable?: string;
}

export interface KimiAgentConfigOptions {
  daemonPort: number;
  graphifyUrl?: string;
}

export interface KimiTurnHookContext {
  name: string;
  daemonPort: number;
  instanceId: string;
  providerRunId: string;
}

const KIMI_TURN_HOOK_START = "# Hive turn-status hook: begin";
const KIMI_TURN_HOOK_END = "# Hive turn-status hook: end";

export function resolveWorkingKimiExecutable() {
  return resolveProviderExecutable("kimi", [".kimi-code/bin/kimi"]);
}

export function kimiHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.KIMI_CODE_HOME ?? join(env.HOME ?? homedir(), ".kimi-code");
}

/** The user's global kimi config, or null if there is none to read. This file is the only surface kimi exposes for the permission question below, and Hive never writes it — it is the user's. Absent, unreadable, and malformed are one answer here on purpose: each callsite has its own safe reading of "Hive could not tell", and none of them should be guessing at which kind of nothing it got. */
function readKimiConfig(home: string): Record<string, unknown> | null {
  try {
    return Bun.TOML.parse(
      readFileSync(join(home, "config.toml"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Why a Hive read-only Kimi agent may not actually be read-only. Kimi has no per-launch deny channel and no flag that forces `manual` back on; its only permission surface is `[[permission.rules]]` and `default_permission_mode` in the user's global config.toml. Hive manages only its marked lifecycle hook there; that permission gate belongs to the user. So when the user has pinned `yolo` or `auto`, a Hive "read-only" Kimi agent launches with write authority and Hive cannot stop it — it can only refuse to pretend otherwise. Null means containment is not contradicted: either the file names no default (Kimi's own default is `manual`) or it cannot be read, and an unreadable file is reported as unknown by the caller rather than assumed safe. */
export function kimiReadOnlyContainmentGap(
  home: string = kimiHome(),
): string | null {
  const mode = readKimiConfig(home)?.default_permission_mode;
  if (mode !== "yolo" && mode !== "auto") return null;
  return (
    `Kimi read-only is NOT enforced: this user's config.toml pins ` +
    `default_permission_mode = "${mode}", and Kimi offers no per-launch flag ` +
    `or deny channel that can override it. The agent will hold write and shell ` +
    `authority. Hive does not change these permission settings — set ` +
    `default_permission_mode = "manual" (or add [[permission.rules]]) in ` +
    `${join(home, "config.toml")} if this agent must be contained.`
  );
}

/** Hive's (readOnly, dangerous) posture mapped to Kimi's permission modes: - readOnly (Hive "manual") maps to Kimi's default `manual` mode — no flag. Kimi offers no flag to force manual back on, so a user whose config.toml pins `default_permission_mode = "yolo"`/`"auto"` launches a Hive read-only agent under that mode instead; Kimi has no per-launch read-only or per-tool deny channel (its `[[permission.rules]]` live only in the global config.toml, which Hive never changes). - !readOnly maps to `--yolo`: auto-approve regular tool calls while static deny rules stay in force. - dangerous maps to `--auto`: fully autonomous, the agent never asks. `--yolo` and `--auto` are mutually exclusive, and dangerous wins over readOnly exactly as it does for claude. */
function kimiPermissionArgs(readOnly: boolean, dangerous: boolean): string[] {
  if (dangerous) return ["--auto"];
  if (!readOnly) return ["--yolo"];
  return [];
}

function kimiLaunchArgs(options: KimiSpawnOptions): string[] {
  return [
    options.executable ?? "kimi",
    "-m",
    options.model,
    ...kimiPermissionArgs(options.readOnly, options.dangerous),
  ];
}

export function buildKimiSpawnCommand(options: KimiSpawnOptions): string[] {
  return kimiLaunchArgs(options);
}

/** Install the agent's launch prompt as the project instruction file Kimi loads into system context, beside the mcp.json written for the same worktree. Doing this while preparing the worktree, rather than as a `mkdir && install && …` prefix on the launch command, is what keeps the launch command a single command. A leading `VAR=value` shell assignment binds only to the first command it precedes, so a prefixed copy step silently swallowed the capability token and Kimi launched with no bearer for its Hive MCP server. */
export async function writeKimiInstructionFile(
  worktreePath: string,
  instructionPath: string,
): Promise<void> {
  const directory = join(worktreePath, ".kimi-code");
  await mkdir(directory, { recursive: true });
  const target = join(directory, "AGENTS.md");
  await copyFile(instructionPath, target);
  await chmod(target, 0o600);
}

/** Kimi has no interactive `--append-system-prompt`/`--rules` flag, and its TUI rejects a positional prompt ("unknown command"). Kimi 0.29.1 does offer `-p`/`--prompt`, but that runs one non-interactive turn and exits, so it cannot launch Hive's persistent agent. The TUI loads its project instruction file into system context. The opening user turn is submitted separately through sessiond after the TUI is ready. The orchestrator writes its own launch prompt after preparing its config, so it still copies the file at launch time. Its capability reaches the process through a real environment map rather than a shell assignment, so the binding hazard described on writeKimiInstructionFile does not reach it. */
export function wrapKimiWithInstructionFile(
  command: string,
  path: string,
): string {
  const target = ".kimi-code/AGENTS.md";
  const copy = `mkdir -p .kimi-code && install -m 600 ${shellQuote(
    path,
  )} ${shellQuote(target)}`;
  return `${copy} && ${command}`;
}

export function wrapKimiSpawnWithEffort(
  command: string,
  effort: string,
): string {
  return `KIMI_MODEL_THINKING_EFFORT=${shellQuote(effort)} ${command}`;
}

/** Kimi reads hooks only from its user-level config. The one Hive-owned hook is therefore generic; per-agent identity stays in the launch environment so ordinary Kimi sessions cannot report a Hive lifecycle event. */
export function wrapKimiWithTurnHookContext(
  command: string,
  context: KimiTurnHookContext,
): string {
  return [
    `HIVE_AGENT_NAME=${shellQuote(context.name)}`,
    `HIVE_DAEMON_PORT=${shellQuote(String(context.daemonPort))}`,
    `HIVE_INSTANCE_ID=${shellQuote(context.instanceId)}`,
    `HIVE_PROVIDER_RUN_ID=${shellQuote(context.providerRunId)}`,
    command,
  ].join(" ");
}

/** Install the documented Kimi hooks once: Stop, emitted immediately before Kimi returns to its input box (the provider's authoritative turn-idle boundary), and PreToolUse for the graphify gate. Kimi reads hooks only from this user-level config, so the gate entry is generic — it runs the worktree-local hook script when the session's cwd has one and a Hive launch environment is present, and is inert everywhere else. */
export async function writeKimiTurnHook(
  hiveCommand: readonly string[] = ["hive"],
  home = kimiHome(),
): Promise<void> {
  if (hiveCommand.length === 0 || hiveCommand[0] === undefined) {
    throw new Error("Hive command must contain an executable");
  }
  const path = join(home, "config.toml");
  const existing = await readFile(path, "utf8").catch(() => "");
  const command = [
    hiveCommand.map(shellQuote).join(" "),
    "event turn-end",
    '--agent "$HIVE_AGENT_NAME"',
    '--port "$HIVE_DAEMON_PORT"',
    '--instance-id "$HIVE_INSTANCE_ID"',
    '--provider-run-id "$HIVE_PROVIDER_RUN_ID"',
  ].join(" ");
  const gateScript = join(".kimi-code", GRAPHIFY_HOOK_SCRIPT);
  const block = [
    KIMI_TURN_HOOK_START,
    "[[hooks]]",
    'event = "Stop"',
    `command = ${JSON.stringify(
      `if [ -n "$HIVE_AGENT_NAME" ]; then ${command}; fi`,
    )}`,
    "timeout = 5",
    "[[hooks]]",
    'event = "PreToolUse"',
    `command = ${JSON.stringify(
      `if [ -n "$HIVE_AGENT_NAME" ] && [ -x ${gateScript} ]; then exec ${gateScript} kimi; fi`,
    )}`,
    "timeout = 5",
    KIMI_TURN_HOOK_END,
  ].join("\n");
  const withoutExisting = existing
    .replace(
      /\n?# Hive turn-status hook: begin[\s\S]*?# Hive turn-status hook: end\n?/g,
      "\n",
    )
    .trimEnd();
  await mkdir(home, { recursive: true });
  await writeFile(
    path,
    `${withoutExisting}${withoutExisting ? "\n\n" : ""}${block}\n`,
    {
      mode: 0o600,
    },
  );
  await chmod(path, 0o600);
}

/** Write the worktree's `.kimi-code/mcp.json` — Kimi's project-level MCP surface, the analog of claude's `.mcp.json`. Unrelated servers are preserved; the `hive` entry is replaced wholesale and names the environment variable holding the bearer rather than the bearer itself. A missing graphify URL removes a stale entry rather than leaving a dead endpoint behind. */
export async function writeKimiAgentConfig(
  worktreePath: string,
  options: KimiAgentConfigOptions,
): Promise<void> {
  const directory = join(worktreePath, ".kimi-code");
  const path = join(directory, "mcp.json");
  await mkdir(directory, { recursive: true });
  const existing = await readProjectConfig(path);
  const servers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  servers.hive = {
    url: daemonMcpUrl(options.daemonPort),
    // Kimi 0.29.1 reads the bearer from this variable at connect time, so the live token never enters the project tree.
    bearerTokenEnvVar: HIVE_CAPABILITY_TOKEN_ENV,
  };
  if (options.graphifyUrl === undefined) delete servers.graphify;
  else servers.graphify = { url: options.graphifyUrl };
  existing.mcpServers = servers;
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  await writeGraphifyHook(
    graphifyHookPath(worktreePath, ".kimi-code"),
    options.graphifyUrl,
  );
}
