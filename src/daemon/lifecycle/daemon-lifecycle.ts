import { dlopen, FFIType, ptr } from "bun:ffi";
import { isNumber, isRecord, isString } from "../../shared/is-record";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { probeProcessLiveness } from "../../adapters/process-liveness";
import { getHiveHome, hiveInstanceSuffix } from "../../hive-home/home";
import { isDaemonPort } from "../../shared/daemon-port";
import { IS_RELEASE_BUILD } from "../../shared/version";
import { daemonLogPath } from "../observability/daemon-log";
import {
  type DaemonHandshake,
  expectedDaemonHandshake,
  handshakeMismatch,
  probeHandshake,
} from "./handshake";
import type { JsonObject, JsonValue } from "../../shared/json";

export * from "./handshake";

export function getPidFilePath(hiveHome = getHiveHome()): string {
  return resolve(hiveHome, "daemon.pid");
}

export function getPortFilePath(hiveHome = getHiveHome()): string {
  return resolve(hiveHome, "daemon.port");
}

export function getDaemonLockPath(hiveHome = getHiveHome()): string {
  return resolve(hiveHome, "daemon.lock");
}

interface DaemonLock {
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly startToken?: string;
  readonly executablePath?: string;
}

export interface DaemonProcessIdentity {
  readonly startToken: string;
  readonly executablePath: string;
}

export function macProcessIdentity(pid: number): DaemonProcessIdentity {
  const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_pidpath: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  try {
    const bsdInfo = Buffer.alloc(136);
    const infoBytes = libSystem.symbols.proc_pidinfo(
      pid,
      3,
      0,
      ptr(bsdInfo),
      bsdInfo.length,
    );
    if (infoBytes !== bsdInfo.length)
      throw new Error(`Could not inspect process start token for pid ${pid}`);
    const path = Buffer.alloc(4096);
    const pathBytes = libSystem.symbols.proc_pidpath(
      pid,
      ptr(path),
      path.length,
    );
    if (pathBytes <= 0)
      throw new Error(`Could not inspect executable path for pid ${pid}`);
    const seconds = bsdInfo.readBigUInt64LE(120);
    const microseconds = bsdInfo.readBigUInt64LE(128);
    return {
      startToken: `${seconds}:${microseconds}`,
      executablePath: path.subarray(0, pathBytes).toString("utf8"),
    };
  } finally {
    libSystem.close();
  }
}

type FileEvidence<T> =
  | { readonly state: "absent" }
  | { readonly state: "valid"; readonly value: T }
  | { readonly state: "unknown" };

function readDaemonLock(hiveHome = getHiveHome()): FileEvidence<DaemonLock> {
  let contents: string;
  try {
    contents = readFileSync(getDaemonLockPath(hiveHome), "utf8");
  } catch (error) {
    // SAFETY: The surrounding code already established this contract.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unknown" };
  }
  try {
    const value: JsonValue = JSON.parse(contents);
    if (!isRecord(value) && !Array.isArray(value)) return { state: "unknown" };
    // SAFETY: The surrounding code already established this contract.
    const lock = value as JsonObject;
    if (
      !isNumber(lock.pid) ||
      !Number.isSafeInteger(lock.pid) ||
      lock.pid <= 0 ||
      !isString(lock.instanceId) ||
      !isString(lock.startedAt) ||
      !(lock.startToken === undefined || isString(lock.startToken)) ||
      !(lock.executablePath === undefined || isString(lock.executablePath)) ||
      (lock.startToken === undefined) !== (lock.executablePath === undefined)
    )
      return { state: "unknown" };
    return {
      state: "valid",
      value: {
        pid: lock.pid,
        instanceId: lock.instanceId,
        startedAt: lock.startedAt,
        ...(lock.startToken === undefined
          ? undefined
          : { startToken: lock.startToken }),
        ...(lock.executablePath === undefined
          ? undefined
          : { executablePath: lock.executablePath }),
      },
    };
  } catch {
    return { state: "unknown" };
  }
}

export type DaemonInstanceLiveness = "live" | "dead" | "unknown";

/** The consumers of this probe promote onto or migrate away a default daemon's database — destructive when a live daemon reads as absent. A slow-but-live daemon must still answer "live", so this gate waits far past the startup poll's budget. */
const DESTRUCTIVE_GATE_PROBE_TIMEOUT_MS = 5_000;

/** A missing lock or a dead owner proves the instance is dead. A live PID alone does not prove ownership (PIDs are reused), so only the matching handshake proves live; an unreachable starting daemon remains unknown and is preserved. */
export async function daemonInstanceLiveness(
  hiveHome: string,
  instanceId: string,
): Promise<DaemonInstanceLiveness> {
  const evidence = readDaemonLock(hiveHome);
  if (evidence.state === "absent") return "dead";
  if (evidence.state === "unknown") return "unknown";
  const lock = evidence.value;
  if (lock.instanceId !== instanceId) return "unknown";
  if (!processIsAlive(lock.pid)) return "dead";
  const portEvidence = readPositiveInteger(getPortFilePath(hiveHome));
  if (portEvidence.state !== "valid" || !isDaemonPort(portEvidence.value))
    return "unknown";
  const handshake = await probeHandshake(portEvidence.value, {
    timeoutMs: DESTRUCTIVE_GATE_PROBE_TIMEOUT_MS,
  });
  return handshake?.instanceId === instanceId ? "live" : "unknown";
}

function processIsAlive(pid: number): boolean {
  const liveness = probeProcessLiveness(pid);
  return liveness === "live" || liveness === "other-uid";
}

function removeLockIfOwned(
  lock: DaemonLock,
  hiveHome = getHiveHome(),
): boolean {
  const evidence = readDaemonLock(hiveHome);
  if (evidence.state !== "valid") return false;
  const current = evidence.value;
  if (
    current.pid !== lock.pid ||
    current.instanceId !== lock.instanceId ||
    current.startedAt !== lock.startedAt ||
    current.startToken !== lock.startToken ||
    current.executablePath !== lock.executablePath
  )
    return false;
  rmSync(getDaemonLockPath(hiveHome), { force: true });
  const remaining = readDaemonLock(hiveHome);
  if (remaining.state === "absent") return true;
  return (
    remaining.state === "valid" &&
    (remaining.value.pid !== lock.pid ||
      remaining.value.instanceId !== lock.instanceId ||
      remaining.value.startedAt !== lock.startedAt ||
      remaining.value.startToken !== lock.startToken ||
      remaining.value.executablePath !== lock.executablePath)
  );
}

function assertLifecycleLockOwnership(
  pid: number,
  action: string,
  hiveHome = getHiveHome(),
): void {
  const evidence = readDaemonLock(hiveHome);
  if (evidence.state === "absent") return;
  if (evidence.state === "unknown") {
    throw new Error(
      `Refusing ${action} because daemon lock ownership is unknown`,
    );
  }
  if (
    evidence.value.pid !== pid ||
    evidence.value.instanceId !== hiveInstanceSuffix(hiveHome)
  ) {
    throw new Error(
      `Refusing ${action} because lifecycle files belong to another daemon`,
    );
  }
}

async function lockHasLiveHandshake(lock: DaemonLock): Promise<boolean> {
  const port = readDaemonPort();
  if (port === null) return false;
  const handshake = await probeHandshake(port, { timeoutMs: 250 });
  return handshake?.instanceId === lock.instanceId;
}

export async function acquireDaemonLock(
  pid = process.pid,
  isAlive: (pid: number) => boolean = processIsAlive,
  processIdentity: (pid: number) => DaemonProcessIdentity = macProcessIdentity,
): Promise<void> {
  mkdirSync(getHiveHome(), { recursive: true });
  const identity = processIdentity(pid);
  const lock: DaemonLock = {
    pid,
    instanceId: hiveInstanceSuffix(),
    startedAt: new Date().toISOString(),
    startToken: identity.startToken,
    executablePath: identity.executablePath,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(getDaemonLockPath(), `${JSON.stringify(lock)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return;
    } catch (error) {
      // SAFETY: The surrounding code already established this contract.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const evidence = readDaemonLock();
    if (evidence.state === "absent") {
      continue;
    }
    if (evidence.state === "unknown") {
      throw new Error(
        `Refusing to replace daemon lock at ${getDaemonLockPath()} because its ownership is unknown`,
      );
    }
    const existing = evidence.value;
    const liveHandshake = await lockHasLiveHandshake(existing);
    const startedAt = Date.parse(existing.startedAt);
    const recentlyStarted =
      Number.isFinite(startedAt) && Date.now() - startedAt < 30_000;
    const ownerIsAlive = isAlive(existing.pid);
    if (liveHandshake || (ownerIsAlive && recentlyStarted)) {
      throw new Error(
        `Hive daemon for instance ${existing.instanceId} is already starting or running (pid ${existing.pid})`,
      );
    }
    if (ownerIsAlive) {
      throw new Error(
        `Refusing to replace daemon lock for live pid ${existing.pid} because its ownership is unknown`,
      );
    }
    removeLockIfOwned(existing);
  }
  throw new Error(
    `Could not acquire Hive daemon lock at ${getDaemonLockPath()}`,
  );
}

export function releaseDaemonLock(
  pid = process.pid,
  hiveHome = getHiveHome(),
): boolean {
  const evidence = readDaemonLock(hiveHome);
  if (evidence.state === "absent") return true;
  if (evidence.state === "unknown") return false;
  const lock = evidence.value;
  if (lock.pid !== pid || lock.instanceId !== hiveInstanceSuffix(hiveHome))
    return false;
  return removeLockIfOwned(lock, hiveHome);
}

function readPositiveInteger(path: string): FileEvidence<number> {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch (error) {
    // SAFETY: The surrounding code already established this contract.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unknown" };
  }
  if (!/^[1-9]\d*$/.test(contents)) return { state: "unknown" };
  const value = Number(contents);
  return Number.isSafeInteger(value)
    ? { state: "valid", value }
    : { state: "unknown" };
}

/** The port the running daemon published, or null when there is no usable one. A non-null result is always a connectable port, so callers do not re-check the range. */
export function readDaemonPort(hiveHome = getHiveHome()): number | null {
  const evidence = readPositiveInteger(getPortFilePath(hiveHome));
  return evidence.state === "valid" && isDaemonPort(evidence.value)
    ? evidence.value
    : null;
}

export function readConfiguredPort(): number {
  const port = Number.parseInt(process.env.HIVE_PORT ?? "0", 10);
  if (!isDaemonPort(port, { allowZero: true })) {
    throw new Error(`Invalid HIVE_PORT: ${process.env.HIVE_PORT}`);
  }
  return port;
}

export async function isRunning(): Promise<boolean> {
  const port = readDaemonPort();
  return port !== null && (await daemonHealthy(port));
}

/** Whether a daemon on this exact port answers its health check. Callers that already know the port ask here, so a health answer can never come from a different daemon than the one the caller went on to interrogate. */
async function daemonHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(250),
    });
    if (!response.ok) {
      return false;
    }
    const body: JsonValue = await response.json();
    return isRecord(body) && "ok" in body && body.ok === true;
  } catch {
    return false;
  }
}

export type DaemonReuseProbe =
  | { state: "absent" }
  | { state: "starting"; port: number }
  | { state: "authorized"; port: number }
  | { state: "rejected"; port: number; reason: string };

export async function probeDaemonReuse(
  expected: DaemonHandshake,
  hiveHome = getHiveHome(),
): Promise<DaemonReuseProbe> {
  const port = readDaemonPort(hiveHome);
  if (port === null) {
    return { state: "absent" };
  }
  const healthy = await daemonHealthy(port);
  const actual = await probeHandshake(port, { timeoutMs: 250 });
  if (actual === null) {
    return healthy
      ? { state: "rejected", port, reason: "reuse handshake unavailable" }
      : { state: "absent" };
  }
  const reason = handshakeMismatch(expected, actual);
  return reason === null
    ? healthy
      ? { state: "authorized", port }
      : { state: "starting", port }
    : { state: "rejected", port, reason };
}

export function writeLifecycleFiles(port: number, pid = process.pid): void {
  mkdirSync(getHiveHome(), { recursive: true });
  assertLifecycleLockOwnership(pid, "lifecycle file overwrite");
  const evidence = readPositiveInteger(getPidFilePath());
  if (evidence.state === "unknown") {
    throw new Error(
      "Refusing to overwrite lifecycle files because pid ownership is unknown",
    );
  }
  if (
    evidence.state === "valid" &&
    evidence.value !== pid &&
    processIsAlive(evidence.value)
  ) {
    throw new Error(
      `Refusing to overwrite lifecycle files for live daemon pid ${evidence.value}`,
    );
  }
  writeFileSync(getPidFilePath(), `${pid}\n`);
  writeFileSync(getPortFilePath(), `${port}\n`);
}

export function cleanupLifecycleFiles(
  pid = process.pid,
  hiveHome = getHiveHome(),
): void {
  assertLifecycleLockOwnership(pid, "lifecycle cleanup", hiveHome);
  const evidence = readPositiveInteger(getPidFilePath(hiveHome));
  if (evidence.state === "unknown") {
    throw new Error(
      "Refusing lifecycle cleanup because pid ownership is unknown",
    );
  }
  if (evidence.state === "valid" && evidence.value !== pid) return;
  rmSync(getPortFilePath(hiveHome), { force: true });
  if (readPositiveInteger(getPortFilePath(hiveHome)).state !== "absent") {
    throw new Error("Could not verify removal of the daemon port file");
  }
  rmSync(getPidFilePath(hiveHome), { force: true });
  if (readPositiveInteger(getPidFilePath(hiveHome)).state !== "absent") {
    throw new Error("Could not verify removal of the daemon pid file");
  }
  if (!releaseDaemonLock(pid, hiveHome)) {
    throw new Error("Could not verify release of the daemon lock");
  }
}

export function daemonSpawnArgv(
  isReleaseBuild: boolean,
  execPath: string,
  entry = resolve(import.meta.dir, "../../cli.ts"),
): string[] {
  return [...hiveCliSpawnArgv(isReleaseBuild, execPath, entry), "daemon"];
}

/** How child processes invoke this exact Hive build. Release hooks must never fall back to a different `hive` on PATH: the active version's daemon, hooks, MCP clients, and Workspace are one control plane. A source checkout still needs Bun plus the entry script because its `process.execPath` is Bun rather than Hive itself. */
export function hiveCliSpawnArgv(
  isReleaseBuild: boolean,
  execPath: string,
  entry = resolve(import.meta.dir, "../../cli.ts"),
): string[] {
  return isReleaseBuild ? [execPath] : [execPath, entry];
}

export const DAEMON_STARTUP_TIMEOUT_MS = 30_000;

/** Bring this project's daemon up and return its port. Every read of mutable process state happens up front, before the first await, and nothing after that reads `process.env` or the working directory again: identifying the daemon, probing for it, spawning it and polling for it are one decision about one home, and a value re-read after an await is a second answer to a question already settled. Sharing a process with code that moves HIVE_HOME is not hypothetical — a Bun test file does exactly that to its neighbours — and a redirect landing mid-flight would otherwise spawn a daemon into a home this call never chose, then poll for it somewhere else. */
export async function ensureStarted(
  spawnDaemon: typeof Bun.spawn = Bun.spawn.bind(Bun),
): Promise<number> {
  const environment = { ...process.env };
  const hiveHome = getHiveHome();
  const configuredPort = readConfiguredPort();
  const projectRoot = process.cwd();
  const handshake = await expectedDaemonHandshake(projectRoot, hiveHome);
  const existing = await probeDaemonReuse(handshake, hiveHome);
  if (existing.state === "authorized") {
    return existing.port;
  }
  if (existing.state === "rejected") {
    throw new Error(
      `Refusing to reuse live Hive daemon on port ${existing.port}: ${existing.reason} differs. ` +
        "Stop the existing daemon before starting this project.",
    );
  }

  const child =
    existing.state === "absent"
      ? (() => {
          mkdirSync(resolve(hiveHome, "logs"), { recursive: true });
          const stderr = openSync(daemonLogPath(hiveHome), "a", 0o600);
          try {
            const spawned = spawnDaemon(
              daemonSpawnArgv(IS_RELEASE_BUILD, process.execPath),
              {
                cwd: projectRoot,
                detached: true,
                env: {
                  ...environment,
                  HIVE_HOME: hiveHome,
                  HIVE_PORT: String(configuredPort),
                  HIVE_PROJECT_ROOT: projectRoot,
                  HIVE_PROJECT_ID: handshake.hiveUuid,
                },
                stdin: "ignore",
                stdout: "ignore",
                stderr,
              },
            );
            spawned.unref();
            return spawned;
          } finally {
            closeSync(stderr);
          }
        })()
      : null;

  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const started = await probeDaemonReuse(handshake, hiveHome);
    if (started.state === "authorized") {
      return started.port;
    }
    if (started.state === "rejected") {
      throw new Error(
        `Hive daemon started with an incompatible handshake: ${started.reason}.`,
      );
    }
    if (started.state === "starting") {
      await Bun.sleep(25);
      continue;
    }
    if (child === null) break;
    if (
      await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(25).then(() => false),
      ])
    ) {
      break;
    }
  }
  throw new Error("Hive daemon failed to start");
}
