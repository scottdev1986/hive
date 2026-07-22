import { readFile, realpath, stat } from "node:fs/promises";
import {
  DAEMON_STARTUP_PREFIX,
  formatDaemonStartupAnnouncement,
  parseDaemonStartupAnnouncement,
  type DaemonStartupAnnouncement,
} from "../src/daemon/startup-announcement";

const timestamp = (milliseconds: number): string =>
  new Date(milliseconds).toISOString();

export function assertBinaryFreshness(
  binaryPath: string,
  binaryMtimeMs: number,
  headCommitTimeMs: number,
): void {
  if (binaryMtimeMs >= headCommitTimeMs) return;
  throw new Error(
    `make run: stale running binary ${binaryPath}: binary mtime ` +
      `${timestamp(binaryMtimeMs)} predates HEAD commit time ` +
      `${timestamp(headCommitTimeMs)}`,
  );
}

async function observeAnnouncement(
  logPath: string,
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
    await Bun.sleep(25);
  }
  throw new Error(
    `make run: did not observe the daemon startup announcement in ${logPath} within ${timeoutMs}ms`,
  );
}

async function headCommitTime(repoRoot: string): Promise<number> {
  const child = Bun.spawn(["git", "show", "-s", "--format=%ct", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const seconds = Number(stdout.trim());
  if (exitCode !== 0 || !Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(
      `make run: could not read HEAD commit time${
        stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`
      }`,
    );
  }
  return seconds * 1_000;
}

export async function verifyDevRun(
  logPath: string,
  expectedBinary: string,
  repoRoot: string,
): Promise<void> {
  const announcement = await observeAnnouncement(logPath);
  const [runningBinary, stagedBinary, headTime] = await Promise.all([
    realpath(announcement.binaryPath),
    realpath(expectedBinary),
    headCommitTime(repoRoot),
  ]);
  if (runningBinary !== stagedBinary) {
    throw new Error(
      `make run: daemon announced binary ${runningBinary}, expected staged binary ${stagedBinary}`,
    );
  }
  const binaryMtime = (await stat(runningBinary)).mtimeMs;
  assertBinaryFreshness(runningBinary, binaryMtime, headTime);
  console.log(formatDaemonStartupAnnouncement({
    ...announcement,
    binaryPath: runningBinary,
  }));
  console.log(
    `make run: binary mtime ${timestamp(binaryMtime)}; HEAD commit time ${timestamp(headTime)}`,
  );
}

if (import.meta.main) {
  const [logPath, expectedBinary, repoRoot] = process.argv.slice(2);
  if (logPath === undefined || expectedBinary === undefined || repoRoot === undefined) {
    console.error("usage: verify-dev-run <startup-log> <expected-binary> <repo-root>");
    process.exitCode = 2;
  } else {
    await verifyDevRun(logPath, expectedBinary, repoRoot).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
