import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/db";
import { MessageDelivery } from "../../src/daemon/delivery";
import { SessiondOrchestratorRootDelivery } from "../../src/daemon/orchestrator-root-delivery";
import type { OrchestratorSessiondSnapshot } from "../../src/daemon/orchestrator-sessiond";
import type { InputReceipt } from "../../src/daemon/session-host/terminal-host-contract";
import {
  type MessageAttempt,
  ORCHESTRATOR_NAME,
  type ProviderRun,
} from "../../src/schemas";

const sessiondRoot: OrchestratorSessiondSnapshot = {
  requestId: "req_018f1e90-7b5a-7cc0-8000-000000000411",
  locator: {
    schemaVersion: 1,
    instanceId: "hive-fixture",
    subject: { kind: "root" },
    generation: 2,
    sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000411",
    hostKind: "sessiond",
    engineBuildId: "engine-fixture",
  },
  state: "running",
  exitCode: null,
  diagnostic: null,
};

const inputReceipt: InputReceipt = {
  transactionId: "message-1",
  stage: "written-to-terminal",
  byteRange: { start: "0", endExclusive: "10" },
  orderedAt: "10",
  availableCreditBytes: 4096,
  consumedByProcess: "not-claimed",
  completeness: "complete",
  diagnostic: null,
};

const providerRun: ProviderRun = {
  runId: "018f1e90-7b5a-7cc0-8000-000000000412",
  agentId: null,
  terminal: sessiondRoot.locator,
  provider: "codex",
  model: null,
  effort: null,
  conversationId: null,
  pid: 4_200,
  startToken: "4200:1",
  foregroundProcessGroupId: 4_200,
  capabilityEpoch: 0,
  launchGrantId: sessiondRoot.requestId,
  startedAt: "2026-07-24T12:00:00.000Z",
  endedAt: null,
  state: "running",
  exitReason: null,
};

function attemptDb(active: ProviderRun | null = providerRun) {
  let attempt: MessageAttempt | null = null;
  return {
    getActiveProviderRunByTerminal: () => active,
    beginMessageAttempt: (
      value: Omit<MessageAttempt, "outcome" | "terminalReceipt">,
    ) => {
      attempt = { ...value, outcome: "pending", terminalReceipt: null };
      return attempt;
    },
    finishMessageAttempt: (
      _attemptId: string,
      result: Pick<MessageAttempt, "outcome" | "terminalReceipt">,
    ) => {
      if (attempt === null) throw new Error("attempt was not started");
      attempt = { ...attempt, ...result };
      return attempt;
    },
    lastAttempt: () => attempt,
  };
}

/** A MessageDelivery wired to a live root host that accepts every write. */
function queenDeliveryHarness(
  db: HiveDatabase,
  composerActive: (recipient: string) => boolean = () => false,
) {
  const writes: Uint8Array[] = [];
  const rootDelivery = new SessiondOrchestratorRootDelivery({
    db,
    current: () => sessiondRoot,
    ready: () => true,
    input: {
      async writeAutomated(input) {
        writes.push(input.bytes);
        return { outcome: "injected", receipt: inputReceipt };
      },
    },
  });
  const delivery = new MessageDelivery(
    db,
    {
      sendSessionMessage: async () => {
        throw new Error("queen delivery must use the root protocol");
      },
    },
    undefined,
    rootDelivery,
    undefined,
    undefined,
    // Deterministic: never inherit a composer lease from the ambient rig.
    composerActive,
  );
  return { writes, delivery };
}

describe("SessiondOrchestratorRootDelivery", () => {
  test("confirms injection only from the root INPUT_SUBMIT receipt", async () => {
    const calls: unknown[] = [];
    const delivery = new SessiondOrchestratorRootDelivery({
      db: attemptDb(),
      current: () => sessiondRoot,
      ready: () => true,
      input: {
        async writeAutomated(input) {
          calls.push(input);
          return { outcome: "injected", receipt: inputReceipt };
        },
      },
    });

    expect(delivery.isLive()).toBe(true);
    expect(
      await delivery.deliverMessage("agent report", {
        message_id: "message-1",
      }),
    ).toEqual({ delivered: true });
    expect(calls).toEqual([
      {
        terminal: sessiondRoot.locator,
        expectedForeground: {
          providerRunId: providerRun.runId,
          pid: 4_200,
          startToken: "4200:1",
          processGroupId: 4_200,
        },
        bytes: new TextEncoder().encode("\x1b[200~agent report\x1b[201~\r"),
        idempotencyKey: expect.any(String),
      },
    ]);
  });

  test("keeps delivery unconfirmed when the host declines input", async () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      db: attemptDb(),
      current: () => sessiondRoot,
      ready: () => true,
      input: {
        async writeAutomated() {
          return { outcome: "declined", reason: "claim denied" };
        },
      },
    });
    // The host's own reason, not a bucket: a refusal that cannot name itself
    // leaves a failed root wake unreadable.
    await expect(
      delivery.deliverMessage("agent report", { message_id: "message-1" }),
    ).resolves.toEqual({ delivered: false, reason: "claim denied" });
  });

  test("is not live before the root host is running", () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      db: attemptDb(),
      current: () => ({ ...sessiondRoot, state: "awaiting-visibility" }),
      ready: () => true,
      input: {
        writeAutomated: async () => ({
          outcome: "injected",
          receipt: inputReceipt,
        }),
      },
    });
    expect(delivery.isLive()).toBe(false);
  });

  test("does not inject while the provider is still drawing its startup screen", async () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      db: attemptDb(),
      current: () => sessiondRoot,
      ready: () => false,
      input: {
        writeAutomated: async () => {
          throw new Error("startup input must remain queued");
        },
      },
    });
    expect(delivery.isLive()).toBe(false);
    await expect(
      delivery.deliverMessage("queued startup alert", {
        message_id: "message-1",
      }),
    ).resolves.toEqual({
      delivered: false,
      reason: "root host is not ready for input",
    });
  });

  test("records an atomic foreground veto and preserves its exact reason", async () => {
    const db = attemptDb();
    const reason = "input receipt stage rejected: foreground-changed";
    const delivery = new SessiondOrchestratorRootDelivery({
      db,
      current: () => sessiondRoot,
      ready: () => true,
      input: {
        writeAutomated: async () => ({ outcome: "declined", reason }),
      },
    });
    await expect(
      delivery.deliverMessage("agent report", { message_id: "message-1" }),
    ).resolves.toEqual({
      delivered: false,
      reason,
    });
    expect(db.lastAttempt()).toMatchObject({
      messageId: "message-1",
      outcome: "foreground-changed",
    });
  });

  test("an unbound root foreground has no automated input authority", async () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      db: attemptDb(null),
      current: () => sessiondRoot,
      ready: () => true,
      input: {
        writeAutomated: async () => {
          throw new Error("an unmanaged foreground must not receive input");
        },
      },
    });
    await expect(
      delivery.deliverMessage("agent report", { message_id: "message-1" }),
    ).resolves.toEqual({
      delivered: false,
      reason: "no active provider run is bound to the root terminal",
    });
  });

  test("a normal notice never submits into an open root turn", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertProviderRun(providerRun);
    db.insertEvent({
      kind: "turn-start",
      agentName: ORCHESTRATOR_NAME,
      timestamp: "2026-07-30T21:48:00.000Z",
    });
    const { writes, delivery } = queenDeliveryHarness(db);

    const message = await delivery.send(
      "maya",
      ORCHESTRATOR_NAME,
      "david closed.",
    );

    // The payload is a composer submission (bracketed paste + Enter). Landing
    // it mid-turn makes the provider cancel the turn's pending tool calls as
    // a human rejection, so an open turn must hold the notice, visibly.
    expect(writes).toHaveLength(0);
    expect(db.getMessage(message.id)?.state).toBe("queued");
    expect(delivery.blockedDeliveries().get(ORCHESTRATOR_NAME)).toMatchObject({
      messageId: message.id,
      diagnostic: "root provider has an open turn; waiting for turn-end",
    });
    db.close();
  });

  test("the held notice delivers and reaches notified at turn-end", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertProviderRun(providerRun);
    db.insertEvent({
      kind: "turn-start",
      agentName: ORCHESTRATOR_NAME,
      timestamp: "2026-07-30T21:48:00.000Z",
    });
    const { writes, delivery } = queenDeliveryHarness(db);
    const message = await delivery.send(
      "maya",
      ORCHESTRATOR_NAME,
      "david closed.",
    );
    expect(writes).toHaveLength(0);

    db.insertEvent({
      kind: "turn-end",
      agentName: ORCHESTRATOR_NAME,
      timestamp: "2026-07-30T21:49:00.000Z",
    });
    // The trigger process-event fires on the root's turn-end hook.
    await delivery.flushQueued(ORCHESTRATOR_NAME);

    expect(writes).toHaveLength(1);
    expect(db.getMessage(message.id)?.state).toBe("notified");
    expect(delivery.blockedDeliveries().get(ORCHESTRATOR_NAME)).toBeUndefined();
    db.close();
  });

  test("a held root composer lease records its hold and delivers on release", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertProviderRun(providerRun);
    let leased = true;
    const { writes, delivery } = queenDeliveryHarness(db, () => leased);

    const message = await delivery.send("maya", ORCHESTRATOR_NAME, "Report.");

    expect(writes).toHaveLength(0);
    expect(db.getMessage(message.id)?.state).toBe("queued");
    expect(delivery.blockedDeliveries().get(ORCHESTRATOR_NAME)).toMatchObject({
      messageId: message.id,
      diagnostic: "root composer lease held; waiting for release",
    });

    leased = false;
    // The maintenance sweep retries queued queen mail after the lease lifts.
    await delivery.wakeOrchestrator();

    expect(writes).toHaveLength(1);
    expect(db.getMessage(message.id)?.state).toBe("notified");
    expect(delivery.blockedDeliveries().get(ORCHESTRATOR_NAME)).toBeUndefined();
    db.close();
  });

  test("urgent queen mail still delivers during an open turn", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertProviderRun(providerRun);
    db.insertEvent({
      kind: "turn-start",
      agentName: ORCHESTRATOR_NAME,
      timestamp: "2026-07-30T21:48:00.000Z",
    });
    const { writes, delivery } = queenDeliveryHarness(db);

    const message = await delivery.send("maya", ORCHESTRATOR_NAME, "Stop.", {
      priority: "urgent",
    });

    expect(writes).toHaveLength(1);
    expect(db.getMessage(message.id)?.state).toBe("notified");
    db.close();
  });

  test("keeps repeatedly declined queen mail queued and visible as blocked", async () => {
    const db = new HiveDatabase(":memory:");
    db.insertProviderRun(providerRun);
    const reason = "claim held by workspace-pane-queen until later";
    const rootDelivery = new SessiondOrchestratorRootDelivery({
      db,
      current: () => sessiondRoot,
      ready: () => true,
      input: {
        writeAutomated: async () => ({ outcome: "declined", reason }),
      },
    });
    const delivery = new MessageDelivery(
      db,
      {
        sendSessionMessage: async () => {
          throw new Error("queen delivery must use the root protocol");
        },
      },
      undefined,
      rootDelivery,
    );

    const message = await delivery.send("maya", ORCHESTRATOR_NAME, "Report.");
    expect(message.state).toBe("queued");
    expect(db.listMessageAttempts(message.id)).toHaveLength(1);

    await delivery.wakeOrchestrator();

    expect(db.getMessage(message.id)?.state).toBe("queued");
    expect(db.listMessageAttempts(message.id)).toHaveLength(2);
    expect(delivery.blockedDeliveries().get(ORCHESTRATOR_NAME)).toMatchObject({
      messageId: message.id,
      diagnostic: reason,
    });
    db.close();
  });
});
