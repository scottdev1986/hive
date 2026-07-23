/** `hive graphify enable|status` — build and inspect Hive's local
 * code graph. Normal provisioning happens automatically inside `hive init`;
 * `enable` remains as the direct recovery command after an offline or failed
 * initialization. */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  buildGraph,
  defaultInstallDeps,
  graphJsonPath,
  graphifyBin,
  graphifyPin,
  graphifyToolsDir,
  installGraphify,
  type CommandRunner,
  type GraphifyInstallDeps,
  runCommand,
} from "../adapters/graphify";

export interface GraphifyCliDeps {
  install: GraphifyInstallDeps;
  run: CommandRunner;
  log: (line: string) => void;
}

export const defaultGraphifyCliDeps: GraphifyCliDeps = {
  install: defaultInstallDeps,
  run: runCommand,
  log: console.log,
};

/** Install the hash-verified runtime and build this repo's graph. Used by both
 * `hive init` and the explicit repair command. */
export async function runGraphifyEnable(
  root: string,
  deps: GraphifyCliDeps = defaultGraphifyCliDeps,
): Promise<number> {
  deps.log(`Preparing Graphify for ${root}:`);
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

  deps.log("Building the graph (first build on a large repo can take minutes)…");
  const built = await buildGraph(root, deps.run);
  if (!built.ok) {
    deps.log(
      `Graph build failed — the daemon will retry on the next landing: ${built.reason}`,
    );
    return 1;
  }
  deps.log(`Graph built: ${built.detail}.`);
  deps.log("The next Hive start will attach the Graphify server.");
  return 0;
}

export async function runGraphifyStatus(
  root: string,
  deps: GraphifyCliDeps = defaultGraphifyCliDeps,
): Promise<number> {
  const installed = existsSync(graphifyBin());
  deps.log(`pin: graphifyy==${graphifyPin()}`);
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
