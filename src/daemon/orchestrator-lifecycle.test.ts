import { describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentMessageSchema,
  ORCHESTRATOR_NAME,
  type AgentRecord,
} from "../schemas";
import { HiveDatabase } from "./db";
import {
  MessageDelivery,
  type RootProtocolDeliverer,
  type TmuxSender,
} from "./delivery";
import {
  createOrchestratorEnvelope,
  compactActiveTeam,
  formatOrchestratorWake,
  ORCHESTRATOR_ENVELOPE_MAX_BYTES,
  orchestratorTmuxSession,
} from "./orchestrator-lifecycle";
import { HiveDaemon } from "./server";
import type { Spawner } from "./spawner";

const home = mkdtempSync(join(tmpdir(), "hive-orchestrator-lifecycle-"));
const timestamp = "2026-07-09T12:00:00.000Z";

test("active status reports observed ownership overlap", () => {
  const agents = [agent(), agent({ id: "agent-noor", name: "noor" })];
  const status = compactActiveTeam(agents, new Map([
    ["maya", { instructions: [], files: ["src/shared.ts"] }],
    ["noor", { instructions: [], files: ["src/shared.ts", "src/noor.ts"] }],
  ]));
  expect(status[0]?.overlaps).toEqual(["noor"]);
  expect(status[1]?.overlaps).toEqual(["maya"]);
});

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "default",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build the event bridge",
    worktreePath: "/tmp/maya",
    branch: "hive/maya-bridge",
    tmuxSession: "hive-maya",
    contextPct: 12,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
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

class RecordingRootProtocol implements RootProtocolDeliverer {
  readonly calls: Array<{ content: string; meta: Record<string, string> }> = [];
  live = true;
  confirmed = true;
  isLive(): boolean { return this.live; }
  async deliverMessage(
    content: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    this.calls.push({ content, meta });
    return this.confirmed;
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
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
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

  test("an agent message reaches the root protocol without touching tmux", async () => {
    const db = new HiveDatabase(join(home, "wake.db"));
    const sender = new RecordingSender();
    const root = new RecordingRootProtocol();
    const delivery = new MessageDelivery(db, sender, undefined, undefined, root);
    try {
      const message = await delivery.send(
        "maya", ORCHESTRATOR_NAME, "The implementation is ready for review.",
      );

      expect(message.deliveredAt).not.toEqual(null);
      expect(message.state).toEqual("injected");
      expect(sender.calls).toEqual([]);
      expect(root.calls[0]?.content).toContain('"kind":"hive.message"');
      expect(root.calls[0]?.content).toContain('"from":"maya"');
    } finally {
      db.close();
    }
  });

  test("an agent message reaches a codex root through the root protocol", async () => {
    const db = new HiveDatabase(join(home, "codex-root-wake.db"));
    const sender = new RecordingSender();
    const rootProtocol = {
      live: true,
      calls: [] as string[],
      isLive(): boolean {
        return this.live;
      },
      async deliverMessage(content: string): Promise<boolean> {
        this.calls.push(content);
        return true;
      },
    };
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      rootProtocol,
    );
    try {
      const message = await delivery.send(
        "maya",
        ORCHESTRATOR_NAME,
        "Codex root, the fix has landed.",
      );

      expect(message.state).toEqual("injected");
      expect(sender.calls).toEqual([]);
      expect(rootProtocol.calls).toHaveLength(1);
      expect(rootProtocol.calls[0]).toContain('"from":"maya"');
    } finally {
      db.close();
    }
  });

  test("an unconfirmed root-protocol wake remains durable", async () => {
    const db = new HiveDatabase(join(home, "root-protocol-fallthrough.db"));
    const sender = new RecordingSender();
    // A stale codex root socket: isLive says yes, delivery cannot confirm.
    const rootProtocol = {
      isLive: () => true,
      deliverMessage: async () => false,
    };
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      rootProtocol,
    );
    try {
      const message = await delivery.send(
        "maya",
        ORCHESTRATOR_NAME,
        "Report for whichever root is real.",
      );

      expect(message.state).toEqual("queued");
      expect(message.deliveredAt).toBeNull();
      expect(sender.calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("keeps a root report durable until its verified protocol is live", async () => {
    const db = new HiveDatabase(join(home, "root-protocol-unavailable.db"));
    const sender = new RecordingSender();
    const root = new RecordingRootProtocol();
    root.live = false;
    const delivery = new MessageDelivery(db, sender, undefined, undefined, root);
    try {
      const queued = await delivery.send(
        "maya",
        ORCHESTRATOR_NAME,
        "The test suite is green.",
      );

      expect(sender.calls).toEqual([]);
      expect(db.getMessage(queued.id)?.deliveredAt).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("delivers a durable root report once its protocol becomes live", async () => {
    const db = new HiveDatabase(join(home, "root-protocol-eventual-delivery.db"));
    const sender = new RecordingSender();
    const root = new RecordingRootProtocol();
    root.live = false;
    const delivery = new MessageDelivery(db, sender, undefined, undefined, root);
    try {
      const queued = await delivery.send("maya", ORCHESTRATOR_NAME, "Ready.");
      expect(db.getMessage(queued.id)?.deliveredAt).toEqual(null);

      root.live = true;
      const delivered = await delivery.wakeOrchestrator();

      expect(delivered).toHaveLength(1);
      expect(sender.calls).toEqual([]);
      expect(root.calls).toHaveLength(1);
      expect(db.getMessage(queued.id)?.deliveredAt).not.toEqual(null);
    } finally {
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
        db.markMessageDelivered(queued.id, new Date().toISOString()),
      ).toEqual(null);
    } finally {
      db.close();
    }
  });

  test("orders and deduplicates concurrent root messages by durable insertion", async () => {
    const db = new HiveDatabase(join(home, "ordering.db"));
    const sender = new RecordingSender();
    const root = new RecordingRootProtocol();
    const delivery = new MessageDelivery(db, sender, undefined, undefined, root);
    try {
      const delivered = await Promise.all([
        delivery.send("maya", ORCHESTRATOR_NAME, "first"),
        delivery.send("sam", ORCHESTRATOR_NAME, "second"),
        delivery.send("nina", ORCHESTRATOR_NAME, "third"),
      ]);

      expect(root.calls.map((call) =>
        JSON.parse(call.content.slice(3)) as { body: string }
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
      expect(sender.calls).toEqual([]);
      expect(root.calls).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test("bounds injected context and leaves the full report behind a reference", async () => {
    const db = new HiveDatabase(join(home, "bounded.db"));
    const sender = new RecordingSender();
    const root = new RecordingRootProtocol();
    const delivery = new MessageDelivery(db, sender, undefined, undefined, root);
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
      expect(sender.calls).toEqual([]);
      expect(root.calls[0]?.content).toEqual(wake);
    } finally {
      db.close();
    }
  });

  /**
   * A preview that drops the finding is not a preview, it is a summons.
   *
   * The cap cut a prefix, and a report is written the other way round: it opens
   * with what the agent was asked to do and closes with what it found. So the
   * cut landed on the punchline — four times in one session, once on the very
   * line "THREE FINDINGS THAT CHANGE DESIGN:", losing all three — and the
   * orchestrator had to spend a hive_read_message on the whole body anyway,
   * which is the cost the cap existed to avoid.
   */
  test("a long report keeps its findings: the middle is cut, never the punchline", () => {
    const findings = [
      "FINDING 1: the matcher can never fire.",
      "FINDING 2: the guard is keyed on an absent field.",
      "FINDING 3: landed is not live.",
    ];
    const body = [
      "Task: audit the routing table.",
      `Method: ${"I read every call site and reproduced each path. ".repeat(120)}`,
      "THREE FINDINGS THAT CHANGE DESIGN:",
      ...findings,
      "Merged as 9f1c2ab.",
    ].join("\n");
    const message = AgentMessageSchema.parse({
      id: "report-1",
      from: "maya",
      to: ORCHESTRATOR_NAME,
      body,
      createdAt: "2026-07-12T12:00:00.000Z",
      deliveredAt: null,
    });

    const envelope = createOrchestratorEnvelope(message);

    // Still bounded, still honest, still retrievable in full by id.
    expect(new TextEncoder().encode(formatOrchestratorWake(envelope)).byteLength)
      .toBeLessThanOrEqual(ORCHESTRATOR_ENVELOPE_MAX_BYTES);
    expect(envelope.truncated).toEqual(true);
    expect(envelope.ref).toContain("hive_read_message");

    // What the orchestrator actually needed, and never got.
    expect(envelope.body).toContain("Task: audit the routing table.");
    for (const finding of findings) {
      expect(envelope.body).toContain(finding);
    }
    expect(envelope.body).toContain("Merged as 9f1c2ab.");
    // And it says what it dropped rather than trailing off mid-sentence.
    expect(envelope.body).toContain("characters elided");
  });

  test("a message that fits is not touched", () => {
    const message = AgentMessageSchema.parse({
      id: "short-1",
      from: "maya",
      to: ORCHESTRATOR_NAME,
      body: "Landed as 4b2e1c9. No blockers.",
      createdAt: "2026-07-12T12:00:00.000Z",
      deliveredAt: null,
    });
    const envelope = createOrchestratorEnvelope(message);
    expect(envelope.body).toEqual("Landed as 4b2e1c9. No blockers.");
    expect(envelope.truncated).toEqual(false);
  });

  test("fetches compact active status only when explicitly requested", async () => {
    const db = new HiveDatabase(join(home, "status-on-demand.db"));
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: unusedSpawner,
    });
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
    const capability = daemon.issueCredential("test-orchestrator", "operator", 0);
    const transport = new StreamableHTTPClientTransport(
      new URL("http://hive/mcp"),
      {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${capability}`);
          return daemon.fetch(new Request(input, { ...init, headers }));
        },
      },
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
      db.insertMessage(AgentMessageSchema.parse({
        id: "reassignment",
        from: ORCHESTRATOR_NAME,
        to: "maya",
        body: "Stop the bridge work. Build the policy store only.",
        createdAt: "2026-07-09T12:00:11.000Z",
        deliveredAt: null,
        priority: "normal",
        intent: "instruction",
        state: "queued",
        sequence: 1,
      }));

      await client.connect(transport);
      const status = textValue(await client.callTool({
        name: "hive_status",
        arguments: { detail: "active" },
      })) as Array<Record<string, unknown>>;
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(status).toHaveLength(1);
      expect(status[0]?.name).toEqual("maya");
      expect(status[0]?.task).toBeString();
      expect(status[0]?.instructionCount).toEqual(1);
      expect(status[0]?.latestInstruction).toContain("policy store");
      expect((status[0]?.task as string).length).toBeLessThanOrEqual(160);
      expect(status[0]).not.toHaveProperty("taskDescription");
      expect(status[0]).not.toHaveProperty("worktreePath");
      const projected = textValue(await client.callTool({
        name: "hive_status",
        arguments: { detail: "active", fields: ["name", "instructionCount"] },
      }));
      expect(projected).toEqual([{ name: "maya", instructionCount: 1 }]);
    } finally {
      listSpy.mockRestore();
      await client.close().catch(() => undefined);
      db.close();
    }
  });
});
