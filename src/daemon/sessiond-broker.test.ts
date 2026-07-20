import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brokerSocketPath,
  connectUnixSocket,
  readLocalPeerPid,
  resolveSessiondBinary,
  SessiondBrokerSupervisor,
  socketFileDescriptor,
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
  return {
    pid: options.pid,
    get exitCode() {
      return exitCode;
    },
    exited,
    kill() {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
    },
  };
}

/** proveReady that succeeds only when the test marks the child as kernel-owned. */
function makeProveReady(state: { ownerPid: number | null }) {
  return async (args: { socketPath: string; childPid: number }) => {
    if (state.ownerPid !== args.childPid) {
      if (state.ownerPid === null) {
        throw new Error("broker not kernel-ready yet");
      }
      throw new Error(
        `broker.sock kernel peer pid ${state.ownerPid} is not the owned child ${args.childPid}`,
      );
    }
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
    const current = join(root, "current");
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

describe("LOCAL_PEERPID measurement", () => {
  test("kernel peer pid equals the process bound to a unix socket", async () => {
    const dir = tempDir("hive-peerpid-");
    const path = join(dir, "s.sock");
    const server = createServer(() => {
      // hold connection open
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    try {
      const client = await connectUnixSocket(path);
      try {
        const peer = readLocalPeerPid(socketFileDescriptor(client));
        expect(peer).toBe(process.pid);
      } finally {
        client.destroy();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("SessiondBrokerSupervisor (kernel-ready gate)", () => {
  test("start resolves only after proveReady succeeds for the child", async () => {
    const home = tempDir("hive-sessiond-home-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    const ownership = { ownerPid: null as number | null };
    let spawned = 0;
    const child = makeChild({ pid: 4242 });

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      spawn: () => {
        spawned += 1;
        setTimeout(() => {
          writeFileSync(socket, "");
          ownership.ownerPid = 4242;
        }, 30);
        return child;
      },
      proveReady: makeProveReady(ownership),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await supervisor.start();
    expect(supervisor.status).toBe("running");
    expect(supervisor.pid).toBe(4242);
    expect(spawned).toBe(1);
    await supervisor.stop();
  });

  test("restarts a crashed broker within the bound, then fails visibly", async () => {
    const home = tempDir("hive-sessiond-crash-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const socket = join(socketDir, "broker.sock");
    let spawnCount = 0;
    const fatals: string[] = [];
    let clock = 1_000;
    const ownership = { ownerPid: null as number | null };

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      maxRestarts: 2,
      restartWindowMs: 60_000,
      readyTimeoutMs: 500,
      spawn: () => {
        spawnCount += 1;
        const pid = 5000 + spawnCount;
        ownership.ownerPid = pid;
        writeFileSync(socket, "");
        return makeChild({ pid, exitAfterMs: 80, exitCode: 9 });
      },
      proveReady: makeProveReady(ownership),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => clock,
      onFatal: (error) => fatals.push(error.message),
    });

    await supervisor.start();
    expect(supervisor.status).toBe("running");

    await new Promise((r) => setTimeout(r, 150));
    clock += 100;
    await new Promise((r) => setTimeout(r, 150));
    clock += 100;
    await new Promise((r) => setTimeout(r, 150));
    clock += 100;
    await new Promise((r) => setTimeout(r, 150));

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
    const child = makeChild({ pid: 77 });
    const ownership = { ownerPid: 77 as number | null };
    const fatals: string[] = [];

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake-hive-sessiond",
      hiveHome: home,
      spawn: () => {
        writeFileSync(socket, "");
        return child;
      },
      proveReady: makeProveReady(ownership),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onFatal: (error) => fatals.push(error.message),
    });

    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();
    expect(supervisor.status).toBe("stopped");
    expect(fatals).toEqual([]);
  });

  // --- Horace compositions: all must REJECT ---------------------------------

  // 1) settle-timing / immediate socket without ownership
  test("pre-existing socket alone never resolves start (no peer ownership)", async () => {
    const home = tempDir("hive-sessiond-sock-only-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    writeFileSync(join(socketDir, "broker.sock"), "");
    const ownership = { ownerPid: null as number | null };

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake",
      hiveHome: home,
      readyTimeoutMs: 400,
      spawn: () => makeChild({ pid: 9000, exitAfterMs: 2_000, exitCode: 1 }),
      proveReady: makeProveReady(ownership),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await expect(supervisor.start()).rejects.toThrow(
      /did not prove kernel ownership|exited 1 before kernel peer/,
    );
    expect(supervisor.status).toBe("failed");
  });

  // 2) unlocked opener / 3) any-opener lsof — socket present, never peer-owned
  test("open-without-ownership compositions never resolve start", async () => {
    const home = tempDir("hive-sessiond-open-only-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    writeFileSync(join(socketDir, "broker.sock"), "");
    // Stale lock stamp equal to child pid (pid-recycling composition) — ignored.
    writeFileSync(join(socketDir, "broker.lock"), "6001\n");
    const ownership = { ownerPid: null as number | null };

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake",
      hiveHome: home,
      readyTimeoutMs: 500,
      spawn: () => makeChild({ pid: 6001, exitAfterMs: 1_500, exitCode: 1 }),
      proveReady: makeProveReady(ownership),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await expect(supervisor.start()).rejects.toThrow(
      /did not prove kernel ownership|exited 1 before kernel peer/,
    );
    expect(supervisor.status).toBe("failed");
  });

  // 4) 400ms slow loser + orphan socket
  test("slow-losing child + orphan socket never resolves start", async () => {
    const home = tempDir("hive-sessiond-slow-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    writeFileSync(join(socketDir, "broker.sock"), "");
    // Foreign peer still owns the socket for the whole test.
    const ownership = { ownerPid: 7777 as number | null };
    const started = Date.now();

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake",
      hiveHome: home,
      readyTimeoutMs: 5_000,
      spawn: () => makeChild({ pid: 9002, exitAfterMs: 400, exitCode: 1 }),
      proveReady: makeProveReady(ownership),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await expect(supervisor.start()).rejects.toThrow(
      /kernel peer pid 7777 is not the owned child 9002|exited 1 before kernel peer/,
    );
    // Rejects on child exit (400ms) or timeout — never resolves as owned.
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(supervisor.status).toBe("failed");
  });

  // 5) stale-same-pid stamp + early announce — proveReady never grants
  test("stale same-pid stamp without kernel peer never resolves start", async () => {
    const home = tempDir("hive-sessiond-stale-pid-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    writeFileSync(join(socketDir, "broker.sock"), "");
    writeFileSync(join(socketDir, "broker.lock"), "9003\n");
    // proveReady never sees real peer ownership (null), even though stamp matches.
    const ownership = { ownerPid: null as number | null };

    const supervisor = new SessiondBrokerSupervisor({
      binary: "/tmp/fake",
      hiveHome: home,
      readyTimeoutMs: 600,
      spawn: () =>
        makeChild({
          pid: 9003,
          exitAfterMs: 400,
          exitCode: 1,
        }),
      proveReady: makeProveReady(ownership),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });

    await expect(supervisor.start()).rejects.toThrow(
      /did not prove kernel ownership|exited 1 before kernel peer/,
    );
    expect(supervisor.status).toBe("failed");
  });

  // 6) foreign process bound to broker.sock → peer-pid mismatch hard-rejects
  test("foreign process on broker.sock rejects with peer-pid mismatch", async () => {
    const home = tempDir("hive-sessiond-foreign-");
    const socketDir = join(home, "runtime", "sessiond");
    mkdirSync(socketDir, { recursive: true });
    const sockPath = join(socketDir, "broker.sock");

    // Real kernel: this process binds the unix socket (peer will be us).
    const server = createServer(() => {
      // accept and hold
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve());
    });

    try {
      const foreignPeer = process.pid;
      const childPid = foreignPeer + 99_999; // not the bound peer
      // Use real LOCAL_PEERPID path via default-style proveReady mock that
      // actually connects and reads peer.
      const supervisor = new SessiondBrokerSupervisor({
        binary: "/tmp/fake",
        hiveHome: home,
        readyTimeoutMs: 2_000,
        spawn: () => makeChild({ pid: childPid, exitAfterMs: 5_000, exitCode: 1 }),
        proveReady: async ({ socketPath, childPid: expected }) => {
          const client = await connectUnixSocket(socketPath);
          try {
            const peer = readLocalPeerPid(socketFileDescriptor(client));
            if (peer !== expected) {
              throw new Error(
                `broker.sock kernel peer pid ${peer} is not the owned child ${expected}`,
              );
            }
          } finally {
            client.destroy();
          }
          // Peer matched (would not in this test); HELLO omitted — mismatch throws first.
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
      });

      await expect(supervisor.start()).rejects.toThrow(
        new RegExp(
          `broker\\.sock kernel peer pid ${foreignPeer} is not the owned child ${childPid}`,
        ),
      );
      expect(supervisor.status).toBe("failed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
