import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseDaemonHandshake } from "./handshake";
import { hiveInstanceSuffix } from "./tmux-sessions";

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function defaultHiveHome(): string {
  return join(homedir(), ".hive");
}

export function instancesRoot(): string {
  return join(defaultHiveHome(), "instances");
}

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
  process.env.HIVE_HOME = home;
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

async function inspectInstance(name: string, home: string): Promise<HiveInstance> {
  const port = readNumber(join(home, "daemon.port"));
  const pid = readNumber(join(home, "daemon.pid"));
  const instanceId = hiveInstanceSuffix(home);
  let running = false;
  if (port !== null && port > 0 && port <= 65_535) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/handshake`, {
        signal: AbortSignal.timeout(250),
      });
      const handshake = response.ok
        ? parseDaemonHandshake(await response.json())
        : null;
      running = handshake?.instanceId === instanceId;
    } catch {
      // Stale lifecycle files are reported as stopped, never as an instance.
    }
  }
  return { name, home: resolve(home), instanceId, port, pid, running };
}

export async function listInstances(): Promise<HiveInstance[]> {
  const named = await readdir(instancesRoot(), { withFileTypes: true })
    .catch(() => []);
  const candidates = [
    { name: "default", home: defaultHiveHome() },
    ...named
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, home: join(instancesRoot(), entry.name) })),
  ];
  return Promise.all(candidates.map(({ name, home }) => inspectInstance(name, home)));
}

export async function printInstances(): Promise<void> {
  for (const instance of await listInstances()) {
    const state = instance.running
      ? `running pid=${instance.pid ?? "?"} port=${instance.port}`
      : "stopped";
    console.log(`${instance.name}\t${instance.instanceId}\t${state}\t${instance.home}`);
  }
}
