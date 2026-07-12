import {
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CodexRoute } from "../../schemas";
import { buildCodexMcpExclusionArgs, HIVE_MCP_SERVERS } from "./mcp-scope";
import { graphifyHookPath, writeGraphifyHook } from "./graphify-hook";

export interface CodexSpawnOptions {
  name: string;
  model: CodexRoute["model"];
  effort: NonNullable<CodexRoute["effort"]>;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  /** Writer autonomy: no human input required. Uses the config-override form
   * (approval_policy "never", sandbox_mode "danger-full-access" — values
   * verified against codex 0.144.0, where the pair renders as "YOLO mode")
   * so spawn and resume share one shape. Ignored for read-only sessions. */
  dangerous?: boolean;
  /** Names of MCP servers this spawn inherits from the user's global
   * `~/.codex/config.toml` and does not need. Each is detached for this
   * process only, via a config override; the user's file is never touched.
   * Hive's own `hive` server is never in this list. */
  excludeMcpServers?: readonly string[];
  /** A capability token was minted for this agent, so the spawn tells codex
   * to read the bearer from the launch environment. Only the env var NAME
   * rides the argv; the value enters through the tmux launch command's
   * `$(cat ...)` substitution (wrapCodexSpawnWithCapabilityEnv), which `ps`
   * shows unexpanded. Never emitted without a token: codex 0.144.1 silently
   * disables an MCP server whose bearer_token_env_var is unset. */
  withCapabilityToken?: boolean;
  /** The per-repo graphify MCP server, when the daemon has one up and healthy
   * (docs/architecture/graphify-integration.md). Attached through the same
   * config-override channel as `hive`; absent means no entry at all. */
  graphifyUrl?: string;
}

export type CodexAgentConfigOptions = Pick<
  CodexSpawnOptions,
  "name" | "daemonPort" | "readOnly" | "graphifyUrl"
> & {
  /** The agent's capability token. Codex has no connect-time headers helper,
   * so unlike Claude its token has to sit in a file: a dedicated 0600
   * `capability-token` whose contents the launch shell exports as
   * CODEX_CAPABILITY_TOKEN_ENV for `bearer_token_env_var`. It must never ride
   * an argv (visible in `ps`) and never sit in the project config.toml —
   * codex does not read that file under Hive's launch. */
  capabilityToken?: string;
};

export const CODEX_NOTIFY_SCRIPT = "hive-notify.sh";

/** The env var codex reads the agent's bearer from (bearer_token_env_var).
 * Populated only inside the agent's tmux launch shell, never in any argv. */
export const CODEX_CAPABILITY_TOKEN_ENV = "HIVE_CAPABILITY_TOKEN";

export function codexCapabilityTokenPath(worktreePath: string): string {
  return join(worktreePath, ".codex", "capability-token");
}

/** Prefixes a codex launch shell command so the capability token file's
 * contents reach the codex process environment without ever appearing in an
 * argv: `ps` shows the `$(cat ...)` text, not the secret. Codex 0.144.1 does
 * pass its environment to exec-tool children (shell_environment_policy
 * exclude/include_only were both ignored when tested), so the agent's own
 * commands can read the var — the same exposure as the 0600 token file
 * itself, which any same-user process can already read. */
export function wrapCodexSpawnWithCapabilityEnv(
  command: string,
  worktreePath: string,
): string {
  const tokenPath = shellToken(codexCapabilityTokenPath(worktreePath));
  return `${CODEX_CAPABILITY_TOKEN_ENV}="$(cat ${tokenPath})" ${command}`;
}

const shellToken = (value: string): string => {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

const tomlString = (value: string): string => JSON.stringify(value);

export function buildCodexTrustArgs(worktreePath: string): string[] {
  const absoluteWorktreePath = resolve(worktreePath);
  return [
    "-c",
    `projects.${tomlString(absoluteWorktreePath)}.trust_level="trusted"`,
  ];
}

function buildCodexConfigArgs(
  options: CodexSpawnOptions,
  sandbox: { asConfigOverride: boolean },
): string[] {
  const args: string[] = [];
  if (options.model !== "default") {
    args.push("-c", `model=${options.model}`);
  }
  args.push("-c", `model_reasoning_effort=${options.effort}`);

  if (options.readOnly) {
    // `codex resume` documents no --sandbox flag, so the resume path passes
    // the same restriction as a config override instead.
    if (sandbox.asConfigOverride) {
      args.push("-c", 'sandbox_mode="read-only"');
    } else {
      args.push("--sandbox", "read-only");
    }
  } else if (options.dangerous ?? false) {
    args.push(
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
    );
  } else {
    args.push(
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
    );
  }

  // The lifecycle hooks ride the command line, not the worktree's
  // `.codex/config.toml`: codex only loads project-local config when the
  // directory's trust is persisted in the user's own config file, and Hive
  // passes trust as a `-c` override precisely so it never edits that file.
  // A hook defined only in the project file therefore never fires (verified
  // against codex 0.144.1 — its trust prompt states project config, hooks,
  // and exec policies load only for trusted directories).
  const notifyPath = resolve(
    options.worktreePath,
    ".codex",
    CODEX_NOTIFY_SCRIPT,
  );
  const hookOverride = (
    event: string,
    command: string,
    matcher?: string,
  ): string =>
    `hooks.${event}=[{${
      matcher === undefined ? "" : `matcher=${tomlString(matcher)},`
    }hooks=[{type="command",command=${
      tomlString(command)
    },timeout=5}]}]`;
  args.push(
    ...buildCodexTrustArgs(options.worktreePath),
    "--dangerously-bypass-hook-trust",
    "-c",
    "features.hooks=true",
    "-c",
    hookOverride("SessionStart", `${notifyPath} session-start`),
    "-c",
    hookOverride("UserPromptSubmit", `${notifyPath} turn-start`),
    "-c",
    hookOverride("PostToolUse", `${notifyPath} tool-boundary`),
    "-c",
    hookOverride("Stop", `${notifyPath} turn-end`),
    ...(options.graphifyUrl === undefined
      ? []
      : [
          "-c",
          hookOverride(
            "PreToolUse",
            `${shellToken(graphifyHookPath(options.worktreePath, ".codex"))} codex`,
            "Bash",
          ),
        ]),
    "-c",
    `mcp_servers.hive.url=${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    ...((options.withCapabilityToken ?? false)
      ? [
        "-c",
        `mcp_servers.hive.bearer_token_env_var=${tomlString(CODEX_CAPABILITY_TOKEN_ENV)}`,
      ]
      : []),
    ...(options.graphifyUrl === undefined ? [] : [
      "-c",
      `mcp_servers.graphify.url=${tomlString(options.graphifyUrl)}`,
    ]),
    // Detach the human's own servers from this agent. Same override channel as
    // hooks and trust, so spawn and resume stay one shape. When Hive attaches
    // graphify, "graphify" joins the keep-set: otherwise a user's inherited
    // server of the same name would be disabled by the very exclusion pass
    // whose url override we just claimed.
    ...buildCodexMcpExclusionArgs(
      options.excludeMcpServers ?? [],
      options.graphifyUrl === undefined
        ? HIVE_MCP_SERVERS
        : [...HIVE_MCP_SERVERS, "graphify"],
    ).args,
  );

  return args;
}

export function buildCodexSpawnCommand(options: CodexSpawnOptions): string[] {
  return ["codex", ...buildCodexConfigArgs(options, { asConfigOverride: false })];
}

// Relaunches a crashed agent's recorded rollout (`codex resume [OPTIONS]
// [SESSION_ID]`, verified against codex CLI help) with the same config
// overrides the original spawn used.
export function buildCodexResumeCommand(
  options: CodexSpawnOptions,
  sessionId: string,
): string[] {
  return [
    "codex",
    "resume",
    ...buildCodexConfigArgs(options, { asConfigOverride: true }),
    sessionId,
  ];
}

export function codexSessionsDirectory(home = homedir()): string {
  return join(home, ".codex", "sessions");
}

// Codex records every conversation as a rollout file whose first line is a
// session_meta entry carrying the session id and cwd. When a crashed agent's
// thread id was never captured from a notify payload, the newest rollout
// whose cwd is the agent's worktree is the session to resume.
const ROLLOUT_SCAN_LIMIT = 100;

export interface CodexRolloutLocation {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

// The newest rollout recorded for a worktree — the shared discovery for
// crash-recovery resume (session id) and the daemon's rollout telemetry
// sensor (file path and freshness).
export async function findLatestCodexRollout(
  worktreePath: string,
  home = homedir(),
): Promise<CodexRolloutLocation | null> {
  const target = resolve(worktreePath);
  const rollouts: { path: string; mtimeMs: number }[] = [];
  const pending = [codexSessionsDirectory(home)];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          rollouts.push({ path, mtimeMs: (await stat(path)).mtimeMs });
        } catch {
          // A rollout deleted mid-scan is simply not a candidate.
        }
      }
    }
  }
  rollouts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const rollout of rollouts.slice(0, ROLLOUT_SCAN_LIMIT)) {
    const meta = await readRolloutSessionMeta(rollout.path);
    if (meta !== null && meta.cwd === target) {
      return { path: rollout.path, sessionId: meta.sessionId, mtimeMs: rollout.mtimeMs };
    }
  }
  return null;
}

export async function findLatestCodexSessionId(
  worktreePath: string,
  home = homedir(),
): Promise<string | null> {
  return (await findLatestCodexRollout(worktreePath, home))?.sessionId ?? null;
}

async function readRolloutSessionMeta(
  path: string,
): Promise<{ sessionId: string; cwd: string } | null> {
  let firstLine: string;
  try {
    const input = createReadStream(path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      const next = await lines[Symbol.asyncIterator]().next();
      firstLine = next.done ? "" : next.value;
    } finally {
      lines.close();
      input.destroy();
    }
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (
      typeof parsed !== "object" || parsed === null ||
      !("payload" in parsed) || typeof parsed.payload !== "object" ||
      parsed.payload === null
    ) {
      return null;
    }
    const payload = parsed.payload as Record<string, unknown>;
    const sessionId = payload.id ?? payload.session_id;
    if (typeof sessionId !== "string" || typeof payload.cwd !== "string") {
      return null;
    }
    return { sessionId, cwd: payload.cwd };
  } catch {
    return null;
  }
}

export async function writeCodexAgentConfig(
  worktreePath: string,
  options: CodexAgentConfigOptions,
): Promise<void> {
  const codexDirectory = join(worktreePath, ".codex");
  const notifyPath = join(codexDirectory, CODEX_NOTIFY_SCRIPT);
  const graphifyPath = graphifyHookPath(worktreePath, ".codex");
  await mkdir(codexDirectory, { recursive: true });

  const notifyScript = [
    "#!/bin/sh",
    [
      'exec hive event "$1"',
      "--agent",
      shellToken(options.name),
      "--port",
      String(options.daemonPort),
    ].join(" "),
    "",
  ].join("\n");
  // No hook tables and no Authorization header here: this project-local file
  // only loads for directories whose trust is persisted in the user's config,
  // which Hive never edits. The lifecycle hooks ride the spawn command's `-c`
  // overrides, and the capability token travels through a 0600 file whose
  // contents the launch shell exports for bearer_token_env_var — never
  // through config codex will not read.
  const config = [
    "[mcp_servers.hive]",
    `url = ${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    "",
  ].join("\n");

  const configPath = join(codexDirectory, "config.toml");
  const tokenPath = codexCapabilityTokenPath(worktreePath);
  await Promise.all([
    writeFile(configPath, config, { mode: 0o600 }),
    writeFile(notifyPath, notifyScript, { mode: 0o755 }),
    writeGraphifyHook(graphifyPath, options.graphifyUrl),
    options.capabilityToken === undefined
      // A leftover token from an earlier process must not outlive the spawn
      // that owned it.
      ? rm(tokenPath, { force: true })
      : writeFile(tokenPath, options.capabilityToken, { mode: 0o600 }),
  ]);
  await Promise.all([
    chmod(configPath, 0o600),
    chmod(notifyPath, 0o755),
    ...(options.capabilityToken === undefined ? [] : [chmod(tokenPath, 0o600)]),
  ]);
}
