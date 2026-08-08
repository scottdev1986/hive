import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { shellToken } from "../../shared/shell-quote";
import { hiveInstanceSuffix } from "../../hive-home/instance-identity";
import { isRecord } from "../../shared/is-record";
import { withFileLock } from "../file-lock";
import {
  GRAPHIFY_HOOK_SCRIPT,
  type GraphifyHookKind,
  graphifyHookPath,
  writeGraphifyHook,
} from "./shared/graphify-hook";
import { daemonMcpUrl } from "./shared/mcp-scope";
import { ORCHESTRATOR_CLAUDE_WRITE_RULES } from "./shared/orchestrator-role";
import {
  probeProviderExecutable,
  providerExecutableCandidates,
  resolveProviderExecutable,
} from "./shared/provider-executable";

export interface ClaudeSpawnOptions {
  name: string;
  model: string;
  effort?: string;
  /** Enable Claude's explicit agent-to-user message boundary. */
  brief?: boolean;
  /** Vendor autocompaction setting (`auto` or an absolute token budget). */
  autoCompact?: string;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  boardTools?: boolean;
  /** Suppress interactive permission prompts. Read-only authority remains enforced independently by denied tools and server capabilities. */
  dangerous?: boolean;
  /** The per-repo graphify MCP server, when the daemon has one up and healthy. Absent means no entry at all: a dead URL in the config would cost every agent a connect-timeout. */
  graphifyUrl?: string;
  /** Absolute path selected by the daemon. Terminal hosts can outlive the daemon and retain a different PATH, so production launches must not ask the pane to resolve `claude` again. */
  executable?: string;
  /** Restrict the session to the worktree's own `.mcp.json` — Hive's `hive` server — instead of also inheriting every server configured for the user's interactive sessions. Absent means today's inherit-everything behavior. */
  scopedMcpConfigPath?: string;
  /** Hive-owned settings file for a launch that must not read project or local settings from its cwd. User settings still apply. */
  scopedSettingsPath?: string;
  /** 0600 file containing additional system instructions for this session. */
  appendSystemPromptFile?: string;
  /** Exact argv prefix for this Hive build. Installed releases pass their absolute binary path so hooks and MCP helpers cannot attach to a different installation (or fail because `hive` is absent from PATH). Source-mode and focused adapter tests may omit it and use `hive`. */
  hiveCommand?: readonly string[];
}

export type ClaudeAgentConfigOptions = Pick<
  ClaudeSpawnOptions,
  | "name"
  | "daemonPort"
  | "readOnly"
  | "boardTools"
  | "dangerous"
  | "graphifyUrl"
  | "hiveCommand"
> & {
  providerRunId?: string;
};

const VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Synchronous `--version` probe. Non-billable by construction: `--version` never opens a session (a guessed subcommand, by contrast, becomes a billable prompt). Null means this executable cannot launch anything. */
export function probeClaudeVersion(executable: string): string | null {
  const output = probeProviderExecutable(executable, VERSION_PROBE_TIMEOUT_MS);
  if (output === null) return null;
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? "unknown";
}

/** The same `--version` probe without the synchronous wait. The runtime adapter's capability probe runs inside the daemon, where a spawnSync of a cold CLI blocks every request the daemon is serving for the duration of that boot; this variant yields the event loop instead. Same contract: null means this executable cannot launch anything. */
export async function probeClaudeVersionDetached(
  executable: string,
): Promise<string | null> {
  try {
    const child = Bun.spawn([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    if (child.exitCode !== 0) return null;
    const trimmed = output.trim();
    if (trimmed.length === 0) return "unknown";
    return /(\d+\.\d+\.\d+)/.exec(trimmed)?.[1] ?? "unknown";
  } catch {
    return null;
  }
}

/** Candidate installations in preference order: every PATH entry, then the native-installer locations a broken package-manager shim commonly shadows (a stale `claude` shim can sit ahead of a working ~/.local/bin/claude on a typical login PATH). */
export function claudeExecutableCandidates(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return providerExecutableCandidates(
    "claude",
    [".local/bin/claude", ".claude/local/claude"],
    env,
  );
}

export interface ResolvedClaudeExecutable {
  path: string;
  version: string | null;
}

/** Bind launches to an executable that provably works. A long-lived terminal host has its own environment, and PATH order happily serves a stale or broken installation first — so a candidate must answer `--version` before it may launch anything. No candidate answering resolves to the bare command with a null version; the protocol handshake remains the authority on whether that executable is usable. */
export function resolveWorkingClaudeExecutable(
  probe: (executable: string) => string | null = probeClaudeVersion,
  candidates: () => string[] = claudeExecutableCandidates,
): ResolvedClaudeExecutable {
  return (
    resolveProviderExecutable("claude", [], probe, candidates) ?? {
      path: "claude",
      version: null,
    }
  );
}

const hook = (
  command: string,
): { hooks: { type: "command"; command: string }[] }[] => [
  { hooks: [{ type: "command", command }] },
];

const claudeHome = (): string => process.env.HOME ?? homedir();

const isMissingFileError = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

function deepMerge(
  existing: Record<string, unknown>,
  hive: Record<string, unknown>,
  path: string[] = [],
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, hiveValue] of Object.entries(hive)) {
    const existingValue = merged[key];
    const nextPath = [...path, key];
    merged[key] =
      isRecord(existingValue) && isRecord(hiveValue)
        ? deepMerge(existingValue, hiveValue, nextPath)
        : Array.isArray(existingValue) &&
            Array.isArray(hiveValue) &&
            nextPath.length >= 2 &&
            (nextPath[0] === "hooks" || nextPath[0] === "permissions")
          ? [...existingValue, ...hiveValue].filter(
              (value, index, values) =>
                values.findIndex((candidate) =>
                  isDeepStrictEqual(candidate, value),
                ) === index,
            )
          : hiveValue;
  }
  return merged;
}

function removeOwnedHiveHooks(
  settings: Record<string, unknown>,
  instanceId: string,
): void {
  if (!isRecord(settings.hooks)) return;
  for (const [kind, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    settings.hooks[kind] = entries.filter((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some((hook) => {
        if (!isRecord(hook) || typeof hook.command !== "string") return false;
        if (
          !/(?:^|\s)event [a-z-]+ --agent \S+ --port \d+/.test(hook.command)
        ) {
          return false;
        }
        const owner = /--instance-id (\S+)/.exec(hook.command)?.[1];
        return owner === undefined || owner === instanceId;
      });
    });
  }
}

export function buildClaudeSpawnCommand(options: ClaudeSpawnOptions): string[] {
  const command = [options.executable ?? "claude"];
  if (options.model !== "default") {
    command.push("--model", options.model);
  }
  if (options.effort !== undefined) {
    command.push("--effort", options.effort);
  }
  if (options.brief === true) {
    command.push("--brief");
  }
  if (options.autoCompact !== undefined) {
    command.push("--autocompact", options.autoCompact);
  }
  // A reader under autonomy takes its mode from the worktree settings ("bypassPermissions", paired there with a deny list that keeps it unable to write). The flag would win over that file, so it must not be passed: it is what pinned autonomous readers to manual approval, where the first WebFetch raised a dialog no one was watching. An attended reader — the orchestrator, and the read-only restart of a revoked writer — passes no autonomy and still gets manual approval here.
  if (options.readOnly && !(options.dangerous ?? false)) {
    command.push("--permission-mode", "default");
  }
  if (options.scopedSettingsPath !== undefined) {
    command.push(
      "--settings",
      options.scopedSettingsPath,
      "--setting-sources",
      "user",
    );
  }
  if (options.scopedMcpConfigPath !== undefined) {
    command.push(
      "--mcp-config",
      options.scopedMcpConfigPath,
      "--strict-mcp-config",
    );
  }
  if (options.appendSystemPromptFile !== undefined) {
    command.push("--append-system-prompt-file", options.appendSystemPromptFile);
  }
  return command;
}

// Relaunches a crashed agent's actual conversation (`claude --resume <session-id>`, verified against claude CLI help) with the same launch flags the original spawn used; hooks and permissions come from the worktree config exactly as at spawn.

export function claudeConfigPath(home = claudeHome()): string {
  return join(home, ".claude.json");
}

let trustSeedQueue: Promise<void> = Promise.resolve();

const positiveInteger = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Trust exactly the agent worktree. Without folder trust Claude blocks and discards the project permission rules that enforce read-only sessions. */
export async function seedClaudeWorktreeTrust(
  worktreePath: string,
  home = claudeHome(),
): Promise<void> {
  // The CLI keys projects by the resolved path, so a worktree reached through a symlinked prefix (/tmp and /var are symlinks on macOS) must be seeded under its real path or the entry silently never matches.
  const key = await realpath(worktreePath).catch(() => resolve(worktreePath));
  const configPath = claudeConfigPath(home);

  const seed = async (): Promise<void> =>
    withFileLock(`${configPath}.hive.lock`, async () => {
      const config = await readJsonObject(configPath);
      const projects = isRecord(config.projects) ? config.projects : {};
      const existing = isRecord(projects[key]) ? projects[key] : {};
      // hasTrustDialogAccepted is the load-bearing key: on 2.1.206 it alone both clears the dialog and restores project-scoped settings. The onboarding pair is cheap insurance against a version that gates an interactive project-onboarding step on it, and stays inside this worktree's entry.
      const seeded = {
        ...existing,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: Math.max(
          1,
          positiveInteger(existing.projectOnboardingSeenCount),
        ),
      };
      // Re-spawns and crash recovery re-seed the same worktree; skipping the write keeps us out of the way of the CLI's own config writer.
      if (isDeepStrictEqual(existing, seeded)) return;

      const next = { ...config, projects: { ...projects, [key]: seeded } };
      // Rename onto the config so a concurrent reader never sees a half file.
      const temporaryPath = `${configPath}.hive-${process.pid}-${Date.now()}.tmp`;
      await mkdir(dirname(configPath), { recursive: true });
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
        await rename(temporaryPath, configPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });

  // Chain even on failure so one bad seed cannot wedge later spawns.
  const next = trustSeedQueue.then(seed, seed);
  trustSeedQueue = next.catch(() => undefined);
  await next;
}

export async function writeClaudeAgentConfig(
  worktreePath: string,
  options: ClaudeAgentConfigOptions,
): Promise<void> {
  const claudeDirectory = join(worktreePath, ".claude");
  await mkdir(claudeDirectory, { recursive: true });
  const settingsPath = join(claudeDirectory, "settings.local.json");
  const mcpPath = join(worktreePath, ".mcp.json");
  const [existingSettings, existingMcp] = await Promise.all([
    readJsonObject(settingsPath),
    readJsonObject(mcpPath),
  ]);
  removeOwnedHiveHooks(existingSettings, hiveInstanceSuffix());

  const hiveCommand = options.hiveCommand ?? ["hive"];
  if (hiveCommand[0] === undefined) {
    throw new Error("Hive command must contain an executable");
  }
  const hiveInvocation = hiveCommand.map(shellToken).join(" ");
  const eventCommand = (kind: string): string =>
    [
      hiveInvocation,
      "event",
      kind,
      "--agent",
      shellToken(options.name),
      "--port",
      String(options.daemonPort),
      "--instance-id",
      hiveInstanceSuffix(),
      ...(options.providerRunId === undefined
        ? []
        : ["--provider-run-id", shellToken(options.providerRunId)]),
    ].join(" ");

  // Denied tools are removed from the session and its subagents, including in bypass mode; the permission mode alone does not make a session read-only. Every built-in tool the vendor marks "Permission required: Yes" that can run a shell command or mutate the filesystem must appear here, because under bypassPermissions nothing else stops it. Re-check on CLI upgrades: a tool added upstream silently punches a hole in this list. Skill and Agent are deliberately absent: a skill's shell still goes through Bash, and a subagent's tool calls are checked against these same rules.
  const readOnlyDeny = [
    "Edit",
    "Write",
    "NotebookEdit",
    "Bash",
    "PowerShell",
    "Monitor",
    "EnterWorktree",
  ];
  const boardTools =
    (options.boardTools ?? false) && !(options.dangerous ?? false);
  // Queen delegates through Hive so every assignment has a board story and a
  // durable lifecycle. Claude's native Agent tool bypasses both.
  const attendedDeny = boardTools ? ["NotebookEdit", "Agent"] : readOnlyDeny;

  const permissions = options.readOnly
    ? (options.dangerous ?? false)
      ? {
          defaultMode: "bypassPermissions",
          deny: readOnlyDeny,
        }
      : {
          defaultMode: "default",
          deny: attendedDeny,
          allow: [
            "Read",
            "Glob",
            "Grep",
            // Vendor permission prompts are outside Hive's approval queue. The reader capability still denies write/land server-side, while this rule lets the agent report, acknowledge, and escalate unattended.
            "mcp__hive__*",
            ...(boardTools
              ? ["Bash(gh:*)", ...ORCHESTRATOR_CLAUDE_WRITE_RULES]
              : []),
          ],
        }
    : (options.dangerous ?? false)
      ? { defaultMode: "bypassPermissions" }
      : {
          defaultMode: "acceptEdits",
          allow: [
            "Read",
            "Glob",
            "Grep",
            "Edit",
            "Write",
            "NotebookEdit",
            "Bash(git status:*)",
            "Bash(git diff:*)",
            "Bash(git log:*)",
            "Bash(git add:*)",
            "Bash(git commit:*)",
            "Bash(bun test:*)",
            "Bash(bun run:*)",
          ],
        };

  // Every bypass-mode session, including an autonomous reader, needs the worktree-local acknowledgement or it blocks on an interactive warning.
  const bypassingPermissions = options.dangerous ?? false;
  const graphifyHook = graphifyHookPath(worktreePath, ".claude");
  // The kind is typed, not a free string: it is the token the generated hook dispatches on, and a spelling the script has no arm for silently never nudges.
  const graphifyCommand = (kind: GraphifyHookKind): string =>
    `${shellToken(graphifyHook)} ${kind}`;

  const settings = {
    enableAllProjectMcpServers: true,
    ...(bypassingPermissions
      ? { skipDangerousModePermissionPrompt: true }
      : {}),
    hooks: {
      SessionStart: hook(eventCommand("session-start")),
      UserPromptSubmit: hook(eventCommand("turn-start")),
      Stop: hook(eventCommand("turn-end")),
      Notification: hook(eventCommand("notification")),
      // This is the mid-turn safe boundary for urgent injection. Without it, a busy agent's queued urgent controls wait for the end of a possibly hour-long turn. The daemon treats it as a delivery tick, never a status change or an events-table row.
      PostToolUse: hook(eventCommand("tool-boundary")),
      ...(options.graphifyUrl === undefined
        ? {}
        : {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: graphifyCommand("claude-search"),
                  },
                ],
              },
              {
                matcher:
                  "Read|Glob|Grep|mcp__hive__graph_locate|mcp__graphify__.*",
                hooks: [
                  { type: "command", command: graphifyCommand("claude-read") },
                ],
              },
            ],
          }),
    },
    permissions,
  };
  const mcp = {
    mcpServers: {
      hive: {
        type: "http",
        url: daemonMcpUrl(options.daemonPort),
        // The capability travels through a helper Claude runs at connect time, not through `headers: {Authorization: "Bearer ${VAR}"}`. An env var would be inherited by every descendant of this agent's process; the helper reads a 0600 file with a close-on-exec descriptor instead.
        headersHelper: `${hiveInvocation} credential --agent ${shellToken(options.name)}`,
      },
      ...(options.graphifyUrl === undefined
        ? {}
        : {
            graphify: {
              type: "http",
              url: options.graphifyUrl,
            },
          }),
    },
  };

  const mergedSettings = deepMerge(existingSettings, settings);
  const mergedMcp = deepMerge(existingMcp, mcp);
  // A missing URL must remove a stale merged entry or every respawn retains a dead endpoint.
  if (options.graphifyUrl === undefined && isRecord(mergedMcp.mcpServers)) {
    delete mergedMcp.mcpServers.graphify;
  }
  if (
    options.graphifyUrl === undefined &&
    isRecord(mergedSettings.hooks) &&
    Array.isArray(mergedSettings.hooks.PreToolUse)
  ) {
    mergedSettings.hooks.PreToolUse = mergedSettings.hooks.PreToolUse.filter(
      (entry) => !JSON.stringify(entry).includes(GRAPHIFY_HOOK_SCRIPT),
    );
  }

  // deepMerge unions arrays under `permissions`, so a config written before the grant existed keeps its bare denials through every respawn and the allow rules never get a chance to apply — and deny outranks allow. Take the bare denials the role replaces back out.
  if (boardTools && isRecord(mergedSettings.permissions)) {
    const merged = mergedSettings.permissions;
    if (Array.isArray(merged.deny)) {
      merged.deny = merged.deny.filter(
        (tool) => tool !== "Bash" && tool !== "Edit" && tool !== "Write",
      );
    }
  }

  await Promise.all([
    writeGraphifyHook(graphifyHook, options.graphifyUrl),
    writeFile(settingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`),
    writeFile(mcpPath, `${JSON.stringify(mergedMcp, null, 2)}\n`),
  ]);
}
