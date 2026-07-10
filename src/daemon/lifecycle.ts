import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getHiveHome } from "./db";

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

export async function ensureStarted(): Promise<number> {
  if (await isRunning()) {
    return readDaemonPort() ?? readConfiguredPort();
  }

  cleanupLifecycleFiles();
  const port = readConfiguredPort();
  const cliEntry = resolve(import.meta.dir, "../cli.ts");
  const child = Bun.spawn([process.execPath, cliEntry, "daemon"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      HIVE_HOME: getHiveHome(),
      HIVE_PORT: String(port),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isRunning()) {
      return readDaemonPort() ?? port;
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
