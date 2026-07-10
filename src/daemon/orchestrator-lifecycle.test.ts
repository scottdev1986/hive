import { describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORCHESTRATOR_NAME,
  type AgentRecord,
} from "../schemas";
import { HiveDatabase } from "./db";
import { MessageDelivery, type TmuxSender } from "./delivery";
import {
  createOrchestratorEnvelope,
  formatOrchestratorWake,
  ORCHESTRATOR_ENVELOPE_MAX_BYTES,
  orchestratorTmuxSession,
} from "./orchestrator-lifecycle";
import { HiveDaemon } from "./server";
import type { Spawner } from "./spawner";

const home = mkdtempSync(join(tmpdir(), "hive-orchestrator-lifecycle-"));
const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "default",
    tier: "standard",
    status: "working",
    taskDescription: "Build the event bridge",
    worktreePath: "/tmp/maya",
    branch: "hive/maya-bridge",
    tmuxSession: "hive-maya",
    contextPct: 12,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    writeRevoked: false,
    ...overrides,
  };
}

class RecordingSender implements TmuxSender {
  readonly calls: Array<[string, string]> = [];

  async sendMessage(session: string, text: string): Promise<void> {
    this.calls.push([session, text]);
  }
}

class FailingSender implements TmuxSender {
  calls = 0;

  async sendMessage(): Promise<void> {
    this.calls += 1;
    throw new Error("orchestrator session unavailable");
  }
}

const unusedSpawner: Spawner = {
  async spawn() {
    throw new Error("not used");
  },
};

function textValue(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as unknown;
}

describe("event-driven orchestrator lifecycle", () => {
  test("stays idle and does not wake for ordinary agent state changes", async () => {
    const db = new HiveDatabase(join(home, "idle.db"));
    const sender = new RecordingSender();
    const daemon = new HiveDaemon({
      db,
      spawner: unusedSpawner,
      tmuxSender: sender,
    });
    db.insertAgent(agent());
    try {
      await daemon.processEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: "2026-07-09T12:00:10.000Z",
      });
      await daemon.processEvent({
        kind: "turn-end",
        agentName: "maya",
        timestamp: "2026-07-09T12:00:20.000Z",
      });
      await Bun.sleep(5);

      expect(sender.calls).toEqual([]);
      expect(db.getUndeliveredMessages(ORCHESTRATOR_NAME)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("an agent message wakes the reserved orchestrator destination", async () => {
    const db = new HiveDatabase(join(home, "wake.db"));
    const sender = new RecordingSender();
    const daemon = new HiveDaemon({
      db,
      spawner: unusedSpawner,
      tmuxSender: sender,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: (input, init) => daemon.fetch(new Request(input, init)) },
    );
    const client = new Client({ name: "wake-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const message = textValue(await client.callTool({
        name: "hive_send",
        arguments: {
          from: "maya",
          to: ORCHESTRATOR_NAME,
          body: "The implementation is ready for review.",
        },
      })) as { deliveredAt: string | null };

      expect(message.deliveredAt).not.toEqual(null);
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]?.[0]).toEqual(orchestratorTmuxSession());
      expect(sender.calls[0]?.[1]).toContain('"kind":"hive.message"');
      expect(sender.calls[0]?.[1]).toContain('"from":"maya"');
      expect(sender.calls[0]?.[1]).not.toContain("Build the event bridge");
    } finally {
      await client.close().catch(() => undefined);
      db.close();
    }
  });

  test("keeps failed wakes unread and acknowledges each message once", async () => {
    const db = new HiveDatabase(join(home, "durable.db"));
    const failing = new MessageDelivery(db, new FailingSender());
    try {
      const queued = await failing.send(
        "maya",
        ORCHESTRATOR_NAME,
        "Durable report",
      );
      expect(queued.deliveredAt).toEqual(null);
      expect(db.getUndeliveredMessages(ORCHESTRATOR_NAME)).toHaveLength(1);

      const recovered = new MessageDelivery(db, new RecordingSender());
      const [first, second] = await Promise.all([
        recovered.orchestratorInbox(),
        recovered.orchestratorInbox(),
      ]);
      expect([first.length, second.length].toSorted()).toEqual([0, 1]);
      expect(db.getMessage(queued.id)?.deliveredAt).not.toEqual(null);
      expect(await recovered.orchestratorInbox()).toEqual([]);
      expect(
        db.acknowledgeMessage(queued.id, new Date().toISOString()),
      ).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("orders and deduplicates concurrent root messages by durable insertion", async () => {
    const db = new HiveDatabase(join(home, "ordering.db"));
    const sender = new RecordingSender();
    const delivery = new MessageDelivery(db, sender);
    try {
      const delivered = await Promise.all([
        delivery.send("maya", ORCHESTRATOR_NAME, "first"),
        delivery.send("sam", ORCHESTRATOR_NAME, "second"),
        delivery.send("nina", ORCHESTRATOR_NAME, "third"),
      ]);

      expect(sender.calls.map((call) =>
        JSON.parse(call[1].slice(3)) as { body: string }
      ).map((envelope) => envelope.body)).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(new Set(delivered.map((message) => message.id)).size).toEqual(3);
      expect(delivered.every((message) => message.deliveredAt !== null)).toEqual(
        true,
      );
      expect(await delivery.wakeOrchestrator()).toEqual([]);
      expect(sender.calls).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test("bounds injected context and leaves the full report behind a reference", async () => {
    const db = new HiveDatabase(join(home, "bounded.db"));
    const sender = new RecordingSender();
    const delivery = new MessageDelivery(db, sender);
    const body = `${'"\\n'.repeat(20_000)}${"🚀".repeat(20_000)}`;
    try {
      const stored = await delivery.send("maya", ORCHESTRATOR_NAME, body);
      const envelope = createOrchestratorEnvelope(stored);
      const wake = formatOrchestratorWake(envelope);

      expect(new TextEncoder().encode(wake).byteLength).toBeLessThanOrEqual(
        ORCHESTRATOR_ENVELOPE_MAX_BYTES,
      );
      expect(envelope.truncated).toEqual(true);
      expect(envelope.ref).toContain("hive_read_message");
      expect(delivery.readOrchestratorMessage(stored.id)?.body).toEqual(body);
      expect(sender.calls[0]?.[1]).toEqual(wake);
    } finally {
      db.close();
    }
  });

  test("fetches compact active status only when explicitly requested", async () => {
    const db = new HiveDatabase(join(home, "status-on-demand.db"));
    const daemon = new HiveDaemon({ db, spawner: unusedSpawner });
    db.insertAgent(agent({
      taskDescription: `Active ${"detail ".repeat(100)}`,
    }));
    db.insertAgent(agent({
      id: "agent-sam",
      name: "sam",
      status: "dead",
      tmuxSession: "hive-sam",
    }));
    const listSpy = spyOn(db, "listAgents");
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      { fetch: (input, init) => daemon.fetch(new Request(input, init)) },
    );
    const client = new Client({ name: "status-test", version: "1.0.0" });
    try {
      expect(listSpy).toHaveBeenCalledTimes(0);
      await daemon.processEvent({
        kind: "turn-start",
        agentName: "maya",
        timestamp: "2026-07-09T12:00:10.000Z",
      });
      expect(listSpy).toHaveBeenCalledTimes(0);

      await client.connect(transport);
      const status = textValue(await client.callTool({
        name: "hive_status",
        arguments: { detail: "active" },
      })) as Array<Record<string, unknown>>;
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(status).toHaveLength(1);
      expect(status[0]?.name).toEqual("maya");
      expect(status[0]?.task).toBeString();
      expect((status[0]?.task as string).length).toBeLessThanOrEqual(160);
      expect(status[0]).not.toHaveProperty("taskDescription");
      expect(status[0]).not.toHaveProperty("worktreePath");
    } finally {
      listSpy.mockRestore();
      await client.close().catch(() => undefined);
      db.close();
    }
  });
});
