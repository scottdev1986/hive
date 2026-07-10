import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import {
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { ORCHESTRATOR_TMUX_SESSION } from "../daemon/orchestrator-lifecycle";
import { ORCHESTRATOR_BRIEF } from "./orchestrator-brief";

export type OrchestratorTool = "claude" | "codex";

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

interface FileSnapshot {
  path: string;
  contents: string | null;
}

type OrchestratorSpawn = (
  command: string[],
  options: {
    cwd: string;
    stdin: "inherit";
    stdout: "inherit";
    stderr: "inherit";
  },
) => { exited: Promise<number> };

const spawnOrchestrator: OrchestratorSpawn = (command, options) =>
  Bun.spawn(command, options);

async function snapshotFile(path: string): Promise<FileSnapshot> {
  return { path, contents: await readExisting(path) };
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.contents === null) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await writeFile(snapshot.path, snapshot.contents);
}

function claudeConfigPaths(cwd: string): string[] {
  return [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".mcp.json"),
  ];
}

async function prepareCodexConfig(cwd: string, port: number): Promise<void> {
  const configPath = join(cwd, ".codex", "config.toml");
  const existingConfig = await readExisting(configPath);
  try {
    await writeCodexAgentConfig(cwd, {
      daemonPort: port,
      name: "orchestrator",
      readOnly: true,
    });
  } finally {
    if (existingConfig !== null) {
      await writeFile(configPath, existingConfig);
    }
  }
}

export async function prepareOrchestratorConfig(
  tool: OrchestratorTool,
  port: number,
  cwd: string,
): Promise<void> {
  if (tool === "claude") {
    await writeClaudeAgentConfig(cwd, {
      daemonPort: port,
      name: "orchestrator",
      readOnly: true,
    });
    return;
  }
  await prepareCodexConfig(cwd, port);
}

export function buildOrchestratorCommand(
  tool: OrchestratorTool,
  port: number,
): string[] {
  if (tool === "claude") {
    return ["claude", "--append-system-prompt", ORCHESTRATOR_BRIEF];
  }
  return [
    "codex",
    "-c",
    `mcp_servers.hive.url="http://127.0.0.1:${port}/mcp"`,
    "--sandbox",
    "read-only",
    ORCHESTRATOR_BRIEF,
  ];
}

export function buildOrchestratorLaunchCommand(
  tool: OrchestratorTool,
  port: number,
  cwd: string,
): string[] {
  return [
    "tmux",
    "new-session",
    "-A",
    "-s",
    ORCHESTRATOR_TMUX_SESSION,
    "-c",
    cwd,
    ...buildOrchestratorCommand(tool, port),
  ];
}

export async function launchOrchestrator(
  tool: OrchestratorTool,
  port: number,
  cwd = process.cwd(),
  spawn: OrchestratorSpawn = spawnOrchestrator,
): Promise<number> {
  const snapshots = tool === "claude"
    ? await Promise.all(claudeConfigPaths(cwd).map(snapshotFile))
    : [];

  try {
    await prepareOrchestratorConfig(tool, port, cwd);
    const child = spawn(buildOrchestratorLaunchCommand(tool, port, cwd), {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } finally {
    await Promise.all(snapshots.map(restoreFile));
  }
}
