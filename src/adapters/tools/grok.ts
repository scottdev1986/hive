import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GrokRoute } from "../../schemas";

export interface GrokSpawnOptions {
  model: GrokRoute["model"];
  effort?: string;
  worktreePath: string;
  readOnly: boolean;
  executable?: string;
}

export interface GrokAgentConfigOptions {
  daemonPort: number;
  capabilityToken?: string;
  graphifyUrl?: string;
}

/**
 * The measured reader policy, kept in one place because Grok matches these
 * Claude-style rule names against differently named native tools. In
 * particular, `Bash` binds Grok's `Shell`; deny wins over allow.
 *
 * Measured on both reachable models: `MCPTool` binds composer-fast's
 * `CallMcpTool` and Grok 4.5's `use_tool` semantic wrapper.
 */
export const GROK_READ_ONLY_PERMISSION_RULES: {
  deny: readonly string[];
  allow: readonly string[];
} = {
  deny: ["Bash", "Write", "Edit"],
  allow: ["MCPTool", "Read", "Grep"],
};

export const GROK_COMPATIBILITY_ENV = {
  GROK_CLAUDE_SKILLS_ENABLED: "false",
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CURSOR_SKILLS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
} as const;

export interface GrokCliIdentity {
  version: string;
  buildHash: string;
  channel: string;
}

const GROK_VERSION_PATTERN = /^grok (\S+) \(([0-9a-f]+)\) \[(\w+)\]$/;

export function parseGrokCliVersion(output: string): GrokCliIdentity | null {
  const match = GROK_VERSION_PATTERN.exec(output.trim());
  return match === null
    ? null
    : { version: match[1]!, buildHash: match[2]!, channel: match[3]! };
}

export function probeGrokCliVersion(executable = "grok"): GrokCliIdentity | null {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    return result.exitCode === 0
      ? parseGrokCliVersion(result.stdout.toString())
      : null;
  } catch {
    return null;
  }
}

export function probeGrokDefaultModel(executable = "grok"): string | null {
  try {
    const result = Bun.spawnSync([executable, "models"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    for (const line of result.stdout.toString().split("\n")) {
      const match = /^\s*\*\s+(\S+)\s+\(default\)\s*$/.exec(line);
      if (match !== null) return match[1]!;
    }
    return null;
  } catch {
    return null;
  }
}

function grokPermissionArgs(readOnly: boolean): string[] {
  if (!readOnly) return ["--always-approve"];
  return [
    ...GROK_READ_ONLY_PERMISSION_RULES.deny.flatMap((rule) => ["--deny", rule]),
    ...GROK_READ_ONLY_PERMISSION_RULES.allow.flatMap((rule) => ["--allow", rule]),
  ];
}

function grokLaunchArgs(options: GrokSpawnOptions): string[] {
  const argv = [options.executable ?? "grok", "-m", options.model];
  if (options.effort !== undefined) {
    argv.push("--reasoning-effort", options.effort);
  }
  argv.push(...grokPermissionArgs(options.readOnly));
  return argv;
}

export function buildGrokSpawnCommand(options: GrokSpawnOptions): string[] {
  return grokLaunchArgs(options);
}

/** Resume the exact durable session. `--session-id` creates and is forbidden. */
export function buildGrokResumeCommand(
  options: GrokSpawnOptions,
  sessionId: string,
): string[] {
  const argv = grokLaunchArgs(options);
  argv.splice(1, 0, "-r", sessionId);
  return argv;
}

/**
 * Grok can otherwise inherit the operator's Claude/Cursor skills, rules,
 * agents, MCPs, and hooks. These process-local switches disable those imports.
 * They do not stop Grok ingesting the repository's own `CLAUDE.md` or
 * `.claude/settings.local.json`; no switch that does was found.
 */
export function wrapGrokSpawnWithCompatibilityEnv(command: string): string {
  const environment = Object.entries(GROK_COMPATIBILITY_ENV)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${environment} ${command}`;
}

const tomlString = (value: string): string => JSON.stringify(value);

function stripHiveMcpTables(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1];
    if (header !== undefined) {
      skipping = header === "mcp_servers.hive" ||
        header.startsWith("mcp_servers.hive.") ||
        header === "mcp_servers.graphify" ||
        header.startsWith("mcp_servers.graphify.");
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

function existingHiveAuthorization(source: string): string | undefined {
  try {
    const parsed = Bun.TOML.parse(source) as {
      mcp_servers?: { hive?: { headers?: { Authorization?: unknown } } };
    };
    const value = parsed.mcp_servers?.hive?.headers?.Authorization;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeGrokAgentConfig(
  worktreePath: string,
  options: GrokAgentConfigOptions,
): Promise<void> {
  const directory = join(worktreePath, ".grok");
  const path = join(directory, "config.toml");
  await mkdir(directory, { recursive: true });
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT"
    ) return "";
    throw error;
  });
  const prefix = stripHiveMcpTables(existing);
  const authorization = options.capabilityToken === undefined
    ? existingHiveAuthorization(existing)
    : `Bearer ${options.capabilityToken}`;
  const owned = [
    "[mcp_servers.hive]",
    `url = ${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    "enabled = true",
    ...(authorization === undefined
      ? []
      : [
          "",
          "[mcp_servers.hive.headers]",
          `Authorization = ${tomlString(authorization)}`,
        ]),
    ...(options.graphifyUrl === undefined
      ? []
      : [
          "",
          "[mcp_servers.graphify]",
          `url = ${tomlString(options.graphifyUrl)}`,
          "enabled = true",
        ]),
  ].join("\n");
  await writeFile(path, `${prefix.length === 0 ? "" : `${prefix}\n\n`}${owned}\n`, {
    mode: 0o600,
  });
}

export async function removeGrokAgentConfig(
  worktreePath: string,
): Promise<boolean> {
  const path = join(worktreePath, ".grok", "config.toml");
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT"
    ) return null;
    throw error;
  });
  if (existing === null) return false;
  let parsed: {
    mcp_servers?: { hive?: { url?: unknown } };
  };
  try {
    parsed = Bun.TOML.parse(existing) as typeof parsed;
  } catch {
    return false;
  }
  const hiveUrl = parsed.mcp_servers?.hive?.url;
  if (
    typeof hiveUrl !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(hiveUrl)
  ) return false;
  const remaining = stripHiveMcpTables(existing);
  if (remaining.trim().length === 0) await rm(path, { force: true });
  else await writeFile(path, `${remaining}\n`, { mode: 0o600 });
  return true;
}

export function grokSessionsDirectory(
  home = Bun.env.GROK_HOME ?? join(homedir(), ".grok"),
): string {
  return join(home, "sessions");
}

interface GrokSummaryLocation {
  id: string;
  model: string | null;
  mtimeMs: number;
}

async function findLatestGrokSummary(
  worktreePath: string,
  home?: string,
  sessionId?: string,
): Promise<GrokSummaryLocation | null> {
  const target = resolve(worktreePath);
  const root = grokSessionsDirectory(home);
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: GrokSummaryLocation | null = null;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    const recordedCwd = await readFile(join(projectPath, ".cwd"), "utf8")
      .then((value) => value.trim())
      .catch(() => null);
    if (project.name !== encodeURIComponent(target) && recordedCwd !== target) {
      continue;
    }
    let sessions;
    try {
      sessions = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const summaryPath = join(projectPath, session.name, "summary.json");
      try {
        const parsed: unknown = JSON.parse(await readFile(summaryPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null || !("info" in parsed)) {
          continue;
        }
        const info = parsed.info;
        if (
          typeof info !== "object" || info === null ||
          !("cwd" in info) || info.cwd !== target ||
          !("id" in info) || typeof info.id !== "string" ||
          (sessionId !== undefined && info.id !== sessionId)
        ) continue;
        const model = "current_model_id" in parsed &&
            typeof parsed.current_model_id === "string"
          ? parsed.current_model_id
          : null;
        const mtimeMs = (await stat(summaryPath)).mtimeMs;
        if (newest === null || mtimeMs > newest.mtimeMs) {
          newest = { id: info.id, model, mtimeMs };
        }
      } catch {
        // A partial or concurrently deleted summary is not a candidate.
      }
    }
  }
  return newest;
}

/** Resolve only a session whose own summary records this exact worktree cwd. */
export async function findLatestGrokSessionId(
  worktreePath: string,
  home?: string,
): Promise<string | null> {
  return (await findLatestGrokSummary(worktreePath, home))?.id ?? null;
}

export async function readLiveGrokModel(
  worktreePath: string,
  sessionId?: string,
  home?: string,
): Promise<string | null> {
  return (await findLatestGrokSummary(worktreePath, home, sessionId))?.model ?? null;
}
