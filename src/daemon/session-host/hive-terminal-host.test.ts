import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  TerminalHostBindingIncompleteError,
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
  completeness: "complete",
  host: { processId: 3_900, startToken: "3900:123400" },
  child: { processId: 4_000, startToken: "4000:123400" },
  jobControl: {
    sessionLeader: true,
    controllingTerminal: true,
    standardStreamsShareTerminal: true,
    childSessionId: 4_000,
    childProcessGroupId: 4_000,
    foregroundProcessGroupId: 4_000,
    terminalIdentity: "terminal-fixture",
    initialProfileAppliedBeforeExec: true,
    initialWindowAppliedBeforeExec: true,
    completeness: "complete",
  },
  window: {
    value: { columns: 80, rows: 24, widthPixels: 810, heightPixels: 500 },
    revision: "0",
  },
  output: { closed: false, retained: { start: "0", endExclusive: "19" } },
  checkpoints: {
    retained: 1,
    newest: {
      contentType: "application/vnd.hive.terminal-checkpoint",
      schemaVersion: "1",
      hashAlgorithm: "sha256",
      hash: "b".repeat(64),
      throughEventSequence: "2",
      throughOutputOffset: "19",
      opaqueBytes: new Uint8Array([1, 2, 3]),
    },
  },
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
    const existing = this.getTerminalHostBindingByLocator(binding.locator);
    if (existing !== null) return existing;
    this.values.push(binding);
    return binding;
  }

  completeTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
    createEvidence: NonNullable<HiveTerminalBinding["createEvidence"]>,
  ): HiveTerminalBinding {
    const index = this.values.findIndex((binding) =>
      binding.locator.sessionId === locator.sessionId
    );
    if (index < 0) throw new Error("missing binding");
    const completed = { ...this.values[index]!, createEvidence };
    this.values[index] = completed;
    return completed;
  }

  renewTerminalHostVisibility(
    locator: HiveTerminalBinding["locator"],
    visibility: HiveTerminalBinding["visibility"],
    lease: Parameters<TerminalHostBindingStore["renewTerminalHostVisibility"]>[2],
  ): HiveTerminalBinding {
    const index = this.values.findIndex((binding) =>
      binding.locator.sessionId === locator.sessionId
    );
    if (index < 0 || this.values[index]!.createEvidence === undefined) {
      throw new Error("missing completed binding");
    }
    const renewed = {
      ...this.values[index]!,
      visibility,
      createEvidence: {
        ...this.values[index]!.createEvidence!,
        visibility: {
          state: "visible" as const,
          workspaceSessionId: visibility.workspaceSessionId,
          openTerminalRevision: lease.openTerminalRevision,
          expiresAt: lease.expiresAt,
        },
      },
    };
    this.values[index] = renewed;
    return renewed;
  }

  recordTerminalHostTermination(
    locator: HiveTerminalBinding["locator"],
    terminationAudit: NonNullable<HiveTerminalBinding["terminationAudit"]>,
  ): HiveTerminalBinding {
    const index = this.values.findIndex((binding) =>
      binding.locator.sessionId === locator.sessionId
    );
    if (index < 0) throw new Error("missing binding");
    const recorded = { ...this.values[index]!, terminationAudit };
    this.values[index] = recorded;
    return recorded;
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
  const renewVisibility = async (
    requestedLocator: typeof locator,
    request: typeof visibility,
  ) => ({
    locator: requestedLocator,
    state: "active" as const,
    expiresAt: "2026-07-18T01:00:15.000Z",
    openTerminalRevision: request.openTerminalRevision,
  });

  test("projects bound neutral lifecycle evidence into the product contract", async () => {
    const bindings = new MemoryBindings();
    const unbound = { ...inspection, session: { key: "other", incarnation: "1" } };
    const terminateRequests: unknown[] = [];
    const directRequests: unknown[] = [];
    const host = {
      renewVisibility,
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
    const adapter = new HiveTerminalHostAdapter(
      host,
      bindings,
      locator.instanceId,
      { now: () => new Date("2026-07-18T01:00:00.000Z") },
    );

    await expect(adapter.create(
      sessionSpec,
      new Uint8Array(),
      { locator, visibility },
    ))
      .resolves.toEqual(createResult);
    const createEvidence = {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedProviderRoot: createResult.inspection.providerRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    };
    expect(bindings.values).toEqual([{ locator, visibility, createEvidence }]);
    const projectedInspection = {
      schemaVersion: 1 as const,
      locator,
      presence: "present" as const,
      complete: false,
      hostPid: 3_900,
      hostStartToken: "3900:123400",
      providerRoot: {
        pid: 4_000,
        startToken: "4000:123400",
        processGroupId: 4_000,
      },
      expectedExecutable: "/bin/sh",
      executableVerified: true,
      outputSeq: "19",
      checkpointSeq: "2",
      checkpointAvailable: true,
      input: { state: "FREE" as const, ownerViewerId: null, claimId: null },
      viewerCount: 0,
      geometry: { ...geometry, widthPx: 810, heightPx: 500 },
      resources: {},
      visibility: createResult.inspection.visibility,
      exit: null,
      survivors: [],
      evidenceAt: inspection.evidenceAt,
      diagnosticIds: [
        "SESSIOND_VIEWER_COUNT_UNAVAILABLE",
        "SESSIOND_RESOURCES_UNAVAILABLE",
      ],
    };
    await expect(adapter.list(locator.instanceId)).resolves.toEqual([
      projectedInspection,
    ]);
    await expect(adapter.list("other-hive")).resolves.toEqual([]);
    await expect(adapter.inspect(locator)).resolves.toEqual(projectedInspection);
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
    const requestId = "req_018f1e90-7b5a-7cc0-8000-000000000103";
    await expect(adapter.terminate(locator, {
      mode: "immediate",
      reason: "stop fixture",
      requestId,
    })).resolves.toEqual({
      locator,
      state: "terminated",
      exit: null,
      survivors: [],
      errors: [],
    });
    expect(terminateRequests).toEqual([{
      session,
      mode: "immediate",
      target: "process-tree",
      deadline: "2026-07-18T01:00:10.000Z",
      idempotencyKey: createHash("sha256")
        .update("hive-sessiond-terminate-v1\0")
        .update(requestId)
        .update("\0")
        .update(session.key)
        .update("\0")
        .update(session.incarnation)
        .digest("hex"),
    }]);
    expect(bindings.values[0]?.terminationAudit).toEqual({
      reason: "stop fixture",
      requestId,
      requestedAt: "2026-07-18T01:00:00.000Z",
    });
  });

  test("follows a bounded LIST ref with INSPECT for the real checkpoint cursor", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedProviderRoot: createResult.inspection.providerRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const inspectedSessions: SessionRef[] = [];
    const host = {
      renewVisibility,
      create: async () => createResult,
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
      list: async () => [{
        ...inspection,
        checkpoints: { retained: 1, newest: null },
        diagnostics: ["checkpoint-body-omitted-from-bounded-list"],
      }],
      inspect: async (requested: SessionRef) => {
        inspectedSessions.push(requested);
        return inspection;
      },
      terminate: async () => termination,
    };
    const adapter = new HiveTerminalHostAdapter(host, bindings, locator.instanceId);

    const listed = await adapter.list(locator.instanceId);
    expect(inspectedSessions).toEqual([session]);
    expect(listed[0]).toEqual(expect.objectContaining({
      checkpointSeq: "2",
      checkpointAvailable: true,
    }));
    expect(listed[0]?.diagnosticIds).not.toContain(
      "checkpoint-body-omitted-from-bounded-list",
    );
  });

  test("derives positive pixels and downgrades stale lifecycle evidence", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedProviderRoot: createResult.inspection.providerRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const stale = {
      ...inspection,
      child: { processId: 4_001, startToken: "4001:123400" },
      window: {
        ...inspection.window,
        value: {
          ...inspection.window.value,
          widthPixels: 0,
          heightPixels: 0,
        },
      },
    };
    const host = {
      renewVisibility,
      create: async () => createResult,
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
      list: async () => [stale],
      inspect: async () => stale,
      terminate: async () => ({
        ...termination,
        state: "unknown" as const,
        reap: { ...termination.reap, reaped: false, completeness: "partial" as const },
        completeness: "partial" as const,
        diagnostics: ["native-termination-partial"],
      }),
    };
    const adapter = new HiveTerminalHostAdapter(
      host,
      bindings,
      locator.instanceId,
      { now: () => new Date("2026-07-18T01:00:00.000Z") },
    );

    const inspected = await adapter.inspect(locator);
    expect(inspected.executableVerified).toBe(false);
    expect(inspected.geometry).toEqual(geometry);
    expect(inspected.diagnosticIds).toContain(
      "SESSIOND_PIXEL_GEOMETRY_DERIVED_NO_VIEWER",
    );
    expect(inspected.diagnosticIds).toContain("SESSIOND_EXECUTABLE_EVIDENCE_STALE");
    await expect(adapter.terminate(locator, {
      mode: "immediate",
      reason: "stop stale fixture",
      requestId: "req_018f1e90-7b5a-7cc0-8000-000000000105",
    })).resolves.toEqual({
      locator,
      state: "unknown",
      exit: null,
      survivors: [],
      errors: [
        {
          phase: "neutral-control",
          code: "UNKNOWN",
          diagnosticId: "native-termination-partial",
        },
        {
          phase: "neutral-control",
          code: "UNKNOWN",
          diagnosticId: "SESSIOND_TERMINATION_INCOMPLETE",
        },
      ],
    });
  });

  test("fails closed for missing, foreign, or mismatched bindings", async () => {
    const bindings = new MemoryBindings();
    const host = {
      renewVisibility,
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
      reason: "stop fixture",
      requestId: "req_018f1e90-7b5a-7cc0-8000-000000000104",
    })).rejects.toBeInstanceOf(TerminalHostBindingNotFoundError);

    const incompleteHost = { ...host, inspect: async () => inspection };
    const incompleteBindings = new MemoryBindings();
    incompleteBindings.bindTerminalHostSession({ locator, visibility });
    const incomplete = new HiveTerminalHostAdapter(
      incompleteHost,
      incompleteBindings,
      locator.instanceId,
    );
    await expect(incomplete.inspect(locator))
      .rejects.toBeInstanceOf(TerminalHostBindingIncompleteError);
  });
});
