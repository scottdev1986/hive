import { TmuxAdapter } from "../adapters/tmux";
import { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { resolveTerminal } from "../adapters/terminal";
import {
  loadHiveConfig,
  loadQuotaConfig,
  resolveRoute,
} from "../config/load";
import { HiveDatabase } from "../daemon/db";
import type { TmuxSender } from "../daemon/delivery";
import { TerminalLayoutManager } from "../daemon/layout";
import { readConfiguredPort } from "../daemon/lifecycle";
import { HiveDaemon } from "../daemon/server";
import { HiveSpawner } from "../daemon/spawner-impl";
import { QuotaLedger } from "../daemon/quota-ledger";
import { QuotaService } from "../daemon/quota";
import { ORCHESTRATOR_NAME } from "../schemas";

export async function runDaemon(): Promise<void> {
  const config = await loadHiveConfig();
  const quotaConfig = await loadQuotaConfig();
  const db = new HiveDatabase();
  const quota = new QuotaService(new QuotaLedger(db), quotaConfig);
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
  const layout = new TerminalLayoutManager({
    db,
    enabled: config.layout === "auto" && !config.headless,
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
    repoRoot: process.cwd(),
    port,
    config,
    routing: resolveRoute,
    tmux,
    terminal,
    onTerminalsChanged: () => layout.requestLayout(),
    onTerminalError: reportTerminalError,
    // Even when quota-aware routing is disabled, critical read-only restarts
    // require a durable accounting lifecycle.
    quota,
    codexAppServer,
  });
  const tmuxSender: TmuxSender = {
    sendMessage: (session, text) => tmux.sendKeys(session, text),
  };
  daemon = new HiveDaemon({
    db,
    spawner,
    tmuxSender,
    tmux,
    repoRoot: process.cwd(),
    port,
    manageLifecycle: true,
    layout,
    quota,
    codexControl: codexAppServer,
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
