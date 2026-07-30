import { readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HIVE_CAPABILITY_TOKEN_ENV } from "./shared/capability-env";
import { ORCHESTRATOR_OPENCODE_PERMISSION } from "./shared/orchestrator-role";
import { isRecord, readProjectConfig } from "./shared/project-config";
import { resolveProviderExecutable } from "./shared/provider-executable";
import { selectRecoverySessionId } from "./shared/recovery-session";

/** The agent Hive writes into the worktree's opencode.json: it carries the
 * launch brief as its {file:} system prompt and the read-only barrier as its
 * permission set. */
export const OPENCODE_HIVE_AGENT = "hive";

export interface OpencodeSpawnOptions {
  model: string;
  readOnly: boolean;
  dangerous: boolean;
  executable?: string;
  /** Launch with this configured agent; Hive passes OPENCODE_HIVE_AGENT
   * whenever the worktree config carries the launch brief. */
  agent?: string;
}

export interface OpencodeAgentConfigOptions {
  daemonPort: number;
  graphifyUrl?: string;
  /** The 0600 launch-prompt file, referenced from the hive agent's prompt
   * as `{file:<path>}`. Absent (crash recovery with no prompt on disk)
   * leaves the agent already on disk untouched. */
  instructionPath?: string;
  readOnly?: boolean;
  /** The queen's role: Edit scoped to her memory and planning files and
   * Bash scoped to gh (orchestrator-role.ts), instead of the read-only
   * barrier. */
  orchestrator?: boolean;
  /** Directories opencode reads skills from on top of its own discovery. This
   * is the queen's channel: opencode offers no launch flag, and her skills are
   * provisioned outside the checkout (adapters/queen-skills.ts). */
  skillPaths?: readonly string[];
}

export interface OpencodeTurnPluginOptions {
  name: string;
  daemonPort: number;
  instanceId: string;
  providerRunId: string;
  hiveCommand?: readonly string[];
}

export function resolveWorkingOpencodeExecutable() {
  return resolveProviderExecutable("opencode", [".opencode/bin/opencode"]);
}

export function opencodeConfigDirectory(
  home = Bun.env.HOME ?? homedir(),
): string {
  return Bun.env.OPENCODE_CONFIG_DIR ?? join(home, ".config", "opencode");
}

/** opencode's durable session store: one sqlite database holding every
 * session's messages and tool-call parts, not per-session files. */
export function opencodeDatabasePath(home = Bun.env.HOME ?? homedir()): string {
  return join(home, ".local", "share", "opencode", "opencode.db");
}

/**
 * The effective default an unflagged launch runs: the `model` key of the
 * global config. The file is JSONC and `opencode models` never marks a
 * default, so a bare key read is the surface — a parse miss is unknown,
 * never a guess.
 */
export function probeOpencodeDefaultModel(
  directory: string = opencodeConfigDirectory(),
): string | null {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    let source: string;
    try {
      source = readFileSync(join(directory, name), "utf8");
    } catch {
      continue;
    }
    const match = /"model"\s*:\s*"([^"]+)"/.exec(source);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Hive's (readOnly, dangerous) posture mapped to opencode's surfaces:
 *
 * - readOnly is the reader barrier, expressed on the hive agent in the
 *   worktree config — `edit` (which covers write/edit/patch) and `bash`
 *   denied, everything else (read/grep/glob, MCP tools) at opencode's
 *   permissive default. This mirrors grok's deny Bash/Write/Edit barrier;
 *   opencode has no read-only flag.
 * - !readOnly maps to opencode's defaults: most tools allow, `doom_loop`
 *   and `external_directory` still ask, `.env` reads stay denied.
 * - dangerous maps to `--auto`: auto-approve everything not explicitly
 *   denied, which lifts those remaining prompts.
 */
function opencodeLaunchArgs(options: OpencodeSpawnOptions): string[] {
  const argv = [options.executable ?? "opencode", "-m", options.model];
  if (options.agent !== undefined) {
    argv.push("--agent", options.agent);
  }
  if (options.dangerous) argv.push("--auto");
  return argv;
}

export function buildOpencodeSpawnCommand(
  options: OpencodeSpawnOptions,
): string[] {
  return opencodeLaunchArgs(options);
}

/** Resume the exact durable session. `-s <id>` continues it directly. */
export function buildOpencodeResumeCommand(
  options: OpencodeSpawnOptions,
  sessionId: string,
): string[] {
  const argv = opencodeLaunchArgs(options);
  argv.splice(1, 0, "-s", sessionId);
  return argv;
}

/**
 * Where the plugin lands, relative to the worktree. Exported because worktree
 * reconciliation has to discount it: a file Hive writes into every opencode
 * worktree is not the agent's work, and counting it as such made every such
 * worktree look permanently dirty and therefore unsweepable.
 */
export const OPENCODE_TURN_PLUGIN_PATH = join(
  ".opencode",
  "plugins",
  "hive-turn-events.ts",
);

/**
 * OpenCode loads project plugins at startup. Its session.idle event is the
 * provider-owned completion signal, so this plugin reports only that boundary
 * instead of inferring state from terminal output or elapsed time.
 */
export async function writeOpencodeTurnPlugin(
  worktreePath: string,
  options: OpencodeTurnPluginOptions,
): Promise<void> {
  const hiveCommand = options.hiveCommand ?? ["hive"];
  if (hiveCommand.length === 0 || hiveCommand[0] === undefined) {
    throw new Error("Hive command must contain an executable");
  }
  const path = join(worktreePath, OPENCODE_TURN_PLUGIN_PATH);
  const directory = dirname(path);
  const args = [
    ...hiveCommand,
    "event",
    "turn-end",
    "--agent",
    options.name,
    "--port",
    String(options.daemonPort),
    "--instance-id",
    options.instanceId,
    "--provider-run-id",
    options.providerRunId,
  ];
  const source = `// Written by Hive. OpenCode's session.idle event is the only completion signal.\nexport const HiveTurnEvents = async () => ({\n  event: async ({ event }: { event: { type: string; properties?: { sessionID?: string } } }) => {\n    if (event.type !== "session.idle") return;\n    const sessionID = event.properties?.sessionID;\n    const args = ${JSON.stringify(args)};\n    if (sessionID !== undefined) args.push("--payload", JSON.stringify({ sessionId: sessionID }));\n    const child = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });\n    void child.exited;\n  },\n});\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(path, source, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Write the worktree's `opencode.json` — opencode's project config, the
 * analog of claude's `.mcp.json` plus settings. Unrelated keys, servers, and
 * agents are preserved; the `hive` MCP entry and the `hive` agent are
 * Hive-owned and replaced wholesale. The Authorization header names the
 * environment variable holding the bearer rather than the bearer itself, and a
 * missing graphify URL removes a stale endpoint. `oauth: false` stops
 * opencode's OAuth auto-detection from intercepting the static bearer.
 */
export async function writeOpencodeAgentConfig(
  worktreePath: string,
  options: OpencodeAgentConfigOptions,
): Promise<void> {
  const path = join(worktreePath, "opencode.json");
  await mkdir(worktreePath, { recursive: true });
  const existing = await readProjectConfig(path);
  const mcp = isRecord(existing.mcp) ? existing.mcp : {};
  mcp.hive = {
    type: "remote",
    url: `http://127.0.0.1:${options.daemonPort}/mcp`,
    enabled: true,
    oauth: false,
    // opencode 1.18.5 substitutes {env:VAR} in config strings at load, so the
    // live token stays in the environment and out of this project file.
    headers: { Authorization: `Bearer {env:${HIVE_CAPABILITY_TOKEN_ENV}}` },
  };
  if (options.graphifyUrl === undefined) delete mcp.graphify;
  else {
    mcp.graphify = {
      type: "remote",
      url: options.graphifyUrl,
      enabled: true,
    };
  }
  existing.mcp = mcp;
  // The hive agent's own permission block does not bind a subagent spawned
  // through the `task` tool: that subagent runs as a different agent and falls
  // back to the global block. opencode merges global with agent rules and lets
  // agent rules win, so a global barrier contains every agent in this worktree
  // without loosening the queen's scoped grants. Read-only has to hold for the
  // whole worktree, not just the primary agent. Keys the project already set
  // are preserved.
  if (options.readOnly === true && options.orchestrator !== true) {
    const permission = isRecord(existing.permission) ? existing.permission : {};
    permission.edit = "deny";
    permission.bash = "deny";
    existing.permission = permission;
  }
  if (options.skillPaths !== undefined && options.skillPaths.length > 0) {
    const skills = isRecord(existing.skills) ? existing.skills : {};
    skills.paths = [...options.skillPaths];
    existing.skills = skills;
  }
  if (options.instructionPath !== undefined) {
    const agents = isRecord(existing.agent) ? existing.agent : {};
    agents[OPENCODE_HIVE_AGENT] = {
      description: "Hive-managed agent carrying the launch brief",
      mode: "primary",
      // {file:} is resolved by opencode itself; absolute paths are honored
      // (verified against opencode 1.18.3), so the brief never leaves the
      // 0600 launch-prompt file.
      prompt: `{file:${options.instructionPath}}`,
      ...(options.orchestrator === true
        ? { permission: ORCHESTRATOR_OPENCODE_PERMISSION }
        : options.readOnly === true
          ? { permission: { edit: "deny", bash: "deny" } }
          : {}),
    };
    existing.agent = agents;
  }
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile's mode only applies at creation, and Hive rewrites whatever
  // opencode.json the project already had — including any credentials the
  // user's own servers keep in it.
  await chmod(path, 0o600);
}

interface OpencodeSessionEntry {
  id: string;
  created: number;
  directory: string;
}

/**
 * `opencode session list --format json` is project-scoped, so it is spawned
 * inside the worktree itself; the entries still carry an explicit directory
 * that must match (a reused worktree holds its dead predecessors' sessions).
 * An unreadable list is no candidates, never an error: the CLI may be gone
 * even though the agent's row survives.
 */
async function listOpencodeSessions(
  worktreePath: string,
  executable: string,
  timeoutMs = 10_000,
): Promise<OpencodeSessionEntry[]> {
  try {
    const result = Bun.spawnSync(
      [executable, "session", "list", "--format", "json"],
      {
        cwd: worktreePath,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
    if (result.exitCode !== 0) return [];
    const parsed: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is OpencodeSessionEntry =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.created === "number" &&
        typeof entry.directory === "string",
    );
  } catch {
    return [];
  }
}

function canonicalDirectory(path: string): string {
  const resolved = resolve(path);
  try {
    // opencode records the realpath (macOS /tmp → /private/tmp); compare
    // like with like.
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export async function discoverOpencodeRecoverySessionId(
  worktreePath: string,
  agentCreatedAt: string,
  executable = "opencode",
): Promise<string | null> {
  const target = canonicalDirectory(worktreePath);
  const artifacts = (await listOpencodeSessions(worktreePath, executable))
    .filter((entry) => canonicalDirectory(entry.directory) === target)
    .map((entry) => ({
      sessionId: entry.id,
      createdAtMs: entry.created,
      path: "opencode session list",
    }));
  return selectRecoverySessionId("opencode", agentCreatedAt, artifacts);
}
