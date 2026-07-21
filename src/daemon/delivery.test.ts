import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentMessageSchema,
  type AgentMessage,
  type AgentRecord,
} from "../schemas";
import { HiveDatabase } from "./db";
import {
  CoexistingSessionSender,
  MessageDelivery,
  queuedDeliveryNote,
  type NativeAgentControl,
  type SessionSender,
  type TmuxSender,
} from "./delivery";
import { HiveDaemon } from "./server";
import type { SessiondAgentInput } from "./session-host/sessiond-agent-input";
import type { InputReceipt } from "./session-host/terminal-host-contract";
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
    category: "simple_coding",
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
    readOnly: false,
    writeRevoked: false,
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
  readonly interrupts: boolean[] = [];

  async sendMessage(
    session: string,
    text: string,
    options: { interrupt?: boolean } = {},
  ): Promise<void> {
    this.calls.push([session, text]);
    this.interrupts.push(options.interrupt === true);
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
  test("a send to an idle sessiond agent queues honestly instead of bouncing (#67)", async () => {
    const db = new HiveDatabase(join(home, "sessiond-idle-send.db"));
    const tmuxCalls: AgentRecord[] = [];
    // The production sender (BunSessionSender) binds the recipient as a tmux
    // session, which throws "Agent <id> has a mismatched SessionLocator" for
    // any sessiond locator — the exact bounce hive_send returned for sarah
    // and alex on 2026-07-20. Delivery must never let a sessiond recipient
    // reach this sender at all.
    const tmux: SessionSender = {
      async sendSessionMessage(recipient) {
        tmuxCalls.push(recipient);
        if (recipient.sessionLocator?.hostKind === "sessiond") {
          throw new Error(`Agent ${recipient.id} has a mismatched SessionLocator`);
        }
      },
    };
    const delivery = new MessageDelivery(db, new CoexistingSessionSender(tmux));
    try {
      const recipient = {
        ...agent("idle"),
        sessionLocator: {
          schemaVersion: 1 as const,
          instanceId: "hive-fixture",
          subject: { kind: "agent" as const, agentId: "agent-maya" },
          generation: 1,
          sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
          hostKind: "sessiond" as const,
          engineBuildId: "engine-fixture",
        },
      };
      db.insertAgent(recipient);

      const message = await delivery.send("sam", "maya", "Please review this.");
      expect(message.state).toBe("queued");
      expect(message.deliveredAt).toBeNull();
      expect(tmuxCalls).toEqual([]);
      expect(db.getUndeliveredMessages("maya")).toHaveLength(1);

      // The wake sweep and the flush loops hit the same wall: they must not
      // throw, must not report the message delivered, and must leave it
      // durably queued for the boundary that can actually take it.
      expect(await delivery.flushQueued("maya")).toEqual([]);
      expect(await delivery.wakeIdleRecipients()).toEqual([]);
      expect(db.getUndeliveredMessages("maya")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  const sessiondRecipient = () => ({
    ...agent("idle"),
    sessionLocator: {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    },
  });

  function acceptingReceipt(messageId: string): InputReceipt {
    return {
      transactionId: messageId,
      stage: "written-to-terminal",
      byteRange: { start: "0", endExclusive: "16" },
      orderedAt: "16",
      availableCreditBytes: 4096,
      consumedByProcess: "not-claimed",
      completeness: "complete",
      diagnostic: null,
    };
  }

  test("injects an idle sessiond agent over the viewer wire and marks it injected (#68)", async () => {
    const db = new HiveDatabase(join(home, "sessiond-inject.db"));
    const injects: Array<{ name: string; text: string; messageId: string }> = [];
    const sessiondInput: SessiondAgentInput = {
      async injectIdle(recipient, text, options) {
        injects.push({ name: recipient.name, text, messageId: options.messageId });
        return { outcome: "injected", receipt: acceptingReceipt(options.messageId) };
      },
    };
    const stubSender: SessionSender = { async sendSessionMessage() {} };
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined, sessiondInput,
    );
    try {
      db.insertAgent(sessiondRecipient());
      const message = await delivery.send("queen", "maya", "Please review this.");
      // The documented stuck case (queen→agent, no human poll) now reaches the
      // idle agent: injected, not fabricated applied, not left queued.
      expect(message.state).toBe("injected");
      expect(message.deliveredAt).not.toBeNull();
      expect(injects).toHaveLength(1);
      expect(injects[0]?.name).toBe("maya");
      expect(injects[0]?.text).toContain("Please review this.");
      expect(injects[0]?.messageId).toBe(message.id);
      expect(db.getUndeliveredMessages("maya")).toHaveLength(0);
      // A delivered row carries no stale failure diagnostic.
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a held human-claim preemption remains visible on the delivered row", async () => {
    const db = new HiveDatabase(join(home, "sessiond-held-preemption.db"));
    const sessiondInput: SessiondAgentInput = {
      async injectIdle(_recipient, _text, options) {
        return {
          outcome: "injected",
          receipt: acceptingReceipt(options.messageId),
          recovery: "held human claim (owner workspace-pane) preempted for delivery; retrying",
        };
      },
    };
    const delivery = new MessageDelivery(
      db, { async sendSessionMessage() {} }, undefined, undefined, undefined, {}, undefined, undefined,
      sessiondInput,
    );
    try {
      db.insertAgent(sessiondRecipient());
      const message = await delivery.send("queen", "maya", "Fleet delivery must proceed.");
      expect(message.state).toBe("injected");
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toBe(
        "sessiond inject recovered: held human claim (owner workspace-pane) preempted for delivery; retrying",
      );
    } finally {
      db.close();
    }
  });

  test("a declined sessiond claim leaves the envelope queued, never applied (#68)", async () => {
    const db = new HiveDatabase(join(home, "sessiond-declined.db"));
    // The arbiter denies the automation claim (a human owns input): injectIdle
    // declines with the arbiter's reason, the message stays durably queued,
    // and the reason is READABLE ON THE ROW — the #68 live proof died
    // guessing this exact cause from a /dev/null stderr.
    const sessiondInput: SessiondAgentInput = {
      async injectIdle() {
        return {
          outcome: "declined",
          reason: "claim denied: human input claim held (held by human writer " +
            "workspace-pane, lease expires 2026-07-20T23:26:43.000Z)",
        };
      },
    };
    const stubSender: SessionSender = { async sendSessionMessage() {} };
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined, sessiondInput,
    );
    try {
      db.insertAgent(sessiondRecipient());
      const message = await delivery.send("queen", "maya", "Human is typing.");
      expect(message.state).toBe("queued");
      expect(message.deliveredAt).toBeNull();
      expect(db.getUndeliveredMessages("maya")).toHaveLength(1);
      const row = db.getMessage(message.id);
      expect(row?.deliveryDiagnostic).toBe(
        "sessiond inject declined: claim denied: human input claim held " +
          "(held by human writer workspace-pane, lease expires 2026-07-20T23:26:43.000Z)",
      );
      expect(row?.deliveryDiagnosticAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("a failed sessiond inject does not throw and leaves the envelope queued (#68)", async () => {
    const db = new HiveDatabase(join(home, "sessiond-inject-fail.db"));
    const sessiondInput: SessiondAgentInput = {
      async injectIdle() { throw new Error("host.sock refused connection"); },
    };
    const stubSender: SessionSender = { async sendSessionMessage() {} };
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined, sessiondInput,
    );
    try {
      db.insertAgent(sessiondRecipient());
      const message = await delivery.send("queen", "maya", "Best effort.");
      expect(message.state).toBe("queued");
      expect(db.getUndeliveredMessages("maya")).toHaveLength(1);
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toBe(
        "sessiond inject failed: host.sock refused connection",
      );
    } finally {
      db.close();
    }
  });

  test("a later successful inject clears the recorded failure diagnostic (#68)", async () => {
    const db = new HiveDatabase(join(home, "sessiond-diagnostic-clear.db"));
    let failing = true;
    const sessiondInput: SessiondAgentInput = {
      async injectIdle(_recipient, _text, options) {
        if (failing) throw new Error("host.sock refused connection");
        return { outcome: "injected", receipt: acceptingReceipt(options.messageId) };
      },
    };
    const stubSender: SessionSender = { async sendSessionMessage() {} };
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined, sessiondInput,
    );
    try {
      db.insertAgent(sessiondRecipient());
      const message = await delivery.send("queen", "maya", "Retry me.");
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toContain("inject failed");
      failing = false;
      await delivery.flushQueued("maya");
      const row = db.getMessage(message.id);
      expect(row?.state).toBe("injected");
      expect(row?.deliveryDiagnostic).toBeNull();
      expect(row?.deliveryDiagnosticAt).toBeNull();
    } finally {
      db.close();
    }
  });

  test("queuedDeliveryNote names the sessiond wire gap for idle recipients (#67)", () => {
    const sessiondRecipient = {
      ...agent("idle"),
      sessionLocator: {
        schemaVersion: 1 as const,
        instanceId: "hive-fixture",
        subject: { kind: "agent" as const, agentId: "agent-maya" },
        generation: 1,
        sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
        hostKind: "sessiond" as const,
        engineBuildId: "engine-fixture",
      },
    };
    const message = AgentMessageSchema.parse({
      id: crypto.randomUUID(),
      from: "queen",
      to: "maya",
      body: "hello",
      createdAt: timestamp,
      deliveredAt: null,
      priority: "normal",
      intent: "instruction",
      state: "queued",
      deadlineAt: null,
      sequence: 1,
      idempotencyKey: null,
      capabilityEpoch: null,
    });
    const note = queuedDeliveryNote(message, sessiondRecipient);
    expect(note).toContain("NOT received");
    expect(note).toContain("sessiond");
    // The old note claimed a paste was swallowed; no paste is ever attempted.
    expect(note).not.toContain("paste");
  });

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
      const steer = await delivery.send(
        "orchestrator",
        "maya",
        "Keep the current turn; check the fixture.",
        { priority: "steer" },
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
          text: "📨 message from queen: Focus on the failing test.",
          interrupt: false,
        },
        {
          agent: "maya",
          text: expect.stringContaining("STEER HIVE CONTROL"),
          interrupt: false,
        },
        {
          agent: "maya",
          text: expect.stringContaining("URGENT HIVE CONTROL"),
          interrupt: true,
        },
      ]);
      expect(normal.state).toEqual("injected");
      expect(steer.state).toEqual("injected");
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
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
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
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
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

  test("steer is received mid-turn without cancelling the in-flight work", async () => {
    const db = new HiveDatabase(join(home, "steer-mid-turn.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent({ ...agent("working"), tool: "claude" });
      const message = await delivery.send("orchestrator", "maya", "Keep the fixture minimal.", {
        priority: "steer",
      });
      expect(message.state).toBe("queued");

      const firstBoundary = new Date(Date.now() + 1_000).toISOString();
      await delivery.flushSteer("maya");
      expect(tmux.calls).toEqual([
        ["hive-maya", expect.stringContaining("STEER HIVE CONTROL")],
      ]);
      expect(tmux.interrupts).toEqual([false]);
      expect(db.getMessage(message.id)?.state).toBe("injected");

      const received = delivery.confirmSteerAtToolBoundary("maya", firstBoundary);
      expect(received).toBe(1);
      expect(db.getMessage(message.id)?.state).toBe("applied");
      // The receipt is mid-turn: no turn-end occurred, so the original work is
      // still alive after hearing the steer instead of being cancelled.
      expect(db.getAgentByName("maya")?.status).toBe("working");
      expect(db.latestTurnBoundaryAt("maya")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("grok steer honestly degrades to the next turn because grok has no tool boundary", async () => {
    const db = new HiveDatabase(join(home, "steer-grok-degrade.db"));
    const tmux = new RecordingTmuxSender();
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent({ ...agent("working"), name: "cesar", tool: "grok", tmuxSession: "hive-cesar" });
      const message = await delivery.send("orchestrator", "cesar", "Keep the fixture minimal.", {
        priority: "steer",
      });
      expect(message.state).toBe("queued");
      expect(await delivery.flushSteer("cesar")).toEqual([]);
      expect(tmux.calls).toEqual([]);
      expect(queuedDeliveryNote(message, db.getAgentByName("cesar"))).toContain(
        "degrades to normal",
      );
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
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
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
      // Preferred address is queen; synonym "orchestrator" still reaches the root
      // and is stored under the preferred name.
      const viaSynonym = await delivery.send("maya", "orchestrator", report);
      expect(viaSynonym.to).toEqual("queen");
      expect(viaSynonym.deliveredAt).toEqual(null);
      expect(tmux.calls).toEqual([]);

      const viaPreferred = await delivery.send("sam", "queen", "second report");
      expect(viaPreferred.to).toEqual("queen");

      const inbox = await delivery.orchestratorInbox();
      expect(inbox.length).toEqual(2);
      expect(inbox.map((m) => m.id).sort()).toEqual(
        [viaSynonym.id, viaPreferred.id].sort(),
      );
      expect(await delivery.orchestratorInbox()).toEqual([]);
      expect(db.getMessage(viaSynonym.id)?.deliveredAt).not.toEqual(null);
    } finally {
      db.close();
    }
  });

  test("drains a genuine pre-rename DB row keyed to orchestrator without send() normalization", async () => {
    const db = new HiveDatabase(join(home, "orchestrator-legacy-row.db"));
    const delivery = new MessageDelivery(db, new UnavailableTmuxSender());
    try {
      // Bypass send() so the stored recipient key stays the pre-rename synonym.
      const legacy = db.insertMessage(AgentMessageSchema.parse({
        id: "legacy-pre-rename",
        from: "maya",
        to: "orchestrator",
        body: "report written before queen was preferred",
        createdAt: timestamp,
        deliveredAt: null,
        priority: "normal",
        intent: "instruction",
        state: "queued",
        sequence: 0,
      }));
      expect(db.getMessage(legacy.id)?.to).toEqual("orchestrator");

      const inbox = await delivery.orchestratorInbox();
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.id).toEqual(legacy.id);
      expect(db.getMessage(legacy.id)?.deliveredAt).not.toEqual(null);
      expect(await delivery.orchestratorInbox()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("canonicalizes root-compatible senders to queen for storage and idempotency", async () => {
    const db = new HiveDatabase(join(home, "root-sender-canonical.db"));
    const delivery = new MessageDelivery(db, new SubmittingTmuxSender(db));
    try {
      db.insertAgent(agent("idle"));
      const first = await delivery.send(
        "Orchestrator",
        "maya",
        "Reuse the middleware.",
        { idempotencyKey: "root-instruction-1" },
      );
      expect(first.from).toEqual("queen");
      expect(db.getMessage(first.id)?.from).toEqual("queen");

      // Same idempotency under the synonym must hit the canonicalized row.
      const again = await delivery.send(
        "orchestrator",
        "maya",
        "Reuse the middleware.",
        { idempotencyKey: "root-instruction-1" },
      );
      expect(again.id).toEqual(first.id);
      expect(again.from).toEqual("queen");
    } finally {
      db.close();
    }
  });

  test("idempotency survives a genuine pre-rename from=orchestrator row after upgrade", async () => {
    const db = new HiveDatabase(join(home, "root-sender-legacy-idempotency.db"));
    const delivery = new MessageDelivery(db, new SubmittingTmuxSender(db));
    try {
      db.insertAgent(agent("idle"));
      // Bypass send(): pre-activation row still keyed under the synonym.
      const legacy = db.insertMessage(AgentMessageSchema.parse({
        id: "legacy-root-idempotent",
        from: "orchestrator",
        to: "maya",
        body: "instruction issued before queen rename",
        createdAt: timestamp,
        deliveredAt: null,
        priority: "normal",
        intent: "instruction",
        state: "queued",
        sequence: 0,
        idempotencyKey: "pre-rename-control-k",
      }));
      expect(legacy.from).toEqual("orchestrator");

      const retry = await delivery.send(
        "Orchestrator",
        "maya",
        "instruction issued before queen rename",
        { idempotencyKey: "pre-rename-control-k" },
      );
      expect(retry.id).toEqual(legacy.id);
      // One row only — no second queen-keyed insert.
      expect(
        db.listMessages().filter((m) => m.idempotencyKey === "pre-rename-control-k"),
      ).toHaveLength(1);
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
        ["hive-maya", "📨 message from queen: Start with the auth module."],
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
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
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
          "📨 message from queen: When done, also update the docs.",
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
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
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

      const alerts = db.getUndeliveredMessages("queen")
        .filter((m) => m.body.includes("stuck unconfirmed"));
      expect(alerts).toHaveLength(1);
      // One line naming the count — not ninety messages dumped into the
      // orchestrator's context.
      expect(alerts[0]?.body).toContain("1 message(s)");
      expect(alerts[0]?.body).toContain("maya");
      expect(alerts[0]?.body).toContain("Nothing was discarded");
      // The alert names what was measured, not merely that a timer expired.
      // This fixture's recipient has an ancient turn-start (the submit probe)
      // and no sign of life since: an open turn gone silent far past any
      // legitimate single tool call.
      expect(alerts[0]?.body).toContain("no sign of life");

      // Surfaced once, never a repeating alarm.
      await delivery.reconcileInjected();
      expect(
        db.getUndeliveredMessages("queen")
          .filter((m) => m.body.includes("stuck unconfirmed")),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  /** Raw-SQL injection backdating, matching the alert test above: the deadline
   * is measured from injectedAt, and only the database can move that. */
  function backdateInjection(db: HiveDatabase, id: string, iso: string): void {
    db.transitionMessage(id, "injected", iso);
    (db as unknown as {
      database: { query: (s: string) => { run: (...a: unknown[]) => void } };
    }).database.query("UPDATE messages SET injectedAt = ? WHERE id = ?")
      .run(iso, id);
  }

  const unconfirmedAlerts = (db: HiveDatabase): AgentMessage[] =>
    db.getUndeliveredMessages("queen")
      .filter((m) => m.body.includes("stuck unconfirmed"));

  test("a recipient mid-turn and alive is busy, not deaf: no alert, and its own boundary confirms it", async () => {
    const db = new HiveDatabase(join(home, "recon-busy-alive.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      const now = Date.now();
      // Every tool call refreshes lastEventAt (the tool-boundary tick), so a
      // fresh value is what a deep builder mid-suite actually looks like.
      db.insertAgent({
        ...agent("working"),
        lastEventAt: new Date(now).toISOString(),
      });
      // The turn opened before the message arrived and is still open.
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: new Date(now - 15 * 60_000).toISOString(),
      });
      const urgent = await delivery.send("sam", "maya", "new brief", {
        priority: "urgent",
      });
      await delivery.flushUrgent("maya");
      backdateInjection(db, urgent.id, new Date(now - 10 * 60_000).toISOString());

      // Ten minutes past injection, zero boundaries since — exactly the shape
      // that fired seven false alarms in one evening. Busy earns silence.
      expect(await delivery.reconcileInjected()).toEqual(0);
      expect(unconfirmedAlerts(db)).toHaveLength(0);
      // Not alerted means every later sweep re-judges it: deafness beginning
      // after this moment still gets its alarm.
      expect(db.getMessage(urgent.id)?.state).toEqual("injected");
      expect(db.getMessage(urgent.id)?.alertAt).toEqual(null);

      // The turn ends; the boundary is the proof, and the message confirms.
      db.insertEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: new Date(now + 1_000).toISOString(),
      });
      expect(await delivery.reconcileInjected()).toEqual(1);
      expect(db.getMessage(urgent.id)?.state).toEqual("applied");
    } finally {
      db.close();
    }
  });

  test("a recipient with no turn events at all still rings the alarm — that is the deafness signature", async () => {
    const db = new HiveDatabase(join(home, "recon-deaf.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      // The historical codex deafness: process up, hooks dead, zero events
      // ever. Nothing here may read as "busy".
      db.insertAgent(agent("working"));
      const urgent = await delivery.send("sam", "maya", "stop", {
        priority: "urgent",
      });
      await delivery.flushUrgent("maya");
      backdateInjection(
        db,
        urgent.id,
        new Date(Date.now() - 10 * 60_000).toISOString(),
      );

      await delivery.reconcileInjected();
      const alerts = unconfirmedAlerts(db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.body).toContain("no turn events at all");
    } finally {
      db.close();
    }
  });

  test("an idle recipient that never submitted the paste still rings", async () => {
    const db = new HiveDatabase(join(home, "recon-idle-swallowed.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      const now = Date.now();
      // Row status says "working" only so the urgent-flush path injects
      // without the idle submit probe; the classifier reads the events, and
      // the events say the last turn closed long ago.
      db.insertAgent(agent("working"));
      // A closed turn: started and finished before the message arrived. An
      // idle TUI should submit a paste immediately, so five quiet minutes
      // mean the paste was swallowed — this alert is the real thing.
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: new Date(now - 30 * 60_000).toISOString(),
      });
      db.insertEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: new Date(now - 25 * 60_000).toISOString(),
      });
      const urgent = await delivery.send("sam", "maya", "hello", {
        priority: "urgent",
      });
      await delivery.flushUrgent("maya");
      backdateInjection(db, urgent.id, new Date(now - 10 * 60_000).toISOString());

      await delivery.reconcileInjected();
      const alerts = unconfirmedAlerts(db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.body).toContain("idle yet never submitted");
    } finally {
      db.close();
    }
  });

  test("a dead recipient rings as dead, whatever its event history says", async () => {
    const db = new HiveDatabase(join(home, "recon-dead.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      const now = Date.now();
      const record = {
        ...agent("working"),
        lastEventAt: new Date(now).toISOString(),
      };
      db.insertAgent(record);
      // An open turn and a fresh lastEventAt — the busy shape — but the agent
      // died. Death outranks busyness: a crashed process holds its turn open
      // forever, and "busy" must never suppress that alarm.
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: new Date(now - 15 * 60_000).toISOString(),
      });
      const urgent = await delivery.send("sam", "maya", "brief", {
        priority: "urgent",
      });
      await delivery.flushUrgent("maya");
      backdateInjection(db, urgent.id, new Date(now - 10 * 60_000).toISOString());
      db.upsertAgent({ ...record, status: "dead" });

      await delivery.reconcileInjected();
      const alerts = unconfirmedAlerts(db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.body).toContain("maya is dead");
    } finally {
      db.close();
    }
  });

  /** The deadline clock for a queued message starts at creation. */
  function backdateCreation(db: HiveDatabase, id: string, iso: string): void {
    (db as unknown as {
      database: { query: (s: string) => { run: (...a: unknown[]) => void } };
    }).database.query("UPDATE messages SET createdAt = ? WHERE id = ?")
      .run(iso, id);
  }

  test("a suspended process rings at once on the OS's word, not after a silence timeout", async () => {
    const db = new HiveDatabase(join(home, "recon-stopped.db"));
    // The probe is the measurement: ps says the pane tree holds a T-state
    // process. No thirty-minute wait — the kernel already published the state.
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      undefined,
      {},
      async () => "stopped",
    );
    try {
      const now = Date.now();
      // The busy shape in every inferred surface: open turn, fresh
      // lastEventAt (its last tick landed just before the SIGSTOP). Only the
      // OS knows, and the OS is asked first.
      db.insertAgent({
        ...agent("working"),
        lastEventAt: new Date(now).toISOString(),
      });
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: new Date(now - 15 * 60_000).toISOString(),
      });
      const urgent = await delivery.send("sam", "maya", "brief", {
        priority: "urgent",
      });
      await delivery.flushUrgent("maya");
      backdateInjection(db, urgent.id, new Date(now - 6 * 60_000).toISOString());

      await delivery.reconcileInjected();
      const alerts = unconfirmedAlerts(db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.body).toContain("process is stopped");
    } finally {
      db.close();
    }
  });

  test("a probe that says running defers to the silence cap, and a failed probe never rings by itself", async () => {
    const db = new HiveDatabase(join(home, "recon-probe-running.db"));
    const probes: AgentRecord[] = [];
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      undefined,
      {},
      async (recipient) => {
        probes.push(recipient);
        throw new Error("ps unavailable");
      },
    );
    try {
      const now = Date.now();
      db.insertAgent({
        ...agent("working"),
        lastEventAt: new Date(now).toISOString(),
      });
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: new Date(now - 15 * 60_000).toISOString(),
      });
      const urgent = await delivery.send("sam", "maya", "brief", {
        priority: "urgent",
      });
      await delivery.flushUrgent("maya");
      backdateInjection(db, urgent.id, new Date(now - 6 * 60_000).toISOString());

      // The probe failed; the recipient shows recent life; silence is earned.
      await delivery.reconcileInjected();
      expect(probes.length).toBeGreaterThan(0);
      expect(probes[0]?.name).toBe("maya");
      expect(unconfirmedAlerts(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a message queued behind a busy recipient's turn is routine, not an alarm", async () => {
    const db = new HiveDatabase(join(home, "recon-queued-busy.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      const now = Date.now();
      db.insertAgent({
        ...agent("working"),
        lastEventAt: new Date(now).toISOString(),
      });
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: new Date(now - 15 * 60_000).toISOString(),
      });
      // Ordinary priority: it waits for the turn boundary by design.
      const message = await delivery.send("sam", "maya", "when you're done…");
      expect(message.state).toEqual("queued");
      backdateCreation(db, message.id, new Date(now - 10 * 60_000).toISOString());

      await delivery.reconcileInjected();
      expect(unconfirmedAlerts(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a message queued at a lifeless recipient rings — deafness blocks delivery before injection", async () => {
    const db = new HiveDatabase(join(home, "recon-queued-deaf.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      // The historical codex deafness exactly: agents whose hooks never fired
      // once. Their messages never left "queued", and the old watchdog — which
      // read only the injected state — was blind to all of it for two hours.
      db.insertAgent(agent("working"));
      const message = await delivery.send("sam", "maya", "hello?");
      expect(message.state).toEqual("queued");
      backdateCreation(
        db,
        message.id,
        new Date(Date.now() - 10 * 60_000).toISOString(),
      );

      await delivery.reconcileInjected();
      const alerts = unconfirmedAlerts(db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.body).toContain("no turn events at all");
      expect(alerts[0]?.body).toContain("never delivered");
    } finally {
      db.close();
    }
  });

  test("the root's queue is its inbox, never a deafness alarm", async () => {
    const db = new HiveDatabase(join(home, "recon-queued-root.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      const message = await delivery.send("sam", "orchestrator", "report");
      backdateCreation(
        db,
        message.id,
        new Date(Date.now() - 60 * 60_000).toISOString(),
      );
      await delivery.reconcileInjected();
      expect(unconfirmedAlerts(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a busy orchestrator is not stalled either — its turns live in the events table", async () => {
    const db = new HiveDatabase(join(home, "recon-root-busy.db"));
    const delivery = new MessageDelivery(db, new RecordingTmuxSender());
    try {
      const now = Date.now();
      // The root has no agents row; its open turn and signs of life are the
      // events its own hooks post. This alert fired for the orchestrator
      // itself tonight, mid-turn and healthy.
      db.insertEvent({
        kind: "turn-start",
        agentName: "orchestrator",
        timestamp: new Date(now - 15 * 60_000).toISOString(),
      });
      db.insertEvent({
        kind: "notification",
        agentName: "orchestrator",
        timestamp: new Date(now - 60_000).toISOString(),
      });
      const message = await delivery.send("sam", "orchestrator", "report");
      backdateInjection(
        db,
        message.id,
        new Date(now - 10 * 60_000).toISOString(),
      );

      expect(await delivery.reconcileInjected()).toEqual(0);
      expect(unconfirmedAlerts(db)).toHaveLength(0);

      // Its turn ends: the boundary confirms the message, silence stays earned.
      db.insertEvent({
        kind: "turn-end",
        agentName: "orchestrator",
        timestamp: new Date(now + 1_000).toISOString(),
      });
      expect(await delivery.reconcileInjected()).toEqual(1);
    } finally {
      db.close();
    }
  });

  test("the sweep does not alert a message that is mid-delivery under the session lock", async () => {
    const db = new HiveDatabase(join(home, "recon-queued-inflight.db"));
    const tmux = new BlockingTmuxSender(db);
    const delivery = new MessageDelivery(db, tmux);
    try {
      // The aurora incident, 2026-07-12 17:04Z: her turn ended, the flush was
      // pasting the queued message under the session lock, and the 30s sweep
      // fired in that one-second window — alerting a "swallowed paste" 350ms
      // before the delivery it raced completed and was confirmed.
      db.insertAgent({ ...agent("working") });
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: "2026-07-09T12:25:00.000Z",
      });
      const message = await delivery.send("sam", "maya", "three requirements");
      expect(message.state).toEqual("queued");
      backdateCreation(
        db,
        message.id,
        new Date(Date.now() - 10 * 60_000).toISOString(),
      );

      // The turn ends and the recipient goes idle; the flush begins pasting.
      db.insertEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: "2026-07-09T12:29:00.000Z",
      });
      db.upsertAgent(agent("idle"));
      const flush = delivery.flushQueued("maya");
      while (tmux.calls.length === 0) {
        await Bun.sleep(1);
      }

      // The sweep runs while the paste is in flight. It must wait behind the
      // delivery lane and judge the settled state, not the racing one.
      const sweep = delivery.reconcileInjected();
      await Bun.sleep(10);
      tmux.releaseNext();
      await flush;
      await sweep;

      expect(unconfirmedAlerts(db)).toHaveLength(0);
      expect(db.getMessage(message.id)?.state).toEqual("injected");
    } finally {
      db.close();
    }
  });

  test("a message still queued after its recipient went idle rings as never-delivered, not as a swallowed paste", async () => {
    const db = new HiveDatabase(join(home, "recon-queued-idle-stall.db"));
    // A broken TUI: the paste lands, nothing submits, and the send's own
    // submit probe (shortened to zero here) honestly leaves the row queued.
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      undefined,
      { submitConfirmMs: 0 },
    );
    try {
      db.insertAgent(agent("idle"));
      db.insertEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: "2026-07-09T12:25:00.000Z",
      });
      db.insertEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: "2026-07-09T12:26:00.000Z",
      });
      const message = await delivery.send("sam", "maya", "hello?");
      expect(message.state).toEqual("queued");
      backdateCreation(
        db,
        message.id,
        new Date(Date.now() - 10 * 60_000).toISOString(),
      );

      await delivery.reconcileInjected();
      const alerts = unconfirmedAlerts(db);
      expect(alerts).toHaveLength(1);
      // A queued message was never pasted-and-submitted, so the alert must
      // not diagnose a swallowed paste — that wording sent the orchestrator
      // hunting a tmux loss that never happened.
      expect(alerts[0]?.body).toContain("went idle without receiving it");
      expect(alerts[0]?.body).toContain("never delivered");
      expect(alerts[0]?.body).not.toContain("swallowed");
    } finally {
      db.close();
    }
  });
});

describe("queuedDeliveryNote", () => {
  const queuedMessage = (priority: "normal" | "steer" | "urgent" = "normal") =>
    AgentMessageSchema.parse({
      id: "m-1",
      from: "orchestrator",
      to: "maya",
      body: "three safety requirements",
      createdAt: timestamp,
      deliveredAt: null,
      priority,
    });

  test("a mid-turn recipient earns the full warning: not received, boundary-delivered, urgent escapes", () => {
    const note = queuedDeliveryNote(queuedMessage(), agent("working"));
    expect(note).toContain("NOT received");
    expect(note).toContain("mid-turn");
    expect(note).toContain("priority=steer");
  });

  test("an urgent message mid-turn names the tool-boundary injection instead", () => {
    const note = queuedDeliveryNote(queuedMessage("urgent"), agent("working"));
    expect(note).toContain("next tool call");
    expect(note).not.toContain("resend");
  });

  test("an idle recipient with a queued message means the paste never submitted", () => {
    const note = queuedDeliveryNote(queuedMessage(), agent("idle"));
    expect(note).toContain("never submitted");
  });

  test("a dead recipient is named as one the message will never reach", () => {
    const note = queuedDeliveryNote(queuedMessage(), agent("dead"));
    expect(note).toContain("never be delivered");
  });

  test("a delivered message carries no note, and neither does the root's inbox queue", () => {
    const injected = {
      ...queuedMessage(),
      state: "injected" as const,
    };
    expect(queuedDeliveryNote(injected, agent("working"))).toBeUndefined();
    expect(queuedDeliveryNote(queuedMessage(), null)).toBeUndefined();
  });
});

/**
 * The agent an orchestrator most needs to redirect is the one with free
 * capacity — and that was the one agent Hive could not reach.
 *
 * Every redelivery trigger hung off the recipient's own activity: flushQueued
 * on its turn-end hook, flushUrgent at a tool boundary. An agent that has
 * finished its work does neither, ever again, so mail queued while it was busy
 * was retried by nothing once it went quiet. Grok made it absolute: it drives
 * no hook channel at all, so it fires none of those triggers whatever it is
 * doing. Live, idle, addressable, deaf (cesar, 2026-07-12: two controls queued,
 * a five-minute "unable to hear" alert, and a kill to stop him).
 *
 * These tests drive the daemon's real maintenance tick, not the wake function
 * directly: a test that calls the sweep itself passes just as happily when
 * nothing in the daemon ever calls it, which is the shape of the bug.
 */
describe("a live idle agent hears", () => {
  function grok(status: AgentRecord["status"]): AgentRecord {
    return {
      ...agent(status),
      id: "agent-cesar",
      name: "cesar",
      tool: "grok",
      model: "grok-4.5",
      tmuxSession: "hive-cesar",
      branch: "hive/cesar-work",
      // Null keeps the telemetry sweep off the filesystem; what this test is
      // about is what the daemon does once the row already says "idle".
      worktreePath: null,
    };
  }

  class FakeTmux {
    readonly sessions = new Set<string>();
    async hasSession(session: string): Promise<boolean> {
      return this.sessions.has(session);
    }
    async capturePane(): Promise<string> {
      return "";
    }
    async killSession(session: string): Promise<void> {
      this.sessions.delete(session);
    }
    async newSession(name: string): Promise<void> {
      this.sessions.add(name);
    }
  }

  test("a grok agent that went idle is woken, and its own work is what proves receipt", async () => {
    const db = new HiveDatabase(join(home, "wake-grok.db"));
    // A grok pane: it takes the paste and posts no hook event, because grok has
    // no hooks to post with. A fake that emitted a turn-start here would be
    // testing a vendor that does not exist.
    const tmux = new RecordingTmuxSender();
    const sessions = new FakeTmux();
    sessions.sessions.add("hive-cesar");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: unusedSpawner,
      tmux: sessions,
      tmuxSender: tmux,
      listUnmergedHiveBranches: async () => [],
    });
    try {
      db.insertAgent(grok("working"));
      const stop = await daemon.delivery.send(
        "orchestrator",
        "cesar",
        "Stop what you are doing and report.",
      );
      // Mid-turn, no channel: queued, exactly as it was in the field.
      expect(stop.state).toEqual("queued");
      expect(tmux.calls).toEqual([]);

      // He finishes. Grok emits no turn-end — the telemetry sweep reading his
      // session transcript is the only thing that ever settles the row, and it
      // settles it to idle. This is the state the orchestrator saw: ALIVE, IDLE
      // and, until now, unreachable.
      db.upsertAgent({ ...db.getAgentByName("cesar")!, status: "idle" });

      await daemon.runMaintenance();

      expect(tmux.calls).toEqual([
        [
          "hive-cesar",
          "📨 message from queen: Stop what you are doing and report.",
        ],
      ]);

      // Handed over is not heard. Receipt is his own work: grok's transcript
      // shows new activity after the injection, which the telemetry sweep
      // carries into lastEventAt — and that, not an exit code, is what turns
      // the message applied.
      const injected = db.getMessage(stop.id)!;
      expect(injected.state).toEqual("injected");
      db.upsertAgent({
        ...db.getAgentByName("cesar")!,
        lastEventAt: new Date(Date.parse(injected.injectedAt!) + 5_000)
          .toISOString(),
      });

      await daemon.runMaintenance();

      expect(db.getMessage(stop.id)?.state).toEqual("applied");
    } finally {
      db.close();
    }
  });

  test("a grok agent that never stirs after the paste is not called applied", async () => {
    // The other half of the same measurement: without activity of his own,
    // nothing promotes the message. "Injected" stays "injected".
    const db = new HiveDatabase(join(home, "wake-grok-silent.db"));
    const tmux = new RecordingTmuxSender();
    const sessions = new FakeTmux();
    sessions.sessions.add("hive-cesar");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: unusedSpawner,
      tmux: sessions,
      tmuxSender: tmux,
    });
    try {
      db.insertAgent(grok("idle"));
      const sent = await daemon.delivery.send("orchestrator", "cesar", "Rebase.");
      await daemon.runMaintenance();
      expect(db.getMessage(sent.id)?.state).toEqual("injected");
    } finally {
      db.close();
    }
  });

  test("an idle Codex agent is woken through its app-server session", async () => {
    const db = new HiveDatabase(join(home, "wake-codex.db"));
    const tmux = new RecordingTmuxSender();
    const native = new RecordingNativeControl();
    const delivery = new MessageDelivery(db, tmux, undefined, native);
    try {
      // Queued while busy: a native session takes it immediately, so the case
      // that strands a message is the one where the app-server was not attached
      // when the send happened.
      db.insertAgent(agent("working"));
      const message = db.insertMessage(AgentMessageSchema.parse({
        id: crypto.randomUUID(),
        from: "orchestrator",
        to: "maya",
        body: "Land what you have.",
        createdAt: timestamp,
        deliveredAt: null,
        sequence: 0,
      }));
      db.upsertAgent({ ...db.getAgentByName("maya")!, status: "idle" });

      await delivery.wakeIdleRecipients();

      // insertMessage fixtures keep stored from as-is; display uses the row.
      expect(native.calls).toEqual([
        {
          agent: "maya",
          text: "📨 message from orchestrator: Land what you have.",
          interrupt: false,
        },
      ]);
      expect(db.getMessage(message.id)?.state).toEqual("injected");
    } finally {
      db.close();
    }
  });

  test("an idle Claude agent is woken through its terminal", async () => {
    const db = new HiveDatabase(join(home, "wake-claude.db"));
    const tmux = new SubmittingTmuxSender(db);
    const delivery = new MessageDelivery(db, tmux);
    try {
      db.insertAgent({ ...agent("working"), tool: "claude" });
      const message = db.insertMessage(AgentMessageSchema.parse({
        id: crypto.randomUUID(),
        from: "orchestrator",
        to: "maya",
        body: "Land what you have.",
        createdAt: timestamp,
        deliveredAt: null,
        sequence: 0,
      }));
      db.upsertAgent({ ...db.getAgentByName("maya")!, status: "idle" });

      await delivery.wakeIdleRecipients();

      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from orchestrator: Land what you have."],
      ]);
      expect(db.getMessage(message.id)?.state).toEqual("injected");
    } finally {
      db.close();
    }
  });

  test("never pastes over a human draft and retries after the draft is submitted", async () => {
    const db = new HiveDatabase(join(home, "composer-tmux.db"));
    const tmux = new SubmittingTmuxSender(db);
    let composing = true;
    const delivery = new MessageDelivery(
      db,
      tmux,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      () => composing,
    );
    try {
      db.insertAgent({ ...agent("idle"), tool: "claude" });
      const queued = await delivery.send("orchestrator", "maya", "Incoming.");
      expect(queued.state).toBe("queued");
      expect(tmux.calls).toEqual([]);

      expect(await delivery.flushQueued("maya")).toEqual([]);
      expect(tmux.calls).toEqual([]);

      composing = false;
      const delivered = await delivery.flushQueued("maya");
      expect(delivered).toHaveLength(1);
      expect(tmux.calls).toEqual([
        ["hive-maya", "📨 message from queen: Incoming."],
      ]);
    } finally {
      db.close();
    }
  });

  test("protects drafts from native, urgent, steer, and critical delivery", async () => {
    const db = new HiveDatabase(join(home, "composer-priorities.db"));
    const tmux = new RecordingTmuxSender();
    const native = new RecordingNativeControl();
    const critical: string[] = [];
    let composing = true;
    const delivery = new MessageDelivery(
      db,
      tmux,
      {
        async interruptAndRestart(recipient) {
          critical.push(recipient.name);
        },
      },
      native,
      undefined,
      {},
      undefined,
      () => composing,
    );
    try {
      db.insertAgent(agent("working"));
      const normal = await delivery.send("orchestrator", "maya", "Normal.");
      const urgent = await delivery.send("orchestrator", "maya", "Urgent.", {
        priority: "urgent",
      });
      const steer = await delivery.send("orchestrator", "maya", "Steer.", {
        priority: "steer",
      });
      const stop = await delivery.send("orchestrator", "maya", "Stop.", {
        intent: "stop",
      });

      expect([normal, urgent, steer, stop].every((message) =>
        message.state === "queued"
      )).toBe(true);
      expect(native.calls).toEqual([]);
      expect(tmux.calls).toEqual([]);
      expect(critical).toEqual([]);
      expect(await delivery.flushUrgent("maya")).toEqual([]);
      expect(await delivery.flushSteer("maya")).toEqual([]);

      composing = false;
      await delivery.flushUrgent("maya");
      await delivery.flushSteer("maya");
      await delivery.flushQueued("maya");
      expect(native.calls.length).toBeGreaterThanOrEqual(3);
      expect(critical).toEqual(["maya"]);
    } finally {
      db.close();
    }
  });

  test("never injects a root report while the user is composing", async () => {
    const db = new HiveDatabase(join(home, "composer-root.db"));
    const calls: string[] = [];
    let composing = true;
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      {
        isLive: () => true,
        async deliverMessage(content) {
          calls.push(content);
          return true;
        },
      },
      {},
      undefined,
      () => composing,
    );
    try {
      const message = await delivery.send("maya", "orchestrator", "Done.");
      expect(message.state).toBe("queued");
      expect(calls).toEqual([]);

      composing = false;
      expect(await delivery.wakeOrchestrator()).toHaveLength(1);
      expect(calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("#68 acceptance failures (2026-07-21): swallowed Enter and silent root wake", () => {
  test("a swallowed Enter is retried once and the retry's submit counts", async () => {
    const db = new HiveDatabase(join(home, "enter-retry.db"));
    const sender = new class extends RecordingTmuxSender {
      override async sendMessage(
        session: string,
        text: string,
        options: { interrupt?: boolean } = {},
      ): Promise<void> {
        await super.sendMessage(session, text, options);
        // The bare Enter retry submits the composer the first Enter left full.
        if (text === "") nextTurnStart(db, "maya");
      }
    }();
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      undefined,
      { sleep: async () => {}, submitConfirmMs: 1 },
    );
    try {
      db.insertAgent({ ...agent("idle"), tool: "claude", model: "claude-opus-4-8" });
      const message = await delivery.send("queen", "maya", "Reply 'ack 68'.");
      expect(message.state).toBe("injected");
      // One paste, then one bare-Enter retry, in order.
      expect(sender.calls.map(([, text]) => text === "" ? "ENTER" : "PASTE"))
        .toEqual(["PASTE", "ENTER"]);
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a paste that never submits queues with its cause on the row, and the next attempt clears the composer", async () => {
    const db = new HiveDatabase(join(home, "enter-retry-fail.db"));
    let submitOnPaste = false;
    const sender = new class extends RecordingTmuxSender {
      override async sendMessage(
        session: string,
        text: string,
        options: { interrupt?: boolean } = {},
      ): Promise<void> {
        await super.sendMessage(session, text, options);
        if (submitOnPaste && text !== "") nextTurnStart(db, "maya");
      }
    }();
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      undefined,
      { sleep: async () => {}, submitConfirmMs: 1 },
    );
    try {
      db.insertAgent({ ...agent("idle"), tool: "claude", model: "claude-opus-4-8" });
      const message = await delivery.send("queen", "maya", "Reply 'ack 68'.");
      expect(message.state).toBe("queued");
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toStartWith(
        "tmux paste not submitted",
      );
      // Paste (no clear: first attempt), then the bare-Enter retry.
      expect(sender.interrupts).toEqual([false, false]);

      // The wake sweep's next attempt clears the stale composer text before
      // re-pasting — a second paste on top of the first would submit a
      // garbled double copy.
      submitOnPaste = true;
      await delivery.flushQueued("maya");
      const row = db.getMessage(message.id);
      expect(row?.state).toBe("injected");
      expect(row?.deliveryDiagnostic).toBeNull();
      expect(sender.interrupts[2]).toBe(true);
    } finally {
      db.close();
    }
  });

  test("one poisoned root message cannot starve the queue, and every failure lands on its row", async () => {
    const db = new HiveDatabase(join(home, "root-wake-isolation.db"));
    const delivered: string[] = [];
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      {
        isLive: () => true,
        async deliverMessage(content: string) {
          if (content.includes("poison")) throw new Error("boom at the head");
          delivered.push(content);
          return true;
        },
      },
      {},
    );
    try {
      const poisoned = await delivery.send("maya", "queen", "poison envelope");
      // The first wake already ran inside send(): poisoned failed, recorded.
      const second = await delivery.send("maya", "queen", "healthy report");
      // 2026-07-21: 0 of 4 queued root messages delivered because the wake
      // loop had no per-message isolation — the head failure starved the
      // rest, silently. The healthy message must deliver.
      expect(db.getMessage(second.id)?.state).toBe("injected");
      expect(delivered).toHaveLength(1);
      const poisonRow = db.getMessage(poisoned.id);
      expect(poisonRow?.state).toBe("queued");
      expect(poisonRow?.deliveryDiagnostic).toBe(
        "root wake failed: boom at the head",
      );
    } finally {
      db.close();
    }
  });

  test("an unconfirmed root delivery records its cause on the row", async () => {
    const db = new HiveDatabase(join(home, "root-wake-unconfirmed.db"));
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      { isLive: () => true, async deliverMessage() { return false; } },
      {},
    );
    try {
      const message = await delivery.send("maya", "queen", "Done.");
      expect(message.state).toBe("queued");
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toBe(
        "root wake failed: the root protocol did not confirm delivery",
      );
    } finally {
      db.close();
    }
  });

  test("hive_send's queued note for the root names the wake and the diagnostic surface", () => {
    const message = AgentMessageSchema.parse({
      id: crypto.randomUUID(),
      from: "james",
      to: "queen",
      body: "ack",
      createdAt: timestamp,
      deliveredAt: null,
      state: "queued",
      sequence: 1,
    });
    const note = queuedDeliveryNote(message, null);
    expect(note).toContain("queen was not woken");
    expect(note).toContain("deliveryDiagnostic");
    expect(note).toContain("Do not re-send");
  });
});

describe("maintenance tick retries failed root wakes (#68)", () => {
  test("a root message stuck by a transient wake failure delivers on the next sweep", async () => {
    const db = new HiveDatabase(join(home, "root-wake-tick-retry.db"));
    let transportUp = false;
    const delivered: string[] = [];
    const delivery = new MessageDelivery(
      db,
      new RecordingTmuxSender(),
      undefined,
      undefined,
      {
        isLive: () => true,
        async deliverMessage(content: string) {
          if (!transportUp) throw new Error("error connecting to tmux socket");
          delivered.push(content);
          return true;
        },
      },
      {},
    );
    try {
      const message = await delivery.send("zoe", "queen", "Task done.");
      expect(message.state).toBe("queued");
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toContain(
        "error connecting to tmux socket",
      );

      // Nothing else sends and queen reaches no boundary; the maintenance
      // sweep alone must recover once the transport is back.
      transportUp = true;
      const woken = await delivery.wakeIdleRecipients();
      expect(woken.map((row) => row.id)).toEqual([message.id]);
      expect(db.getMessage(message.id)?.state).toBe("injected");
      expect(delivered).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("loud failure on stuck deliveries (2026-07-21 messaging regression)", () => {
  const stuckAgent = (): AgentRecord => ({
    ...agent("idle"),
    sessionLocator: {
      schemaVersion: 1 as const,
      instanceId: "hive-fixture",
      subject: { kind: "agent" as const, agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000901",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-fixture",
    },
  });

  /** An injector that always declines the way an orphaned human claim does. */
  const orphanDeclining: SessiondAgentInput = {
    async injectIdle() {
      return { outcome: "declined", reason: "claim denied: HumanOrphaned" };
    },
  };

  const stubSender: SessionSender = { async sendSessionMessage() {} };

  function receipt(messageId: string): InputReceipt {
    return {
      transactionId: messageId,
      stage: "written-to-terminal",
      byteRange: { start: "0", endExclusive: "16" },
      orderedAt: "16",
      availableCreditBytes: 4096,
      consumedByProcess: "not-claimed",
      completeness: "complete",
      diagnostic: null,
    };
  }

  function alerts(db: HiveDatabase): AgentMessage[] {
    return db.listMessages().filter((message) =>
      message.from === "hive-control" && message.body.startsWith("Delivery blocked:")
    );
  }

  test("a message queued past the threshold behind a diagnostic alerts queen exactly once", async () => {
    const db = new HiveDatabase(join(home, "stuck-delivery-alert.db"));
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined,
      orphanDeclining,
    );
    try {
      db.insertAgent(stuckAgent());
      const message = await delivery.send("queen", "maya", "Are you there?");
      expect(message.state).toBe("queued");
      expect(db.getMessage(message.id)?.deliveryDiagnostic).toBe(
        "sessiond inject declined: claim denied: HumanOrphaned",
      );

      // POSITIVE CONTROL for the clock, not the wiring: the same row, read
      // one minute after it was queued, is NOT yet stuck. Without this a
      // reader that alerted on every queued row would look identical below.
      const tooEarly = new Date(Date.parse(message.createdAt) + 60_000)
        .toISOString();
      expect(await delivery.alertStuckDeliveries(tooEarly)).toBe(0);
      expect(alerts(db)).toHaveLength(0);

      const later = new Date(Date.parse(message.createdAt) + 37 * 60_000)
        .toISOString();
      expect(await delivery.alertStuckDeliveries(later)).toBe(1);
      const fired = alerts(db);
      expect(fired).toHaveLength(1);
      expect(fired[0]?.to).toBe("queen");
      expect(fired[0]?.body).toContain(message.id);
      expect(fired[0]?.body).toContain("maya");
      expect(fired[0]?.body).toContain("queued 37m");
      expect(fired[0]?.body).toContain("HumanOrphaned");

      // One alert per message, not one per tick.
      const evenLater = new Date(Date.parse(message.createdAt) + 60 * 60_000)
        .toISOString();
      expect(await delivery.alertStuckDeliveries(evenLater)).toBe(0);
      expect(alerts(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("a delivered message never alerts, however old", async () => {
    const db = new HiveDatabase(join(home, "stuck-delivery-negative.db"));
    const delivering: SessiondAgentInput = {
      async injectIdle(_recipient, _text, options) {
        return { outcome: "injected", receipt: receipt(options.messageId) };
      },
    };
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined,
      delivering,
    );
    try {
      db.insertAgent(stuckAgent());
      const message = await delivery.send("queen", "maya", "Landed fine.");
      expect(message.state).toBe("injected");
      const later = new Date(Date.parse(message.createdAt) + 60 * 60_000)
        .toISOString();
      expect(await delivery.alertStuckDeliveries(later)).toBe(0);
      expect(alerts(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a dead recipient's stranded mail is not reported as a live deafness", async () => {
    const db = new HiveDatabase(join(home, "stuck-delivery-dead.db"));
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined,
      orphanDeclining,
    );
    try {
      db.insertAgent(stuckAgent());
      const message = await delivery.send("queen", "maya", "Still there?");
      db.markAgentDead("agent-maya", new Date().toISOString());
      const later = new Date(Date.parse(message.createdAt) + 37 * 60_000)
        .toISOString();
      expect(await delivery.alertStuckDeliveries(later)).toBe(0);
      expect(alerts(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("hive_status surfaces the blocked recipient and its diagnostic", async () => {
    const db = new HiveDatabase(join(home, "stuck-delivery-status.db"));
    const delivery = new MessageDelivery(
      db, stubSender, undefined, undefined, undefined, {}, undefined, undefined,
      orphanDeclining,
    );
    try {
      db.insertAgent(stuckAgent());
      const message = await delivery.send("queen", "maya", "Report please.");
      // POSITIVE CONTROL: before the threshold the same reader reports nothing,
      // so a non-empty map below is the age test firing, not a constant.
      const tooEarly = new Date(Date.parse(message.createdAt) + 60_000)
        .toISOString();
      expect(delivery.blockedDeliveries(tooEarly).size).toBe(0);

      const later = new Date(Date.parse(message.createdAt) + 12 * 60_000)
        .toISOString();
      const blocked = delivery.blockedDeliveries(later);
      expect(blocked.get("maya")).toEqual({
        messageId: message.id,
        queuedMinutes: 12,
        diagnostic: "sessiond inject declined: claim denied: HumanOrphaned",
      });
    } finally {
      db.close();
    }
  });
});
