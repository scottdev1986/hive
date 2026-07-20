/**
 * Production owner of the `hive-sessiond serve` broker process.
 *
 * The broker authenticates exactly one daemon-lock identity, so the daemon
 * that holds `$HIVE_HOME/daemon.lock` must spawn and supervise the broker.
 * Until this module existed, only the b22 proof harness ever started a broker
 * — the staged app's terminal panes could not render live content.
 *
 * Crash recovery is bounded: a dead broker is restarted a fixed number of
 * times inside a sliding window, then the supervisor fails visibly. Infinite
 * retry is never acceptable (issue #37).
 *
 * Adoption of a broker left running by a previous daemon is deliberately
 * carved out: taking over an existing process without killing live sessions
 * needs broker-PID evidence and peer-identity proof beyond flock, which is a
 * separate design. A restarting daemon always spawns a fresh broker under its
 * current lock; an orphan holding `broker.lock` fails startup visibly.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getHiveHome } from "./db";
import {
  currentLink,
  installRoot,
  sessiondPath,
} from "../update/paths";
import { IS_RELEASE_BUILD } from "../version";

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 50;

export type SessiondBrokerState = "stopped" | "starting" | "running" | "failed";

export interface ResolveSessiondBinaryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly repoRoot?: string;
  readonly installRoot?: string;
  readonly isReleaseBuild?: boolean;
}

/** Locate the staged or development `hive-sessiond` binary. */
export function resolveSessiondBinary(
  options: ResolveSessiondBinaryOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const override = env.HIVE_SESSIOND_BIN?.trim();
  if (override !== undefined && override !== "" && isExecutable(override)) {
    return resolve(override);
  }

  const execPath = options.execPath ?? process.execPath;
  const sibling = join(dirname(execPath), "hive-sessiond");
  if (isExecutable(sibling)) return sibling;

  const root = options.installRoot ?? installRoot();
  const staged = sessiondPath(currentLink(root));
  if (isExecutable(staged)) return staged;

  const isRelease = options.isReleaseBuild ?? IS_RELEASE_BUILD;
  if (!isRelease) {
    const repoRoot = options.repoRoot ?? process.cwd();
    const dev = join(repoRoot, "native/sessiond/zig-out/bin/hive-sessiond");
    if (isExecutable(dev)) return dev;
  }

  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function brokerSocketPath(hiveHome = getHiveHome()): string {
  return join(hiveHome, "runtime", "sessiond", "broker.sock");
}

export function brokerLockPath(hiveHome = getHiveHome()): string {
  return join(hiveHome, "runtime", "sessiond", "broker.lock");
}

/** Line the broker prints to stdout only after exclusive flock succeeds. */
export const BROKER_OWNER_ANNOUNCE_PREFIX = "hive-sessiond-owner ";

/**
 * Pid stamped into broker.lock after exclusive flock (not mere open).
 * macOS lsof cannot report flock holders (empty lock field even with LOCK_EX),
 * so this content is only meaningful together with the child's ownership
 * announcement — open-without-flock does not write it.
 */
export function readBrokerLockFilePid(hiveHome: string): number | null {
  const lockPath = brokerLockPath(hiveHome);
  if (!existsSync(lockPath)) return null;
  try {
    const text = readFileSync(lockPath, "utf8").trim();
    if (text === "") return null;
    const pid = Number(text.split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Parse lsof -F lock-status for an EXCLUSIVE holder only.
 * FD forms like `3uW` / lock field `W`/`w`/`x`/`X` mean exclusive write lock.
 * A bare open (`3u`, empty lock field) is NOT ownership — horace's probe.
 * On current macOS, flock holders often produce an empty lock field; callers
 * must not treat "any open" as exclusive.
 */
export function parseLsofExclusiveLockHolder(lsofFOutput: string): number | null {
  let currentPid: number | null = null;
  for (const rawLine of lsofFOutput.split("\n")) {
    const line = rawLine.replace(/\0/g, "");
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      currentPid = Number.isFinite(pid) && pid > 0 ? pid : null;
      continue;
    }
    if (currentPid === null) continue;
    // Lock field: lW / lw / lX / lx (full-file or partial exclusive).
    if (line.startsWith("l")) {
      const lock = line.slice(1).trim();
      if (lock !== "" && /[WwXx]/.test(lock)) return currentPid;
      continue;
    }
    // FD field: 3uW / 7uW — W suffix is exclusive lock in lsof's FD column.
    if (line.startsWith("f")) {
      const fd = line.slice(1);
      if (/[WwXx]/.test(fd)) return currentPid;
    }
  }
  return null;
}

/** Best-effort exclusive flock holder via lsof -F (null when not reported). */
export function readLsofExclusiveLockHolderPid(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null;
  try {
    const result = Bun.spawnSync(["lsof", "-F", "pfnl", lockPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    const text = new TextDecoder().decode(result.stdout);
    return parseLsofExclusiveLockHolder(text);
  } catch {
    return null;
  }
}

/**
 * Who holds exclusive broker.lock ownership evidence for this home.
 *
 * Order (adversarial — each alone is insufficient):
 * 1. lsof exclusive lock-status when the platform reports it (W / lock field)
 * 2. else pid stamped into the lock file AFTER exclusive flock by hive-sessiond
 *
 * Open-without-flock never updates the stamp and never gets a W marker, so it
 * cannot satisfy the ready gate. A supervisor try-lock is intentionally NOT
 * used: it would race the child's own exclusive acquisition.
 */
export function readBrokerLockHolderPid(hiveHome: string): number | null {
  const lockPath = brokerLockPath(hiveHome);
  if (!existsSync(lockPath)) return null;
  const fromLsof = readLsofExclusiveLockHolderPid(lockPath);
  if (fromLsof !== null) return fromLsof;
  return readBrokerLockFilePid(hiveHome);
}

function startupExitError(
  hiveHome: string,
  exitCode: number,
  socketExistedBeforeSpawn: boolean,
  readLockHolder: (hiveHome: string) => number | null = readBrokerLockHolderPid,
): Error {
  const holder = readLockHolder(hiveHome);
  // Pre-existing socket or a live lock holder means we never owned the broker
  // (orphan / BrokerAlreadyRunning). Name the holder when it can be measured.
  if (socketExistedBeforeSpawn || holder !== null) {
    if (holder !== null) {
      return new Error(
        `hive-sessiond serve exited ${exitCode} before becoming the live broker: ` +
          `broker.lock held by pid ${holder}`,
      );
    }
    return new Error(
      `hive-sessiond serve exited ${exitCode} before becoming the live broker ` +
        `(could not acquire exclusive broker.lock — another process owns the ` +
        `sessiond broker for this HIVE_HOME)`,
    );
  }
  return new Error(
    `hive-sessiond serve exited ${exitCode} before broker.sock appeared`,
  );
}

/**
 * Watch child stdout for `hive-sessiond-owner <pid>` — printed only after the
 * real binary takes exclusive flock. Open-without-flock fakes never emit it.
 */
export function watchBrokerOwnerAnnouncement(
  stdout: ReadableStream<Uint8Array> | null | undefined,
  expectedPid: number,
): { readonly confirmed: () => boolean; readonly stop: () => void } {
  let confirmed = false;
  let stopped = false;
  if (stdout == null) {
    return {
      confirmed: () => false,
      stop: () => {
        stopped = true;
      },
    };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stdout.getReader();
  void (async () => {
    try {
      while (!stopped && !confirmed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith(BROKER_OWNER_ANNOUNCE_PREFIX)) continue;
          const pid = Number(line.slice(BROKER_OWNER_ANNOUNCE_PREFIX.length).trim());
          if (pid === expectedPid) {
            confirmed = true;
            break;
          }
        }
      }
    } catch {
      // stream closed on kill
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  })();
  return {
    confirmed: () => confirmed,
    stop: () => {
      stopped = true;
      try {
        reader.cancel().catch(() => undefined);
      } catch {
        // ignore
      }
    },
  };
}

export interface SessiondBrokerSupervisorOptions {
  readonly binary: string;
  readonly hiveHome: string;
  /** Restarts allowed inside `restartWindowMs` before fatal failure. Default 3. */
  readonly maxRestarts?: number;
  /** Sliding window for counting restarts. Default 60s. */
  readonly restartWindowMs?: number;
  /** How long to wait for broker.sock after spawn. Default 10s. */
  readonly readyTimeoutMs?: number;
  /** How long to wait for a graceful SIGTERM before SIGKILL. Default 5s. */
  readonly stopTimeoutMs?: number;
  /** Called once when bounded restart is exhausted (never infinite). */
  readonly onFatal?: (error: Error) => void;
  /** Test seam: spawn a process. Defaults to Bun.spawn (stdout piped for owner announce). */
  readonly spawn?: (
    command: string[],
    options: {
      cwd?: string;
      env: NodeJS.ProcessEnv;
      stdin: "ignore";
      stdout: "pipe" | "ignore";
      stderr: "inherit" | "ignore";
    },
  ) => SubprocessLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly socketExists?: (path: string) => boolean;
  /**
   * Who holds exclusive broker.lock evidence (lsof W / lock-file pid stamp).
   * Ready also requires the child's stdout ownership announcement — neither
   * alone is enough; open-without-flock satisfies neither on a real binary.
   */
  readonly readLockHolder?: (hiveHome: string) => number | null;
}

/** Minimal process surface so tests can inject fakes without Bun types. */
export interface SubprocessLike {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
  /** Piped stdout for `hive-sessiond-owner <pid>` after exclusive flock. */
  readonly stdout?: ReadableStream<Uint8Array> | null;
}

export class SessiondBrokerSupervisor {
  private readonly binary: string;
  private readonly hiveHome: string;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly onFatal: ((error: Error) => void) | null;
  private readonly spawnImpl: NonNullable<SessiondBrokerSupervisorOptions["spawn"]>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly socketExists: (path: string) => boolean;
  private readonly readLockHolder: (hiveHome: string) => number | null;

  private child: SubprocessLike | null = null;
  private state: SessiondBrokerState = "stopped";
  private stopping = false;
  private restartAt: number[] = [];
  private superviseGeneration = 0;

  constructor(options: SessiondBrokerSupervisorOptions) {
    this.binary = options.binary;
    this.hiveHome = options.hiveHome;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.restartWindowMs = options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.onFatal = options.onFatal ?? null;
    this.spawnImpl = options.spawn ?? ((command, spawnOptions) =>
      Bun.spawn(command, spawnOptions) as SubprocessLike);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.socketExists = options.socketExists ?? ((path) => existsSync(path));
    this.readLockHolder = options.readLockHolder ?? readBrokerLockHolderPid;
  }

  get status(): SessiondBrokerState {
    return this.state;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Spawn the broker and wait until the owned child holds broker.lock and
   * broker.sock is present. Call only while holding the daemon lock for `hiveHome`.
   */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("sessiond broker supervisor is already started");
    }
    this.stopping = false;
    this.state = "starting";
    this.restartAt = [];
    try {
      await this.spawnAndWaitReady();
      this.state = "running";
      this.watchExits();
    } catch (error) {
      this.state = "failed";
      await this.killChild();
      throw error;
    }
  }

  /** SIGTERM the owned broker, escalate to SIGKILL if needed. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.superviseGeneration += 1;
    await this.killChild();
    this.state = "stopped";
  }

  private async spawnAndWaitReady(): Promise<void> {
    const socket = brokerSocketPath(this.hiveHome);
    // An orphan broker leaves broker.sock in place. Socket presence alone is
    // not ownership. Positive ownership is the AND of:
    //   (1) child stdout announced hive-sessiond-owner <child.pid> (only after
    //       exclusive flock in the real binary — never on open-without-flock)
    //   (2) lock-holder evidence for child.pid (lsof exclusive W when reported,
    //       else pid stamp written under exclusive flock)
    // Elapsed time never resolves ready. Supervisor never try-locks: that races
    // the child's exclusive acquisition.
    const socketExistedBeforeSpawn = this.socketExists(socket);

    const child = this.spawnImpl([this.binary, "serve"], {
      env: {
        ...process.env,
        HIVE_HOME: this.hiveHome,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    this.child = child;

    const announcement = watchBrokerOwnerAnnouncement(child.stdout, child.pid);
    try {
      const deadline = this.now() + this.readyTimeoutMs;
      while (this.now() < deadline) {
        if (child.exitCode !== null) {
          throw startupExitError(
            this.hiveHome,
            child.exitCode,
            socketExistedBeforeSpawn,
            this.readLockHolder,
          );
        }
        if (
          this.socketExists(socket) &&
          announcement.confirmed() &&
          this.readLockHolder(this.hiveHome) === child.pid
        ) {
          return;
        }
        await this.sleep(READY_POLL_MS);
      }
      if (child.exitCode !== null) {
        throw startupExitError(
          this.hiveHome,
          child.exitCode,
          socketExistedBeforeSpawn,
          this.readLockHolder,
        );
      }
      const holder = this.readLockHolder(this.hiveHome);
      if (!announcement.confirmed()) {
        throw new Error(
          `hive-sessiond serve did not announce exclusive ownership within ` +
            `${this.readyTimeoutMs}ms (spawned child pid ${child.pid}` +
            (holder !== null && holder !== child.pid
              ? `; broker.lock evidence held by pid ${holder}`
              : "") +
            `)`,
        );
      }
      if (holder !== null && holder !== child.pid) {
        throw new Error(
          `hive-sessiond serve did not own broker.lock within ${this.readyTimeoutMs}ms: ` +
            `broker.lock held by pid ${holder} (spawned child pid ${child.pid})`,
        );
      }
      if (!this.socketExists(socket)) {
        throw new Error(
          `hive-sessiond serve did not create ${socket} within ${this.readyTimeoutMs}ms`,
        );
      }
      throw new Error(
        `hive-sessiond serve did not own broker.lock within ${this.readyTimeoutMs}ms ` +
          `(spawned child pid ${child.pid}; lock holder unknown)`,
      );
    } finally {
      announcement.stop();
    }
  }

  private watchExits(): void {
    const child = this.child;
    if (child === null) return;
    const generation = this.superviseGeneration;
    void child.exited.then((code) => {
      void this.onChildExit(child, code, generation);
    });
  }

  private async onChildExit(
    child: SubprocessLike,
    code: number,
    generation: number,
  ): Promise<void> {
    if (generation !== this.superviseGeneration) return;
    if (this.stopping) return;
    if (this.child !== child) return;

    this.child = null;
    const now = this.now();
    this.restartAt = this.restartAt.filter(
      (at) => now - at < this.restartWindowMs,
    );

    if (this.restartAt.length >= this.maxRestarts) {
      const error = new Error(
        `sessiond broker crashed repeatedly (exit ${code}); ` +
          `gave up after ${this.maxRestarts} restarts in ${this.restartWindowMs}ms`,
      );
      this.state = "failed";
      console.error(error.message);
      this.onFatal?.(error);
      return;
    }

    this.restartAt.push(now);
    this.state = "starting";
    console.error(
      `sessiond broker exited ${code}; restarting ` +
        `(${this.restartAt.length}/${this.maxRestarts} in window)`,
    );
    try {
      await this.spawnAndWaitReady();
      if (this.stopping || generation !== this.superviseGeneration) {
        await this.killChild();
        return;
      }
      this.state = "running";
      this.watchExits();
    } catch (error) {
      const failure = error instanceof Error
        ? error
        : new Error(String(error));
      this.state = "failed";
      console.error(`sessiond broker restart failed: ${failure.message}`);
      this.onFatal?.(failure);
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    if (child.exitCode !== null) return;

    try {
      child.kill("SIGTERM");
    } catch {
      // already reaped
    }

    const deadline = this.now() + this.stopTimeoutMs;
    while (this.now() < deadline) {
      if (child.exitCode !== null) return;
      await this.sleep(READY_POLL_MS);
    }
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already reaped
      }
      await Promise.race([
        child.exited,
        this.sleep(1_000),
      ]);
    }
  }
}
