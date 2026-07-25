import { describe, expect, test } from "bun:test";
import { SessiondOrchestratorRootDelivery } from "../../src/daemon/orchestrator-root-delivery";
import type { OrchestratorSessiondSnapshot } from "../../src/daemon/orchestrator-sessiond";
import type { InputReceipt } from "../../src/daemon/session-host/terminal-host-contract";
import type { MessageAttempt, ProviderRun } from "../../src/schemas";

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
  };
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
    ).toBe(true);
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
    await expect(
      delivery.deliverMessage("agent report", { message_id: "message-1" }),
    ).resolves.toBe(false);
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
    ).resolves.toBe(false);
  });

  test("does not turn a queued Hive message into a shell command after the TUI exits", async () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      db: attemptDb(),
      current: () => sessiondRoot,
      ready: () => true,
      canInject: async () => false,
      input: {
        writeAutomated: async () => {
          throw new Error("the idle shell must never receive provider input");
        },
      },
    });
    await expect(
      delivery.deliverMessage("agent report", { message_id: "message-1" }),
    ).resolves.toBe(false);
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
    ).resolves.toBe(false);
  });
});
