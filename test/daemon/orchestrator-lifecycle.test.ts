import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HiveDatabase } from "../../src/daemon/db";
import {
  MessageDelivery,
  type RootProtocolDeliverer,
  type SessionSender,
} from "../../src/daemon/delivery";
import {
  compactActiveTeam,
  createOrchestratorEnvelope,
  formatOrchestratorWake,
  ORCHESTRATOR_ENVELOPE_MAX_BYTES,
} from "../../src/daemon/orchestrator-lifecycle";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  SessiondAgentInput,
  SessiondInjectResult,
} from "../../src/daemon/session-host/sessiond-agent-input";
import type { Spawner } from "../../src/daemon/spawner";
import {
  AgentMessageSchema,
  type AgentRecord,
  ORCHESTRATOR_NAME,
  type ProviderRun,
} from "../../src/schemas";

const home = mkdtempSync(join(tmpdir(), "hive-orchestrator-lifecycle-"));
const timestamp = "2026-07-09T12:00:00.000Z";

test("active status reports observed ownership overlap", () => {
  const agents = [agent(), agent({ id: "agent-noor", name: "noor" })];
  const status = compactActiveTeam(
    agents,
    new Map([
      ["maya", { instructions: [], files: ["src/shared.ts"] }],
      ["noor", { instructions: [], files: ["src/shared.ts", "src/noor.ts"] }],
    ]),
  );
  expect(status[0]?.overlaps).toEqual(["noor"]);
  expect(status[1]?.overlaps).toEqual(["maya"]);
});

test("compact status keeps nullable delivery and graphify fields present", () => {
  const [status] = compactActiveTeam([agent({ graphifyCalls: null })]);
  expect(status).toHaveProperty("graphifyCalls", null);
  expect(status).toHaveProperty("deliveryBlocked", null);
});

test("compact status carries the passive activity projection", () => {
  const value = agent();
  const activity = {
    agentId: value.id,
    providerRunId: null,
    observedAt: timestamp,
    terminalState: "unknown" as const,
    providerState: "unknown" as const,
    turnState: "unknown" as const,
    phase: "unknown" as const,
    summary: null,
    evidence: [],
    providerEventThrough: null,
    outputThrough: "0",
    completeness: "unknown" as const,
  };
  expect(
    compactActiveTeam([value], new Map(), new Map([[value.id, activity]]))[0]
      ?.activity,
  ).toEqual(activity);
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

class RecordingSender implements SessionSender {
  readonly calls: Array<[string, string]> = [];

  async sendSessionMessage(agent: AgentRecord, text: string): Promise<void> {
    this.calls.push([agent.name, text]);
  }
}

class RecordingRootProtocol implements RootProtocolDeliverer {
  readonly calls: Array<{ content: string; meta: Record<string, string> }> = [];
  live = true;
  confirmed = true;
  isLive(): boolean {
    return this.live;
  }
  async deliverMessage(
    content: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    this.calls.push({ content, meta });
    return this.confirmed;
  }
}

class FailingSender implements SessionSender {
  calls = 0;

  async sendSessionMessage(): Promise<void> {
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
  const content = (
    result as {
      content: Array<{ type: string; text?: string }>;
    }
  ).content[0];
  if (content?.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as unknown;
}

describe("event-driven orchestrator lifecycle", () => {
  test("a working provider receives its first queued message as its opening turn", async () => {
    const db = new HiveDatabase(":memory:");
    const terminal = {
      schemaVersion: 1 as const,
      instanceId: "opening-turn",
      subject: { kind: "agent" as const, agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000501",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-opening-turn",
    };
    db.insertAgent(agent({ sessionLocator: terminal }));
    const run: ProviderRun = {
      runId: "018f1e90-7b5a-7cc0-8000-000000000502",
      agentId: "agent-maya",
      terminal,
      provider: "codex",
      model: "default",
      effort: null,
      conversationId: null,
      pid: 4_200,
      startToken: "4200:1",
      foregroundProcessGroupId: 4_200,
      capabilityEpoch: 0,
      launchGrantId: "launch-opening-turn",
      startedAt: timestamp,
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    db.insertProviderRun(run);
    const writes: Parameters<SessiondAgentInput["writeAutomated"]>[0][] = [];
    const input: SessiondAgentInput = {
      writeAutomated: async (value) => {
        writes.push(value);
        return {
          outcome: "injected",
          receipt: {
            transactionId: value.idempotencyKey,
            stage: "written-to-terminal",
            byteRange: { start: "0", endExclusive: "5" },
            orderedAt: "5",
            availableCreditBytes: 4_096,
            consumedByProcess: "not-claimed",
            completeness: "complete",
            diagnostic: null,
          },
        };
      },
    };
    const delivery = new MessageDelivery(
      db,
      new RecordingSender(),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      () => false,
      input,
    );

    const message = await delivery.send("queen", "maya", "Begin now.");

    expect(message.state).toBe("injected");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expectedForeground).toEqual({
      providerRunId: run.runId,
      pid: run.pid,
      startToken: run.startToken,
      processGroupId: run.foregroundProcessGroupId,
    });
    expect(db.listMessageAttempts(message.id)).toHaveLength(1);
    expect(db.listMessageAttempts(message.id)[0]?.outcome).toBe("written");

    const second = await delivery.send("sam", "maya", "Second message.");
    const third = await delivery.send("queen", "maya", "Third message.");
    expect([second.state, third.state]).toEqual(["queued", "queued"]);
    const current = db.getAgentByName("maya");
    if (current === null) throw new Error("agent disappeared");
    db.upsertAgent({ ...current, status: "idle" });

    const flushed = await delivery.flushQueued("maya");

    expect(flushed.map((item) => item.id)).toEqual([second.id, third.id]);
    expect(writes).toHaveLength(2);
    const batch = new TextDecoder().decode(writes[1]?.bytes);
    expect(batch.indexOf(second.id)).toBeLessThan(batch.indexOf(third.id));
    expect(batch).toContain(`message ${second.id} from sam:`);
    expect(batch).toContain(`message ${third.id} from queen:`);
    expect(db.listMessageAttempts(second.id)[0]).toMatchObject({
      outcome: "written",
      terminalReceipt: { transactionId: writes[1]?.idempotencyKey },
    });
    expect(db.listMessageAttempts(third.id)[0]).toMatchObject({
      outcome: "written",
      terminalReceipt: { transactionId: writes[1]?.idempotencyKey },
    });
    db.close();
  });

  test("a foreground change leaves the opening message queued with its terminal receipt", async () => {
    const db = new HiveDatabase(":memory:");
    const terminal = {
      schemaVersion: 1 as const,
      instanceId: "foreground-race",
      subject: { kind: "agent" as const, agentId: "agent-maya" },
      generation: 1,
      sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000503",
      hostKind: "sessiond" as const,
      engineBuildId: "engine-foreground-race",
    };
    db.insertAgent(agent({ sessionLocator: terminal }));
    const run: ProviderRun = {
      runId: "018f1e90-7b5a-7cc0-8000-000000000504",
      agentId: "agent-maya",
      terminal,
      provider: "codex",
      model: "default",
      effort: null,
      conversationId: null,
      pid: 4_300,
      startToken: "4300:1",
      foregroundProcessGroupId: 4_300,
      capabilityEpoch: 0,
      launchGrantId: "launch-foreground-race",
      startedAt: timestamp,
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    db.insertProviderRun(run);
    const writes: Parameters<SessiondAgentInput["writeAutomated"]>[0][] = [];
    const input: SessiondAgentInput = {
      writeAutomated: async (value): Promise<SessiondInjectResult> => {
        writes.push(value);
        return {
          outcome: "declined",
          reason: "input receipt stage rejected: foreground-changed",
          receipt: {
            transactionId: value.idempotencyKey,
            stage: "rejected",
            byteRange: null,
            orderedAt: null,
            availableCreditBytes: 4_096,
            consumedByProcess: "not-claimed",
            completeness: "complete",
            diagnostic: "foreground-changed",
          },
        };
      },
    };
    const delivery = new MessageDelivery(
      db,
      new RecordingSender(),
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      () => false,
      input,
    );

    const message = await delivery.send("queen", "maya", "Begin now.");
    const stored = db.getMessage(message.id);
    const [attempt] = db.listMessageAttempts(message.id);

    expect(stored).toMatchObject({ state: "queued", deliveredAt: null });
    expect(attempt).toMatchObject({
      expectedProviderRunId: run.runId,
      terminalGeneration: 1,
      outcome: "foreground-changed",
      terminalReceipt: {
        stage: "rejected",
        byteRange: null,
        diagnostic: "foreground-changed",
      },
    });

    const second = await delivery.send("sam", "maya", "Second message.");
    const third = await delivery.send("queen", "maya", "Third message.");
    const current = db.getAgentByName("maya");
    if (current === null) throw new Error("agent disappeared");
    db.upsertAgent({ ...current, status: "idle" });
    expect(await delivery.flushQueued("maya")).toEqual([]);
    expect(writes).toHaveLength(2);
    for (const id of [message.id, second.id, third.id]) {
      expect(db.getMessage(id)).toMatchObject({
        state: "queued",
        deliveredAt: null,
      });
      expect(db.listMessageAttempts(id).at(-1)).toMatchObject({
        outcome: "foreground-changed",
        terminalReceipt: {
          transactionId: writes[1]?.idempotencyKey,
          byteRange: null,
        },
      });
    }
    db.close();
  });

  test("stays idle and does not wake for ordinary agent state changes", async () => {
    const db = new HiveDatabase(join(home, "idle.db"));
    const sender = new RecordingSender();
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: unusedSpawner,
      sessionSender: sender,
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

  test("an agent message reaches the root protocol directly", async () => {
    const db = new HiveDatabase(join(home, "wake.db"));
    const sender = new RecordingSender();
    const root = new RecordingRootProtocol();
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      root,
    );
    try {
      const message = await delivery.send(
        "maya",
        ORCHESTRATOR_NAME,
        "The implementation is ready for review.",
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
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      root,
    );
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
    const db = new HiveDatabase(
      join(home, "root-protocol-eventual-delivery.db"),
    );
    const sender = new RecordingSender();
    const root = new RecordingRootProtocol();
    root.live = false;
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      root,
    );
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
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      root,
    );
    try {
      const delivered = await Promise.all([
        delivery.send("maya", ORCHESTRATOR_NAME, "first"),
        delivery.send("sam", ORCHESTRATOR_NAME, "second"),
        delivery.send("nina", ORCHESTRATOR_NAME, "third"),
      ]);

      expect(
        root.calls
          .map((call) => JSON.parse(call.content.slice(3)) as { body: string })
          .map((envelope) => envelope.body),
      ).toEqual(["first", "second", "third"]);
      expect(new Set(delivered.map((message) => message.id)).size).toEqual(3);
      expect(
        delivered.every((message) => message.deliveredAt !== null),
      ).toEqual(true);
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
    const delivery = new MessageDelivery(
      db,
      sender,
      undefined,
      undefined,
      root,
    );
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
    expect(
      new TextEncoder().encode(formatOrchestratorWake(envelope)).byteLength,
    ).toBeLessThanOrEqual(ORCHESTRATOR_ENVELOPE_MAX_BYTES);
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
    spyOn(db, "getTerminalHostBindingByLocator").mockReturnValue({
      createEvidence: {},
    } as never);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: unusedSpawner,
    });
    db.insertAgent(
      agent({
        taskDescription: `Active ${"detail ".repeat(100)}`,
      }),
    );
    db.insertAgent(
      agent({
        id: "agent-sam",
        name: "sam",
        status: "dead",
      }),
    );
    const listSpy = spyOn(db, "listAgents");
    const capability = daemon.issueCredential(
      "test-orchestrator",
      "operator",
      0,
    );
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
      db.insertMessage(
        AgentMessageSchema.parse({
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
        }),
      );

      await client.connect(transport);
      const status = textValue(
        await client.callTool({
          name: "hive_status",
          arguments: { detail: "active" },
        }),
      ) as Array<Record<string, unknown>>;
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(status).toHaveLength(1);
      expect(status[0]?.name).toEqual("maya");
      const task = status[0]?.task;
      expect(task).toBeString();
      expect(status[0]?.instructionCount).toEqual(1);
      expect(status[0]?.latestInstruction).toContain("policy store");
      expect(
        typeof task === "string" ? task.length : Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(160);
      expect(status[0]).not.toHaveProperty("taskDescription");
      expect(status[0]).not.toHaveProperty("worktreePath");
      const projected = textValue(
        await client.callTool({
          name: "hive_status",
          arguments: { detail: "active", fields: ["name", "instructionCount"] },
        }),
      );
      expect(projected).toEqual([{ name: "maya", instructionCount: 1 }]);
    } finally {
      listSpy.mockRestore();
      await client.close().catch(() => undefined);
      db.close();
    }
  });
});
