import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import {
  MessageDelivery,
  type NativeAgentControl,
  type TmuxSender,
} from "./delivery";
import { HiveDaemon } from "./server";
import { actingAs } from "./testing";
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
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
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

class UnavailableTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    throw new Error("tmux session unavailable");
  }
}

class RecordingNativeControl implements NativeAgentControl {
  readonly calls: Array<{ agent: string; text: string; interrupt: boolean }> = [];

  hasAgent(agentName: string): boolean {
    return agentName === "maya";
  }

  async deliver(
    value: AgentRecord,
    text: string,
    options: { interrupt?: boolean } = {},
  ): Promise<void> {
    this.calls.push({
      agent: value.name,
      text,
      interrupt: options.interrupt === true,
    });
  }
}

const unusedSpawner: Spawner = {
  async spawn() {
    throw new Error("not used");
  },
};

describe("MessageDelivery", () => {
  test("steers a working native Codex session and interrupts it for urgent control", async () => {
    const db = new HiveDatabase(join(home, "native-codex.db"));
    const tmux = new RecordingTmuxSender();
    const native = new RecordingNativeControl();
    const delivery = new MessageDelivery(db, tmux, undefined, native);
    try {
      db.insertAgent(agent("working"));
      const normal = await delivery.send(
        "orchestrator",
        "maya",
        "Focus on the failing test.",
      );
      const urgent = await delivery.send(
        "orchestrator",
        "maya",
        "Pause and report current state.",
        { priority: "urgent" },
      );
      expect(native.calls).toEqual([
        {
          agent: "maya",
          text: "📨 message from orchestrator: Focus on the failing test.",
          interrupt: false,
        },
        {
          agent: "maya",
          text: expect.stringContaining("URGENT HIVE CONTROL"),
          interrupt: true,
        },
      ]);
      expect(normal.state).toEqual("applied");
      expect(urgent.state).toEqual("injected");
      expect(tmux.calls).toEqual([]);
    } finally {
      db.close();
    }
  });

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

      const response = await actingAs(daemon, "operator")("http://hive/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "turn-end",
          agentName: "maya",
          timestamp: "2026-07-09T12:01:00.000Z",
          contextPct: 31,
        }),
      });
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

  test("queues before registration and delivers on the recipient's first inbox poll", async () => {
    const db = new HiveDatabase(join(home, "send-before-register.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      expect(db.reserveAgentName("maya", timestamp)).toEqual(true);
      const queued = await delivery.send(
        "sam",
        "maya",
        "Sent while you were spawning.",
      );
      expect(queued.deliveredAt).toEqual(null);
      expect(tmux.calls).toEqual([]);

      db.insertAgent(agent("working"));
      db.releaseAgentName("maya");
      const inbox = delivery.inbox("maya");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        id: queued.id,
        body: "Sent while you were spawning.",
      });
      expect(inbox[0]?.deliveredAt).not.toEqual(null);
      expect(delivery.inbox("maya")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("flushes a pre-registration message when the recipient session starts", async () => {
    const db = new HiveDatabase(join(home, "register-and-wake.db"));
    const tmux = new RecordingTmuxSender();
    const daemon = new HiveDaemon({
      db,
      spawner: unusedSpawner,
      tmuxSender: tmux,
    });
    try {
      db.reserveAgentName("maya", timestamp);
      const queued = await daemon.delivery.send(
        "sam",
        "maya",
        "Welcome online.",
      );
      db.insertAgent(agent("spawning"));
      db.releaseAgentName("maya");

      const response = await actingAs(daemon, "operator")("http://hive/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "session-start",
          agentName: "maya",
          timestamp: "2026-07-09T12:00:30.000Z",
        }),
      });

      expect(response.status).toEqual(200);
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: Welcome online."],
      ]);
      expect(db.getMessage(queued.id)?.deliveredAt).not.toEqual(null);
    } finally {
      db.close();
    }
  });

  test("rejects messages to names that are neither registered nor spawning", async () => {
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

  test("keeps reports unread when root is unavailable and drains them exactly once", async () => {
    const db = new HiveDatabase(join(home, "orchestrator-inbox.db"));
    const tmux = new UnavailableTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      const report = "Task complete.\nRoot cause: enter race.\nBranch: hive/maya-delivery";
      const queued = await delivery.send("maya", "orchestrator", report);
      expect(queued.deliveredAt).toEqual(null);
      expect(tmux.calls).toHaveLength(1);

      const inbox = await delivery.orchestratorInbox();
      expect(inbox.length).toEqual(1);
      expect(inbox[0]?.id).toEqual(queued.id);
      expect(inbox[0]?.body).toEqual(report);
      expect(await delivery.orchestratorInbox()).toEqual([]);
      expect(db.getMessage(queued.id)?.deliveredAt).not.toEqual(null);
    } finally {
      db.close();
    }
  });

  test("orchestrator stays a valid recipient even when agents are dead", async () => {
    const db = new HiveDatabase(join(home, "orchestrator-always.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      db.insertAgent(agent("dead"));
      const queued = await delivery.send(
        "maya",
        "orchestrator",
        "Still reachable.",
      );
      expect(db.getMessage(queued.id)?.deliveredAt).not.toEqual(null);
    } finally {
      db.close();
    }
  });

  test("orchestrator messages reach an idle agent immediately", async () => {
    const db = new HiveDatabase(join(home, "orchestrator-to-idle.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send(
        "orchestrator",
        "maya",
        "Start with the auth module.",
      );
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from orchestrator: Start with the auth module."],
      ]);
      expect(message.deliveredAt === null).toEqual(false);
    } finally {
      db.close();
    }
  });

  test("orchestrator messages to a working agent queue and flush on turn-end", async () => {
    const db = new HiveDatabase(join(home, "orchestrator-to-working.db"));
    const tmux = new RecordingTmuxSender();
    const daemon = new HiveDaemon({
      db,
      spawner: unusedSpawner,
      tmuxSender: tmux,
    });
    try {
      db.insertAgent(agent("working"));
      const queued = await daemon.delivery.send(
        "orchestrator",
        "maya",
        "When done, also update the docs.",
      );
      expect(queued.deliveredAt).toEqual(null);
      expect(tmux.calls).toEqual([]);

      const response = await actingAs(daemon, "operator")("http://hive/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "turn-end",
          agentName: "maya",
          timestamp: "2026-07-09T12:02:00.000Z",
        }),
      });
      expect(response.status).toEqual(200);
      expect(tmux.calls).toEqual([
        [
          "hive-maya",
          "📨 message from orchestrator: When done, also update the docs.",
        ],
      ]);
      expect(db.getMessage(queued.id)?.deliveredAt === null).toEqual(false);
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
      const response = await actingAs(daemon, "operator")("http://hive/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "turn-end",
          agentName: "maya",
          timestamp: "2026-07-09T12:01:00.000Z",
        }),
      });

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
