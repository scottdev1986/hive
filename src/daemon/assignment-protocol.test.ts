import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import type { RootProtocolDeliverer, TmuxSender } from "./delivery";
import { agentStateCas, HiveDatabase } from "./db";
import { HiveDaemon } from "./server";
import type { SpawnRequest, Spawner } from "./spawner";
import { actingAs } from "./testing";

const root = mkdtempSync(join(tmpdir(), "hive-assignment-protocol-"));
const at = "2026-07-16T04:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "claude",
    model: "sonnet",
    category: "heavy_research",
    status: "working",
    taskDescription: "Research the durable outcome contract",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-assignment",
    tmuxSession: "hive-maya",
    processIncarnation: 1,
    processStartedAt: at,
    contextPct: null,
    createdAt: at,
    lastEventAt: at,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("spawn is not used in this test");
  }
}

class RootRecorder implements RootProtocolDeliverer {
  readonly calls: string[] = [];

  constructor(private readonly live = true) {}

  isLive(): boolean {
    return this.live;
  }

  async deliverMessage(content: string): Promise<boolean> {
    this.calls.push(content);
    return true;
  }
}

class WorkerSender implements TmuxSender {
  private turn = Date.parse("2030-01-01T00:00:00.000Z");

  constructor(private readonly db: HiveDatabase) {}

  async sendMessage(session: string): Promise<void> {
    const target = this.db.listAgents().find((value) =>
      value.tmuxSession === session
    );
    if (target === undefined) return;
    this.turn += 1_000;
    this.db.insertEvent({
      kind: "turn-start",
      agentName: target.name,
      timestamp: new Date(this.turn).toISOString(),
    });
  }
}

class LiveTmux {
  async hasSession(): Promise<boolean> {
    return true;
  }

  async killSession(): Promise<void> {}

  async capturePane(): Promise<string> {
    return "";
  }

  async newSession(): Promise<void> {}
}

function daemon(
  path: string,
  rootProtocol: RootProtocolDeliverer = new RootRecorder(),
): { db: HiveDatabase; daemon: HiveDaemon } {
  const db = new HiveDatabase(path);
  return {
    db,
    daemon: new HiveDaemon({
      db,
      spawner: new UnusedSpawner(),
      tmux: new LiveTmux(),
      tmuxSender: new WorkerSender(db),
      rootProtocol,
      repoRoot: "/repo",
      landBranch: async () => ({ commit: "landed-commit" }),
    }),
  };
}

function assign(db: HiveDatabase, value: AgentRecord): AgentRecord {
  const persisted = db.insertAgent(value);
  db.createAssignmentForAgent(persisted);
  return persisted;
}

async function client(
  daemon: HiveDaemon,
  subject: string,
  role: "operator" | "orchestrator" | "writer" | "reader",
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: actingAs(daemon, subject, role) },
  );
  const value = new Client({ name: "assignment-test", version: "1.0.0" });
  await value.connect(transport);
  return value;
}

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as unknown;
}

const summary = {
  done: ["verified the state transition"],
  remaining: ["queen acceptance"],
  blockers: [],
};

describe("durable assignment outcomes", () => {
  test("spawn creates one assignment and process replacement rebinds only that open task", () => {
    const db = new HiveDatabase(join(root, "spawn-binding.db"));
    try {
      const spawning = db.insertAgent(agent({ status: "spawning" }));
      const assignment = db.getOpenAssignmentForAgent(spawning.id)!;
      expect(assignment).toMatchObject({
        agentId: spawning.id,
        taskDescription: spawning.taskDescription,
        processIncarnation: 1,
        state: "active",
      });
      expect(db.listAssignments()).toHaveLength(1);

      const replacement = db.beginAgentProcess(
        agentStateCas(spawning),
        "2026-07-16T04:00:10.000Z",
        "replacement-session",
        0,
        { status: "working" },
      );
      expect(replacement?.processIncarnation).toBe(2);
      expect(db.getAssignmentById(assignment.id)?.processIncarnation).toBe(2);
      expect(db.reportAssignment(
        assignment.id,
        spawning.id,
        1,
        "complete",
        summary,
        "2026-07-16T04:00:20.000Z",
      )).toBeNull();
    } finally {
      db.close();
    }
  });

  test("schema startup backfills a legacy live holder once and never reopens acceptance", () => {
    const path = join(root, "legacy-backfill.db");
    const legacy = new HiveDatabase(path);
    const worker = legacy.upsertAgent(agent());
    expect(legacy.getLatestAssignmentForAgent(worker.id)).toBeNull();
    legacy.close();

    const migrated = new HiveDatabase(path);
    const assignment = migrated.getOpenAssignmentForAgent(worker.id)!;
    expect(assignment).toMatchObject({
      agentId: worker.id,
      taskDescription: worker.taskDescription,
      state: "active",
    });
    migrated.reportAssignment(
      assignment.id,
      worker.id,
      worker.processIncarnation ?? 0,
      "complete",
      summary,
      "2026-07-16T04:00:30.000Z",
    );
    migrated.acceptAssignment(
      assignment.id,
      "queen",
      "2026-07-16T04:00:40.000Z",
    );
    expect(migrated.createAssignmentForAgent(worker).state).toBe("accepted");
    expect(migrated.listAssignments()).toHaveLength(1);
    migrated.close();

    const reopened = new HiveDatabase(path);
    try {
      expect(reopened.getOpenAssignmentForAgent(worker.id)).toBeNull();
      expect(reopened.listAssignments()).toHaveLength(1);
      expect(reopened.getLatestAssignmentForAgent(worker.id)?.state).toBe(
        "accepted",
      );
    } finally {
      reopened.close();
    }
  });

  test("a clean read-only turn ending with active work wakes queen exactly once", async () => {
    const recorder = new RootRecorder();
    const { db, daemon: hive } = daemon(
      join(root, "read-only-turn-end.db"),
      recorder,
    );
    try {
      const research = assign(db, agent({
        readOnly: true,
        branch: null,
        worktreePath: null,
      }));
      const assignment = db.getOpenAssignmentForAgent(research.id);
      expect(assignment).toMatchObject({
        agentId: research.id,
        processIncarnation: 1,
        state: "active",
        generation: 0,
      });

      await hive.processEvent({
        kind: "turn-end",
        agentName: research.name,
        timestamp: "2026-07-16T04:01:00.000Z",
      });
      await hive.processEvent({
        kind: "turn-end",
        agentName: research.name,
        timestamp: "2026-07-16T04:02:00.000Z",
      });

      expect(recorder.calls).toHaveLength(1);
      expect(db.listMessages().filter((message) =>
        message.from === "hive-assignment"
      )).toHaveLength(1);
      expect(db.getOpenAssignmentForAgent(research.id)?.state).toBe("active");
    } finally {
      db.close();
    }
  });

  test("a same-agent follow-up rearms the next unfinished-idle generation", async () => {
    const recorder = new RootRecorder();
    const { db, daemon: hive } = daemon(join(root, "follow-up.db"), recorder);
    const worker = assign(db, agent());
    const queen = await client(hive, "queen", "orchestrator");
    try {
      await hive.processEvent({
        kind: "turn-end",
        agentName: worker.name,
        timestamp: "2026-07-16T04:01:00.000Z",
      });
      expect(recorder.calls).toHaveLength(1);

      const sent = await queen.callTool({
        name: "hive_send",
        arguments: {
          from: "queen",
          to: worker.name,
          body: "Continue with the remaining verification.",
          idempotencyKey: "assignment-follow-up-1",
        },
      });
      expect(sent.isError ?? false).toBe(false);
      expect(db.getOpenAssignmentForAgent(worker.id)).toMatchObject({
        state: "in_progress",
        generation: 1,
      });

      await hive.processEvent({
        kind: "turn-end",
        agentName: worker.name,
        timestamp: "2026-07-16T04:03:00.000Z",
      });
      await hive.processEvent({
        kind: "turn-end",
        agentName: worker.name,
        timestamp: "2026-07-16T04:04:00.000Z",
      });
      expect(recorder.calls).toHaveLength(2);
      expect(db.listMessages().filter((message) =>
        message.idempotencyKey?.startsWith("assignment:unfinished-idle:")
      ).map((message) => message.idempotencyKey)).toEqual([
        `assignment:unfinished-idle:${
          db.getOpenAssignmentForAgent(worker.id)!.id
        }:0`,
        `assignment:unfinished-idle:${
          db.getOpenAssignmentForAgent(worker.id)!.id
        }:1`,
      ]);
    } finally {
      await queen.close();
      db.close();
    }
  });

  test("reported complete stays open until acceptance, then ordinary turn-end is silent", async () => {
    const recorder = new RootRecorder();
    const { db, daemon: hive } = daemon(join(root, "acceptance.db"), recorder);
    const worker = assign(db, agent());
    const writer = await client(hive, worker.name, "writer");
    const queen = await client(hive, "queen", "orchestrator");
    try {
      const assignmentId = db.getOpenAssignmentForAgent(worker.id)!.id;
      const progressing = await writer.callTool({
        name: "hive_assignment_report",
        arguments: { agent: worker.name, status: "in_progress", summary },
      });
      expect(progressing.isError ?? false).toBe(false);
      expect(db.getAssignmentById(assignmentId)).toMatchObject({
        state: "in_progress",
        summary,
      });
      expect(recorder.calls).toHaveLength(0);

      const premature = await queen.callTool({
        name: "hive_accept_assignment",
        arguments: { assignmentId },
      });
      expect(premature.isError).toBe(true);
      expect(db.getAssignmentById(assignmentId)?.state).toBe("in_progress");

      const reported = await writer.callTool({
        name: "hive_assignment_report",
        arguments: { agent: worker.name, status: "complete", summary },
      });
      expect(reported.isError ?? false).toBe(false);
      expect(db.getAssignmentById(assignmentId)?.state).toBe(
        "reported_complete",
      );
      expect(recorder.calls).toHaveLength(1);
      const status = textValue(await queen.callTool({
        name: "hive_status",
        arguments: {},
      })) as Array<{ assignment?: { id: string; state: string } }>;
      expect(status[0]?.assignment).toMatchObject({
        id: assignmentId,
        state: "reported_complete",
      });

      const accepted = await queen.callTool({
        name: "hive_accept_assignment",
        arguments: { assignmentId },
      });
      expect(accepted.isError ?? false).toBe(false);
      expect(db.getAssignmentById(assignmentId)).toMatchObject({
        state: "accepted",
        acceptedBy: "queen",
      });
      const afterAcceptance = textValue(await queen.callTool({
        name: "hive_status",
        arguments: {},
      })) as Array<{ assignment?: unknown }>;
      expect(afterAcceptance[0]?.assignment).toBeUndefined();

      await hive.processEvent({
        kind: "turn-end",
        agentName: worker.name,
        timestamp: "2026-07-16T04:05:00.000Z",
      });
      expect(recorder.calls).toHaveLength(1);
    } finally {
      await writer.close();
      await queen.close();
      db.close();
    }
  });

  test("blocked reports wake queen and follow-up makes the assignment in progress", async () => {
    const recorder = new RootRecorder();
    const { db, daemon: hive } = daemon(join(root, "blocked.db"), recorder);
    const worker = assign(db, agent({ readOnly: true }));
    const reader = await client(hive, worker.name, "reader");
    const queen = await client(hive, "queen", "orchestrator");
    try {
      const blocked = await reader.callTool({
        name: "hive_assignment_report",
        arguments: {
          agent: worker.name,
          status: "blocked",
          summary: { ...summary, blockers: ["missing external evidence"] },
        },
      });
      expect(blocked.isError ?? false).toBe(false);
      expect(db.getOpenAssignmentForAgent(worker.id)?.state).toBe("blocked");
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0]).toContain("hive_status");
      expect(recorder.calls[0]).not.toContain("missing external evidence");

      await queen.callTool({
        name: "hive_send",
        arguments: {
          from: "queen",
          to: worker.name,
          body: "The evidence is available; continue.",
          idempotencyKey: "blocked-follow-up",
        },
      });
      expect(db.getOpenAssignmentForAgent(worker.id)).toMatchObject({
        state: "in_progress",
        generation: 1,
        summary: null,
      });
    } finally {
      await reader.close();
      await queen.close();
      db.close();
    }
  });

  test("landing and terminalization do not manufacture assignment completion", async () => {
    const { db, daemon: hive } = daemon(join(root, "git-terminal.db"));
    const worker = assign(db, agent());
    const assignmentId = db.getOpenAssignmentForAgent(worker.id)!.id;
    try {
      await hive.landAgent(worker.name, worker.capabilityEpoch);
      expect(db.getAssignmentById(assignmentId)?.state).toBe("active");

      db.reportAssignment(
        assignmentId,
        worker.id,
        worker.processIncarnation ?? 0,
        "in_progress",
        summary,
        "2026-07-16T04:06:00.000Z",
      );
      db.markAgentDead(worker.id, "2026-07-16T04:07:00.000Z");
      expect(db.getAssignmentById(assignmentId)).toMatchObject({
        state: "in_progress",
        acceptedAt: null,
      });
    } finally {
      db.close();
    }
  });

  test("holderless child and same-name predecessor credentials cannot report or accept", async () => {
    const { db, daemon: hive } = daemon(join(root, "exact-holder-auth.db"));
    const predecessor = assign(db, agent());
    const oldFetch = actingAs(hive, predecessor.name, "writer");
    const oldTransport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: oldFetch },
    );
    const oldClient = new Client({ name: "old-holder", version: "1.0.0" });
    await oldClient.connect(oldTransport);

    const childCredential = hive.capabilities.mint(
      predecessor.name,
      "writer",
      { epoch: predecessor.capabilityEpoch },
    ).token;
    const childTransport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("Authorization", `Bearer ${childCredential}`);
          return hive.fetch(new Request(input, { ...init, headers }));
        },
      },
    );
    const childClient = new Client({ name: "child", version: "1.0.0" });
    await childClient.connect(childTransport);
    const operator = await client(hive, "operator", "operator");
    try {
      const operatorReport = await operator.callTool({
        name: "hive_assignment_report",
        arguments: {
          agent: predecessor.name,
          status: "in_progress",
          summary,
        },
      });
      expect(operatorReport.isError).toBe(true);

      const childReport = await childClient.callTool({
        name: "hive_assignment_report",
        arguments: {
          agent: predecessor.name,
          status: "in_progress",
          summary,
        },
      });
      expect(childReport.isError).toBe(true);

      db.database.query(`
        UPDATE agents
        SET status = 'dead', writeRevoked = 1,
            closedAt = '2026-07-16T04:08:00.000Z'
        WHERE id = ?
      `).run(predecessor.id);
      const successor = assign(db, agent({
        id: "agent-maya-successor",
        processIncarnation: 9,
        processStartedAt: "2026-07-16T04:09:00.000Z",
        createdAt: "2026-07-16T04:09:00.000Z",
        lastEventAt: "2026-07-16T04:09:00.000Z",
      }));
      const successorAssignment = db.getOpenAssignmentForAgent(successor.id)!;
      const predecessorReport = await oldClient.callTool({
        name: "hive_assignment_report",
        arguments: {
          agent: successor.name,
          status: "complete",
          summary,
        },
      });
      expect(predecessorReport.isError).toBe(true);
      const predecessorClose = await oldClient.callTool({
        name: "hive_accept_assignment",
        arguments: { assignmentId: successorAssignment.id },
      });
      expect(predecessorClose.isError).toBe(true);
      expect(db.getAssignmentById(successorAssignment.id)?.state).toBe("active");
    } finally {
      await operator.close();
      await childClient.close();
      await oldClient.close();
      db.close();
    }
  });

  test("a queued unfinished-idle wake survives database restart", async () => {
    const path = join(root, "restart.db");
    const first = daemon(path, new RootRecorder(false));
    const worker = assign(first.db, agent());
    await first.daemon.processEvent({
      kind: "turn-end",
      agentName: worker.name,
      timestamp: "2026-07-16T04:10:00.000Z",
    });
    expect(first.db.listQueuedMessages().filter((message) =>
      message.from === "hive-assignment"
    )).toHaveLength(1);
    first.db.close();

    const recorder = new RootRecorder();
    const restarted = daemon(path, recorder);
    try {
      await restarted.daemon.runMaintenance();
      await restarted.daemon.runMaintenance();
      expect(recorder.calls).toHaveLength(1);
      expect(restarted.db.listQueuedMessages().filter((message) =>
        message.from === "hive-assignment"
      )).toHaveLength(0);
    } finally {
      restarted.db.close();
    }
  });
});
