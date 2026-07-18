import { describe, expect, test } from "bun:test";
import type {
  CreateRequest,
  CreateResult,
  SessionInspection,
  SessionRef,
  TerminationResult,
} from "./terminal-host-contract";
import type {
  HiveTerminalBinding,
  TerminalHostBindingStore,
} from "./terminal-host-binding";
import {
  HiveTerminalHostAdapter,
  TerminalHostBindingMismatchError,
  TerminalHostBindingNotFoundError,
} from "./hive-terminal-host";

const session: SessionRef = { key: "neutral-key", incarnation: "incarnation-1" };
const locator: HiveTerminalBinding["locator"] = {
  schemaVersion: 1,
  instanceId: "hive-fixture",
  subject: { kind: "agent", agentId: "agent-fixture" },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
  hostKind: "sessiond",
  engineBuildId: "engine-fixture",
};
const visibility: HiveTerminalBinding["visibility"] = {
  workspaceSessionId: "workspace-fixture",
  workspacePid: 4_000,
  workspaceStartToken: "4000:123400",
  openTerminalRevision: "1",
};
const createRequest: CreateRequest = {
  key: session.key,
  idempotencyKey: "create-idempotency",
  command: {
    executable: "/bin/sh",
    arguments: ["-c", "read line"],
    workingDirectory: "/tmp",
    completeEnvironment: [],
    descriptorMap: [],
  },
  terminalProfile: {
    inputMode: "canonical",
    echo: true,
    signalCharacters: true,
    softwareFlowControl: true,
    eofByte: 4,
    startByte: 17,
    stopByte: 19,
    hangupOnLastClose: true,
  },
  initialWindow: { columns: 80, rows: 24, widthPixels: 800, heightPixels: 480 },
};
const createResult: CreateResult = {
  session,
  outcome: { state: "unknown", diagnostic: "fixture" },
  limits: {
    maxInputTransactionBytes: 1,
    maxInputQueueBytes: 1,
    maxOutputFrameBytes: 1,
    outputLowWaterBytes: 1,
    outputHighWaterBytes: 1,
    outputRetentionBytes: 1,
  },
};
const inspection: SessionInspection = {
  session,
  lifecycle: "running",
  completeness: "partial",
  host: null,
  child: null,
  jobControl: null,
  window: { value: createRequest.initialWindow, revision: "0" },
  output: { closed: false, retained: { start: "0", endExclusive: "0" } },
  checkpoints: { retained: 0, newest: null },
  inputOwner: null,
  exit: null,
  reap: {
    authority: "unavailable",
    reaped: false,
    status: null,
    completeness: "unavailable",
  },
  descendants: [],
  survivors: [],
  evidenceAt: "2026-07-18T01:00:00.000Z",
  diagnostics: [],
};
const termination: TerminationResult = {
  state: "terminated",
  exit: null,
  reap: {
    authority: "direct-parent",
    reaped: true,
    status: null,
    completeness: "complete",
  },
  survivors: [],
  completeness: "complete",
  diagnostics: [],
};

class MemoryBindings implements TerminalHostBindingStore {
  readonly values: HiveTerminalBinding[] = [];

  bindTerminalHostSession(binding: HiveTerminalBinding): HiveTerminalBinding {
    this.values.push(binding);
    return binding;
  }

  getTerminalHostBinding(value: SessionRef): HiveTerminalBinding | null {
    return this.values.find((binding) =>
      binding.session.key === value.key &&
      binding.session.incarnation === value.incarnation) ?? null;
  }

  getTerminalHostBindingByLocator(
    value: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding | null {
    return this.values.find((binding) =>
      binding.locator.instanceId === value.instanceId &&
      binding.locator.sessionId === value.sessionId &&
      binding.locator.generation === value.generation) ?? null;
  }
}

describe("HiveTerminalHostAdapter", () => {
  test("binds create and maps lifecycle operations without leaking neutral inventory", async () => {
    const bindings = new MemoryBindings();
    const unbound = { ...inspection, session: { key: "other", incarnation: "1" } };
    const terminateRequests: unknown[] = [];
    const directRequests: unknown[] = [];
    const host = {
      create: async () => createResult,
      claimInput: async (request: unknown) => {
        directRequests.push(request);
        return { state: "unknown" as const, diagnostic: "fixture" };
      },
      submitInput: async (request: unknown) => {
        directRequests.push(request);
        return {
          transactionId: "transaction-fixture",
          stage: "unknown" as const,
          byteRange: null,
          orderedAt: null,
          availableCreditBytes: 0,
          consumedByProcess: "not-claimed" as const,
          completeness: "unknown" as const,
          diagnostic: "fixture",
        };
      },
      resize: async (request: unknown) => {
        directRequests.push(request);
        return { state: "unknown" as const, diagnostic: "fixture" };
      },
      list: async () => [inspection, unbound],
      inspect: async () => inspection,
      terminate: async (request: unknown) => {
        terminateRequests.push(request);
        return termination;
      },
    };
    const adapter = new HiveTerminalHostAdapter(host, bindings, locator.instanceId);

    await expect(adapter.create(createRequest, { locator, visibility }))
      .resolves.toEqual(createResult);
    expect(bindings.values).toEqual([{ session, locator, visibility }]);
    await expect(adapter.list()).resolves.toEqual([{
      binding: { session, locator, visibility },
      inspection,
    }]);
    await expect(adapter.inspect(locator)).resolves.toEqual({
      binding: { session, locator, visibility },
      inspection,
    });
    await adapter.claimInput(locator, {
      writer: "writer-fixture",
      kind: "automation",
      leaseMilliseconds: 1_000,
      idempotencyKey: "claim-idempotency",
    });
    await adapter.submitInput(locator, {
      claimToken: "claim-fixture",
      transactionId: "transaction-fixture",
      idempotencyKey: "input-idempotency",
      operation: { kind: "canonical-end-of-file" },
    });
    await adapter.resize(locator, {
      window: createRequest.initialWindow,
      revision: "2",
      idempotencyKey: "resize-idempotency",
    });
    expect(directRequests).toEqual([
      {
        session,
        writer: "writer-fixture",
        kind: "automation",
        leaseMilliseconds: 1_000,
        idempotencyKey: "claim-idempotency",
      },
      {
        session,
        claimToken: "claim-fixture",
        transactionId: "transaction-fixture",
        idempotencyKey: "input-idempotency",
        operation: { kind: "canonical-end-of-file" },
      },
      {
        session,
        window: createRequest.initialWindow,
        revision: "2",
        idempotencyKey: "resize-idempotency",
      },
    ]);
    await expect(adapter.terminate(locator, {
      mode: "immediate",
      target: "process-tree",
      deadline: "2026-07-18T01:00:01.000Z",
      idempotencyKey: "terminate-idempotency",
    })).resolves.toEqual(termination);
    expect(terminateRequests).toEqual([{
      session,
      mode: "immediate",
      target: "process-tree",
      deadline: "2026-07-18T01:00:01.000Z",
      idempotencyKey: "terminate-idempotency",
    }]);
  });

  test("fails closed for missing, foreign, or mismatched bindings", async () => {
    const bindings = new MemoryBindings();
    const host = {
      create: async () => ({
        ...createResult,
        session: { ...session, key: "wrong-key" },
      }),
      claimInput: async () => ({ state: "unknown" as const, diagnostic: "fixture" }),
      submitInput: async () => ({
        transactionId: "transaction-fixture",
        stage: "unknown" as const,
        byteRange: null,
        orderedAt: null,
        availableCreditBytes: 0,
        consumedByProcess: "not-claimed" as const,
        completeness: "unknown" as const,
        diagnostic: "fixture",
      }),
      resize: async () => ({ state: "unknown" as const, diagnostic: "fixture" }),
      list: async () => [],
      inspect: async () => ({
        ...inspection,
        session: { ...session, incarnation: "wrong-incarnation" },
      }),
      terminate: async () => termination,
    };
    const adapter = new HiveTerminalHostAdapter(host, bindings, locator.instanceId);

    await expect(adapter.create(createRequest, { locator, visibility }))
      .rejects.toBeInstanceOf(TerminalHostBindingMismatchError);
    await expect(adapter.inspect(locator))
      .rejects.toBeInstanceOf(TerminalHostBindingNotFoundError);
    bindings.bindTerminalHostSession({ session, locator, visibility });
    await expect(adapter.inspect(locator))
      .rejects.toBeInstanceOf(TerminalHostBindingMismatchError);
    await expect(adapter.terminate({ ...locator, instanceId: "other-hive" }, {
      mode: "immediate",
      target: "process-tree",
      deadline: "2026-07-18T01:00:01.000Z",
      idempotencyKey: "terminate-idempotency",
    })).rejects.toBeInstanceOf(TerminalHostBindingNotFoundError);
  });
});
