import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { sourceBuildHash } from "../src/daemon/handshake";
import {
  DAEMON_STARTUP_PREFIX,
  formatDaemonStartupAnnouncement,
  parseDaemonStartupAnnouncement,
  type DaemonStartupAnnouncement,
} from "../src/daemon/startup-announcement";

export function assertBinaryFreshness(
  binaryPath: string,
  builtSourceHash: string,
  currentSourceHash: string,
): void {
  if (builtSourceHash === currentSourceHash) return;
  throw new Error(
    `make run: stale running binary ${binaryPath}: built from source ` +
      `${builtSourceHash.slice(0, 8)}, current source is ${currentSourceHash.slice(0, 8)}`,
  );
}

function daemonIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function exitedDaemonError(logPath: string, contents: string): Error {
  const detail = contents.trim().split("\n").filter(Boolean).at(-1);
  return new Error(
    detail === undefined
      ? `make run: daemon exited before startup; ${logPath} is empty`
      : `make run: daemon exited before startup: ${detail}`,
  );
}

export async function observeAnnouncement(
  logPath: string,
  daemonPid: number,
  timeoutMs = 10_000,
): Promise<DaemonStartupAnnouncement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const contents = await readFile(logPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const line = contents.split("\n").find((candidate) =>
      candidate.startsWith(DAEMON_STARTUP_PREFIX)
    );
    if (line !== undefined) {
      const announcement = parseDaemonStartupAnnouncement(line);
      if (announcement === null) {
        throw new Error(`make run: malformed daemon startup announcement in ${logPath}`);
      }
      return announcement;
    }
    if (!daemonIsRunning(daemonPid)) {
      throw exitedDaemonError(logPath, contents);
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `make run: did not observe the daemon startup announcement in ${logPath} within ${timeoutMs}ms`,
  );
}

export async function verifyDevRun(
  logPath: string,
  expectedBinary: string,
  repoRoot: string,
  daemonPid: number,
): Promise<void> {
  const announcement = await observeAnnouncement(logPath, daemonPid);
  const [runningBinary, stagedBinary, currentSourceHash] = await Promise.all([
    realpath(announcement.binaryPath),
    realpath(expectedBinary),
    sourceBuildHash(join(repoRoot, "src")),
  ]);
  if (runningBinary !== stagedBinary) {
    throw new Error(
      `make run: daemon announced binary ${runningBinary}, expected staged binary ${stagedBinary}`,
    );
  }
  assertBinaryFreshness(runningBinary, announcement.sourceHash, currentSourceHash);
  console.log(formatDaemonStartupAnnouncement({
    ...announcement,
    binaryPath: runningBinary,
  }));
  console.log(
    `make run: staged source ${currentSourceHash.slice(0, 8)} matches the running binary`,
  );
}

if (import.meta.main) {
  const [logPath, expectedBinary, repoRoot, daemonPidRaw] = process.argv.slice(2);
  const daemonPid = Number(daemonPidRaw);
  if (
    logPath === undefined || expectedBinary === undefined || repoRoot === undefined ||
    !Number.isSafeInteger(daemonPid) || daemonPid <= 0
  ) {
    console.error(
      "usage: verify-dev-run <startup-log> <expected-binary> <repo-root> <daemon-pid>",
    );
    process.exitCode = 2;
  } else {
    await verifyDevRun(logPath, expectedBinary, repoRoot, daemonPid).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
