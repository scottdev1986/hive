import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDaemonLock,
  cleanupLifecycleFiles,
  daemonInstanceLiveness,
  daemonSpawnArgv,
  getDaemonLockPath,
  getPidFilePath,
  getPortFilePath,
  isRunning,
  probeDaemonReuse,
  readConfiguredPort,
  releaseDaemonLock,
  writeLifecycleFiles,
} from "./lifecycle";
import { hiveInstanceSuffix } from "./tmux-sessions";
import type { DaemonHandshake } from "./handshake";
import { handshakeMismatch } from "./handshake";

const handshake: DaemonHandshake = {
  productVersion: "0.1.0",
  buildHash: "current-build",
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  capabilities: ["daemon-handshake-v1"],
  instanceId: "instance-a",
  hiveUuid: "hive-project-a",
  identityKey: "project-a",
  repoFamilyKey: null,
  generation: 1,
};

describe("respawning as the daemon", () => {
  test("a source checkout names the entry script, because bun is the executable", () => {
    expect(daemonSpawnArgv(false, "/opt/homebrew/bin/bun", "/repo/src/cli.ts"))
      .toEqual(["/opt/homebrew/bin/bun", "/repo/src/cli.ts", "daemon"]);
  });

  test("a release build spawns itself, never a path inside its own bundle", () => {
    // `import.meta.dir` in a compiled binary is Bun's virtual filesystem. Passing
    // it as argv makes the child try to run `/$bunfs/root/cli.ts` as a command.
    const argv = daemonSpawnArgv(true, "/Users/s/.local/share/hive/current/hive", "/$bunfs/root/cli.ts");
    expect(argv).toEqual(["/Users/s/.local/share/hive/current/hive", "daemon"]);
    expect(argv.join(" ")).not.toContain("bunfs");
  });
});

describe("daemon lifecycle", () => {
  test("defaults to an ephemeral port", () => {
    const previousPort = process.env.HIVE_PORT;
    delete process.env.HIVE_PORT;
    try {
      expect(readConfiguredPort()).toBe(0);
    } finally {
      if (previousPort === undefined) delete process.env.HIVE_PORT;
      else process.env.HIVE_PORT = previousPort;
    }
  });

  test("refuses a second daemon lock for one instance", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-lock-"));
    process.env.HIVE_HOME = home;
    try {
      await acquireDaemonLock(10101, () => true);
      expect(getDaemonLockPath()).toEqual(join(home, "daemon.lock"));
      await expect(acquireDaemonLock(20202, () => true)).rejects.toThrow(
        "already starting or running",
      );
      releaseDaemonLock(10101);
      await acquireDaemonLock(20202, () => true);
      releaseDaemonLock(20202);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("preserves a malformed daemon lock instead of reclaiming unknown ownership", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-malformed-lock-"));
    process.env.HIVE_HOME = home;
    try {
      writeFileSync(getDaemonLockPath(), "not-json\n");
      await expect(acquireDaemonLock(20202, () => false)).rejects.toThrow(
        "ownership is unknown",
      );
      expect(readFileSync(getDaemonLockPath(), "utf8")).toBe("not-json\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("preserves an unreachable lock whose recorded process is still live", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-unreachable-lock-"));
    process.env.HIVE_HOME = home;
    const lock = {
      pid: 10101,
      instanceId: hiveInstanceSuffix(home),
      startedAt: "2020-01-01T00:00:00.000Z",
    };
    try {
      writeFileSync(getDaemonLockPath(), `${JSON.stringify(lock)}\n`);
      await expect(acquireDaemonLock(20202, () => true)).rejects.toThrow(
        "ownership is unknown",
      );
      expect(JSON.parse(readFileSync(getDaemonLockPath(), "utf8"))).toEqual(lock);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("never probes a non-positive pid from an invalid daemon lock", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-invalid-lock-pid-"));
    process.env.HIVE_HOME = home;
    const probed: number[] = [];
    try {
      writeFileSync(getDaemonLockPath(), `${JSON.stringify({
        pid: -1,
        instanceId: hiveInstanceSuffix(home),
        startedAt: "2020-01-01T00:00:00.000Z",
      })}\n`);
      await expect(acquireDaemonLock(20202, (pid) => {
        probed.push(pid);
        return false;
      })).rejects.toThrow("ownership is unknown");
      expect(probed).toEqual([]);
      expect(existsSync(getDaemonLockPath())).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("refuses to overwrite lifecycle files when pid ownership is unknown", () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-malformed-pid-write-"));
    process.env.HIVE_HOME = home;
    try {
      writeFileSync(getPidFilePath(), "not-a-pid\n");
      writeFileSync(getPortFilePath(), "4317\n");
      expect(() => writeLifecycleFiles(8123)).toThrow("pid ownership is unknown");
      expect(readFileSync(getPidFilePath(), "utf8")).toBe("not-a-pid\n");
      expect(readFileSync(getPortFilePath(), "utf8")).toBe("4317\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("refuses lifecycle cleanup when pid ownership is unknown", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-malformed-pid-cleanup-"));
    process.env.HIVE_HOME = home;
    try {
      await acquireDaemonLock();
      writeFileSync(getPidFilePath(), "not-a-pid\n");
      writeFileSync(getPortFilePath(), "4317\n");
      expect(() => cleanupLifecycleFiles()).toThrow("pid ownership is unknown");
      expect(readFileSync(getPidFilePath(), "utf8")).toBe("not-a-pid\n");
      expect(readFileSync(getPortFilePath(), "utf8")).toBe("4317\n");
      expect(existsSync(getDaemonLockPath())).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("refuses to overwrite lifecycle files owned by another daemon lock", () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-foreign-lock-write-"));
    process.env.HIVE_HOME = home;
    const lock = {
      pid: 10101,
      instanceId: "another-instance",
      startedAt: "2020-01-01T00:00:00.000Z",
    };
    try {
      writeFileSync(getDaemonLockPath(), `${JSON.stringify(lock)}\n`);
      writeFileSync(getPortFilePath(), "4317\n");
      expect(() => writeLifecycleFiles(8123)).toThrow("another daemon");
      expect(existsSync(getPidFilePath())).toBe(false);
      expect(readFileSync(getPortFilePath(), "utf8")).toBe("4317\n");
      expect(JSON.parse(readFileSync(getDaemonLockPath(), "utf8"))).toEqual(lock);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("a missing pid file does not authorize cleanup of another daemon lock", () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-foreign-lock-cleanup-"));
    process.env.HIVE_HOME = home;
    const lock = {
      pid: process.pid,
      instanceId: "another-instance",
      startedAt: "2020-01-01T00:00:00.000Z",
    };
    try {
      writeFileSync(getDaemonLockPath(), `${JSON.stringify(lock)}\n`);
      writeFileSync(getPortFilePath(), "4317\n");
      expect(() => cleanupLifecycleFiles()).toThrow("another daemon");
      expect(existsSync(getPidFilePath())).toBe(false);
      expect(readFileSync(getPortFilePath(), "utf8")).toBe("4317\n");
      expect(JSON.parse(readFileSync(getDaemonLockPath(), "utf8"))).toEqual(lock);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("proves daemon-lock liveness without treating an unreachable live pid as dead", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-owner-"));
    process.env.HIVE_HOME = home;
    const instanceId = hiveInstanceSuffix(home);
    try {
      expect(await daemonInstanceLiveness(home, instanceId)).toEqual("dead");
      await acquireDaemonLock();
      writeLifecycleFiles(4317);
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ ...handshake, instanceId }),
      );
      expect(await daemonInstanceLiveness(home, instanceId)).toEqual("live");
      fetchSpy.mockRejectedValue(new Error("temporarily unreachable"));
      expect(await daemonInstanceLiveness(home, instanceId)).toEqual("unknown");
      fetchSpy.mockRestore();
      releaseDaemonLock();
      expect(await daemonInstanceLiveness(home, instanceId)).toEqual("dead");
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("instance identity is part of daemon reuse", () => {
    expect(handshakeMismatch(handshake, { ...handshake, instanceId: "instance-b" }))
      .toEqual("instance identity");
  });

  test("a confirmed move retains its opaque handshake identity", () => {
    const moved = { ...handshake, identityKey: "project-b" };
    expect(handshakeMismatch(handshake, moved)).toEqual("project identity key");
    expect(handshakeMismatch({ ...handshake, identityKey: "project-b" }, moved)).toBeNull();
  });

  test("a recreated path cannot inherit the prior HiveUUID", () => {
    const recreated = { ...handshake, hiveUuid: "hive-new", identityKey: "project-a" };
    expect(handshakeMismatch(handshake, recreated)).toEqual("project identity (HiveUUID)");
  });
  test("accepts a healthy daemon even when its pidfile is missing", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-health-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true }),
    );
    try {
      writeLifecycleFiles(4317);
      rmSync(getPidFilePath());
      expect(await isRunning()).toEqual(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
    }
  });

  test("rejects a live pid when the recorded health endpoint is absent", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-stale-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection refused"),
    );
    try {
      writeLifecycleFiles(4317, process.pid);
      expect(await isRunning()).toEqual(false);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
    }
  });

  test("rejects cross-project adoption even when health is live", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-project-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input) => {
      const url = String(input);
      return Promise.resolve(Response.json(url.endsWith("/health")
        ? { ok: true }
        : { ...handshake, hiveUuid: "hive-project-b" }));
    }) as typeof fetch);
    try {
      writeLifecycleFiles(4317);
      expect(await probeDaemonReuse(handshake)).toEqual({
        state: "rejected",
        port: 4317,
        reason: "project identity (HiveUUID)",
      });
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("rejects a stale build with the same marketing version", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-build-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input) =>
      Promise.resolve(Response.json(String(input).endsWith("/health")
        ? { ok: true }
        : { ...handshake, buildHash: "stale-build" }))
    ) as typeof fetch);
    try {
      writeLifecycleFiles(4317);
      expect(await probeDaemonReuse(handshake)).toEqual({
        state: "rejected",
        port: 4317,
        reason: "content-addressed build hash",
      });
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });

  test("authorizes legitimate same-project reuse only after handshake", async () => {
    const previousHome = process.env.HIVE_HOME;
    const home = mkdtempSync(join(tmpdir(), "hive-lifecycle-reuse-"));
    process.env.HIVE_HOME = home;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input) =>
      Promise.resolve(Response.json(String(input).endsWith("/health")
        ? { ok: true }
        : handshake))
    ) as typeof fetch);
    try {
      writeLifecycleFiles(4317);
      expect(await probeDaemonReuse(handshake)).toEqual({
        state: "authorized",
        port: 4317,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
    }
  });
});
