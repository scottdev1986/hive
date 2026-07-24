import { describe, expect, test } from "bun:test";
import {
  OrchestratorRootDelivery,
  SessiondOrchestratorRootDelivery,
} from "../../src/daemon/orchestrator-root-delivery";
import { orchestratorTmuxSession } from "../../src/daemon/orchestrator-lifecycle";
import type { OrchestratorSessiondSnapshot } from "../../src/daemon/orchestrator-sessiond";
import type { InputReceipt } from "../../src/daemon/session-host/terminal-host-contract";

function tmux() {
  return {
    calls: [] as Array<{ session: string; text: string }>,
    async sendMessage(session: string, text: string) {
      this.calls.push({ session, text });
    },
  };
}

describe("OrchestratorRootDelivery", () => {
  for (const tool of ["claude", "codex", "grok"] as const) {
    test(`submits agent reports into the live ${tool} root`, async () => {
      const sender = tmux();
      const delivery = new OrchestratorRootDelivery({ tmux: sender });

      expect(await delivery.deliverMessage("agent report", {})).toEqual(true);
      expect(sender.calls).toEqual([{
        session: orchestratorTmuxSession(),
        text: "agent report",
      }]);
      expect(delivery.isLive()).toEqual(true);
    });
  }
});

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

describe("SessiondOrchestratorRootDelivery", () => {
  test("confirms injection only from the root INPUT_SUBMIT receipt", async () => {
    const calls: unknown[] = [];
    const delivery = new SessiondOrchestratorRootDelivery({
      current: () => sessiondRoot,
      ready: () => true,
      input: {
        async injectRoot(locator, content, options) {
          calls.push({ locator, content, options });
          return { outcome: "injected", receipt: inputReceipt };
        },
      },
    });

    expect(delivery.isLive()).toBe(true);
    expect(await delivery.deliverMessage("agent report", { message_id: "message-1" }))
      .toBe(true);
    expect(calls).toEqual([{
      locator: sessiondRoot.locator,
      content: "agent report",
      options: { messageId: "message-1" },
    }]);
  });

  test("keeps delivery unconfirmed when the host declines input", async () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      current: () => sessiondRoot,
      ready: () => true,
      input: {
        async injectRoot() {
          return { outcome: "declined", reason: "claim denied" };
        },
      },
    });
    await expect(delivery.deliverMessage(
      "agent report",
      { message_id: "message-1" },
    )).resolves.toBe(false);
  });

  test("is not live before the root host is running", () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      current: () => ({ ...sessiondRoot, state: "awaiting-visibility" }),
      ready: () => true,
      input: { injectRoot: async () => ({ outcome: "injected", receipt: inputReceipt }) },
    });
    expect(delivery.isLive()).toBe(false);
  });

  test("does not inject while the provider is still drawing its startup screen", async () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      current: () => sessiondRoot,
      ready: () => false,
      input: {
        injectRoot: async () => {
          throw new Error("startup input must remain queued");
        },
      },
    });
    expect(delivery.isLive()).toBe(false);
    await expect(delivery.deliverMessage(
      "queued startup alert",
      { message_id: "message-1" },
    )).resolves.toBe(false);
  });

  test("does not turn a queued Hive message into a shell command after the TUI exits", async () => {
    const delivery = new SessiondOrchestratorRootDelivery({
      current: () => sessiondRoot,
      ready: () => true,
      canInject: async () => false,
      input: {
        injectRoot: async () => {
          throw new Error("the idle shell must never receive provider input");
        },
      },
    });
    await expect(delivery.deliverMessage(
      "agent report",
      { message_id: "message-1" },
    )).resolves.toBe(false);
  });
});
