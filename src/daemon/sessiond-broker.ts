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

import { dlopen, FFIType, suffix } from "bun:ffi";
import { accessSync, constants } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { currentLink, installRoot, sessiondPath } from "../update/paths";
import { IS_RELEASE_BUILD } from "../version";
import { getHiveHome } from "./db";
import type { DaemonHandshake } from "./handshake";

const _DEFAULT_MAX_RESTARTS = 3;
const _DEFAULT_RESTART_WINDOW_MS = 60_000;
const _DEFAULT_READY_TIMEOUT_MS = 10_000;
// Every hosted terminal has already been terminated before the broker stops.
// The broker owns no remaining conversation to drain, so a short grace period
// is enough to reap an ordinary exit without making application shutdown wait
// five seconds on a wedged broker.
const _DEFAULT_STOP_TIMEOUT_MS = 500;
const _READY_POLL_MS = 50;

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
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
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
    throw new Error(
      "connected socket has no usable file descriptor for LOCAL_PEERPID",
    );
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
    throw new Error(`LOCAL_PEERPID unavailable (getsockopt returned ${rc})`);
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

//! The broker process supervisor lived here: spawning `hive-sessiond serve`,
//! proving kernel peer ownership of broker.sock, and restarting it within a
//! bound. Hive launches each terminal host itself now and speaks to it on the
//! host's own sockets, so nothing supervises a broker — what remains is
//! locating the binary and the socket helpers the viewer path still uses.
