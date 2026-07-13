import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryIndex } from "../adapters/memory";
import { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeSpawnCommand,
  resolveWorkingClaudeExecutable,
  type ResolvedClaudeExecutable,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { CHANNELS_MIN_VERSION, versionAtLeast } from "../daemon/channels";
import { writeCredential } from "../daemon/credentials";
import { getHiveHome } from "../daemon/db";
import { operatorHeaders } from "./credential";
import { orchestratorTmuxSession } from "../daemon/orchestrator-lifecycle";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import { unknownVendor } from "../schemas";
import { ORCHESTRATOR_BRIEF, orchestratorDocGuidance } from "./orchestrator-brief";
import { ensureProfile } from "../adapters/profile";
import {
  buildGrokSpawnCommand,
  GROK_COMPATIBILITY_ENV,
  probeGrokCliVersion,
  probeGrokDefaultModel,
  writeGrokAgentConfig,
} from "../adapters/tools/grok";
import type { CapabilityProvider } from "../schemas";

export type OrchestratorTool = CapabilityProvider;

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
      `the Codex socket path is too long for this system: ${socket}\n` +
        "Fix: point TMPDIR at a shorter directory",
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
    // A command the user has earned: Hive will not close a live orchestrator
    // out from under them in order to start another one.
    throw new Error(
      `an orchestrator is already running in tmux session ${session}\n` +
        "Fix: close it, or run `hive stop`, before starting another",
    );
  }
  await tmux.killSession(session, { ignoreMissing: true });
}

export function orchestratorConfigRoot(): string {
  return join(getHiveHome(), "runtime", "orchestrator");
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
  switch (tool) {
    case "claude":
      await writeClaudeAgentConfig(orchestratorConfigRoot(), {
        daemonPort: port,
        name: "orchestrator",
        readOnly: true,
        channels: true,
      });
      return;
    case "codex":
      // Nothing on disk, and that is the whole configuration: the Codex
      // orchestrator carries its hive server and sandbox on the `-c` flags
      // `buildOrchestratorCommand` builds. An empty arm is a decision, not an
      // omission — which is exactly what the old `if (claude)` could not say.
      return;
    case "grok": {
      const authorization = operatorHeaders().Authorization;
      await writeGrokAgentConfig(orchestratorConfigRoot(), {
        daemonPort: port,
        capabilityToken: authorization?.replace(/^Bearer\s+/, ""),
      });
      return;
    }
    default:
      unknownVendor(tool, "orchestrator config");
  }
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
  recoveryBrief = "",
): string[] {
  const brief = [ORCHESTRATOR_BRIEF, recoveryBrief, docGuidance, memoryIndex]
    .filter((part) => part !== "")
    .join("\n\n");
  switch (tool) {
    case "claude": {
      const configRoot = orchestratorConfigRoot();
      return [
        ...buildClaudeSpawnCommand({
          name: "orchestrator",
          model: "default",
          worktreePath: process.cwd(),
          daemonPort: port,
          readOnly: true,
          channels: true,
          executable,
          scopedSettingsPath: join(configRoot, ".claude", "settings.local.json"),
          scopedMcpConfigPath: join(configRoot, ".mcp.json"),
          appendSystemPrompt: brief,
        }),
      ];
    }
    case "codex":
      return [
        "codex",
        "-c",
        `mcp_servers.hive.url="http://127.0.0.1:${port}/mcp"`,
        // The token FILE PATH, never the token: paths are not secrets, so argv
        // and ps can see this. Codex ignores the unknown key (verified against
        // codex-cli 0.144.1); the daemon reads it during the root-socket
        // exchange.
        ...(codexTokenFile === "" ? [] : [
          "-c",
          `mcp_servers.hive.capability_token_file=${JSON.stringify(codexTokenFile)}`,
        ]),
        "--sandbox",
        "read-only",
        brief,
      ];
    case "grok": {
      const model = probeGrokDefaultModel();
      if (model === null) {
        throw new Error("grok models did not report an effective default");
      }
      return [
        ...buildGrokSpawnCommand({
          model,
          worktreePath: process.cwd(),
          readOnly: true,
        }),
        brief,
      ];
    }
    default:
      unknownVendor(tool, "orchestrator command");
  }
}

export function buildOrchestratorLaunchCommand(
  tool: OrchestratorTool,
  port: number,
  cwd: string,
  memoryIndex = "",
  docGuidance = "",
  executable = "claude",
  codexTokenFile = "",
  recoveryBrief = "",
): string[] {
  switch (tool) {
    case "codex": {
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
        recoveryBrief,
      );
      return ["tmux", "new-session", "-s", orchestratorTmuxSession(), "-c", cwd,
        ...buildCodexRootAuthorityCommand(undefined, codexCommand.slice(1)),
        ";", "set-option", "-g", "mouse", "on"];
    }
    case "claude":
      return [
        "tmux",
        "new-session",
        "-s",
        orchestratorTmuxSession(),
        "-c",
        cwd,
        ...buildOrchestratorCommand(
          tool,
          port,
          memoryIndex,
          docGuidance,
          executable,
          "",
          recoveryBrief,
        ),
        ";",
        "set-option",
        "-g",
        "mouse",
        "on",
      ];
    case "grok":
      return [
        "tmux",
        "new-session",
        "-s",
        orchestratorTmuxSession(),
        "-c",
        cwd,
        "env",
        `GROK_HOME=${join(orchestratorConfigRoot(), ".grok")}`,
        ...Object.entries(GROK_COMPATIBILITY_ENV).map(([key, value]) =>
          `${key}=${value}`
        ),
        ...buildOrchestratorCommand(
          tool,
          port,
          memoryIndex,
          docGuidance,
          "claude",
          "",
          recoveryBrief,
        ),
        ";",
        "set-option",
        "-g",
        "mouse",
        "on",
      ];
    default:
      unknownVendor(tool, "orchestrator launch command");
  }
}

export async function launchOrchestrator(
  tool: OrchestratorTool,
  port: number,
  cwd = process.cwd(),
  spawn: OrchestratorSpawn = spawnOrchestrator,
  detectVersion?: () => Promise<string | null>,
  resolveExecutable: () => ResolvedClaudeExecutable = resolveWorkingClaudeExecutable,
  tmux: OrchestratorTmux = new TmuxAdapter(),
  recoveryBrief = "",
): Promise<number> {
  // Resolve and gate Claude only for the Claude path. A Codex orchestrator
  // must not require an unrelated Claude installation.
  let claudePath = "claude";
  switch (tool) {
    case "claude": {
      const claude = resolveExecutable();
      claudePath = claude.path;
      const version = await (detectVersion ?? (async () => claude.version))();
      if (version === null || !versionAtLeast(version, CHANNELS_MIN_VERSION)) {
        throw new Error(
          `the orchestrator needs Claude ${CHANNELS_MIN_VERSION} or newer (for Channels)\n` +
            "Fix: update Claude Code, then retry",
        );
      }
      break;
    }
    case "codex":
      // No gate: Codex's own binary is what launches, and Channels is a Claude
      // feature. A future vendor must state its own minimum here rather than
      // inherit Codex's silence — an ungated launch of a CLI too old for the
      // hive MCP server stalls instead of failing.
      break;
    case "grok":
      if (probeGrokCliVersion() === null) {
        throw new Error("the Grok orchestrator needs a working grok CLI");
      }
      break;
    default:
      unknownVendor(tool, "orchestrator launch");
  }
  await prepareFreshOrchestratorSession(tmux);
  await prepareOrchestratorConfig(tool, port, cwd);
  let codexTokenFile = "";
  switch (tool) {
    case "codex": {
      const provisioned = await provisionCodexRootToken(port).catch(() => null);
      if (provisioned === null) {
        // A daemon predating the mint endpoint; degrade to the old
        // unauthenticated root rather than refuse to launch.
        //
        // Deliberately not printed. "No single-use Codex root token available
        // from the daemon" names our own plumbing, and there is nothing the
        // user can do with it — no command, no setting, no decision. A message
        // that cannot be acted on is not a warning, it is noise, and it trains
        // people to ignore the messages that do matter. The condition is real,
        // so it goes where a real diagnostic goes: the daemon's log, on the
        // side that knows it happened.
      } else {
        codexTokenFile = provisioned;
      }
      break;
    }
    case "claude":
      // Claude's orchestrator authenticates over the same operator
      // credential every Claude agent uses; there is no root token to mint.
      break;
    case "grok":
      // Grok authenticates through the operator credential written into its
      // worktree-local project MCP config above.
      break;
    default:
      unknownVendor(tool, "orchestrator root token");
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
      recoveryBrief,
    ),
    {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return await child.exited;
}
