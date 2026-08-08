import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  buildGraph,
  type CommandRunner,
  defaultInstallDeps,
  type GraphifyInstallDeps,
  graphifyBin,
  graphifyPin,
  graphifyToolsDir,
  graphJsonPath,
  installGraphify,
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

export async function provisionGraphify(
  root: string,
  deps: GraphifyCliDeps = defaultGraphifyCliDeps,
): Promise<number> {
  deps.log(`Preparing Graphify for ${root}:`);
  deps.log(
    `  checking Hive's signed Graphify runtime channel and installing any compatible update into ${graphifyToolsDir()},`,
  );
  deps.log(
    "  then building a code-only knowledge graph in graphify-out/ — parsed locally, nothing leaves this machine.",
  );

  const installed = await installGraphify(deps.install);
  if (!installed.ok) {
    deps.log(`Graphify update unavailable: ${installed.reason}`);
    if (!existsSync(graphifyBin())) return 1;
    deps.log("Using the installed Graphify runtime.");
  } else {
    deps.log(`Installed ${installed.detail}.`);
  }

  deps.log(
    "Building the graph (first build on a large repo can take minutes)…",
  );
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
  deps.log(`build input: graphifyy==${graphifyPin()}`);
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
