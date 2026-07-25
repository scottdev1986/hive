import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hiveInstanceSuffix } from "../../daemon/instance-identity";
import { HIVE_CAPABILITY_TOKEN_ENV } from "./capability-env";
import { resolveProviderExecutable } from "./provider-executable";
import {
  invalidRecoveryArtifactEvidence,
  isMissingRecoveryArtifact,
  type RecoverySessionArtifact,
  recoveryArtifactTimestamp,
  selectRecoverySessionId,
} from "./recovery-session";

export interface GrokSpawnOptions {
  model: string;
  effort?: string;
  worktreePath: string;
  readOnly: boolean;
  executable?: string;
  /** The session UUID Hive assigns at creation because Grok has no session-id
   * hook channel. */
  sessionId?: string;
  /** Additional vendor system rules for this session. */
  rules?: string;
}

export interface GrokAgentConfigOptions {
  daemonPort: number;
  name?: string;
  providerRunId?: string;
  hiveCommand?: readonly string[];
  graphifyUrl?: string;
}

export type GrokProjectTrust = "trusted" | "untrusted" | "unknown";

/** Grok maps these compatibility names to native tools: `Bash` covers `Shell`,
 * and `MCPTool` covers both `CallMcpTool` and `use_tool`. Deny wins. */
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
  version: string | null;
  buildHash: string | null;
  channel: string | null;
}

const GROK_VERSION_PATTERN = /^grok (\S+) \(([0-9a-f]+)\)(?: \[(\w+)\])?$/;

export function parseGrokCliVersion(output: string): GrokCliIdentity | null {
  const match = GROK_VERSION_PATTERN.exec(output.trim());
  if (match === null) return null;
  const [, version, buildHash, channel] = match;
  if (version === undefined || buildHash === undefined) return null;
  return { version, buildHash, channel: channel ?? null };
}

export function probeGrokCliVersion(
  executable = "grok",
  timeoutMs = 5_000,
): GrokCliIdentity | null {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    return (
      parseGrokCliVersion(result.stdout.toString()) ?? {
        version: null,
        buildHash: null,
        channel: null,
      }
    );
  } catch {
    return null;
  }
}

export function resolveWorkingGrokExecutable() {
  return resolveProviderExecutable("grok", [
    ".local/bin/grok",
    ".grok/bin/grok",
    ".opencode/bin/grok",
  ]);
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
      if (match?.[1] !== undefined) return match[1];
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
    ...GROK_READ_ONLY_PERMISSION_RULES.allow.flatMap((rule) => [
      "--allow",
      rule,
    ]),
  ];
}

function grokLaunchArgs(options: GrokSpawnOptions): string[] {
  const argv = [options.executable ?? "grok", "-m", options.model];
  if (options.effort !== undefined) {
    argv.push("--reasoning-effort", options.effort);
  }
  if (options.rules !== undefined) {
    argv.push("--rules", options.rules);
  }
  argv.push(...grokPermissionArgs(options.readOnly));
  return argv;
}

/** `--session-id` creates a session and must never enter the resume path. */
export function buildGrokSpawnCommand(options: GrokSpawnOptions): string[] {
  const argv = grokLaunchArgs(options);
  if (options.sessionId !== undefined) {
    argv.push("--session-id", options.sessionId);
  }
  return argv;
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
const shellToken = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const hook = (command: string) => [
  { hooks: [{ type: "command" as const, command }] },
];

export function ownsGrokHook(
  source: string,
  instanceId = hiveInstanceSuffix(),
): boolean {
  return (
    source.includes(" event ") &&
    source.includes(`--instance-id ${shellToken(instanceId)}`) &&
    source.includes("--provider-run-id") &&
    [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "StopFailure",
      "PostCompact",
      "SessionEnd",
    ].every((event) => source.includes(`"${event}"`))
  );
}

async function grokHookPath(
  directory: string,
  instanceId: string,
): Promise<string> {
  const preferred = join(directory, grokHookFilename(instanceId));
  const existing = await readFile(preferred, "utf8").catch(() => null);
  if (existing === null || ownsGrokHook(existing, instanceId)) return preferred;

  const suffix = createHash("sha256")
    .update(instanceId)
    .digest("hex")
    .slice(0, 12);
  for (let index = 0; ; index += 1) {
    const candidate = join(directory, `hive-${suffix}-${index + 1}.json`);
    const candidateSource = await readFile(candidate, "utf8").catch(() => null);
    if (candidateSource === null || ownsGrokHook(candidateSource, instanceId)) {
      return candidate;
    }
  }
}

export function grokHookFilename(instanceId = hiveInstanceSuffix()): string {
  const suffix = createHash("sha256")
    .update(instanceId)
    .digest("hex")
    .slice(0, 12);
  return `hive-${suffix}.json`;
}

export function inspectGrokProjectTrust(
  worktreePath: string,
  executable = "grok",
): GrokProjectTrust {
  try {
    const result = Bun.spawnSync([executable, "inspect"], {
      cwd: worktreePath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return "unknown";
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    const trust = /Project trusted:\s*(yes|no)\b/.exec(output)?.[1];
    return trust === "yes"
      ? "trusted"
      : trust === "no"
        ? "untrusted"
        : "unknown";
  } catch {
    return "unknown";
  }
}

function stripHiveMcpTables(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1];
    if (header !== undefined) {
      skipping =
        header === "mcp_servers.hive" ||
        header.startsWith("mcp_servers.hive.") ||
        header === "mcp_servers.graphify" ||
        header.startsWith("mcp_servers.graphify.");
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

export async function writeGrokAgentConfig(
  worktreePath: string,
  options: GrokAgentConfigOptions,
): Promise<void> {
  const directory = join(worktreePath, ".grok");
  const hooksDirectory = join(directory, "hooks");
  const path = join(directory, "config.toml");
  await mkdir(directory, { recursive: true });
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return "";
    throw error;
  });
  const prefix = stripHiveMcpTables(existing);
  const owned = [
    "[mcp_servers.hive]",
    `url = ${tomlString(`http://127.0.0.1:${options.daemonPort}/mcp`)}`,
    "enabled = true",
    "",
    "[mcp_servers.hive.headers]",
    // Grok 0.2.112 expands ${VAR} in mcp_servers string fields at load time, so
    // the live token stays in the environment and out of this project file.
    `Authorization = ${tomlString(`Bearer \${${HIVE_CAPABILITY_TOKEN_ENV}}`)}`,
    ...(options.graphifyUrl === undefined
      ? []
      : [
          "",
          "[mcp_servers.graphify]",
          `url = ${tomlString(options.graphifyUrl)}`,
          "enabled = true",
        ]),
  ].join("\n");
  const writes = [
    writeFile(path, `${prefix.length === 0 ? "" : `${prefix}\n\n`}${owned}\n`, {
      mode: 0o600,
    }),
  ];
  const name = options.name;
  const providerRunId = options.providerRunId;
  if (name !== undefined && providerRunId !== undefined) {
    const hiveCommand = options.hiveCommand ?? ["hive"];
    if (hiveCommand[0] === undefined) {
      throw new Error("Hive command must contain an executable");
    }
    const instanceId = hiveInstanceSuffix();
    const invocation = hiveCommand.map(shellToken).join(" ");
    const eventCommand = (kind: string): string =>
      [
        invocation,
        "event",
        kind,
        "--agent",
        shellToken(name),
        "--port",
        String(options.daemonPort),
        "--instance-id",
        shellToken(instanceId),
        "--provider-run-id",
        shellToken(providerRunId),
      ].join(" ");
    const hooks = {
      hooks: {
        SessionStart: hook(eventCommand("session-start")),
        UserPromptSubmit: hook(eventCommand("turn-start")),
        PreToolUse: hook(eventCommand("tool-start")),
        PostToolUse: hook(eventCommand("tool-boundary")),
        PostToolUseFailure: hook(eventCommand("tool-boundary")),
        Stop: hook(eventCommand("turn-end")),
        StopFailure: hook(eventCommand("turn-failure")),
        PostCompact: hook(eventCommand("compacted")),
        SessionEnd: hook(eventCommand("session-end")),
      },
    };
    await mkdir(hooksDirectory, { recursive: true });
    const hookPath = await grokHookPath(hooksDirectory, instanceId);
    writes.push(
      writeFile(hookPath, `${JSON.stringify(hooks, null, 2)}\n`, {
        mode: 0o600,
      }),
    );
  }
  await Promise.all(writes);
}

async function removeOwnedGrokHooks(worktreePath: string): Promise<boolean> {
  const directory = join(worktreePath, ".grok", "hooks");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  let removed = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null || !ownsGrokHook(source)) continue;
    await rm(path, { force: true });
    removed = true;
  }
  return removed;
}

export async function removeGrokAgentConfig(
  worktreePath: string,
): Promise<boolean> {
  const hooksRemoved = await removeOwnedGrokHooks(worktreePath);
  const path = join(worktreePath, ".grok", "config.toml");
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  });
  if (existing === null) return hooksRemoved;
  let parsed: {
    mcp_servers?: { hive?: { url?: unknown } };
  };
  try {
    parsed = Bun.TOML.parse(existing) as typeof parsed;
  } catch {
    return hooksRemoved;
  }
  const hiveUrl = parsed.mcp_servers?.hive?.url;
  if (
    typeof hiveUrl !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(hiveUrl)
  )
    return hooksRemoved;
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
  createdAt: unknown;
  path: string;
  /** The session directory itself — `updates.jsonl` and `signals.json` are
   * this session's telemetry, and they are only findable from here. */
  directory: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function findLatestGrokSummary(
  worktreePath: string,
  home?: string,
  sessionId?: string,
): Promise<GrokSummaryLocation | null> {
  const summaries = await findGrokSummaries(worktreePath, home, sessionId);
  let newest: GrokSummaryLocation | null = null;
  for (const summary of summaries) {
    if (newest === null || summary.mtimeMs > newest.mtimeMs) newest = summary;
  }
  return newest;
}

async function findGrokSummaries(
  worktreePath: string,
  home?: string,
  sessionId?: string,
  strictEvidence = false,
): Promise<GrokSummaryLocation[]> {
  const target = resolve(worktreePath);
  const root = grokSessionsDirectory(home);
  let projects: Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (strictEvidence && !isMissingRecoveryArtifact(error)) {
      invalidRecoveryArtifactEvidence(
        "Grok",
        root,
        "sessions directory cannot be read",
      );
    }
    return [];
  }
  const summaries: GrokSummaryLocation[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let recordedCwd: string | null;
    try {
      recordedCwd = (await readFile(join(projectPath, ".cwd"), "utf8")).trim();
    } catch (error) {
      if (strictEvidence && !isMissingRecoveryArtifact(error)) {
        invalidRecoveryArtifactEvidence(
          "Grok",
          join(projectPath, ".cwd"),
          "project identity cannot be read",
        );
      }
      recordedCwd = null;
    }
    if (project.name !== encodeURIComponent(target) && recordedCwd !== target) {
      continue;
    }
    let sessions: Dirent[];
    try {
      sessions = await readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      if (strictEvidence && !isMissingRecoveryArtifact(error)) {
        invalidRecoveryArtifactEvidence(
          "Grok",
          projectPath,
          "project directory cannot be read",
        );
      }
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const summaryPath = join(projectPath, session.name, "summary.json");
      let parsed: unknown;
      let mtimeMs: number;
      try {
        parsed = JSON.parse(await readFile(summaryPath, "utf8"));
        mtimeMs = (await stat(summaryPath)).mtimeMs;
      } catch (error) {
        if (strictEvidence && !isMissingRecoveryArtifact(error)) {
          invalidRecoveryArtifactEvidence(
            "Grok",
            summaryPath,
            "cannot be read as a summary",
          );
        }
        // A partial or concurrently deleted summary is not a candidate.
        continue;
      }
      if (!isRecord(parsed) || !isRecord(parsed.info)) {
        if (strictEvidence) {
          invalidRecoveryArtifactEvidence("Grok", summaryPath, "has no info");
        }
        throw new Error(`Invalid Grok summary at ${summaryPath}`);
      }
      const info = parsed.info;
      if (typeof info.id !== "string" || typeof info.cwd !== "string") {
        if (strictEvidence) {
          invalidRecoveryArtifactEvidence(
            "Grok",
            summaryPath,
            "has invalid session identity",
          );
        }
        throw new Error(`Invalid Grok summary at ${summaryPath}`);
      }
      if (
        info.cwd !== target ||
        (sessionId !== undefined && info.id !== sessionId)
      )
        continue;
      if (
        parsed.current_model_id !== undefined &&
        typeof parsed.current_model_id !== "string"
      ) {
        if (strictEvidence) {
          invalidRecoveryArtifactEvidence(
            "Grok",
            summaryPath,
            "has an invalid model id",
          );
        }
        throw new Error(`Invalid Grok summary at ${summaryPath}`);
      }
      const model =
        typeof parsed.current_model_id === "string"
          ? parsed.current_model_id
          : null;
      summaries.push({
        id: info.id,
        model,
        mtimeMs,
        createdAt: parsed.created_at,
        path: summaryPath,
        directory: join(projectPath, session.name),
      });
    }
  }
  return summaries;
}

/** Resolve only a session whose own summary records this exact worktree cwd. */
export async function findLatestGrokSessionId(
  worktreePath: string,
  home?: string,
): Promise<string | null> {
  return (await findLatestGrokSummary(worktreePath, home))?.id ?? null;
}

export async function discoverGrokRecoverySessionId(
  worktreePath: string,
  agentCreatedAt: string,
  home?: string,
): Promise<string | null> {
  const artifacts: RecoverySessionArtifact[] = (
    await findGrokSummaries(worktreePath, home, undefined, true)
  ).map((summary) => ({
    sessionId: summary.id,
    createdAtMs: recoveryArtifactTimestamp(
      "Grok",
      summary.path,
      summary.createdAt,
    ),
    path: summary.path,
  }));
  return selectRecoverySessionId("Grok", agentCreatedAt, artifacts);
}

/**
 * The session directory whose summary records this exact worktree cwd — where
 * `updates.jsonl` (the turn and tool-call stream) and `signals.json` (the
 * context reading) live. Pass `sessionId` whenever the row has one: without it
 * this resolves the newest session for the cwd, and a reused worktree still
 * holds every dead predecessor's session.
 */
export async function findLatestGrokSessionDirectory(
  worktreePath: string,
  sessionId?: string,
  home?: string,
): Promise<string | null> {
  return (
    (await findLatestGrokSummary(worktreePath, home, sessionId))?.directory ??
    null
  );
}

export async function readLiveGrokModel(
  worktreePath: string,
  sessionId?: string,
  home?: string,
): Promise<string | null> {
  return (
    (await findLatestGrokSummary(worktreePath, home, sessionId))?.model ?? null
  );
}
