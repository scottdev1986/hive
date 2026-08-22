import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative } from "node:path";
import { z } from "zod";
import {
  type DaemonProcessIdentity,
  macProcessIdentity,
} from "../../src/daemon/lifecycle/daemon-lifecycle";

const processRoleSchema = z.enum([
  "daemon",
  "workspace",
  "orchestrator",
  "graphify",
  "other",
]);
export type ProcessRole = z.infer<typeof processRoleSchema>;

const ownedProcessSchema = z.object({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  executablePath: z.string().min(1),
  role: processRoleSchema,
});
export type OwnedProcess = z.infer<typeof ownedProcessSchema>;

const ownershipRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  qaRoot: z.string().min(1),
  processes: z.array(ownedProcessSchema),
});
export type OwnershipRegistry = z.infer<typeof ownershipRegistrySchema>;

export interface ListedProcess {
  readonly pid: number;
  readonly command: string;
}

export interface ProcessOwnershipSystem {
  readonly list: () => readonly ListedProcess[];
  readonly identity: (pid: number) => DaemonProcessIdentity | null;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const defaultSystem: ProcessOwnershipSystem = {
  list: listProcesses,
  identity: inspectIdentity,
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
  sleep: Bun.sleep,
};

function listProcesses(): readonly ListedProcess[] {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`could not list processes: ${result.stderr.trim()}`);
  }
  const processes: ListedProcess[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    processes.push({ pid, command: match[2] ?? "" });
  }
  return processes;
}

function inspectIdentity(pid: number): DaemonProcessIdentity | null {
  try {
    return macProcessIdentity(pid);
  } catch (inspectionError) {
    try {
      process.kill(pid, 0);
    } catch (livenessError) {
      if ((livenessError as NodeJS.ErrnoException).code === "ESRCH")
        return null;
      throw inspectionError;
    }
    throw inspectionError;
  }
}

function canonicalIdentity(
  identity: DaemonProcessIdentity,
): DaemonProcessIdentity {
  return {
    startToken: identity.startToken,
    executablePath: realpathSync.native(identity.executablePath),
  };
}

function isUnderRoot(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && !fromRoot.startsWith("..") && fromRoot[0] !== "/";
}

function classifyProcess(command: string, executablePath: string): ProcessRole {
  const executable = basename(executablePath);
  if (executable.startsWith("HiveWorkspace")) return "workspace";
  if (command.includes("workspace-orchestrator")) return "orchestrator";
  if (executable.includes("graphify") || command.includes("graphify-mcp"))
    return "graphify";
  if (/(?:^|\s)daemon(?:\s|$)/.test(command)) return "daemon";
  return "other";
}

function rootProcesses(
  qaRoot: string,
  system: ProcessOwnershipSystem,
): readonly OwnedProcess[] {
  const processes: OwnedProcess[] = [];
  const commandRoots = [
    qaRoot,
    ...(qaRoot.startsWith("/private/tmp/")
      ? [qaRoot.replace("/private/tmp/", "/tmp/")]
      : []),
  ];
  for (const listed of system.list()) {
    if (!commandRoots.some((root) => listed.command.includes(root))) continue;
    const inspected = system.identity(listed.pid);
    if (inspected === null) continue;
    const identity = canonicalIdentity(inspected);
    if (!isUnderRoot(qaRoot, identity.executablePath)) continue;
    processes.push({
      pid: listed.pid,
      ...identity,
      role: classifyProcess(listed.command, identity.executablePath),
    });
  }
  return processes.sort((left, right) => left.pid - right.pid);
}

function writeOwnershipRegistry(
  registryPath: string,
  registry: OwnershipRegistry,
): void {
  const temporaryPath = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, registryPath);
}

export function readOwnershipRegistry(registryPath: string): OwnershipRegistry {
  return ownershipRegistrySchema.parse(
    JSON.parse(readFileSync(registryPath, "utf8")),
  );
}

/** Claims a fresh staging root. An existing state directory is an active or
 * abandoned run, and a live executable under the root is an unowned run; both
 * refuse instead of guessing which process is safe to reclaim. */
export function beginOwnership(
  qaRootPath: string,
  registryPath: string,
  system: ProcessOwnershipSystem = defaultSystem,
): OwnershipRegistry {
  const qaRoot = realpathSync.native(qaRootPath);
  const stateDirectory = dirname(registryPath);
  try {
    mkdirSync(stateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `another QA rig owns ${stateDirectory}; run 'make qa-clean' first`,
      );
    }
    throw error;
  }
  try {
    const unowned = rootProcesses(qaRoot, system);
    if (unowned.length > 0) {
      throw new Error(
        `unowned process already runs from ${qaRoot}: ${unowned.map((process) => process.pid).join(",")}`,
      );
    }
    const registry: OwnershipRegistry = {
      schemaVersion: 1,
      qaRoot,
      processes: [],
    };
    writeOwnershipRegistry(registryPath, registry);
    return registry;
  } catch (error) {
    rmSync(registryPath, { force: true });
    rmdirSync(stateDirectory);
    throw error;
  }
}

function mergeProcesses(
  registry: OwnershipRegistry,
  discovered: readonly OwnedProcess[],
): OwnershipRegistry {
  const processes = [...registry.processes];
  for (const process of discovered) {
    const samePid = processes.find(
      (candidate) => candidate.pid === process.pid,
    );
    if (samePid !== undefined) {
      if (
        samePid.startToken !== process.startToken ||
        samePid.executablePath !== process.executablePath
      ) {
        throw new Error(
          `refusing: pid ${process.pid} identity changed after it was registered`,
        );
      }
      continue;
    }
    processes.push(process);
  }
  processes.sort((left, right) => left.pid - right.pid);
  return { ...registry, processes };
}

export function captureOwnership(
  registryPath: string,
  system: ProcessOwnershipSystem = defaultSystem,
): OwnershipRegistry {
  const registry = readOwnershipRegistry(registryPath);
  const updated = mergeProcesses(
    registry,
    rootProcesses(registry.qaRoot, system),
  );
  writeOwnershipRegistry(registryPath, updated);
  return updated;
}

async function captureRequiredRoles(
  registryPath: string,
  requiredRoles: readonly ProcessRole[],
  system: ProcessOwnershipSystem,
): Promise<OwnershipRegistry> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const registry = captureOwnership(registryPath, system);
    if (
      requiredRoles.every((role) =>
        registry.processes.some((process) => process.role === role),
      )
    ) {
      return registry;
    }
    await system.sleep(100);
  }
  throw new Error(
    `refusing: launch did not yield owned ${requiredRoles.join(" and ")}`,
  );
}

function liveRegisteredProcesses(
  registry: OwnershipRegistry,
  system: ProcessOwnershipSystem,
): readonly OwnedProcess[] {
  const live: OwnedProcess[] = [];
  for (const owned of registry.processes) {
    const inspected = system.identity(owned.pid);
    if (inspected === null) continue;
    const current = canonicalIdentity(inspected);
    if (
      current.startToken !== owned.startToken ||
      current.executablePath !== owned.executablePath
    ) {
      throw new Error(
        `refusing: pid ${owned.pid} identity changed after it was registered`,
      );
    }
    live.push(owned);
  }
  return live;
}

async function signalUntilStopped(
  registryPath: string,
  signal: NodeJS.Signals,
  attempts: number,
  system: ProcessOwnershipSystem,
): Promise<readonly OwnedProcess[]> {
  const signalled = new Set<string>();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const registry = captureOwnership(registryPath, system);
    const live = liveRegisteredProcesses(registry, system);
    if (live.length === 0) return [];
    for (const process of live) {
      const key = `${process.pid}:${process.startToken}`;
      if (signalled.has(key)) continue;
      system.signal(process.pid, signal);
      signalled.add(key);
    }
    await system.sleep(100);
  }
  return liveRegisteredProcesses(
    captureOwnership(registryPath, system),
    system,
  );
}

export async function stopOwnedProcesses(
  registryPath: string,
  system: ProcessOwnershipSystem = defaultSystem,
): Promise<void> {
  let remaining = await signalUntilStopped(registryPath, "SIGTERM", 50, system);
  if (remaining.length > 0) {
    remaining = await signalUntilStopped(registryPath, "SIGKILL", 20, system);
  }
  if (remaining.length > 0) {
    throw new Error(
      `refusing: registered processes did not stop: ${remaining.map((process) => process.pid).join(",")}`,
    );
  }
  assertRootEmpty(readOwnershipRegistry(registryPath).qaRoot, system);
}

export function assertRootEmpty(
  qaRootPath: string,
  system: ProcessOwnershipSystem = defaultSystem,
): void {
  const qaRoot = realpathSync.native(qaRootPath);
  const remaining = rootProcesses(qaRoot, system);
  if (remaining.length > 0) {
    throw new Error(
      `refusing: unowned process remains under ${qaRoot}: ${remaining.map((process) => process.pid).join(",")}`,
    );
  }
}

function parseRole(value: string | undefined): ProcessRole {
  return processRoleSchema.parse(value);
}

async function main(argv: readonly string[]): Promise<number> {
  const [operation, ...args] = argv;
  switch (operation) {
    case "begin": {
      const [qaRoot, registryPath] = args;
      if (qaRoot === undefined || registryPath === undefined)
        throw new Error("begin requires QA root and registry path");
      beginOwnership(qaRoot, registryPath);
      return 0;
    }
    case "capture": {
      const [registryPath, ...roleTexts] = args;
      if (registryPath === undefined)
        throw new Error("capture requires registry path");
      const roles = roleTexts.map(parseRole);
      if (roles.length === 0) captureOwnership(registryPath);
      else await captureRequiredRoles(registryPath, roles, defaultSystem);
      return 0;
    }
    case "stop": {
      const [registryPath] = args;
      if (registryPath === undefined)
        throw new Error("stop requires registry path");
      await stopOwnedProcesses(registryPath);
      return 0;
    }
    case "assert-empty": {
      const [qaRoot] = args;
      if (qaRoot === undefined)
        throw new Error("assert-empty requires QA root");
      assertRootEmpty(qaRoot);
      return 0;
    }
    default:
      throw new Error(
        `unknown process ownership operation: ${operation ?? ""}`,
      );
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "process ownership failed",
    );
    process.exitCode = 2;
  }
}
