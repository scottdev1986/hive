import { dlopen, FFIType, suffix } from "bun:ffi";
import { accessSync, constants } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  currentLink,
  installRoot,
  sessiondPath,
} from "../../update-service/paths";
import { IS_RELEASE_BUILD } from "../../shared/version";

const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;

export interface ResolveSessiondBinaryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly repoRoot?: string;
  readonly installRoot?: string;
  readonly isReleaseBuild?: boolean;
}

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
  const loaded = dlopen(`libc.${suffix}`, {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  libcSingleton = {
    symbols: {
      getsockopt: (fd, level, optname, optval, optlen) =>
        loaded.symbols.getsockopt(fd, level, optname, optval, optlen),
    },
  };
  return libcSingleton;
}

export function socketFileDescriptor(socket: Socket): number {
  const handle = "_handle" in socket ? socket._handle : undefined;
  const fd =
    handle !== null &&
    handle !== undefined &&
    typeof handle === "object" &&
    "fd" in handle
      ? handle.fd
      : undefined;
  if (typeof fd !== "number" || fd < 0) {
    throw new Error(
      "connected socket has no usable file descriptor for LOCAL_PEERPID",
    );
  }
  return fd;
}

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

export function connectUnixSocket(
  path: string,
  timeoutMs = 500,
): Promise<Socket> {
  // Stale AF_UNIX paths can hang connect() until the process is killed.
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
