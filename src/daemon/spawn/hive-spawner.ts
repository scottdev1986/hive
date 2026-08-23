import { join } from "node:path";
import { definedFields } from "../../shared/defined-fields";
import { runGit } from "../../adapters/git";
import { loadAndValidateWakePack } from "./pack-assembly";
import { resolveWorkingClaudeExecutable } from "../../adapters/providers/claude-cli";
import { isFunction } from "../../shared/is-record";
import {
  probeGrokCliVersion,
  wrapGrokSpawnWithCompatibilityEnv,
} from "../../adapters/providers/grok-cli";
import {
  wrapKimiSpawnWithEffort,
  wrapKimiWithTurnHookContext,
} from "../../adapters/providers/kimi-cli";
import type { PreparedProviderRuntime } from "../../adapters/providers/provider-adapter";
import { getAgentAdapter } from "../../adapters/providers/provider-registry";
import { wrapSpawnWithCapabilityEnv } from "../../adapters/providers/shared/capability-env";
import { listInheritedCodexMcpServers } from "../../adapters/providers/shared/mcp-scope";
import { provisionSkills } from "../../adapters/skills";
import {
  type CreatedWorktree,
  createWorktree,
  plannedWorktree,
  slugify,
  unavailableAgentNames,
  WorktreeNameCollisionError,
} from "../../adapters/worktrees";
import { getHiveHome, hiveInstanceSuffix } from "../../hive-home/home";
import {
  VERIFICATION_ARTICLE_ID,
  verificationCommandFromTitle,
} from "../../memory-service/harvest";
import {
  buildMemoryIndex,
  readMemoryFact,
} from "../../memory-service/memory-store";
import type { AgentRecord, ExecutionIdentity } from "../../schemas/agent";
import {
  type CapabilityDiscoveryResult,
  type CapabilityProvider,
  CapabilityProviderSchema,
  type CapabilityRecord,
  forEachProvider,
  splitVariant,
  unknownVendor,
} from "../../schemas/capability";
import { GitShaSchema } from "../../schemas/hierarchy-ids";
import { identifyModelVendor } from "../../schemas/routing-derivation";
import type {
  EffortTarget,
  ModelEnablementDecision,
  RoutingPolicy,
} from "../../schemas/routing-policy";
import { isDaemonPort } from "../../shared/daemon-port";
import { errorMessage } from "../../shared/error-message";
import { shellJoin } from "../../shared/shell-quote";
import { IS_RELEASE_BUILD } from "../../shared/version";
import { poolAvailability } from "../../usage-service/usage-credits/policy";
import type { AccountBilling } from "../../usage-service/usage-credits/usage-credit-types";
import { parseToken } from "../authorization/authorization-service";
import { hiveCliSpawnArgv } from "../lifecycle/daemon-lifecycle";
import {
  parseProcessTable,
  runPs,
  treeRunsCommand,
} from "../resource-management/resources";
import {
  AuthorizedLaunch,
  type LaunchGateChecks,
  type LaunchGateResult,
  type RawLaunchCandidate,
  requireAuthorizedLaunch,
} from "../routing-service/authorized-launch";
import {
  type CandidateGate,
  HiveRouter,
  type LaunchDecision,
} from "../routing-service/router";
import {
  requireSessiondAgentLocator,
  sessiondTerminalIsDead,
} from "../session-host/hive-terminal-host";
import { mintSessionLocator } from "../session-host/locators";
import { providerTerminalEnvironment } from "../session-host/provider-terminal-environment";
import type {
  SessionLocator,
  SessionSpec,
} from "../session-host/session-host-contract";
import { SessiondWireError } from "../session-host/sessiond-host";
import {
  prepareSessionZdotdir,
  type ShellSessionLaunch,
  shellSessionLaunch,
} from "../session-host/shell-session";
import {
  PTY_CREATE_GEOMETRY,
  type WorkspaceVisibilityLease,
} from "../session-host/workspace-visibility";
import { NAME_POOL, selectAgentName } from "./agent-name-selection";
import { buildAgentPrompt } from "./agent-prompt";
import { loadAgentStandards } from "./agent-standards";
import { classifyVendorDrainError } from "./drain-handler";
import { resolveAutoEffort, validateEffort } from "./effort";
import type {
  HiveSpawnerDependencies,
  SessiondSpawnAdmission,
  Sleep,
  StrandedIdentity,
  WorktreeCreator,
  WorktreeHeadReader,
} from "./hive-spawner-contract";
import { writeLaunchPrompt } from "./launch-prompt";
import {
  agentUiLaunchArgv,
  launchedCommandName,
  protocolProviderArgv,
} from "./provider-launch-argv";
import {
  type QuarantineLaunchLayer,
  readinessFailureLayer,
  waitForMcpReporting,
  watchForProofOfLife,
} from "./readiness";
import { SpawnFailedError } from "./spawn-failed-error";
import {
  assignmentKindForSpawn,
  isHierarchySpawnRequest,
  type Spawner,
  type SpawnRequest,
} from "./spawn-service";

const sleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readWorktreeHead: WorktreeHeadReader = async (worktreePath) => {
  const result = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot measure hierarchy worktree HEAD: ${result.stderr.trim() || `git exited ${String(result.exitCode)}`}`,
    );
  }
  return GitShaSchema.parse(result.stdout.trim());
};

export class HiveSpawner implements Spawner {
  private readonly makeWorktree: WorktreeCreator;
  private readonly wait: Sleep;
  private readonly claudeExecutable: string;
  private readonly codexExecutable: string;
  private readonly grokExecutable: string;
  private readonly kimiExecutable: string;
  private readonly opencodeExecutable: string;
  private readonly buildMemoryIndex: typeof buildMemoryIndex;
  private readonly readCodexActivity: (
    worktreePath: string,
    toolSessionId: string,
  ) => Promise<string | null>;
  private readonly repoUnavailableNames: typeof unavailableAgentNames;
  private readonly billingCache = new Map<
    CapabilityProvider,
    { at: number; value: Promise<AccountBilling | null> }
  >();
  private routerInstance: HiveRouter | undefined;

  constructor(private readonly dependencies: HiveSpawnerDependencies) {
    this.makeWorktree = dependencies.createWorktree ?? createWorktree;
    this.wait = dependencies.sleep ?? sleep;
    this.claudeExecutable =
      dependencies.claudeExecutable ?? resolveWorkingClaudeExecutable().path;
    this.codexExecutable = dependencies.codexExecutable ?? "codex";
    this.grokExecutable = dependencies.grokExecutable ?? "grok";
    this.kimiExecutable = dependencies.kimiExecutable ?? "kimi";
    this.opencodeExecutable = dependencies.opencodeExecutable ?? "opencode";
    this.buildMemoryIndex = dependencies.buildMemoryIndex ?? buildMemoryIndex;
    this.readCodexActivity =
      dependencies.readCodexActivity ?? (async () => null);
    this.repoUnavailableNames =
      dependencies.unavailableAgentNames ??
      (dependencies.createWorktree === undefined
        ? unavailableAgentNames
        : async () => new Set());
  }

  hierarchyRecipientBindingState(recipient: AgentRecord) {
    return (
      this.dependencies
        .hierarchyAdmission?.()
        ?.recipientBindingState(recipient) ?? "legacy"
    );
  }

  /** P0: Hive constitution (project-agnostic factory principles). */
  private router(): HiveRouter {
    if (this.routerInstance === undefined) {
      const quota =
        this.dependencies.quota?.config.enabled === true
          ? this.dependencies.quota
          : undefined;
      this.routerInstance = new HiveRouter({
        db: this.dependencies.db,
        readPolicy: () => {
          if (this.dependencies.readRoutingPolicy === undefined) {
            throw new Error("no routing policy source is configured");
          }
          return this.dependencies.readRoutingPolicy();
        },
        ...definedFields({
          launchCooldown:
            quota === undefined
              ? undefined
              : (candidate: AuthorizedLaunch) =>
                  quota.launchCooldown(candidate),
          drainedPool:
            quota === undefined
              ? undefined
              : (candidate: AuthorizedLaunch) => {
                  const drained = quota.drainFor(candidate);
                  return drained === null
                    ? null
                    : { pool: drained.pool, resetsAt: drained.resetsAt };
                },
          poolsGoverning:
            quota === undefined
              ? undefined
              : (candidate: AuthorizedLaunch) =>
                  quota.poolsGoverning(candidate).map((status) => status.pool),
        }),
      });
    }
    return this.routerInstance;
  }

  private daemonPort(): number {
    const configured = this.dependencies.port;
    const port = isFunction(configured) ? configured() : configured;
    if (!isDaemonPort(port)) {
      throw new Error(`Hive daemon has no listening port (resolved ${port})`);
    }
    return port;
  }

  private executableFor(tool: CapabilityProvider): string {
    return {
      claude: this.claudeExecutable,
      codex: this.codexExecutable,
      grok: this.grokExecutable,
      kimi: this.kimiExecutable,
      opencode: this.opencodeExecutable,
    }[tool];
  }

  private async createSession(
    record: AgentRecord,
    command: string,
    _expectedExecutable: string,
    launchGrantId: string,
    // REQUIRED, and deliberately not defaulted. A minted-here id is one no provider hook carries, so recordProviderHookEvent rejects every event on run-id mismatch and the agent's events vanish silently — no test and no typecheck can see that. A caller that forgets to thread the id must fail to compile instead.
    providerRunId: string,
  ): Promise<void> {
    const admission = await this.requireSessiondCreationPolicy(record);
    const pane = await this.dependencies.sessiond.admit({
      agentId: record.id,
      agentName: record.name,
    });
    const shell = shellSessionLaunch(command);
    const spec = await this.sessiondSpec(
      record,
      shell,
      launchGrantId,
      pane?.geometry ?? PTY_CREATE_GEOMETRY,
    );
    const created = await this.requireSessiondHost(record).create(spec, {
      locator: requireSessiondAgentLocator(record),
      visibility: admission.visibility,
    });
    this.dependencies.db.insertProviderRun({
      runId: providerRunId,
      agentId: record.id,
      terminal: created.locator,
      provider: record.tool,
      model: record.model,
      effort: record.executionIdentity?.effort ?? null,
      conversationId: record.toolSessionId ?? null,
      capabilityEpoch: record.capabilityEpoch,
      launchGrantId,
      startedAt: created.inspection.evidenceAt,
      endedAt: null,
      adapterChild: null,
      protocolReceipt: null,
      state: "running",
      exitReason: null,
    });
  }

  /** Unknown or live terminal state cannot authorize failed-spawn cleanup. */
  private async terminalReportedDead(record: AgentRecord): Promise<boolean> {
    try {
      const inspection = await this.requireSessiondHost(record).inspect(
        requireSessiondAgentLocator(record),
      );
      return sessiondTerminalIsDead(inspection);
    } catch {
      return false;
    }
  }

  private async sessionPresent(record: AgentRecord): Promise<boolean> {
    const inspection = await this.requireSessiondHost(record).inspect(
      requireSessiondAgentLocator(record),
    );
    if (inspection.presence === "unknown") {
      throw new Error(`Session presence is unknown for ${record.name}`);
    }
    return inspection.presence === "present";
  }

  private async captureVisible(_record: AgentRecord): Promise<string> {
    throw new Error("visible terminal capture is not available");
  }

  private requireAgentLocator(record: AgentRecord): SessionLocator {
    const locator = record.sessionLocator;
    if (
      locator === undefined ||
      locator.subject.kind !== "agent" ||
      locator.subject.agentId !== record.id
    ) {
      throw new Error(`Agent ${record.id} has a mismatched SessionLocator`);
    }
    return locator;
  }

  private async requireSessiondCreationPolicy(
    record: AgentRecord,
  ): Promise<WorkspaceVisibilityLease> {
    const locator = requireSessiondAgentLocator(record);
    const policy =
      (await this.dependencies.sessiond.prepareAgentCreation()) ?? null;
    if (policy === null) {
      throw new Error(`Agent ${record.id} has no sessiond creation policy`);
    }
    if (policy.engineBuildId !== locator.engineBuildId) {
      throw new Error(`Agent ${record.id} sessiond engine admission changed`);
    }
    return policy;
  }

  private requireSessiondHost(
    _record: AgentRecord,
  ): SessiondSpawnAdmission["terminalHost"] {
    return this.dependencies.sessiond.terminalHost;
  }

  private async sessiondSpec(
    record: AgentRecord,
    shell: ShellSessionLaunch,
    launchGrantId: string,
    geometry: SessionSpec["geometry"],
  ): Promise<SessionSpec> {
    if (record.worktreePath === null) {
      throw new Error(
        `Agent ${record.id} has no worktree for session creation`,
      );
    }
    const locator = requireSessiondAgentLocator(record);
    const zdotdir = await prepareSessionZdotdir(locator.sessionId);
    const userZdotdir = process.env.ZDOTDIR ?? process.env.HOME ?? "";

    return {
      schemaVersion: 1,
      locator,
      provider: record.tool,
      toolSessionId: record.toolSessionId ?? null,
      cwd: record.worktreePath,
      argv: shell.argv,
      environment: {
        ...(await providerTerminalEnvironment(process.env)),
        ...shell.env,
        ZDOTDIR: zdotdir,
        HIVE_USER_ZDOTDIR: userZdotdir,
      },
      expectedExecutable: shell.expectedExecutable,
      readOnly: record.readOnly,
      capabilityEpoch: record.capabilityEpoch,
      geometry,
      launchGrantId,
      launchGrantRevision: 1,
    };
  }

  /** Servers a Codex spawn would inherit from the user's global config. Read once per spawn, never written. A read failure means "inherit nothing to exclude" — the agent keeps today's surface rather than failing to launch. */
  private async inheritedCodexMcpServers(): Promise<string[]> {
    const list =
      this.dependencies.listCodexMcpServers ?? listInheritedCodexMcpServers;
    try {
      return await list();
    } catch (error) {
      console.error(
        `Hive could not read the user's Codex MCP server list; the spawned agent inherits all of them: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return [];
    }
  }

  private async discoverCapabilities(
    provider: CapabilityProvider,
  ): Promise<CapabilityDiscoveryResult | undefined> {
    const discover = this.dependencies.discoverCapabilities;
    if (discover === undefined) return undefined;
    const result = await discover(provider);
    if (result.status === "ok") {
      this.dependencies.quota?.replaceCapabilityCatalog?.(
        provider,
        result.records,
      );
    }
    return result;
  }

  private async availabilityRefusal(
    tool: CapabilityProvider,
    model: string,
  ): Promise<string | null> {
    if (this.dependencies.quota?.config.enabled === true) return null;
    const readBilling = this.dependencies.readBilling;
    if (readBilling === undefined) return null;
    const now = Date.now();
    const cached = this.billingCache.get(tool);
    const value =
      cached !== undefined && now - cached.at < 30_000
        ? cached.value
        : readBilling(tool);
    if (value !== cached?.value) {
      this.billingCache.set(tool, { at: now, value });
    }
    let billing: AccountBilling | null;
    try {
      billing = await value;
    } catch (error) {
      if (this.billingCache.get(tool)?.value === value) {
        this.billingCache.delete(tool);
      }
      throw error;
    }
    if (billing === null) return null;
    const discovery = await this.discoverCapabilities(tool);
    const base = splitVariant(model).base;
    const record =
      discovery?.status === "ok"
        ? discovery.records.find(
            (candidate) =>
              candidate.canonicalId === base ||
              candidate.launchToken === base ||
              candidate.aliases.includes(model),
          )
        : undefined;
    if (record?.displayName == null) return null;
    const availability = poolAvailability(billing, record.displayName);
    return availability.state === "exhausted"
      ? `${model} cannot run: ${availability.detail}`
      : null;
  }

  async authorizeLaunch(
    identity: ExecutionIdentity,
  ): Promise<AuthorizedLaunch> {
    let record: CapabilityRecord | undefined;
    const result = await AuthorizedLaunch.gate(identity, {
      resolution: async (candidate) => {
        if (this.dependencies.discoverCapabilities === undefined) return null;
        const discovery = await this.discoverCapabilities(candidate.tool);
        if (discovery === undefined || discovery.status !== "ok") {
          return `${candidate.tool}'s model catalog is unreadable`;
        }
        record = discovery.records.find(
          (entry) =>
            entry.launchToken === candidate.model ||
            entry.canonicalId === candidate.model ||
            entry.aliases.includes(candidate.model),
        );
        return record === undefined
          ? `${candidate.tool}'s readable catalog has no record for ${candidate.model}`
          : null;
      },
      enablement: async (candidate) => {
        let enabled: ModelEnablementDecision;
        try {
          enabled =
            (await this.dependencies.isModelEnabled?.(
              candidate.tool,
              candidate.model,
            )) ?? null;
        } catch (error) {
          return `${candidate.model} enablement policy is unreadable (${errorMessage(
            error,
          )}); open the Model Control Center and enable it before launching`;
        }
        if (enabled !== null && enabled !== true && enabled !== false) {
          return enabled.refusal;
        }
        if (enabled !== true) {
          return (
            `${candidate.model} is not enabled; open the Model Control Center ` +
            "and enable it before launching"
          );
        }
        if (!CapabilityProviderSchema.safeParse(candidate.tool).success) {
          return `provider ${JSON.stringify(candidate.tool)} is not enabled`;
        }
        if (record?.entitled.state === "known" && !record.entitled.value) {
          return `${candidate.model} is not entitled`;
        }
        return record?.hidden.state === "known" && record.hidden.value
          ? `${candidate.model} is disabled by the vendor`
          : null;
      },
      availability: (candidate) =>
        this.availabilityRefusal(candidate.tool, candidate.model),
      effort: (candidate) => {
        if (candidate.effort === undefined) return { refusal: null };
        try {
          return {
            effort: validateEffort(record, candidate.model, candidate.effort)
              .effort,
            refusal: null,
          };
        } catch (error) {
          return {
            refusal: errorMessage(error),
          };
        }
      },
    });
    if (result.refusal !== undefined) {
      throw new Error(
        `${result.refusal.reason} refused ${identity.tool}/${identity.model}: ` +
          result.refusal.detail,
      );
    }
    return result.authorized;
  }

  /** Is the binary we launched still running inside that pane? Null means we could not tell — no pane, or a `ps` we could not read — and readiness treats that as no evidence rather than as life. The command is the one hive actually launched, never a provider name inferred from the record: providers may wrap their CLI with launch-time setup, so looking for only the provider executable can reject the command Hive actually launched. */
  private async launchedProcessAlive(
    record: AgentRecord,
    command: string,
  ): Promise<boolean | null> {
    try {
      const rootPids = [
        (
          await this.requireSessiondHost(record).inspect(
            requireSessiondAgentLocator(record),
          )
        ).shellRoot?.pid,
      ].filter((pid): pid is number => pid !== undefined && pid !== null);
      if (rootPids.length === 0) return null;
      const samples = parseProcessTable(
        await (this.dependencies.ps ?? runPs)(),
      );
      if (samples.length === 0) return null;
      return treeRunsCommand(samples, [...rootPids], command);
    } catch {
      return null;
    }
  }

  private async readCodexActivityFor(
    record: AgentRecord,
  ): Promise<string | null> {
    const current = this.dependencies.db.getAgentById(record.id) ?? record;
    const tool = current.executionIdentity?.tool ?? current.tool;
    if (current.worktreePath === null || current.toolSessionId === undefined) {
      return null;
    }
    switch (tool) {
      case "claude":
      case "grok":
      case "kimi":
      case "opencode":
        // These vendors have their own durable artifacts; a Codex rollout can only belong to a stale predecessor and must never signal liveness.
        return null;
      case "codex":
        break;
      default:
        return unknownVendor(tool, "Codex activity reader");
    }
    try {
      return await this.readCodexActivity(
        current.worktreePath,
        current.toolSessionId,
      );
    } catch {
      return null;
    }
  }

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    const blocked = new Set<string>();
    for (;;) {
      const name = this.claimAgentName(blocked);
      const stranded: StrandedIdentity = {
        release: null,
        launchOwnsName: false,
      };
      try {
        const repoUnavailable = await this.repoUnavailableNames(
          this.dependencies.repoRoot,
          NAME_POOL,
        );
        if (repoUnavailable.has(name)) {
          throw new WorktreeNameCollisionError(
            `Agent name ${name} is already claimed in this repository`,
          );
        }
        return await this.spawnReserved(request, name, stranded);
      } catch (error) {
        stranded.release?.();
        await this.settleStrandedReservation(name);
        if (error instanceof WorktreeNameCollisionError) {
          blocked.add(name);
          continue;
        }
        throw error;
      } finally {
        if (!stranded.launchOwnsName) {
          this.dependencies.db.releaseAgentName(name);
        }
      }
    }
  }

  /** A spawn that threw may not walk away still holding capacity. The booking is made before the agent row is written. If that window throws, the dead-agent sweep sees no row and treats the reservation as an in-flight spawn until its TTL. Do not rely on cancellation at individual throw sites. The guard runs at the one place every failure must pass and asks the LEDGER what the name is still holding rather than trusting a pointer the caller threaded down, which is the same question `settleReservationsOfDeadAgents` asks, and for the same reason. A statement added to that window later cannot reintroduce the leak. `cancel` is the honest settle either way: a booking that never started is released, and one that had already proved life is reconciled at its estimate rather than silently refunded. */
  private async settleStrandedReservation(name: string): Promise<void> {
    const quota = this.dependencies.quota;
    if (quota === undefined) return;
    const held = quota.ledger.getActiveReservationForAgent(name);
    if (held === null) return;
    try {
      quota.cancel(held.id);
    } catch (error) {
      console.error(
        `Hive failed to settle the stranded quota reservation for ${name}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  /** Take exclusive hold of a name for the duration of this spawn. The reservation row is the arbiter, not the liveness scan: two spawns that both read an empty agents table still cannot both claim `maya`, because only one `INSERT OR IGNORE` reports a change. Concurrent spawns therefore walk on to different names instead of colliding. A reservation is held for exactly as long as a spawn is in flight, so an in-flight name is as unavailable as a live one — reuse can never race a spawning or recovering agent. */
  private claimAgentName(blocked: ReadonlySet<string>): string {
    const db = this.dependencies.db;
    const unavailable = new Set(blocked);
    for (;;) {
      const candidate = selectAgentName(db.listAgents(), unavailable);
      if (!db.reserveAgentName(candidate)) {
        unavailable.add(candidate);
        continue;
      }
      // Holding the reservation, no concurrent spawn can create a live holder for this name, so this check is authoritative rather than racy.
      if (db.getLiveAgentByName(candidate) === null) return candidate;
      db.releaseAgentName(candidate);
      unavailable.add(candidate);
    }
  }

  private async spawnReserved(
    request: SpawnRequest,
    name: string,
    stranded: StrandedIdentity,
  ): Promise<AgentRecord> {
    const readOnly = request.readOnly ?? false;
    if (readOnly && this.dependencies.issueCredential === undefined) {
      throw new Error(
        `Cannot spawn ${name} read-only: reader capability issuance is unavailable`,
      );
    }
    const hierarchyRequest = isHierarchySpawnRequest(request) ? request : null;
    // Board story linkage is prompt/context only. A tracking task stays
    // admission-inert: this check refuses unknown ids so a brief never points
    // at a missing story, and never widens hierarchy admission.
    const boardTaskId = request.taskId;
    if (boardTaskId !== undefined) {
      const lookup = this.dependencies.getBoardTask;
      if (lookup !== undefined && lookup(boardTaskId) === null) {
        throw new Error(
          `Task ${boardTaskId} does not exist on the board. Fix: hive_task_list`,
        );
      }
    }
    const hierarchyAdmission =
      hierarchyRequest === null
        ? null
        : (this.dependencies.hierarchyAdmission?.() ??
          (() => {
            throw new Error(
              `Cannot spawn ${name}: hierarchy admission is unavailable`,
            );
          })());
    const hierarchyIdentity =
      hierarchyRequest === null || hierarchyAdmission === null
        ? null
        : hierarchyAdmission.preflight(
            {
              runId: hierarchyRequest.runId,
              runEpoch: hierarchyRequest.runEpoch,
              nodeId: hierarchyRequest.nodeId,
              taskId: hierarchyRequest.taskId,
              delegationSpec: hierarchyRequest.delegationSpec,
              grantId: hierarchyRequest.grantId,
              spawnBrief: hierarchyRequest.spawnBrief,
            },
            assignmentKindForSpawn(request),
          );
    if (hierarchyIdentity !== null && hierarchyAdmission !== null) {
      stranded.release = () => {
        hierarchyAdmission.failLaunch(hierarchyIdentity);
      };
    }
    if (
      hierarchyIdentity !== null &&
      this.dependencies.db.getAgentById(hierarchyIdentity.agentId) !== null
    ) {
      throw new Error(
        `Cannot spawn ${name}: hierarchy identity ${hierarchyIdentity.agentId} is already reserved`,
      );
    }
    // What governs this spawn: the user's routing policy — the candidate set the user configured for this task category — and nothing else. The router resolves the category route (else global, else refuses), runs every candidate through the full launch gate, and selects one fairly by smooth weighted round-robin. A corrupt policy store throws out of read() and the spawn refuses: "I could not read your policy" is never answered as "you have no policy" (unknown-read-as-permission).
    const readPolicy = (): RoutingPolicy => {
      if (this.dependencies.readRoutingPolicy === undefined) {
        throw new Error(
          `Cannot spawn ${name}: no routing policy source is configured`,
        );
      }
      return this.dependencies.readRoutingPolicy();
    };
    let tool: CapabilityProvider;
    const explicitModel: string | undefined = request.model;
    if (request.model !== undefined) {
      // An explicit model is bound to its vendor before anything launches. The vendor is read from the DISCOVERED CATALOG — the vendor's own list of what it can run, aliases included — never from the shape of the name (unknown-read-as-permission).
      const identified = identifyModelVendor(
        request.model,
        await forEachProvider((provider) =>
          this.discoverCapabilities(provider),
        ),
      );
      if (identified.state === "unclaimed") {
        throw new Error(
          `Cannot spawn ${name}: no vendor's catalog lists model ` +
            `${JSON.stringify(request.model)}. Every vendor Hive knows was asked ` +
            "and none of them can run it, so there is no tool to launch it on. " +
            "Name a model one of them publishes.",
        );
      }
      if (identified.state === "claimed") {
        const vendor = identified.provider;
        if (request.tool !== undefined && request.tool !== vendor) {
          throw new Error(
            `Cannot spawn ${name}: model ${JSON.stringify(request.model)} is a ${vendor} model, ` +
              `but tool=${JSON.stringify(request.tool)} was explicitly requested. ` +
              `Drop the tool to run it on ${vendor}, or name a ${request.tool} model.`,
          );
        }
        tool = vendor;
      } else if (request.tool !== undefined) {
        // Unreadable is not permission, but the caller can explicitly name the CLI to use. Hive preserves that instruction while making the missing vendor evidence visible.
        console.warn(
          `Hive could not identify the vendor of model ${JSON.stringify(request.model)} ` +
            `(${identified.reason}); ` +
            `it launches on the explicitly requested ${request.tool}, unverified.`,
        );
        tool = request.tool;
      } else {
        throw new Error(
          `Cannot spawn ${name}: no vendor's catalog could be read to identify ` +
            `${JSON.stringify(request.model)}, and no tool= was given. Pass the ` +
            "vendor explicitly to launch it.",
        );
      }
    } else {
      // Routed spawns get their tool from the chain walk below; this value is never read before the walk assigns the authorized launch.
      tool = request.tool ?? "claude";
    }
    // Fixed before routing: flat spawns mint here, while hierarchy spawns use the grant subject reserved by preflight. The id also makes the router selection idempotent.
    const agentId = hierarchyIdentity?.agentId ?? crypto.randomUUID();
    let executionIdentity: ExecutionIdentity | undefined;
    let quotaReservationId: string | undefined;
    let effort: string | undefined;
    const linkEffort = async (
      entry: {
        provider: CapabilityProvider;
        model: string;
        effort: EffortTarget;
      },
      policy: RoutingPolicy,
    ): Promise<string | undefined> => {
      if (request.effort !== undefined) return request.effort;
      if (entry.effort.mode === "exact") return entry.effort.value;
      if (entry.effort.mode === "none") return undefined;
      if (entry.effort.mode === "never-configured") {
        throw new Error(
          `${entry.provider}/${entry.model} effort is never-configured; choose Hive decides or an explicit effort`,
        );
      }
      if (entry.effort.mode === "hive-decides") {
        const discovery = await this.discoverCapabilities(entry.provider);
        const record =
          discovery?.status === "ok"
            ? discovery.records.find(
                (candidate) =>
                  candidate.launchToken === entry.model ||
                  candidate.canonicalId === entry.model ||
                  candidate.aliases.includes(entry.model),
              )
            : undefined;
        return resolveAutoEffort(record, request.category).effort;
      }
      const row = policy.models.find(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.model === entry.model,
      );
      if (row?.effort.mode === "exact") return row.effort.value;
      if (row?.effort.mode === "hive-decides") {
        const discovery = await this.discoverCapabilities(entry.provider);
        const record =
          discovery?.status === "ok"
            ? discovery.records.find(
                (candidate) =>
                  candidate.launchToken === entry.model ||
                  candidate.canonicalId === entry.model,
              )
            : undefined;
        return resolveAutoEffort(record, request.category).effort;
      }
      return undefined;
    };
    const authorizeCandidate = async (
      raw: RawLaunchCandidate,
    ): Promise<LaunchGateResult> => {
      let record: CapabilityRecord | undefined;
      const checks: LaunchGateChecks = {
        resolution: async (candidate) => {
          if (candidate.model.trim().length === 0) return "model is empty";
          if (this.dependencies.discoverCapabilities === undefined) return null;
          const discovery = await this.discoverCapabilities(candidate.tool);
          if (discovery === undefined || discovery.status !== "ok") {
            return `${candidate.tool}'s model catalog is unreadable`;
          }
          record = discovery.records.find(
            (entry) =>
              entry.launchToken === candidate.model ||
              entry.canonicalId === candidate.model ||
              entry.aliases.includes(candidate.model),
          );
          return record === undefined
            ? `${candidate.tool}'s readable catalog has no record for ${candidate.model}`
            : null;
        },
        enablement: async (candidate) => {
          let enabled: ModelEnablementDecision;
          try {
            enabled =
              (await this.dependencies.isModelEnabled?.(
                candidate.tool,
                candidate.model,
              )) ?? null;
          } catch (error) {
            return `${candidate.model} enablement policy is unreadable (${errorMessage(
              error,
            )}); open the Model Control Center and enable it before launching`;
          }
          if (enabled !== null && enabled !== true && enabled !== false) {
            return enabled.refusal;
          }
          if (enabled !== true) {
            return (
              `${candidate.model} is not enabled; open the Model Control Center ` +
              "and enable it before launching"
            );
          }
          if (!CapabilityProviderSchema.safeParse(candidate.tool).success) {
            return `provider ${JSON.stringify(candidate.tool)} is not enabled`;
          }
          if (record === undefined) return null;
          if (record.entitled.state === "known" && !record.entitled.value) {
            return `${candidate.model} is not entitled`;
          }
          return record.hidden.state === "known" && record.hidden.value
            ? `${candidate.model} is disabled by the vendor`
            : null;
        },
        availability: (candidate) =>
          this.availabilityRefusal(candidate.tool, candidate.model),
        effort: async (candidate) => {
          // The candidate's effort is the user's instruction (request.effort or the chain link); validation against the model's own record disposes. Undefined means provider-controlled, resolved to the vendor's honest answer: Claude's effort is observed, never chosen; Grok and Codex take their discovered default; Codex's CLI requires a flag, so its last resort stays "medium".
          try {
            const requested = candidate.effort;
            if (requested !== undefined) {
              const validated = validateEffort(
                record,
                candidate.model,
                requested,
              );
              if (validated.warning !== undefined)
                console.warn(validated.warning);
              return {
                refusal: null,
                ...definedFields({ effort: validated.effort }),
              };
            }
            const discoveredDefault =
              record?.defaultEffort.state === "known"
                ? record.defaultEffort.value
                : undefined;
            switch (candidate.tool) {
              case "claude":
              case "opencode":
                return { refusal: null };
              case "grok":
              case "kimi": {
                if (discoveredDefault === undefined) return { refusal: null };
                const validated = validateEffort(
                  record,
                  candidate.model,
                  discoveredDefault,
                );
                return {
                  refusal: null,
                  ...definedFields({ effort: validated.effort }),
                };
              }
              case "codex": {
                const validated = validateEffort(
                  record,
                  candidate.model,
                  discoveredDefault ?? "medium",
                );
                if (validated.warning !== undefined)
                  console.warn(validated.warning);
                return {
                  refusal: null,
                  ...definedFields({ effort: validated.effort }),
                };
              }
              default:
                return unknownVendor(candidate.tool, "spawn effort");
            }
          } catch (error) {
            return {
              refusal: errorMessage(error),
            };
          }
        },
      };
      return await AuthorizedLaunch.gate(raw, checks);
    };
    const requireGate = async (
      raw: RawLaunchCandidate,
    ): Promise<AuthorizedLaunch> => {
      const result = await authorizeCandidate(raw);
      if (result.refusal !== undefined) {
        throw new Error(
          `Cannot spawn ${name}: ${result.refusal.reason} refused ` +
            `${raw.tool}/${raw.model}: ${result.refusal.detail}`,
        );
      }
      return result.authorized;
    };
    /** The router's per-candidate launch gate: effort resolution plus the complete AuthorizedLaunch mint. An explicitly requested tool narrows the route here rather than in policy. */
    const gateCandidate: CandidateGate = async (candidate) => {
      if (request.tool !== undefined && candidate.provider !== request.tool) {
        return {
          refusal: {
            gate: "policy",
            detail: `tool=${request.tool} was explicitly requested`,
          },
        };
      }
      let effortValue: string | undefined;
      try {
        effortValue = await linkEffort(candidate, readPolicy());
      } catch (error) {
        return {
          refusal: {
            gate: "effort",
            detail: errorMessage(error),
          },
        };
      }
      const gate = await authorizeCandidate({
        tool: candidate.provider,
        model: candidate.model,
        ...definedFields({ effort: effortValue }),
      });
      return gate.refusal !== undefined
        ? {
            refusal: {
              gate: gate.refusal.reason,
              detail: gate.refusal.detail,
            },
          }
        : { authorized: gate.authorized };
    };
    let authorized: AuthorizedLaunch;
    let decision: LaunchDecision;
    if (explicitModel !== undefined) {
      // A user-named model is the only candidate and is never substituted: it passes the same gates as any candidate (a pin is a route, not a consent), bypasses weighted selection, and never mutates balance.
      authorized = await requireGate({
        tool,
        model: explicitModel,
        ...definedFields({ effort: request.effort }),
      });
      decision = this.router().recordExplicitDecision(
        agentId,
        request.category,
        authorized,
      );
    } else {
      const selection = await this.router().select(
        {
          requestId: agentId,
          category: request.category,
          requirements: { reviewOfProvider: request.reviewOfTool ?? null },
          excludedPoolIds: request.excludedPoolIds ?? [],
        },
        gateCandidate,
      );
      if (selection.outcome === "refused") {
        const refusal = selection.refusal;
        const detail =
          refusal.kind === "no-candidate"
            ? `${refusal.detail}:\n  ${refusal.evaluations
                .map(
                  (evaluation) =>
                    `${evaluation.candidate.provider}/${evaluation.candidate.model} — ` +
                    `${evaluation.refusal?.gate}: ${evaluation.refusal?.detail}`,
                )
                .join("\n  ")}\n` +
              "Enable a model or edit the route in the Model Control Center."
            : refusal.detail;
        throw new Error(`Cannot spawn ${name}: ${detail}`);
      }
      authorized = selection.authorized;
      decision = selection.decision;
    }
    if (this.dependencies.quota?.config.enabled === true) {
      await this.dependencies.quotaReady?.();
      quotaReservationId = this.dependencies.quota.reserveLaunch(
        name,
        authorized,
        request.category,
      ).id;
    }
    tool = authorized.tool;
    const model: string = authorized.model;
    effort = authorized.effort;
    if (model !== "default") {
      switch (tool) {
        case "claude":
        case "kimi":
        case "opencode":
          executionIdentity = {
            tool,
            model,
            ...definedFields({ effort }),
          };
          break;
        case "codex":
          executionIdentity = { tool, model, effort: effort ?? "medium" };
          break;
        case "grok": {
          const identity =
            this.dependencies.grokIdentity?.() ??
            probeGrokCliVersion(this.grokExecutable);
          if (identity === null) {
            throw new Error("Cannot spawn Grok: grok --version failed");
          }
          executionIdentity = {
            tool,
            model,
            ...definedFields({ effort }),
            cliVersion: identity.version ?? "unknown",
            cliBuildHash: identity.buildHash ?? "unknown",
          };
          break;
        }
        default:
          unknownVendor(tool, "execution identity");
      }
    }
    const sessiondPolicy =
      await this.dependencies.sessiond.prepareAgentCreation();
    if (sessiondPolicy === null) {
      throw new SpawnFailedError(
        name,
        "transport",
        "failed",
        "failed to spawn: sessiond spawn admission is unavailable",
      );
    }
    // Before the worktree, because this can refuse: a spawn that dies later leaves a worktree behind to be reaped.
    const standards = await loadAgentStandards(this.dependencies.repoRoot);
    // Read once, before the prompt: the directive, the digest, and the MCP config below must all describe the same server observation.
    const graphifyUrl = this.dependencies.graphifyUrl?.() ?? null;
    const [memoryIndex, graphBrief, verificationFact] = await Promise.all([
      // Memory resolves against the primary checkout, never the worktree: .hive/memory is gitignored, so worktrees never contain it.
      this.buildMemoryIndex(this.dependencies.repoRoot, {
        brief: request.task,
      }),
      this.dependencies.graphifyBrief === undefined
        ? Promise.resolve(null)
        : this.dependencies.graphifyBrief(request.task).catch((error) => {
            console.error(
              `Hive could not build a graph brief for ${name}; spawning without one: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
            );
            return null;
          }),
      readMemoryFact(
        this.dependencies.repoRoot,
        "repo",
        VERIFICATION_ARTICLE_ID,
      ).catch(() => null),
    ]);
    const learnedCommand =
      verificationFact === null
        ? null
        : verificationCommandFromTitle(verificationFact.title);
    const timestamp = new Date().toISOString();
    const providerRunId = crypto.randomUUID();
    // Hive names Grok's session id at launch because Grok has no lifecycle hooks. Do not select the newest session by cwd: reused worktrees also contain dead predecessors, while `--session-id` makes this row authoritative immediately.
    const grokSessionId = tool === "grok" ? crypto.randomUUID() : undefined;
    const sessionLocator = mintSessionLocator(
      hiveInstanceSuffix(getHiveHome()),
      { kind: "agent", agentId },
      hierarchyIdentity?.generation ?? 1,
      sessiondPolicy.engineBuildId,
    );
    let record = this.dependencies.db.insertAgent({
      // A fresh flat UUID or the hierarchy grant's never-before-used subject. Reusing either would overwrite the closure record that distinguishes two generations.
      id: agentId,
      sessionLocator,
      ...definedFields({ toolSessionId: grokSessionId }),
      name,
      tool,
      model,
      category: request.category,
      status: "spawning",
      taskDescription: request.task,
      worktreePath: join(
        this.dependencies.repoRoot,
        ".hive",
        "worktrees",
        name,
      ),
      branch: null,
      // Unknown, not empty. A fresh agent has not been observed yet, and 0 was a claim we had no basis for — one that survived, unchallenged, for the whole life of any agent whose telemetry we could never read.
      contextPct: null,
      createdAt: timestamp,
      lastEventAt: timestamp,
      ...definedFields({ quotaReservationId, executionIdentity }),
      capabilityEpoch: hierarchyIdentity?.capabilityEpoch ?? 0,
      readOnly,
      writeRevoked: false,
    });
    stranded.release = null;
    const planned = plannedWorktree(
      this.dependencies.repoRoot,
      name,
      slugify(request.task),
    );
    const baseOid = await readWorktreeHead(this.dependencies.repoRoot).catch(
      () => null,
    );
    await this.dependencies.settlement
      ?.open(record, planned, baseOid)
      .catch((error) => {
        console.error(
          `Hive could not open ${name}'s settlement case before worktree creation; the recovery sweep will adopt it: ${errorMessage(error)}`,
        );
      });
    let worktree: CreatedWorktree;
    try {
      worktree = await this.makeWorktree(
        this.dependencies.repoRoot,
        name,
        slugify(request.task),
      );
    } catch (error) {
      if (hierarchyIdentity !== null && hierarchyAdmission !== null) {
        hierarchyAdmission.failLaunch(hierarchyIdentity);
      }
      const failed = await this.failSpawn(
        record,
        null,
        errorMessage(error),
        "transport",
        decision.decisionId,
        providerRunId,
        "never-created",
      );
      throw this.spawnFailure(failed, "transport", errorMessage(error));
    }
    record = this.dependencies.db.insertAgent({
      ...record,
      worktreePath: worktree.path,
      branch: worktree.branch,
    });
    let providerProcessProvenAlive = false;
    if (hierarchyIdentity !== null) {
      if (hierarchyAdmission === null) {
        throw new Error(
          `Cannot spawn ${name}: hierarchy launch provenance is incomplete`,
        );
      }
      try {
        const baseSha = await (
          this.dependencies.measureWorktreeHead ?? readWorktreeHead
        )(worktree.path);
        const measuredFacts = {
          provider: tool,
          model,
          sessionLocator,
          worktree: worktree.path,
          branch: worktree.branch,
          baseSha,
        };
        hierarchyAdmission.stampMeasuredLaunch(
          hierarchyIdentity,
          measuredFacts,
        );
        hierarchyAdmission.prepareLaunch(hierarchyIdentity, measuredFacts);
      } catch (error) {
        hierarchyAdmission.failLaunch(hierarchyIdentity);
        const failed = await this.failSpawn(
          record,
          worktree,
          errorMessage(error),
          "transport",
          decision.decisionId,
          providerRunId,
          "never-created",
        );
        throw this.spawnFailure(failed, "transport", errorMessage(error));
      }
    }

    const failProviderLaunch = async (
      failureReason: string,
      layer: QuarantineLaunchLayer,
      neverCreated = false,
    ): Promise<AgentRecord> => {
      if (providerProcessProvenAlive) {
        const current = this.dependencies.db.getAgentById(record.id) ?? record;
        return current.status === "spawning"
          ? this.dependencies.db.insertAgent({
              ...current,
              status: "working",
              lastEventAt: new Date().toISOString(),
            })
          : current;
      }
      this.recordLaunchFailure(
        record,
        decision.decisionId,
        providerRunId,
        failureReason,
      );
      if (!neverCreated && !(await this.terminalReportedDead(record))) {
        return this.preserveUnverifiedLaunch(record);
      }
      try {
        if (hierarchyIdentity !== null && hierarchyAdmission !== null) {
          hierarchyAdmission.failLaunch(hierarchyIdentity);
          if (!neverCreated) {
            await this.stopVerifiedSession(
              record,
              "Hierarchy provider launch failed",
            );
          }
          return await this.failSpawn(
            record,
            worktree,
            failureReason,
            layer,
            decision.decisionId,
            providerRunId,
            neverCreated ? "never-created" : undefined,
          );
        }
        return await this.failSpawnIfStillSpawning(
          record,
          worktree,
          failureReason,
          layer,
          decision.decisionId,
          providerRunId,
          neverCreated ? "never-created" : undefined,
        );
      } catch (error) {
        // A synchronous spawn reports discarded cleanup by throwing. This
        // launch is already detached, so forwarding that verdict makes its
        // outer rescue recreate the discarded row as `stuck`.
        if (
          error instanceof SpawnFailedError &&
          this.dependencies.db.getAgentById(record.id) === null
        ) {
          return record;
        }
        throw error;
      }
    };

    const launch = async (): Promise<void> => {
      try {
        const assignment = this.dependencies.assignments?.open(
          record.id,
          record.createdAt,
        );
        const spawnBrief =
          hierarchyIdentity === null || hierarchyAdmission === null
            ? undefined
            : hierarchyAdmission.takeLaunchContext(hierarchyIdentity);

        // P0.12: Dual-read pack+index (gate with wake_pack_enabled sunset flag)
        const wakePackEnabled =
          this.dependencies.config.memory?.wake_pack_enabled ?? true;
        let constitution: string | undefined;
        let profile: string | undefined;
        let handoffText: string | undefined;
        let projectDoc: string | undefined;
        let recentMistakes: readonly string[];

        if (wakePackEnabled) {
          // P0: Load and validate wake pack floor (throws SpawnFailedError if handoff unsynthable)
          const pack = await loadAndValidateWakePack({
            db: this.dependencies.db,
            episodic: this.dependencies.episodic,
            repoRoot: this.dependencies.repoRoot,
            handoffId: request.handoffId,
            agentName: name,
            task: request.task,
          });

          constitution = pack.constitution;
          profile = pack.profile;
          projectDoc = pack.projectDoc;
          handoffText = pack.handoffText;
          recentMistakes = pack.recentMistakes ?? [];
        } else {
          // Pack-off path: normalize to empty array (no mistakes loaded)
          recentMistakes = [];
        }

        const prompt = buildAgentPrompt(
          name,
          request.task,
          worktree,
          memoryIndex,
          standards,
          {
            tool,
            readOnly,
            category: request.category,
            ...definedFields({
              graphBrief: graphBrief === null ? undefined : graphBrief,
              graphifyTools: graphifyUrl === null ? undefined : true,
              assignment,
              handoffId: request.handoffId,
              spawnBrief,
              boardTaskId,
              learnedVerification:
                learnedCommand === null || verificationFact === null
                  ? undefined
                  : {
                      command: learnedCommand,
                      status: verificationFact.status,
                    },
              constitution,
              profile,
              handoffText,
              projectDoc,
              recentMistakes:
                recentMistakes !== undefined && recentMistakes.length > 0
                  ? recentMistakes
                  : undefined,
            }),
          },
        );
        const instructionPath = await writeLaunchPrompt(
          this.requireAgentLocator(record).sessionId,
          prompt,
        );
        const adapter = getAgentAdapter(tool);
        const dangerous = this.dependencies.config.autonomy === "dangerous";
        const excludeMcpServers =
          tool === "codex"
            ? await this.inheritedCodexMcpServers()
            : // Grok's inherited MCPs are disabled by GROK_*_MCPS_ENABLED=false.
              [];
        const capabilityToken = this.dependencies.issueCredential?.(
          name,
          readOnly ? "reader" : "writer",
          record.capabilityEpoch,
        );
        const hierarchyCredentialId =
          hierarchyIdentity === null
            ? null
            : capabilityToken === undefined
              ? null
              : (parseToken(capabilityToken)?.id ?? null);
        if (hierarchyIdentity !== null && hierarchyCredentialId === null) {
          throw new Error(
            `Cannot spawn ${name}: hierarchy credential identity is unavailable`,
          );
        }
        await provisionSkills(this.dependencies.repoRoot, worktree.path, {
          role: "agent",
          tool,
          category: request.category,
        });
        // Before the config, because an untrusted workspace makes the CLI discard the hooks and permissions the config write is about to lay down (claude's folder-trust seed; the other vendors have none).
        await adapter.prepareWorktree?.(worktree.path);
        const kickoff = "Begin the assigned task.";
        const hiveCommand = hiveCliSpawnArgv(
          IS_RELEASE_BUILD,
          process.execPath,
        );
        // An adapter may REFUSE here — Grok does, when the worktree is untrusted and the vendor would therefore never start Hive's MCP server in it. Nothing has been launched at this point: prepareRuntime builds a command and writes provider config, and no terminal host exists yet. Reporting that through the generic catch below would send it down the teardown-verification path and record the agent as `stuck` with "teardown could not be verified" — a cleanup failure that did not happen, about a session that was never created.
        let preparedLaunch: PreparedProviderRuntime;
        try {
          preparedLaunch = await adapter.prepareRuntime({
            daemonPort: this.daemonPort(),
            model,
            ...definedFields({ effort }),
            name,
            readOnly,
            dangerous,
            worktreePath: worktree.path,
            executable: this.executableFor(tool),
            hiveCommand,
            ...definedFields({
              withCapability: capabilityToken === undefined ? undefined : true,
              graphifyUrl: graphifyUrl === null ? undefined : graphifyUrl,
            }),
            instructionPath,
            providerRunId,
            excludeMcpServers,
          });
        } catch (error) {
          await failProviderLaunch(
            error instanceof Error
              ? error.message
              : "provider launch preparation failed",
            "transport",
            true,
          );
          return;
        }
        const frontendArgv = agentUiLaunchArgv({
          hiveCommand,
          subject: name,
          provider: tool,
          executable: this.executableFor(tool),
          daemonPort: this.daemonPort(),
          providerRunId,
          worktreePath: worktree.path,
          journalPath: join(
            getHiveHome(),
            "agent-ui",
            this.requireAgentLocator(record).sessionId,
            "outbound.jsonl",
          ),
          model,
          ...definedFields({ effort }),
          readOnly,
          instructionPath,
          kickoff,
          providerArgv: protocolProviderArgv(tool, preparedLaunch.argv),
        });
        let frontendCommand = shellJoin(frontendArgv);
        if (tool === "grok") {
          frontendCommand = wrapGrokSpawnWithCompatibilityEnv(frontendCommand);
        }
        if (tool === "kimi") {
          if (effort !== undefined) {
            frontendCommand = wrapKimiSpawnWithEffort(frontendCommand, effort);
          }
          frontendCommand = wrapKimiWithTurnHookContext(frontendCommand, {
            name,
            daemonPort: this.daemonPort(),
            instanceId: hiveInstanceSuffix(),
            providerRunId,
          });
        }
        if (capabilityToken !== undefined) {
          frontendCommand = wrapSpawnWithCapabilityEnv(
            frontendCommand,
            name,
            frontendArgv[0] ?? "",
          );
        }
        const revalidateAtAdapter = async (): Promise<AuthorizedLaunch> => {
          const revalidated = await requireGate({
            tool: authorized.tool,
            model: authorized.model,
            ...definedFields({ effort: authorized.effort }),
          });
          if (
            revalidated.tool !== authorized.tool ||
            revalidated.model !== authorized.model ||
            revalidated.effort !== authorized.effort
          ) {
            throw new Error(
              `Cannot spawn ${name}: launch identity changed during final revalidation`,
            );
          }
          authorized = revalidated;
          return requireAuthorizedLaunch(authorized);
        };
        const launchSession = async (
          candidate: AuthorizedLaunch,
          command: string,
          expectedExecutable: string,
        ): Promise<void> => {
          requireAuthorizedLaunch(candidate);
          if (hierarchyIdentity !== null && hierarchyAdmission !== null) {
            hierarchyAdmission.revalidateLaunch(hierarchyIdentity);
          }
          await this.createSession(
            record,
            command,
            expectedExecutable,
            decision.decisionId,
            providerRunId,
          );
        };

        const launchedCommand = launchedCommandName(frontendArgv);
        const launchBaseline = new Date().toISOString();
        await launchSession(
          await revalidateAtAdapter(),
          frontendCommand,
          launchedCommand,
        );
        const failureReason = await this.monitorReadiness(
          record,
          launchedCommand,
        );
        if (failureReason !== null) {
          // The command ran, so this is the model's answer — unless the pane shows the binary never executed at all.
          await failProviderLaunch(
            failureReason,
            readinessFailureLayer(failureReason),
          );
          return;
        }
        providerProcessProvenAlive = true;
        const ready = this.dependencies.db.getAgentById(record.id);
        if (ready?.status === "spawning") {
          this.dependencies.db.insertAgent({ ...ready, status: "working" });
        }
        if (quotaReservationId !== undefined) {
          this.dependencies.quota?.markStarted(quotaReservationId);
        }
        this.router().recordLaunchResult(decision.decisionId, "started");
        if (
          hierarchyIdentity !== null &&
          hierarchyAdmission !== null &&
          hierarchyCredentialId !== null
        ) {
          const bindingReady = this.dependencies.db.getAgentById(record.id);
          if (
            bindingReady === null ||
            bindingReady.status === "dead" ||
            bindingReady.status === "done" ||
            bindingReady.status === "stuck"
          ) {
            throw new Error(
              `Cannot bind hierarchy identity ${record.id}: launch is no longer live`,
            );
          }
          hierarchyAdmission.bindAfterReadiness(
            hierarchyIdentity,
            hierarchyCredentialId,
          );
        }
        // Starting the task earlier invalidates the assigned revision that every
        // hierarchy re-check must still prove. A failed launch therefore makes
        // no board claim to compensate, while a live launch advances it once.
        if (boardTaskId !== undefined) {
          this.dependencies.startBoardTask?.(boardTaskId, agentId, name);
        }
        // MCP reachability measures a control channel, not process liveness. A
        // provider that misses this deadline is still a started run when the
        // readiness watch already proved its launched process alive, so it can
        // change none of the bookkeeping above. It therefore runs last and
        // unawaited: waited on, it held the row at `spawning`, the quota
        // reservation, the routing result, the hierarchy binding and the name
        // reservation behind a line of console output. Recording the launch
        // ahead of the binding alone would only move the lie — an agent that
        // reads working cannot do hierarchy writes until it is bound — so the
        // whole diagnostic goes last. hive_status carries the standing
        // observation of reachability; this is only its launch-time note.
        if (this.dependencies.mcpClientSeen !== undefined) {
          void waitForMcpReporting(
            name,
            launchBaseline,
            this.dependencies.mcpClientSeen,
            (ms) => this.wait(ms),
            this.dependencies.mcpReportingTimeoutMs,
          )
            .catch((error) => errorMessage(error))
            .then((reportingFailure) => {
              if (reportingFailure !== null) {
                console.warn(`Hive ${name}: ${reportingFailure}`);
              }
            });
        }
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "Agent launch failed";
        await failProviderLaunch(
          reason,
          "transport",
          error instanceof SessiondWireError &&
            error.code === "CAPACITY_EXCEEDED",
        );
      }
    };
    stranded.launchOwnsName = true;
    void launch()
      .catch((error) => {
        let reason =
          error instanceof Error ? error.message : "unknown background failure";
        if (hierarchyIdentity !== null && hierarchyAdmission !== null) {
          try {
            hierarchyAdmission.failLaunch(hierarchyIdentity);
          } catch (compensationError) {
            const detail =
              compensationError instanceof Error
                ? compensationError.message
                : "unknown binding state";
            reason = `${reason}; hierarchy binding cleanup failed: ${detail}`;
          }
        }
        this.preserveStuck(record, `Background launch failed: ${reason}`);
        console.error(`Hive background launch failed for ${name}: ${reason}`);
      })
      .finally(() => {
        this.dependencies.db.releaseAgentName(name);
      });
    return record;
  }

  private async monitorReadiness(
    record: AgentRecord,
    launchedCommand: string,
  ): Promise<string | null> {
    const newestEventSeq = () =>
      this.dependencies.newestAgentEventSeq?.(record.id) ?? null;
    // Baseline from the stream, sampled before the watch: anything at or below it was already there, so only a genuinely new lifecycle event counts.
    const baselineEventSeq = newestEventSeq();

    const locator = requireSessiondAgentLocator(record);
    const proof = await watchForProofOfLife(locator, baselineEventSeq, {
      hasSession: () => this.sessionPresent(record),
      capturePane: () => this.captureVisible(record),
      newestEventSeq,
      codexActivity: () => this.readCodexActivityFor(record),
      launchedProcessAlive: () =>
        this.launchedProcessAlive(record, launchedCommand),
      launchedCommand,
      settled: () => !this.isStillSpawning(record.id),
      wait: (ms) => this.wait(ms),
    });
    return proof.alive ? null : proof.reason;
  }

  private isStillSpawning(agentId: string): boolean {
    const current = this.dependencies.db.getAgentById(agentId);
    return current === null || current.status === "spawning";
  }

  private preserveStuck(
    record: AgentRecord,
    _failureReason: string,
  ): AgentRecord {
    return this.dependencies.db.insertAgent({
      ...(this.dependencies.db.getAgentById(record.id) ?? record),
      status: "stuck",
      writeRevoked: true,
      lastEventAt: new Date().toISOString(),
    });
  }

  private preserveUnverifiedLaunch(record: AgentRecord): AgentRecord {
    return this.dependencies.db.insertAgent({
      ...(this.dependencies.db.getAgentById(record.id) ?? record),
      status: "unknown",
      writeRevoked: true,
      lastEventAt: new Date().toISOString(),
    });
  }

  private async stopVerifiedSession(
    record: AgentRecord,
    context: string,
  ): Promise<void> {
    try {
      const outcome = await this.dependencies.stopSession(record);
      if (outcome.survivors.length > 0) {
        throw new Error(
          `${outcome.survivors.length} process(es) survived teardown`,
        );
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "unknown process state";
      const reason = `${context}: teardown could not be verified: ${detail}`;
      this.preserveStuck(record, reason);
      throw new Error(reason, { cause: error });
    }
  }

  private async failSpawnIfStillSpawning(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
    layer: QuarantineLaunchLayer,
    decisionId: string,
    providerRunId: string,
    terminalDisposition?: "never-created",
  ): Promise<AgentRecord> {
    const current = this.dependencies.db.getAgentById(record.id);
    if (current !== null && current.status !== "spawning") {
      if (current.status === "dead" || current.status === "stuck") {
        this.dependencies.assignments?.close(
          record.id,
          new Date().toISOString(),
        );
      }
      return current;
    }
    return await this.failSpawn(
      record,
      worktree,
      failureReason,
      layer,
      decisionId,
      providerRunId,
      terminalDisposition,
    );
  }

  private spawnFailure(
    record: AgentRecord,
    layer: QuarantineLaunchLayer,
    failureReason: string,
  ): SpawnFailedError {
    const outcome = record.status === "stuck" ? "stuck" : "failed";
    const detail =
      outcome === "stuck"
        ? `could not verify cleanup after spawn: ${failureReason}`
        : `failed to spawn: ${failureReason}`;
    return new SpawnFailedError(record.name, layer, outcome, detail);
  }

  private recordLaunchFailure(
    record: AgentRecord,
    decisionId: string,
    providerRunId: string,
    failureReason: string,
    endedAt = new Date().toISOString(),
  ): void {
    const firstReport =
      this.dependencies.db.getRunOutcome(providerRunId) === null;
    this.dependencies.db.recordRunOutcome({
      decisionId,
      providerRunId,
      provider: record.tool,
      model: record.model,
      taskCategory: record.category,
      outcome: "launch-failed",
      handoffId: null,
      startedAt: record.createdAt,
      endedAt,
    });
    if (firstReport) {
      console.error(`Hive launch failed for ${record.name}: ${failureReason}`);
    }
  }

  private async failSpawn(
    record: AgentRecord,
    worktree: CreatedWorktree | null,
    failureReason: string,
    layer: QuarantineLaunchLayer,
    decisionId: string,
    providerRunId: string,
    terminalDisposition?: "never-created",
  ): Promise<AgentRecord> {
    let failed: AgentRecord;
    try {
      failed = await this.failSpawnAndCleanup(
        record,
        worktree,
        failureReason,
        layer,
        decisionId,
        providerRunId,
        terminalDisposition,
      );
    } finally {
      this.dependencies.assignments?.close(record.id, new Date().toISOString());
    }
    if (this.dependencies.db.getAgentById(record.id) === null) {
      throw this.spawnFailure(failed, layer, failureReason);
    }
    return failed;
  }

  private async failSpawnAndCleanup(
    record: AgentRecord,
    worktree: CreatedWorktree | null,
    failureReason: string,
    layer: QuarantineLaunchLayer,
    decisionId: string,
    providerRunId: string,
    terminalDisposition?: "never-created",
  ): Promise<AgentRecord> {
    // Record the spawn verdict and leave the terminal alone. A readiness or MCP timeout does not prove terminal death, especially under load.
    const stopping = this.preserveStuck(record, failureReason);
    // A vendor rate-limit error is a drain, not a route failure; the quarantine would punish a healthy route for an empty meter.
    const vendorDrain =
      layer === "model" && classifyVendorDrainError(record.tool, failureReason);
    if (layer === "model" && !vendorDrain) {
      this.router().recordLaunchResult(decisionId, "launch-failed");
    }
    if (record.quotaReservationId !== undefined) {
      try {
        // A model-layer failure reached the provider and may quarantine that exact route. Transport failures release capacity without claiming anything about the model.
        await this.dependencies.quota?.cancel(
          record.quotaReservationId,
          new Date().toISOString(),
          layer === "model" && !vendorDrain ? failureReason : undefined,
        );
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "quota cancellation failed";
        return this.preserveStuck(
          stopping,
          `${failureReason}\nQuota release could not be verified: ${detail}`,
        );
      }
    }
    const endedAt = new Date().toISOString();
    this.recordLaunchFailure(
      record,
      decisionId,
      providerRunId,
      failureReason,
      endedAt,
    );
    let failed = this.dependencies.db.insertAgent({
      ...(this.dependencies.db.getAgentById(record.id) ?? stopping),
      status: "dead",
      writeRevoked: true,
      lastEventAt: endedAt,
    });
    if (vendorDrain) {
      failed = this.dependencies.db.getAgentById(failed.id) ?? failed;
      await this.dependencies.drainError?.(failed, failureReason);
    }
    const {
      preserved,
      removed: worktreeRemoved,
      cleanupErrors,
    } = this.dependencies.settlement === undefined
      ? {
          preserved:
            worktree === null
              ? null
              : `Kept the worktree at ${worktree.path} (branch ${worktree.branch}): no settlement service is wired.`,
          removed: false,
          cleanupErrors: [],
        }
      : await this.dependencies.settlement.settleFailed(
          failed,
          worktree,
          this.dependencies.keepWorktreeOnFailure ?? false,
        );

    if (
      worktree === null ||
      (terminalDisposition === "never-created" && worktreeRemoved)
    ) {
      this.dependencies.db.discardSpawn(
        failed.id,
        terminalDisposition ?? "never-created",
      );
      return failed;
    }

    if (worktreeRemoved) {
      failed = this.dependencies.db.insertAgent({
        ...failed,
        worktreePath: null,
        branch: null,
      });
    } else if (worktree !== null) {
      failed = this.dependencies.db.insertAgent({
        ...failed,
        status: "stuck",
      });
    }

    if (preserved !== null || cleanupErrors.length > 0) {
      console.error(
        [failureReason, preserved, ...cleanupErrors].filter(Boolean).join("\n"),
      );
    }
    return failed;
  }
}
