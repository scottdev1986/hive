import { type Dirent, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { shellQuote } from "../../daemon/session-host/shell-session";
import { resolveProviderExecutable } from "./provider-executable";
import {
  invalidRecoveryArtifactEvidence,
  isMissingRecoveryArtifact,
  type RecoverySessionArtifact,
  recoveryArtifactTimestamp,
  selectRecoverySessionId,
} from "./recovery-session";

export interface KimiSpawnOptions {
  model: string;
  readOnly: boolean;
  dangerous: boolean;
  executable?: string;
}

export interface KimiAgentConfigOptions {
  daemonPort: number;
  capabilityToken?: string;
  graphifyUrl?: string;
}

export function resolveWorkingKimiExecutable() {
  return resolveProviderExecutable("kimi", [".kimi-code/bin/kimi"]);
}

/**
 * The effective default an unflagged launch runs: `default_model` from the
 * config file. Kimi has no CLI surface that reports it (`kimi provider list`
 * prints the catalog, not the default), so the file is the surface.
 */
export function probeKimiDefaultModel(
  home: string = Bun.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"),
): string | null {
  try {
    const parsed = Bun.TOML.parse(
      readFileSync(join(home, "config.toml"), "utf8"),
    ) as { default_model?: unknown };
    return typeof parsed.default_model === "string" &&
      parsed.default_model.length > 0
      ? parsed.default_model
      : null;
  } catch {
    return null;
  }
}

/**
 * Hive's (readOnly, dangerous) posture mapped to Kimi's permission modes:
 *
 * - readOnly (Hive "manual") maps to Kimi's default `manual` mode — no flag.
 *   Kimi offers no flag to force manual back on, so an operator whose
 *   config.toml pins `default_permission_mode = "yolo"`/`"auto"` launches a
 *   Hive read-only agent under that mode instead; Kimi has no per-launch
 *   read-only or per-tool deny channel (its `[[permission.rules]]` live only
 *   in the global config.toml, which Hive does not write).
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
 * Kimi has no `--append-system-prompt`/`--rules` flag, and its interactive TUI
 * rejects a positional prompt ("unknown command"). Its project instruction
 * surface is `<project>/.kimi-code/AGENTS.md`, which the CLI loads into the
 * system context (verified against kimi 0.28.1): the shared 0600 prompt file
 * is installed there, and the kickoff — which claude/codex pass as the opening
 * positional and grok as its trailing prompt — rides as the closing section
 * because Kimi offers no launch-time user-message channel at all.
 */
export function wrapKimiWithInstructionFile(
  command: string,
  path: string,
  initialPrompt?: string,
): string {
  const target = ".kimi-code/AGENTS.md";
  const copy = `mkdir -p .kimi-code && install -m 600 ${shellQuote(
    path,
  )} ${shellQuote(target)}`;
  const kickoff =
    initialPrompt === undefined
      ? ""
      : ` && printf '\\n\\n## Opening instruction\\n\\n%s\\n' ${shellQuote(
          initialPrompt,
        )} >> ${shellQuote(target)}`;
  // No `exec` here: the wrapped command may carry an env-assignment prefix
  // (wrapKimiSpawnWithEffort), which `exec` would try to run as a program.
  return `${copy}${kickoff} && ${command}`;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Write the worktree's `.kimi-code/mcp.json` — Kimi's project-level MCP
 * surface, the analog of claude's `.mcp.json`. Unrelated servers are
 * preserved; the `hive` entry is replaced wholesale and carries the bearer
 * token in a 0600 file (never an argv), exactly like grok's config.toml. A
 * spawn without a fresh token keeps the authorization already on disk, and a
 * missing graphify URL removes a stale entry rather than leaving a dead
 * endpoint behind.
 */
export async function writeKimiAgentConfig(
  worktreePath: string,
  options: KimiAgentConfigOptions,
): Promise<void> {
  const directory = join(worktreePath, ".kimi-code");
  const path = join(directory, "mcp.json");
  await mkdir(directory, { recursive: true });
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
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return {};
      throw error;
    },
  );
  const servers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  const existingHive = isRecord(servers.hive) ? servers.hive : {};
  const existingHeaders = isRecord(existingHive.headers)
    ? existingHive.headers
    : {};
  const authorization =
    options.capabilityToken !== undefined
      ? `Bearer ${options.capabilityToken}`
      : typeof existingHeaders.Authorization === "string"
        ? existingHeaders.Authorization
        : undefined;
  servers.hive = {
    url: `http://127.0.0.1:${options.daemonPort}/mcp`,
    ...(authorization === undefined
      ? {}
      : { headers: { Authorization: authorization } }),
  };
  if (options.graphifyUrl === undefined) delete servers.graphify;
  else servers.graphify = { url: options.graphifyUrl };
  existing.mcpServers = servers;
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile's mode only applies at creation; the bearer token in this file
  // must be 0600 even when a looser mcp.json was already on disk.
  await chmod(path, 0o600);
}

export function kimiSessionsDirectory(
  home = Bun.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"),
): string {
  return join(home, "sessions");
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
