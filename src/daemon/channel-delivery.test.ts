import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import {
  MessageDelivery,
  formatChannelMessage,
  type ChannelDeliverer,
  type TmuxSender,
} from "./delivery";

const home = mkdtempSync(join(tmpdir(), "hive-channel-delivery-"));
process.env.HIVE_HOME = home;

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(status: AgentRecord["status"]): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "claude",
    model: "claude-fable-5",
    tier: "standard",
    status,
    taskDescription: "Build delivery",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-delivery",
    tmuxSession: "hive-maya",
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: true,
  };
}

class RecordingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];
  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
  }
}

class FakeChannel implements ChannelDeliverer {
  readonly calls: Array<{ agent: string; content: string; meta: Record<string, string> }> = [];
  constructor(
    private live: boolean,
    private confirm: boolean | "throw" = true,
  ) {}
  isLive(): boolean {
    return this.live;
  }
  async deliverMessage(
    agentName: string,
    content: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    this.calls.push({ agent: agentName, content, meta });
    if (this.confirm === "throw") throw new Error("bridge exploded");
    return this.confirm;
  }
  setLive(value: boolean): void {
    this.live = value;
  }
}

let counter = 0;
const freshDb = (): HiveDatabase =>
  new HiveDatabase(join(home, `channel-${counter++}.db`));

describe("channel-first delivery", () => {
  test("delivers to an idle agent over the channel and never pastes", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(true);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "reuse the middleware");

      expect(channel.calls).toHaveLength(1);
      expect(channel.calls[0]?.content).toBe("reuse the middleware");
      expect(channel.calls[0]?.meta).toMatchObject({
        sender: "sam",
        priority: "normal",
        intent: "instruction",
      });
      expect(tmux.calls).toEqual([]);
      // The CLI queues the event for its next turn and never acknowledges it,
      // so a channel delivery stops at "injected" — never "applied".
      expect(message.state).toBe("injected");
      expect(message.deliveredAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("delivers to a busy agent because the CLI queues events for the next turn", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(true);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("working"));
      const message = await delivery.send("sam", "maya", "heads up");
      expect(channel.calls).toHaveLength(1);
      expect(tmux.calls).toEqual([]);
      expect(message.state).toBe("injected");
    } finally {
      db.close();
    }
  });

  test("falls back to tmux paste when no channel is live", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(false);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "reuse the middleware");
      expect(channel.calls).toEqual([]);
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from sam: reuse the middleware"],
      ]);
      // The paste-then-Enter path structurally submits the turn.
      expect(message.state).toBe("applied");
    } finally {
      db.close();
    }
  });

  test("falls back to tmux when the bridge does not confirm the write", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(true, false);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "hello");
      expect(channel.calls).toHaveLength(1);
      expect(tmux.calls).toHaveLength(1);
      expect(message.state).toBe("applied");
    } finally {
      db.close();
    }
  });

  test("falls back to tmux when the bridge throws", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(true, "throw");
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "hello");
      expect(tmux.calls).toHaveLength(1);
      expect(message.state).toBe("applied");
    } finally {
      db.close();
    }
  });

  test("an unconfirmed channel leaves a busy agent's message durably queued", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(true, false);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("working"));
      const message = await delivery.send("sam", "maya", "hello");
      expect(tmux.calls).toEqual([]);
      expect(message.state).toBe("queued");
      expect(message.deliveredAt).toBeNull();
      expect(db.getUndeliveredMessages("maya")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("flushQueued drains a queued message over the channel at a turn boundary", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(false);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("working"));
      const queued = await delivery.send("sam", "maya", "later");
      expect(queued.state).toBe("queued");

      db.upsertAgent(agent("idle"));
      channel.setLive(true);
      const drained = await delivery.flushQueued("maya");
      expect(drained).toHaveLength(1);
      expect(drained[0]?.state).toBe("injected");
      expect(channel.calls).toHaveLength(1);
      expect(tmux.calls).toEqual([]);
      expect(db.getUndeliveredMessages("maya")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a channel-delivered message is not re-delivered by a later flush", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(true);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("idle"));
      await delivery.send("sam", "maya", "once");
      expect(await delivery.flushQueued("maya")).toEqual([]);
      expect(channel.calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an urgent message carries its acknowledgement instruction into the channel", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel = new FakeChannel(true);
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "pivot now", {
        priority: "urgent",
      });
      expect(channel.calls[0]?.content).toContain("pivot now");
      expect(channel.calls[0]?.content).toContain("hive_ack_message");
      expect(channel.calls[0]?.meta.priority).toBe("urgent");
      expect(message.state).toBe("injected");
    } finally {
      db.close();
    }
  });

  test("a send to an agent that dies mid-lock stays durably queued", async () => {
    const db = freshDb();
    const tmux = new RecordingTmuxSender();
    const channel: ChannelDeliverer = {
      isLive: () => true,
      async deliverMessage() {
        // The agent dies while the channel push is in flight.
        db.upsertAgent(agent("dead"));
        return false;
      },
    };
    const delivery = new MessageDelivery(db, tmux, undefined, channel);
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "hello");
      expect(message.state).toBe("queued");
      expect(tmux.calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("formatChannelMessage", () => {
  test("uses bare-identifier meta keys the CLI will not drop", () => {
    const { meta } = formatChannelMessage({
      id: "m1",
      from: "sam",
      to: "maya",
      body: "hi",
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
      sequence: 3,
      idempotencyKey: null,
      capabilityEpoch: null,
    });
    for (const key of Object.keys(meta)) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    }
    expect(meta.sequence).toBe("3");
    expect(meta.message_id).toBe("m1");
  });

  test("a critical control names its capability epoch", () => {
    const { content } = formatChannelMessage({
      id: "m2",
      from: "hive-control",
      to: "maya",
      body: "stop",
      createdAt: timestamp,
      deliveredAt: null,
      priority: "critical",
      intent: "stop",
      state: "queued",
      injectedAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      deadlineAt: null,
      alertAt: null,
      sequence: 1,
      idempotencyKey: null,
      capabilityEpoch: 4,
    });
    expect(content).toContain("capabilityEpoch=4");
  });
});
