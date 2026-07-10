import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ClaudeRoute } from "../../schemas";

export interface ClaudeSpawnOptions {
  name: string;
  model: ClaudeRoute["model"];
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  /** Launch with the Channels research preview so the hive-channel bridge
   * can push daemon messages into the running session. */
  channels?: boolean;
}

export type ClaudeAgentConfigOptions = Pick<
  ClaudeSpawnOptions,
  "name" | "daemonPort" | "readOnly" | "channels"
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

const runCommand: CommandRunner = async (argv) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
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
): Promise<string | null> {
  try {
    const result = await run(["claude", "--version"]);
    if (result.exitCode !== 0) return null;
    return /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
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
  const command = ["claude"];
  if (options.model !== "default") {
    command.push("--model", options.model);
  }
  if (options.readOnly) {
    command.push("--permission-mode", "default");
  }
  if (options.channels ?? false) {
    command.push(
      CLAUDE_CHANNELS_FLAG,
      `server:${HIVE_CHANNEL_SERVER_NAME}`,
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
  home = homedir(),
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

  const settings = {
    enableAllProjectMcpServers: true,
    hooks: {
      SessionStart: hook(eventCommand("session-start")),
      ...(isRecord(existingSettings.hooks) &&
          "UserPromptSubmit" in existingSettings.hooks
        ? {}
        : { UserPromptSubmit: hook(eventCommand("turn-start")) }),
      Stop: hook(eventCommand("turn-end")),
      Notification: hook(eventCommand("notification")),
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
    },
  };

  const mergedSettings = deepMerge(existingSettings, settings);
  const mergedMcp = deepMerge(existingMcp, mcp);

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
