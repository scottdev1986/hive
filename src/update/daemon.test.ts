import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
 
import { writeLifecycleFiles } from "../daemon/lifecycle";
import type { DaemonHandshake } from "../daemon/handshake";
import {
  explainRefusal,
  inspectDaemonForUpdate,
  restartStaleDaemon,
} from "./daemon";

/** The handshake the *new* binary expects, after an update changed its hash. */
const expected: DaemonHandshake = {
  productVersion: "0.0.7",
  buildHash: "hash-of-0.0.7",
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  capabilities: ["daemon-handshake-v1"],
  hiveUuid: "hive-project-a",
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
    expect(explainRefusal(state)).toContain("hive stop");
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
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port: null });
    expect(state).toEqual({ state: "absent" });
    expect(await restartStaleDaemon(state)).toEqual({ stopped: true, pid: null });
  });

  test("a port serving something that is not Hive is absent, not a kill target", async () => {
    const port = serve(null);
    writeLifecycleFiles(port, 4242);
    const state = await inspectDaemonForUpdate({ expected, liveAgents: noAgents, port });
    expect(state).toEqual({ state: "absent" });
  });
});
