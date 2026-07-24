import { readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { selectRecoverySessionId } from "./recovery-session";
import { resolveProviderExecutable } from "./provider-executable";

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
  capabilityToken?: string;
  graphifyUrl?: string;
  /** The 0600 launch-prompt file, referenced from the hive agent's prompt
   * as `{file:<path>}`. Absent (crash recovery with no prompt on disk)
   * leaves the agent already on disk untouched. */
  instructionPath?: string;
  readOnly?: boolean;
}

export function resolveWorkingOpencodeExecutable() {
  return resolveProviderExecutable("opencode", [".opencode/bin/opencode"]);
}

export function opencodeConfigDirectory(
  home = Bun.env.HOME ?? homedir(),
): string {
  return Bun.env.OPENCODE_CONFIG_DIR ?? join(home, ".config", "opencode");
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
    if (match !== null) return match[1]!;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Write the worktree's `opencode.json` — opencode's project config, the
 * analog of claude's `.mcp.json` plus settings. Unrelated keys, servers, and
 * agents are preserved; the `hive` MCP entry and the `hive` agent are
 * Hive-owned and replaced wholesale. The bearer token lives only in this
 * 0600 file, never an argv, exactly like kimi's mcp.json; a spawn without a
 * fresh token keeps the authorization already on disk, and a missing
 * graphify URL removes a stale endpoint. `oauth: false` stops opencode's
 * OAuth auto-detection from intercepting the static bearer.
 */
export async function writeOpencodeAgentConfig(
  worktreePath: string,
  options: OpencodeAgentConfigOptions,
): Promise<void> {
  const path = join(worktreePath, "opencode.json");
  await mkdir(worktreePath, { recursive: true });
  const existing: Record<string, unknown> = await readFile(path, "utf8").then(
    (source) => {
      try {
        const parsed: unknown = JSON.parse(source);
        return isRecord(parsed) ? parsed : {};
      } catch {
        return {};
      }
    },
    (error: unknown) => {
      if (
        typeof error === "object" && error !== null && "code" in error &&
        error.code === "ENOENT"
      ) return {};
      throw error;
    },
  );
  const mcp = isRecord(existing.mcp) ? existing.mcp : {};
  const existingHive = isRecord(mcp.hive) ? mcp.hive : {};
  const existingHeaders = isRecord(existingHive.headers)
    ? existingHive.headers
    : {};
  const authorization = options.capabilityToken !== undefined
    ? `Bearer ${options.capabilityToken}`
    : typeof existingHeaders.Authorization === "string"
    ? existingHeaders.Authorization
    : undefined;
  mcp.hive = {
    type: "remote",
    url: `http://127.0.0.1:${options.daemonPort}/mcp`,
    enabled: true,
    oauth: false,
    ...(authorization === undefined
      ? {}
      : { headers: { Authorization: authorization } }),
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
  if (options.instructionPath !== undefined) {
    const agents = isRecord(existing.agent) ? existing.agent : {};
    agents[OPENCODE_HIVE_AGENT] = {
      description: "Hive-managed agent carrying the launch brief",
      mode: "primary",
      // {file:} is resolved by opencode itself; absolute paths are honored
      // (verified against opencode 1.18.3), so the brief never leaves the
      // 0600 launch-prompt file.
      prompt: `{file:${options.instructionPath}}`,
      ...(options.readOnly === true
        ? { permission: { edit: "deny", bash: "deny" } }
        : {}),
    };
    existing.agent = agents;
  }
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile's mode only applies at creation; the bearer token in this file
  // must be 0600 even when a looser opencode.json was already on disk.
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
    return parsed.filter((entry): entry is OpencodeSessionEntry =>
      isRecord(entry) && typeof entry.id === "string" &&
      typeof entry.created === "number" && typeof entry.directory === "string"
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
