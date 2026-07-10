import { TmuxAdapter } from "../adapters/tmux";
import { resolveTerminal } from "../adapters/terminal";
import {
  loadHiveConfig,
  loadQuotaConfig,
  resolveRoute,
} from "../config/load";
import { HiveDatabase } from "../daemon/db";
import type { TmuxSender } from "../daemon/delivery";
import { readConfiguredPort } from "../daemon/lifecycle";
import { startDaemon } from "../daemon/server";
import { HiveSpawner } from "../daemon/spawner-impl";
import { QuotaLedger } from "../daemon/quota-ledger";
import { QuotaService } from "../daemon/quota";

export async function runDaemon(): Promise<void> {
  const config = await loadHiveConfig();
  const quotaConfig = await loadQuotaConfig();
  const db = new HiveDatabase();
  const quota = new QuotaService(new QuotaLedger(db), quotaConfig);
  const tmux = new TmuxAdapter();
  const terminal = resolveTerminal(config);
  const port = readConfiguredPort();
  const spawner = new HiveSpawner({
    db,
    repoRoot: process.cwd(),
    port,
    config,
    routing: resolveRoute,
    tmux,
    terminal,
    ...(quotaConfig.enabled ? { quota } : {}),
  });
  const tmuxSender: TmuxSender = {
    sendMessage: (session, text) => tmux.sendKeys(session, text),
  };
  const daemon = startDaemon({
    db,
    spawner,
    tmuxSender,
    tmux,
    repoRoot: process.cwd(),
    port,
    manageLifecycle: true,
    ...(quotaConfig.enabled ? { quota } : {}),
  });

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
