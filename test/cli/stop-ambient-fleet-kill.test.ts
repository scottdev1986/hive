// stopHive with partial deps must not kill through ambient HIVE_HOME.
//
// A call that mocks only liveness/kill/cleanup while leaving
// readAgents/readSessiondBinding/stopSessiond on defaults can inherit a real
// instance's HIVE_HOME from the worktree shell. Those defaults then read the
// real agent list, daemon.port, and user credential and POST kill
// requests (`reason="hive stop ppid=<gone> argv=[]"` under `bun test`), while
// the mocked `kill` never signals the daemon.
//
// This suite sandboxes that scenario: scratch HIVE_HOME, a live sessiond
// agent row, terminal-host binding, user credential, and daemon.port
// aimed at a local capture server. No kill request may escape a stopHive
// whose caller did not explicitly provide the lethal dependency.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAgentCli, killOrigin, stopHive } from "../../src/cli/control";
import { writeCredential } from "../../src/daemon/authorization/credentials";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { AgentRecord } from "../../src/schemas/agent";

const LOCATOR = {
  schemaVersion: 1,
  instanceId: "repro-instance",
  subject: { kind: "agent", agentId: "agent-maya" },
  generation: 1,
  sessionId: "ses_0198a8f0-0000-7000-8000-000000000001",
  hostKind: "sessiond",
  engineBuildId: "engine-repro",
} as const;

function liveSessiondAgent(): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-test",
    category: "complex_coding",
    status: "working",
    taskDescription: "repro",
    worktreePath: null,
    branch: null,
    contextPct: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    lastEventAt: "2026-07-20T00:00:00.000Z",
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: LOCATOR,
  };
}

let home = "";
let previousHome: string | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
const killRequests: Array<{ url: string; origin?: string }> = [];

beforeEach(() => {
  killRequests.length = 0;
  home = mkdtempSync(join(tmpdir(), "hive-70-repro-"));
  previousHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;

  // Ambient instance shape: live sessiond agent, terminal-host binding
  // (required preflight), user credential, daemon.port at the capture server.
  const db = new HiveDatabase(join(home, "hive.db"));
  try {
    db.insertAgent(liveSessiondAgent());
    db.bindTerminalHostSession({
      locator: LOCATOR,
      visibility: {
        workspaceSessionId: "workspace-repro",
        workspacePid: 4100,
        workspaceStartToken: "4100:123456",
        openTerminalRevision: "1",
      },
    });
  } finally {
    db.close();
  }
  writeCredential("user", "repro-user-token");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/kill")) {
        const body = (await request.json().catch(() => null)) as {
          origin?: string;
        } | null;
        killRequests.push({
          url: url.pathname,
          ...(body?.origin === undefined ? {} : { origin: body.origin }),
        });
        return Response.json({
          reaped: { killed: [{ pid: 1 }], survivors: [] },
        });
      }
      return Response.json({ agents: [] });
    },
  });
  Bun.write(join(home, "daemon.port"), `${server.port}\n`);
});

afterEach(() => {
  server?.stop(true);
  server = null;
  if (previousHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("stopHive with partial deps cannot reach through ambient HIVE_HOME and kill the fleet (#70)", async () => {
  // Partial deps: liveness/kill/cleanup mocked; lethal readers left on defaults.
  const states: Array<"live" | "dead"> = ["live", "dead"];
  const error = await stopHive({
    readPid: () => 4242,
    liveness: async () => states.shift() ?? "dead",
    cleanup: () => {},
    sleep: async () => {},
    timeoutMs: 50,
    log: () => {},
  }).then(
    () => null,
    (thrown: unknown) => thrown,
  );

  // A leaked kill would show up here with a stop origin.
  expect(
    killRequests.map((request) => `${request.url} origin=${request.origin}`),
  ).toEqual([]);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/refus/i);
});

// Positive control: the capture server records a deliberate kill on this path.
// A broken instrument would make the no-leak assertion above vacuous.
test("positive control: the capture server records a deliberately sent kill", async () => {
  const agent = liveSessiondAgent();
  const captureServer = server;
  if (captureServer === null) throw new Error("capture server did not start");
  expect(captureServer.hostname).toBe("127.0.0.1");
  const captureResponse = await fetch(
    `http://127.0.0.1:${captureServer.port}/`,
  );
  expect(await captureResponse.json()).toEqual({ agents: [] });
  await killAgentCli(
    agent.name,
    captureServer.port,
    agent.sessionLocator,
    killOrigin("stop"),
  );
  expect(killRequests).toHaveLength(1);
  expect(killRequests[0]?.url).toBe("/agents/maya/kill");
  expect(killRequests[0]?.origin).toStartWith("hive stop pid=");
});
