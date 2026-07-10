import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMemoryIndex } from "../adapters/memory";
import { ITerm2Adapter } from "../adapters/iterm2";
import { TerminalAppAdapter } from "../adapters/terminal-app";
import { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeSpawnCommand,
  detectClaudeCliVersion,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { CHANNELS_MIN_VERSION, versionAtLeast } from "../daemon/channels";
import {
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { readCredential } from "../daemon/credentials";
import { operatorHeaders } from "./credential";
import { orchestratorTmuxSession } from "../daemon/orchestrator-lifecycle";
import type { TerminalHandle } from "../schemas";
import { ORCHESTRATOR_BRIEF, orchestratorDocGuidance } from "./orchestrator-brief";
import { loadProfile } from "../adapters/profile";

export type OrchestratorTool = "claude" | "codex";
export type OrchestratorTerminalApp = "auto" | "terminal" | "iterm2";

export function codexRootSocketPath(home = Bun.env.HIVE_HOME ?? "~/.hive"): string {
  const safe = home.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  return `/tmp/hive-codex-root-${safe}.sock`;
}

/** Authority-first command for the Codex root driver. */
export function buildCodexRootAuthorityCommand(
  socketPath = codexRootSocketPath(),
): string[] {
  return [
    "sh",
    "-lc",
    `codex app-server --listen unix://${socketPath} & authority=$!; ` +
      `trap 'kill "$authority" 2>/dev/null || true' EXIT INT TERM; ` +
      `for attempt in $(seq 1 50); do ` +
      `test -S '${socketPath}' && break; sleep 0.1; done; ` +
      `test -S '${socketPath}' || { echo 'Codex app-server failed to become ready' >&2; exit 1; }; ` +
      `exec codex --remote unix://${socketPath}`,
  ];
}

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
  // Codex has no connect-time headers helper, so the orchestrator's token is
  // read from its 0600 credential file and written into the 0600 config.
  const capabilityToken = readCredential("orchestrator");
  try {
    await writeCodexAgentConfig(cwd, {
      daemonPort: port,
      name: "orchestrator",
      readOnly: true,
      ...(capabilityToken === null ? {} : { capabilityToken }),
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
      channels: true,
    });
    return;
  }
  await prepareCodexConfig(cwd, port);
}

/** Load the repo profile and format the orchestrator's repo-specific doc
 * guidance. A repo with no profile yet contributes "", leaving the generic
 * brief untouched rather than teaching hive's own doc names. */
export async function buildOrchestratorDocGuidance(cwd: string): Promise<string> {
  const profile = await loadProfile(cwd).catch(() => null);
  if (profile === null) return "";
  return orchestratorDocGuidance({
    primary: profile.docs.primary,
    loadBearing: profile.docs.briefable,
  });
}

export function buildOrchestratorCommand(
  tool: OrchestratorTool,
  port: number,
  memoryIndex = "",
  docGuidance = "",
): string[] {
  const brief = [ORCHESTRATOR_BRIEF, docGuidance, memoryIndex]
    .filter((part) => part !== "")
    .join("\n\n");
  if (tool === "claude") {
    return [
      ...buildClaudeSpawnCommand({
        name: "orchestrator",
        model: "default",
        worktreePath: process.cwd(),
        daemonPort: port,
        readOnly: true,
        channels: true,
      }),
      "--append-system-prompt",
      brief,
    ];
  }
  return [
    "codex",
    "-c",
    `mcp_servers.hive.url="http://127.0.0.1:${port}/mcp"`,
    "--sandbox",
    "read-only",
    brief,
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

export async function registerOrchestratorTerminal(
  port: number,
  handle: TerminalHandle,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/orchestrator-terminal`, {
    method: "POST",
    headers: { "content-type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({ handle }),
  });
  if (!response.ok) {
    throw new Error(
      `could not register the orchestrator terminal with Hive: HTTP ${response.status}`,
    );
  }
}

interface RunningTerminalRegistrationDependencies {
  listClientTtys: (session: string) => Promise<string[]>;
  captureTerminalApp: (tty: string) => Promise<TerminalHandle | null>;
  captureITerm2: (tty: string) => Promise<TerminalHandle | null>;
  register: (port: number, handle: TerminalHandle) => Promise<void>;
}

const runningTerminalRegistrationDependencies =
  (): RunningTerminalRegistrationDependencies => ({
    listClientTtys: async (session) =>
      await new TmuxAdapter().listClientTtys(session),
    captureTerminalApp: async (tty) =>
      await new TerminalAppAdapter().captureWindowByTty(tty),
    captureITerm2: async (tty) =>
      await new ITerm2Adapter().captureWindowByTty(tty),
    register: registerOrchestratorTerminal,
  });

// The recovery command asks tmux for the physical client attached to the
// already-live root, so it identifies the orchestrator window rather than the
// shell where `hive layout register` happens to run.
export async function registerRunningOrchestratorTerminal(
  port: number,
  app: OrchestratorTerminalApp = "auto",
  dependencies: RunningTerminalRegistrationDependencies =
    runningTerminalRegistrationDependencies(),
): Promise<TerminalHandle> {
  const ttys = await dependencies.listClientTtys(orchestratorTmuxSession());
  if (ttys.length !== 1) {
    throw new Error(
      ttys.length === 0
        ? "the Hive orchestrator has no attached terminal client"
        : "the Hive orchestrator has multiple attached terminal clients; detach all but one and retry",
    );
  }
  const tty = ttys[0]!;
  const captures = app === "terminal"
    ? [dependencies.captureTerminalApp]
    : app === "iterm2"
    ? [dependencies.captureITerm2]
    : [dependencies.captureTerminalApp, dependencies.captureITerm2];
  const handles: TerminalHandle[] = [];
  const errors: unknown[] = [];
  for (const capture of captures) {
    try {
      const handle = await capture(tty);
      if (handle !== null) handles.push(handle);
    } catch (error) {
      errors.push(error);
    }
  }
  if (handles.length !== 1) {
    if (handles.length > 1) {
      throw new Error(`multiple terminal applications claim orchestrator TTY ${tty}`);
    }
    if (errors.length > 0) throw errors[0];
    throw new Error(
      `could not find a supported terminal window for orchestrator TTY ${tty}`,
    );
  }
  const handle = handles[0]!;
  await dependencies.register(port, handle);
  return handle;
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
  memoryIndex = "",
  docGuidance = "",
): string[] {
  if (tool === "codex") {
    return ["tmux", "new-session", "-A", "-s", orchestratorTmuxSession(), "-c", cwd,
      ...buildCodexRootAuthorityCommand()];
  }
  return [
    "tmux",
    "new-session",
    "-A",
    "-s",
    orchestratorTmuxSession(),
    "-c",
    cwd,
    ...buildOrchestratorCommand(tool, port, memoryIndex, docGuidance),
  ];
}

export async function launchOrchestrator(
  tool: OrchestratorTool,
  port: number,
  cwd = process.cwd(),
  spawn: OrchestratorSpawn = spawnOrchestrator,
  captureTerminal: OrchestratorTerminalCapture = captureOrchestratorTerminal,
): Promise<number> {
  if (tool !== "claude") {
    // The authority command performs the handshake gate before attaching the
    // interactive remote TUI; delivery wiring is enabled by the daemon when
    // a root driver is registered for this socket/thread.
  }
  const version = await detectClaudeCliVersion();
  if (version === null || !versionAtLeast(version, CHANNELS_MIN_VERSION)) {
    throw new Error(
      `The Hive orchestrator requires Claude Channels (Claude >= ${CHANNELS_MIN_VERSION}).`,
    );
  }
  const snapshots = tool === "claude"
    ? await Promise.all(claudeConfigPaths(cwd).map(snapshotFile))
    : [];

  let registeredTerminal = false;
  try {
    const handle = await captureTerminal();
    if (handle !== null) {
      await registerOrchestratorTerminal(port, handle);
      registeredTerminal = true;
    }
  } catch (error) {
    // Window layout is cosmetic. Adapter, permission, and daemon registration
    // failures must never prevent the orchestrator process from launching.
    console.warn(
      `hive: terminal layout registration skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    await prepareOrchestratorConfig(tool, port, cwd);
    const [memoryIndex, docGuidance] = await Promise.all([
      buildMemoryIndex(cwd).catch(() => ""),
      buildOrchestratorDocGuidance(cwd).catch(() => ""),
    ]);
    const child = spawn(
      buildOrchestratorLaunchCommand(tool, port, cwd, memoryIndex, docGuidance),
      {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    return await child.exited;
  } finally {
    await Promise.all(snapshots.map(restoreFile));
    if (registeredTerminal) {
      await unregisterOrchestratorTerminal(port).catch(() => undefined);
    }
  }
}
