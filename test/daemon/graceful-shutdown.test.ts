import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processGroupAlive } from "../../src/adapters/providers/protocol/process-group";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { macProcessIdentity } from "../../src/daemon/lifecycle/daemon-lifecycle";
import { SuccessionStore } from "../../src/daemon/queen-provider-service/succession";
import {
  parseProcessTable,
  runPs,
} from "../../src/daemon/resource-management/resources";
import { HiveDaemon } from "../../src/daemon/server";
import type { Spawner } from "../../src/daemon/spawn/spawn-service";
import { hiveInstanceSuffix } from "../../src/hive-home/home";
import type { AgentRecord } from "../../src/schemas/agent";
import { RunCheckpointSchema } from "../../src/schemas/run-checkpoint";
import type { SessionLocator } from "../../src/schemas/session-protocol";
import { required } from "../required";
import { spawnTestChild } from "../support/spawn-test-child";
import { PROCESS_TABLE_VISIBLE_MS, waitUntil } from "../support/wait-until";

const repoRoot = join(import.meta.dir, "..", "..");
const at = "2026-08-10T12:00:00.000Z";

class StubSpawner implements Spawner {
  async spawn(): Promise<AgentRecord> {
    throw new Error("not used in graceful shutdown tests");
  }
}

const hostNotReached = async (): Promise<never> => {
  throw new Error("terminal host method not expected in this test");
};

const emptyTerminalHost = {
  waitForHostExit: async () => ({ kind: "inherited" as const }),
  create: hostNotReached,
  capture: hostNotReached,
  submitInput: hostNotReached,
  resize: hostNotReached,
  inspect: hostNotReached,
  terminate: hostNotReached,
  issueAttach: hostNotReached,
  list: async () => [],
};

function locator(): SessionLocator {
  return {
    schemaVersion: 1,
    instanceId: hiveInstanceSuffix(),
    subject: { kind: "agent", agentId: "agent-maya" },
    generation: 1,
    sessionId: "ses_019fec49-0000-7000-8000-000000000001",
    hostKind: "sessiond",
    engineBuildId: "graceful-shutdown-test",
  };
}

function agent(sessionLocator: SessionLocator): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-test",
    category: "simple_coding",
    status: "working",
    taskDescription: "hold live work during shutdown",
    worktreePath: null,
    branch: null,
    contextPct: 10,
    createdAt: at,
    lastEventAt: at,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator,
  };
}

function bindHost(
  db: HiveDatabase,
  sessionLocator: SessionLocator,
  complete: boolean,
): void {
  db.bindTerminalHostSession({
    locator: sessionLocator,
    visibility: {
      workspaceSessionId: "workspace-graceful-shutdown",
      workspacePid: 4_100,
      workspaceStartToken: "4100:1",
      openTerminalRevision: "1",
    },
  });
  if (!complete) return;
  completeHost(db, sessionLocator);
}

function completeHost(db: HiveDatabase, sessionLocator: SessionLocator): void {
  db.completeTerminalHostSession(sessionLocator, {
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    verifiedShellRoot: {
      pid: 4_300,
      startToken: "4300:1",
      processGroupId: 4_300,
    },
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    visibility: {
      state: "visible",
      workspaceSessionId: "workspace-graceful-shutdown",
      openTerminalRevision: "1",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
  });
}

async function waitForChildProcess(parentPid: number): Promise<number> {
  let childPid: number | undefined;
  await waitUntil(
    async () => {
      childPid = parseProcessTable(await runPs()).find(
        (process) => process.ppid === parentPid,
      )?.pid;
      return childPid !== undefined;
    },
    {
      deadlineMs: PROCESS_TABLE_VISIBLE_MS,
      label: `process ${parentPid} to start its child`,
    },
  );
  return required(childPid);
}

function stopRequest(daemon: HiveDaemon, token: string): Promise<Response> {
  return daemon.fetch(
    new Request("http://hive/stop", {
      method: "POST",
      headers: {
        Host: "127.0.0.1",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        invoker: { cwd: repoRoot, agentWorktree: false },
      }),
    }),
  );
}

function harness(
  onShutdown: () => void,
  options: {
    completeBinding?: boolean;
    manageLifecycle?: boolean;
    seedAgent?: boolean;
  } = {},
) {
  const db = new HiveDatabase(":memory:");
  new SuccessionStore(db);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new StubSpawner(),
    repoRoot,
    port: 0,
    terminalHost: emptyTerminalHost,
    initiateShutdown: onShutdown,
    manageLifecycle: options.manageLifecycle,
  });
  const sessionLocator = locator();
  const seedAgent = () => {
    db.insertAgent(agent(sessionLocator));
    bindHost(db, sessionLocator, options.completeBinding ?? false);
  };
  if (options.seedAgent !== false) seedAgent();
  const token = daemon.capabilities.mint("user", "user").token;
  return { daemon, db, token, sessionLocator, seedAgent };
}

/** Read /health over the daemon's real socket rather than its fetch handler. */
async function health(daemon: HiveDaemon): Promise<Response> {
  const port = daemon.listeningPort;
  if (port === null) throw new Error("daemon did not start");
  return fetch(`http://127.0.0.1:${port}/health`);
}

let tempRoot = "";
let previousHiveHome: string | undefined;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hive-graceful-shutdown-"));
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HIVE_HOME = join(tempRoot, "hive-home");
  await mkdir(Bun.env.HIVE_HOME, { recursive: true });
});

afterAll(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("graceful shutdown checkpoint", () => {
  test("reaps a held agent's recorded process tree", async () => {
    const { daemon, db, sessionLocator } = harness(() => undefined, {
      completeBinding: true,
      manageLifecycle: true,
    });
    const held = db.upsertAgent({
      ...agent(sessionLocator),
      status: "held",
      holdReason: "quota window",
      holdResetAt: "2026-08-10T13:00:00.000Z",
    });
    const child = spawnTestChild({
      executable: "/bin/sh",
      argv: ["-c", "sleep 60 & wait"],
      cwd: tempRoot,
      env: process.env,
    });
    db.insertProviderRun({
      runId: crypto.randomUUID(),
      agentId: held.id,
      terminal: sessionLocator,
      provider: "codex",
      model: "gpt-test",
      effort: null,
      conversationId: null,
      capabilityEpoch: 0,
      launchGrantId: "graceful-shutdown-test",
      startedAt: at,
      endedAt: null,
      adapterChild: {
        pid: child.pid,
        startToken: macProcessIdentity(child.pid).startToken,
        processGroupId: child.pid,
        observedAt: at,
      },
      protocolReceipt: null,
      state: "running",
      exitReason: null,
    });
    const nestedPid = await waitForChildProcess(child.pid);
    let stopped = false;

    try {
      expect(held.status).toBe("held");
      expect(processGroupAlive(child.pid)).toBe(true);

      await daemon.stop();
      stopped = true;

      expect(processGroupAlive(child.pid)).toBe(false);
      const remaining = parseProcessTable(await runPs());
      expect(remaining.some((process) => process.pid === child.pid)).toBe(
        false,
      );
      expect(remaining.some((process) => process.pid === nestedPid)).toBe(
        false,
      );
      expect(db.getAgentByName("maya")?.status).toBe("dead");
    } finally {
      await child.shutdown();
      if (!stopped) await daemon.stop();
      db.close();
    }
  });

  test("writes and digest-verifies the checkpoint before any worker termination", async () => {
    const operations: string[] = [];
    const { daemon, db, token } = harness(() => operations.push("shutdown"), {
      completeBinding: true,
    });
    const recordTermination = db.recordTerminalHostTermination.bind(db);
    jest
      .spyOn(db, "recordTerminalHostTermination")
      .mockImplementation((sessionLocator, audit) => {
        const row = db.database
          .query(
            "SELECT document FROM run_checkpoints ORDER BY CAST(revision AS INTEGER) DESC LIMIT 1",
          )
          .get() as { document: string } | null;
        expect(row).not.toBeNull();
        const checkpoint = RunCheckpointSchema.parse(
          JSON.parse(row?.document ?? "{}"),
        );
        expect(checkpoint.reason).toBe("graceful-shutdown");
        expect(checkpoint.written).toBeNull();
        expect(
          new SuccessionStore(db).readCheckpoint(
            checkpoint.instanceId,
            checkpoint.revision,
          ),
        ).toMatchObject({ state: "present", digestVerified: true });
        operations.push("verified-checkpoint", "terminate-worker");
        return recordTermination(sessionLocator, audit);
      });

    try {
      const response = await stopRequest(daemon, token);
      const body = await response.json();
      expect({ status: response.status, body }).toMatchObject({
        status: 200,
        body: { state: "stopping", killed: ["maya"] },
      });
      expect(operations).toEqual([
        "verified-checkpoint",
        "terminate-worker",
        "shutdown",
      ]);
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("digest verification failure aborts shutdown and leaves the daemon running", async () => {
    let shutdowns = 0;
    let terminations = 0;
    const { daemon, db, token, sessionLocator, seedAgent } = harness(
      () => {
        shutdowns += 1;
      },
      { seedAgent: false },
    );
    const recordTermination = db.recordTerminalHostTermination.bind(db);
    jest
      .spyOn(db, "recordTerminalHostTermination")
      .mockImplementation((sessionLocator, audit) => {
        terminations += 1;
        return recordTermination(sessionLocator, audit);
      });
    db.database.exec(`
      CREATE TRIGGER corrupt_graceful_checkpoint
      AFTER INSERT ON run_checkpoints
      BEGIN
        UPDATE run_checkpoints
        SET document = replace(
          document,
          '"reason":"graceful-shutdown"',
          '"reason":"owner-ruling"'
        )
        WHERE instanceId = NEW.instanceId AND revision = NEW.revision;
      END;
    `);
    try {
      daemon.start();
      // /health is a readiness probe: it answers 503 until the first
      // maintenance sweep succeeds, and that sweep shells out to ps, vm_stat
      // and git. The port listens within milliseconds but readiness costs
      // seconds, so await the sweep the daemon is waiting on. Polling a fixed
      // window instead is a race that a loaded machine loses.
      await daemon.runMaintenance();
      expect((await health(daemon)).status).toBe(200);
      seedAgent();

      const failed = await stopRequest(daemon, token);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({
        state: "stop-failed",
        error: expect.stringContaining("digest verification"),
      });
      expect(terminations).toBe(0);
      expect(shutdowns).toBe(0);
      expect(db.getAgentByName("maya")?.status).toBe("working");
      expect(daemon.server).not.toBeNull();
      const port = daemon.listeningPort;
      expect(port).not.toBeNull();
      const stillServing = await health(daemon);
      expect(stillServing.status).toBe(200);
      expect(await stillServing.json()).toMatchObject({
        database: { status: "ok" },
      });

      db.database.exec("DROP TRIGGER corrupt_graceful_checkpoint");
      completeHost(db, sessionLocator);
      const retry = await stopRequest(daemon, token);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ state: "stopping" });
      expect(terminations).toBe(1);
      expect(shutdowns).toBe(1);
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
