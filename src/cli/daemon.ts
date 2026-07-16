import { homedir } from "node:os";
import { join } from "node:path";
import { TmuxAdapter } from "../adapters/tmux";
import { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { loadHiveConfig, loadQuotaConfig } from "../config/load";
import { agentStateCas, HiveDatabase } from "../daemon/db";
import {
  policyModelEnablement,
  retireLegacyRoutingToml,
  RoutingPolicyStore,
} from "../daemon/routing-policy-store";
import { BunTmuxSender } from "../daemon/delivery";
import { buildGraphBrief } from "../adapters/graphify";
import { GraphifyService } from "../daemon/graphify-service";
import {
  acquireDaemonLock,
  readConfiguredPort,
  releaseDaemonLock,
} from "../daemon/lifecycle";
import { HiveDaemon } from "../daemon/server";
import { HiveSpawner } from "../daemon/spawner-impl";
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
import { verifiedAgentStop } from "../daemon/teardown";
import {
  inheritDefaultModelControlSettings,
  inheritOrdinaryWorkspaceSelection,
} from "../daemon/instance-settings";
import { ORDINARY_WORKSPACE_RUNTIME } from "../daemon/instances";
import { SelectionPreferenceStore } from "../daemon/selection-preferences";

export async function runDaemon(): Promise<void> {
  await acquireDaemonLock();
  process.once("exit", () => releaseDaemonLock());
  const repoRoot = process.env.HIVE_PROJECT_ROOT ?? process.cwd();
  const config = await loadHiveConfig();
  const quotaConfig = await loadQuotaConfig();
  const db = new HiveDatabase();
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
  const tmux = new TmuxAdapter();
  const port = readConfiguredPort();
  let daemon: HiveDaemon;
  const codexAppServer = new CodexAppServerManager({
    onEvent: (event, holder) => daemon.processEvent(event, {
      agentId: holder.id,
      processIncarnation: agentStateCas(holder).processIncarnation,
      capabilityEpoch: holder.capabilityEpoch,
    }).then(() => undefined),
    queueApproval: ({ agentName, description }) =>
      daemon.queueCodexApproval(agentName, description),
    denyApproval: async (id) => daemon.denyCodexApproval(id),
    // The writer mutation gate. It is deliberately keyed on the exact agent id
    // and holder snapshot rather than the agent name: a name is reusable, and a
    // replacement answering to the same name must never inherit the authority
    // of the session that asked.
    authorizeMutation: (request) => daemon.authorizeCodexMutation(request),
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
    // Only the daemon mints. The grant is bound to the exact durable process
    // holder; provider launchers read its 0600 file into a scoped environment,
    // so the bearer is never an argv value but is visible to that process tree.
    issueCredential: (agent, role) =>
      daemon.issueAgentCredential(agent, role),
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
    tmux,
    stopSession: verifiedAgentStop(tmux),
    // Even when quota-aware routing is disabled, critical read-only restarts
    // require a durable accounting lifecycle.
    quota,
    codexAppServer,
  });
  // Not a hand-rolled lambda. The previous one was `(session, text) =>
  // tmux.sendKeys(session, text)`, which structurally cannot forward the
  // `options` argument delivery passes it — and because `options` is optional
  // on TmuxSender, a two-parameter function satisfies the interface and
  // typechecks clean. So every message the real daemon ever sent went out with
  // interrupt dropped: "urgent interrupts at the next safe boundary" was a
  // label on a database row, never a behaviour, in production only. Tests
  // missed it because they use BunTmuxSender, which does forward.
  const tmuxSender = new BunTmuxSender(tmux);
  daemon = new HiveDaemon({
    db,
    spawner,
    tmuxSender,
    tmux,
    repoRoot,
    graphify,
    port,
    manageLifecycle: true,
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

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await daemon.stop();
    quotaDb.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
