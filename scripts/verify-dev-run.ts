import { readFile, realpath } from "node:fs/promises";
import { sourceBuildHash } from "../src/daemon/handshake";
import { readDaemonPort } from "../src/daemon/lifecycle";
import {
  fetchMemoryEmbeddingsStatus,
  recallMemory,
  type MemoryEmbeddingsStatus,
} from "../src/cli/mcp";
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
  devHome?: string,
): Promise<void> {
  const announcement = await observeAnnouncement(logPath, daemonPid);
  const [runningBinary, stagedBinary, currentSourceHash] = await Promise.all([
    realpath(announcement.binaryPath),
    realpath(expectedBinary),
    sourceBuildHash(repoRoot),
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
  if (devHome !== undefined) {
    await verifyMemoryLeg(devHome);
  }
}

/**
 * The D1 guard for `make run`: the dev daemon must come up with the FULL
 * memory system, never silently FTS-only. The embedding service loads its
 * model lazily, so a live `memory_recall` through the daemon is the probe —
 * it dynamic-imports the external runtime bundle, loads the model, and
 * embeds the query. Afterwards hive_status's memory.embeddings section must
 * read "ready"; anything else (embedding-runtime-missing, disabled, …)
 * fails the run with the daemon's own detail.
 */
export async function verifyMemoryLeg(devHome: string): Promise<void> {
  // readDaemonPort and the operator credential both resolve per-HIVE_HOME.
  process.env.HIVE_HOME = devHome;
  const port = readDaemonPort();
  if (port === null) {
    throw new Error(`make run: no daemon port file under ${devHome}`);
  }
  const before = await fetchMemoryEmbeddingsStatus(port);
  if (before.state === "disabled") {
    throw new Error(
      "make run: the dev daemon reports memory.embeddings state \"disabled\" — " +
        (before.detail ?? "the semantic leg is not wired") +
        "; refusing to run a dev daemon without the full memory system (defect D1)",
    );
  }
  await recallMemory(port, "hive dev run semantic leg probe");
  const after = await fetchMemoryEmbeddingsStatus(port);
  if (after.state !== "ready") {
    throw new Error(
      `make run: memory.embeddings state is "${after.state}" after a live recall probe` +
        (after.detail === undefined ? "" : `: ${after.detail}`) +
        " — refusing to run a dev daemon without the semantic leg (defect D1)",
    );
  }
  console.log(
    "make run: memory.embeddings " + formatMemoryEmbeddingsStatus(after),
  );
}

function formatMemoryEmbeddingsStatus(status: MemoryEmbeddingsStatus): string {
  const vectors = status.vectors === undefined
    ? "vectors unknown"
    : `vectors=${status.vectors.total} (${status.vectors.articles} articles, ${status.vectors.facts} facts)`;
  return `state=${status.state} provider=${status.provider ?? "?"} ` +
    `model=${status.model ?? "?"} ${vectors}`;
}

if (import.meta.main) {
  const [logPath, expectedBinary, repoRoot, daemonPidRaw, devHome] = process.argv.slice(2);
  const daemonPid = Number(daemonPidRaw);
  if (
    logPath === undefined || expectedBinary === undefined || repoRoot === undefined ||
    !Number.isSafeInteger(daemonPid) || daemonPid <= 0
  ) {
    console.error(
      "usage: verify-dev-run <startup-log> <expected-binary> <repo-root> <daemon-pid> [dev-home]",
    );
    process.exitCode = 2;
  } else {
    await verifyDevRun(logPath, expectedBinary, repoRoot, daemonPid, devHome).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
