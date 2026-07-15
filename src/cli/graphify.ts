/**
 * `hive graphify enable|disable|status` — the consent surface for the
 * graphify integration (docs/graphify/integration.md).
 *
 * This command never prompts: running `enable` IS the consent, in the same
 * sense that running `init` is authorization for what init prints itself
 * doing. The one interactive question about graphify lives in `hive init`
 * (TTY-gated, flag-overridable — see runInit); this command is the scriptable
 * spelling those flags and that prompt both resolve to. The command states
 * exactly what it is about to do, then does it, and a platform with no
 * published bundle gets one honest line plus a clean exit.
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { probeDaemonReuse } from "../daemon/lifecycle";
import { expectedDaemonHandshake } from "../daemon/handshake";
import { operatorFetch } from "./credential";
import {
  buildGraph,
  defaultInstallDeps,
  ensureGraphifyIgnored,
  graphJsonPath,
  graphifyBin,
  graphifyPin,
  graphifyToolsDir,
  installGraphify,
  purgeGraphify,
  readGraphifyState,
  writeGraphifyState,
  type CommandRunner,
  type GraphifyInstallDeps,
  runCommand,
} from "../adapters/graphify";

export interface GraphifyCliDeps {
  install: GraphifyInstallDeps;
  run: CommandRunner;
  log: (line: string) => void;
  /** Ask a running daemon to converge on the persisted state. Injectable so
   * tests never open a socket. */
  syncDaemon: (root: string, log: (line: string) => void) => Promise<void>;
}

/** Best-effort: the state file is the truth and the next daemon start reads
 * it, so an unreachable daemon costs nothing but immediacy. */
async function syncDaemon(
  root: string,
  log: (line: string) => void,
): Promise<void> {
  const daemon = await probeDaemonReuse(await expectedDaemonHandshake(root))
    .catch(() => ({ state: "absent" } as const));
  if (daemon.state !== "authorized") {
    log("No daemon for this project is running; the next `hive` start applies this.");
    return;
  }
  try {
    const response = await operatorFetch(`http://127.0.0.1:${daemon.port}/graphify`, {
      method: "POST",
    });
    const body = await response.json().catch(() => null) as
      | { enabled?: boolean; running?: boolean; url?: string | null; lastError?: string | null; error?: string }
      | null;
    if (!response.ok) {
      log(`Daemon did not apply it (${body?.error ?? `HTTP ${response.status}`}); it will on its next start.`);
      return;
    }
    if (body?.running === true) {
      log(`Daemon: graphify MCP server live at ${body.url}.`);
    } else {
      log(
        body?.enabled === true
          ? `Daemon: server not running${body?.lastError ? ` (${body.lastError})` : ""} — agents run without graph context.`
          : "Daemon: graphify server stopped.",
      );
    }
  } catch {
    log("Could not reach the daemon; the next start applies this.");
  }
}

export const defaultGraphifyCliDeps: GraphifyCliDeps = {
  install: defaultInstallDeps,
  run: runCommand,
  log: console.log,
  syncDaemon,
};

/** Install (hash-verified), exclude, persist, build. Returns a process exit
 * code: a machine that cannot enable gets told why and exits nonzero, but
 * nothing else in Hive changes state. */
export async function runGraphifyEnable(
  root: string,
  deps: GraphifyCliDeps = defaultGraphifyCliDeps,
): Promise<number> {
  deps.log(`Enabling graphify for ${root}:`);
  deps.log(
    `  fetching Hive's graphify bundle (graphifyy==${graphifyPin()}, sha256-verified against this Hive build) into ${graphifyToolsDir()},`,
  );
  deps.log(
    "  then building a code-only knowledge graph in graphify-out/ — parsed locally, nothing leaves this machine.",
  );

  const installed = await installGraphify(deps.install);
  if (!installed.ok) {
    deps.log(installed.reason);
    return 1;
  }
  deps.log(`Installed ${installed.detail}.`);

  const ignored = await ensureGraphifyIgnored(root, deps.run);
  if (!ignored.ok) {
    deps.log(`Could not keep graphify-out/ out of git: ${ignored.reason}`);
    return 1;
  }
  deps.log(`graphify-out/ excluded via ${ignored.detail} (verified).`);

  await writeGraphifyState(root, { enabled: true, pin: graphifyPin() });

  deps.log("Building the graph (first build on a large repo can take minutes)…");
  const built = await buildGraph(root, deps.run);
  if (!built.ok) {
    deps.log(
      `Graph build failed — graphify stays enabled and the daemon will retry on the next landing: ${built.reason}`,
    );
    return 1;
  }
  deps.log(`Graph built: ${built.detail}.`);
  await deps.syncDaemon(root, deps.log);
  return 0;
}

export async function runGraphifyDisable(
  root: string,
  options: { purge?: boolean } = {},
  deps: GraphifyCliDeps = defaultGraphifyCliDeps,
): Promise<number> {
  await writeGraphifyState(root, { enabled: false, pin: null });
  deps.log("Graphify disabled: no graph context, no MCP server, no rebuilds.");
  await deps.syncDaemon(root, deps.log);
  if (options.purge === true) {
    const removed = await purgeGraphify(root);
    for (const path of removed) deps.log(`Removed ${path}.`);
    deps.log("Nothing else to clean — graphify never writes outside those paths.");
  } else {
    deps.log(
      `The installed tool and graphify-out/ were kept for cheap re-enable; \`hive graphify disable --purge\` removes both.`,
    );
  }
  return 0;
}

export async function runGraphifyStatus(
  root: string,
  deps: GraphifyCliDeps = defaultGraphifyCliDeps,
): Promise<number> {
  const state = await readGraphifyState(root);
  const installed = existsSync(graphifyBin());
  deps.log(`pin: graphifyy==${graphifyPin()}`);
  deps.log(`enabled: ${state.enabled}${state.pin === null ? "" : ` (installed pin ${state.pin})`}`);
  deps.log(`installed: ${installed ? graphifyToolsDir() : "no"}`);
  try {
    const graph = await stat(graphJsonPath(root));
    deps.log(
      `graph: ${graphJsonPath(root)} (${Math.round(graph.size / 1024)} KB, built ${graph.mtime.toISOString()})`,
    );
  } catch {
    deps.log("graph: not built");
  }
  return 0;
}
