import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import { MessageDelivery, type TmuxSender } from "./delivery";
import { HiveDaemon } from "./server";
import type { Spawner } from "./spawner";

const home = mkdtempSync(join(tmpdir(), "hive-delivery-test-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(status: AgentRecord["status"]): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    tier: "standard",
    status,
    taskDescription: "Build delivery",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-delivery",
    tmuxSession: "hive-maya",
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
  };
}

class RecordingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
  }
}

class BlockingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];
  private readonly releases: Array<() => void> = [];

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    await new Promise<void>((resolve) => {
      this.releases.push(resolve);
    });
  }

  releaseNext(): void {
    const release = this.releases.shift();
    if (release === undefined) {
      throw new Error("No blocked tmux send to release");
    }
    release();
  }
}

class FailingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    if (text.includes("First message")) {
      throw new Error("tmux pane unavailable");
    }
  }
}

const unusedSpawner: Spawner = {
  async spawn() {
    throw new Error("not used");
  },
};

describe("MessageDelivery", () => {
  test("stores and immediately delivers to an idle agent", async () => {
    const db = new HiveDatabase(join(home, "immediate.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "Please review this.");
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: Please review this."],
      ]);
      expect(message.deliveredAt === null).toEqual(false);
      expect(db.getMessage(message.id)).toEqual(message);
    } finally {
      db.close();
    }
  });

  test("defers a working recipient and flushes on a turn-end event", async () => {
    const db = new HiveDatabase(join(home, "deferred.db"));
    const tmux = new RecordingTmuxSender();
    const daemon = new HiveDaemon({
      db,
      spawner: unusedSpawner,
      tmuxSender: tmux,
    });
    try {
      db.insertAgent(agent("working"));
      const queued = await daemon.delivery.send("sam", "maya", "Queued work.");
      expect(queued.deliveredAt).toEqual(null);
      expect(tmux.calls).toEqual([]);

      const response = await daemon.fetch(new Request("http://hive/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "turn-end",
          agentName: "maya",
          timestamp: "2026-07-09T12:01:00.000Z",
          contextPct: 31,
        }),
      }));
      expect(response.status).toEqual(200);
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: Queued work."],
      ]);
      expect(db.getMessage(queued.id)?.deliveredAt === null).toEqual(false);
      expect(db.getAgentByName("maya")?.status).toEqual("idle");
      expect(db.getAgentByName("maya")?.contextPct).toEqual(31);
    } finally {
      db.close();
    }
  });

  test("inbox drains undelivered messages without waking a working agent", async () => {
    const db = new HiveDatabase(join(home, "inbox.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent(agent("working"));
      const queued = await delivery.send("sam", "maya", "Read later.");
      const inbox = delivery.inbox("maya");
      expect(inbox.length).toEqual(1);
      expect(inbox[0]?.id).toEqual(queued.id);
      expect(inbox[0]?.deliveredAt === null).toEqual(false);
      expect(delivery.inbox("maya")).toEqual([]);
      expect(tmux.calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("rejects messages to missing and dead recipients", async () => {
    const db = new HiveDatabase(join(home, "invalid-recipient.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      await expect(
        delivery.send("sam", "nobody", "Are you there?"),
      ).rejects.toThrow("Recipient agent not found: nobody");
      db.insertAgent(agent("dead"));
      await expect(
        delivery.send("sam", "maya", "Are you there?"),
      ).rejects.toThrow("Recipient agent is dead: maya");
      expect(db.listMessages()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("serializes concurrent immediate sends for one tmux session", async () => {
    const db = new HiveDatabase(join(home, "serialized.db"));
    const tmux = new BlockingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent(agent("idle"));
      const first = delivery.send("sam", "maya", "First message");
      const second = delivery.send("sam", "maya", "Second message");
      await Bun.sleep(0);
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: First message"],
      ]);

      tmux.releaseNext();
      await Bun.sleep(0);
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: First message"],
        ["hive-maya", "📨 message from sam: Second message"],
      ]);
      tmux.releaseNext();

      const delivered = await Promise.all([first, second]);
      expect(delivered.every((message) => message.deliveredAt !== null)).toEqual(
        true,
      );
    } finally {
      db.close();
    }
  });

  test("rapid queue flushes deliver each message only once", async () => {
    const db = new HiveDatabase(join(home, "flush-race.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent(agent("working"));
      const queued = await delivery.send("sam", "maya", "Only once");
      db.upsertAgent(agent("idle"));

      await Promise.all([
        delivery.flushQueued("maya"),
        delivery.flushQueued("maya"),
      ]);

      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: Only once"],
      ]);
      expect(db.getMessage(queued.id)?.deliveredAt === null).toEqual(false);
    } finally {
      db.close();
    }
  });

  test("a failed queued send does not abort later sends or the event", async () => {
    const db = new HiveDatabase(join(home, "flush-failure.db"));
    const tmux = new FailingTmuxSender();
    const daemon = new HiveDaemon({
      db,
      spawner: unusedSpawner,
      tmuxSender: tmux,
    });
    try {
      db.insertAgent(agent("working"));
      const first = await daemon.delivery.send(
        "sam",
        "maya",
        "First message",
      );
      const second = await daemon.delivery.send(
        "sam",
        "maya",
        "Second message",
      );
      const response = await daemon.fetch(new Request("http://hive/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "turn-end",
          agentName: "maya",
          timestamp: "2026-07-09T12:01:00.000Z",
        }),
      }));

      expect(response.status).toEqual(200);
      expect(tmux.calls.toSorted((left, right) =>
        left[1].localeCompare(right[1])
      )).toEqual([
        ["hive-maya", "📨 message from sam: First message"],
        ["hive-maya", "📨 message from sam: Second message"],
      ]);
      expect(db.getMessage(first.id)?.deliveredAt).toEqual(null);
      expect(db.getMessage(second.id)?.deliveredAt === null).toEqual(false);
    } finally {
      db.close();
    }
  });
});
