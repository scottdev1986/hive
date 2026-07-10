import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ITerm2Adapter } from "../adapters/iterm2";
import { TerminalAppAdapter } from "../adapters/terminal-app";
import {
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import {
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { ORCHESTRATOR_TMUX_SESSION } from "../daemon/orchestrator-lifecycle";
import type { TerminalHandle } from "../schemas";
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

export function readCurrentTty(): string | null {
  const result = Bun.spawnSync(["/usr/bin/tty"], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const tty = result.stdout.toString().trim();
  return tty.startsWith("/dev/") ? tty : null;
}

export type OrchestratorTerminalCapture = () => Promise<TerminalHandle | null>;

// The orchestrator runs in whatever terminal the user typed `hive claude`
// into, so unlike agent viewers there is no window-creation step that yields
// a handle. Identify the window by the TTY hive is attached to, but only in
// emulators whose windows hive knows how to drive; anywhere else (VS Code,
// Alacritty, an existing tmux) the orchestrator simply doesn't participate
// in the layout.
export const captureOrchestratorTerminal: OrchestratorTerminalCapture =
  async () => {
    if (Bun.env.TMUX !== undefined) {
      return null;
    }
    const tty = readCurrentTty();
    if (tty === null) {
      return null;
    }
    if (Bun.env.TERM_PROGRAM === "Apple_Terminal") {
      return await new TerminalAppAdapter().captureWindowByTty(tty);
    }
    if (Bun.env.TERM_PROGRAM === "iTerm.app") {
      return await new ITerm2Adapter().captureWindowByTty(tty);
    }
    return null;
  };

async function registerOrchestratorTerminal(
  port: number,
  handle: TerminalHandle,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/orchestrator-terminal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!response.ok) {
    throw new Error(
      `could not register the orchestrator terminal with Hive: HTTP ${response.status}`,
    );
  }
}

async function unregisterOrchestratorTerminal(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/orchestrator-terminal`, {
    method: "DELETE",
  });
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
  captureTerminal: OrchestratorTerminalCapture = captureOrchestratorTerminal,
): Promise<number> {
  const snapshots = tool === "claude"
    ? await Promise.all(claudeConfigPaths(cwd).map(snapshotFile))
    : [];

  let registeredTerminal = false;
  const handle = await captureTerminal();
  if (handle !== null) {
    // A supported terminal that cannot be scripted is configuration failure,
    // not an unsupported-terminal opt-out. Surface the adapter's actionable
    // macOS permission error in the foreground.
    await registerOrchestratorTerminal(port, handle);
    registeredTerminal = true;
  }

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
    if (registeredTerminal) {
      await unregisterOrchestratorTerminal(port).catch(() => undefined);
    }
  }
}
