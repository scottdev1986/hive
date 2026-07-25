// Urgent must never be reported as delivered by a path that cannot cancel.
//
// send() refuses an urgent outright when no native cancel surface exists, with
// "no turn was cancelled and no message was queued". But a native connection can
// disappear AFTER that check, and the catch around deliverNative fell through to
// the paste path for an idle recipient — pasting the control as literal text and
// returning its "injected" state. The caller was told the turn had been
// cancelled when it had not been touched. Neither branch of that guard was
// tested, which is why it survived.
import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/db";
import {
  MessageDelivery,
  type NativeAgentControl,
  type SessionSender,
} from "../../src/daemon/delivery";
import { submitPaste } from "../../src/daemon/testing";
import type { AgentRecord } from "../../src/schemas";

const timestamp = "2026-07-25T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "idle",
    taskDescription: "Build the thing",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-work",
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "hive-urgent-test",
      subject: { kind: "agent", agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000401",
      hostKind: "sessiond",
      engineBuildId: "engine-urgent-test",
    },
    ...overrides,
  };
}

/** Records every paste so a fallthrough is visible, not merely inferred from a
 * returned state. */
class RecordingSender implements SessionSender {
  readonly pastes: Array<[string, string]> = [];
  constructor(private readonly db: HiveDatabase) {}
  async sendSessionMessage(target: AgentRecord, text: string): Promise<void> {
    this.pastes.push([target.name, text]);
    // Confirm the paste the way a real pane would, so the ordinary-traffic
    // control below completes instead of waiting on a submit that never lands.
    const sessionId = target.sessionLocator?.sessionId;
    if (sessionId !== undefined) submitPaste(this.db, sessionId);
  }
}

/** A native surface that passes the liveness check and then fails — the race
 * the catch exists to handle. */
const failingNative: NativeAgentControl = {
  hasAgent: () => true,
  deliver: async () => {
    throw new Error("native control vanished after liveness was checked");
  },
};

function harness(status: AgentRecord["status"]) {
  const db = new HiveDatabase(":memory:");
  const sender = new RecordingSender(db);
  const delivery = new MessageDelivery(db, sender, undefined, failingNative);
  db.insertAgent(agent({ status }));
  return { db, sender, delivery };
}

describe("urgent delivery when the native surface fails mid-send", () => {
  test("an IDLE recipient keeps the urgent queued instead of pasting it as text", async () => {
    const { sender, delivery } = harness("idle");
    const result = await delivery.send("queen", "maya", "STOP NOW", {
      priority: "urgent",
    });
    // Queued is honest: nothing was cancelled, and the caller can see that.
    expect(result.state).toBe("queued");
    expect(result.deliveredAt).toBeNull();
    // The load-bearing assertion: the control was not pasted anywhere.
    expect(sender.pastes).toEqual([]);
  });

  test("a WORKING recipient also keeps it queued", async () => {
    // This branch was already correct; it is asserted so a future edit cannot
    // quietly regress the half that worked.
    const { sender, delivery } = harness("working");
    const result = await delivery.send("queen", "maya", "STOP NOW", {
      priority: "urgent",
    });
    expect(result.state).toBe("queued");
    expect(sender.pastes).toEqual([]);
  });

  test("an ordinary message still falls back to the paste path when idle", async () => {
    // Positive control: the fallback is deliberately kept for traffic whose
    // contract is delivery rather than cancellation. Without this, the fix above
    // could pass by disabling the fallback for everything.
    const { sender, delivery } = harness("idle");
    const result = await delivery.send("queen", "maya", "just some guidance", {
      priority: "normal",
    });
    expect(sender.pastes.length).toBe(1);
    expect(result.state).not.toBe("queued");
  });
});
