import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverBriefableDocs } from "../adapters/briefing-docs";
import { buildMemoryIndex } from "../adapters/memory";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../adapters/tools/capability-env";
import {
  buildClaudeSpawnCommand,
  type ResolvedClaudeExecutable,
  resolveWorkingClaudeExecutable,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { resolveWorkingCodexExecutable } from "../adapters/tools/codex";
import {
  buildGrokSpawnCommand,
  GROK_COMPATIBILITY_ENV,
  probeGrokDefaultModel,
  resolveWorkingGrokExecutable,
  writeGrokAgentConfig,
} from "../adapters/tools/grok";
import {
  buildKimiSpawnCommand,
  probeKimiDefaultModel,
  resolveWorkingKimiExecutable,
  wrapKimiWithInstructionFile,
  writeKimiAgentConfig,
} from "../adapters/tools/kimi";
import {
  buildCodexMcpExclusionArgs,
  listInheritedCodexMcpServers,
} from "../adapters/tools/mcp-scope";
import {
  buildOpencodeSpawnCommand,
  OPENCODE_HIVE_AGENT,
  probeOpencodeDefaultModel,
  resolveWorkingOpencodeExecutable,
  writeOpencodeAgentConfig,
} from "../adapters/tools/opencode";
import { writeCredential } from "../daemon/credentials";
import { getHiveHome } from "../daemon/db";
import {
  codexInstructionProfileName,
  launchPromptPath,
  wrapGrokWithRulesFile,
  writeCodexInstructionProfile,
  writeLaunchPrompt,
} from "../daemon/launch-prompt";
import { hiveCliSpawnArgv } from "../daemon/lifecycle";
import { orchestratorSessionKey } from "../daemon/orchestrator-lifecycle";
import { OrchestratorSessiondLaunchSchema } from "../daemon/orchestrator-sessiond";
import { mintSessionRequestId } from "../daemon/session-host/locators";
import { shellJoin } from "../daemon/session-host/shell-session";
import type { CapabilityProvider } from "../schemas";
import { normalizeNulText, ORCHESTRATOR_NAME, unknownVendor } from "../schemas";
import { IS_RELEASE_BUILD } from "../version";
import { operatorHeaders } from "./credential";
import {
  ORCHESTRATOR_BRIEF,
  orchestratorDocGuidance,
} from "./orchestrator-brief";
import {
  daemonOrchestratorSessiondControl,
  type OrchestratorSessiondControl,
  runOrchestratorSessiondLaunch,
} from "./orchestrator-sessiond";

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
  const body = (await response.json().catch(() => null)) as {
    token?: string;
  } | null;
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
    case "grok":
      await writeGrokAgentConfig(orchestratorConfigRoot(), {
        daemonPort: port,
      });
      return;
    case "kimi": {
      // Kimi has no home-override for project config: its `.kimi-code/` is
      // read from the process cwd, so the config lands where the root runs.
      await writeKimiAgentConfig(cwd, { daemonPort: port });
      return;
    }
    case "opencode": {
      // opencode's project config is read from the process cwd, so the
      // config lands where the root runs; the brief rides the hive agent's
      // {file:} prompt in it, and the queen's role (#12) rides the agent's
      // permission set.
      await writeOpencodeAgentConfig(cwd, {
        daemonPort: port,
        orchestrator: true,
        instructionPath: launchPromptPath(orchestratorSessionKey()),
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
export async function buildOrchestratorDocGuidance(
  cwd: string,
): Promise<string> {
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
  const _brief = buildOrchestratorInstructions(
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
          scopedSettingsPath: join(
            configRoot,
            ".claude",
            "settings.local.json",
          ),
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
        // The root exists to call Hive's capability-scoped orchestration
        // tools. A prompt here deadlocks unattended delegation;
        // pre-approve only this Hive-owned server, never inherited MCPs.
        "-c",
        'mcp_servers.hive.default_tools_approval_mode="approve"',
        "--profile",
        codexInstructionProfileName(orchestratorSessionKey()),
        // Codex's supported bearer indirection. The launch shell populates
        // this process-local variable from the 0600 capability file; neither
        // the token nor a made-up config key appears in argv.
        ...(codexTokenFile === ""
          ? []
          : [
              "-c",
              `mcp_servers.hive.bearer_token_env_var=${JSON.stringify(HIVE_CAPABILITY_TOKEN_ENV)}`,
            ]),
        // The queen's role (#12) needs writes for her memory and planning
        // docs. workspace-write is the finest sandbox codex offers — it
        // cannot scope subpaths of the workspace — so the
        // no-implementation-code boundary rides her brief. Network stays on
        // for gh's board calls.
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
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
        // The queen's role (#12) as grok can express it: --allow/--deny are
        // per-tool only — no per-command gh scope, no per-path write scope —
        // so the role's grant is a full tool approval and the
        // no-implementation-code boundary rides her brief.
        wrapGrokWithRulesFile(
          shellJoin(
            buildGrokSpawnCommand({
              model,
              worktreePath: process.cwd(),
              readOnly: false,
              executable: grokExecutable,
            }),
          ),
          launchPromptPath(orchestratorSessionKey()),
        ),
      ];
    }
    case "kimi": {
      const kimiExecutable = executable ?? "kimi";
      const model = probeKimiDefaultModel();
      if (model === null) {
        throw new Error("kimi config did not report an effective default");
      }
      return [
        "sh",
        "-lc",
        // The queen's role (#12) as kimi can express it: kimi has no
        // per-launch permission scoping at all (the kimi-adapter gap), so
        // --yolo auto-approves her tool calls and the
        // no-implementation-code boundary rides her brief.
        wrapKimiWithInstructionFile(
          shellJoin(
            buildKimiSpawnCommand({
              model,
              readOnly: false,
              dangerous: false,
              executable: kimiExecutable,
            }),
          ),
          launchPromptPath(orchestratorSessionKey()),
        ),
      ];
    }
    case "opencode": {
      const opencodeExecutable = executable ?? "opencode";
      const model = probeOpencodeDefaultModel();
      if (model === null) {
        throw new Error("opencode config did not report an effective default");
      }
      // The queen's role permission rides agent.hive in the worktree
      // opencode.json (prepareOrchestratorConfig); no argv change, and the
      // read-only barrier stays off because the role replaces it.
      return buildOpencodeSpawnCommand({
        model,
        readOnly: false,
        dangerous: false,
        executable: opencodeExecutable,
        agent: OPENCODE_HIVE_AGENT,
      });
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
  resolveKimiExecutable?: typeof resolveWorkingKimiExecutable;
  resolveOpencodeExecutable?: typeof resolveWorkingOpencodeExecutable;
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
      const claude = (
        options.resolveClaudeExecutable ?? resolveWorkingClaudeExecutable
      )();
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
      const codex = (
        options.resolveCodexExecutable ?? resolveWorkingCodexExecutable
      )();
      if (codex === null) {
        throw new Error("the Codex orchestrator needs a working codex CLI");
      }
      providerExecutable = codex.path;
      break;
    }
    case "grok": {
      const grok = (
        options.resolveGrokExecutable ?? resolveWorkingGrokExecutable
      )();
      if (grok === null) {
        throw new Error("the Grok orchestrator needs a working grok CLI");
      }
      providerExecutable = grok.path;
      break;
    }
    case "kimi": {
      const kimi = (
        options.resolveKimiExecutable ?? resolveWorkingKimiExecutable
      )();
      if (kimi === null) {
        throw new Error("the Kimi orchestrator needs a working kimi CLI");
      }
      providerExecutable = kimi.path;
      break;
    }
    case "opencode": {
      const opencode = (
        options.resolveOpencodeExecutable ?? resolveWorkingOpencodeExecutable
      )();
      if (opencode === null) {
        throw new Error(
          "the opencode orchestrator needs a working opencode CLI",
        );
      }
      providerExecutable = opencode.path;
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
        await (options.listCodexMcpServers ?? listInheritedCodexMcpServers)(),
      ).args;
      const provisioned = await (
        options.provisionCodexToken ?? provisionCodexRootToken
      )(port).catch(() => null);
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
    case "kimi":
      // Kimi authenticates through the same operator credential, written
      // into the project `.kimi-code/mcp.json` above.
      break;
    case "opencode":
      // opencode authenticates through the same operator credential,
      // written into the project `opencode.json` above.
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
  // Every provider but claude reads its bearer from HIVE_CAPABILITY_TOKEN, so
  // the operator token stays out of the config files kimi and opencode read
  // from the user's own project directory.
  const environment =
    tool === "claude"
      ? {}
      : tool === "codex"
        ? { [HIVE_CAPABILITY_TOKEN_ENV]: codexToken }
        : {
            [HIVE_CAPABILITY_TOKEN_ENV]: (
              operatorHeaders().Authorization ?? ""
            ).replace(/^Bearer\s+/, ""),
            ...(tool === "grok"
              ? {
                  GROK_HOME: join(orchestratorConfigRoot(), ".grok"),
                  ...GROK_COMPATIBILITY_ENV,
                }
              : {}),
          };
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
