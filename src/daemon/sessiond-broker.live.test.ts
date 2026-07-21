/**
 * Live broker lifecycle against a real ReleaseFast hive-sessiond binary.
 * Skips when the binary is absent (no make build / release sessiond yet).
 *
 * Ready-proof is kernel-bound: LOCAL_PEERPID on broker.sock must equal the
 * spawned child, and HELLO must complete on that connection. HELLO requires
 * the daemon to be listening (daemon.lock + GET /handshake), so the daemon
 * starts before supervisor.start() — same order as production runDaemon.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireDaemonLock,
  cleanupLifecycleFiles,
  releaseDaemonLock,
} from "./lifecycle";
import {
  brokerSocketPath,
  resolveSessiondBinary,
  SessiondBrokerSupervisor,
} from "./sessiond-broker";
import { SessiondHost } from "./session-host/sessiond-host";
import { HiveDaemon, startDaemon } from "./server";
import { HiveDatabase } from "./db";

const repoRoot = resolve(import.meta.dir, "../..");
const binary = resolveSessiondBinary({
  repoRoot,
  isReleaseBuild: false,
  env: process.env,
});

const describeIfBinary = binary !== null ? describe : describe.skip;

/** Short by necessity: host.sock under …/runtime/sessiond/hosts/… must fit sun_path. */
function shortHome(tag: string): string {
  const home = `/tmp/hsb-${tag}-${Math.random().toString(16).slice(2, 6)}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

class UnusedSpawner {
  async spawn(): Promise<never> {
    throw new Error("live broker test does not spawn agents");
  }
}

async function waitForPort(daemon: HiveDaemon): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (daemon.listeningPort !== null) return;
    await Bun.sleep(20);
  }
  throw new Error("daemon did not bind a port");
}

describeIfBinary("sessiond broker live lifecycle", () => {
  let home: string;
  let daemon: HiveDaemon | null = null;
  let supervisor: SessiondBrokerSupervisor | null = null;
  const previousHome = process.env.HIVE_HOME;
  const previousPort = process.env.HIVE_PORT;

  afterEach(async () => {
    if (daemon !== null) {
      try {
        await daemon.stop();
      } catch {
        // best-effort
      }
      daemon = null;
    }
    if (supervisor !== null) {
      try {
        await supervisor.stop();
      } catch {
        // best-effort
      }
      supervisor = null;
    }
    try {
      cleanupLifecycleFiles();
    } catch {
      // lock may already be gone
    }
    try {
      releaseDaemonLock();
    } catch {
      // ignore
    }
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
    if (previousPort === undefined) delete process.env.HIVE_PORT;
    else process.env.HIVE_PORT = previousPort;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  test("daemon lock holder starts, proves peer ownership + HELLO, tears down", async () => {
    home = shortHome("ok");
    process.env.HIVE_HOME = home;
    process.env.HIVE_PORT = "0";
    await acquireDaemonLock();

    supervisor = new SessiondBrokerSupervisor({
      binary: binary!,
      hiveHome: home,
      repoRoot,
      readyTimeoutMs: 15_000,
    });

    const db = new HiveDatabase(join(home, "hive.db"));
    daemon = startDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      repoRoot,
      spawner: new UnusedSpawner(),
      manageLifecycle: true,
      sessiondBroker: supervisor,
      port: 0,
    });
    await waitForPort(daemon);

    await supervisor.start();
    expect(supervisor.status).toBe("running");
    expect(existsSync(brokerSocketPath(home))).toBe(true);

    const host = new SessiondHost({ repoRoot, hiveHome: home });
    const engine = await host.discoverEngineBuildId();
    expect(engine.length).toBe(64);

    await daemon.stop();
    daemon = null;
    supervisor = null;
  }, 30_000);

  test("orphan broker.lock / foreign socket fails startup (no limp)", async () => {
    home = shortHome("or");
    process.env.HIVE_HOME = home;
    process.env.HIVE_PORT = "0";

    // Orphan: a real hive-sessiond serve that holds broker.sock (and lock).
    const orphan = Bun.spawn([binary!, "serve"], {
      env: { ...process.env, HIVE_HOME: home },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const socket = brokerSocketPath(home);
    const orphanDeadline = Date.now() + 15_000;
    while (Date.now() < orphanDeadline) {
      if (existsSync(socket) && orphan.exitCode === null) break;
      if (orphan.exitCode !== null) {
        throw new Error(`orphan broker exited ${orphan.exitCode} before ready`);
      }
      await Bun.sleep(20);
    }
    expect(existsSync(socket)).toBe(true);
    expect(orphan.exitCode).toBeNull();
    const orphanPid = orphan.pid;

    await acquireDaemonLock();
    supervisor = new SessiondBrokerSupervisor({
      binary: binary!,
      hiveHome: home,
      repoRoot,
      readyTimeoutMs: 5_000,
      maxRestarts: 3,
    });

    // Daemon must listen so HELLO could theoretically run; peer-pid should
    // reject first because the orphan owns the socket.
    const db = new HiveDatabase(join(home, "hive.db"));
    daemon = startDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      repoRoot,
      spawner: new UnusedSpawner(),
      manageLifecycle: true,
      sessiondBroker: supervisor,
      port: 0,
    });
    await waitForPort(daemon);

    let startError: unknown;
    try {
      await supervisor.start();
    } catch (error) {
      startError = error;
    }
    expect(startError).toBeInstanceOf(Error);
    const message = (startError as Error).message;
    // Peer is the orphan, not our child — kernel mismatch or child exit
    // after BrokerAlreadyRunning while orphan holds the bind.
    expect(message).toMatch(
      new RegExp(
        `kernel peer pid ${orphanPid} is not the owned child|exited \\d+ before kernel peer|did not prove kernel ownership`,
      ),
    );
    expect(supervisor.status).toBe("failed");
    expect(orphan.exitCode).toBeNull();

    await supervisor.stop();
    supervisor = null;
    await daemon.stop();
    daemon = null;
    try {
      orphan.kill("SIGTERM");
    } catch {
      // already dead
    }
    await Promise.race([orphan.exited, Bun.sleep(2_000)]);
  }, 30_000);

  test("broker crash is restarted within the bound; HELLO recovers", async () => {
    home = shortHome("cr");
    process.env.HIVE_HOME = home;
    process.env.HIVE_PORT = "0";
    await acquireDaemonLock();

    const fatals: string[] = [];
    supervisor = new SessiondBrokerSupervisor({
      binary: binary!,
      hiveHome: home,
      repoRoot,
      maxRestarts: 2,
      restartWindowMs: 60_000,
      readyTimeoutMs: 15_000,
      onFatal: (error) => fatals.push(error.message),
    });

    const db = new HiveDatabase(join(home, "hive.db"));
    daemon = startDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      repoRoot,
      spawner: new UnusedSpawner(),
      manageLifecycle: true,
      sessiondBroker: supervisor,
      port: 0,
    });
    await waitForPort(daemon);

    await supervisor.start();
    const firstPid = supervisor.pid;
    expect(firstPid).not.toBeNull();

    process.kill(firstPid!, "SIGKILL");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (
        supervisor.status === "running" &&
        supervisor.pid !== null &&
        supervisor.pid !== firstPid &&
        existsSync(brokerSocketPath(home))
      ) {
        break;
      }
      await Bun.sleep(50);
    }
    expect(supervisor.status).toBe("running");
    expect(supervisor.pid).not.toBe(firstPid);
    expect(existsSync(brokerSocketPath(home))).toBe(true);
    expect(fatals).toEqual([]);

    const host = new SessiondHost({ repoRoot, hiveHome: home });
    const engine = await host.discoverEngineBuildId();
    expect(engine.length).toBe(64);

    await daemon.stop();
    daemon = null;
    supervisor = null;
  }, 45_000);
});
