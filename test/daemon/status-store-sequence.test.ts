import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { StatusStore } from "../../src/daemon/status/status-store";

const AT = "2026-08-02T12:00:00.000Z";

function turnEvent(status: StatusStore, agentId: string): string {
  return status.appendSourceEvent({
    entity: { kind: "agent", id: agentId },
    occurredAt: AT,
    kind: "status.turn",
    source: {
      kind: "provider-hook",
      id: `claude:${agentId}`,
      observedAt: AT,
      confidence: "high",
    },
    data: { agentId, value: "working" },
  }).seq;
}

describe("the newest sequence an agent has produced", () => {
  test("is null before it produces anything, and the event's own seq after", () => {
    const db = new HiveDatabase(":memory:");
    const status = new StatusStore(db, "sequence-fixture");
    try {
      expect(status.newestAgentEventSeq("agent-maya")).toBeNull();

      const seq = turnEvent(status, "agent-maya");

      expect(status.newestAgentEventSeq("agent-maya")).toEqual(seq);
    } finally {
      db.close();
    }
  });

  test("advances, and never with another agent's traffic", () => {
    const db = new HiveDatabase(":memory:");
    const status = new StatusStore(db, "sequence-fixture");
    try {
      const first = turnEvent(status, "agent-maya");
      const nina = turnEvent(status, "agent-nina");

      expect(status.newestAgentEventSeq("agent-maya")).toEqual(first);
      expect(nina).not.toEqual(first);

      const second = turnEvent(status, "agent-maya");

      expect(status.newestAgentEventSeq("agent-maya")).toEqual(second);
      expect(BigInt(second) > BigInt(first)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("orders by magnitude, not by text", () => {
    // The store keeps sequences as decimal strings, where "9" sorts after
    // "10". A lexicographic MAX would go backwards on the tenth event and the
    // watch would stop seeing anything new.
    const db = new HiveDatabase(":memory:");
    const status = new StatusStore(db, "sequence-fixture");
    try {
      let seq = "";
      for (let index = 0; index < 11; index += 1) {
        seq = turnEvent(status, "agent-maya");
      }

      expect(seq).toEqual("11");
      expect(status.newestAgentEventSeq("agent-maya")).toEqual("11");
    } finally {
      db.close();
    }
  });
});
