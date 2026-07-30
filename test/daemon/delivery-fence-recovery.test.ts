import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/db";
import {
  MessageDelivery,
  type SessionSender,
  type StaleRunForeground,
} from "../../src/daemon/delivery";
import type { AutomatedInput } from "../../src/daemon/session-host/contract";
import type {
  SessiondAgentInput,
  SessiondInjectResult,
} from "../../src/daemon/session-host/sessiond-agent-input";
import type { AgentRecord, ProviderRun } from "../../src/schemas";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const SESSION_ID = "ses_019fb46e-20e8-71f8-85fe-e00ca20b7de4";
const RUN_ID = "0495a5fc-33e8-4048-9d25-1fee3fb06091";
const RECORDED = { pid: 999, startToken: "1:1", processGroupId: 999 };
const MEASURED = { pid: 4242, startToken: "2:2", processGroupId: 4242 };

function agent(status: AgentRecord["status"]): AgentRecord {
  const now = "2026-07-30T12:00:00.000Z";
  return {
    id: "maya-id",
    name: "maya",
    tool: "claude",
    model: "claude-sonnet-5",
    category: "simple_coding",
    status,
    taskDescription: "Build the inbox.",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya",
    contextPct: null,
    createdAt: now,
    lastEventAt: now,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "test-instance",
      subject: { kind: "agent", agentId: "maya-id" },
      generation: 1,
      sessionId: SESSION_ID,
      hostKind: "sessiond",
      engineBuildId: "test-build",
    },
  };
}

function run(): ProviderRun {
  return {
    runId: RUN_ID,
    agentId: "maya-id",
    terminal: agent("idle").sessionLocator as NonNullable<
      AgentRecord["sessionLocator"]
    >,
    provider: "claude",
    model: "claude-sonnet-5",
    effort: null,
    conversationId: null,
    pid: RECORDED.pid,
    startToken: RECORDED.startToken,
    foregroundProcessGroupId: RECORDED.processGroupId,
    capabilityEpoch: 0,
    launchGrantId: "grant-1",
    startedAt: "2026-07-30T12:00:00.000Z",
    endedAt: null,
    state: "running",
    exitReason: null,
  };
}

function acceptedReceipt(transactionId: string) {
  return {
    transactionId,
    stage: "accepted" as const,
    byteRange: null,
    orderedAt: null,
    availableCreditBytes: 0,
    consumedByProcess: "not-claimed" as const,
    completeness: "complete" as const,
    diagnostic: null,
  };
}

class FakeInput implements SessiondAgentInput {
  readonly writes: AutomatedInput[] = [];

  constructor(
    private readonly respond: (input: AutomatedInput) => SessiondInjectResult,
  ) {}

  async writeAutomated(input: AutomatedInput): Promise<SessiondInjectResult> {
    this.writes.push(input);
    return this.respond(input);
  }
}

const inject = (input: AutomatedInput): SessiondInjectResult => ({
  outcome: "injected",
  receipt: acceptedReceipt(input.idempotencyKey),
});
const refuseForeground: SessiondInjectResult = {
  outcome: "declined",
  reason: "input receipt stage rejected: foreground-changed",
};

const isEscape = (input: AutomatedInput): boolean =>
  input.bytes.length === 1 && input.bytes[0] === 0x1b;

const silentSender: SessionSender = {
  sendSessionMessage: async () => {
    throw new Error("legacy sender must not be used with sessiond input");
  },
};

function harness(
  status: AgentRecord["status"],
  respond: (input: AutomatedInput) => SessiondInjectResult,
  staleRunForeground?: StaleRunForeground,
) {
  const root = mkdtempSync(join(tmpdir(), "hive-fence-recovery-"));
  roots.push(root);
  const db = new HiveDatabase(join(root, "hive.db"));
  db.insertAgent(agent(status));
  db.insertProviderRun(run());
  const input = new FakeInput(respond);
  const delivery = new MessageDelivery(
    db,
    silentSender,
    undefined,
    undefined,
    undefined,
    async () => "running",
    () => false,
    input,
    staleRunForeground,
  );
  return { db, delivery, input };
}

describe("delivery fence recovery", () => {
  test("retries once against the measured foreground when the recorded run identity is stale", async () => {
    const { db, delivery, input } = harness(
      "idle",
      (write) =>
        write.expectedForeground.pid === MEASURED.pid
          ? inject(write)
          : refuseForeground,
      async () => MEASURED,
    );

    const message = await delivery.send("queen", "maya", "Hello.");

    expect(message.state).toBe("notified");
    expect(input.writes).toHaveLength(2);
    expect(input.writes[0]?.expectedForeground.pid).toBe(RECORDED.pid);
    expect(input.writes[1]?.expectedForeground.pid).toBe(MEASURED.pid);
    expect(input.writes[1]?.idempotencyKey.endsWith(":remeasured")).toBe(true);
    const attempts = db.listMessageAttempts(message.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("written");
    expect(delivery.blockedDeliveries().size).toBe(0);
  });

  test("records the decline and surfaces it when the recorded identity is still alive", async () => {
    const { db, delivery } = harness(
      "idle",
      () => refuseForeground,
      async () => undefined,
    );

    const message = await delivery.send("queen", "maya", "Hello.");

    expect(message.state).toBe("queued");
    const attempts = db.listMessageAttempts(message.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("foreground-changed");
    const blocked = delivery.blockedDeliveries().get("maya");
    expect(blocked?.messageId).toBe(message.id);
    expect(blocked?.diagnostic).toContain("foreground-changed");
  });

  test("urgent escape fires at most once per message across delivery retries", async () => {
    let declineNotices = true;
    const { db, delivery, input } = harness("working", (write) => {
      if (isEscape(write)) return inject(write);
      return declineNotices
        ? { outcome: "declined", reason: "claim held by viewer until later" }
        : inject(write);
    });

    const message = await delivery.send("queen", "maya", "Stop.", {
      priority: "urgent",
    });

    expect(message.state).toBe("queued");
    expect(input.writes.filter(isEscape)).toHaveLength(1);
    expect(db.listMessageAttempts(message.id).at(-1)?.outcome).toBe(
      "input-busy",
    );

    declineNotices = false;
    const flushed = await delivery.flushUrgent("maya");

    expect(flushed.map((flushedMessage) => flushedMessage.id)).toEqual([
      message.id,
    ]);
    expect(db.getMessage(message.id)?.state).toBe("notified");
    expect(input.writes.filter(isEscape)).toHaveLength(1);
    expect(db.listMessageAttempts(message.id).at(-1)?.outcome).toBe("written");
  });

  test("acknowledge accepts a queued message read via inbox and keeps the receipt distinction", async () => {
    const { delivery } = harness("working", () => refuseForeground);

    const message = await delivery.send("queen", "maya", "Poll me.");
    expect(message.state).toBe("queued");
    expect(await delivery.inbox("maya")).toMatchObject([{ id: message.id }]);

    const acknowledged = delivery.acknowledge("maya", message.id);
    expect(acknowledged.state).toBe("acknowledged");
    expect(acknowledged.notifiedAt).toBeNull();
    expect(acknowledged.acknowledgedAt).not.toBeNull();
  });
});
