import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentMessage,
  AgentRecord,
  HookEvent,
} from "../schemas";
import {
  getDatabaseIdentityPath,
  HiveDatabase,
  type Approval,
} from "./db";
import {
  TerminalHostBindingConflictError,
  type HiveTerminalBinding,
} from "./session-host/terminal-host-binding";
import {
  deleteAgentRow,
  deleteApprovalRow,
  deleteEventRows,
  deleteMessageRow,
  listAgentsNamed,
} from "./testing";

const home = mkdtempSync(join(tmpdir(), "hive-db-test-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
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
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

describe("HiveDatabase", () => {
  test("persists terminal policy binding by the exact Hive locator", () => {
    const path = join(home, "terminal-host-bindings.db");
    const binding: HiveTerminalBinding = {
      locator: {
        schemaVersion: 1,
        instanceId: "hive-fixture",
        subject: { kind: "agent", agentId: "agent-maya" },
        generation: 2,
        sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
        hostKind: "sessiond",
        engineBuildId: "engine-build-fixture",
      },
      visibility: {
        workspaceSessionId: "workspace-fixture",
        workspacePid: 4100,
        workspaceStartToken: "4100:123456",
        openTerminalRevision: "7",
      },
    };
    const createEvidence = {
      expectedExecutable: "/bin/sh",
      executableVerified: true,
      verifiedProviderRoot: {
        pid: 4300,
        startToken: "4300:123456",
        processGroupId: 4300,
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
        state: "attaching" as const,
        workspaceSessionId: binding.visibility.workspaceSessionId,
        openTerminalRevision: binding.visibility.openTerminalRevision,
        expiresAt: "2026-07-18T12:00:15.000Z",
      },
    };
    const terminationAudit = {
      reason: "stop fixture agent",
      requestId: "req_018f1e90-7b5a-7cc0-8000-000000000103",
      requestedAt: "2026-07-18T12:00:00.000Z",
    };
    let db = new HiveDatabase(path);
    try {
      expect(db.bindTerminalHostSession(binding)).toEqual(binding);
      expect(db.bindTerminalHostSession(binding)).toEqual(binding);
      expect(db.completeTerminalHostSession(binding.locator, createEvidence))
        .toEqual({ ...binding, createEvidence });
      expect(db.recordTerminalHostTermination(binding.locator, terminationAudit))
        .toEqual({ ...binding, createEvidence, terminationAudit });
    } finally {
      db.close();
    }

    db = new HiveDatabase(path);
    try {
      const completed = { ...binding, createEvidence, terminationAudit };
      expect(db.getTerminalHostBindingByLocator(binding.locator)).toEqual(completed);
      expect(db.listTerminalHostBindings(binding.locator.instanceId)).toEqual([completed]);
      expect(db.listTerminalHostBindings("another-hive")).toEqual([]);
      expect(db.bindTerminalHostSession(binding)).toEqual(completed);
      expect(() => db.completeTerminalHostSession(binding.locator, {
        ...createEvidence,
        expectedExecutable: "/usr/bin/false",
      })).toThrow(TerminalHostBindingConflictError);
      expect(() => db.bindTerminalHostSession({
        ...binding,
        visibility: { ...binding.visibility, openTerminalRevision: "8" },
      })).toThrow(TerminalHostBindingConflictError);
    } finally {
      db.close();
    }
  });

  test("migrates neutral-ref bindings to locator-only bindings without losing policy", () => {
    const path = join(home, "terminal-host-bindings-legacy.db");
    new HiveDatabase(path).close();
    const legacy = new Database(path);
    legacy.exec(`
      DROP TABLE terminal_host_bindings;
      CREATE TABLE terminal_host_bindings (
        sessionKey TEXT NOT NULL,
        sessionIncarnation TEXT NOT NULL,
        locatorInstanceId TEXT NOT NULL,
        locatorSessionId TEXT NOT NULL,
        locatorGeneration INTEGER NOT NULL CHECK (locatorGeneration > 0),
        locatorJson TEXT NOT NULL,
        visibilityJson TEXT NOT NULL,
        PRIMARY KEY (sessionKey, sessionIncarnation),
        UNIQUE (locatorInstanceId, locatorSessionId, locatorGeneration)
      );
    `);
    const locator = {
      schemaVersion: 1 as const,
      instanceId: "hive-legacy",
      subject: { kind: "agent" as const, agentId: "agent-legacy" },
      generation: 3,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000102",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-build-legacy",
    };
    const visibility = {
      workspaceSessionId: "workspace-legacy",
      workspacePid: 4200,
      workspaceStartToken: "4200:123456",
      openTerminalRevision: "9",
    };
    legacy.query(`
      INSERT INTO terminal_host_bindings (
        sessionKey, sessionIncarnation,
        locatorInstanceId, locatorSessionId, locatorGeneration,
        locatorJson, visibilityJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "neutral-key", "neutral-incarnation", locator.instanceId,
      locator.sessionId, locator.generation, JSON.stringify(locator),
      JSON.stringify(visibility),
    );
    legacy.close();

    const db = new HiveDatabase(path);
    try {
      expect(db.getTerminalHostBindingByLocator(locator)).toEqual({ locator, visibility });
      expect(db.database.query("PRAGMA table_info(terminal_host_bindings)").all())
        .not.toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "sessionKey" }),
          expect.objectContaining({ name: "sessionIncarnation" }),
        ]));
      expect(db.database.query("PRAGMA table_info(terminal_host_bindings)").all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "createEvidenceJson" }),
          expect.objectContaining({ name: "terminationAuditJson" }),
        ]));
    } finally {
      db.close();
    }
  });

  test("opens read-only without creating or migrating schema", () => {
    const path = join(home, "readonly-schema.db");
    const initial = new Database(path, { create: true });
    initial.exec("CREATE TABLE sentinel (value TEXT)");
    initial.close();

    const db = HiveDatabase.openReadonly(path);
    try {
      expect(db.database.query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).all()).toEqual([{ name: "sentinel" }]);
      expect(db.database.query("PRAGMA busy_timeout").get()).toEqual({
        timeout: 5000,
      });
      expect(() => db.database.exec("CREATE TABLE migrated (value TEXT)"))
        .toThrow("attempt to write a readonly database");
    } finally {
      db.close();
    }
  });

  test("read-only opens keep reading while the daemon holds a write lock", () => {
    const path = join(home, "readonly-contention.db");
    const daemon = new HiveDatabase(path);
    daemon.database.exec("BEGIN IMMEDIATE");
    let reader: HiveDatabase | null = null;
    try {
      reader = HiveDatabase.openReadonly(path);
      expect(reader.listAgents()).toEqual([]);
    } finally {
      reader?.close();
      daemon.database.exec("ROLLBACK");
      daemon.close();
    }
  });

  test("round-trips and updates agent records", () => {
    const db = new HiveDatabase(join(home, "agents.db"));
    try {
      const inserted = db.insertAgent(agent());
      expect(inserted).toEqual(expect.objectContaining(agent()));
      expect(inserted.sessionLocator).toEqual(expect.objectContaining({
        schemaVersion: 1,
        subject: { kind: "agent", agentId: "agent-maya" },
        generation: 1,
        hostKind: "tmux",
        engineBuildId: null,
      }));
      expect(db.getAgentByName("maya")).toEqual(inserted);

      const updated = { ...inserted, ...agent({
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
      }) };
      // Reaching a terminal status stamps closure durably, from failedAt.
      const closed = { ...updated, closedAt: "2026-07-09T12:01:00.000Z" };
      expect(db.upsertAgent(updated)).toEqual(closed);
      expect(db.listAgents()).toEqual([closed]);
      expect(deleteAgentRow(db, updated.id)).toEqual(true);
      expect(db.getAgentById(updated.id)).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("migrates legacy readers without clearing genuine control revocation", () => {
    const path = join(home, "legacy-reader-authority.db");
    const initial = new HiveDatabase(path);
    initial.insertAgent(agent({
      id: "legacy-reader",
      name: "reader",
      status: "control-paused",
    }));
    initial.insertAgent(agent({
      id: "critical-writer",
      name: "writer",
      status: "control-paused",
      controlMessageId: "critical-1",
    }));
    initial.close();

    const legacy = new Database(path);
    legacy.exec("ALTER TABLE agents DROP COLUMN readOnly");
    legacy.exec("UPDATE agents SET writeRevoked = 1");
    legacy.close();

    const db = new HiveDatabase(path);
    try {
      expect(db.getAgentByName("reader")).toMatchObject({
        readOnly: true,
        writeRevoked: false,
        status: "idle",
      });
      expect(db.getAgentByName("writer")).toMatchObject({
        readOnly: false,
        writeRevoked: true,
        status: "control-paused",
        controlMessageId: "critical-1",
      });
    } finally {
      db.close();
    }
  });

  test("stamps closure once and clears it when recovery revives the agent", () => {
    const db = new HiveDatabase(join(home, "closure.db"));
    try {
      db.insertAgent(agent());
      expect(db.getAgentByName("maya")?.closedAt).toBeUndefined();

      const dead = db.markAgentDead(
        "agent-maya",
        "2026-07-09T12:02:00.000Z",
      );
      expect(dead?.closedAt).toEqual("2026-07-09T12:02:00.000Z");

      // A later write that keeps the agent closed must not slide the instant.
      const rewritten = db.upsertAgent({
        ...dead!,
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
      db.markAgentDead("agent-maya", "2026-07-09T12:02:00.000Z");
      // The name comes back on a brand-new AgentUUID.
      db.insertAgent(agent({
        id: "agent-maya-2",
        taskDescription: "quota ledger",
        createdAt: "2026-07-09T13:00:00.000Z",
      }));

      const holders = listAgentsNamed(db, "maya");
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
      db.markAgentDead("agent-maya", "2026-07-09T12:02:00.000Z");
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
      expect(listAgentsNamed(db, "maya").map((holder) => holder.id))
        .toEqual(["agent-maya", "agent-maya-2"]);
      // The rebuilt table still admits only one live holder.
      expect(() => db.insertAgent(agent({ id: "agent-maya-3" })))
        .toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  test("marking dead records a failure reason and preserves an existing one", () => {
    const db = new HiveDatabase(join(home, "dead-reasons.db"));
    try {
      db.upsertAgent(agent());
      const reconciled = db.markAgentDead(
        "agent-maya",
        "2026-07-09T13:00:00.000Z",
        "tmux session missing (reconciled)",
      );
      expect(reconciled?.failureReason).toEqual(
        "tmux session missing (reconciled)",
      );

      db.upsertAgent(agent({
        id: "agent-david",
        name: "david",
        status: "stuck",
        failureReason: "earlier reason",
      }));
      const preserved = db.markAgentDead(
        "agent-david",
        "2026-07-09T13:00:00.000Z",
      );
      expect(preserved?.failureReason).toEqual("earlier reason");
    } finally {
      db.close();
    }
  });

  test("migrates legacy agent rows and omits retired viewer state", () => {
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
      value.category,
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
      const migrated = db.getAgentByName("maya")!;
      expect(migrated).toMatchObject({
        ...value,
        contextPct: null,
      });
      expect(migrated.sessionLocator).toMatchObject({
        schemaVersion: 1,
        subject: { kind: "agent", agentId: value.id },
        generation: 1,
        hostKind: "tmux",
      });
      expect(migrated.sessionLocator?.sessionId).toMatch(
        /^ses_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const { sessionLocator: _omitted, ...legacyRewrite } = migrated;
      expect(db.upsertAgent(legacyRewrite).sessionLocator).toEqual(
        migrated.sessionLocator,
      );
      const retiredViewerColumn = ["terminal", "Handle"].join("");
      expect(
        db.database.query("PRAGMA table_info(agents)").all().some(
          (column) => (column as { name: string }).name === retiredViewerColumn,
        ),
      ).toEqual(false);
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
      deliveryDiagnostic: null,
      deliveryDiagnosticAt: null,
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
      expect(deleteMessageRow(db, message.id)).toEqual(true);
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
      deliveryDiagnostic: null,
      deliveryDiagnosticAt: null,
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
        kind: "effort-drift",
        agentName: "maya",
        timestamp,
        description: "Execution effort drifted from high to low",
      },
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
      expect(deleteEventRows(db, "maya")).toEqual(events.length);
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
      kind: "tool-permission",
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
      expect(deleteApprovalRow(db, approval.id)).toEqual(true);
    } finally {
      db.close();
    }
  });

  test("a legacy approval row with no kind column migrates to the never-truncated kind", () => {
    // Rows written before approvals had a `kind` cannot be classified after
    // the fact, and the failure that loses information is truncating a
    // decision-critical description we misread as boilerplate. So the
    // backfill lands on `tool-permission`, which is never trimmed.
    const path = join(home, "legacy-approval-kind.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        agentName TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        resolvedAt TEXT
      );
    `);
    legacy.query(`
      INSERT INTO approvals (id, agentName, description, status, createdAt, resolvedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-approval",
      "maya",
      "Bash: rm -rf ./build && npm publish --access public",
      "pending",
      timestamp,
      null,
    );
    legacy.close();

    const db = new HiveDatabase(path);
    try {
      const approval = db.getApproval("legacy-approval");
      expect(approval?.kind).toEqual("tool-permission");
      expect(approval?.description).toEqual(
        "Bash: rm -rf ./build && npm publish --access public",
      );
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

  test("refuses to recreate a persistent database whose identity marker survived", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hive-lost-db-test-"));
    process.env.HIVE_HOME = isolatedHome;
    const path = join(isolatedHome, "hive.db");
    const db = new HiveDatabase();
    db.close();
    try {
      expect(existsSync(getDatabaseIdentityPath())).toBe(true);
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });

      expect(() => new HiveDatabase()).toThrow(
        "refusing to create an empty replacement",
      );
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
      process.env.HIVE_HOME = home;
    }
  });

  test("keeps first-install and lost-database semantics distinct in both open modes", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hive-open-matrix-test-"));
    process.env.HIVE_HOME = isolatedHome;
    const path = join(isolatedHome, "hive.db");
    try {
      expect(() => HiveDatabase.openReadonly()).toThrow(
        "A read-only command will not create or seed it",
      );
      expect(existsSync(path)).toBe(false);
      expect(existsSync(getDatabaseIdentityPath())).toBe(false);

      const initialized = new HiveDatabase();
      initialized.close();
      expect(existsSync(path)).toBe(true);
      expect(existsSync(getDatabaseIdentityPath())).toBe(true);

      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      expect(() => new HiveDatabase()).toThrow(
        "refusing to create an empty replacement",
      );
      expect(() => HiveDatabase.openReadonly()).toThrow(
        "refusing to create an empty replacement",
      );
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
      process.env.HIVE_HOME = home;
    }
  });

  test("read-only adoption of a legacy database never creates identity or schema", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hive-readonly-adopt-test-"));
    process.env.HIVE_HOME = isolatedHome;
    const path = join(isolatedHome, "hive.db");
    const legacy = new Database(path, { create: true });
    legacy.exec("CREATE TABLE sentinel (value TEXT)");
    const before = legacy.query(
      "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
    ).all();
    legacy.close();
    try {
      expect(existsSync(getDatabaseIdentityPath())).toBe(false);
      const readonly = HiveDatabase.openReadonly();
      readonly.close();
      expect(existsSync(getDatabaseIdentityPath())).toBe(false);

      const observed = new Database(path, { readonly: true });
      try {
        expect(observed.query(
          "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
        ).all()).toEqual(before);
      } finally {
        observed.close();
      }
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
      process.env.HIVE_HOME = home;
    }
  });
});

describe("contextPct can say 'unknown'", () => {
  test("a legacy NOT NULL database is rebuilt, and its known-wrong numbers are dropped", () => {
    const path = join(home, "legacy-contextpct.db");
    const retiredViewerColumn = ["terminal", "Handle"].join("");
    // A database from before unknown was representable: contextPct REAL NOT NULL,
    // carrying the numbers that made this a bug — computed against a hardcoded
    // 200k window while the agent ran a 1M one, so 100% when it was really ~22%.
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, tool TEXT NOT NULL,
        model TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
        taskDescription TEXT NOT NULL, worktreePath TEXT, branch TEXT,
        tmuxSession TEXT NOT NULL, ${retiredViewerColumn} TEXT,
        contextPct REAL NOT NULL,
        createdAt TEXT NOT NULL, lastEventAt TEXT NOT NULL,
        failureReason TEXT, failedAt TEXT, quotaReservationId TEXT,
        controlQuotaReservationId TEXT, controlMessageId TEXT,
        executionIdentity TEXT, toolSessionId TEXT,
        recoveryAttempts INTEGER NOT NULL DEFAULT 0,
        capabilityEpoch INTEGER NOT NULL DEFAULT 0,
        writeRevoked INTEGER NOT NULL DEFAULT 0,
        liveModel TEXT,
        closedAt TEXT
      )
    `);
    legacy.exec(`
      INSERT INTO agents (id, name, tool, model, liveModel, tier, status,
        taskDescription, tmuxSession, contextPct, createdAt, lastEventAt)
      VALUES ('a1', 'zoe', 'claude', 'claude-fable-5', 'claude-opus-4-8',
        'deep', 'working', 'work', 'hive-zoe', 100,
        '2026-07-11T12:00:00.000Z', '2026-07-11T12:00:00.000Z')
    `);
    legacy.close();

    const db = new HiveDatabase(path);
    try {
      const columns = db.database.query("PRAGMA table_info(agents)").all() as Array<
        { name: string; notnull: number }
      >;
      const contextPct = columns.find((column) => column.name === "contextPct");
      expect(contextPct?.notnull).toBe(0);
      expect(columns.some((column) => column.name === retiredViewerColumn)).toBe(false);

      const zoe = db.getAgentByName("zoe");
      // The 100 is gone, not migrated forward: it was computed against the wrong
      // denominator and carrying it across would preserve the exact lie this
      // column is being reshaped to stop telling. Unknown until re-observed.
      expect(zoe?.contextPct).toBeNull();
      // And the rebuild copied everything else, including a column the old
      // hand-maintained copy list had already started forgetting.
      expect(zoe?.liveModel).toBe("claude-opus-4-8");
      expect(zoe?.model).toBe("claude-fable-5");
      expect(zoe?.status).toBe("working");
    } finally {
      db.close();
    }
  });

  test("null survives a write and a read", () => {
    const db = new HiveDatabase(join(home, "null-contextpct.db"));
    try {
      db.insertAgent(agent({ id: "agent-lucas", name: "lucas", contextPct: null }));
      expect(db.getAgentByName("lucas")?.contextPct).toBeNull();
      db.upsertAgent({ ...db.getAgentByName("lucas")!, contextPct: 22 });
      expect(db.getAgentByName("lucas")?.contextPct).toBe(22);
    } finally {
      db.close();
    }
  });

  // The rebuild used to copy only the columns this build knows the name of, and
  // drop the rest — while its own comment claimed it could not. A newer Hive's
  // column, erased by an older one; a hand-added column, erased by any of them.
  test("a column the rebuild has never heard of survives it, values and all", () => {
    const path = join(home, "stray-column.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, tool TEXT NOT NULL,
        model TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
        taskDescription TEXT NOT NULL, worktreePath TEXT, branch TEXT,
        tmuxSession TEXT NOT NULL,
        contextPct REAL NOT NULL,
        createdAt TEXT NOT NULL, lastEventAt TEXT NOT NULL
      )
    `);
    legacy.exec("ALTER TABLE agents ADD COLUMN deploymentRegion TEXT");
    legacy.exec(
      "ALTER TABLE agents ADD COLUMN shardIndex INTEGER NOT NULL DEFAULT 7",
    );
    legacy.exec(`
      INSERT INTO agents (id, name, tool, model, tier, status, taskDescription,
        tmuxSession, contextPct, createdAt, lastEventAt, deploymentRegion)
      VALUES ('a1', 'zoe', 'claude', 'claude-opus-4-8', 'deep', 'idle', 'work',
        'hive-zoe', 42, '2026-07-11T12:00:00.000Z', '2026-07-11T12:00:00.000Z',
        'us-east-1')
    `);
    legacy.close();

    const db = new HiveDatabase(path);
    try {
      const columns = db.database.query("PRAGMA table_info(agents)").all() as Array<
        { name: string; notnull: number; dflt_value: unknown }
      >;
      const shard = columns.find((column) => column.name === "shardIndex");
      expect(columns.some((column) => column.name === "deploymentRegion")).toBe(true);
      // Rebuilt from the old table's own declaration, so the constraint and the
      // default come across too, not just the name.
      expect(shard?.notnull).toBe(1);
      expect(String(shard?.dflt_value)).toBe("7");

      const row = db.database.query(
        "SELECT deploymentRegion, shardIndex FROM agents WHERE id = 'a1'",
      ).get() as { deploymentRegion: string; shardIndex: number };
      expect(row.deploymentRegion).toBe("us-east-1");
      expect(row.shardIndex).toBe(7);
      // The one column the migration does mean to discard, still discarded.
      expect(db.getAgentByName("zoe")?.contextPct).toBeNull();
    } finally {
      db.close();
    }
  });

  // Foreign keys go off for the rebuild, and a throw in between used to leave
  // them off for the rest of the connection's life — silently, and long after
  // the failed migration that caused it had been forgotten.
  test("a rebuild that throws still restores foreign key enforcement", () => {
    const db = new HiveDatabase(join(home, "rebuild-throws.db"));
    try {
      const enforced = (): number =>
        (db.database.query("PRAGMA foreign_keys").get() as {
          foreign_keys: number;
        }).foreign_keys;
      expect(enforced()).toBe(1);

      // Fail the rebuild where it hurts: after foreign keys are already off.
      db.database.exec("CREATE TABLE agents_rebuilt (taken TEXT)");
      expect(() =>
        (db as unknown as { rebuildAgentsTable(expression: string): void })
          .rebuildAgentsTable("NULL")
      ).toThrow();

      expect(enforced()).toBe(1);
      // And the transaction rolled the half-built table back, so agents is whole.
      expect(db.listAgents()).toEqual([]);
    } finally {
      db.close();
    }
  });

  /**
   * The orchestrator's dot is derived from these two rows, so the reader must
   * return them newest-first and must be able to show the contradiction (a
   * turn-end whose predecessor is another turn-end) that means the root's
   * turn-start hook is not reaching us. See orchestrator-status.ts.
   */
  test("reads the root's last lifecycle and turn signals, newest first", () => {
    const db = new HiveDatabase(join(home, "boundaries.db"));
    try {
      // The root has no agents-table row by design; its turns live here.
      db.insertEvent({
        kind: "session-launch",
        agentName: "launching-root",
        timestamp: "2026-07-12T10:00:03.500Z",
      });
      expect(db.recentOrchestratorSignals("launching-root")).toEqual([
        "session-launch",
      ]);

      db.insertEvent({
        kind: "session-start",
        agentName: "orchestrator",
        timestamp: "2026-07-12T10:00:00.000Z",
      });
      db.insertEvent({
        kind: "turn-start",
        agentName: "orchestrator",
        timestamp: "2026-07-12T10:00:01.000Z",
      });
      db.insertEvent({
        kind: "turn-end",
        agentName: "orchestrator",
        timestamp: "2026-07-12T10:00:02.000Z",
      });
      expect(db.recentOrchestratorSignals("orchestrator")).toEqual([
        "turn-end",
        "turn-start",
      ]);

      // The 2026-07-11 stale-port shape: turn-ends keep landing while every
      // turn-start is orphaned. The reader must surface it as-is so the
      // derivation can refuse to call it "idle".
      db.insertEvent({
        kind: "turn-end",
        agentName: "orchestrator",
        timestamp: "2026-07-12T10:00:03.000Z",
      });
      expect(db.recentOrchestratorSignals("orchestrator")).toEqual([
        "turn-end",
        "turn-end",
      ]);

      // A root nobody has heard from has no boundaries at all — not a default.
      expect(db.recentOrchestratorSignals("never-seen")).toEqual([]);

      db.insertEvent({
        kind: "session-start",
        agentName: "fresh-root",
        timestamp: "2026-07-12T10:00:04.000Z",
      });
      expect(db.recentOrchestratorSignals("fresh-root")).toEqual([
        "session-start",
      ]);

      db.insertEvent({
        kind: "session-end",
        agentName: "fresh-root",
        timestamp: "2026-07-12T10:00:05.000Z",
      });
      expect(db.recentOrchestratorSignals("fresh-root")).toEqual([
        "session-end",
        "session-start",
      ]);
    } finally {
      db.close();
    }
  });
});
