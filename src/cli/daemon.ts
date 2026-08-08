import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { getHiveHome } from "../hive-home/home";
import { HOME_MIGRATION_ANNOUNCEMENT } from "../hive-home/migration";
import { buildGraphBrief } from "../adapters/graphify";
import { resolveWorkingClaudeExecutable } from "../adapters/providers/claude-cli";
import { resolveWorkingCodexExecutable } from "../adapters/providers/codex-cli";
import { resolveWorkingGrokExecutable } from "../adapters/providers/grok-cli";
import { resolveWorkingKimiExecutable } from "../adapters/providers/kimi-cli";
import { resolveWorkingOpencodeExecutable } from "../adapters/providers/opencode-cli";
import { persistAutonomy } from "../config/autonomy";
import { loadHiveConfig, loadQuotaConfig } from "../config/load";
import { createCapabilitySnapshotAuthority } from "../daemon/provider-capabilities/snapshot-authority";
import { HiveDatabase } from "../daemon/database/hive-database";
import { GraphifyService } from "../daemon/graphify-service/graphify-service";
import { currentBuildHash } from "../daemon/lifecycle/daemon-lifecycle";
import { hiveInstanceSuffix } from "../hive-home/instance-identity";
import { machineModelControlDatabase } from "../daemon/routing-service/instance-settings";
import {
  acquireDaemonLock,
  cleanupLifecycleFiles,
  macProcessIdentity,
  readConfiguredPort,
  releaseDaemonLock,
} from "../daemon/lifecycle/daemon-lifecycle";
import { readModelInventory } from "../daemon/provider-capabilities/model-inventory";
import { projectRootOrCwd } from "../daemon/project-identity-core/project-root";
import {
  policyModelEnablement,
  RoutingPolicyStore,
  retireLegacyRoutingToml,
} from "../daemon/routing-policy-store";
import { HiveDaemon } from "../daemon/server";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
} from "../daemon/session-host/hive-terminal-host";
import { SessiondHost } from "../daemon/session-host/sessiond-host";
import { observeSessiondOutput } from "../daemon/session-host/sessiond-output-observer";
import { WorkspaceVisibilityAuthority } from "../daemon/session-host/workspace-visibility";
import { resolveSessiondBinary } from "../daemon/session-host/sessiond-broker";
import { HiveSpawner } from "../daemon/spawn/spawn-service";
import { formatDaemonStartupAnnouncement } from "../daemon/lifecycle/startup-announcement";
import {
  agentRecordStatusIncarnationGenerationSource,
  StatusService,
} from "../daemon/status-service/status-service";
import { stopSessiondAgentSession } from "../daemon/resource-management/teardown";
import { EpisodicStore } from "../memory-service/episodic";
import type { AgentRecord } from "../schemas/agent";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  forEachProvider,
} from "../schemas/capability";
import type {
  SessionLocator,
  TerminalGeometry,
} from "../schemas/session-protocol";
import { QuotaService } from "../usage-service/usage-quota";
import {
  migrateDefaultQuotaLedger,
  QuotaDatabase,
  QuotaLedger,
} from "../usage-service/quota-ledger";
import {
  ClaudeQuotaProbe,
  ClaudeStdioProbeTransport,
  CodexQuotaProbe,
  CodexStdioProbeTransport,
  GrokQuotaProbe,
  GrokStdioProbeTransport,
  KimiQuotaProbe,
} from "../usage-service/quota-sources";
import { TokenUsageStore } from "../usage-service/token-usage";
import {
  readBillingWithMemory,
  readRememberedBilling,
} from "../usage-service/usage-credits/usage-credit-memory";
import { HIVE_SOURCE_HASH } from "../shared/version";
import { composeModelControlSnapshot } from "./model-control";
import { errorMessage } from "../shared/error-message";
import { systemClock } from "../shared/clock";

export async function startBrokerAndDiscoverEngineBuildId(
  dependencies: Readonly<{
    startBroker: () => Promise<void>;
    discoverEngineBuildId: () => Promise<string>;
    onFatalFailure: (
      stage: "broker-start" | "engine-discovery",
      error: unknown,
    ) => Promise<never>;
  }>,
): Promise<string> {
  try {
    await dependencies.startBroker();
  } catch (error) {
    return await dependencies.onFatalFailure("broker-start", error);
  }
  try {
    return await dependencies.discoverEngineBuildId();
  } catch (error) {
    return await dependencies.onFatalFailure("engine-discovery", error);
  }
}

export async function exitAfterDaemonStartupFailure(
  stage: "broker-start" | "engine-discovery",
  error: unknown,
  dependencies: Readonly<{
    stopBroker: () => Promise<void>;
    stopDaemon: () => Promise<void>;
    cleanupLifecycle: () => void;
    exit: (code: number) => never;
  }>,
): Promise<never> {
  const message = errorMessage(error);
  const label =
    stage === "broker-start"
      ? "sessiond broker failed to start"
      : "sessiond engine build discovery failed";
  console.error(`${label}: ${message}`);
  try {
    await dependencies.stopBroker();
  } catch {}
  try {
    await dependencies.stopDaemon();
  } catch {
    // stop may refuse on unrelated teardown; still drop lifecycle below
  }
  try {
    dependencies.cleanupLifecycle();
  } catch {}
  return dependencies.exit(1);
}

export function stopSpawnSession(
  agent: AgentRecord,
  dependencies: Readonly<{
    terminalHost: Pick<HiveTerminalHostAdapter, "inspect" | "terminate"> &
      Partial<Pick<HiveTerminalHostAdapter, "stopProvider">>;
    providerRuns?: Pick<HiveDatabase, "getActiveProviderRunForAgent">;
  }>,
) {
  return stopSessiondAgentSession(agent, {
    terminalHost: dependencies.terminalHost,
    readHostPid: async (record) =>
      (
        await dependencies.terminalHost.inspect(
          requireSessiondAgentLocator(record),
        )
      ).hostPid,
    ...(dependencies.providerRuns === undefined
      ? {}
      : {
          readProviderRun: (record: AgentRecord) =>
            dependencies.providerRuns?.getActiveProviderRunForAgent(
              record.id,
            ) ?? null,
        }),
  });
}

/** The startup Model Control decision, and the only place that decides it. An empty store gets the provisional baseline: route candidates are EXACT model ids frozen from the vendors' live catalogs right now (an unreadable vendor is skipped, never guessed), and the seed writes no enablement state, because enablement is consent and only the user's own click can grant it. A store that is NOT empty is READ before the daemon proceeds. That read is the point: an unparseable document throws here, at boot, instead of leaving the daemon running on a policy nobody could parse until some later spawn turns it into a refusal. "I cannot read your policy" must stop Hive, and it must never be answered by seeding defaults over the user's own document. */
export async function prepareStartupRoutingPolicy(
  store: Pick<
    RoutingPolicyStore,
    "isEmpty" | "read" | "seedProvisionalBaseline"
  >,
  readVendorDefaults: () => Promise<{
    vendorDefaults: Partial<Record<CapabilityProvider, string>>;
  }>,
): Promise<void> {
  if (!store.isEmpty()) {
    store.read();
    return;
  }
  store.seedProvisionalBaseline(await readVendorDefaults());
}

export interface ProductionTerminalComposition {
  terminalHost: SessiondHost;
  spawnerDependencies: Readonly<Record<string, never>>;
  daemonDependencies: Readonly<{
    terminalHost: SessiondHost;
    sessionHost: SessiondHost;
    observeTerminalOutput: (
      locator: SessionLocator,
      geometry: TerminalGeometry,
    ) => ReturnType<typeof observeSessiondOutput>;
  }>;
}

export function createProductionTerminalComposition(
  options: ConstructorParameters<typeof SessiondHost>[0],
  construct: (
    kind: "sessiond",
    options: ConstructorParameters<typeof SessiondHost>[0],
  ) => SessiondHost = (_kind, hostOptions) => new SessiondHost(hostOptions),
): ProductionTerminalComposition {
  const terminalHost = construct("sessiond", options);
  return {
    terminalHost,
    spawnerDependencies: {},
    daemonDependencies: {
      terminalHost,
      // Supplies the queen's explicit "show me the screen" read. Without this callback, `hive_terminal_observe` must refuse the request.
      sessionHost: terminalHost,
      observeTerminalOutput: (locator, geometry) =>
        observeSessiondOutput(
          terminalHost,
          locator,
          geometry,
          "hive-daemon:activity",
        ),
    },
  };
}

/** Single source of truth for the spawner's per-vendor executable paths, so a new vendor added to `discoveryExecutables` cannot be forgotten here. */
export function spawnerExecutables(
  discoveryExecutables: Record<CapabilityProvider, string>,
): {
  claudeExecutable: string;
  codexExecutable: string;
  grokExecutable: string;
  kimiExecutable: string;
  opencodeExecutable: string;
} {
  return {
    claudeExecutable: discoveryExecutables.claude,
    codexExecutable: discoveryExecutables.codex,
    grokExecutable: discoveryExecutables.grok,
    kimiExecutable: discoveryExecutables.kimi,
    opencodeExecutable: discoveryExecutables.opencode,
  };
}

export async function runDaemon(): Promise<void> {
  // Lock first: the broker authenticates the single daemon-lock identity, so spawn under that identity only after the exclusive lock is held.
  await acquireDaemonLock();
  process.once("exit", () => releaseDaemonLock());
  // Through the identity resolver, never the raw directory: a daemon started from a subdirectory must key its state to the repository root, or it mints a second project identity one level down from the real one.
  const repoRoot = projectRootOrCwd(process.env.HIVE_PROJECT_ROOT);
  const sessiondBinary = resolveSessiondBinary({ repoRoot });
  if (sessiondBinary === null) {
    throw new Error(
      "hive-sessiond binary not found. Stage a release build (make build), " +
        "or set HIVE_SESSIOND_BIN.",
    );
  }
  // Hive launches each terminal host itself and speaks to it on its own socket. A broker would only relay every launch and inspect, imposing a shared concurrency ceiling without participating in the terminal data path.
  const config = await loadHiveConfig();
  const quotaConfig = await loadQuotaConfig();
  const claudeExecutable = resolveWorkingClaudeExecutable().path;
  const codexExecutable = resolveWorkingCodexExecutable()?.path ?? "codex";
  const grokExecutable = resolveWorkingGrokExecutable()?.path ?? "grok";
  const kimiExecutable = resolveWorkingKimiExecutable()?.path ?? "kimi";
  const opencodeExecutable =
    resolveWorkingOpencodeExecutable()?.path ?? "opencode";
  const discoveryExecutables: Record<CapabilityProvider, string> = {
    claude: claudeExecutable,
    codex: codexExecutable,
    grok: grokExecutable,
    kimi: kimiExecutable,
    opencode: opencodeExecutable,
  };
  const quotaDb = new QuotaDatabase();
  const capabilityAuthority = createCapabilitySnapshotAuthority(
    quotaDb.database,
    discoveryExecutables,
  );
  const discoverCapabilities = (provider: CapabilityProvider) =>
    capabilityAuthority.discover(provider);
  const db = new HiveDatabase();
  const status = StatusService.create(db, hiveInstanceSuffix());
  const retiredToml = retireLegacyRoutingToml(getHiveHome());
  if (retiredToml !== null) {
    console.log(
      `routing.toml is no longer read as policy; preserved at ${retiredToml}`,
    );
  }
  const policyDatabase = machineModelControlDatabase(db);
  const routingPolicy = new RoutingPolicyStore(policyDatabase.database);
  await prepareStartupRoutingPolicy(routingPolicy, () =>
    (async () => {
      const discovery = await forEachProvider(discoverCapabilities);
      const vendorDefaults: Partial<Record<CapabilityProvider, string>> = {};
      for (const provider of CAPABILITY_PROVIDERS) {
        const probed = discovery[provider];
        if (
          probed.status === "ok" &&
          probed.effectiveDefault.model.state === "known"
        ) {
          vendorDefaults[provider] = probed.effectiveDefault.model.value;
        }
      }
      return { vendorDefaults };
    })().catch(() => ({ vendorDefaults: {} })),
  );
  const quotaLedger = new QuotaLedger(quotaDb);
  migrateDefaultQuotaLedger(quotaDb);
  const quota = new QuotaService(quotaLedger, quotaConfig, systemClock, [
    new CodexQuotaProbe(
      new CodexStdioProbeTransport([codexExecutable, "app-server", "--stdio"]),
    ),
    new ClaudeQuotaProbe(
      new ClaudeStdioProbeTransport([
        claudeExecutable,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ]),
    ),
    new GrokQuotaProbe(
      new GrokStdioProbeTransport([grokExecutable, "agent", "stdio"]),
    ),
    new KimiQuotaProbe(),
  ]);
  const terminalComposition = createProductionTerminalComposition({
    repoRoot,
    pendingBindings: db,
  });
  const sessiond = terminalComposition.terminalHost;
  const workspaceVisibility = new WorkspaceVisibilityAuthority({
    expectedInstanceId: hiveInstanceSuffix(),
    observeProcess: (pid) => macProcessIdentity(pid),
    discoverEngineBuildId: () => sessiond.discoverEngineBuildId(),
  });
  const port = readConfiguredPort();
  let daemon: HiveDaemon;
  // The per-repo graphify MCP server. Constructed unconditionally — start() reads the repo's opt-in state and is a no-op for the repos that never enabled it.
  const graphify = new GraphifyService(repoRoot);
  // The per-project episodic memory store (HiveMemory HM-1). Its location is derived from the daemon's own project identity, never a caller parameter. Memory is a derived projection of the daemon's primary records, so a store that cannot open must not stop the daemon from booting.
  let episodicStore: EpisodicStore | undefined;
  try {
    episodicStore = EpisodicStore.forProjectRoot(repoRoot);
  } catch (error) {
    console.error(
      `Hive episodic store failed to open; continuing without episodic memory: ${errorMessage(
        error,
      )}`,
    );
  }
  // One token usage store serves both the daemon's own reads and the budget fence, so a fence never decides from a second, differently-collected copy of the same numbers.
  const tokenUsage = new TokenUsageStore(db);
  const modelControlRefreshIntervalMs = 5 * 60_000;
  const capabilityRefreshAttempts = new Map<CapabilityProvider, number>();
  const billingRefreshAttempts = new Map<CapabilityProvider, number>();
  const readStoredCapabilities = async (provider: CapabilityProvider) =>
    capabilityAuthority.current(provider)?.catalog ?? {
      status: "unavailable" as const,
      reason: "the daemon has not measured this provider yet",
    };
  const refreshModelControl = async (): Promise<void> => {
    const now = Date.now();
    await Promise.all([
      forEachProvider(async (provider) => {
        const attemptedAt = capabilityRefreshAttempts.get(provider) ?? 0;
        if (now - attemptedAt < modelControlRefreshIntervalMs) return;
        capabilityRefreshAttempts.set(provider, now);
        await capabilityAuthority.snapshot(provider).catch(() => undefined);
      }),
      forEachProvider(async (provider) => {
        const attemptedAt = billingRefreshAttempts.get(provider) ?? 0;
        if (now - attemptedAt < modelControlRefreshIntervalMs) return;
        billingRefreshAttempts.set(provider, now);
        await readBillingWithMemory(provider).catch(() => null);
      }),
    ]);
  };
  const spawner = new HiveSpawner({
    ...terminalComposition.spawnerDependencies,
    db,
    repoRoot,
    hierarchyAdmission: () => daemon.hierarchy.admission,
    getBoardTask: (taskId) => daemon.hierarchy.getTask(taskId),
    startBoardTask: (taskId, agentId, agentName) =>
      daemon.hierarchy.startTaskFromSpawn(taskId, agentId, agentName),
    ...spawnerExecutables(discoveryExecutables),
    // `port` is normally 0: Bun chooses the instance's ephemeral port only when the daemon starts. Every later launch must read that bound port, never preserve the pre-bind sentinel in agent hooks and MCP config.
    port: () => daemon.listeningPort ?? port,
    graphifyUrl: () => graphify.serverUrl(),
    // The layer-1 digest, built against the primary checkout's graph — that is where builds land — and hard-bounded inside.
    graphifyBrief: (task) => buildGraphBrief(repoRoot, task),
    // Only the daemon mints. The spawner asks for a credential, it never creates one, and the token is written to a 0600 file rather than handed to the agent process through its environment.
    issueCredential: (name, role, epoch) =>
      daemon.issueCredential(name, role, epoch),
    // Refuse rather than record a spawn whose Hive MCP never answers.
    mcpClientSeen: (subject, since) => daemon.mcpClientSeen(subject, since),
    quotaReady: () => daemon.quotaReady(),
    // A spawn that dies of a vendor rate limit is a drain, not a crash.
    drainError: (agent, failure) => daemon.onVendorDrainError(agent, failure),
    assignments: {
      open: (agentId, openedAt) => status.openAssignment(agentId, openedAt),
      close: (agentId, closedAt) => status.closeAssignment(agentId, closedAt),
    },
    newestAgentEventSeq: (agentId) => status.newestAgentEventSeq(agentId),
    config,
    // Every live spawn is governed by the user's routing policy: the spawn's category resolves to the user-authored route, every candidate passes the launch gate, and a corrupt or absent policy refuses rather than routes.
    readRoutingPolicy: () => routingPolicy.read(),
    discoverCapabilities,
    // THE JOIN: the AuthorizedLaunch gate's enablement guard reads the policy store — an enabled row is the user's consent, anything else refuses.
    isModelEnabled: policyModelEnablement(routingPolicy),
    readBilling: (provider) => readBillingWithMemory(provider),
    stopSession: (agent) =>
      stopSpawnSession(agent, {
        terminalHost: daemon.sessiondTerminalHost,
        providerRuns: db,
      }),
    quota,
    sessiond: {
      get terminalHost() {
        return daemon.sessiondTerminalHost;
      },
      prepareAgentCreation: () => daemon.prepareAgentSessiondSpawn(),
      admit: (candidate) => daemon.admitSessiondSpawn(candidate),
    },
    settlement: {
      open: (agent, worktree, baseOid) =>
        daemon.openWorktreeSettlementCase(agent, worktree, baseOid),
      settleFailed: (agent, worktree, keepOnFailure) =>
        daemon.settleFailedSpawnWorktree(agent, worktree, keepOnFailure),
    },
  });
  daemon = new HiveDaemon({
    ...terminalComposition.daemonDependencies,
    // Resolve an exact terminal generation for `hive_terminal_observe`. The tool refuses anything that is not an exact match, so this returns the locator only when BOTH the session id and the generation agree — a reader must never be handed a newer incarnation's screen while believing it asked about the one it named.
    resolveSessionLocator: async (sessionId, generation) => {
      for (const agent of db.listAgents()) {
        const locator = agent.sessionLocator;
        if (
          locator != null &&
          locator.sessionId === sessionId &&
          locator.generation === generation
        ) {
          return locator;
        }
      }
      return (
        db
          .listTerminalHostBindings(hiveInstanceSuffix())
          .map((binding) => binding.locator)
          .find(
            (locator) =>
              locator.sessionId === sessionId &&
              locator.generation === generation,
          ) ?? null
      );
    },
    statusIncarnationGenerationSource:
      agentRecordStatusIncarnationGenerationSource((agentId) =>
        db.getAgentById(agentId),
      ),
    db,
    tokenUsage,
    spawner,
    statusService: status,
    workspaceVisibility,
    repoRoot,
    graphify,
    episodicStore,
    port,
    manageLifecycle: true,
    quota,
    modelControlSnapshot: () =>
      composeModelControlSnapshot({
        discover: readStoredCapabilities,
        readBilling: readRememberedBilling,
        readQuota: async () => quota.statuses(),
        readTokenUsage: () => tokenUsage.snapshot(repoRoot),
      }),
    refreshModelControl,
    modelInventory: () =>
      readModelInventory({
        discover: discoverCapabilities,
        readPolicy: () => routingPolicy.read(),
      }),
    resources: config.resources,
    retention: config.memory.retention,
    artifacts: config.artifacts,
    wakeBudgetTokens: config.memory.wake_budget_tokens,
    memoryEmbeddings: {
      provider: config.memory.embedding_provider,
      model: config.memory.embedding_model,
    },
    // One source of truth for autonomy: this very `config` object, which the spawner also reads at each spawn. Persist first, mutate second — if the disk write fails, the live value never diverges from the file.
    autonomy: {
      get: () => config.autonomy,
      set: async (value) => {
        await persistAutonomy(value);
        config.autonomy = value;
      },
    },
  });
  daemon.start();
  // Daemon must be on a port (and daemon.port written) before HELLO can auth. That write must not become advertise-then-fail: any broker start failure tears the daemon down and removes lifecycle files before a non-zero exit.
  for (let i = 0; i < 100 && daemon.listeningPort === null; i += 1) {
    await Bun.sleep(20);
  }
  if (daemon.listeningPort === null) {
    try {
      await daemon.stop();
    } catch {}
    try {
      cleanupLifecycleFiles();
    } catch {}
    throw new Error(
      "daemon failed to bind a listening port before sessiond broker start",
    );
  }
  const engineBuildId = await startBrokerAndDiscoverEngineBuildId({
    startBroker: async () => {},
    discoverEngineBuildId: () => sessiond.discoverEngineBuildId(),
    onFatalFailure: (stage, error) =>
      exitAfterDaemonStartupFailure(stage, error, {
        stopBroker: async () => {},
        stopDaemon: () => daemon.stop(),
        cleanupLifecycle: cleanupLifecycleFiles,
        // Non-zero exit with nothing advertised — do not leave Bun.serve half-alive.
        exit: (code) => process.exit(code),
      }),
  });
  console.log(
    formatDaemonStartupAnnouncement({
      engineBuildId,
      binaryPath: resolve(process.execPath),
      sourceHash: HIVE_SOURCE_HASH ?? (await currentBuildHash()),
    }),
  );
  const migrationAnnouncement = join(
    getHiveHome(),
    HOME_MIGRATION_ANNOUNCEMENT,
  );
  try {
    const migration = JSON.parse(
      readFileSync(migrationAnnouncement, "utf8"),
    ) as {
      from?: unknown;
      to?: unknown;
    };
    if (
      typeof migration.from === "string" &&
      typeof migration.to === "string"
    ) {
      console.log(
        `Hive migrated its home from ${migration.from} to ${migration.to}.`,
      );
      rmSync(migrationAnnouncement, { force: true });
    }
  } catch {}

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    const hardStop = setTimeout(() => {
      process.kill(process.pid, "SIGKILL");
    }, 30_000);
    let exitCode = 0;
    try {
      await daemon.stop();
    } catch (error) {
      exitCode = 1;
      console.error(
        `Hive daemon cleanup failed before exit: ${errorMessage(error)}`,
      );
    } finally {
      // stop() owns the supervisor when wired; belt-and-braces if construction failed after start or stop threw before the broker field was torn down.
      clearTimeout(hardStop);
    }
    quotaDb.close();
    if (policyDatabase.opened) policyDatabase.database.close();
    db.close();
    process.exit(exitCode);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
