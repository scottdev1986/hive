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
    recoveryAttempts: 0,
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
        toolSessionId: "0189-session",
        recoveryAttempts: 2,
      });
      // Reaching a terminal status stamps closure durably, from failedAt.
      const closed = { ...updated, closedAt: "2026-07-09T12:01:00.000Z" };
      expect(db.upsertAgent(updated)).toEqual(closed);
      expect(db.listAgents()).toEqual([closed]);
      expect(db.deleteAgent(updated.id)).toEqual(true);
      expect(db.getAgentById(updated.id)).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("stamps closure once and clears it when recovery revives the agent", () => {
    const db = new HiveDatabase(join(home, "closure.db"));
    try {
      db.insertAgent(agent());
      expect(db.getAgentByName("maya")?.closedAt).toBeUndefined();

      const dead = db.markAgentDeadAndDetachTerminal(
        "agent-maya",
        "2026-07-09T12:02:00.000Z",
      );
      expect(dead?.agent.closedAt).toEqual("2026-07-09T12:02:00.000Z");

      // A later write that keeps the agent closed must not slide the instant.
      const rewritten = db.upsertAgent({
        ...dead!.agent,
        failureReason: "killed by orchestrator",
        lastEventAt: "2026-07-09T12:30:00.000Z",
      });
      expect(rewritten.closedAt).toEqual("2026-07-09T12:02:00.000Z");

      // Crash recovery brings this same agent back: it is live, not closed.
      const revived = db.upsertAgent({ ...rewritten, status: "working" });
      expect(revived.closedAt).toBeUndefined();
      expect(db.getLiveAgentByName("maya")?.id).toEqual("agent-maya");
    } finally {
      db.close();
    }
  });

  test("keeps every past holder of a name as its own row", () => {
    const db = new HiveDatabase(join(home, "holders.db"));
    try {
      db.insertAgent(agent({ taskDescription: "crash matrix" }));
      db.markAgentDeadAndDetachTerminal("agent-maya", "2026-07-09T12:02:00.000Z");
      // The name comes back on a brand-new AgentUUID.
      db.insertAgent(agent({
        id: "agent-maya-2",
        taskDescription: "quota ledger",
        createdAt: "2026-07-09T13:00:00.000Z",
      }));

      const holders = db.listAgentsNamed("maya");
      expect(holders.map((holder) => holder.id))
        .toEqual(["agent-maya", "agent-maya-2"]);
      // The closed holder keeps its own task and closure instant: history can
      // still say which maya did what.
      expect(holders[0]).toMatchObject({
        status: "dead",
        taskDescription: "crash matrix",
        closedAt: "2026-07-09T12:02:00.000Z",
      });
      expect(holders[1]).toMatchObject({
        status: "working",
        taskDescription: "quota ledger",
      });

      // A bare name means the live holder, never the ghost.
      expect(db.getAgentByName("maya")?.id).toEqual("agent-maya-2");
      expect(db.getLiveAgentByName("maya")?.id).toEqual("agent-maya-2");
    } finally {
      db.close();
    }
  });

  test("refuses a second live holder of one name", () => {
    const db = new HiveDatabase(join(home, "one-live-holder.db"));
    try {
      db.insertAgent(agent());
      expect(() => db.insertAgent(agent({ id: "agent-maya-2" })))
        .toThrow(/UNIQUE constraint failed/);

      // Once the first holder closes, the name is free again.
      db.markAgentDeadAndDetachTerminal("agent-maya", "2026-07-09T12:02:00.000Z");
      expect(db.insertAgent(agent({ id: "agent-maya-2" })).name).toEqual("maya");
    } finally {
      db.close();
    }
  });

  test("resolves a name with no live holder to its most recent closed one", () => {
    const db = new HiveDatabase(join(home, "closed-lookup.db"));
    try {
      db.insertAgent(agent({ status: "dead", closedAt: timestamp }));
      db.insertAgent(agent({
        id: "agent-maya-2",
        status: "failed",
        createdAt: "2026-07-09T13:00:00.000Z",
        closedAt: "2026-07-09T13:05:00.000Z",
      }));

      expect(db.getLiveAgentByName("maya")).toEqual(null);
      // Delivery looks a recipient up by name and rejects terminal agents; it
      // must see the newest ghost, not an arbitrary one.
      expect(db.getAgentByName("maya")?.id).toEqual("agent-maya-2");
    } finally {
      db.close();
    }
  });

  test("rebuilds a legacy agents table that made names globally unique", () => {
    const path = join(home, "legacy-unique-name.db");
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
        lastEventAt TEXT NOT NULL
      );
      INSERT INTO agents (
        id, name, tool, model, tier, status, taskDescription,
        worktreePath, branch, tmuxSession, contextPct, createdAt, lastEventAt
      ) VALUES (
        'agent-maya', 'maya', 'codex', 'gpt-5-codex', 'standard', 'dead',
        'crash matrix', '/tmp/hive-maya', 'hive/maya-daemon', 'hive-maya',
        12, '${timestamp}', '${timestamp}'
      );
    `);
    legacy.close();

    const db = new HiveDatabase(path);
    try {
      // The dead holder survives the rebuild, with closure backfilled from the
      // only terminal instant a legacy row records.
      expect(db.getAgentByName("maya")).toMatchObject({
        id: "agent-maya",
        status: "dead",
        closedAt: timestamp,
      });
      // And the name is now reusable without overwriting that history.
      db.insertAgent(agent({ id: "agent-maya-2" }));
      expect(db.listAgentsNamed("maya").map((holder) => holder.id))
        .toEqual(["agent-maya", "agent-maya-2"]);
      // The rebuilt table still admits only one live holder.
      expect(() => db.insertAgent(agent({ id: "agent-maya-3" })))
        .toThrow(/UNIQUE constraint failed/);
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
      // A second claim returns null exactly like a missing row: a push path
      // racing another delivery must not report a fresh delivery for a
      // message someone else already claimed.
      expect(
        db.markMessageDelivered(message.id, "2026-07-09T12:02:00.000Z"),
      ).toEqual(null);
      expect(db.getMessage(message.id)?.deliveredAt).toEqual(deliveredAt);
      expect(db.getUndeliveredMessages("maya")).toEqual([]);
      expect(db.deleteMessage(message.id)).toEqual(true);
    } finally {
      db.close();
    }
  });

  test("prunes settled history but never operating state", () => {
    const db = new HiveDatabase(join(home, "prune.db"));
    const old = "2026-06-01T00:00:00.000Z";
    const now = "2026-07-09T12:00:00.000Z";
    const message = (overrides: Partial<AgentMessage>): AgentMessage => ({
      id: "message-old",
      from: "sam",
      to: "maya",
      body: "history",
      createdAt: old,
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
      ...overrides,
    });
    try {
      db.insertEvent({ kind: "turn-start", agentName: "maya", timestamp: old });
      db.insertEvent({ kind: "turn-start", agentName: "maya", timestamp: now });
      db.insertMessage(message({ id: "old-applied", state: "applied" }));
      db.insertMessage(message({ id: "old-queued", sequence: 2 }));
      db.insertApproval({
        id: "old-approved",
        agentName: "maya",
        description: "done",
        status: "approved",
        createdAt: old,
        resolvedAt: old,
      });
      db.insertApproval({
        id: "old-pending",
        agentName: "maya",
        description: "still waiting",
        status: "pending",
        createdAt: old,
        resolvedAt: null,
      });

      expect(db.pruneHistory(now)).toEqual({
        events: 1,
        messages: 1,
        approvals: 1,
      });
      expect(db.listEvents("maya")).toHaveLength(1);
      expect(db.getMessage("old-queued")).not.toBeNull();
      expect(db.getMessage("old-applied")).toBeNull();
      expect(db.getApproval("old-pending")).not.toBeNull();
      expect(db.getApproval("old-approved")).toBeNull();
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

  test("clears stranded spawn-name reservations wholesale at daemon startup", () => {
    const db = new HiveDatabase(join(home, "reservations-clear.db"));
    try {
      expect(db.reserveAgentName("cara", timestamp)).toEqual(true);
      expect(db.reserveAgentName("liam", timestamp)).toEqual(true);
      expect(db.clearAgentNameReservations()).toEqual(2);
      expect(db.isAgentNameReserved("cara")).toEqual(false);
      expect(db.isAgentNameReserved("liam")).toEqual(false);
      expect(db.clearAgentNameReservations()).toEqual(0);
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
