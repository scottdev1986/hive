import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OUTSIDE_REPO_TMPDIR } from "../../test/outside-repo-tmpdir";
import type { AgentRecord } from "../schemas";
import type { SessionInspection } from "../daemon/session-host/contract";
import type { TmuxSessionHost } from "../daemon/session-host/tmux-host";
import {
  exitAfterDaemonStartupFailure,
  startBrokerAndDiscoverEngineBuildId,
  stopSpawnSession,
} from "./daemon";

test("engine discovery failure tears down a live daemon and exits 1", async () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-discovery-failure-"));
  const marker = join(fixture, "teardown.json");
  const daemonModule = pathToFileURL(join(import.meta.dir, "daemon.ts")).href;
  const script = `
    import { writeFileSync } from "node:fs";
    import {
      exitAfterDaemonStartupFailure,
      startBrokerAndDiscoverEngineBuildId,
    } from ${JSON.stringify(daemonModule)};
    const state = { brokerStopped: false, daemonStopped: false, lifecycleCleaned: false };
    const server = Bun.serve({ port: 0, fetch: () => new Response("alive") });
    await startBrokerAndDiscoverEngineBuildId({
      startBroker: async () => {},
      discoverEngineBuildId: async () => { throw new Error("planted engine discovery failure"); },
      onFatalFailure: (stage, error) => exitAfterDaemonStartupFailure(stage, error, {
        stopBroker: async () => { state.brokerStopped = true; },
        stopDaemon: async () => { server.stop(true); state.daemonStopped = true; },
        cleanupLifecycle: () => {
          state.lifecycleCleaned = true;
          writeFileSync(process.env.TEARDOWN_MARKER, JSON.stringify(state));
        },
        exit: (code) => process.exit(code),
      }),
    }).catch(() => { process.exitCode = 1; });
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, TEARDOWN_MARKER: marker },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(1_000).then(() => null),
    ]);
    if (exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).toBe(1);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      brokerStopped: true,
      daemonStopped: true,
      lifecycleCleaned: true,
    });
    expect(stderr).toContain(
      "sessiond engine build discovery failed: planted engine discovery failure",
    );
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("positive control: broker-start failures still take the fatal handler", async () => {
  let discoveryAttempted = false;
  await expect(startBrokerAndDiscoverEngineBuildId({
    startBroker: async () => {
      throw new Error("planted broker start failure");
    },
    discoverEngineBuildId: async () => {
      discoveryAttempted = true;
      return "unreachable";
    },
    onFatalFailure: async (stage, error) => {
      expect(stage).toBe("broker-start");
      throw new Error(`handled: ${(error as Error).message}`);
    },
  })).rejects.toThrow("handled: planted broker start failure");
  expect(discoveryAttempted).toBe(false);
});

test("spawn cleanup dispatches a sessiond row by its exact locator", async () => {
  const locator = {
    schemaVersion: 1 as const,
    instanceId: "hive-production",
    subject: { kind: "agent" as const, agentId: "agent-aria" },
    generation: 1,
    sessionId: "ses_019f7dca-7580-78d0-aa83-22a0c471fde6",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-production",
  };
  const record = {
    id: "agent-aria",
    name: "aria",
    tool: "claude",
    model: "claude-haiku-4-5-20251001",
    category: "simple_coding",
    status: "spawning",
    taskDescription: "production pane qualification",
    worktreePath: "/tmp/aria",
    branch: "hive/aria-production-pane-qualification",
    tmuxSession: "hive-aria",
    sessionLocator: locator,
    contextPct: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    lastEventAt: "2026-07-20T00:00:00.000Z",
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: true,
    writeRevoked: false,
  } satisfies AgentRecord;
  const inspected: unknown[] = [];
  const terminated: unknown[] = [];

  await expect(stopSpawnSession(record, {
    sessions: {} as TmuxSessionHost,
    terminalHost: {
      inspect: async (candidate) => {
        inspected.push(candidate);
        return { hostPid: null } as SessionInspection;
      },
      terminate: async (candidate) => {
        terminated.push(candidate);
        return {
          locator,
          state: "terminated" as const,
          exit: null,
          survivors: [],
          errors: [],
        };
      },
    },
  })).resolves.toEqual({ killed: [], survivors: [] });
  expect(inspected).toEqual([locator]);
  expect(terminated).toEqual([locator]);
});
