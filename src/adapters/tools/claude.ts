import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Route } from "../../schemas";

export interface ClaudeSpawnOptions {
  name: string;
  model: Route["model"];
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
}

export type ClaudeAgentConfigOptions = Pick<
  ClaudeSpawnOptions,
  "name" | "daemonPort" | "readOnly"
>;

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
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, hiveValue] of Object.entries(hive)) {
    const existingValue = merged[key];
    merged[key] =
      isRecord(existingValue) && isRecord(hiveValue)
        ? deepMerge(existingValue, hiveValue)
        : hiveValue;
  }
  return merged;
}

export function buildClaudeSpawnCommand(
  options: ClaudeSpawnOptions,
): string[] {
  const command = ["claude", "--model", options.model];
  if (options.readOnly) {
    command.push("--permission-mode", "default");
  }
  return command;
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
          "Bash(git status:*)",
          "Bash(git log:*)",
          "Bash(git diff:*)",
          "Bash(ls:*)",
          "Bash(cat:*)",
          "Bash(rg:*)",
          "Bash(grep:*)",
          "Bash(find:*)",
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
    permissions,
  };
  const mcp = {
    mcpServers: {
      hive: {
        type: "http",
        url: `http://127.0.0.1:${options.daemonPort}/mcp`,
      },
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
