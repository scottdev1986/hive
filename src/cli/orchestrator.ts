import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryIndex } from "../adapters/memory";
import { ITerm2Adapter } from "../adapters/iterm2";
import { TerminalAppAdapter } from "../adapters/terminal-app";
import { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeSpawnCommand,
  resolveWorkingClaudeExecutable,
  type ResolvedClaudeExecutable,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { CHANNELS_MIN_VERSION, versionAtLeast } from "../daemon/channels";
import {
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { writeCredential } from "../daemon/credentials";
import { operatorHeaders } from "./credential";
import { orchestratorTmuxSession } from "../daemon/orchestrator-lifecycle";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import type { TerminalHandle } from "../schemas";
import { ORCHESTRATOR_BRIEF, orchestratorDocGuidance } from "./orchestrator-brief";
import { ensureProfile } from "../adapters/profile";

export type OrchestratorTool = "claude" | "codex";
export type OrchestratorTerminalApp = "auto" | "terminal" | "iterm2";

/** The Codex root app-server socket. It lives in the per-user temp dir (0700
 * on macOS), never world-writable /tmp where any local user could pre-bind the
 * name, and is keyed by the same resolved-home hash the tmux session names use
 * — so two spellings of the same HIVE_HOME can no longer name two sockets. */
export function codexRootSocketPath(hiveHome?: string): string {
  const socket = join(
    tmpdir(),
    `hive-codex-root-${hiveInstanceSuffix(hiveHome)}.sock`,
  );
  // macOS caps sun_path at 104 bytes; an over-long TMPDIR must fail here with
  // its cause, not as an inscrutable bind error inside the tmux shell command.
  if (Buffer.byteLength(socket) > 103) {
    throw new Error(
      `Codex root socket path exceeds the AF_UNIX length limit: ${socket}. ` +
        "Point TMPDIR at a shorter directory.",
    );
  }
  return socket;
}

/** Authority-first command for the Codex root driver. */
export function buildCodexRootAuthorityCommand(
  socketPath = codexRootSocketPath(),
  codexArguments: readonly string[] = [],
): string[] {
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", `'"'"'`)}'`;
  const remoteCommand = [
    "codex",
    "--remote",
    `unix://${socketPath}`,
    ...codexArguments,
  ].map(shellQuote).join(" ");
  const quotedSocket = shellQuote(socketPath);
  return [
    "sh",
    "-lc",
    `codex app-server --listen ${shellQuote(`unix://${socketPath}`)} & authority=$!; ` +
      `trap 'kill "$authority" 2>/dev/null || true' EXIT INT TERM; ` +
      `for attempt in $(seq 1 50); do ` +
      `test -S ${quotedSocket} && break; sleep 0.1; done; ` +
      `test -S ${quotedSocket} || { echo 'Codex app-server failed to become ready' >&2; exit 1; }; ` +
      `exec ${remoteCommand}`,
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

type OrchestratorTmux = Pick<
  TmuxAdapter,
  "hasSession" | "listClientTtys" | "killSession"
>;

export async function prepareFreshOrchestratorSession(
  tmux: OrchestratorTmux = new TmuxAdapter(),
): Promise<void> {
  const session = orchestratorTmuxSession();
  if (!(await tmux.hasSession(session))) return;

  const clients = await tmux.listClientTtys(session);
  if (clients.length > 0) {
    throw new Error(
      `A Hive orchestrator is already active in tmux session ${session}; ` +
        "close it or run `hive stop` before starting another.",
    );
  }
  await tmux.killSession(session, { ignoreMissing: true });
}

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
  // No secret ever enters .codex/config.toml: the root's capability travels as
  // a single-use token FILE whose path rides the -c flag (see
  // provisionCodexRootToken). A pre-existing config is therefore safe to
  // restore immediately — the write only exists for the notify script.
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

/** The credential-store subject holding the single-use Codex root token. */
export const CODEX_ROOT_TOKEN_SUBJECT = "codex-root";

/** Ask the daemon to mint a single-use, short-lived root token. Returns null
 * when the daemon does not offer the endpoint yet or refuses — the launch
 * proceeds without a token rather than failing, matching the pre-token
 * behavior until the daemon side lands. */
export async function requestCodexRootToken(
  port: number,
): Promise<string | null> {
  const response = await fetch(`http://127.0.0.1:${port}/codex-root-token`, {
    method: "POST",
    headers: operatorHeaders(),
  }).catch(() => null);
  if (response === null || !response.ok) return null;
  const body = await response.json().catch(() => null) as
    | { token?: string }
    | null;
  return typeof body?.token === "string" && body.token.length > 0
    ? body.token
    : null;
}

/** Provision the Codex root capability: mint a single-use token and write it
 * to a 0600 file inside the 0700 credentials directory under the resolved
 * Hive home. Only the PATH is returned — the token itself never reaches argv,
 * env, or .codex/config.toml; the daemon exchanges it once over the root
 * socket for a connection-bound session and invalidates it on first use. */
export async function provisionCodexRootToken(
  port: number,
  request: (port: number) => Promise<string | null> = requestCodexRootToken,
  write: (subject: string, token: string) => string = writeCredential,
): Promise<string | null> {
  const token = await request(port);
  if (token === null) return null;
  return write(CODEX_ROOT_TOKEN_SUBJECT, token);
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
 * guidance. A repo whose profile cannot be built contributes "", leaving the
 * generic brief untouched rather than teaching hive's own doc names. */
export async function buildOrchestratorDocGuidance(cwd: string): Promise<string> {
  const profile = await ensureProfile(cwd).catch(() => null);
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
  executable = "claude",
  codexTokenFile = "",
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
        executable,
        appendSystemPrompt: brief,
      }),
    ];
  }
  return [
    "codex",
    "-c",
    `mcp_servers.hive.url="http://127.0.0.1:${port}/mcp"`,
    // The token FILE PATH, never the token: paths are not secrets, so argv and
    // ps can see this. Codex ignores the unknown key (verified against
    // codex-cli 0.144.1); the daemon reads it during the root-socket exchange.
    ...(codexTokenFile === "" ? [] : [
      "-c",
      `mcp_servers.hive.capability_token_file=${JSON.stringify(codexTokenFile)}`,
    ]),
    "--sandbox",
    "read-only",
    brief,
  ];
}

export type OrchestratorTerminalCapture = () => Promise<TerminalHandle | null>;

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
  // The daemon authenticates DELETE like POST; without the operator credential
  // it answers 401 and the stale handle would sit in the layout forever.
  await fetch(`http://127.0.0.1:${port}/orchestrator-terminal`, {
    method: "DELETE",
    headers: operatorHeaders(),
  });
}

export function buildOrchestratorLaunchCommand(
  tool: OrchestratorTool,
  port: number,
  cwd: string,
  memoryIndex = "",
  docGuidance = "",
  executable = "claude",
  codexTokenFile = "",
): string[] {
  if (tool === "codex") {
    // `codex --help` defines the initial brief as positional [PROMPT]. The
    // app-server has no prompt option, so it belongs on the remote TUI command
    // that creates the thread, after the ordinary config/sandbox flags.
    const codexCommand = buildOrchestratorCommand(
      tool,
      port,
      memoryIndex,
      docGuidance,
      "claude",
      codexTokenFile,
    );
    return ["tmux", "new-session", "-s", orchestratorTmuxSession(), "-c", cwd,
      ...buildCodexRootAuthorityCommand(undefined, codexCommand.slice(1))];
  }
  return [
    "tmux",
    "new-session",
    "-s",
    orchestratorTmuxSession(),
    "-c",
    cwd,
    ...buildOrchestratorCommand(tool, port, memoryIndex, docGuidance, executable),
  ];
}

export async function launchOrchestrator(
  tool: OrchestratorTool,
  port: number,
  cwd = process.cwd(),
  spawn: OrchestratorSpawn = spawnOrchestrator,
  // Workspace owns the viewer, so normal launches have no external terminal
  // handle to register with the daemon's legacy window wall.
  captureTerminal: OrchestratorTerminalCapture = async () => null,
  detectVersion?: () => Promise<string | null>,
  resolveExecutable: () => ResolvedClaudeExecutable = resolveWorkingClaudeExecutable,
  tmux: OrchestratorTmux = new TmuxAdapter(),
): Promise<number> {
  // Resolve and gate Claude only for the Claude path. A Codex orchestrator
  // must not require an unrelated Claude installation.
  let claudePath = "claude";
  if (tool === "claude") {
    const claude = resolveExecutable();
    claudePath = claude.path;
    const version = await (detectVersion ?? (async () => claude.version))();
    if (version === null || !versionAtLeast(version, CHANNELS_MIN_VERSION)) {
      throw new Error(
        `The Hive orchestrator requires Claude Channels (Claude >= ${CHANNELS_MIN_VERSION}).`,
      );
    }
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
    await prepareFreshOrchestratorSession(tmux);
    await prepareOrchestratorConfig(tool, port, cwd);
    let codexTokenFile = "";
    if (tool === "codex") {
      const provisioned = await provisionCodexRootToken(port).catch(() => null);
      if (provisioned === null) {
        // Pre-token daemons have no mint endpoint; degrade to the old
        // unauthenticated root instead of refusing to launch, but say so.
        console.warn(
          "hive: no single-use Codex root token available from the daemon; " +
            "launching the Codex orchestrator without one.",
        );
      } else {
        codexTokenFile = provisioned;
      }
    }
    const [memoryIndex, docGuidance] = await Promise.all([
      buildMemoryIndex(cwd).catch(() => ""),
      buildOrchestratorDocGuidance(cwd).catch(() => ""),
    ]);
    const child = spawn(
      buildOrchestratorLaunchCommand(
        tool,
        port,
        cwd,
        memoryIndex,
        docGuidance,
        claudePath,
        codexTokenFile,
      ),
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
