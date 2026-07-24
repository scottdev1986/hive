import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMemoryIndex } from "../adapters/memory";
import {
  buildClaudeSpawnCommand,
  resolveWorkingClaudeExecutable,
  type ResolvedClaudeExecutable,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { writeCredential } from "../daemon/credentials";
import { getHiveHome } from "../daemon/db";
import { operatorHeaders } from "./credential";
import { orchestratorSessionKey } from "../daemon/orchestrator-lifecycle";
import { shellJoin } from "../daemon/session-host/shell-session";
import {
  normalizeNulText,
  ORCHESTRATOR_NAME,
  unknownVendor,
} from "../schemas";
import { ORCHESTRATOR_BRIEF, orchestratorDocGuidance } from "./orchestrator-brief";
import { discoverBriefableDocs } from "../adapters/briefing-docs";
import {
  buildGrokSpawnCommand,
  GROK_COMPATIBILITY_ENV,
  probeGrokDefaultModel,
  resolveWorkingGrokExecutable,
  writeGrokAgentConfig,
} from "../adapters/tools/grok";
import type { CapabilityProvider } from "../schemas";
import {
  buildCodexMcpExclusionArgs,
  listInheritedCodexMcpServers,
} from "../adapters/tools/mcp-scope";
import {
  CODEX_CAPABILITY_TOKEN_ENV,
  resolveWorkingCodexExecutable,
} from "../adapters/tools/codex";
import { hiveCliSpawnArgv } from "../daemon/lifecycle";
import { IS_RELEASE_BUILD } from "../version";
import { mintSessionRequestId } from "../daemon/session-host/locators";
import { OrchestratorSessiondLaunchSchema } from "../daemon/orchestrator-sessiond";
import {
  daemonOrchestratorSessiondControl,
  runOrchestratorSessiondLaunch,
  type OrchestratorSessiondControl,
} from "./orchestrator-sessiond";
import {
  codexInstructionProfileName,
  launchPromptPath,
  wrapGrokWithRulesFile,
  writeCodexInstructionProfile,
  writeLaunchPrompt,
} from "../daemon/launch-prompt";

export type OrchestratorTool = CapabilityProvider;

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
        boardTools: true,
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

export function buildOrchestratorInstructions(
  memoryIndex = "",
  docGuidance = "",
  recoveryBrief = "",
): string {
  return normalizeNulText(
    [ORCHESTRATOR_BRIEF, recoveryBrief, docGuidance, memoryIndex]
      .filter((part) => part !== "")
      .join("\n\n"),
  );
}

export function buildOrchestratorCommand(
  tool: OrchestratorTool,
  port: number,
  memoryIndex = "",
  docGuidance = "",
  executable?: string,
  codexTokenFile = "",
  recoveryBrief = "",
  codexMcpExclusionArgs: readonly string[] = [],
): string[] {
  const brief = buildOrchestratorInstructions(
    memoryIndex,
    docGuidance,
    recoveryBrief,
  );
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
          executable: executable ?? "claude",
          scopedSettingsPath: join(configRoot, ".claude", "settings.local.json"),
          scopedMcpConfigPath: join(configRoot, ".mcp.json"),
          appendSystemPromptFile: launchPromptPath(orchestratorSessionKey()),
        }),
      ];
    }
    case "codex":
      return [
        executable ?? "codex",
        // Apps/connectors are a separate Codex feature, not an inherited
        // mcp_servers table, and can otherwise hold the root at startup on
        // `codex_apps`. Hive orchestration needs only Hive's own MCP server.
        "-c",
        "features.apps=false",
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
        "--profile",
        codexInstructionProfileName(orchestratorSessionKey()),
        // Codex's supported bearer indirection. The launch shell populates
        // this process-local variable from the 0600 capability file; neither
        // the token nor a made-up config key appears in argv.
        ...(codexTokenFile === "" ? [] : [
          "-c",
          `mcp_servers.hive.bearer_token_env_var=${JSON.stringify(CODEX_CAPABILITY_TOKEN_ENV)}`,
        ]),
        "--sandbox",
        "read-only",
      ];
    case "grok": {
      const grokExecutable = executable ?? "grok";
      const model = probeGrokDefaultModel(grokExecutable);
      if (model === null) {
        throw new Error("grok models did not report an effective default");
      }
      return [
        "sh",
        "-lc",
        wrapGrokWithRulesFile(shellJoin(buildGrokSpawnCommand({
          model,
          worktreePath: process.cwd(),
          readOnly: true,
          executable: grokExecutable,
        })), launchPromptPath(orchestratorSessionKey())),
      ];
    }
    default:
      unknownVendor(tool, "orchestrator command");
  }
}

export interface LaunchOrchestratorOptions {
  sessiondControl?: OrchestratorSessiondControl;
  sessiondSleep?: (milliseconds: number) => Promise<void>;
  resolveClaudeExecutable?: () => ResolvedClaudeExecutable;
  resolveCodexExecutable?: typeof resolveWorkingCodexExecutable;
  resolveGrokExecutable?: typeof resolveWorkingGrokExecutable;
  listCodexMcpServers?: () => Promise<string[]>;
  provisionCodexToken?: (port: number) => Promise<string | null>;
}

export async function launchOrchestrator(
  tool: OrchestratorTool,
  port: number,
  cwd = process.cwd(),
  recoveryBrief = "",
  options: LaunchOrchestratorOptions = {},
): Promise<number> {
  // Resolve and gate Claude only for the Claude path. A Codex orchestrator
  // must not require an unrelated Claude installation.
  let providerExecutable: string;
  switch (tool) {
    case "claude": {
      const claude = (options.resolveClaudeExecutable ??
        resolveWorkingClaudeExecutable)();
      if (claude.path === "claude" && claude.version === null) {
        throw new Error(
          "the Claude orchestrator needs a working Claude Code CLI\n" +
            "Fix: repair or install Claude Code, then retry",
        );
      }
      providerExecutable = realpathSync.native(claude.path);
      break;
    }
    case "codex": {
      const codex = (options.resolveCodexExecutable ??
        resolveWorkingCodexExecutable)();
      if (codex === null) {
        throw new Error("the Codex orchestrator needs a working codex CLI");
      }
      providerExecutable = codex.path;
      break;
    }
    case "grok": {
      const grok = (options.resolveGrokExecutable ??
        resolveWorkingGrokExecutable)();
      if (grok === null) {
        throw new Error("the Grok orchestrator needs a working grok CLI");
      }
      providerExecutable = grok.path;
      break;
    }
    default:
      unknownVendor(tool, "orchestrator launch");
  }
  await prepareOrchestratorConfig(tool, port, cwd);
  let codexTokenFile = "";
  let codexToken = "";
  let codexMcpExclusionArgs: string[] = [];
  switch (tool) {
    case "codex": {
      codexMcpExclusionArgs = buildCodexMcpExclusionArgs(
        await (options.listCodexMcpServers ??
          listInheritedCodexMcpServers)(),
      ).args;
      const provisioned = await (options.provisionCodexToken ??
        provisionCodexRootToken)(port).catch(() => null);
      if (provisioned === null) {
        throw new Error(
          "the Hive daemon could not authorize the Codex orchestrator\n" +
            "Fix: run `hive stop`, then reopen Hive",
        );
      }
      codexTokenFile = provisioned;
      codexToken = (await readFile(provisioned, "utf8")).trim();
      if (codexToken === "") {
        throw new Error("the Codex orchestrator capability file is empty");
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
  const orchestratorBrief = buildOrchestratorInstructions(
    memoryIndex,
    docGuidance,
    recoveryBrief,
  );
  await writeLaunchPrompt(orchestratorSessionKey(), orchestratorBrief);
  if (tool === "codex") {
    await writeCodexInstructionProfile(
      orchestratorSessionKey(),
      orchestratorBrief,
    );
  }
  const argv = buildOrchestratorCommand(
    tool,
    port,
    memoryIndex,
    docGuidance,
    providerExecutable,
    codexTokenFile,
    recoveryBrief,
    codexMcpExclusionArgs,
  );
  const environment = tool === "grok"
    ? {
        GROK_HOME: join(orchestratorConfigRoot(), ".grok"),
        ...GROK_COMPATIBILITY_ENV,
      }
    : tool === "codex"
    ? { [CODEX_CAPABILITY_TOKEN_ENV]: codexToken }
    : {};
  const launch = OrchestratorSessiondLaunchSchema.parse({
    requestId: mintSessionRequestId(),
    provider: tool,
    cwd,
    argv,
    environment,
    expectedExecutable: providerExecutable,
  });
  return await runOrchestratorSessiondLaunch(
    launch,
    options.sessiondControl ?? daemonOrchestratorSessiondControl(port),
    options.sessiondSleep,
  );
}
