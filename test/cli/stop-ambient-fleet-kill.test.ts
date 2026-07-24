// #70 regression: the 2026-07-20 fleet kills.
//
// Twice on 2026-07-20 every live agent of instance /tmp/hv-a27e3d322a died
// under an operator-credentialed `hive stop` audited as
// `reason="hive stop ppid=<gone> argv=[]"` while the daemon survived. The
// killer was not a human shell: `argv=[]` is `process.argv.slice(2)` under
// `bun test`, and the ppid was an agent's ephemeral Bash shell. A test that
// called stopHive with PARTIAL dependencies (liveness/kill/cleanup mocked,
// readAgents/readSessiondBinding/stopSessiond left to defaults) reached
// through the ambient environment: the worktree shell had inherited the real
// instance's HIVE_HOME, so the defaults read the real agent list, the real
// daemon.port and the real operator credential — and killed the real fleet,
// while the mocked `kill` meant the daemon was never signalled.
//
// This test IS that scenario, sandboxed: a scratch HIVE_HOME with a live
// sessiond agent row, a terminal-host binding, an operator credential and a
// daemon.port pointing at a local capture server. It asserts the fixed
// behavior — no kill request may escape a stopHive whose caller did not
// explicitly provide the lethal dependency. Before the fix it fails by
// reproducing the incident byte-for-byte (a captured POST /agents/maya/kill
// with origin "hive stop ppid=... argv=[]").
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAgentCli, killOrigin, stopHive } from "../../src/cli/control";
import { HiveDatabase } from "../../src/daemon/db";
import { writeCredential } from "../../src/daemon/credentials";
import type { AgentRecord } from "../../src/schemas";

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
    recoveryAttempts: 0,
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

  // The ambient instance the incident shell had inherited: a live sessiond
  // agent, its terminal-host binding (so the #65 preflight passes), an
  // operator credential, and a daemon.port aimed at the capture server.
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
  writeCredential("operator", "repro-operator-token");
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/kill")) {
        const body = await request.json().catch(() => null) as
          | { origin?: string }
          | null;
        killRequests.push({ url: url.pathname, ...body?.origin === undefined ? {} : { origin: body.origin } });
        return Response.json({ reaped: { killed: [{ pid: 1 }], survivors: [] } });
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
  // Exactly the dependency shape control.test.ts's daemon-liveness tests used
  // on 2026-07-20: liveness/kill/cleanup mocked, everything lethal defaulted.
  const states: Array<"live" | "dead"> = ["live", "dead"];
  const error = await stopHive({
    readPid: () => 4242,
    liveness: async () => states.shift() ?? "dead",
    cleanup: () => {},
    sleep: async () => {},
    timeoutMs: 50,
    log: () => {},
  }).then(() => null, (thrown: unknown) => thrown);

  // The incident signature is a captured kill request with a stop origin.
  // Surface it in the failure output so the reproduction is self-evident.
  expect(
    killRequests.map((request) => `${request.url} origin=${request.origin}`),
  ).toEqual([]);
  // And the refusal must be loud, not a silent no-op.
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/refus/i);
});

// In-suite positive control: the capture server DOES observe a kill request
// when one is deliberately sent over the exact HTTP path the incident used.
// A broken instrument would make the assertion above vacuous.
test("positive control: the capture server records a deliberately sent kill", async () => {
  const agent = liveSessiondAgent();
  await killAgentCli(
    agent.name,
    server!.port,
    agent.sessionLocator,
    killOrigin("stop"),
  );
  expect(killRequests).toHaveLength(1);
  expect(killRequests[0]!.url).toBe("/agents/maya/kill");
  expect(killRequests[0]!.origin).toStartWith("hive stop pid=");
});
