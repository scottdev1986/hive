import { describe, expect, test } from "bun:test";
import type {
  SessionInspection,
  SessionRef,
  TerminationResult,
} from "./terminal-host-contract";
import type {
  CreateResult,
  SessionSpec,
} from "./contract";
import type {
  HiveTerminalBinding,
  TerminalHostBindingStore,
} from "./terminal-host-binding";
import {
  HiveTerminalHostAdapter,
  TerminalHostBindingMismatchError,
  TerminalHostBindingNotFoundError,
} from "./hive-terminal-host";

const session: SessionRef = {
  key: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
  incarnation: "incarnation-1",
};
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
const geometry = {
  columns: 80,
  rows: 24,
  widthPx: 800,
  heightPx: 480,
  cellWidthPx: 10,
  cellHeightPx: 20,
};
const sessionSpec: SessionSpec = {
  schemaVersion: 1,
  locator,
  provider: "codex",
  toolSessionId: null,
  cwd: "/tmp",
  argv: ["/bin/sh", "-c", "read line"],
  environment: {},
  expectedExecutable: "/bin/sh",
  readOnly: false,
  capabilityEpoch: 0,
  geometry,
  launchGrantId: "launch-grant-fixture",
  launchGrantRevision: 1,
};
const createResult: CreateResult = {
  locator,
  created: true,
  inspection: {
    schemaVersion: 1,
    locator,
    presence: "present",
    complete: true,
    hostPid: 3_900,
    hostStartToken: "3900:123400",
    providerRoot: { pid: 4_000, startToken: "4000:123400", processGroupId: 4_000 },
    expectedExecutable: sessionSpec.expectedExecutable,
    executableVerified: true,
    outputSeq: "0",
    checkpointSeq: "0",
    checkpointAvailable: false,
    input: { state: "FREE", ownerViewerId: null, claimId: null },
    viewerCount: 0,
    geometry,
    resources: {},
    visibility: {
      state: "attaching",
      workspaceSessionId: visibility.workspaceSessionId,
      openTerminalRevision: visibility.openTerminalRevision,
      expiresAt: "2026-07-18T01:00:15.000Z",
    },
    exit: null,
    survivors: [],
    evidenceAt: "2026-07-18T01:00:00.000Z",
    diagnosticIds: [],
  },
};
const inspection: SessionInspection = {
  session,
  lifecycle: "running",
  completeness: "partial",
  host: null,
  child: null,
  jobControl: null,
  window: {
    value: { columns: 80, rows: 24, widthPixels: 800, heightPixels: 480 },
    revision: "0",
  },
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

  getTerminalHostBindingByLocator(
    value: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding | null {
    return this.values.find((binding) =>
      binding.locator.instanceId === value.instanceId &&
      binding.locator.sessionId === value.sessionId &&
      binding.locator.generation === value.generation) ?? null;
  }

  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[] {
    return this.values.filter((binding) => binding.locator.instanceId === instanceId);
  }
}

describe("HiveTerminalHostAdapter", () => {
  test("binds create and maps lifecycle operations without leaking neutral inventory", async () => {
    const bindings = new MemoryBindings();
    const unbound = { ...inspection, session: { key: "other", incarnation: "1" } };
    const terminateRequests: unknown[] = [];
    const directRequests: unknown[] = [];
    const host = {
      create: async (spec: SessionSpec, input: Uint8Array) => {
        expect(spec).toEqual(sessionSpec);
        expect(input).toEqual(new Uint8Array());
        return createResult;
      },
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

    await expect(adapter.create(
      sessionSpec,
      new Uint8Array(),
      { locator, visibility },
    ))
      .resolves.toEqual(createResult);
    expect(bindings.values).toEqual([{ locator, visibility }]);
    await expect(adapter.list()).resolves.toEqual([{
      binding: { locator, visibility },
      inspection,
    }]);
    await expect(adapter.inspect(locator)).resolves.toEqual({
      binding: { locator, visibility },
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
      window: inspection.window.value,
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
        window: inspection.window.value,
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
        locator: { ...locator, sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000199" },
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
      list: async () => [inspection],
      inspect: async () => ({
        ...inspection,
        session: { ...session, incarnation: "wrong-incarnation" },
      }),
      terminate: async () => termination,
    };
    const adapter = new HiveTerminalHostAdapter(host, bindings, locator.instanceId);

    await expect(adapter.create(
      sessionSpec,
      new Uint8Array(),
      { locator, visibility },
    ))
      .rejects.toBeInstanceOf(TerminalHostBindingMismatchError);
    bindings.values.length = 0;
    await expect(adapter.inspect(locator))
      .rejects.toBeInstanceOf(TerminalHostBindingNotFoundError);
    bindings.bindTerminalHostSession({ locator, visibility });
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
