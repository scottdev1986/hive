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
 * Ready-proof is kernel-bound on the service resource itself: the supervisor
 * connects to broker.sock, reads LOCAL_PEERPID (macOS), requires that peer
 * equals the spawned child pid, and completes HELLO on that same connection.
 * Self-authored evidence (settle time, lsof openers, lock-file stamps,
 * stdout announces) is not ready-evidence — broker.lock remains the broker's
 * internal mutual exclusion only.
 *
 * Adoption of a broker left running by a previous daemon is deliberately
 * carved out: a restarting daemon always spawns a fresh broker under its
 * current lock; a foreign peer on broker.sock fails startup visibly.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";
import { getHiveHome } from "./db";
import {
  expectedDaemonHandshake,
  type DaemonHandshake,
} from "./handshake";
import {
  SessiondSocketClient,
} from "./session-host/sessiond-host";
import {
  HelloPayloadSchema,
  SESSION_PROTOCOL_MINOR_RANGE,
  SESSION_PROTOCOL_VERSION,
  WelcomePayloadSchema,
} from "../schemas/session-protocol";
import {
  currentLink,
  installRoot,
  sessiondPath,
} from "../update/paths";
import { IS_RELEASE_BUILD } from "../version";

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
// Every hosted terminal has already been terminated before the broker stops.
// The broker owns no remaining conversation to drain, so a short grace period
// is enough to reap an ordinary exit without making application shutdown wait
// five seconds on a wedged broker.
const DEFAULT_STOP_TIMEOUT_MS = 500;
const READY_POLL_MS = 50;

/** Darwin sys/un.h — measured: SOL_LOCAL=0, LOCAL_PEERPID=0x002. */
const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;

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

// --- kernel peer-pid (ready evidence) ---------------------------------------

type Libc = {
  readonly symbols: {
    readonly getsockopt: (
      fd: number,
      level: number,
      optname: number,
      optval: Int32Array | Uint32Array,
      optlen: Uint32Array,
    ) => number;
  };
};

let libcSingleton: Libc | null = null;

function libc(): Libc {
  if (libcSingleton !== null) return libcSingleton;
  libcSingleton = dlopen(`libc.${suffix}`, {
    getsockopt: {
      args: [
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  }) as unknown as Libc;
  return libcSingleton;
}

/** Extract the OS fd from a connected node/Bun net.Socket (Bun: _handle.fd). */
export function socketFileDescriptor(socket: Socket): number {
  const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  if (typeof fd !== "number" || fd < 0) {
    throw new Error("connected socket has no usable file descriptor for LOCAL_PEERPID");
  }
  return fd;
}

/**
 * Kernel peer pid for a connected AF_UNIX socket (macOS LOCAL_PEERPID).
 * Measured: against hive-sessiond serve, peer equals the broker process pid.
 */
export function readLocalPeerPid(fd: number): number {
  const peer = new Int32Array(1);
  const len = new Uint32Array([4]);
  const rc = libc().symbols.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, peer, len);
  if (rc !== 0) {
    throw new Error(
      `LOCAL_PEERPID unavailable (getsockopt returned ${rc})`,
    );
  }
  const peerPid = peer[0] ?? 0;
  const peerLen = len[0] ?? 0;
  if (peerLen !== 4 || peerPid <= 0) {
    throw new Error(
      `LOCAL_PEERPID returned invalid pid ${peerPid} (len=${peerLen})`,
    );
  }
  return peerPid;
}

/** Connect with a hard timeout — a stale broker.sock after SIGKILL can otherwise
 * hang connect() until the process is killed, blocking crash recovery forever. */
export function connectUnixSocket(
  path: string,
  timeoutMs = 500,
): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolveSocket(socket);
    });
  });
}

export interface ProveBrokerReadyOptions {
  readonly socketPath: string;
  readonly expectedChildPid: number;
  readonly handshake: DaemonHandshake;
}

/**
 * Kernel-bound ready-proof on the live service resource:
 *   connect(broker.sock) ∧ LOCAL_PEERPID === child.pid ∧ HELLO/WELCOME on that connection.
 * A foreign process that bound the socket fails the peer-pid match.
 */
export async function proveSessiondBrokerReady(
  options: ProveBrokerReadyOptions,
): Promise<void> {
  let socket: Socket;
  try {
    socket = await connectUnixSocket(options.socketPath);
  } catch (error) {
    throw new Error(
      `could not connect to ${options.socketPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  let peerPid: number;
  try {
    peerPid = readLocalPeerPid(socketFileDescriptor(socket));
  } catch (error) {
    socket.destroy();
    throw error;
  }

  if (peerPid !== options.expectedChildPid) {
    socket.destroy();
    throw new Error(
      `broker.sock kernel peer pid ${peerPid} is not the owned child ` +
        `${options.expectedChildPid}`,
    );
  }

  const client = new SessiondSocketClient(socket);
  try {
    const hello = HelloPayloadSchema.parse({
      schemaVersion: 1,
      buildId: options.handshake.buildHash,
      instanceId: options.handshake.instanceId,
      protocol: {
        major: SESSION_PROTOCOL_VERSION.major,
        minMinor: SESSION_PROTOCOL_MINOR_RANGE.min,
        maxMinor: SESSION_PROTOCOL_MINOR_RANGE.max,
      },
      clientRole: "daemon",
      daemonControl: {
        productVersion: options.handshake.productVersion,
        buildHash: options.handshake.buildHash,
        wireProtocol: options.handshake.wireProtocol,
        schemaEpoch: options.handshake.schemaEpoch,
        instanceId: options.handshake.instanceId,
        hiveUuid: options.handshake.hiveUuid,
        identityKey: options.handshake.identityKey,
        repoFamilyKey: options.handshake.repoFamilyKey,
      },
    });
    const welcome = await client.request({
      requestType: "HELLO",
      responseType: "WELCOME",
      payload: hello,
      responseSchema: WelcomePayloadSchema,
    });
    if (
      welcome.endpointRole !== "broker" ||
      welcome.instanceId !== options.handshake.instanceId ||
      welcome.protocol.major !== SESSION_PROTOCOL_VERSION.major ||
      welcome.protocol.minor < SESSION_PROTOCOL_MINOR_RANGE.min ||
      welcome.protocol.minor > SESSION_PROTOCOL_MINOR_RANGE.max
    ) {
      throw new Error("sessiond broker WELCOME does not match this daemon");
    }
  } finally {
    client.close();
  }
}

function startupExitError(
  exitCode: number,
  expectedChildPid: number,
  lastReadyError: string | null,
): Error {
  const detail = lastReadyError !== null ? ` (last ready error: ${lastReadyError})` : "";
  return new Error(
    `hive-sessiond serve exited ${exitCode} before kernel peer ownership of ` +
      `broker.sock was proven for child pid ${expectedChildPid}${detail}`,
  );
}

export interface SessiondBrokerSupervisorOptions {
  readonly binary: string;
  readonly hiveHome: string;
  /** Restarts allowed inside `restartWindowMs` before fatal failure. Default 3. */
  readonly maxRestarts?: number;
  /** Sliding window for counting restarts. Default 60s. */
  readonly restartWindowMs?: number;
  /** How long to wait for kernel-ready proof after spawn. Default 10s. */
  readonly readyTimeoutMs?: number;
  /** How long to wait for a graceful SIGTERM before SIGKILL. Default 500ms. */
  readonly stopTimeoutMs?: number;
  /** Called once when bounded restart is exhausted (never infinite). */
  readonly onFatal?: (error: Error) => void;
  /** Repo root for expectedDaemonHandshake when using default proveReady. */
  readonly repoRoot?: string;
  /** Handshake for HELLO on the peer-proven connection. */
  readonly handshake?: () => Promise<DaemonHandshake>;
  /**
   * Ready-proof seam. Defaults to connect + LOCAL_PEERPID + HELLO.
   * Injected in unit tests so compositions reject without a real kernel peer.
   */
  readonly proveReady?: (args: {
    socketPath: string;
    childPid: number;
  }) => Promise<void>;
  /** Test seam: spawn a process. Defaults to Bun.spawn. */
  readonly spawn?: (
    command: string[],
    options: {
      cwd?: string;
      env: NodeJS.ProcessEnv;
      stdin: "ignore";
      stdout: "ignore" | "pipe";
      stderr: "inherit" | "ignore";
    },
  ) => SubprocessLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly socketExists?: (path: string) => boolean;
}

/** Minimal process surface so tests can inject fakes without Bun types. */
export interface SubprocessLike {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
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
  private readonly proveReady: (args: {
    socketPath: string;
    childPid: number;
  }) => Promise<void>;

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

    const handshake =
      options.handshake ??
      (() => expectedDaemonHandshake(options.repoRoot ?? process.cwd()));
    this.proveReady = options.proveReady ?? (async ({ socketPath, childPid }) => {
      await proveSessiondBrokerReady({
        socketPath,
        expectedChildPid: childPid,
        handshake: await handshake(),
      });
    });
  }

  get status(): SessiondBrokerState {
    return this.state;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Spawn the broker and wait until kernel peer-pid on broker.sock equals the
   * child and HELLO succeeds on that connection.
   * Call only while holding the daemon lock, after the daemon is listening
   * (HELLO authenticates against daemon.lock + GET /handshake).
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
    const child = this.spawnImpl([this.binary, "serve"], {
      env: {
        ...process.env,
        HIVE_HOME: this.hiveHome,
      },
      stdin: "ignore",
      // Owner-announce line (if present) is debug only — not ready-evidence.
      stdout: "ignore",
      stderr: "inherit",
    });
    this.child = child;

    let lastReadyError: string | null = null;
    const deadline = this.now() + this.readyTimeoutMs;
    while (this.now() < deadline) {
      if (child.exitCode !== null) {
        throw startupExitError(child.exitCode, child.pid, lastReadyError);
      }
      if (this.socketExists(socket)) {
        try {
          await this.proveReady({ socketPath: socket, childPid: child.pid });
          return;
        } catch (error) {
          // Peer-mismatch, connect timeout on a stale sock, HELLO not-ready:
          // all are retryable until the ready deadline. A foreign bind fails
          // the gate for the full window then throws with lastReadyError;
          // a just-killed broker's stale sock must not abort crash recovery.
          lastReadyError = error instanceof Error ? error.message : String(error);
        }
      }
      await this.sleep(READY_POLL_MS);
    }
    if (child.exitCode !== null) {
      throw startupExitError(child.exitCode, child.pid, lastReadyError);
    }
    throw new Error(
      `hive-sessiond serve did not prove kernel ownership of ${socket} ` +
        `for child pid ${child.pid} within ${this.readyTimeoutMs}ms` +
        (lastReadyError !== null ? ` (last ready error: ${lastReadyError})` : ""),
    );
  }

  private watchExits(): void {
    const child = this.child;
    if (child === null) return;
    const generation = this.superviseGeneration;
    void child.exited.then((code) => {
      void this.onChildExit(child, code, generation);
    });
    // Backup poll: an external SIGKILL must restart the broker even if the
    // platform is slow to settle the Subprocess.exited promise (staged crash
    // recovery was observed to hang with a dead child and no respawn).
    void (async () => {
      while (
        this.child === child &&
        generation === this.superviseGeneration &&
        !this.stopping
      ) {
        if (child.exitCode !== null) {
          void this.onChildExit(child, child.exitCode, generation);
          return;
        }
        await this.sleep(READY_POLL_MS);
      }
    })();
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
