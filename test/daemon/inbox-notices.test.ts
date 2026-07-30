import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import { MessageDelivery, type SessionSender } from "../../src/daemon/delivery";
import type { AgentRecord } from "../../src/schemas";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function agent(status: AgentRecord["status"]): AgentRecord {
  const now = "2026-07-30T12:00:00.000Z";
  return {
    id: "maya-id",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status,
    taskDescription: "Build the inbox.",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya",
    contextPct: null,
    createdAt: now,
    lastEventAt: now,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

class Sender implements SessionSender {
  readonly calls: Array<{ text: string; interrupt: boolean | undefined }> = [];

  async sendSessionMessage(
    _recipient: AgentRecord,
    text: string,
    options: { messageId: string; interrupt?: boolean },
  ): Promise<void> {
    this.calls.push({ text, interrupt: options.interrupt });
  }
}

function harness(status: AgentRecord["status"]) {
  const root = mkdtempSync(join(tmpdir(), "hive-inbox-notice-"));
  roots.push(root);
  const db = new HiveDatabase(join(root, "hive.db"));
  db.insertAgent(agent(status));
  const sender = new Sender();
  return { db, delivery: new MessageDelivery(db, sender), sender };
}

describe("inbox notices", () => {
  test("coalesces normal messages and requires explicit acknowledgement", async () => {
    const { db, delivery, sender } = harness("working");
    const first = await delivery.send("queen", "maya", "First body.");
    const second = await delivery.send("sam", "maya", "Second body.");

    expect(sender.calls).toEqual([]);
    expect(first.state).toBe("queued");
    expect(second.state).toBe("queued");

    db.upsertAgent(agent("idle"));
    await delivery.flushQueued("maya");

    expect(sender.calls).toEqual([
      {
        text: "📨 Hive: 2 unread messages. Check hive_inbox.",
        interrupt: false,
      },
    ]);
    expect(await delivery.inbox("maya")).toHaveLength(2);
    expect(db.getMessage(first.id)?.state).toBe("notified");

    const acknowledged = delivery.acknowledge("maya", first.id);
    expect(acknowledged.state).toBe("acknowledged");
    expect(await delivery.inbox("maya")).toMatchObject([{ id: second.id }]);
  });

  test("urgent delivery interrupts once and still exposes only an inbox notice", async () => {
    const { delivery, sender } = harness("working");
    const message = await delivery.send(
      "queen",
      "maya",
      "Stop the current task.",
      {
        priority: "urgent",
      },
    );

    expect(sender.calls).toEqual([
      {
        text: "⚠️ Hive: urgent message from queen. Check hive_inbox now.",
        interrupt: true,
      },
    ]);
    expect(sender.calls[0]?.text).not.toContain("Stop the current task.");
    expect(message.state).toBe("notified");
  });
});
