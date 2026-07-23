import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
 
import {
  getPidFilePath,
  getPortFilePath,
  writeLifecycleFiles,
} from "../../src/daemon/lifecycle";
import type { DaemonHandshake } from "../../src/daemon/handshake";
import {
  explainRefusal,
  inspectDaemonForUpdate,
  restartStaleDaemon,
} from "../../src/update/daemon";

/** The handshake the *new* binary expects, after an update changed its hash. */
const expected: DaemonHandshake = {
  productVersion: "0.0.7",
  buildHash: "hash-of-0.0.7",
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  capabilities: ["daemon-handshake-v1"],
  instanceId: "instance-a",
  hiveUuid: "hive-project-a",
  identityKey: "project-a",
  repoFamilyKey: null,
  generation: 1,
};

/** What the daemon still running the *old* binary presents. */
const stalePeer: DaemonHandshake = {
  ...expected,
  productVersion: "0.0.6",
  buildHash: "hash-of-0.0.6",
};

let home: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let previousHome: string | undefined;

function serve(body: unknown | null): number {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") return Response.json({ ok: true });
      if (pathname === "/handshake" && body !== null) return Response.json(body);
      return new Response("not found", { status: 404 });
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("test server did not bind a port");
  return port;
}

beforeEach(() => {
  previousHome = process.env.HIVE_HOME;
  home = mkdtempSync(join(tmpdir(), "hive-update-daemon-"));
  process.env.HIVE_HOME = home;
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHome;
});

const noAgents = async (): Promise<readonly string[]> => [];

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnLongLivedChild() {
  const child = Bun.spawn([
    process.execPath,
    "-e",
    'process.on("SIGTERM", () => process.exit(0)); console.log("ready"); setInterval(() => {}, 1000);',
  ], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (ready.done || new TextDecoder().decode(ready.value).trim() !== "ready") {
    throw new Error("child process did not become ready");
  }
  return child;
}

async function stopChild(child: Awaited<ReturnType<typeof spawnLongLivedChild>>): Promise<void> {
  if (processIsAlive(child.pid)) process.kill(child.pid, "SIGKILL");
  await child.exited;
}

describe("the daemon left behind by an update", () => {
  test("a daemon running the previous build is stale, not current", async () => {
    const port = serve(stalePeer);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    expect(state).toEqual({
      state: "stale",
      port,
      pid: 4242,
      // Version differs first, but the build hash is what actually proves it.
      reason: "product version",
    });
  });

  test("a rebuilt binary with the same version is still stale", async () => {
    // The exact bug the build hash exists for: same marketing version, different
    // code. A version-only check would silently adopt this daemon.
    const port = serve({ ...expected, buildHash: "hash-of-a-different-build" });
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    expect(state).toMatchObject({
      state: "stale",
      reason: "content-addressed build hash",
    });
  });

  test("a daemon running our exact build is current and must not be restarted", async () => {
    const port = serve(expected);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    expect(state).toEqual({ state: "current", port });
    expect(await restartStaleDaemon(state)).toEqual({
      stopped: false,
      reason: "daemon is already current",
    });
  });

  test("another project's daemon is never ours to stop, even when our version is newer", async () => {
    // handshakeMismatch reports "product version" first, before it ever looks at
    // identity. Acting on that string alone would kill a stranger's daemon.
    const port = serve({ ...stalePeer, hiveUuid: "hive-project-b" });
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    expect(state).toEqual({
      state: "foreign",
      port,
      reason: "project identity (HiveUUID)",
    });

    let killed = false;
    const outcome = await restartStaleDaemon(state, { kill: () => (killed = true) });
    expect(killed).toEqual(false);
    expect(outcome).toMatchObject({ stopped: false });
    expect(explainRefusal(state)).toContain("different project");
  });

  test("a daemon whose project identity key differs is foreign too", async () => {
    // `hiveUuid` names the project; `identityKey` names the directory that
    // resolved to it. Either differing means the daemon is not ours.
    const port = serve({ ...stalePeer, identityKey: "project-b" });
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    expect(state).toEqual({ state: "foreign", port, reason: "project identity key" });

    let killed = false;
    await restartStaleDaemon(state, { kill: () => (killed = true) });
    expect(killed).toEqual(false);
  });

  test("a stale daemon with a live team is busy, and the team is left running", async () => {
    const port = serve(stalePeer);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({
      expected,
      liveAgents: async () => ["leo", "maya", "sam"],
      port,
    });
    expect(state).toMatchObject({ state: "busy", liveAgents: ["leo", "maya", "sam"] });

    let killed = false;
    const outcome = await restartStaleDaemon(state, { kill: () => (killed = true) });
    expect(killed).toEqual(false);
    expect(outcome).toEqual({
      stopped: false,
      reason: "3 agent(s) live (leo, maya, sam)",
    });
    expect(explainRefusal(state)).toContain(
      "run `hive stop`, then rerun `hive update`",
    );
  });

  test("an unreadable agent list is treated as a live team, not an idle one", async () => {
    // Failing closed: refusing to activate costs a retry; guessing costs an
    // agent mid-write.
    const port = serve(stalePeer);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({
      expected,
      liveAgents: () => Promise.reject(new Error("no operator credential")),
      port,
    });
    expect(state.state).toEqual("busy");
  });

  test("a stale idle daemon is stopped so the next start runs the new build", async () => {
    const port = serve(stalePeer);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });

    const signals: Array<[number, string]> = [];
    let alive = true;
    const outcome = await restartStaleDaemon(state, {
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        alive = false;
      },
      isRunning: async () => alive,
      sleep: async () => {},
    });
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    expect(outcome).toEqual({ stopped: true, pid: 4242 });
  });

  test("SIGTERM stops only the recorded process and removes its lifecycle files", async () => {
    const target = await spawnLongLivedChild();
    const unrelated = await spawnLongLivedChild();
    const port = 45_123;
    writeLifecycleFiles(port, target.pid);

    try {
      const outcome = await restartStaleDaemon(
        { state: "stale", port, pid: target.pid, reason: "build hash" },
        {
          kill: (pid, signal) => process.kill(pid, signal),
          isRunning: async () => processIsAlive(target.pid),
          timeoutMs: 2_000,
        },
      );

      await target.exited;
      expect(outcome).toEqual({ stopped: true, pid: target.pid });
      expect(processIsAlive(target.pid)).toBe(false);
      expect(existsSync(getPidFilePath())).toBe(false);
      expect(existsSync(getPortFilePath())).toBe(false);
      expect(processIsAlive(unrelated.pid)).toBe(true);
    } finally {
      await stopChild(target);
      await stopChild(unrelated);
    }
  });

  test("a daemon that will not exit is reported, not assumed dead", async () => {
    const port = serve(stalePeer);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    const outcome = await restartStaleDaemon(state, {
      kill: () => {},
      isRunning: async () => true,
      sleep: async () => {},
      timeoutMs: 100,
    });
    expect(outcome).toMatchObject({ stopped: false });
    expect(outcome).toHaveProperty("reason", expect.stringContaining("did not exit"));
  });

  test("no daemon at all means activation is unconditionally safe", async () => {
    let resolvedIdentity = false;
    const state = await inspectDaemonForUpdate({
      expected: async () => {
        resolvedIdentity = true;
        throw new Error("legacy identity resolver is broken");
      },
      liveAgents: noAgents,
      port: null,
    });
    expect(state).toEqual({ state: "absent" });
    expect(resolvedIdentity).toBe(false);
    expect(await restartStaleDaemon(state)).toEqual({ stopped: true, pid: null });
  });

  test("a port serving something that is not Hive is absent, not a kill target", async () => {
    const port = serve(null);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    expect(state).toEqual({ state: "absent" });
  });
});
