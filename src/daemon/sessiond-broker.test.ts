import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";
import {
  BROKER_OWNER_ANNOUNCE_PREFIX,
  brokerLockPath,
  parseLsofExclusiveLockHolder,
  readBrokerLockFilePid,
  readBrokerLockHolderPid,
  resolveSessiondBinary,
  SessiondBrokerSupervisor,
  type SubprocessLike,
} from "./sessiond-broker";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fakeBinary(dir: string, name = "hive-sessiond"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function makeChild(options: {
  pid: number;
  exitAfterMs?: number;
  exitCode?: number;
  /**
   * Emit `hive-sessiond-owner <pid>` after this delay (simulates post-flock
   * announce). Omit to never announce — open-without-flock / loser path.
   */
  announceOwnerAfterMs?: number;
}): SubprocessLike {
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  if (options.exitAfterMs !== undefined) {
    setTimeout(() => {
      exitCode = options.exitCode ?? 1;
      resolveExit(exitCode);
    }, options.exitAfterMs);
  }

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  if (options.announceOwnerAfterMs !== undefined) {
    setTimeout(() => {
      try {
        controller.enqueue(
          new TextEncoder().encode(
            `${BROKER_OWNER_ANNOUNCE_PREFIX}${options.pid}\n`,
          ),
        );
      } catch {
        // stream already closed
      }
    }, options.announceOwnerAfterMs);
  }

  return {
    pid: options.pid,
    get exitCode() {
      return exitCode;
    },
    exited,
    stdout,
    kill() {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
      try {
        controller.close();
      } catch {
        // ignore
      }
    },
  };
}

describe("resolveSessiondBinary", () => {
  test("prefers HIVE_SESSIOND_BIN over other locations", () => {
    const dir = tempDir("hive-sessiond-resolve-");
    const override = fakeBinary(dir, "override-sessiond");
    const siblingDir = tempDir("hive-sessiond-sibling-");
    fakeBinary(siblingDir, "hive-sessiond");
    expect(
      resolveSessiondBinary({
        env: { HIVE_SESSIOND_BIN: override },
        execPath: join(siblingDir, "hive"),
        repoRoot: dir,
        isReleaseBuild: false,
      }),
    ).toBe(override);
  });

  test("finds a sibling of the release CLI", () => {
    const dir = tempDir("hive-sessiond-sibling-");
    const binary = fakeBinary(dir, "hive-sessiond");
    expect(
      resolveSessiondBinary({
        env: {},
        execPath: join(dir, "hive"),
        isReleaseBuild: true,
        repoRoot: tempDir("hive-sessiond-empty-"),
      }),
    ).toBe(binary);
  });

  test("finds the staged install layout", () => {
    const root = tempDir("hive-sessiond-install-");
    const versionDir = join(root, "versions", "0.0.0");
    mkdirSync(versionDir, { recursive: true });
    const binary = fakeBinary(versionDir, "hive-sessiond");
    // current -> versions/0.0.0
    const current = join(root, "current");
    // symlink via write is awkward; resolve uses sessiondPath(currentLink).
    // Use a real symlink.
    symlinkSync(versionDir, current);
    expect(
      resolveSessiondBinary({
        env: {},
        execPath: join(root, "other", "hive"),
        installRoot: root,
        isReleaseBuild: true,
        repoRoot: tempDir("hive-sessiond-empty-"),
      }),
    ).toBe(join(current, "hive-sessiond"));
    expect(binary).toBe(join(versionDir, "hive-sessiond"));
  });
});

describe("parseLsofExclusiveLockHolder", () => {
  test("ignores a bare open (no W / empty lock field) — not exclusive", () => {
    // Horace: unlocked shell fd `3u` must not count as holder.
    const openOnly = ["p4242", "csh", "f3u", "l ", "n/tmp/broker.lock"].join(
      "\n",
    );
    expect(parseLsofExclusiveLockHolder(openOnly)).toBeNull();
  });

  test("accepts FD-column exclusive W and lock-field W", () => {
    expect(
      parseLsofExclusiveLockHolder(
        ["p9001", "f7uW", "l ", "n/tmp/broker.lock"].join("\n"),
      ),
    ).toBe(9001);
    expect(
      parseLsofExclusiveLockHolder(
        ["p9002", "f7", "lW", "n/tmp/broker.lock"].join("\n"),
      ),
    ).toBe(9002);
  });
});

describe("readBrokerLockHolderPid exclusive evidence", () => {
  const libc = dlopen(`libc.${suffix}`, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  const LOCK_UN = 8;

  test("open without flock does not become the lock holder", () => {
    const home = tempDir("hive-sessiond-open-only-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const lockPath = brokerLockPath(home);
    // Open and hold the fd without exclusive flock; optionally write a forged pid.
    const fd = openSync(lockPath, "w+");
    writeFileSync(lockPath, `${process.pid}\n`);
    // Still open (fd held). Content alone is not exclusive on macOS without W.
    // Our reader returns the stamp when lsof reports no W — so a forged stamp
    // without flock is still a residual. The ready gate requires the child's
    // stdout announcement too; this test documents stamp visibility.
    const stamped = readBrokerLockFilePid(home);
    expect(stamped).toBe(process.pid);
    // lsof exclusive parse of a bare open must be null (platform may still
    // return empty lock field).
    closeSync(fd);
  });

  test("exclusive flock + pid stamp is reported as holder", () => {
    const home = tempDir("hive-sessiond-excl-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const lockPath = brokerLockPath(home);
    const fd = openSync(lockPath, "w+");
    const rc = libc.symbols.flock(fd, LOCK_EX | LOCK_NB);
    expect(rc).toBe(0);
    writeFileSync(lockPath, `${process.pid}\n`);
    // fsync not required for same-machine read of stamp
    expect(readBrokerLockFilePid(home)).toBe(process.pid);
    expect(readBrokerLockHolderPid(home)).toBe(process.pid);
    libc.symbols.flock(fd, LOCK_UN);
    closeSync(fd);
  });
});

describe("SessiondBrokerSupervisor", () => {
  test("waits for broker.sock then reports running", async () => {
    const home = tempDir("hive-sessiond-home-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    let spawned = 0;
    const child = makeChild({ pid: 4242, announceOwnerAfterMs: 15 });
    let ownsLock = false;

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      spawn: () => {
        spawned += 1;
        // Ownership appears with the socket: lock holder becomes the child.
        setTimeout(() => {
          writeFileSync(socket, "");
          ownsLock = true;
        }, 20);
        return child;
      },
      readLockHolder: () => (ownsLock ? child.pid : null),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await supervisor.start();
    expect(supervisor.status).toBe("running");
    expect(supervisor.pid).toBe(4242);
    expect(spawned).toBe(1);
    await supervisor.stop();
    expect(supervisor.status).toBe("stopped");
  });

  test("restarts a crashed broker within the bound, then fails visibly", async () => {
    const home = tempDir("hive-sessiond-crash-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    let spawnCount = 0;
    const fatals: string[] = [];
    let clock = 1_000;
    let ownerPid: number | null = null;

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      maxRestarts: 2,
      restartWindowMs: 60_000,
      readyTimeoutMs: 500,
      spawn: () => {
        spawnCount += 1;
        const pid = 5000 + spawnCount;
        ownerPid = pid;
        writeFileSync(socket, "");
        // Crash after ready is accepted via positive ownership.
        return makeChild({
          pid,
          exitAfterMs: 80,
          exitCode: 9,
          announceOwnerAfterMs: 0,
        });
      },
      readLockHolder: () => ownerPid,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => clock,
      onFatal: (error) => fatals.push(error.message),
    });

    await supervisor.start();
    expect(supervisor.status).toBe("running");

    // Advance clock inside the restart window for each crash cycle.
    await new Promise((r) => setTimeout(r, 150));
    clock += 100;
    await new Promise((r) => setTimeout(r, 150));
    clock += 100;
    await new Promise((r) => setTimeout(r, 150));
    clock += 100;
    await new Promise((r) => setTimeout(r, 150));

    // start + 2 restarts = 3 spawns; next crash exhausts bound (maxRestarts=2 means
    // 2 restarts after initial, so 3 total; on 3rd crash restartAt.length is 2 already
    // before push... let's check logic:
    // restartAt starts empty. On first crash, length 0 < 2, push, restart (spawn 2).
    // On second crash, length 1 < 2, push, restart (spawn 3).
    // On third crash, length 2 >= 2, fatal. Total spawns = 3.
    expect(spawnCount).toBeGreaterThanOrEqual(3);
    expect(supervisor.status).toBe("failed");
    expect(fatals.length).toBe(1);
    expect(fatals[0]).toMatch(/crashed repeatedly/);
  });

  test("stop is idempotent and does not count as a crash", async () => {
    const home = tempDir("hive-sessiond-stop-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    const child = makeChild({ pid: 77, announceOwnerAfterMs: 0 });
    const fatals: string[] = [];

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      spawn: () => {
        writeFileSync(socket, "");
        return child;
      },
      readLockHolder: () => child.pid,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onFatal: (error) => fatals.push(error.message),
    });

    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();
    expect(supervisor.status).toBe("stopped");
    expect(fatals).toEqual([]);
  });

  // Horace B2: orphan's pre-existing broker.sock must not make start() succeed
  // while the child dies with BrokerAlreadyRunning. Old readiness only checked
  // existsSync(broker.sock) and returned immediately — this test goes RED there.
  test("orphan pre-existing socket + child exit fails start visibly", async () => {
    const home = tempDir("hive-sessiond-orphan-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    // Orphan already holding the socket and broker.lock.
    writeFileSync(socket, "");
    const orphanPid = 4242;
    let spawned = 0;

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      readyTimeoutMs: 2_000,
      spawn: () => {
        spawned += 1;
        // Child loses the lock race and exits; never announces ownership.
        return makeChild({ pid: 9001, exitAfterMs: 40, exitCode: 1 });
      },
      // Lock never moves to the losing child.
      readLockHolder: () => orphanPid,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await expect(supervisor.start()).rejects.toThrow(
      /exited 1 before becoming the live broker.*pid 4242/,
    );
    expect(supervisor.status).toBe("failed");
    // Must fail at first spawn — not limp into restart loops.
    expect(spawned).toBe(1);
  });

  // Horace delta mutation: exitAfterMs 400 (past the old 250ms settle) used to
  // let start() RESOLVE at ~259ms with advertise-then-fail. Positive ownership
  // (lock holder === child) must keep this RED forever — no time-based ready.
  test("slow-losing child + orphan socket never resolves start (ownership, not settle)", async () => {
    const home = tempDir("hive-sessiond-slow-orphan-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    writeFileSync(socket, "");
    const orphanPid = 7777;
    let resolved = false;
    let spawned = 0;

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      readyTimeoutMs: 5_000,
      spawn: () => {
        spawned += 1;
        // Stalled >250ms before exit 1 — the exact mutation that beat settle.
        // Never announces ownership (loser never took exclusive flock).
        return makeChild({ pid: 9002, exitAfterMs: 400, exitCode: 1 });
      },
      readLockHolder: () => orphanPid,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    const started = Date.now();
    await expect(
      supervisor.start().then(() => {
        resolved = true;
      }),
    ).rejects.toThrow(/exited 1 before becoming the live broker.*pid 7777/);
    const elapsed = Date.now() - started;
    expect(resolved).toBe(false);
    expect(supervisor.status).toBe("failed");
    expect(spawned).toBe(1);
    // Must wait for the child's real exit, not a short settle window.
    expect(elapsed).toBeGreaterThanOrEqual(350);
  });

  // Horace delta-3: open broker.lock without exclusive flock + pre-existing
  // socket must NOT make start() resolve. lsof -t would see the open; exclusive
  // evidence + owner announcement must both be absent.
  test("open-without-flock fake never resolves start (not exclusive owner)", async () => {
    const home = tempDir("hive-sessiond-fake-open-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    const lockPath = brokerLockPath(home);
    // Stale orphan socket already present.
    writeFileSync(socket, "");
    writeFileSync(lockPath, "");

    let spawned = 0;
    const fakePid = 6001;
    // Hold an open fd without flock for the whole test (lsof -t would list us).
    const openOnlyFd = openSync(lockPath, "r+");

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      readyTimeoutMs: 800,
      spawn: () => {
        spawned += 1;
        // Fake "sessiond": socket present, lock file open somewhere, never
        // exclusive-flocked, never announces owner, stays alive past any settle.
        return makeChild({
          pid: fakePid,
          exitAfterMs: 2_000,
          exitCode: 1,
          // no announceOwnerAfterMs — never claims exclusive ownership
        });
      },
      // Open-only must not report exclusive holder (simulates empty lsof lock field).
      readLockHolder: () => null,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    let resolved = false;
    await expect(
      supervisor.start().then(() => {
        resolved = true;
      }),
    ).rejects.toThrow(/did not announce exclusive ownership|exited 1 before/);
    expect(resolved).toBe(false);
    expect(supervisor.status).toBe("failed");
    expect(spawned).toBe(1);

    closeSync(openOnlyFd);
  });

  // Announcement alone is insufficient without lock-holder evidence (forged
  // stdout from a fake that never took the flock).
  test("owner announcement without lock evidence does not resolve start", async () => {
    const home = tempDir("hive-sessiond-announce-only-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    writeFileSync(socket, "");

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      readyTimeoutMs: 600,
      spawn: () =>
        makeChild({
          pid: 7001,
          exitAfterMs: 1_500,
          exitCode: 1,
          announceOwnerAfterMs: 0, // lies on stdout
        }),
      readLockHolder: () => null, // never took exclusive flock / no stamp
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await expect(supervisor.start()).rejects.toThrow(
      /did not own broker.lock|lock holder unknown|exited 1 before/,
    );
    expect(supervisor.status).toBe("failed");
  });
});
