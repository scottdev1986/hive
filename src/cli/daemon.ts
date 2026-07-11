import { TmuxAdapter } from "../adapters/tmux";
import { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { resolveTerminal } from "../adapters/terminal";
import {
  loadHiveConfig,
  loadQuotaConfig,
  loadRoutingPins,
  resolveRoute,
} from "../config/load";
import { HiveDatabase } from "../daemon/db";
import { BunTmuxSender } from "../daemon/delivery";
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
import { ORCHESTRATOR_NAME } from "../schemas";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
} from "../daemon/capability-discovery";

export async function runDaemon(): Promise<void> {
  const repoRoot = process.env.HIVE_PROJECT_ROOT ?? process.cwd();
  const config = await loadHiveConfig();
  const quotaConfig = await loadQuotaConfig();
  const db = new HiveDatabase();
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
  const spawner = new HiveSpawner({
    db,
    repoRoot,
    port,
    // Only the daemon mints. The spawner asks for a credential, it never
    // creates one, and the token is written to a 0600 file rather than handed
    // to the agent process through its environment.
    issueCredential: (name, role, epoch) =>
      daemon.issueCredential(name, role, epoch),
    config,
    routing: resolveRoute,
    routingPins: loadRoutingPins,
    discoverCapabilities: async (provider) =>
      provider === "claude"
        ? await new ClaudeCapabilityProbe().read()
        : await new CodexCapabilityProbe().read(),
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
    port,
    manageLifecycle: true,
    layout,
    workspacePresence,
    quota,
    codexControl: codexAppServer,
    resources: config.resources,
    lifecycle: config.lifecycle,
    autonomy: config.autonomy,
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
