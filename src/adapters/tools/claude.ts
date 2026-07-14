import { createReadStream, existsSync } from "node:fs";
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
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
  GRAPHIFY_HOOK_SCRIPT,
  graphifyHookPath,
  writeGraphifyHook,
  type GraphifyHookKind,
} from "./graphify-hook";
import { hiveInstanceSuffix } from "../../daemon/tmux-sessions";
import { withFileLock } from "../file-lock";
import {
  invalidRecoveryArtifactEvidence,
  isMissingRecoveryArtifact,
  recoveryArtifactTimestamp,
  RecoverySessionDiscoveryError,
  selectRecoverySessionId,
  type RecoverySessionArtifact,
} from "./recovery-session";

export interface ClaudeSpawnOptions {
  name: string;
  model: string;
  effort?: string;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  /** Suppress interactive permission prompts. Read-only authority remains
   * enforced independently by denied tools and server capabilities. */
  dangerous?: boolean;
  /** The per-repo graphify MCP server, when the daemon has one up and healthy
   * (docs/graphify/integration.md). Absent means no entry at all:
   * a dead URL in the config would cost every agent a connect-timeout. */
  graphifyUrl?: string;
  /** Absolute path selected by the daemon. tmux servers can outlive the
   * daemon and retain a different PATH, so production launches must not ask
   * the pane to resolve `claude` again. */
  executable?: string;
  /** Restrict the session to the worktree's own `.mcp.json` — Hive's `hive`
   * server — instead of also inheriting every server
   * configured for the human's interactive sessions. Absent means today's
   * inherit-everything behavior. */
  scopedMcpConfigPath?: string;
  /** Hive-owned settings file for a launch that must not read project or local
   * settings from its cwd. User settings still apply. */
  scopedSettingsPath?: string;
  /** Additional system instructions for this session. */
  appendSystemPrompt?: string;
  /** Exact argv prefix for this Hive build. Installed releases pass their
   * absolute binary path so hooks and MCP helpers cannot attach to a
   * different installation (or fail because `hive` is absent from PATH).
   * Source-mode and focused adapter tests may omit it and use `hive`. */
  hiveCommand?: readonly string[];
}

export type ClaudeAgentConfigOptions = Pick<
  ClaudeSpawnOptions,
  | "name"
  | "daemonPort"
  | "readOnly"
  | "dangerous"
  | "graphifyUrl"
  | "hiveCommand"
>;

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
 * CLI is missing or unparseable. */
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
 * (a stale `claude` shim can sit ahead of a working ~/.local/bin/claude on a
 * typical login PATH). */
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
        if (!/(?:^|\s)event [a-z-]+ --agent \S+ --port \d+/.test(hook.command)) {
          return false;
        }
        const owner = /--instance-id (\S+)/.exec(hook.command)?.[1];
        return owner === undefined || owner === instanceId;
      });
    });
  }
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
  // A reader under autonomy takes its mode from the worktree settings
  // ("bypassPermissions", paired there with a deny list that keeps it unable to
  // write). The flag would win over that file, so it must not be passed: it is
  // what pinned autonomous readers to manual approval, where the first WebFetch
  // raised a dialog no one was watching. An attended reader — the orchestrator,
  // and the read-only restart of a revoked writer — passes no autonomy and
  // still gets manual approval here.
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
    // `--mcp-config` is variadic; the strict flag terminates its value list.
    command.push(
      "--mcp-config",
      options.scopedMcpConfigPath,
      "--strict-mcp-config",
    );
  }
  if (options.appendSystemPrompt !== undefined) {
    command.push("--append-system-prompt", options.appendSystemPrompt);
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
  } catch (error) {
    if (isMissingRecoveryArtifact(error)) return null;
    return invalidRecoveryArtifactEvidence(
      "Claude",
      directory,
      "cannot be read",
    );
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

export async function discoverClaudeRecoverySessionId(
  worktreePath: string,
  agentCreatedAt: string,
  home = homedir(),
): Promise<string | null> {
  const directory = claudeProjectDirectory(worktreePath, home);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  const target = resolve(worktreePath);
  const artifacts: RecoverySessionArtifact[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(directory, entry);
    const sessionId = entry.slice(0, -".jsonl".length);
    const artifact = await readClaudeRecoveryArtifact(path, sessionId, target);
    if (artifact !== null) artifacts.push(artifact);
  }
  return selectRecoverySessionId("Claude", agentCreatedAt, artifacts);
}

async function readClaudeRecoveryArtifact(
  path: string,
  sessionId: string,
  target: string,
): Promise<RecoverySessionArtifact | null> {
  let earliest = Number.POSITIVE_INFINITY;
  let sawSessionRecord = false;
  let sawDifferentCwd = false;
  try {
    const input = createReadStream(path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof parsed !== "object" || parsed === null ||
          !("sessionId" in parsed) || parsed.sessionId !== sessionId
        ) continue;
        sawSessionRecord = true;
        if (!("timestamp" in parsed)) continue;
        if (!("cwd" in parsed) || typeof parsed.cwd !== "string") {
          invalidRecoveryArtifactEvidence("Claude", path, "has no cwd");
        }
        if (parsed.cwd !== target) {
          sawDifferentCwd = true;
          continue;
        }
        earliest = Math.min(
          earliest,
          recoveryArtifactTimestamp("Claude", path, parsed.timestamp),
        );
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } catch (error) {
    if (error instanceof RecoverySessionDiscoveryError) throw error;
    if (isMissingRecoveryArtifact(error)) return null;
    return invalidRecoveryArtifactEvidence(
      "Claude",
      path,
      "cannot be read",
    );
  }
  if (Number.isFinite(earliest)) {
    return { sessionId, createdAtMs: earliest, path };
  }
  if (sawSessionRecord && sawDifferentCwd) return null;
  return invalidRecoveryArtifactEvidence(
    "Claude",
    path,
    "has no timestamped session record",
  );
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

/** Trust exactly the agent worktree. Without folder trust Claude blocks and
 * discards the project permission rules that enforce read-only sessions. */
export async function seedClaudeWorktreeTrust(
  worktreePath: string,
  home = claudeHome(),
): Promise<void> {
  // The CLI keys projects by the resolved path, so a worktree reached through a
  // symlinked prefix (/tmp and /var are symlinks on macOS) must be seeded under
  // its real path or the entry silently never matches.
  const key = await realpath(worktreePath).catch(() => resolve(worktreePath));
  const configPath = claudeConfigPath(home);

  const seed = async (): Promise<void> => withFileLock(`${configPath}.hive.lock`, async () => {
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
    ].join(" ");

  // Denied tools are removed from the session and its subagents, including in
  // bypass mode; the permission mode alone does not make a session read-only.
  const readOnlyDeny = ["Edit", "Write", "NotebookEdit", "Bash"];

  const permissions = options.readOnly
    ? (options.dangerous ?? false)
      ? {
          // The deny list defines read-only; an allow list would require Hive
          // to predict every present and future read tool.
          defaultMode: "bypassPermissions",
          deny: readOnlyDeny,
        }
      : {
          defaultMode: "default",
          deny: readOnlyDeny,
          allow: [
            "Read",
            "Glob",
            "Grep",
            // Vendor permission prompts are outside Hive's approval queue. The
            // reader capability still denies write/land server-side, while this
            // rule lets the agent report, acknowledge, and escalate unattended.
            "mcp__hive__*",
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

  // Every bypass-mode session, including an autonomous reader, needs the
  // worktree-local acknowledgement or it blocks on an interactive warning.
  const bypassingPermissions = options.dangerous ?? false;
  const graphifyHook = graphifyHookPath(worktreePath, ".claude");
  // The kind is typed, not a free string: it is the token the generated hook
  // dispatches on, and a spelling the script has no arm for silently never
  // nudges.
  const graphifyCommand = (kind: GraphifyHookKind): string =>
    `${shellToken(graphifyHook)} ${kind}`;

  const settings = {
    enableAllProjectMcpServers: true,
    ...(bypassingPermissions ? { skipDangerousModePermissionPrompt: true } : {}),
    hooks: {
      SessionStart: hook(eventCommand("session-start")),
      // Always write the current daemon endpoint. deepMerge preserves the
      // user's own UserPromptSubmit hooks alongside Hive's.
      UserPromptSubmit: hook(eventCommand("turn-start")),
      Stop: hook(eventCommand("turn-end")),
      Notification: hook(eventCommand("notification")),
      // The mid-turn safe boundary for urgent injection (SPEC decision 1):
      // without it a busy agent's queued urgent controls wait for the end of
      // a possibly hour-long turn. The daemon treats it as a delivery tick,
      // never a status change or an events-table row.
      PostToolUse: hook(eventCommand("tool-boundary")),
      ...(options.graphifyUrl === undefined
        ? {}
        : {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  { type: "command", command: graphifyCommand("claude-search") },
                ],
              },
              // Grep belongs HERE, not on the Bash matcher. The `search` branch
              // filters shell commands with case-sensitive lowercase patterns
              // (*grep*, *"rg "*), and a native Grep call's hook input says
              // `"tool_name":"Grep"` — capital G, no shell command at all — so
              // it would fall straight through that filter and exit silent. The
              // gap that mattered: `Bash` only ever caught SHELLED-OUT search,
              // which is the route the harness steers models away from, while
              // the native Grep tool — the likeliest search of all — was in no
              // matcher whatsoever. This branch suppresses nothing but reads of
              // graph output, which is the correct rule for Grep too: an agent
              // already grepping inside graphify-out/ needs no nudge.
              {
                matcher: "Read|Glob|Grep",
                hooks: [
                  { type: "command", command: graphifyCommand("claude-read") },
                ],
              },
            ],
          }),
    },
    // The statusLine JSON carries the subscriber's five-hour/weekly usage;
    // the command forwards it to the daemon as semi-official quota telemetry.
    statusLine: {
      type: "command",
      command: [
        hiveInvocation,
        "statusline",
        "--agent",
        shellToken(options.name),
        "--port",
        String(options.daemonPort),
        "--instance-id",
        hiveInstanceSuffix(),
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
        headersHelper:
          `${hiveInvocation} credential --agent ${shellToken(options.name)}`,
      },
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
  // A missing URL must remove a stale merged entry or every respawn retains a
  // dead endpoint.
  if (
    options.graphifyUrl === undefined &&
    isRecord(mergedMcp.mcpServers)
  ) {
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

  await Promise.all([
    writeGraphifyHook(graphifyHook, options.graphifyUrl),
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
