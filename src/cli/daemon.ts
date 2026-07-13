import { homedir } from "node:os";
import { join } from "node:path";
import { TmuxAdapter } from "../adapters/tmux";
import { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { resolveTerminal } from "../adapters/terminal";
import {
  loadHiveConfig,
  loadQuotaConfig,
  loadRoutingPins,
} from "../config/load";
import { HiveDatabase } from "../daemon/db";
import {
  policyModelEnablement,
  retireLegacyRoutingToml,
  RoutingPolicyStore,
} from "../daemon/routing-policy-store";
import { BunTmuxSender } from "../daemon/delivery";
import { buildGraphBrief } from "../adapters/graphify";
import { GraphifyService } from "../daemon/graphify-service";
import { TerminalLayoutManager } from "../daemon/layout";
import { readConfiguredPort } from "../daemon/lifecycle";
import { HiveDaemon } from "../daemon/server";
import { HiveSpawner } from "../daemon/spawner-impl";
import { QuotaLedger } from "../daemon/quota-ledger";
import { WorkspacePresence } from "../daemon/workspace-presence";
import { QuotaService } from "../daemon/quota";
import {
  ClaudeQuotaProbe,
  ClaudeStdioProbeTransport,
  CodexQuotaProbe,
  CodexStdioProbeTransport,
} from "../daemon/quota-sources";
import {
  CAPABILITY_PROVIDERS,
  forEachProvider,
  ORCHESTRATOR_NAME,
  unknownVendor,
  type CapabilityProvider,
} from "../schemas";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
  GrokCapabilityProbe,
} from "../daemon/capability-discovery";
import { resolveGoverningRoute } from "../daemon/routing-resolve";
import { readBillingWithMemory } from "../daemon/usage-credits";
import { persistAutonomy } from "../config/autonomy";
import { readCostConsent } from "../daemon/cost-consent";
import { readModelInventory } from "../daemon/model-inventory";

export async function runDaemon(): Promise<void> {
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
  // vendor is skipped, never guessed), and the seed enables ONLY the models
  // whose billing was actually READ as plan-covered. Enablement is consent
  // now, so a failed read seeds with nothing enabled — visible in the Control
  // Center, off until the user's own click.
  const routingPolicy = new RoutingPolicyStore(db);
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
      const inventory = await readModelInventory({
        discover: async (provider) => discovery[provider],
      });
      const vendorDefaults: Partial<Record<CapabilityProvider, string>> = {};
      for (const provider of CAPABILITY_PROVIDERS) {
        const probed = discovery[provider];
        if (probed.status === "ok" && probed.effectiveDefault.model.state === "known") {
          vendorDefaults[provider] = probed.effectiveDefault.model.value;
        }
      }
      return {
        coveredModels: inventory.models
          .filter((model) => model.plan.status === "covered")
          .map((model) => ({ provider: model.vendor, model: model.canonicalId })),
        vendorDefaults,
      };
    })().catch(() => ({ coveredModels: [], vendorDefaults: {} }));
    routingPolicy.seedProvisionalBaseline(facts);
  }
  // Live limits come from the providers themselves. Both probes are read-only
  // and start no model turn, so a startup refresh costs nothing but a subprocess.
  const quota = new QuotaService(
    new QuotaLedger(db),
    quotaConfig,
    () => new Date(),
    [
      new CodexQuotaProbe(new CodexStdioProbeTransport()),
      new ClaudeQuotaProbe(new ClaudeStdioProbeTransport()),
    ],
  );
  const tmux = new TmuxAdapter();
  const terminal = resolveTerminal(config);
  const port = readConfiguredPort();
  let daemon: HiveDaemon;
  const reportTerminalError = (message: string): void => {
    console.error(message);
    // The detached daemon has no visible stderr. Put terminal failures on the
    // durable orchestrator path so geometry cannot fail silently.
    void daemon?.delivery.send("hive-terminal", ORCHESTRATOR_NAME, message, {
      idempotencyKey: `terminal-error:${Bun.hash(message)}`,
    }).catch(() => undefined);
  };
  // While the Workspace app holds the viewer lease its panes are the viewers:
  // no external windows are opened and the window wall stays still. The lease
  // is TTL-based, so a crashed app reverts the daemon to external viewers.
  const workspacePresence = new WorkspacePresence();
  const layout = new TerminalLayoutManager({
    db,
    enabled: config.layout === "auto" && !config.headless,
    suppressed: () => workspacePresence.isPresent(),
    logError: reportTerminalError,
  });
  const codexAppServer = new CodexAppServerManager({
    onEvent: (event) => daemon.processEvent(event),
    queueApproval: ({ agentName, description }) =>
      daemon.queueCodexApproval(agentName, description),
    observeRateLimits: (model, response, observedAt) =>
      quota.observeCodexRateLimits(model, response, observedAt),
  });
  // The per-repo graphify MCP server (docs/architecture/graphify-integration.md).
  // Constructed unconditionally — start() reads the repo's opt-in state and is
  // a no-op for the repos that never enabled it.
  const graphify = new GraphifyService(repoRoot);
  const spawner = new HiveSpawner({
    db,
    repoRoot,
    port,
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
    config,
    // Every live spawn is governed by the derivation engine: live discovery +
    // the user's pins + the last-known-good derivation. No static `routing`
    // table is wired — the binary ships no model knowledge, and a cell nothing
    // can author refuses the spawn with its reason.
    governingRoute: (tier, io) => resolveGoverningRoute(tier, io),
    routingPins: loadRoutingPins,
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
    terminal,
    workspacePresent: () => workspacePresence.isPresent(),
    onTerminalsChanged: () => layout.requestLayout(),
    onTerminalError: reportTerminalError,
    channelsEnabled: config.channels === "auto",
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
    // Crash-recovered agents get their viewers reopened unless headless.
    ...(config.headless ? {} : { terminal }),
    repoRoot,
    graphify,
    port,
    manageLifecycle: true,
    layout,
    workspacePresence,
    quota,
    modelInventory: () =>
      readModelInventory({
        readConsent: (model) => readCostConsent(db, model),
      }),
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
  });
  daemon.start();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await daemon.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
