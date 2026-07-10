import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentMessage,
  AgentRecord,
  HookEvent,
} from "../schemas";
import { HiveDatabase, type Approval } from "./db";

const home = mkdtempSync(join(tmpdir(), "hive-db-test-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    tier: "standard",
    status: "working",
    taskDescription: "Build the daemon",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-daemon",
    tmuxSession: "hive-maya",
    contextPct: 12,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
    ...overrides,
  };
}

describe("HiveDatabase", () => {
  test("round-trips and updates agent records", () => {
    const db = new HiveDatabase(join(home, "agents.db"));
    try {
      const inserted = db.insertAgent(agent());
      expect(inserted).toEqual(agent());
      expect(db.getAgentByName("maya")).toEqual(agent());

      const updated = agent({
        status: "failed",
        contextPct: 28,
        failureReason: "Error: model not supported",
        failedAt: "2026-07-09T12:01:00.000Z",
        executionIdentity: {
          tool: "codex",
          model: "gpt-5-codex",
          effort: "high",
        },
        controlMessageId: "control-1",
        controlQuotaReservationId: "quota-control-1",
      });
      expect(db.upsertAgent(updated)).toEqual(updated);
      expect(db.listAgents()).toEqual([updated]);
      expect(db.deleteAgent(updated.id)).toEqual(true);
      expect(db.getAgentById(updated.id)).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("attaches terminal handles only while an agent is live", () => {
    const db = new HiveDatabase(join(home, "terminal-handles.db"));
    const handle = { app: "iterm2", sessionId: "session-agent-maya" } as const;
    try {
      db.insertAgent(agent());
      expect(db.attachTerminalHandle("agent-maya", handle)?.terminalHandle)
        .toEqual(handle);

      const killed = db.markAgentDeadAndDetachTerminal(
        "agent-maya",
        "2026-07-09T12:02:00.000Z",
      );
      expect(killed?.terminalHandle).toEqual(handle);
      expect(killed?.agent).toMatchObject({
        status: "dead",
        lastEventAt: "2026-07-09T12:02:00.000Z",
      });
      expect(killed?.agent.terminalHandle).toBeUndefined();
      expect(db.attachTerminalHandle("agent-maya", handle)).toEqual(null);
      expect(db.getAgentByName("maya")?.terminalHandle).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("marking dead records a failure reason and preserves an existing one", () => {
    const db = new HiveDatabase(join(home, "dead-reasons.db"));
    try {
      db.upsertAgent(agent({
        terminalHandle: { app: "iterm2", sessionId: "session-maya" },
      }));
      const reconciled = db.markAgentDeadAndDetachTerminal(
        "agent-maya",
        "2026-07-09T13:00:00.000Z",
        "tmux session missing (reconciled)",
      );
      expect(reconciled?.terminalHandle).toEqual({
        app: "iterm2",
        sessionId: "session-maya",
      });
      expect(reconciled?.agent.failureReason).toEqual(
        "tmux session missing (reconciled)",
      );

      db.upsertAgent(agent({
        id: "agent-david",
        name: "david",
        status: "stuck",
        failureReason: "earlier reason",
      }));
      const preserved = db.markAgentDeadAndDetachTerminal(
        "agent-david",
        "2026-07-09T13:00:00.000Z",
      );
      expect(preserved?.agent.failureReason).toEqual("earlier reason");
    } finally {
      db.close();
    }
  });

  test("round-trips the orchestrator terminal handle", () => {
    const db = new HiveDatabase(join(home, "orchestrator-terminal.db"));
    try {
      expect(db.getOrchestratorTerminal()).toBeNull();

      const first = {
        app: "terminal",
        processId: 88,
        windowId: 12,
        tty: "/dev/ttys002",
      } as const;
      db.setOrchestratorTerminal(first);
      expect(db.getOrchestratorTerminal()).toEqual(first);

      const replacement = { app: "iterm2", sessionId: "root-1" } as const;
      db.setOrchestratorTerminal(replacement);
      expect(db.getOrchestratorTerminal()).toEqual(replacement);

      db.clearOrchestratorTerminal();
      expect(db.getOrchestratorTerminal()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("treats a corrupted orchestrator terminal record as absent", () => {
    const db = new HiveDatabase(join(home, "orchestrator-corrupt.db"));
    try {
      db.database.query(
        "INSERT INTO meta (key, value) VALUES ('orchestratorTerminal', 'not json')",
      ).run();
      expect(db.getOrchestratorTerminal()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("migrates legacy agent rows with no terminal handle", () => {
    const path = join(home, "legacy-agents.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        tool TEXT NOT NULL,
        model TEXT NOT NULL,
        tier TEXT NOT NULL,
        status TEXT NOT NULL,
        taskDescription TEXT NOT NULL,
        worktreePath TEXT,
        branch TEXT,
        tmuxSession TEXT NOT NULL,
        contextPct REAL NOT NULL,
        createdAt TEXT NOT NULL,
        lastEventAt TEXT NOT NULL,
        failureReason TEXT,
        failedAt TEXT
      );
    `);
    const value = agent();
    legacy.query(`
      INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.id,
      value.name,
      value.tool,
      value.model,
      value.tier,
      value.status,
      value.taskDescription,
      value.worktreePath,
      value.branch,
      value.tmuxSession,
      value.contextPct,
      value.createdAt,
      value.lastEventAt,
      null,
      null,
    );
    legacy.close();

    const db = new HiveDatabase(path);
    try {
      expect(db.getAgentByName("maya")).toEqual(value);
      expect(
        db.database.query("PRAGMA table_info(agents)").all().some(
          (column) => (column as { name: string }).name === "terminalHandle",
        ),
      ).toEqual(true);
      for (const name of [
        "executionIdentity",
        "controlMessageId",
        "controlQuotaReservationId",
      ]) {
        expect(
          db.database.query("PRAGMA table_info(agents)").all().some(
            (column) => (column as { name: string }).name === name,
          ),
        ).toEqual(true);
      }
      expect(
        db.database.query("PRAGMA table_info(agents)").all().some(
          (column) =>
            (column as { name: string }).name === "quotaReservationId",
        ),
      ).toEqual(true);
    } finally {
      db.close();
    }
  });

  test("round-trips messages and delivery updates", () => {
    const db = new HiveDatabase(join(home, "messages.db"));
    const message: AgentMessage = {
      id: "message-1",
      from: "sam",
      to: "maya",
      body: "The interface is ready.",
      createdAt: timestamp,
      deliveredAt: null,
      priority: "normal",
      intent: "instruction",
      state: "queued",
      injectedAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      deadlineAt: null,
      alertAt: null,
      sequence: 1,
      idempotencyKey: null,
      capabilityEpoch: null,
    };
    try {
      expect(db.insertMessage(message)).toEqual(message);
      expect(db.getUndeliveredMessages("maya")).toEqual([message]);
      const deliveredAt = "2026-07-09T12:01:00.000Z";
      expect(db.markMessageDelivered(message.id, deliveredAt)).toEqual({
        ...message,
        deliveredAt,
      });
      expect(db.getUndeliveredMessages("maya")).toEqual([]);
      expect(db.deleteMessage(message.id)).toEqual(true);
    } finally {
      db.close();
    }
  });

  test("durably reserves agent names during spawn", () => {
    const path = join(home, "agent-name-reservations.db");
    let db = new HiveDatabase(path);
    expect(db.reserveAgentName("cara", timestamp)).toEqual(true);
    expect(db.reserveAgentName("cara", timestamp)).toEqual(false);
    db.close();

    db = new HiveDatabase(path);
    try {
      expect(db.isAgentNameReserved("cara")).toEqual(true);
      expect(db.releaseAgentName("cara")).toEqual(true);
      expect(db.isAgentNameReserved("cara")).toEqual(false);
    } finally {
      db.close();
    }
  });

  test("round-trips every hook event variant", () => {
    const db = new HiveDatabase(join(home, "events.db"));
    const events: HookEvent[] = [
      { kind: "session-start", agentName: "maya", timestamp },
      { kind: "turn-start", agentName: "maya", timestamp },
      { kind: "turn-end", agentName: "maya", timestamp, contextPct: 42 },
      { kind: "turn-end", agentName: "maya", timestamp },
      { kind: "notification", agentName: "maya", timestamp },
      {
        kind: "approval-request",
        agentName: "maya",
        timestamp,
        description: "Access the network",
      },
      { kind: "dead", agentName: "maya", timestamp },
    ];
    try {
      for (const event of events) {
        expect(db.insertEvent(event)).toEqual(event);
      }
      expect(db.listEvents()).toEqual(events);
      expect(db.listEvents("maya")).toEqual(events);
      expect(db.deleteEvents("maya")).toEqual(events.length);
      expect(db.listEvents()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("round-trips and resolves approvals", () => {
    const db = new HiveDatabase(join(home, "approvals.db"));
    const approval = {
      id: "approval-1",
      agentName: "maya",
      description: "Run a network install",
      status: "pending",
      createdAt: timestamp,
      resolvedAt: null,
    } satisfies Approval;
    try {
      expect(db.insertApproval(approval)).toEqual(approval);
      expect(db.listApprovals("pending")).toEqual([approval]);
      const resolvedAt = "2026-07-09T12:02:00.000Z";
      const resolved = {
        ...approval,
        status: "approved",
        resolvedAt,
      } satisfies Approval;
      expect(db.resolveApproval(approval.id, "approved", resolvedAt)).toEqual(resolved);
      expect(db.resolveApproval(approval.id, "denied", resolvedAt)).toEqual(null);
      expect(db.listApprovals("approved")).toEqual([resolved]);
      expect(db.deleteApproval(approval.id)).toEqual(true);
    } finally {
      db.close();
    }
  });

  test("restart resolves legacy notification approvals without hiding real escalations", () => {
    const path = join(home, "legacy-notification-approvals.db");
    let db = new HiveDatabase(path);
    db.insertAgent(agent({ status: "awaiting-approval" }));
    db.insertApproval({
      id: "notification-approval",
      agentName: "maya",
      description: "Notification from maya",
      status: "pending",
      createdAt: timestamp,
      resolvedAt: null,
    });
    db.close();

    db = new HiveDatabase(path);
    try {
      expect(db.listApprovals("pending")).toEqual([]);
      expect(db.getApproval("notification-approval")).toMatchObject({
        status: "approved",
      });
      expect(db.getAgentByName("maya")?.status).toEqual("idle");

      db.insertApproval({
        id: "real-approval",
        agentName: "maya",
        description: "Run npm publish",
        status: "pending",
        createdAt: timestamp,
        resolvedAt: null,
      });
      db.upsertAgent({ ...db.getAgentByName("maya")!, status: "awaiting-approval" });
    } finally {
      db.close();
    }

    db = new HiveDatabase(path);
    try {
      expect(db.listApprovals("pending").map((approval) => approval.id)).toEqual([
        "real-approval",
      ]);
      expect(db.getAgentByName("maya")?.status).toEqual("awaiting-approval");
    } finally {
      db.close();
    }
  });

  test("uses HIVE_HOME and enables WAL mode", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hive-home-test-"));
    process.env.HIVE_HOME = isolatedHome;
    const db = new HiveDatabase();
    try {
      expect(db.path).toEqual(join(isolatedHome, "hive.db"));
      expect(db.database.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
    } finally {
      db.close();
      rmSync(isolatedHome, { recursive: true, force: true });
      process.env.HIVE_HOME = home;
    }
  });
});
