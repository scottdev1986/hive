import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/db";
import { MessageDelivery } from "../../src/daemon/delivery";
import type { AgentRecord } from "../../src/schemas";
import { AgentMessageSchema } from "../../src/schemas/message";

/**
 * `state` must be evidence, not optimism.
 *
 * The push path has said so since the busy-pane measurement (see `markInjected`):
 * handing bytes over proves injection, and only a turn boundary proves the
 * recipient acted. The PULL paths did not follow. `inbox` wrote "applied" for a
 * normal message the moment it was FETCHED, and `orchestratorInbox` wrote it for
 * every message — both with `injectedAt` still null, a combination the lifecycle
 * cannot otherwise produce. Because `listInjectedUnapplied` requires a non-null
 * `injectedAt`, those rows were invisible to reconciliation AND to the stalled
 * sweep: the strongest claim in the system, recorded on no evidence, in a shape
 * that guaranteed nobody would ever re-examine it.
 */

const AT = "2026-07-09T12:00:00.000Z";

function agent(): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "idle",
    taskDescription: "delivery truthfulness",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya",
    contextPct: 10,
    createdAt: AT,
    lastEventAt: AT,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  } as AgentRecord;
}

const refusingSender = {
  async sendSessionMessage(): Promise<void> {
    throw new Error("the push path must not run in a pull-path test");
  },
};

function harness() {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent());
  return { db, delivery: new MessageDelivery(db, refusingSender as never) };
}

function queue(db: HiveDatabase, id: string, to: string, priority: string) {
  db.insertMessage(
    AgentMessageSchema.parse({
      id,
      from: "queen",
      to,
      body: "do the thing",
      priority,
      createdAt: AT,
      deliveredAt: null,
    }),
  );
}

describe("delivery state is evidence, not optimism", () => {
  test.each([
    ["normal", "msg-normal"],
    ["urgent", "msg-urgent"],
  ])(
    "an agent pulling a %s message records injection, never application",
    async (priority, id) => {
      const { db, delivery } = harness();
      try {
        queue(db, id, "maya", priority);
        await delivery.inbox("maya");

        const row = db.getMessage(id);
        // Fetching is not acting. No turn boundary exists yet.
        expect(row?.state).toBe("injected");
        expect(row?.appliedAt).toBeNull();
        // And injection must be *recorded*, or the row is unreachable by both
        // reconcileInjected and the stalled-delivery sweep.
        expect(row?.injectedAt).not.toBeNull();
      } finally {
        db.close();
      }
    },
  );

  test("the root's drain follows the same rule", async () => {
    const { db, delivery } = harness();
    try {
      queue(db, "msg-root", "queen", "normal");
      await delivery.orchestratorInbox();

      const row = db.getMessage("msg-root");
      expect(row?.state).toBe("injected");
      expect(row?.injectedAt).not.toBeNull();
      expect(row?.appliedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a real turn boundary still promotes injected to applied", async () => {
    const { db, delivery } = harness();
    try {
      queue(db, "msg-agent", "maya", "normal");
      queue(db, "msg-root", "queen", "normal");
      await delivery.inbox("maya");
      await delivery.orchestratorInbox();

      // Honesty is worthless if a message can never be confirmed. The boundary
      // is where the TUI submits what it held, so it is the proof.
      //
      // Far-future on purpose: `inbox` stamps injectedAt from the wall clock,
      // so a boundary written as a fixed near-date silently stops being "after
      // the injection" once real time passes it. This assertion must not depend
      // on when it is run.
      const later = "2099-01-01T00:00:00.000Z";
      db.insertEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: later,
      } as never);
      db.insertEvent({
        kind: "turn-end",
        agentName: "queen",
        timestamp: later,
      } as never);

      expect(await delivery.reconcileInjected("2099-01-01T00:00:01.000Z")).toBe(
        2,
      );
      expect(db.getMessage("msg-agent")?.state).toBe("applied");
      expect(db.getMessage("msg-root")?.state).toBe("applied");
    } finally {
      db.close();
    }
  });
});
