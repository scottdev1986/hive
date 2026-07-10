import { chmod, mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexRoute } from "../../schemas";
import { buildCodexMcpExclusionArgs } from "./mcp-scope";

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
}

export type CodexAgentConfigOptions = Pick<
  CodexSpawnOptions,
  "name" | "daemonPort" | "readOnly"
> & {
  /** The agent's capability token. Codex has no connect-time headers helper,
   * so unlike Claude its token has to sit in a file. It goes in the 0600
   * config.toml as a static header rather than in `bearer_token_env_var`,
   * because an environment variable is inherited by every descendant. */
  capabilityToken?: string;
};

export const CODEX_NOTIFY_SCRIPT = "hive-notify.sh";

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

  const notifyPath = resolve(
    options.worktreePath,
    ".codex",
    CODEX_NOTIFY_SCRIPT,
  );
  args.push(
    ...buildCodexTrustArgs(options.worktreePath),
    "-c",
    `mcp_servers.hive.url=${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    "-c",
    `notify=[${tomlString(notifyPath)}]`,
    // Detach the human's own servers from this agent. Same override channel as
    // notify and trust, so spawn and resume stay one shape.
    ...buildCodexMcpExclusionArgs(options.excludeMcpServers ?? []).args,
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

export async function findLatestCodexSessionId(
  worktreePath: string,
  home = homedir(),
): Promise<string | null> {
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
      return meta.sessionId;
    }
  }
  return null;
}

async function readRolloutSessionMeta(
  path: string,
): Promise<{ sessionId: string; cwd: string } | null> {
  let firstLine: string;
  try {
    const handle = await open(path, "r");
    try {
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(8192),
        0,
        8192,
        0,
      );
      firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    } finally {
      await handle.close();
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
  await mkdir(codexDirectory, { recursive: true });

  const notifyScript = [
    "#!/bin/sh",
    [
      "exec hive event turn-end",
      "--agent",
      shellToken(options.name),
      "--port",
      String(options.daemonPort),
      '--payload "$1"',
    ].join(" "),
    "",
  ].join("\n");
  const config = [
    "[mcp_servers.hive]",
    `url = ${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    ...(options.capabilityToken === undefined ? [] : [
      "",
      "[mcp_servers.hive.http_headers]",
      `Authorization = ${tomlString(`Bearer ${options.capabilityToken}`)}`,
    ]),
    "",
  ].join("\n");

  const configPath = join(codexDirectory, "config.toml");
  await Promise.all([
    writeFile(configPath, config, { mode: 0o600 }),
    writeFile(notifyPath, notifyScript, { mode: 0o755 }),
  ]);
  await Promise.all([chmod(configPath, 0o600), chmod(notifyPath, 0o755)]);
}
