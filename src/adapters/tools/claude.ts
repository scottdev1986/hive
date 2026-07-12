import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ClaudeRoute } from "../../schemas";

export interface ClaudeSpawnOptions {
  name: string;
  model: ClaudeRoute["model"];
  effort?: string;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  /** Writer autonomy: bypass every permission prompt so the session needs no
   * human input. Applied through the worktree's settings
   * (permissions.defaultMode "bypassPermissions"). That mode raises a blocking
   * acceptance dialog on its own — the CLI keys the disclaimer on the mode, not
   * on the `--dangerously-skip-permissions` flag — so writeClaudeAgentConfig
   * pairs it with skipDangerousModePermissionPrompt in the same file. Verified
   * against claude 2.1.206. Ignored for read-only sessions. */
  dangerous?: boolean;
  /** Launch with the Channels research preview so the hive-channel bridge can
   * push daemon messages into the running session. Attended sessions only: the
   * flag raises a warning dialog nothing can pre-accept, so spawned agents
   * leave this off and take tmux delivery instead. */
  channels?: boolean;
  /** The per-repo graphify MCP server, when the daemon has one up and healthy
   * (docs/architecture/graphify-integration.md). Absent means no entry at all:
   * a dead URL in the config would cost every agent a connect-timeout. */
  graphifyUrl?: string;
  /** Absolute path selected by the daemon. tmux servers can outlive the
   * daemon and retain a different PATH, so production launches must not ask
   * the pane to resolve `claude` again. */
  executable?: string;
  /** Restrict the session to the worktree's own `.mcp.json` — Hive's `hive`
   * server plus the channel bridge — instead of also inheriting every server
   * configured for the human's interactive sessions. Absent means today's
   * inherit-everything behavior. */
  scopedMcpConfigPath?: string;
  /** Hive-owned settings file for a launch that must not read project or local
   * settings from its cwd. User settings still apply. */
  scopedSettingsPath?: string;
  /** Additional system instructions for this session. Emitted before the
   * Channels `--` terminator, which makes every following argument positional. */
  appendSystemPrompt?: string;
}

export type ClaudeAgentConfigOptions = Pick<
  ClaudeSpawnOptions,
  "name" | "daemonPort" | "readOnly" | "dangerous" | "channels" | "graphifyUrl"
>;

// The .mcp.json name of the stdio bridge Claude Code spawns as a subprocess.
// Channels only work over stdio servers, so the HTTP hive daemon cannot push
// directly; the bridge relays daemon deliveries into the session.
export const HIVE_CHANNEL_SERVER_NAME = "hive-channel";

// During the research preview, `server:` channel entries are only accepted
// behind the development flag; hive is not an allowlisted channel plugin.
export const CLAUDE_CHANNELS_FLAG = "--dangerously-load-development-channels";

export type CommandRunner = (argv: string[]) => Promise<{
  stdout: string;
  exitCode: number;
}>;

const VERSION_PROBE_TIMEOUT_MS = 5_000;

const runCommand: CommandRunner = async (argv) => {
  const child = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "ignore",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, exitCode };
};

/** Read the installed Claude CLI version (e.g. "2.1.206"), or null when the
 * CLI is missing or unparseable — callers must then skip Channels. */
export async function detectClaudeCliVersion(
  run: CommandRunner = runCommand,
  executable = "claude",
): Promise<string | null> {
  try {
    const result = await run([executable, "--version"]);
    if (result.exitCode !== 0) return null;
    return /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Synchronous `--version` probe. Non-billable by construction: `--version`
 * never opens a session (a guessed subcommand, by contrast, becomes a billable
 * prompt). Null means this executable cannot launch anything. */
export function probeClaudeVersion(executable: string): string | null {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    return /(\d+\.\d+\.\d+)/.exec(result.stdout.toString())?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Candidate installations in preference order: every PATH entry, then the
 * native-installer locations a broken package-manager shim commonly shadows
 * (a homebrew `claude` that prints "native binary not installed" sits ahead
 * of a working ~/.local/bin/claude on a typical login PATH). */
export function claudeExecutableCandidates(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const home = env.HOME ?? homedir();
  const fromPath = (env.PATH ?? "")
    .split(":")
    .filter((dir) => dir.length > 0)
    .map((dir) => join(dir, "claude"));
  const known = [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
  ];
  const candidates: string[] = [];
  for (const candidate of [...fromPath, ...known]) {
    if (!candidates.includes(candidate) && existsSync(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export interface ResolvedClaudeExecutable {
  path: string;
  version: string | null;
}

/** Bind launches to an executable that provably works. A long-lived tmux
 * server has its own environment, and PATH order happily serves a stale or
 * broken installation first — so a candidate must answer `--version` before
 * it may launch anything. No candidate answering resolves to the bare command
 * with a null version, which downstream version gates fail closed on. */
export function resolveWorkingClaudeExecutable(
  probe: (executable: string) => string | null = probeClaudeVersion,
  candidates: () => string[] = claudeExecutableCandidates,
): ResolvedClaudeExecutable {
  for (const candidate of candidates()) {
    const version = probe(candidate);
    if (version !== null) {
      return { path: candidate, version };
    }
  }
  return { path: "claude", version: null };
}

const shellToken = (value: string): string => {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

const hook = (command: string): { hooks: { type: "command"; command: string }[] }[] => [
  { hooks: [{ type: "command", command }] },
];

/** Claude Code resolves its config from $HOME, not from the passwd entry, so
 * Hive must read the same variable. os.homedir() ignores a reassigned HOME and
 * would silently point at the operator's real config. */
const claudeHome = (): string => process.env.HOME ?? homedir();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
        : Array.isArray(existingValue) && Array.isArray(hiveValue) &&
            nextPath.length >= 2 &&
            (nextPath[0] === "hooks" || nextPath[0] === "permissions")
        ? [...existingValue, ...hiveValue].filter((value, index, values) =>
            values.findIndex((candidate) =>
              isDeepStrictEqual(candidate, value)
            ) === index
          )
        : hiveValue;
  }
  return merged;
}

export function buildClaudeSpawnCommand(
  options: ClaudeSpawnOptions,
): string[] {
  const command = [options.executable ?? "claude"];
  if (options.model !== "default") {
    command.push("--model", options.model);
  }
  if (options.effort !== undefined) {
    command.push("--effort", options.effort);
  }
  if (options.readOnly) {
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
    // `--mcp-config <configs...>` is variadic in Claude 2.1.206, so the
    // non-variadic `--strict-mcp-config` must follow it to terminate the list.
    // Verified on this machine: with both flags a session exposes only the
    // servers in the named file (5 inherited servers and 41 MCP tools drop to
    // 1 server and 0 — `claude -p --output-format stream-json` init message).
    command.push(
      "--mcp-config",
      options.scopedMcpConfigPath,
      "--strict-mcp-config",
    );
  }
  if (options.appendSystemPrompt !== undefined) {
    command.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.channels ?? false) {
    command.push(
      CLAUDE_CHANNELS_FLAG,
      `server:${HIVE_CHANNEL_SERVER_NAME}`,
      // This option is variadic (`<channels...>`) in Claude 2.1.206. Without
      // a terminator it consumes Hive's positional task prompt and rejects
      // the prompt as an untagged channel entry. `--strict-mcp-config` already
      // terminates the `--mcp-config` list above, so exactly one `--` is
      // needed here — a second would itself be read as prompt text.
      "--",
    );
  }
  return command;
}

// Relaunches a crashed agent's actual conversation (`claude --resume
// <session-id>`, verified against claude CLI help) with the same launch
// flags the original spawn used; hooks and permissions come from the
// worktree config exactly as at spawn.
export function buildClaudeResumeCommand(
  options: ClaudeSpawnOptions,
  sessionId: string,
): string[] {
  const command = buildClaudeSpawnCommand(options);
  command.splice(1, 0, "--resume", sessionId);
  return command;
}

// Claude Code stores transcripts under ~/.claude/projects/<munged-cwd>/,
// where the munge replaces every non-alphanumeric path character with "-".
export function claudeProjectDirectory(
  worktreePath: string,
  home = claudeHome(),
): string {
  return join(
    home,
    ".claude",
    "projects",
    resolve(worktreePath).replace(/[^A-Za-z0-9]/g, "-"),
  );
}

// Disk-discovery fallback for a crashed agent whose session id was never
// captured from hook traffic: the newest transcript in the worktree's
// project directory is the session to resume.
export async function findLatestClaudeSessionId(
  worktreePath: string,
  home = homedir(),
): Promise<string | null> {
  const directory = claudeProjectDirectory(worktreePath, home);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  let newest: { sessionId: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    try {
      const info = await stat(join(directory, entry));
      if (newest === null || info.mtimeMs > newest.mtimeMs) {
        newest = { sessionId: entry.slice(0, -".jsonl".length), mtimeMs: info.mtimeMs };
      }
    } catch {
      // A transcript deleted mid-scan is simply not a candidate.
    }
  }
  return newest?.sessionId ?? null;
}

// Claude Code keeps per-project first-run state in ~/.claude.json.
export function claudeConfigPath(home = claudeHome()): string {
  return join(home, ".claude.json");
}

// One writer at a time per process. Parallel spawns would otherwise read the
// same config, add different worktrees, and the last rename would win.
let trustSeedQueue: Promise<void> = Promise.resolve();

const positiveInteger = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Pre-accept the folder-trust prompt for one Hive-created worktree.
 *
 * A fresh worktree is an unknown folder, so `claude` opens on a blocking
 * "Do you trust the files in this folder?" dialog that an unattended agent
 * cannot answer. The CLI documents this exact escape hatch in the error it
 * prints when it drops project settings: set
 * `projects[<path>].hasTrustDialogAccepted: true` in ~/.claude.json.
 *
 * Trust is also load-bearing beyond the dialog: an untrusted workspace makes
 * the CLI discard the project-scoped permission rules and hooks that Hive
 * writes into the worktree — including a read-only agent's deny list.
 *
 * Scope: this touches exactly one `projects` key, the agent worktree's own
 * absolute path, and never a global flag. The CLI resolves trust by walking
 * from the session cwd upward, so the worktree key alone is enough — Hive
 * never has to trust the repository root or affect the operator's own
 * sessions. (Accepting the dialog by hand records it against the main repo
 * instead, which is why this seeds the narrower key. Verified on 2.1.206.)
 */
export async function seedClaudeWorktreeTrust(
  worktreePath: string,
  home = claudeHome(),
): Promise<void> {
  // The CLI keys projects by the resolved path, so a worktree reached through a
  // symlinked prefix (/tmp and /var are symlinks on macOS) must be seeded under
  // its real path or the entry silently never matches.
  const key = await realpath(worktreePath).catch(() => resolve(worktreePath));
  const configPath = claudeConfigPath(home);

  const seed = async (): Promise<void> => {
    const config = await readJsonObject(configPath);
    const projects = isRecord(config.projects) ? config.projects : {};
    const existing = isRecord(projects[key]) ? projects[key] : {};
    // hasTrustDialogAccepted is the load-bearing key: on 2.1.206 it alone both
    // clears the dialog and restores project-scoped settings. The onboarding
    // pair is cheap insurance against a version that gates an interactive
    // project-onboarding step on it, and stays inside this worktree's entry.
    const seeded = {
      ...existing,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: Math.max(
        1,
        positiveInteger(existing.projectOnboardingSeenCount),
      ),
    };
    // Re-spawns and crash recovery re-seed the same worktree; skipping the
    // write keeps us out of the way of the CLI's own config writer.
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
  };

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

  const eventCommand = (kind: string): string =>
    [
      "hive",
      "event",
      kind,
      "--agent",
      shellToken(options.name),
      "--port",
      String(options.daemonPort),
    ].join(" ");

  const permissions = options.readOnly
    ? {
        defaultMode: "default",
        deny: ["Edit", "Write", "NotebookEdit", "Bash"],
        allow: [
          "Read",
          "Glob",
          "Grep",
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

  // bypassPermissions raises a blocking "WARNING: Claude Code running in Bypass
  // Permissions mode" dialog on every launch, whether the mode arrives from the
  // CLI flag or from these settings. The CLI clears it when
  // skipDangerousModePermissionPrompt is set in any settings source, and
  // localSettings (this file) is one of them — so the acceptance stays inside
  // the agent's worktree instead of relying on the operator's ~/.claude
  // settings. Measured against claude 2.1.206; without this key an unattended
  // writer stalls on the dialog forever.
  const dangerousWriter = !options.readOnly && (options.dangerous ?? false);

  const settings = {
    enableAllProjectMcpServers: true,
    ...(dangerousWriter ? { skipDangerousModePermissionPrompt: true } : {}),
    hooks: {
      SessionStart: hook(eventCommand("session-start")),
      ...(isRecord(existingSettings.hooks) &&
          "UserPromptSubmit" in existingSettings.hooks
        ? {}
        : { UserPromptSubmit: hook(eventCommand("turn-start")) }),
      Stop: hook(eventCommand("turn-end")),
      Notification: hook(eventCommand("notification")),
      // The mid-turn safe boundary for urgent injection (SPEC decision 1):
      // without it a busy agent's queued urgent controls wait for the end of
      // a possibly hour-long turn. The daemon treats it as a delivery tick,
      // never a status change or an events-table row.
      PostToolUse: hook(eventCommand("tool-boundary")),
    },
    // The statusLine JSON carries the subscriber's five-hour/weekly usage;
    // the command forwards it to the daemon as semi-official quota telemetry.
    statusLine: {
      type: "command",
      command: [
        "hive",
        "statusline",
        "--agent",
        shellToken(options.name),
        "--port",
        String(options.daemonPort),
      ].join(" "),
    },
    permissions,
  };
  const mcp = {
    mcpServers: {
      hive: {
        type: "http",
        url: `http://127.0.0.1:${options.daemonPort}/mcp`,
        // The capability travels through a helper Claude runs at connect time,
        // not through `headers: {Authorization: "Bearer ${VAR}"}`. An env var
        // would be inherited by every descendant of this agent's process; the
        // helper reads a 0600 file with a close-on-exec descriptor instead.
        headersHelper: `hive credential --agent ${shellToken(options.name)}`,
      },
      ...((options.channels ?? false)
        ? {
            [HIVE_CHANNEL_SERVER_NAME]: {
              type: "stdio",
              command: "hive",
              args: [
                "channel-bridge",
                "--agent",
                options.name,
                "--port",
                String(options.daemonPort),
              ],
            },
          }
        : {}),
      // The repo's local knowledge graph, read-only and loopback-only. Only
      // written when the daemon's server was healthy at spawn time.
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
  // A respawn merges over the previous spawn's file, so a graphify entry from
  // a daemon that is no longer serving would survive as a dead URL every
  // agent pays a connect-timeout for. No URL now means no entry, period.
  if (
    options.graphifyUrl === undefined &&
    isRecord(mergedMcp.mcpServers)
  ) {
    delete mergedMcp.mcpServers.graphify;
  }

  await Promise.all([
    writeFile(
      settingsPath,
      `${JSON.stringify(mergedSettings, null, 2)}\n`,
    ),
    writeFile(
      mcpPath,
      `${JSON.stringify(mergedMcp, null, 2)}\n`,
    ),
  ]);
}
