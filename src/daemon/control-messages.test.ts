import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentRecord } from "../schemas";
import { orchestratorTmuxSession } from "./tmux-sessions";
import { HiveDatabase } from "./db";
import { submitPaste } from "./testing";
import {
  type CriticalControlRuntime,
  MessageDelivery,
  type TmuxSender,
} from "./delivery";

const root = mkdtempSync(join(tmpdir(), "hive-controls-"));
const timestamp = "2026-07-09T12:00:00.000Z";

function agent(status: AgentRecord["status"] = "working"): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-test",
    category: "simple_coding",
    status,
    taskDescription: "Build safely",
    worktreePath: "/tmp/hive-control-maya",
    branch: "hive/maya-control",
    tmuxSession: "hive-maya",
    contextPct: 1,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

class RecordingSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];
  constructor(private readonly db: HiveDatabase) {}
  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    submitPaste(this.db, session);
  }
}

class RecordingControlRuntime implements CriticalControlRuntime {
  readonly calls: Array<{ agent: AgentRecord; message: AgentMessage }> = [];
  constructor(private readonly failure?: Error) {}
  async interruptAndRestart(
    value: AgentRecord,
    message: AgentMessage,
  ): Promise<void> {
    this.calls.push({ agent: value, message });
    if (this.failure !== undefined) throw this.failure;
  }
}

describe("priority control messages", () => {
  test("normal remains backward compatible while urgent waits for a safe boundary and requires acknowledgement", async () => {
    const db = new HiveDatabase(join(root, "normal-urgent.db"));
    const sender = new RecordingSender(db);
    const delivery = new MessageDelivery(db, sender);
    try {
      db.insertAgent(agent("idle"));
      const normal = await delivery.send("sam", "maya", "ordinary");
      // A paste is not proof of application: the recipient's TUI queues the text
    // and submits it at its next turn boundary. "injected" is what we can prove.
    expect(normal).toMatchObject({ priority: "normal", state: "injected" });
      expect(sender.calls[0]).toEqual([
        "hive-maya",
        "📨 message from sam: ordinary",
      ]);

      db.upsertAgent({ ...agent("working"), lastEventAt: timestamp });
      const queuedNormal = await delivery.send(
        "sam",
        "maya",
        "ordinary later",
      );
      const urgent = await delivery.send("orchestrator", "maya", "review now", {
        priority: "urgent",
        deadlineMs: 60_000,
      });
      expect(urgent).toMatchObject({ state: "queued", priority: "urgent" });
      expect(sender.calls).toHaveLength(1);

      db.upsertAgent({ ...agent("idle"), lastEventAt: timestamp });
      await delivery.flushQueued("maya");
      expect(db.getMessage(urgent.id)).toMatchObject({ state: "injected" });
      expect(sender.calls[1]?.[1]).toContain("URGENT HIVE CONTROL");
      expect(sender.calls[2]?.[1]).toEqual("📨 message from sam: ordinary later");
      expect(db.getMessage(queuedNormal.id)?.state).toEqual("injected");
      const acknowledged = delivery.acknowledge(
        "maya",
        urgent.id,
        undefined,
        true,
      );
      expect(acknowledged.state).toEqual("applied");
      expect(acknowledged.acknowledgedAt).not.toEqual(null);
      expect(acknowledged.appliedAt).not.toEqual(null);
    } finally {
      db.close();
    }
  });

  test("critical revokes the capability epoch before restart and rejects stale acknowledgement", async () => {
    const db = new HiveDatabase(join(root, "critical.db"));
    const runtime = new RecordingControlRuntime();
    const delivery = new MessageDelivery(db, new RecordingSender(db), runtime);
    try {
      db.insertAgent(agent());
      db.insertApproval({
        id: "stale-approval",
        agentName: "maya",
        description: "Run a stale command",
        status: "pending",
        createdAt: timestamp,
        resolvedAt: null,
      });
      // A stop/cancel/restrict-writes control revokes and replaces the process,
      // so it stays `injected` until the read-only replacement acknowledges.
      // (`pause` is non-destructive and daemon-applied — covered separately.)
      const control = await delivery.send(
        "orchestrator",
        "maya",
        "Stop before coding.",
        { priority: "critical", intent: "stop" },
      );
      expect(control).toMatchObject({
        priority: "critical",
        state: "injected",
        capabilityEpoch: 1,
      });
      expect(runtime.calls[0]?.agent).toMatchObject({
        status: "control-paused",
        writeRevoked: true,
        capabilityEpoch: 1,
      });
      expect(db.getAgentByName("maya")).toMatchObject({
        writeRevoked: true,
        capabilityEpoch: 1,
      });
      expect(db.getApproval("stale-approval")).toMatchObject({
        status: "denied",
      });
      expect(() => delivery.acknowledge("maya", control.id, 0, true))
        .toThrow(/Stale capability epoch/);
      expect(delivery.acknowledge("maya", control.id, 1, false).state)
        .toEqual("applied");
    } finally {
      db.close();
    }
  });

  test("a critical control queued during spawn revokes before the first writer turn", async () => {
    const db = new HiveDatabase(join(root, "spawn-race.db"));
    const runtime = new RecordingControlRuntime();
    const delivery = new MessageDelivery(db, new RecordingSender(db), runtime);
    try {
      db.reserveAgentName("maya", timestamp);
      const queued = await delivery.send(
        "orchestrator",
        "maya",
        "Cancel this task.",
        { priority: "critical", intent: "cancel" },
      );
      expect(queued).toMatchObject({ state: "queued", capabilityEpoch: null });
      db.insertAgent(agent("spawning"));
      db.releaseAgentName("maya");
      expect(await delivery.recoverCriticalControls()).toEqual(1);
      expect(db.getMessage(queued.id)).toMatchObject({
        state: "injected",
        capabilityEpoch: 1,
      });
      expect(runtime.calls[0]?.agent.writeRevoked).toEqual(true);
    } finally {
      db.close();
    }
  });

  test("idempotency, deadline wakeups, and crash recovery are durable", async () => {
    const path = join(root, "recovery.db");
    let db = new HiveDatabase(path);
    const sender = new RecordingSender(db);
    const failing = new RecordingControlRuntime(new Error("restart crashed"));
    db.insertAgent(agent());
    const first = await new MessageDelivery(db, sender, failing).send(
      "orchestrator",
      "maya",
      "Stop now.",
      {
        priority: "critical",
        intent: "stop",
        idempotencyKey: "stop-1",
        deadlineMs: 1,
      },
    );
    expect(first.state).toEqual("queued");
    const duplicate = await new MessageDelivery(db, sender, failing).send(
      "orchestrator",
      "maya",
      "Stop now.",
      { priority: "critical", idempotencyKey: "stop-1" },
    );
    expect(duplicate.id).toEqual(first.id);
    db.close();

    db = new HiveDatabase(path);
    const recoveredRuntime = new RecordingControlRuntime();
    const recoveredDelivery = new MessageDelivery(
      db,
      sender,
      recoveredRuntime,
    );
    try {
      expect(await recoveredDelivery.recoverCriticalControls()).toEqual(1);
      expect(db.getMessage(first.id)?.state).toEqual("injected");
      expect(recoveredRuntime.calls).toHaveLength(1);

      const urgent = await recoveredDelivery.send(
        "orchestrator",
        "maya",
        "Need acknowledgement",
        { priority: "urgent", deadlineMs: 1 },
      );
      const future = new Date(Date.now() + 60_000).toISOString();
      expect(await recoveredDelivery.alertExpiredControls(future)).toEqual(1);
      expect(await recoveredDelivery.alertExpiredControls(future)).toEqual(0);
      expect(db.getMessage(urgent.id)?.alertAt).not.toEqual(null);
      expect(sender.calls).toEqual([]);
      expect(db.listMessages().some((message) =>
        message.to === "queen" &&
        message.body.includes("missed its acknowledgement deadline") &&
        message.deliveredAt === null
      )).toEqual(true);
    } finally {
      db.close();
    }
  });

  test("migrates legacy delivered messages to the applied audit state", () => {
    const path = join(root, "legacy.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, "from" TEXT NOT NULL, "to" TEXT NOT NULL,
        body TEXT NOT NULL, createdAt TEXT NOT NULL, deliveredAt TEXT
      );
      INSERT INTO messages VALUES (
        'legacy', 'sam', 'maya', 'old',
        '2026-07-09T12:00:00.000Z', '2026-07-09T12:01:00.000Z'
      );
    `);
    legacy.close();
    const db = new HiveDatabase(path);
    try {
      expect(db.getMessage("legacy")).toMatchObject({
        priority: "normal",
        state: "applied",
        injectedAt: "2026-07-09T12:01:00.000Z",
      });
    } finally {
      db.close();
    }
  });
});
