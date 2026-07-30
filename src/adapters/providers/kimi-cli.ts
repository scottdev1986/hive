import { type Dirent, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { shellQuote } from "../../daemon/session-host/shell-session";
import { HIVE_CAPABILITY_TOKEN_ENV } from "./shared/capability-env";
import {
  GRAPHIFY_HOOK_SCRIPT,
  graphifyHookPath,
  writeGraphifyHook,
} from "./shared/graphify-hook";
import { isRecord, readProjectConfig } from "./shared/project-config";
import { resolveProviderExecutable } from "./shared/provider-executable";
import {
  invalidRecoveryArtifactEvidence,
  isMissingRecoveryArtifact,
  type RecoverySessionArtifact,
  recoveryArtifactTimestamp,
  selectRecoverySessionId,
} from "./shared/recovery-session";

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

/** The kimi CLI's data root: `$KIMI_CODE_HOME`, defaulting to ~/.kimi-code. */
export function kimiHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.KIMI_CODE_HOME ?? join(env.HOME ?? homedir(), ".kimi-code");
}

/**
 * The operator's global kimi config, or null if there is none to read.
 *
 * This file is the only surface kimi exposes for either of the two questions
 * below, and Hive never writes it — it is the user's. Absent, unreadable, and
 * malformed are one answer here on purpose: each callsite has its own safe
 * reading of "Hive could not tell", and none of them should be guessing at
 * which kind of nothing it got.
 */
function readKimiConfig(home: string): Record<string, unknown> | null {
  try {
    return Bun.TOML.parse(
      readFileSync(join(home, "config.toml"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The effective default an unflagged launch runs: `default_model` from the
 * config file. Kimi has no CLI surface that reports it (`kimi provider list`
 * prints the catalog, not the default), so the file is the surface.
 */
export function probeKimiDefaultModel(
  home: string = kimiHome(),
): string | null {
  const model = readKimiConfig(home)?.default_model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

/**
 * Why a Hive read-only Kimi agent may not actually be read-only.
 *
 * Kimi has no per-launch deny channel and no flag that forces `manual` back on;
 * its only permission surface is `[[permission.rules]]` and
 * `default_permission_mode` in the operator's global config.toml. Hive manages
 * only its marked lifecycle hook there; that permission gate belongs to the
 * user. So when the operator has
 * pinned `yolo` or `auto`, a Hive "read-only" Kimi agent launches with write
 * authority and Hive cannot stop it — it can only refuse to pretend otherwise.
 *
 * Null means containment is not contradicted: either the file names no default
 * (Kimi's own default is `manual`) or it cannot be read, and an unreadable file
 * is reported as unknown by the caller rather than assumed safe.
 */
export function kimiReadOnlyContainmentGap(
  home: string = kimiHome(),
): string | null {
  const mode = readKimiConfig(home)?.default_permission_mode;
  if (mode !== "yolo" && mode !== "auto") return null;
  return (
    `Kimi read-only is NOT enforced: this operator's config.toml pins ` +
    `default_permission_mode = "${mode}", and Kimi offers no per-launch flag ` +
    `or deny channel that can override it. The agent will hold write and shell ` +
    `authority. Hive does not change these permission settings — set ` +
    `default_permission_mode = "manual" (or add [[permission.rules]]) in ` +
    `${join(home, "config.toml")} if this agent must be contained.`
  );
}

/**
 * Hive's (readOnly, dangerous) posture mapped to Kimi's permission modes:
 *
 * - readOnly (Hive "manual") maps to Kimi's default `manual` mode — no flag.
 *   Kimi offers no flag to force manual back on, so an operator whose
 *   config.toml pins `default_permission_mode = "yolo"`/`"auto"` launches a
 *   Hive read-only agent under that mode instead; Kimi has no per-launch
 *   read-only or per-tool deny channel (its `[[permission.rules]]` live only
 *   in the global config.toml, which Hive never changes).
 * - !readOnly maps to `--yolo`: auto-approve regular tool calls while static
 *   deny rules stay in force.
 * - dangerous maps to `--auto`: fully autonomous, the agent never asks.
 *   `--yolo` and `--auto` are mutually exclusive, and dangerous wins over
 *   readOnly exactly as it does for claude.
 */
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

/** Resume the exact durable session. `--session <id>` opens it directly. */
export function buildKimiResumeCommand(
  options: KimiSpawnOptions,
  sessionId: string,
): string[] {
  const argv = kimiLaunchArgs(options);
  argv.splice(1, 0, "--session", sessionId);
  return argv;
}

/**
 * Kimi has no interactive `--append-system-prompt`/`--rules` flag, and its TUI
 * rejects a positional prompt ("unknown command"). Kimi 0.29.1 does offer
 * `-p`/`--prompt`, but that runs one non-interactive turn and exits, so it
 * cannot launch Hive's persistent agent. The TUI loads its project instruction
 * file into system context. The opening user turn is submitted separately
 * through sessiond after the TUI is ready.
 */
export function wrapKimiWithInstructionFile(
  command: string,
  path: string,
): string {
  const target = ".kimi-code/AGENTS.md";
  const copy = `mkdir -p .kimi-code && install -m 600 ${shellQuote(
    path,
  )} ${shellQuote(target)}`;
  // No `exec` here: the wrapped command may carry an env-assignment prefix
  // (wrapKimiSpawnWithEffort), which `exec` would try to run as a program.
  return `${copy} && ${command}`;
}

/**
 * Kimi has no effort CLI flag; `KIMI_MODEL_THINKING_EFFORT` forces the
 * thinking effort on the wire for this process only (kimi provider models
 * only), which is the per-launch channel Hive's effort routing needs.
 */
export function wrapKimiSpawnWithEffort(
  command: string,
  effort: string,
): string {
  return `KIMI_MODEL_THINKING_EFFORT=${shellQuote(effort)} ${command}`;
}

/**
 * Kimi reads hooks only from its user-level config. The one Hive-owned hook is
 * therefore generic; per-agent identity stays in the launch environment so
 * ordinary Kimi sessions cannot report a Hive lifecycle event.
 */
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

/**
 * Install the documented Kimi hooks once: Stop, emitted immediately before
 * Kimi returns to its input box (the provider's authoritative turn-idle
 * boundary), and PreToolUse for the graphify gate. Kimi reads hooks only from
 * this user-level config, so the gate entry is generic — it runs the
 * worktree-local hook script when the session's cwd has one and a Hive launch
 * environment is present, and is inert everywhere else.
 */
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
    // Kimi runs hook commands in the session's cwd with the tool-call JSON on
    // stdin, and honors hookSpecificOutput.permissionDecision "deny" — the
    // exact contract the generated script emits. `exec` hands that stdin
    // through untouched.
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

/**
 * Write the worktree's `.kimi-code/mcp.json` — Kimi's project-level MCP
 * surface, the analog of claude's `.mcp.json`. Unrelated servers are
 * preserved; the `hive` entry is replaced wholesale and names the environment
 * variable holding the bearer rather than the bearer itself. A missing graphify
 * URL removes a stale entry rather than leaving a dead endpoint behind.
 */
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
    url: `http://127.0.0.1:${options.daemonPort}/mcp`,
    // Kimi 0.29.1 reads the bearer from this variable at connect time, so the
    // live token never enters the project tree.
    bearerTokenEnvVar: HIVE_CAPABILITY_TOKEN_ENV,
  };
  if (options.graphifyUrl === undefined) delete servers.graphify;
  else servers.graphify = { url: options.graphifyUrl };
  existing.mcpServers = servers;
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile's mode only applies at creation, and Hive rewrites whatever
  // mcp.json the project already had — including any credentials the user's own
  // servers keep in it.
  await chmod(path, 0o600);
  // The gate script the user-level PreToolUse hook (writeKimiTurnHook) runs
  // when the session's cwd holds one; a missing URL removes it and its marker.
  await writeGraphifyHook(
    graphifyHookPath(worktreePath, ".kimi-code"),
    options.graphifyUrl,
  );
}

export function kimiSessionsDirectory(home = kimiHome()): string {
  return join(home, "sessions");
}

/**
 * The session's own directory under the sessions root, or null when no project
 * directory holds it. The layout is `sessions/<wd_key>/<session_id>/` and the
 * `wd_<name>_<hash>` segment is the CLI's own derivation, so the id is found
 * by scanning project directories rather than re-deriving the hash.
 */
export async function findKimiSessionDirectory(
  toolSessionId: string,
  home?: string,
): Promise<string | null> {
  const root = kimiSessionsDirectory(home);
  let projects: Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = join(root, project.name, toolSessionId);
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {}
  }
  return null;
}

interface KimiSessionLocation {
  id: string;
  createdAt: unknown;
  path: string;
}

/**
 * Every session whose own state.json records this exact worktree as workDir.
 * The layout is `sessions/<wd_key>/<session_id>/state.json` with
 * `{createdAt, workDir}` — the session_index.jsonl at the home root carries
 * no creation time, so the state file is the creation evidence.
 */
async function findKimiSessions(
  worktreePath: string,
  home?: string,
  strictEvidence = false,
): Promise<KimiSessionLocation[]> {
  const target = resolve(worktreePath);
  const root = kimiSessionsDirectory(home);
  let projects: Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (strictEvidence && !isMissingRecoveryArtifact(error)) {
      invalidRecoveryArtifactEvidence(
        "Kimi",
        root,
        "sessions directory cannot be read",
      );
    }
    return [];
  }
  const sessions: KimiSessionLocation[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, project.name), {
        withFileTypes: true,
      });
    } catch (error) {
      if (strictEvidence && !isMissingRecoveryArtifact(error)) {
        invalidRecoveryArtifactEvidence(
          "Kimi",
          join(root, project.name),
          "project directory cannot be read",
        );
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = join(root, project.name, entry.name, "state.json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(statePath, "utf8"));
      } catch (error) {
        if (strictEvidence && !isMissingRecoveryArtifact(error)) {
          invalidRecoveryArtifactEvidence(
            "Kimi",
            statePath,
            "cannot be read as session state",
          );
        }
        continue;
      }
      if (
        !isRecord(parsed) ||
        typeof parsed.workDir !== "string" ||
        parsed.workDir !== target
      )
        continue;
      sessions.push({
        id: entry.name,
        createdAt: parsed.createdAt,
        path: statePath,
      });
    }
  }
  return sessions;
}

export async function discoverKimiRecoverySessionId(
  worktreePath: string,
  agentCreatedAt: string,
  home?: string,
): Promise<string | null> {
  const artifacts: RecoverySessionArtifact[] = (
    await findKimiSessions(worktreePath, home, true)
  ).map((session) => ({
    sessionId: session.id,
    createdAtMs: recoveryArtifactTimestamp(
      "Kimi",
      session.path,
      session.createdAt,
    ),
    path: session.path,
  }));
  return selectRecoverySessionId("Kimi", agentCreatedAt, artifacts);
}
