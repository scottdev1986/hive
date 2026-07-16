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
import { writeCredential } from "../daemon/credentials";
import { getHiveHome } from "../daemon/db";
import { operatorHeaders } from "./credential";
import { orchestratorTmuxSession } from "../daemon/orchestrator-lifecycle";
import {
  hiveInstanceSuffix,
  hiveTmuxSocketName,
} from "../daemon/tmux-sessions";
import { ORCHESTRATOR_NAME, unknownVendor } from "../schemas";
import { ORCHESTRATOR_BRIEF, orchestratorDocGuidance } from "./orchestrator-brief";
import { discoverBriefableDocs } from "../adapters/briefing-docs";
import {
  buildGrokSpawnCommand,
  GROK_COMPATIBILITY_ENV,
  probeGrokCliVersion,
  probeGrokDefaultModel,
  writeGrokAgentConfig,
} from "../adapters/tools/grok";
import type { CapabilityProvider } from "../schemas";
import {
  buildCodexMcpExclusionArgs,
  listInheritedCodexMcpServers,
} from "../adapters/tools/mcp-scope";
import {
  CODEX_CAPABILITY_TOKEN_ENV,
  codexCompatibilityRefusal,
  probeCodexCliVersion,
} from "../adapters/tools/codex";
import { hiveCliSpawnArgv } from "../daemon/lifecycle";
import { IS_RELEASE_BUILD } from "../version";

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
  capabilityTokenFile = "",
): string[] {
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", `'"'"'`)}'`;
  const remoteCommand = [
    "codex",
    "--remote",
    `unix://${socketPath}`,
    // Keep startup and disconnect diagnostics visible in the native terminal.
    // The alternate screen erases the only provider evidence when a remote
    // TUI exits before it creates a thread.
    "--no-alt-screen",
    ...codexArguments,
  ].map(shellQuote).join(" ");
  // The app-server authority owns MCP/App startup. Passing these only to the
  // remote TUI is too late: an inherited server can already be blocking the
  // root before the client connects. Replay only authority-safe Codex config
  // overrides here, including Hive: MCP servers are created by the authority,
  // so passing Hive only to the remote TUI leaves the root with no Hive tools.
  const authorityConfigArguments: string[] = [];
  for (let index = 0; index < codexArguments.length; index += 1) {
    if (codexArguments[index] !== "-c") continue;
    const value = codexArguments[index + 1];
    if (value === undefined) continue;
    authorityConfigArguments.push("-c", value);
    index += 1;
  }
  const authorityConfig = authorityConfigArguments.length === 0
    ? ""
    : ` ${authorityConfigArguments.map(shellQuote).join(" ")}`;
  const quotedSocket = shellQuote(socketPath);
  const capabilityEnvironment = capabilityTokenFile === ""
    ? ""
    : `export ${CODEX_CAPABILITY_TOKEN_ENV}="$(cat ${
      shellQuote(capabilityTokenFile)
    })"; `;
  return [
    "sh",
    "-lc",
    `${capabilityEnvironment}codex app-server --listen ${shellQuote(`unix://${socketPath}`)}${authorityConfig} & authority=$!; ` +
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

/** The credential-store subject holding the Codex root's local Hive
 * capability. This authorizes Hive control-plane calls; it is not a provider
 * credential and Hive never reads or manages provider secrets. */
export const CODEX_ROOT_TOKEN_SUBJECT = "codex-root";

/** Ask the daemon to mint a root capability. Returns null
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

/** Provision the Codex root capability: mint a token and write it
 * to a 0600 file inside the 0700 credentials directory under the resolved
 * Hive home. Only the PATH is returned. The launch shell reads it into the
 * process-local bearer environment Codex supports; the token itself never
 * reaches argv or .codex/config.toml. */
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
        name: ORCHESTRATOR_NAME,
        readOnly: true,
        hiveCommand: hiveCliSpawnArgv(IS_RELEASE_BUILD, process.execPath),
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

/** Discover the repo's briefable docs and format the orchestrator's
 * repo-specific doc guidance. A repo whose docs cannot be walked contributes "",
 * leaving the generic brief untouched rather than teaching hive's own doc names. */
export async function buildOrchestratorDocGuidance(cwd: string): Promise<string> {
  const docs = await discoverBriefableDocs(cwd).catch(() => null);
  if (docs === null) return "";
  return orchestratorDocGuidance({
    primary: docs.primary,
    loadBearing: docs.briefable,
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
  codexMcpExclusionArgs: readonly string[] = [],
): string[] {
  const brief = [ORCHESTRATOR_BRIEF, recoveryBrief, docGuidance, memoryIndex]
    .filter((part) => part !== "")
    .join("\n\n");
  switch (tool) {
    case "claude": {
      const configRoot = orchestratorConfigRoot();
      return [
        ...buildClaudeSpawnCommand({
          name: ORCHESTRATOR_NAME,
          model: "default",
          worktreePath: process.cwd(),
          daemonPort: port,
          readOnly: true,
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
        // Apps/connectors are a separate Codex feature, not an inherited
        // mcp_servers table, and can otherwise hold the root at startup on
        // `codex_apps`. Hive orchestration needs only Hive's own MCP server.
        "-c",
        "features.apps=false",
        // Codex 0.144.4 enables internal subagents by default. A root child is
        // outside Hive's identity, quota, and lifecycle tracking while still
        // inheriting the root capability, so the coordinator must disable it.
        "-c",
        "features.multi_agent=false",
        // The root is a Hive coordinator, not a general-purpose Codex
        // session. Detach addressable MCP servers inherited from the user's
        // global config for this process only, exactly as Codex agents do.
        // This prevents an unrelated server's startup from blocking Hive.
        ...codexMcpExclusionArgs,
        "-c",
        `mcp_servers.hive.url="http://127.0.0.1:${port}/mcp"`,
        // The read-only root exists to call Hive's capability-scoped
        // orchestration tools. A prompt here deadlocks unattended delegation;
        // pre-approve only this Hive-owned server, never inherited MCPs.
        "-c",
        'mcp_servers.hive.default_tools_approval_mode="approve"',
        // Codex's supported bearer indirection. The launch shell populates
        // this process-local variable from the 0600 capability file; neither
        // the token nor a made-up config key appears in argv.
        ...(codexTokenFile === "" ? [] : [
          "-c",
          `mcp_servers.hive.bearer_token_env_var=${JSON.stringify(CODEX_CAPABILITY_TOKEN_ENV)}`,
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
  codexMcpExclusionArgs: readonly string[] = [],
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
        codexMcpExclusionArgs,
      );
      return ["tmux", "-L", hiveTmuxSocketName(), "new-session", "-s", orchestratorTmuxSession(), "-c", cwd,
        ...buildCodexRootAuthorityCommand(
          undefined,
          codexCommand.slice(1),
          codexTokenFile,
        ),
        ";", "set-option", "-g", "mouse", "on"];
    }
    case "claude":
      return [
        "tmux",
        "-L",
        hiveTmuxSocketName(),
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
        "-L",
        hiveTmuxSocketName(),
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
  listCodexMcpServers: () => Promise<string[]> = listInheritedCodexMcpServers,
  provisionCodexToken: (port: number) => Promise<string | null> =
    provisionCodexRootToken,
): Promise<number> {
  // Resolve and gate Claude only for the Claude path. A Codex orchestrator
  // must not require an unrelated Claude installation.
  let claudePath = "claude";
  switch (tool) {
    case "claude": {
      const claude = resolveExecutable();
      claudePath = claude.path;
      const version = await (detectVersion ?? (async () => claude.version))();
      if (version === null) {
        throw new Error(
          "the Claude orchestrator needs a working Claude Code CLI\n" +
            "Fix: repair or install Claude Code, then retry",
        );
      }
      break;
    }
    case "codex": {
      const version = await (detectVersion ?? probeCodexCliVersion)();
      const refusal = codexCompatibilityRefusal(version);
      if (refusal !== null) throw new Error(refusal);
      break;
    }
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
  let codexMcpExclusionArgs: string[] = [];
  switch (tool) {
    case "codex": {
      codexMcpExclusionArgs = buildCodexMcpExclusionArgs(
        await listCodexMcpServers(),
      ).args;
      const provisioned = await provisionCodexToken(port).catch(() => null);
      if (provisioned === null) {
        throw new Error(
          "the Hive daemon could not authorize the Codex orchestrator\n" +
            "Fix: run `hive stop`, then reopen Hive",
        );
      }
      codexTokenFile = provisioned;
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
      codexMcpExclusionArgs,
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
