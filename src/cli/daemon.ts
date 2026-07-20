import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { loadHiveConfig, loadQuotaConfig } from "../config/load";
import { HiveDatabase } from "../daemon/db";
import {
  policyModelEnablement,
  retireLegacyRoutingToml,
  RoutingPolicyStore,
} from "../daemon/routing-policy-store";
import { BunTmuxSender } from "../daemon/delivery";
import { TmuxSessionHost } from "../daemon/session-host/tmux-host";
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
  type CapabilityProvider,
} from "../schemas";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
  GrokCapabilityProbe,
} from "../daemon/capability-discovery";
import { readBillingWithMemory } from "../daemon/usage-credits";
import { persistAutonomy } from "../config/autonomy";
import { readModelInventory } from "../daemon/model-inventory";
import { stopAgentSession } from "../daemon/teardown";
import {
  inheritDefaultModelControlSettings,
  inheritOrdinaryWorkspaceSelection,
} from "../daemon/instance-settings";
import { ORDINARY_WORKSPACE_RUNTIME } from "../daemon/instances";
import { hiveInstanceSuffix } from "../daemon/tmux-sessions";
import { SelectionPreferenceStore } from "../daemon/selection-preferences";
import { SessiondHost } from "../daemon/session-host/sessiond-host";
import { WorkspaceVisibilityAuthority } from "../daemon/session-host/workspace-visibility";
import { getHiveHome } from "../daemon/db";

export async function runDaemon(): Promise<void> {
  // Lock first: the broker authenticates the single daemon-lock identity, so
  // spawn under that identity only after the exclusive lock is held.
  await acquireDaemonLock();
  process.once("exit", () => releaseDaemonLock());
  const repoRoot = process.env.HIVE_PROJECT_ROOT ?? process.cwd();
  const sessiondBinary = resolveSessiondBinary({ repoRoot });
  if (sessiondBinary === null) {
    throw new Error(
      "hive-sessiond binary not found. Stage a release build (make build) or " +
        "build the ReleaseFast proof binary (make native), or set HIVE_SESSIOND_BIN.",
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
      const discovery = await forEachProvider(async (provider) => {
        switch (provider) {
          case "claude":
            return await new ClaudeCapabilityProbe().read();
          case "codex":
            return await new CodexCapabilityProbe().read();
          case "grok":
            return await new GrokCapabilityProbe().read();
          default:
            return unknownVendor(provider, "policy baseline seeding");
        }
      });
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
      new CodexQuotaProbe(new CodexStdioProbeTransport()),
      new ClaudeQuotaProbe(new ClaudeStdioProbeTransport()),
      new GrokQuotaProbe(new GrokStdioProbeTransport()),
    ],
  );
  const sessions = new TmuxSessionHost();
  const sessiond = new SessiondHost({ repoRoot, pendingBindings: db });
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
  const spawner = new HiveSpawner({
    db,
    repoRoot,
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
    discoverCapabilities: async (provider) => {
      switch (provider) {
        case "claude":
          return await new ClaudeCapabilityProbe().read();
        case "codex":
          return await new CodexCapabilityProbe().read();
        case "grok":
          return await new GrokCapabilityProbe().read();
        default:
          return unknownVendor(provider, "capability discovery");
      }
    },
    // THE JOIN: the AuthorizedLaunch gate's enablement guard reads the policy
    // store — an enabled row is the user's consent, anything else refuses.
    isModelEnabled: policyModelEnablement(routingPolicy),
    // The release valve reads the provider's own metering, not a model name.
    readBilling: (provider) => readBillingWithMemory(provider),
    tmux: sessions,
    stopSession: (agent) => stopAgentSession(agent, { sessions }),
    // Even when quota-aware routing is disabled, critical read-only restarts
    // require a durable accounting lifecycle.
    quota,
    codexAppServer,
    sessiond: {
      get terminalHost() { return daemon.sessiondTerminalHost; },
      prepare: () => daemon.prepareSessiondSpawn(),
      admit: (candidate) => daemon.admitSessiondSpawn(candidate),
    },
  });
  // Not a hand-rolled lambda. The previous one was `(session, text) =>
  // the legacy sender could not forward the delivery options, so urgent input
  // `options` argument delivery passes it — and because `options` is optional
  // on TmuxSender, a two-parameter function satisfies the interface and
  // typechecks clean. So every message the real daemon ever sent went out with
  // interrupt dropped: "urgent interrupts at the next safe boundary" was a
  // label on a database row, never a behaviour, in production only. Tests
  // missed it because they use BunTmuxSender, which does forward.
  const tmuxSender = new BunTmuxSender(sessions);
  daemon = new HiveDaemon({
    statusIncarnationGenerationSource:
      agentRecordStatusIncarnationGenerationSource((agentId) =>
        db.getAgentById(agentId)
      ),
    db,
    spawner,
    statusStore,
    tmuxSender,
    tmux: sessions,
    terminalHost: sessiond,
    workspaceVisibility,
    repoRoot,
    graphify,
    port,
    manageLifecycle: true,
    sessiondBroker,
    quota,
    modelInventory: () =>
      readModelInventory({ readPolicy: () => routingPolicy.read() }),
    codexControl: codexAppServer,
    resources: config.resources,
    lifecycle: config.lifecycle,
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
  try {
    await sessiondBroker.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sessiond broker failed to start: ${message}`);
    try {
      await sessiondBroker.stop();
    } catch {
      // ignore
    }
    try {
      await daemon.stop();
    } catch {
      // stop may refuse on unrelated teardown; still drop lifecycle below
    }
    try {
      cleanupLifecycleFiles();
    } catch {
      // stop() with manageLifecycle already cleaned; belt-and-braces
    }
    // Non-zero exit with nothing advertised — do not leave Bun.serve half-alive.
    process.exit(1);
  }

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
