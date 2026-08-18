import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultHiveHome,
  hiveInstanceSuffix,
  instancesRoot,
} from "../../hive-home/home";
import { isDaemonPort } from "../../shared/daemon-port";
import {
  type DaemonInstanceLiveness,
  daemonInstanceLiveness,
} from "./daemon-lifecycle";
import { probeHandshake } from "./handshake";

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const ORDINARY_WORKSPACE_RUNTIME = "HIVE_ORDINARY_WORKSPACE_RUNTIME";

export function namedInstanceHome(name: string): string {
  if (!INSTANCE_NAME.test(name)) {
    throw new Error(
      `Invalid Hive instance name "${name}": use letters, numbers, hyphens, and underscores`,
    );
  }
  return join(instancesRoot(), name);
}

export function selectInstance(name: string): string {
  const home = namedInstanceHome(name);
  delete process.env[ORDINARY_WORKSPACE_RUNTIME];
  process.env.HIVE_HOME = home;
  return home;
}

export function selectFreshInstance(id: string = randomUUID()): string {
  const home = selectInstance(`run-${id}`);
  process.env[ORDINARY_WORKSPACE_RUNTIME] = "1";
  return home;
}

export function selectInstanceFromArgv(argv: readonly string[]): string | null {
  const index = argv.indexOf("--instance");
  if (index < 0) return null;
  const name = argv[index + 1];
  if (name === undefined || name.startsWith("-")) {
    throw new Error("--instance requires a name");
  }
  return selectInstance(name);
}

function readNumber(path: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export interface HiveInstance {
  readonly name: string;
  readonly home: string;
  readonly instanceId: string;
  readonly port: number | null;
  readonly pid: number | null;
  readonly running: boolean;
}

export interface InstanceMutationBlocker {
  readonly instance: HiveInstance;
  readonly liveAgents: readonly string[];
}

async function inspectInstance(
  name: string,
  home: string,
): Promise<HiveInstance> {
  const port = readNumber(join(home, "daemon.port"));
  const pid = readNumber(join(home, "daemon.pid"));
  const instanceId = hiveInstanceSuffix(home);
  let running = false;
  if (port !== null && isDaemonPort(port)) {
    // A stale or unreachable daemon reports as stopped, never as an instance.
    const handshake = await probeHandshake(port, { timeoutMs: 250 });
    running = handshake?.instanceId === instanceId;
  }
  return { name, home: resolve(home), instanceId, port, pid, running };
}

export async function listInstances(): Promise<HiveInstance[]> {
  const named = await readdir(instancesRoot(), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const candidates = [
    { name: "default", home: defaultHiveHome() },
    ...named
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        home: join(instancesRoot(), entry.name),
      })),
  ];
  return Promise.all(
    candidates.map(({ name, home }) => inspectInstance(name, home)),
  );
}

/** Global install mutations are safe only when every positively live daemon has an empty team. An instance still starting is unknown and blocks too. */
export async function instanceMutationBlockers(
  liveAgents: (port: number) => Promise<readonly string[]>,
  deps: {
    instances?: () => Promise<HiveInstance[]>;
    liveness?: (
      home: string,
      instanceId: string,
    ) => Promise<DaemonInstanceLiveness>;
  } = {},
): Promise<InstanceMutationBlocker[]> {
  const blockers: InstanceMutationBlocker[] = [];
  for (const instance of await (deps.instances ?? listInstances)()) {
    if (instance.running && instance.port !== null) {
      const agents = await liveAgents(instance.port).catch(() => ["<unknown>"]);
      if (agents.length > 0) blockers.push({ instance, liveAgents: agents });
      continue;
    }
    const state = await (deps.liveness ?? daemonInstanceLiveness)(
      instance.home,
      instance.instanceId,
    );
    if (state === "unknown") {
      blockers.push({ instance, liveAgents: ["<starting-or-unreachable>"] });
    }
  }
  return blockers;
}

export async function printInstances(): Promise<void> {
  for (const instance of await listInstances()) {
    const state = instance.running
      ? `running pid=${instance.pid ?? "?"} port=${instance.port}`
      : "stopped";
    console.log(
      `${instance.name}\t${instance.instanceId}\t${state}\t${instance.home}`,
    );
  }
}
