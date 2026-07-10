import { TmuxAdapter } from "../adapters/tmux";
import { resolveTerminal } from "../adapters/terminal";
import { loadHiveConfig, resolveRoute } from "../config/load";
import { HiveDatabase } from "../daemon/db";
import type { TmuxSender } from "../daemon/delivery";
import { readConfiguredPort } from "../daemon/lifecycle";
import { startDaemon } from "../daemon/server";
import { HiveSpawner } from "../daemon/spawner-impl";

export async function runDaemon(): Promise<void> {
  const config = await loadHiveConfig();
  const db = new HiveDatabase();
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
  });
  const tmuxSender: TmuxSender = {
    sendMessage: (session, text) => tmux.sendKeys(session, text),
  };
  const daemon = startDaemon({
    db,
    spawner,
    tmuxSender,
    port,
    manageLifecycle: true,
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
