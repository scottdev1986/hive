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
import { buildCodexMcpExclusionArgs, HIVE_MCP_SERVERS } from "./mcp-scope";
import {
  graphifyHookPath,
  writeGraphifyHook,
  type GraphifyHookKind,
} from "./graphify-hook";
import { hiveInstanceSuffix } from "../../daemon/tmux-sessions";
import { assertCodexWriterContained } from "../../daemon/codex-containment";

/** Typed, not a bare string in a template: the token the generated hook
 * dispatches on. A kind the script has no arm for silently never nudges. */
const CODEX_GRAPHIFY_HOOK_KIND: GraphifyHookKind = "codex";

export interface CodexSpawnOptions {
  name: string;
  model: string;
  effort: string;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  /** No-prompt autonomy for readers through config overrides shared by spawn
   * and resume. The filesystem sandbox always remains read-only. */
  dangerous?: boolean;
  /** Names of MCP servers this spawn inherits from the user's global
   * `~/.codex/config.toml` and does not need. Each is detached for this
   * process only, via a config override; the user's file is never touched.
   * Hive's own `hive` server is never in this list. */
  excludeMcpServers?: readonly string[];
  /** Read the bearer from the launch environment. Only the variable name may
   * enter argv, and the override is absent when no token exists. */
  withCapabilityToken?: boolean;
  /** The per-repo graphify MCP server, when the daemon has one up and healthy
   * (docs/graphify/integration.md). Attached through the same
   * config-override channel as `hive`; absent means no entry at all. */
  graphifyUrl?: string;
}

export type CodexAgentConfigOptions = Pick<
  CodexSpawnOptions,
  "name" | "daemonPort" | "readOnly" | "graphifyUrl"
> & {
  /** Exact argv prefix for this Hive build. Installed releases pass their
   * absolute binary path so lifecycle hooks cannot attach to a different
   * Hive installation or fail when `hive` is absent from PATH. */
  hiveCommand?: readonly string[];
  /** Stored only in Hive's 0600 token file and exported by the launch shell;
   * never written to argv or project config. */
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
  assertCodexWriterContained("codex", options.readOnly);
  // Apps/connectors do not appear in mcp_servers, so inherited-server
  // exclusions cannot detach them. Hive agents have a deliberately scoped
  // tool surface; disable Apps for this process without changing user config.
  //
  // Disable Codex-internal subagents too. `codex features list` (0.144.4)
  // reports `multi_agent` as a stable feature that is on by default; a worker
  // that spawns its own children gives them execution identities Hive never
  // authorized, reserved quota for, or attested — the /root/review and
  // /root/review_grok rollouts of the incident. `features.multi_agent=false`
  // (equivalently `--disable multi_agent`) is the verified disable surface;
  // `multi_agent_v2` and `enable_fanout` are already off by default. A Hive
  // worker is a single agent, so nothing legitimate is lost.
  const args: string[] = [
    "-c",
    "features.apps=false",
    "-c",
    "features.multi_agent=false",
  ];
  if (options.model !== "default") {
    args.push("-c", `model=${options.model}`);
  }
  args.push("-c", `model_reasoning_effort=${options.effort}`);

  // Codex writers are contained before the adapter can construct argv.
  // `codex resume` documents no --sandbox flag, so that path carries the same
  // reader restriction as a config override instead.
  if (sandbox.asConfigOverride) {
    args.push("-c", 'sandbox_mode="read-only"');
  } else {
    args.push("--sandbox", "read-only");
  }
  if (options.dangerous ?? false) {
    args.push("-c", 'approval_policy="never"');
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
  const hookEntry = (command: string, matcher?: string): string =>
    `{${
      matcher === undefined ? "" : `matcher=${tomlString(matcher)},`
    }hooks=[{type="command",command=${tomlString(command)},timeout=5}]}`;
  const hookOverride = (
    event: string,
    command: string,
    matcher?: string,
  ): string => `hooks.${event}=[${hookEntry(command, matcher)}]`;
  // PreToolUse carries at most one Hive entry (graphify). The fail-open
  // writer identity PreToolUse guard was removed: Codex 0.144.4 hooks fail
  // open on error/timeout and are writer-tamperable, so they cannot authorize
  // mutation. Codex writers are refused at launch instead.
  const preToolUseEntries: string[] = [];
  if (options.graphifyUrl !== undefined) {
    preToolUseEntries.push(hookEntry(
      `${shellToken(graphifyHookPath(options.worktreePath, ".codex"))} ${
        CODEX_GRAPHIFY_HOOK_KIND
      }`,
      "Bash",
    ));
  }
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
    ...(preToolUseEntries.length === 0 ? [] : [
      "-c",
      `hooks.PreToolUse=[${preToolUseEntries.join(",")}]`,
    ]),
    "-c",
    `mcp_servers.hive.url=${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    ...((options.dangerous ?? false)
      ? [
        "-c",
        'mcp_servers.hive.default_tools_approval_mode="approve"',
      ]
      : []),
    ...((options.withCapabilityToken ?? false)
      ? [
        "-c",
        `mcp_servers.hive.bearer_token_env_var=${tomlString(CODEX_CAPABILITY_TOKEN_ENV)}`,
      ]
      : []),
    ...(options.graphifyUrl === undefined ? [] : [
      "-c",
      `mcp_servers.graphify.url=${tomlString(options.graphifyUrl)}`,
      ...((options.dangerous ?? false)
        ? [
          "-c",
          'mcp_servers.graphify.default_tools_approval_mode="approve"',
        ]
        : []),
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
// session_meta entry carrying the session id, cwd, source, and creation time.
// Hook-claimed ids are not trusted, and 0.144.4 exposes no independent datum
// that binds one of these rollout records to a Hive process incarnation.
const ROLLOUT_SCAN_LIMIT = 100;

export interface CodexRolloutLocation {
  path: string;
  sessionId: string;
  createdAt: string;
  mtimeMs: number;
}

async function findCodexRollout(
  worktreePath: string,
  home: string,
  sessionId?: string,
): Promise<CodexRolloutLocation | null> {
  const target = resolve(worktreePath);
  const rollouts = await listCodexRollouts(home);
  rollouts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const rollout of rollouts.slice(0, ROLLOUT_SCAN_LIMIT)) {
    const meta = await readRolloutSessionMeta(rollout.path);
    if (
      meta !== null && meta.cwd === target &&
      (sessionId === undefined || meta.sessionId === sessionId)
    ) {
      return {
        path: rollout.path,
        sessionId: meta.sessionId,
        createdAt: meta.createdAt,
        mtimeMs: rollout.mtimeMs,
      };
    }
  }
  return null;
}

async function listCodexRollouts(
  home: string,
): Promise<{ path: string; mtimeMs: number }[]> {
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
  return rollouts;
}

// Raw newest-rollout lookup for telemetry. This cwd-only result is never
// sufficient to bind an active process.
export async function findLatestCodexRollout(
  worktreePath: string,
  home = homedir(),
): Promise<CodexRolloutLocation | null> {
  return findCodexRollout(worktreePath, home);
}

export async function findCodexRolloutBySessionId(
  worktreePath: string,
  sessionId: string,
  home = homedir(),
): Promise<CodexRolloutLocation | null> {
  return findCodexRollout(worktreePath, home, sessionId);
}

/** Codex 0.144.4 rollout metadata has no PID, launch nonce, process handle, or
 * other datum Hive can bind to a process incarnation. Cwd/source/timestamps
 * are shared by independent and child sessions, so chronology is not proof. */
export function findCodexRolloutForProcess(
  worktreePath: string,
  processStartedAt: string,
  home = homedir(),
): Promise<CodexRolloutLocation | null> {
  void worktreePath;
  void processStartedAt;
  void home;
  return Promise.resolve(null);
}

export async function findLatestCodexSessionId(
  worktreePath: string,
  home = homedir(),
): Promise<string | null> {
  return (await findLatestCodexRollout(worktreePath, home))?.sessionId ?? null;
}

export function discoverCodexRecoverySessionId(
  worktreePath: string,
  agentCreatedAt: string,
  home = homedir(),
): Promise<string | null> {
  void worktreePath;
  void agentCreatedAt;
  void home;
  return Promise.resolve(null);
}

async function readRolloutSessionMeta(
  path: string,
): Promise<{ sessionId: string; cwd: string; createdAt: string } | null> {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    !("type" in parsed) || parsed.type !== "session_meta"
  ) {
    return null;
  }
  if (
    !("payload" in parsed) || typeof parsed.payload !== "object" ||
    parsed.payload === null
  ) throw new Error(`Invalid Codex session_meta in ${path}`);
  const payload = parsed.payload as Record<string, unknown>;
  const sessionId = payload.id ?? payload.session_id;
  const createdAt = (parsed as Record<string, unknown>).timestamp;
  if (
    typeof sessionId !== "string" || typeof payload.cwd !== "string" ||
    payload.source !== "cli" || typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new Error(`Invalid Codex session_meta in ${path}`);
  }
  return {
    sessionId,
    cwd: payload.cwd,
    createdAt,
  };
}

export async function writeCodexAgentConfig(
  worktreePath: string,
  options: CodexAgentConfigOptions,
): Promise<void> {
  assertCodexWriterContained("codex", options.readOnly);
  const codexDirectory = join(worktreePath, ".codex");
  const notifyPath = join(codexDirectory, CODEX_NOTIFY_SCRIPT);
  const graphifyPath = graphifyHookPath(worktreePath, ".codex");
  await mkdir(codexDirectory, { recursive: true });

  const hiveCommand = options.hiveCommand ?? ["hive"];
  if (hiveCommand[0] === undefined) {
    throw new Error("Hive command must contain an executable");
  }
  const hiveInvocation = hiveCommand.map(shellToken).join(" ");
  const notifyScript = [
    "#!/bin/sh",
    [
      `exec ${hiveInvocation} event "$1"`,
      "--agent",
      shellToken(options.name),
      "--port",
      String(options.daemonPort),
      "--instance-id",
      hiveInstanceSuffix(),
    ].join(" "),
    "",
  ].join("\n");
  // No PreToolUse identity guard script: the fail-open/tamperable hook path
  // was removed; Codex writers are refused at launch instead.
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
    // Remove any leftover identity-guard script from older launches.
    rm(join(codexDirectory, "hive-tool-guard.sh"), { force: true }),
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
