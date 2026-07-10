import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IS_RELEASE_BUILD } from "../version";
import { getHiveHome } from "./db";
import {
  expectedDaemonHandshake,
  handshakeMismatch,
  parseDaemonHandshake,
  type DaemonHandshake,
} from "./handshake";

export function getPidFilePath(): string {
  return resolve(getHiveHome(), "daemon.pid");
}

export function getPortFilePath(): string {
  return resolve(getHiveHome(), "daemon.port");
}

function readNumber(path: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export function readDaemonPort(): number | null {
  return readNumber(getPortFilePath());
}

export function readConfiguredPort(): number {
  const port = Number.parseInt(process.env.HIVE_PORT ?? "4483", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid HIVE_PORT: ${process.env.HIVE_PORT}`);
  }
  return port;
}

export async function isRunning(): Promise<boolean> {
  const port = readDaemonPort();
  if (port === null || port <= 0 || port > 65_535) {
    return false;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(250),
    });
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null &&
      "ok" in body && body.ok === true;
  } catch {
    return false;
  }
}

export type DaemonReuseProbe =
  | { state: "absent" }
  | { state: "authorized"; port: number }
  | { state: "rejected"; port: number; reason: string };

/**
 * Health is deliberately only a liveness probe. Reuse needs the complete
 * project/build/protocol handshake from a separate endpoint.
 */
export async function probeDaemonReuse(
  expected: DaemonHandshake,
): Promise<DaemonReuseProbe> {
  const port = readDaemonPort();
  if (port === null || port <= 0 || port > 65_535 || !(await isRunning())) {
    return { state: "absent" };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/handshake`, {
      signal: AbortSignal.timeout(250),
    });
    const actual = response.ok ? parseDaemonHandshake(await response.json()) : null;
    const reason = actual === null ? "missing or malformed reuse handshake" :
      handshakeMismatch(expected, actual);
    return reason === null ? { state: "authorized", port } :
      { state: "rejected", port, reason };
  } catch {
    return { state: "rejected", port, reason: "reuse handshake unavailable" };
  }
}

export function writeLifecycleFiles(
  port: number,
  pid = process.pid,
): void {
  mkdirSync(getHiveHome(), { recursive: true });
  writeFileSync(getPidFilePath(), `${pid}\n`);
  writeFileSync(getPortFilePath(), `${port}\n`);
}

export function cleanupLifecycleFiles(pid = process.pid): void {
  const recordedPid = readNumber(getPidFilePath());
  if (recordedPid !== null && recordedPid !== pid) {
    return;
  }
  rmSync(getPidFilePath(), { force: true });
  rmSync(getPortFilePath(), { force: true });
}

/**
 * How to re-invoke ourselves as the daemon.
 *
 * A source checkout runs under `bun`, so `process.execPath` is the Bun binary
 * and the entry script must be named explicitly. A compiled release *is* the
 * entry: its sources live in Bun's virtual filesystem, and passing that path as
 * argv would make the new process try to run `/$bunfs/root/cli.ts` as a
 * subcommand. Release builds therefore spawn themselves with `daemon` alone.
 */
export function daemonSpawnArgv(
  isReleaseBuild: boolean,
  execPath: string,
  entry = resolve(import.meta.dir, "../cli.ts"),
): string[] {
  return isReleaseBuild ? [execPath, "daemon"] : [execPath, entry, "daemon"];
}

export async function ensureStarted(): Promise<number> {
  const projectRoot = process.cwd();
  const handshake = await expectedDaemonHandshake(projectRoot);
  const existing = await probeDaemonReuse(handshake);
  if (existing.state === "authorized") {
    return existing.port;
  }
  if (existing.state === "rejected") {
    throw new Error(
      `Refusing to reuse live Hive daemon on port ${existing.port}: ${existing.reason} differs. ` +
        "Stop the existing daemon before starting this project.",
    );
  }

  cleanupLifecycleFiles();
  const port = readConfiguredPort();
  const child = Bun.spawn(daemonSpawnArgv(IS_RELEASE_BUILD, process.execPath), {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      HIVE_HOME: getHiveHome(),
      HIVE_PORT: String(port),
      HIVE_PROJECT_ROOT: projectRoot,
      HIVE_PROJECT_ID: handshake.hiveUuid,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const started = await probeDaemonReuse(handshake);
    if (started.state === "authorized") {
      return started.port;
    }
    if (started.state === "rejected") {
      throw new Error(
        `Hive daemon started with an incompatible handshake: ${started.reason}.`,
      );
    }
    if (await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(25).then(() => false),
    ])) {
      break;
    }
  }
  throw new Error("Hive daemon failed to start");
}
