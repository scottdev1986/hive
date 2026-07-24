import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { resolveWorkingClaudeExecutable } from "../adapters/tools/claude";
import { resolveWorkingCodexExecutable } from "../adapters/tools/codex";
import { resolveWorkingGrokExecutable } from "../adapters/tools/grok";
import { loadHiveConfig, loadQuotaConfig } from "../config/load";
import { HiveDatabase } from "../daemon/db";
import {
  policyModelEnablement,
  retireLegacyRoutingToml,
  RoutingPolicyStore,
} from "../daemon/routing-policy-store";
import type { TmuxSessionHost } from "../daemon/session-host/tmux-host";
import { buildGraphBrief } from "../adapters/graphify";
import { GraphifyService } from "../daemon/graphify-service";
import {
  acquireDaemonLock,
  cleanupLifecycleFiles,
  macProcessIdentity,
  readConfiguredPort,
  releaseDaemonLock,
} from "../daemon/lifecycle";
import { HiveDaemon } from "../daemon/server";
import { EpisodicStore } from "../daemon/episodic-store";
import { readWikiLog } from "../daemon/memory-delta";
import {
  resolveSessiondBinary,
  SessiondBrokerSupervisor,
} from "../daemon/sessiond-broker";
import { HiveSpawner } from "../daemon/spawner-impl";
import { StatusStore } from "../daemon/status-store";
import { agentRecordStatusIncarnationGenerationSource } from "../daemon/status-generation";
import {
  migrateDefaultQuotaLedger,
  QuotaDatabase,
  QuotaLedger,
} from "../daemon/quota-ledger";
import { QuotaService } from "../daemon/quota";
import {
  ClaudeQuotaProbe,
  ClaudeStdioProbeTransport,
  CodexQuotaProbe,
  CodexStdioProbeTransport,
  GrokQuotaProbe,
  GrokStdioProbeTransport,
} from "../daemon/quota-sources";
import {
  CAPABILITY_PROVIDERS,
  forEachProvider,
  unknownVendor,
  type AgentRecord,
  type CapabilityProvider,
} from "../schemas";
import {
  ClaudeCapabilityProbe,
  ClaudeStdioCapabilityTransport,
  CodexCapabilityProbe,
  CodexStdioCapabilityTransport,
  GrokCapabilityProbe,
  GrokCliCapabilityTransport,
} from "../daemon/capability-discovery";
import { readBillingWithMemory } from "../daemon/usage-credits";
import { persistAutonomy } from "../config/autonomy";
import { readModelInventory } from "../daemon/model-inventory";
import {
  stopAgentSession,
  stopSessiondAgentSession,
} from "../daemon/teardown";
import {
  inheritDefaultModelControlSettings,
  inheritOrdinaryWorkspaceSelection,
} from "../daemon/instance-settings";
import { ORDINARY_WORKSPACE_RUNTIME } from "../daemon/instances";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import { SelectionPreferenceStore } from "../daemon/selection-preferences";
import { SessiondHost } from "../daemon/session-host/sessiond-host";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
} from "../daemon/session-host/hive-terminal-host";
import { WorkspaceVisibilityAuthority } from "../daemon/session-host/workspace-visibility";
import { getHiveHome } from "../daemon/db";
import { formatDaemonStartupAnnouncement } from "../daemon/startup-announcement";
import { currentBuildHash } from "../daemon/handshake";
import { HIVE_SOURCE_HASH } from "../version";

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
  const message = error instanceof Error ? error.message : String(error);
  const label = stage === "broker-start"
    ? "sessiond broker failed to start"
    : "sessiond engine build discovery failed";
  console.error(`${label}: ${message}`);
  try {
    await dependencies.stopBroker();
  } catch {
    // ignore
  }
  try {
    await dependencies.stopDaemon();
  } catch {
    // stop may refuse on unrelated teardown; still drop lifecycle below
  }
  try {
    dependencies.cleanupLifecycle();
  } catch {
    // stop() with manageLifecycle already cleaned; belt-and-braces
  }
  return dependencies.exit(1);
}

export function stopSpawnSession(
  agent: AgentRecord,
  dependencies: Readonly<{
    sessions?: TmuxSessionHost;
    terminalHost: Pick<HiveTerminalHostAdapter, "inspect" | "terminate">;
  }>,
) {
  if (agent.sessionLocator?.hostKind !== "sessiond") {
    if (dependencies.sessions === undefined) {
      throw new Error(
        `Agent ${agent.id} has a legacy tmux locator, but production is sessiond-only`,
      );
    }
    return stopAgentSession(agent, { sessions: dependencies.sessions });
  }
  return stopSessiondAgentSession(agent, {
    terminalHost: dependencies.terminalHost,
    readHostPid: async (record) =>
      (await dependencies.terminalHost.inspect(
        requireSessiondAgentLocator(record),
      )).hostPid,
  });
}

export interface ProductionTerminalComposition {
  terminalHost: SessiondHost;
  spawnerDependencies: Readonly<Record<never, never>>;
  daemonDependencies: Readonly<{ terminalHost: SessiondHost }>;
}

/** The production terminal composition has one constructor call and one host.
 * Legacy tmux implementations remain importable by explicit tests until #1/#2,
 * but are not members of this graph. */
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
    daemonDependencies: { terminalHost },
  };
}

export async function runDaemon(): Promise<void> {
  // Lock first: the broker authenticates the single daemon-lock identity, so
  // spawn under that identity only after the exclusive lock is held.
  await acquireDaemonLock();
  process.once("exit", () => releaseDaemonLock());
  const repoRoot = process.env.HIVE_PROJECT_ROOT ?? process.cwd();
  const sessiondBinary = resolveSessiondBinary({ repoRoot });
  if (sessiondBinary === null) {
    throw new Error(
      "hive-sessiond binary not found. Stage a release build (make build), " +
        "or set HIVE_SESSIOND_BIN.",
    );
  }
  // Construct the supervisor now; start() only after the daemon is listening.
  // Ready-proof connects to broker.sock, checks LOCAL_PEERPID, and completes
  // HELLO — which loads daemon.lock + GET /handshake from daemon.port.
  const sessiondBroker = new SessiondBrokerSupervisor({
    binary: sessiondBinary,
    hiveHome: getHiveHome(),
    repoRoot,
    onFatal: (error) => {
      console.error(`sessiond broker supervision failed fatally: ${error.message}`);
    },
  });
  const config = await loadHiveConfig();
  const quotaConfig = await loadQuotaConfig();
  const claudeExecutable = resolveWorkingClaudeExecutable().path;
  const codexExecutable = resolveWorkingCodexExecutable()?.path ?? "codex";
  const grokExecutable = resolveWorkingGrokExecutable()?.path ?? "grok";
  const discoverCapabilities = async (
    provider: CapabilityProvider,
  ) => {
    switch (provider) {
      case "claude":
        return await new ClaudeCapabilityProbe(
          new ClaudeStdioCapabilityTransport(
            [
              claudeExecutable,
              "-p",
              "--input-format",
              "stream-json",
              "--output-format",
              "stream-json",
              "--verbose",
            ],
            [claudeExecutable],
          ),
        ).read();
      case "codex":
        return await new CodexCapabilityProbe(
          new CodexStdioCapabilityTransport(
            [codexExecutable, "app-server", "--stdio"],
            [codexExecutable],
          ),
        ).read();
      case "grok":
        return await new GrokCapabilityProbe(
          new GrokCliCapabilityTransport(grokExecutable),
        ).read();
      default:
        return unknownVendor(provider, "capability discovery");
    }
  };
  const db = new HiveDatabase();
  const statusStore = new StatusStore(db, hiveInstanceSuffix());
  // routing.toml is dead as a policy source (user directive 2026-07-12); the
  // file is renamed aside, never deleted and never interpreted.
  const retiredToml = retireLegacyRoutingToml(
    Bun.env.HIVE_HOME ?? join(homedir(), ".hive"),
  );
  if (retiredToml !== null) {
    console.log(`routing.toml is no longer read as policy; preserved at ${retiredToml}`);
  }
  // First boot only: seed the provisional baseline. Chain entries are EXACT
  // model ids frozen from the vendors' live catalogs right now (an unreadable
  // vendor is skipped, never guessed), but the seed writes no enablement state.
  // Enablement is consent, and only the user's own click can grant it.
  const routingPolicy = new RoutingPolicyStore(db);
  inheritDefaultModelControlSettings(routingPolicy);
  if (routingPolicy.isEmpty()) {
    const facts = await (async () => {
      const discovery = await forEachProvider(discoverCapabilities);
      const vendorDefaults: Partial<Record<CapabilityProvider, string>> = {};
      for (const provider of CAPABILITY_PROVIDERS) {
        const probed = discovery[provider];
        if (probed.status === "ok" && probed.effectiveDefault.model.state === "known") {
          vendorDefaults[provider] = probed.effectiveDefault.model.value;
        }
      }
      return { vendorDefaults };
    })().catch(() => ({ vendorDefaults: {} }));
    routingPolicy.seedProvisionalBaseline(facts);
  }
  const ordinarySelection = process.env[ORDINARY_WORKSPACE_RUNTIME] === "1"
    ? new SelectionPreferenceStore()
    : undefined;
  inheritOrdinaryWorkspaceSelection(routingPolicy, {
    ...(ordinarySelection === undefined ? {} : { preferences: ordinarySelection }),
  });
  // Live limits come from the providers themselves. All three probes are
  // read-only and start no model turn, so a startup refresh costs nothing but
  // a subprocess.
  const quotaDb = new QuotaDatabase();
  const quotaLedger = new QuotaLedger(quotaDb);
  migrateDefaultQuotaLedger(quotaDb);
  const quota = new QuotaService(
    quotaLedger,
    quotaConfig,
    () => new Date(),
    [
      new CodexQuotaProbe(new CodexStdioProbeTransport([
        codexExecutable,
        "app-server",
        "--stdio",
      ])),
      new ClaudeQuotaProbe(new ClaudeStdioProbeTransport([
        claudeExecutable,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ])),
      new GrokQuotaProbe(new GrokStdioProbeTransport([
        grokExecutable,
        "agent",
        "stdio",
      ])),
    ],
  );
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
  const codexAppServer = new CodexAppServerManager({
    onEvent: (event) => daemon.processEvent(event),
    queueApproval: ({ agentName, description }) =>
      daemon.queueCodexApproval(agentName, description),
    observeRateLimits: (model, response, observedAt) =>
      quota.observeCodexRateLimits(model, response, observedAt),
  });
  // The per-repo graphify MCP server (docs/graphify/integration.md).
  // Constructed unconditionally — start() reads the repo's opt-in state and is
  // a no-op for the repos that never enabled it.
  const graphify = new GraphifyService(repoRoot);
  // The per-project episodic memory store (HiveMemory HM-1). Its location is
  // derived from the daemon's own project identity, never a caller parameter.
  // Memory is a derived projection of the daemon's primary records, so a
  // store that cannot open must not stop the daemon from booting.
  let episodicStore: EpisodicStore | undefined;
  try {
    episodicStore = EpisodicStore.forProjectRoot(repoRoot);
  } catch (error) {
    console.error(
      `Hive episodic store failed to open; continuing without episodic memory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const spawner = new HiveSpawner({
    ...terminalComposition.spawnerDependencies,
    db,
    repoRoot,
    claudeExecutable,
    codexExecutable,
    grokExecutable,
    // `port` is normally 0: Bun chooses the instance's ephemeral port only
    // when the daemon starts. Every later launch must read that bound port,
    // never preserve the pre-bind sentinel in agent hooks and MCP config.
    port: () => daemon.listeningPort ?? port,
    // Synchronous read of the live server; null attaches nothing and costs
    // the spawn nothing.
    graphifyUrl: () => graphify.serverUrl(),
    // The layer-1 digest, built against the primary checkout's graph — that
    // is where builds land — and hard-bounded inside.
    graphifyBrief: (task) => buildGraphBrief(repoRoot, task),
    // Only the daemon mints. The spawner asks for a credential, it never
    // creates one, and the token is written to a 0600 file rather than handed
    // to the agent process through its environment.
    issueCredential: (name, role, epoch) =>
      daemon.issueCredential(name, role, epoch),
    assignments: {
      open: (agentId, openedAt) => statusStore.openAssignment(agentId, openedAt),
      close: (agentId, closedAt) => statusStore.closeAssignment(agentId, closedAt),
    },
    config,
    // Every live spawn is governed by the user's routing policy: the spawn's
    // category resolves to the user-authored chain, every link passes the
    // launch gate, and a corrupt or absent policy refuses rather than routes.
    readRoutingPolicy: () => routingPolicy.read(),
    discoverCapabilities,
    // THE JOIN: the AuthorizedLaunch gate's enablement guard reads the policy
    // store — an enabled row is the user's consent, anything else refuses.
    isModelEnabled: policyModelEnablement(routingPolicy),
    // The release valve reads the provider's own metering, not a model name.
    readBilling: (provider) => readBillingWithMemory(provider),
    stopSession: (agent) => stopSpawnSession(agent, {
      terminalHost: daemon.sessiondTerminalHost,
    }),
    // Even when quota-aware routing is disabled, critical read-only restarts
    // require a durable accounting lifecycle.
    quota,
    codexAppServer,
    sessiond: {
      get terminalHost() { return daemon.sessiondTerminalHost; },
      prepareAgentCreation: () => daemon.prepareAgentSessiondSpawn(),
      admit: (candidate) => daemon.admitSessiondSpawn(candidate),
    },
    // HiveMemory HM-3 WP6: baseline the agent's wake-delta high-water mark
    // at the memory state its spawn index just showed, so the first wake
    // delta covers only post-spawn changes.
    seedMemoryHighWater: async (agentName) => {
      if (episodicStore === undefined) return;
      const { totals } = await readWikiLog(repoRoot);
      episodicStore.advanceMemoryHighWater(agentName, totals);
    },
  });
  daemon = new HiveDaemon({
    ...terminalComposition.daemonDependencies,
    statusIncarnationGenerationSource:
      agentRecordStatusIncarnationGenerationSource((agentId) =>
        db.getAgentById(agentId)
      ),
    db,
    spawner,
    statusStore,
    workspaceVisibility,
    repoRoot,
    graphify,
    episodicStore,
    port,
    manageLifecycle: true,
    sessiondBroker,
    quota,
    modelInventory: () =>
      readModelInventory({
        discover: discoverCapabilities,
        readPolicy: () => routingPolicy.read(),
      }),
    codexControl: codexAppServer,
    resources: config.resources,
    lifecycle: config.lifecycle,
    retention: config.memory.retention,
    wakeBudgetTokens: config.memory.wake_budget_tokens,
    memoryEmbeddings: {
      provider: config.memory.embedding_provider,
      model: config.memory.embedding_model,
    },
    recovery: {
      claudeExecutable,
      codexExecutable,
      grokExecutable,
    },
    // One source of truth for autonomy: this very `config` object, which the
    // spawner also reads at each spawn. Persist first, mutate second — if the
    // disk write fails, the live value never diverges from the file.
    autonomy: {
      get: () => config.autonomy,
      set: async (value) => {
        await persistAutonomy(value);
        config.autonomy = value;
      },
    },
    ...(ordinarySelection === undefined
      ? {}
      : { selectionPreferences: ordinarySelection }),
  });
  daemon.start();
  // Daemon must be on a port (and daemon.port written) before HELLO can auth.
  // That write must not become advertise-then-fail: any broker start failure
  // tears the daemon down and removes lifecycle files before a non-zero exit.
  for (let i = 0; i < 100 && daemon.listeningPort === null; i += 1) {
    await Bun.sleep(20);
  }
  if (daemon.listeningPort === null) {
    try {
      await daemon.stop();
    } catch {
      // ignore
    }
    try {
      cleanupLifecycleFiles();
    } catch {
      // ignore
    }
    throw new Error("daemon failed to bind a listening port before sessiond broker start");
  }
  const engineBuildId = await startBrokerAndDiscoverEngineBuildId({
    startBroker: () => sessiondBroker.start(),
    discoverEngineBuildId: () => sessiond.discoverEngineBuildId(),
    onFatalFailure: (stage, error) =>
      exitAfterDaemonStartupFailure(stage, error, {
        stopBroker: () => sessiondBroker.stop(),
        stopDaemon: () => daemon.stop(),
        cleanupLifecycle: cleanupLifecycleFiles,
        // Non-zero exit with nothing advertised — do not leave Bun.serve half-alive.
        exit: (code) => process.exit(code),
      }),
  });
  console.log(formatDaemonStartupAnnouncement({
    engineBuildId,
    binaryPath: resolve(process.execPath),
    sourceHash: HIVE_SOURCE_HASH ?? await currentBuildHash(),
  }));

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await daemon.stop();
    } finally {
      // stop() owns the supervisor when wired; belt-and-braces if construction
      // failed after start or stop threw before the broker field was torn down.
      await sessiondBroker.stop();
    }
    quotaDb.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
