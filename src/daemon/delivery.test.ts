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

/**
 * A pane that takes the paste and never does anything with it.
 *
 * This is a *broken* TUI, and it is what every fake in this file used to be:
 * `sendMessage` resolves, so `tmux send-keys` "succeeded", and the agent's mind
 * never changed. Keep it only for the cases that are about exactly that.
 */
class RecordingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
  }
}

let turnClock = Date.parse("2026-07-09T12:30:00.000Z");

/** Turns are strictly ordered in time; two stamped in one millisecond are not
 * distinguishable as "a new turn", so the fakes advance a clock. */
function nextTurnStart(db: HiveDatabase, agentName: string): void {
  turnClock += 1_000;
  db.insertEvent({
    kind: "turn-start",
    agentName,
    timestamp: new Date(turnClock).toISOString(),
  });
}

/**
 * A pane that behaves like a real one: an idle TUI handed a paste submits it,
 * and the model starts a turn, which the agent reports through its hook stream.
 *
 * That turn-start is the only evidence Hive ever gets that a message actually
 * reached a mind, so a fake that omits it is not a simplification — it is a
 * TUI that silently drops every message while reporting success, which is the
 * bug under test rather than a stand-in for delivery working.
 */
class SubmittingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  constructor(
    private readonly db: HiveDatabase,
    private readonly agentName = "maya",
  ) {}

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    nextTurnStart(this.db, this.agentName);
  }
}

class BlockingTmuxSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];
  private readonly releases: Array<() => void> = [];

  constructor(private readonly db: HiveDatabase) {}

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    await new Promise<void>((resolve) => {
      this.releases.push(resolve);
    });
    nextTurnStart(this.db, "maya");
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

  constructor(private readonly db: HiveDatabase) {}

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
    if (text.includes("First message")) {
      throw new Error("tmux pane unavailable");
    }
    nextTurnStart(this.db, "maya");
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
      expect(normal.state).toEqual("injected");
      expect(urgent.state).toEqual("injected");
      expect(tmux.calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores and immediately delivers to an idle agent", async () => {
    const db = new HiveDatabase(join(home, "immediate.db"));
    const tmux = new SubmittingTmuxSender(db);
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
    const tmux = new SubmittingTmuxSender(db);
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

  test("urgent messages inject into a busy agent at a tool boundary; normal ones keep waiting", async () => {
    const db = new HiveDatabase(join(home, "urgent-boundary.db"));
    const tmux = new RecordingTmuxSender();
    const daemon = new HiveDaemon({
      db,
      spawner: unusedSpawner,
      tmuxSender: tmux,
    });
    try {
      db.insertAgent(agent("working"));
      const normal = await daemon.delivery.send("sam", "maya", "Read later.");
      const urgent = await daemon.delivery.send(
        "orchestrator",
        "maya",
        "Pause before coding the next module.",
        { priority: "urgent", intent: "instruction" },
      );
      // Both queue: the recipient is mid-turn with no live channel.
      expect(normal.deliveredAt).toEqual(null);
      expect(urgent.deliveredAt).toEqual(null);
      expect(tmux.calls).toEqual([]);

      // A completed tool call is the nearest safe boundary (SPEC decision
      // 1): urgent traffic injects now, ordinary traffic still waits for
      // the turn to end.
      const response = await actingAs(daemon, "operator")("http://hive/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "tool-boundary",
          agentName: "maya",
          timestamp: "2026-07-09T12:01:00.000Z",
        }),
      });
      expect(response.status).toEqual(200);
      expect(tmux.calls).toHaveLength(1);
      expect(tmux.calls[0]?.[0]).toEqual("hive-maya");
      expect(tmux.calls[0]?.[1]).toContain("URGENT HIVE CONTROL");
      expect(tmux.calls[0]?.[1]).toContain("Pause before coding");
      expect(db.getMessage(urgent.id)?.state).toEqual("injected");
      expect(db.getMessage(normal.id)?.deliveredAt).toEqual(null);
      // A tool boundary is a delivery tick, not a lifecycle fact: status
      // stays working, lastEventAt advances, and no event row is persisted.
      expect(db.getAgentByName("maya")?.status).toEqual("working");
      expect(db.getAgentByName("maya")?.lastEventAt).toEqual(
        "2026-07-09T12:01:00.000Z",
      );
      expect(
        db.listEvents().filter((event) => event.agentName === "maya"),
      ).toEqual([]);
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
      const inbox = await delivery.inbox("maya");
      expect(inbox.length).toEqual(1);
      expect(inbox[0]?.id).toEqual(queued.id);
      expect(inbox[0]?.deliveredAt === null).toEqual(false);
      expect(await delivery.inbox("maya")).toEqual([]);
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
      const inbox = await delivery.inbox("maya");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        id: queued.id,
        body: "Sent while you were spawning.",
      });
      expect(inbox[0]?.deliveredAt).not.toEqual(null);
      expect(await delivery.inbox("maya")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("flushes a pre-registration message when the recipient session starts", async () => {
    const db = new HiveDatabase(join(home, "register-and-wake.db"));
    const tmux = new SubmittingTmuxSender(db);
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

  test("routes a reused name to its live holder, never the closed one", async () => {
    const db = new HiveDatabase(join(home, "reused-recipient.db"));
    const delivery = new MessageDelivery(db, new SubmittingTmuxSender(db));
    try {
      db.insertAgent({ ...agent("dead"), closedAt: timestamp });
      // maya's name was reissued to a new agent with its own session.
      db.insertAgent({
        ...agent("idle"),
        id: "agent-maya-2",
        tmuxSession: "hive-maya-2",
        createdAt: "2026-07-09T13:00:00.000Z",
      });

      const message = await delivery.send("sam", "maya", "Are you there?");
      expect(message.to).toEqual("maya");
      // The closed holder is not a recipient: it never sees the message, and
      // the send is not rejected on its behalf either.
      expect(db.getAgentByName("maya")?.id).toEqual("agent-maya-2");
      expect(db.listMessages()).toHaveLength(1);
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
      expect(tmux.calls).toEqual([]);

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
      expect(db.getMessage(queued.id)?.deliveredAt).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("orchestrator messages reach an idle agent immediately", async () => {
    const db = new HiveDatabase(join(home, "orchestrator-to-idle.db"));
    const tmux = new SubmittingTmuxSender(db);
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
    const tmux = new SubmittingTmuxSender(db);
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
    const tmux = new BlockingTmuxSender(db);
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
    const tmux = new SubmittingTmuxSender(db);
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
    const tmux = new FailingTmuxSender(db);
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

/**
 * The ninety orphans. "Injected" was a state nothing ever read again: Hive knew
 * the message was unconfirmed — that is what the null appliedAt means — and told
 * nobody, forever. It is now a promise that resolves one of two ways.
 */
describe("reconciling messages we handed over", () => {
  test("a paste is not proof of application", async () => {
    const db = new HiveDatabase(join(home, "recon-notapplied.db"));
    const delivery = new MessageDelivery(db, new SubmittingTmuxSender(db));
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "hello");
      // send-keys exited 0. That is all we know, and all we may claim: the
      // recipient's TUI holds the text until its next turn boundary.
      expect(message.state).toEqual("injected");
      expect(message.appliedAt).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("a turn boundary after injection is what proves it reached the model", async () => {
    const db = new HiveDatabase(join(home, "recon-applied.db"));
    const delivery = new MessageDelivery(db, new SubmittingTmuxSender(db));
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "hello");

      // The recipient finishes the turn the paste started. A real event, not a
      // bumped `lastEventAt`: an idle agent emits `notification` events while
      // doing nothing at all, and those used to count as proof the model ran.
      db.insertEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(await delivery.reconcileInjected()).toEqual(1);
      expect(db.getMessage(message.id)?.state).toEqual("applied");
      expect(db.getMessage(message.id)?.appliedAt).not.toEqual(null);
    } finally {
      db.close();
    }
  });

  test("an idle pane that swallows the paste leaves the message queued, not injected", async () => {
    const db = new HiveDatabase(join(home, "recon-stalled.db"));
    // The pane accepts the bytes and the agent never wakes: a modal, a
    // permission prompt, a composer that never pressed Enter. `tmux send-keys`
    // exits 0 all the same, because exit 0 only ever meant tmux took the
    // keystrokes.
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      undefined,
      undefined,
      { submitConfirmMs: 200 },
    );
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "hello");

      // This is the regression. Hive used to call this "injected" and hand the
      // orchestrator an `injectedAt`, and an orchestrator that believes a stop
      // order landed stops chasing it — which is exactly how an agent worked
      // straight through one and landed the commit it was sent to prevent.
      expect(message.state).toEqual("queued");
      expect(message.injectedAt).toEqual(null);
      expect(message.deliveredAt).toEqual(null);
      expect(db.getMessage(message.id)?.state).toEqual("queued");
      // Still undelivered, so the next boundary retries it rather than losing it.
      expect(db.getUndeliveredMessages("maya")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("a busy recipient holding a paste in its composer is injected, not applied", async () => {
    const db = new HiveDatabase(join(home, "recon-busy.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent(agent("working"));
      const urgent = await delivery.send("sam", "maya", "stop", {
        priority: "urgent",
      });
      // A busy TUI genuinely does hold the text until its next tool call, so
      // "injected" is the honest maximum here — and it is not "applied".
      const injected = (await delivery.flushUrgent("maya"))[0]!;
      expect(injected.state).toEqual("injected");
      expect(injected.appliedAt).toEqual(null);
      expect(await delivery.reconcileInjected()).toEqual(0);
      expect(db.getMessage(urgent.id)?.state).toEqual("injected");
    } finally {
      db.close();
    }
  });

  test("a message unconfirmed past the deadline is surfaced once, in one line", async () => {
    const db = new HiveDatabase(join(home, "recon-alert.db"));
    const delivery = new MessageDelivery(db, new SubmittingTmuxSender(db));
    try {
      db.insertAgent(agent("idle"));
      const message = await delivery.send("sam", "maya", "hello");

      // Backdate the injection past the confirmation deadline.
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      db.transitionMessage(message.id, "injected", old);
      (db as unknown as { database: { query: (s: string) => { run: (...a: unknown[]) => void } } })
        .database.query("UPDATE messages SET injectedAt = ? WHERE id = ?")
        .run(old, message.id);

      await delivery.reconcileInjected();

      const alerts = db.getUndeliveredMessages("orchestrator")
        .filter((m) => m.body.includes("never confirmed applied"));
      expect(alerts).toHaveLength(1);
      // One line naming the count — not ninety messages dumped into the
      // orchestrator's context.
      expect(alerts[0]?.body).toContain("1 message(s)");
      expect(alerts[0]?.body).toContain("maya");
      expect(alerts[0]?.body).toContain("Nothing was discarded");

      // Surfaced once, never a repeating alarm.
      await delivery.reconcileInjected();
      expect(
        db.getUndeliveredMessages("orchestrator")
          .filter((m) => m.body.includes("never confirmed applied")),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
