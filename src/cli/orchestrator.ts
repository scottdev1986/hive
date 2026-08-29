import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isString } from "../shared/is-record";
import {
  buildClaudeSpawnCommand,
  type ResolvedClaudeExecutable,
  resolveWorkingClaudeExecutable,
  writeClaudeAgentConfig,
} from "../adapters/providers/claude-cli";
import { resolveWorkingCodexExecutable } from "../adapters/providers/codex-cli";
import {
  buildGrokSpawnCommand,
  GROK_COMPATIBILITY_ENV,
  resolveWorkingGrokExecutable,
  writeGrokAgentConfig,
} from "../adapters/providers/grok-cli";
import {
  buildKimiSpawnCommand,
  resolveWorkingKimiExecutable,
  wrapKimiWithInstructionFile,
  writeKimiAgentConfig,
} from "../adapters/providers/kimi-cli";
import {
  buildOpencodeSpawnCommand,
  OPENCODE_HIVE_AGENT,
  resolveWorkingOpencodeExecutable,
  writeOpencodeAgentConfig,
} from "../adapters/providers/opencode-cli";
import { HIVE_CAPABILITY_TOKEN_ENV } from "../adapters/providers/shared/capability-env";
import {
  buildCodexMcpExclusionArgs,
  daemonMcpUrl,
  listInheritedCodexMcpServers,
} from "../adapters/providers/shared/mcp-scope";
import {
  grokQueenHome,
  provisionQueenSkills,
  queenSkillDelivery,
} from "../adapters/queen-skills";
import { writeCredential } from "../daemon/authorization/credentials";
import { hiveCliSpawnArgv } from "../daemon/lifecycle/daemon-lifecycle";
import { OrchestratorSessiondLaunchSchema } from "../daemon/orchestrator-host/sessiond-controller";
import { discoverRuntimeCapabilities } from "../daemon/provider-capabilities/snapshot-authority";
import { queenBootCapsules } from "../daemon/queen-provider-service/queen-boot-capsule-service";
import { mintSessionRequestId } from "../daemon/session-host/locators";
import {
  codexInstructionProfileName,
  launchPromptPath,
  wrapGrokWithRulesFile,
  writeCodexInstructionProfile,
  writeLaunchPrompt,
} from "../daemon/spawn/launch-prompt";
import {
  agentUiLaunchArgv,
  protocolProviderArgv,
} from "../daemon/spawn/spawn-service";
import { getHiveHome, orchestratorSessionKey } from "../hive-home/home";
import { EpisodicStore } from "../memory-service/episodic";
import { buildMemoryIndex } from "../memory-service/memory-store";
import { ORCHESTRATOR_NAME } from "../schemas/agent";
import { type CapabilityProvider, unknownVendor } from "../schemas/capability";
import { definedFields } from "../shared/defined-fields";
import { shellJoin } from "../shared/shell-quote";
import { IS_RELEASE_BUILD } from "../shared/version";
import { isTestRunnerEnv } from "./invoker";
import {
  daemonOrchestratorSessiondControl,
  type OrchestratorSessiondControl,
  runOrchestratorSessiondLaunch,
} from "./orchestrator-sessiond";
import { QUEEN_POLICY } from "./queen-policy";
import { UserDaemonClient } from "./user-daemon-client";

export type OrchestratorTool = CapabilityProvider;

export function orchestratorConfigRoot(): string {
  return join(getHiveHome(), "runtime", "orchestrator");
}

export function orchestratorJournalPath(): string {
  return join(
    getHiveHome(),
    "agent-ui",
    orchestratorSessionKey(),
    "outbound.jsonl",
  );
}

/** The credential-store subject holding the Codex root's local Hive capability. This authorizes Hive control-plane calls; it is not a provider credential and Hive never reads or manages provider secrets. */
export const CODEX_ROOT_TOKEN_SUBJECT = "codex-root";

/** Ask the daemon to mint a root capability. Returns null when the daemon does not offer the endpoint or refuses; the caller decides how to fail closed. */
export async function requestCodexRootToken(
  port: number,
): Promise<string | null> {
  // SAFETY: The surrounding code already established this contract.
  const body = (await new UserDaemonClient({
    port,
    verifyIdentity: !isTestRunnerEnv(),
  })
    .json(
      "/codex-root-token",
      {
        method: "POST",
      },
      "return-null",
    )
    .catch(() => null)) as {
    token?: string;
  } | null;
  return isString(body?.token) && body.token.length > 0 ? body.token : null;
}

/** Refresh the root's credential for a new launch: the daemon mints a FRESH orchestrator credential, revoking every predecessor's, and persists it for the vendors whose config reads it from the store. Every vendor calls this per launch — a dead predecessor token can never read or attest in the successor's place. A daemon that cannot mint fails the launch loudly: a root that cannot authenticate as the queen is not a root. */
export async function provisionQueenRootToken(
  port: number,
  request: (port: number) => Promise<string | null> = requestCodexRootToken,
): Promise<string> {
  const token = await request(port);
  if (token === null) {
    throw new Error(
      "the Hive daemon could not mint the queen root credential\n" +
        "Fix: run `hive stop`, then reopen Hive",
    );
  }
  return token;
}

/** Provision the Codex root capability: mint a token and write it to a 0600 file inside the 0700 credentials directory under the resolved Hive home. Only the PATH is returned. The launch shell reads it into the process-local bearer environment Codex supports; the token itself never reaches argv or .codex/config.toml. */
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
      return;
    case "grok":
      await writeGrokAgentConfig(orchestratorConfigRoot(), {
        daemonPort: port,
      });
      return;
    case "kimi": {
      await writeKimiAgentConfig(cwd, { daemonPort: port });
      return;
    }
    case "opencode": {
      // opencode's project config is read from the process cwd, so the config lands where the root runs; the launch context rides the hive agent's {file:} prompt in it, and the queen's role rides the agent's permission set.
      const skills = queenSkillDelivery("opencode", orchestratorConfigRoot());
      await writeOpencodeAgentConfig(cwd, {
        daemonPort: port,
        orchestrator: true,
        instructionPath: launchPromptPath(orchestratorSessionKey()),
        ...definedFields({
          skillPaths:
            skills.directory === null ? undefined : [skills.directory],
        }),
      });
      return;
    }
    default:
      unknownVendor(tool, "orchestrator config");
  }
}

export async function buildQueenLaunchContext(
  input: {
    memoryIndex?: string;
    bootCapsule?: string;
    repoRoot: string;
    episodic?: {
      listEvents: () => Array<{
        id: string;
        type: string;
        ts: string;
        summary: string;
      }>;
    };
  } = {
    repoRoot: process.cwd(),
  },
): Promise<string> {
  // P0: Load pack floor for queen launch
  const { loadConstitution, loadProfile, loadProjectDoc, loadRecentMistakes } =
    await import("../memory-service/pack-floor");

  const [constitution, profile, projectDoc, recentMistakes] = await Promise.all(
    [
      Promise.resolve(loadConstitution()),
      loadProfile(),
      loadProjectDoc(input.repoRoot),
      loadRecentMistakes(input.episodic, input.repoRoot),
    ],
  );

  // P0: Flatten pack floor (composeLaunchContext expects flat fields, not nested packFloor)
  return queenBootCapsules.composeLaunchContext({
    policy: QUEEN_POLICY,
    memoryIndex: input.memoryIndex,
    bootCapsule: input.bootCapsule,
    constitution,
    profile,
    projectDoc,
    recentMistakes,
  }).text;
}

export interface OrchestratorCommandOptions {
  readonly tool: OrchestratorTool;
  readonly port: number;
  readonly executable?: string;
  readonly codexAuthorized?: boolean;
  readonly codexMcpExclusionArgs?: readonly string[];
  readonly queenSkillArgs?: readonly string[];
  readonly effectiveModel?: string;
  readonly effectiveEffort?: string;
}

export const CLAUDE_QUEEN_MODEL = "claude-opus-5";
export const CLAUDE_QUEEN_EFFORT = "high";
export const CLAUDE_QUEEN_AUTOCOMPACT = "250k";
/** First user turn on every queen launch, including a first boot. There is no assigned task until the user gives one. */
export const QUEEN_KICKOFF =
  "Follow your boot capsule. If there is no user request and no live work to continue, wait for the user. Do not invent work, do not spawn, and do not create a board unless the user asks.";

export function buildOrchestratorCommand(
  options: OrchestratorCommandOptions,
): string[] {
  const {
    tool,
    port,
    executable,
    codexAuthorized = false,
    codexMcpExclusionArgs = [],
    queenSkillArgs = [],
    effectiveModel,
    effectiveEffort,
  } = options;
  switch (tool) {
    case "claude": {
      const configRoot = orchestratorConfigRoot();
      return [
        ...buildClaudeSpawnCommand({
          name: ORCHESTRATOR_NAME,
          model: effectiveModel ?? CLAUDE_QUEEN_MODEL,
          effort: effectiveEffort ?? CLAUDE_QUEEN_EFFORT,
          brief: true,
          autoCompact: CLAUDE_QUEEN_AUTOCOMPACT,
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
        ...queenSkillArgs,
      ];
    }
    case "codex":
      return [
        executable ?? "codex",
        "-c",
        "features.apps=false",
        ...codexMcpExclusionArgs,
        "-c",
        `mcp_servers.hive.url="${daemonMcpUrl(port)}"`,
        // The root exists to call Hive's capability-scoped orchestration tools. A prompt here deadlocks unattended delegation; pre-approve only this Hive-owned server, never inherited MCPs.
        "-c",
        'mcp_servers.hive.default_tools_approval_mode="approve"',
        "--profile",
        codexInstructionProfileName(orchestratorSessionKey()),
        // Codex's supported bearer indirection. The launch shell populates this process-local variable from the 0600 capability file; neither the token nor a made-up config key appears in argv.
        ...(!codexAuthorized
          ? []
          : [
              "-c",
              `mcp_servers.hive.bearer_token_env_var=${JSON.stringify(HIVE_CAPABILITY_TOKEN_ENV)}`,
            ]),
        // The queen's role needs writes for her memory. workspace-write is the finest sandbox codex offers — it cannot scope subpaths of the workspace — so the no-implementation-code boundary rides her pinned policy. Network stays on for gh's board calls.
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
      ];
    case "grok": {
      const grokExecutable = executable ?? "grok";
      if (effectiveModel === undefined) {
        throw new Error("Grok protocol snapshot has no effective default");
      }
      return [
        "sh",
        "-lc",
        wrapGrokWithRulesFile(
          shellJoin(
            buildGrokSpawnCommand({
              model: effectiveModel,
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
      if (effectiveModel === undefined) {
        throw new Error("Kimi protocol snapshot has no effective default");
      }
      return [
        "sh",
        "-lc",
        // Kimi has no read-only argv flag, so the native command uses --yolo. The ACP launch below discards native flags and requests Kimi's manual mode in SessionStart.
        wrapKimiWithInstructionFile(
          shellJoin([
            ...buildKimiSpawnCommand({
              model: effectiveModel,
              readOnly: false,
              dangerous: false,
              executable: kimiExecutable,
            }),
            // `--skills-dir` replaces kimi's own user and project discovery, so this is the queen's whole skill surface rather than an addition to it.
            ...queenSkillArgs,
          ]),
          launchPromptPath(orchestratorSessionKey()),
        ),
      ];
    }
    case "opencode": {
      const opencodeExecutable = executable ?? "opencode";
      // The queen's role permission rides agent.hive in the worktree opencode.json (prepareOrchestratorConfig); no argv change, and the read-only barrier stays off because the role replaces it. The model is the effective default read from the same cached protocol snapshot as pre-spawn routing.
      return buildOpencodeSpawnCommand({
        model: effectiveModel ?? null,
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

async function orchestratorDefaultModel(
  tool: OrchestratorTool,
): Promise<string | undefined> {
  if (tool === "claude") return CLAUDE_QUEEN_MODEL;
  if (tool === "codex") return undefined;
  const discovery = await discoverRuntimeCapabilities(tool);
  if (
    discovery.status === "ok" &&
    discovery.effectiveDefault.model.state === "known"
  ) {
    return discovery.effectiveDefault.model.value;
  }
  throw new Error(`${tool} protocol snapshot has no effective default`);
}

export interface LaunchOrchestratorOptions {
  sessiondControl?: OrchestratorSessiondControl;
  resolveClaudeExecutable?: () => ResolvedClaudeExecutable;
  resolveCodexExecutable?: typeof resolveWorkingCodexExecutable;
  resolveGrokExecutable?: typeof resolveWorkingGrokExecutable;
  resolveKimiExecutable?: typeof resolveWorkingKimiExecutable;
  resolveOpencodeExecutable?: typeof resolveWorkingOpencodeExecutable;
  listCodexMcpServers?: () => Promise<string[]>;
  provisionCodexToken?: (port: number) => Promise<string | null>;
  provisionQueenToken?: (port: number) => Promise<string>;
}

/** What one vendor's root carries in her launch environment. Every provider but claude reads its bearer from HIVE_CAPABILITY_TOKEN — and what it carries is the queen's own orchestrator credential, never the user's: the root authenticates as queen on every vendor, so the user-dial actions stay beyond her reach and her succession tools accept her calls. Claude reads the same credential from the store at MCP connect time, so no token travels in her environment at all. */
export function orchestratorLaunchEnvironment(
  tool: OrchestratorTool,
  tokens: { codexToken: string; queenToken: string },
) {
  if (tool === "claude") return {};
  if (tool === "codex") {
    return { [HIVE_CAPABILITY_TOKEN_ENV]: tokens.codexToken };
  }
  if (tool === "grok") {
    return {
      [HIVE_CAPABILITY_TOKEN_ENV]: tokens.queenToken,
      GROK_HOME: grokQueenHome(orchestratorConfigRoot()),
      ...GROK_COMPATIBILITY_ENV,
    };
  }
  return { [HIVE_CAPABILITY_TOKEN_ENV]: tokens.queenToken };
}

export async function launchOrchestrator(
  tool: OrchestratorTool,
  port: number,
  cwd = process.cwd(),
  bootCapsule = "",
  options: LaunchOrchestratorOptions = {},
  targetGeneration?: number,
): Promise<number> {
  // Resolve and gate Claude only for the Claude path. A Codex orchestrator must not require an unrelated Claude installation.
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
  let codexTokenFile = "";
  let codexToken = "";
  let queenToken = "";
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
      // Claude's root reads her credential at MCP connect time through the headersHelper, which reads the queen credential file the daemon persists. Refreshing it here revokes the predecessor's token before this root boots.
      await (options.provisionQueenToken ?? provisionQueenRootToken)(port);
      break;
    case "grok":
    case "kimi":
    case "opencode":
      // These vendors read the queen credential from HIVE_CAPABILITY_TOKEN.
      queenToken = await (
        options.provisionQueenToken ?? provisionQueenRootToken
      )(port);
      break;
    default:
      unknownVendor(tool, "orchestrator root token");
  }
  // Her skills, before the command that has to name their directory. A vendor with no isolated path returns `degraded` instead of a directory, and the launch says which rather than implying a provisioning that never happened.
  const queenSkills = await provisionQueenSkills(
    cwd,
    tool,
    orchestratorConfigRoot(),
  );
  if (queenSkills.degraded !== null) {
    console.warn(
      `Hive gave the ${tool} queen no skill directory of her own: ${queenSkills.degraded}`,
    );
  }
  const memoryIndex = await buildMemoryIndex(cwd).catch(() => "");
  // Wire the real episodic store into queen launch (memory hole #7). Fail-closed if unavailable.
  const episodic = EpisodicStore.forProjectRoot(cwd);
  const launchContext = await buildQueenLaunchContext({
    memoryIndex,
    bootCapsule,
    repoRoot: cwd,
    episodic,
  });
  await writeLaunchPrompt(orchestratorSessionKey(), launchContext);
  await prepareOrchestratorConfig(tool, port, cwd);
  if (tool === "codex") {
    await writeCodexInstructionProfile(orchestratorSessionKey(), launchContext);
  }
  const effectiveModel = await orchestratorDefaultModel(tool);
  const effectiveEffort = tool === "claude" ? CLAUDE_QUEEN_EFFORT : undefined;
  const providerArgv = buildOrchestratorCommand({
    tool,
    port,
    executable: providerExecutable,
    codexAuthorized: codexTokenFile !== "",
    codexMcpExclusionArgs,
    queenSkillArgs: queenSkills.launchArgs,
    effectiveModel,
    effectiveEffort,
  });
  const environment = orchestratorLaunchEnvironment(tool, {
    codexToken,
    queenToken,
  });
  const requestId = mintSessionRequestId();
  const providerRunId = crypto.randomUUID();
  const argv = agentUiLaunchArgv({
    hiveCommand: hiveCliSpawnArgv(IS_RELEASE_BUILD, process.execPath),
    subject: ORCHESTRATOR_NAME,
    provider: tool,
    executable: providerExecutable,
    daemonPort: port,
    providerRunId,
    worktreePath: cwd,
    journalPath: orchestratorJournalPath(),
    model: effectiveModel ?? "default",
    ...definedFields({ effort: effectiveEffort }),
    readOnly: true,
    instructionPath: launchPromptPath(orchestratorSessionKey()),
    kickoff: QUEEN_KICKOFF,
    providerArgv: protocolProviderArgv(tool, providerArgv),
  });
  const launch = OrchestratorSessiondLaunchSchema.parse({
    requestId,
    providerRunId,
    provider: tool,
    cwd,
    argv,
    environment,
    expectedExecutable: providerExecutable,
    model: effectiveModel ?? null,
    effort: effectiveEffort ?? null,
    ...definedFields({ targetGeneration }),
  });
  return await runOrchestratorSessiondLaunch(
    launch,
    options.sessiondControl ?? daemonOrchestratorSessiondControl(port),
  );
}
