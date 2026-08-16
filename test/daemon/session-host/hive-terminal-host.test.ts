import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { macProcessIdentity } from "../../../src/daemon/lifecycle/daemon-lifecycle";
import {
  HiveTerminalHostAdapter,
  requireSessiondRootLocator,
  TerminalHostBindingIncompleteError,
  TerminalHostBindingMismatchError,
  TerminalHostBindingNotFoundError,
} from "../../../src/daemon/session-host/hive-terminal-host";
import type {
  CreateResult,
  SessionSpec,
} from "../../../src/daemon/session-host/session-host-contract";
import type {
  HiveTerminalBinding,
  TerminalHostBindingStore,
} from "../../../src/daemon/session-host/terminal-host-binding";
import type {
  SessionInspection,
  SessionRef,
  TerminationResult,
} from "../../../src/daemon/session-host/terminal-host-contract";
import type { ProviderRun } from "../../../src/schemas/provider-run";
import { required } from "../../required";
import { PROCESS_TABLE_VISIBLE_MS, waitUntil } from "../../support/wait-until";

async function processGroupStates(
  processGroupId: number,
): Promise<Array<{ pid: number; state: string }>> {
  const child = Bun.spawn(["ps", "-axo", "pid=,pgid=,stat="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => Number(fields[1]) === processGroupId)
    .map((fields) => ({
      pid: Number(fields[0]),
      state: fields[2] ?? "",
    }));
}

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
const providerRuns = {
  getActiveProviderRunByTerminal: () => null,
  endProviderRun: () => null,
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
  argv: ["/bin/zsh", "-c", "read line"],
  environment: {},
  expectedExecutable: "/bin/zsh",
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
    shellRoot: {
      pid: 4_000,
      startToken: "4000:123400",
      processGroupId: 4_000,
    },
    foreground: { state: "unknown", runId: null },
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

  releaseUncreatedTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
  ): boolean {
    const index = this.values.findIndex(
      (binding) =>
        binding.locator.instanceId === locator.instanceId &&
        binding.locator.sessionId === locator.sessionId &&
        binding.locator.generation === locator.generation &&
        binding.createEvidence === undefined &&
        binding.terminationAudit === undefined &&
        binding.terminationEvidence === undefined,
    );
    if (index < 0) return false;
    this.values.splice(index, 1);
    return true;
  }

  completeTerminalHostSession(
    locator: HiveTerminalBinding["locator"],
    createEvidence: NonNullable<HiveTerminalBinding["createEvidence"]>,
  ): HiveTerminalBinding {
    const index = this.values.findIndex(
      (binding) => binding.locator.sessionId === locator.sessionId,
    );
    if (index < 0) throw new Error("missing binding");
    const completed = { ...required(this.values[index]), createEvidence };
    this.values[index] = completed;
    return completed;
  }

  renewTerminalHostVisibility(
    locator: HiveTerminalBinding["locator"],
    visibility: HiveTerminalBinding["visibility"],
    lease: Parameters<
      TerminalHostBindingStore["renewTerminalHostVisibility"]
    >[2],
  ): HiveTerminalBinding {
    const index = this.values.findIndex(
      (binding) => binding.locator.sessionId === locator.sessionId,
    );
    if (index < 0 || this.values[index]?.createEvidence === undefined) {
      throw new Error("missing completed binding");
    }
    const renewed = {
      ...required(this.values[index]),
      visibility,
      createEvidence: {
        ...required(this.values[index]?.createEvidence),
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
    const index = this.values.findIndex(
      (binding) => binding.locator.sessionId === locator.sessionId,
    );
    if (index < 0) throw new Error("missing binding");
    const recorded = { ...required(this.values[index]), terminationAudit };
    this.values[index] = recorded;
    return recorded;
  }

  recordTerminalHostTerminationEvidence(
    locator: HiveTerminalBinding["locator"],
    terminationEvidence: NonNullable<
      HiveTerminalBinding["terminationEvidence"]
    >,
  ): HiveTerminalBinding {
    const index = this.values.findIndex(
      (binding) => binding.locator.sessionId === locator.sessionId,
    );
    if (index < 0) throw new Error("missing binding");
    const recorded = { ...required(this.values[index]), terminationEvidence };
    this.values[index] = recorded;
    return recorded;
  }

  getTerminalHostBindingByLocator(
    value: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding | null {
    return (
      this.values.find(
        (binding) =>
          binding.locator.instanceId === value.instanceId &&
          binding.locator.sessionId === value.sessionId &&
          binding.locator.generation === value.generation,
      ) ?? null
    );
  }

  listTerminalHostBindings(instanceId: string): readonly HiveTerminalBinding[] {
    return this.values.filter(
      (binding) => binding.locator.instanceId === instanceId,
    );
  }
}

describe("HiveTerminalHostAdapter", () => {
  test("projects bound neutral lifecycle evidence into the product contract", async () => {
    const bindings = new MemoryBindings();
    const unbound = {
      ...inspection,
      session: { key: "other", incarnation: "1" },
    };
    const terminateRequests: unknown[] = [];
    const directRequests: unknown[] = [];
    const renewalRequests: unknown[] = [];
    const host = {
      waitForHostExit: async () => ({ kind: "inherited" as const }),
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },

      create: async (spec: SessionSpec) => {
        expect(spec).toEqual(sessionSpec);
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
      {
        now: () => new Date("2026-07-18T01:00:00.000Z"),
        providerRuns,
      },
    );

    await expect(
      adapter.create(sessionSpec, { locator, visibility }),
    ).resolves.toEqual(createResult);
    // Create binds the terminal to a workspace session and nothing more. It
    // does not renew, because there is no lease to keep alive: the host
    // observes its own supervisor and lives until something stops it.
    expect(renewalRequests).toEqual([]);
    const createEvidence = {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: {
        state: "attaching" as const,
        workspaceSessionId: visibility.workspaceSessionId,
        openTerminalRevision: "1",
        expiresAt: "2026-07-18T01:00:15.000Z",
      },
    };
    expect(bindings.values).toEqual([{ locator, visibility, createEvidence }]);
    const projectedInspection = {
      schemaVersion: 1 as const,
      locator,
      presence: "present" as const,
      complete: false,
      hostPid: 3_900,
      hostStartToken: "3900:123400",
      shellRoot: {
        pid: 4_000,
        startToken: "4000:123400",
        processGroupId: 4_000,
      },
      foreground: { state: "shell-idle" as const, runId: null },
      expectedExecutable: "/bin/zsh",
      executableVerified: true,
      outputSeq: "19",
      checkpointSeq: "2",
      checkpointAvailable: true,
      input: { state: "FREE" as const, ownerViewerId: null, claimId: null },
      viewerCount: 0,
      geometry: { ...geometry, widthPx: 810, heightPx: 500 },
      resources: {},
      visibility: createEvidence.visibility,
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
    await expect(adapter.inspect(locator)).resolves.toEqual(
      projectedInspection,
    );
    await adapter.claimInput(locator, {
      writer: "writer-fixture",
      kind: "automation",
      leaseMilliseconds: 1_000,
      idempotencyKey: "claim-idempotency",
    });
    await adapter.submitInput(locator, {
      provenance: "automation",
      action: "keys",
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
        provenance: "automation",
        action: "keys",
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
    await expect(
      adapter.terminate(locator, {
        mode: "immediate",
        reason: "stop fixture",
        requestId,
      }),
    ).resolves.toEqual({
      locator,
      state: "terminated",
      exit: null,
      survivors: [],
      errors: [],
    });
    expect(terminateRequests).toEqual([
      {
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
      },
    ]);
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
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const inspectedSessions: SessionRef[] = [];
    const host = {
      waitForHostExit: async () => ({ kind: "inherited" as const }),
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },
      create: async () => createResult,
      claimInput: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
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
      resize: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
      list: async () => [
        {
          ...inspection,
          checkpoints: { retained: 1, newest: null },
          diagnostics: ["checkpoint-body-omitted-from-bounded-list"],
        },
      ],
      inspect: async (requested: SessionRef) => {
        inspectedSessions.push(requested);
        return inspection;
      },
      terminate: async () => termination,
    };
    const adapter = new HiveTerminalHostAdapter(
      host,
      bindings,
      locator.instanceId,
      { providerRuns },
    );

    const listed = await adapter.list(locator.instanceId);
    expect(inspectedSessions).toEqual([session]);
    expect(listed[0]).toEqual(
      expect.objectContaining({
        checkpointSeq: "2",
        checkpointAvailable: true,
      }),
    );
    expect(listed[0]?.diagnosticIds).not.toContain(
      "checkpoint-body-omitted-from-bounded-list",
    );
  });

  test("projects terminal foreground without treating it as provider identity", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const run: ProviderRun = {
      runId: "018f1e90-7b5a-7cc0-8000-000000000200",
      agentId: "agent-fixture",
      terminal: locator,
      provider: "codex",
      model: "gpt-fixture",
      effort: null,
      conversationId: null,
      adapterChild: {
        pid: 4_100,
        startToken: "4100:original",
        processGroupId: 4_100,
        observedAt: "2026-07-18T01:00:00.000Z",
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "launch-grant-fixture",
      startedAt: "2026-07-18T01:00:00.000Z",
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    const observed = {
      ...inspection,
      jobControl: {
        ...required(inspection.jobControl),
        foregroundProcessGroupId: required(run.adapterChild).processGroupId,
      },
    };
    const adapter = new HiveTerminalHostAdapter(
      {
        waitForHostExit: async () => ({ kind: "inherited" as const }),
        issueAttach: async () => {
          throw new Error("issueAttach not under test");
        },
        create: async () => createResult,
        claimInput: async () => ({
          state: "unknown" as const,
          diagnostic: "fixture",
        }),
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
        resize: async () => ({
          state: "unknown" as const,
          diagnostic: "fixture",
        }),
        list: async () => [observed],
        inspect: async () => observed,
        terminate: async () => termination,
      },
      bindings,
      locator.instanceId,
      {
        processIdentity: () => ({ startToken: "4100:recycled" }),
        providerRuns: {
          getActiveProviderRunByTerminal: () => run,
          endProviderRun: () => null,
        },
      },
    );

    expect((await adapter.inspect(locator)).foreground).toEqual({
      state: "unmanaged",
      runId: null,
      pid: 4_100,
      startToken: "4100:recycled",
      foregroundProcessGroupId: 4_100,
    });
  });

  test("projects the sessiond process census and input owner for Live Run controls", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const observed = {
      ...inspection,
      inputOwner: {
        token: "input-token",
        writer: "workspace-fixture",
        kind: "user" as const,
        leaseExpiresAt: "2026-07-18T01:00:15.000Z",
      },
      descendants: [
        { processId: 4_100, startToken: "4100:123400" },
        { processId: 4_200, startToken: "4200:123400" },
      ],
    };
    const adapter = new HiveTerminalHostAdapter(
      {
        waitForHostExit: async () => ({ kind: "inherited" as const }),
        issueAttach: async () => {
          throw new Error("issueAttach not under test");
        },
        create: async () => createResult,
        claimInput: async () => ({
          state: "unknown" as const,
          diagnostic: "fixture",
        }),
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
        resize: async () => ({
          state: "unknown" as const,
          diagnostic: "fixture",
        }),
        list: async () => [observed],
        inspect: async () => observed,
        terminate: async () => termination,
      },
      bindings,
      locator.instanceId,
      { providerRuns },
    );

    await expect(adapter.inspectControl(locator)).resolves.toMatchObject({
      terminal: {
        shellRoot: createResult.inspection.shellRoot,
      },
      processCensus: {
        completeness: "complete",
        members: [
          { pid: 4_000, startToken: "4000:123400" },
          { pid: 4_100, startToken: "4100:123400" },
          { pid: 4_200, startToken: "4200:123400" },
        ],
      },
      inputOwner: {
        writer: "workspace-fixture",
        kind: "user",
      },
      foregroundProcessGroupId: 4_000,
    });
  });

  test("derives positive pixels and downgrades stale lifecycle evidence", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
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
      waitForHostExit: async () => ({ kind: "inherited" as const }),
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },
      create: async () => createResult,
      claimInput: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
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
      resize: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
      list: async () => [stale],
      inspect: async () => stale,
      terminate: async () => ({
        ...termination,
        state: "unknown" as const,
        reap: {
          ...termination.reap,
          reaped: false,
          completeness: "partial" as const,
        },
        completeness: "partial" as const,
        diagnostics: ["native-termination-partial"],
      }),
    };
    const adapter = new HiveTerminalHostAdapter(
      host,
      bindings,
      locator.instanceId,
      {
        now: () => new Date("2026-07-18T01:00:00.000Z"),
        providerRuns,
      },
    );

    const inspected = await adapter.inspect(locator);
    expect(inspected.executableVerified).toBe(false);
    expect(inspected.geometry).toEqual(geometry);
    expect(inspected.diagnosticIds).toContain(
      "SESSIOND_PIXEL_GEOMETRY_DERIVED_NO_VIEWER",
    );
    expect(inspected.diagnosticIds).toContain(
      "SESSIOND_EXECUTABLE_EVIDENCE_STALE",
    );
    await expect(
      adapter.terminate(locator, {
        mode: "immediate",
        reason: "stop stale fixture",
        requestId: "req_018f1e90-7b5a-7cc0-8000-000000000105",
      }),
    ).resolves.toEqual({
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

  test("reports a terminated process tree as closed before its host is reaped", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const host = {
      waitForHostExit: async () => ({ kind: "inherited" as const }),
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },
      create: async () => createResult,
      claimInput: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
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
      resize: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
      list: async () => [inspection],
      inspect: async () => inspection,
      terminate: async () => ({
        ...termination,
        reap: {
          ...termination.reap,
          reaped: false,
        },
      }),
    };
    const adapter = new HiveTerminalHostAdapter(
      host,
      bindings,
      locator.instanceId,
      { providerRuns },
    );

    await expect(
      adapter.terminate(locator, {
        mode: "immediate",
        reason: "stop fixture",
        requestId: "req_018f1e90-7b5a-7cc0-8000-000000000106",
      }),
    ).resolves.toEqual({
      locator,
      state: "terminated",
      exit: null,
      survivors: [],
      errors: [
        {
          phase: "neutral-control",
          code: "UNKNOWN",
          diagnosticId: "SESSIOND_TERMINATION_UNREAPED",
        },
      ],
    });
    expect(
      bindings.getTerminalHostBindingByLocator(locator)?.terminationEvidence,
    ).toEqual({
      completedAt: expect.any(String),
      result: {
        locator,
        state: "terminated",
        exit: null,
        survivors: [],
        errors: [
          {
            phase: "neutral-control",
            code: "UNKNOWN",
            diagnosticId: "SESSIOND_TERMINATION_UNREAPED",
          },
        ],
      },
    });
  });

  test("pauses, resumes, and stops only the freshly verified provider group while zsh survives", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const run: ProviderRun = {
      runId: "018f1e90-7b5a-7cc0-8000-000000000201",
      agentId: "agent-fixture",
      terminal: locator,
      provider: "codex",
      model: "gpt-fixture",
      effort: null,
      conversationId: null,
      adapterChild: {
        pid: 4_100,
        startToken: "4100:123400",
        processGroupId: 4_100,
        observedAt: "2026-07-18T01:00:00.000Z",
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "launch-grant-fixture",
      startedAt: "2026-07-18T01:00:00.000Z",
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    let active: ProviderRun | null = run;
    let state: "running" | "stopped" | "gone" = "running";
    let foregroundProcessGroupId = required(run.adapterChild).processGroupId;
    const signals: Array<[number, string]> = [];
    const host = {
      waitForHostExit: async () => ({ kind: "inherited" as const }),
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },
      create: async () => createResult,
      claimInput: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
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
      resize: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
      list: async () => [
        {
          ...inspection,
          jobControl: {
            ...required(inspection.jobControl),
            foregroundProcessGroupId,
          },
        },
      ],
      inspect: async () => ({
        ...inspection,
        jobControl: {
          ...required(inspection.jobControl),
          foregroundProcessGroupId,
        },
      }),
      terminate: async () => termination,
    };
    const adapter = new HiveTerminalHostAdapter(
      host,
      bindings,
      locator.instanceId,
      {
        now: () => new Date("2026-07-18T01:00:01.000Z"),
        processIdentity: (pid) => ({
          startToken:
            pid === required(run.adapterChild).pid
              ? required(run.adapterChild).startToken
              : required(inspection.child).startToken,
        }),
        processState: async () => state,
        processGroupState: () => (state === "gone" ? "gone" : "running"),
        signalProcessGroup: (processGroupId, signal) => {
          signals.push([processGroupId, signal]);
          if (signal === "SIGSTOP") state = "stopped";
          if (signal === "SIGCONT") state = "running";
          if (signal === "SIGTERM") {
            state = "gone";
            foregroundProcessGroupId = required(
              inspection.jobControl,
            ).childProcessGroupId;
          }
        },
        sleep: async () => undefined,
        providerRuns: {
          getActiveProviderRunByTerminal: () => active,
          endProviderRun: (runId, endedAt, exitReason) => {
            if (active?.runId !== runId) return active;
            active = {
              ...active,
              state: "exited",
              endedAt,
              exitReason,
            };
            return active;
          },
        },
      },
    );

    expect(await adapter.pauseProvider(locator, run)).toBe(true);
    expect(await adapter.resumeProvider(locator, run)).toBe(true);
    expect(await adapter.stopProvider(locator, run)).toBe(true);
    expect(signals).toEqual([
      [4_100, "SIGSTOP"],
      [4_100, "SIGCONT"],
      [4_100, "SIGTERM"],
    ]);
    expect(active).toMatchObject({
      state: "exited",
      exitReason: "provider-stopped",
    });
    const after = await adapter.inspect(locator);
    expect(after.presence).toBe("present");
    expect(after.shellRoot).toEqual(createResult.inspection.shellRoot);
    expect(after.foreground).toEqual({ state: "shell-idle", runId: null });
  });

  test("does not signal a stale reported identity", async () => {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const run: ProviderRun = {
      runId: "018f1e90-7b5a-7cc0-8000-000000000202",
      agentId: "agent-fixture",
      terminal: locator,
      provider: "codex",
      model: "gpt-fixture",
      effort: null,
      conversationId: null,
      adapterChild: {
        pid: 4_100,
        startToken: "4100:123400",
        processGroupId: 4_100,
        observedAt: "2026-07-18T01:00:00.000Z",
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "launch-grant-fixture",
      startedAt: "2026-07-18T01:00:00.000Z",
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    const signals: string[] = [];
    const adapter = new HiveTerminalHostAdapter(
      {
        waitForHostExit: async () => ({ kind: "inherited" as const }),
        issueAttach: async () => {
          throw new Error("issueAttach not under test");
        },
        create: async () => createResult,
        claimInput: async () => ({
          state: "unknown" as const,
          diagnostic: "fixture",
        }),
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
        resize: async () => ({
          state: "unknown" as const,
          diagnostic: "fixture",
        }),
        list: async () => [
          {
            ...inspection,
            jobControl: {
              ...required(inspection.jobControl),
              foregroundProcessGroupId: required(run.adapterChild)
                .processGroupId,
            },
          },
        ],
        inspect: async () => ({
          ...inspection,
          jobControl: {
            ...required(inspection.jobControl),
            foregroundProcessGroupId: required(run.adapterChild).processGroupId,
          },
        }),
        terminate: async () => termination,
      },
      bindings,
      locator.instanceId,
      {
        processIdentity: (pid) => {
          if (pid !== required(run.adapterChild).pid)
            return { startToken: "4000:123400" };
          return { startToken: "4100:recycled" };
        },
        processState: async () => "running",
        processGroupState: () => "running",
        signalProcessGroup: (_processGroupId, signal) => signals.push(signal),
        sleep: async () => undefined,
        providerRuns: {
          getActiveProviderRunByTerminal: () => run,
          endProviderRun: () => null,
        },
      },
    );

    expect(await adapter.pauseProvider(locator, run)).toBe(false);
    expect(signals).toEqual([]);
  });

  test("the production signal path suspends and resumes a real process group", async () => {
    const child = spawn("/bin/zsh", ["-c", "sleep 3600 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = required(child.pid);
    try {
      process.kill(-pid, 0);
      const identity = macProcessIdentity(pid);
      const bindings = new MemoryBindings();
      bindings.bindTerminalHostSession({ locator, visibility });
      bindings.completeTerminalHostSession(locator, {
        expectedExecutable: sessionSpec.expectedExecutable,
        executableVerified: true,
        verifiedShellRoot: createResult.inspection.shellRoot,
        geometry,
        visibility: createResult.inspection.visibility,
      });
      const run: ProviderRun = {
        runId: "018f1e90-7b5a-7cc0-8000-000000000203",
        agentId: "agent-fixture",
        terminal: locator,
        provider: "codex",
        model: "gpt-fixture",
        effort: null,
        conversationId: null,
        adapterChild: {
          pid,
          startToken: identity.startToken,
          processGroupId: pid,
          observedAt: "2026-07-18T01:00:00.000Z",
        },
        protocolReceipt: null,
        capabilityEpoch: 0,
        launchGrantId: "launch-grant-fixture",
        startedAt: "2026-07-18T01:00:00.000Z",
        endedAt: null,
        state: "running",
        exitReason: null,
      };
      const observed = () => ({
        ...inspection,
        jobControl: {
          ...required(inspection.jobControl),
          foregroundProcessGroupId: pid,
        },
      });
      const adapter = new HiveTerminalHostAdapter(
        {
          waitForHostExit: async () => ({ kind: "inherited" as const }),
          issueAttach: async () => {
            throw new Error("issueAttach not under test");
          },
          create: async () => createResult,
          claimInput: async () => ({
            state: "unknown" as const,
            diagnostic: "fixture",
          }),
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
          resize: async () => ({
            state: "unknown" as const,
            diagnostic: "fixture",
          }),
          list: async () => [observed()],
          inspect: async () => observed(),
          terminate: async () => termination,
        },
        bindings,
        locator.instanceId,
        {
          providerRuns: {
            getActiveProviderRunByTerminal: () => run,
            endProviderRun: () => null,
          },
        },
      );

      await waitUntil(
        async () =>
          (await processGroupStates(pid)).some((member) => member.pid !== pid),
        {
          deadlineMs: PROCESS_TABLE_VISIBLE_MS,
          label: `process group ${pid} to contain a forked child`,
        },
      );
      expect(await adapter.pauseProvider(locator, run)).toBe(true);
      expect(macProcessIdentity(pid)).toEqual(identity);
      expect(
        (await processGroupStates(pid))
          .filter((member) => member.pid !== pid)
          .every((member) => member.state.startsWith("T")),
      ).toBe(true);
      expect(await adapter.resumeProvider(locator, run)).toBe(true);
      expect(macProcessIdentity(pid)).toEqual(identity);
      expect(
        (await processGroupStates(pid))
          .filter((member) => member.pid !== pid)
          .every((member) => !member.state.startsWith("T")),
      ).toBe(true);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  });

  test("fails closed for missing, foreign, or mismatched bindings", async () => {
    const bindings = new MemoryBindings();
    const host = {
      waitForHostExit: async () => ({ kind: "inherited" as const }),
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },
      create: async () => ({
        ...createResult,
        locator: {
          ...locator,
          sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000199",
        },
      }),
      claimInput: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
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
      resize: async () => ({
        state: "unknown" as const,
        diagnostic: "fixture",
      }),
      list: async () => [inspection],
      inspect: async () => ({
        ...inspection,
        session: { ...session, incarnation: "wrong-incarnation" },
      }),
      terminate: async () => termination,
    };
    const adapter = new HiveTerminalHostAdapter(
      host,
      bindings,
      locator.instanceId,
      { providerRuns },
    );

    await expect(
      adapter.create(sessionSpec, { locator, visibility }),
    ).rejects.toBeInstanceOf(TerminalHostBindingMismatchError);
    bindings.values.length = 0;
    await expect(adapter.inspect(locator)).rejects.toBeInstanceOf(
      TerminalHostBindingNotFoundError,
    );
    bindings.bindTerminalHostSession({ locator, visibility });
    await expect(adapter.inspect(locator)).rejects.toBeInstanceOf(
      TerminalHostBindingMismatchError,
    );
    await expect(
      adapter.terminate(
        { ...locator, instanceId: "other-hive" },
        {
          mode: "immediate",
          reason: "stop fixture",
          requestId: "req_018f1e90-7b5a-7cc0-8000-000000000104",
        },
      ),
    ).rejects.toBeInstanceOf(TerminalHostBindingNotFoundError);

    const incompleteHost = { ...host, inspect: async () => inspection };
    const incompleteBindings = new MemoryBindings();
    incompleteBindings.bindTerminalHostSession({ locator, visibility });
    const incomplete = new HiveTerminalHostAdapter(
      incompleteHost,
      incompleteBindings,
      locator.instanceId,
      { providerRuns },
    );
    await expect(incomplete.inspect(locator)).rejects.toBeInstanceOf(
      TerminalHostBindingIncompleteError,
    );
  });
});

describe("closing a session whose host is already gone", () => {
  function adapterWithNoLiveHosts(options: {
    endedRuns: string[];
    activeRun?: ProviderRun;
  }): { adapter: HiveTerminalHostAdapter; bindings: MemoryBindings } {
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const adapter = new HiveTerminalHostAdapter(
      {
        waitForHostExit: async () => ({ kind: "inherited" as const }),
        issueAttach: async () => {
          throw new Error("issueAttach not under test");
        },
        create: async () => createResult,
        claimInput: async () => {
          throw new Error("claimInput not under test");
        },
        submitInput: async () => {
          throw new Error("submitInput not under test");
        },
        resize: async () => {
          throw new Error("resize not under test");
        },
        // The host is gone: nothing is listed for this session any more.
        list: async () => [],
        inspect: async () => {
          throw new Error("inspect not under test");
        },
        terminate: async () => {
          throw new Error("a departed host must never be asked to terminate");
        },
      },
      bindings,
      locator.instanceId,
      {
        providerRuns: {
          getActiveProviderRunByTerminal: () => options.activeRun ?? null,
          endProviderRun: (runId: string) => {
            options.endedRuns.push(runId);
            return null;
          },
        },
      },
    );
    return { adapter, bindings };
  }

  test("reports it terminated, so the close has a way to succeed", async () => {
    const endedRuns: string[] = [];
    const { adapter, bindings } = adapterWithNoLiveHosts({ endedRuns });

    const result = await adapter.terminate(locator, {
      reason: "queen closed the agent",
      requestId: "request-fixture",
      mode: "graceful",
    });

    // Before this, both close paths threw here, and an agent whose host had
    // departed could never be closed by any tool: the row stayed live forever,
    // holding a quota reservation and collecting undeliverable messages.
    expect(result.state).toBe("terminated");
    expect(result.survivors).toEqual([]);
    // No exit is invented — nobody watched this host leave.
    expect(result.exit).toBeNull();
    expect(result.errors.map((error) => error.diagnosticId)).toEqual([
      "SESSIOND_HOST_ALREADY_ABSENT",
    ]);
    // The close is still audited, so the record says who asked and why.
    expect(bindings.values[0]?.terminationAudit).toEqual(
      expect.objectContaining({
        reason: "queen closed the agent",
        requestId: "request-fixture",
      }),
    );
  });

  test("ends the provider run the departed host was carrying", async () => {
    const endedRuns: string[] = [];
    const run: ProviderRun = {
      runId: "018f1e90-7b5a-7cc0-8000-000000000900",
      agentId: "agent-fixture",
      terminal: locator,
      provider: "codex",
      model: "gpt-fixture",
      effort: null,
      conversationId: null,
      adapterChild: {
        pid: 4_100,
        startToken: "4100:original",
        processGroupId: 4_100,
        observedAt: "2026-07-18T01:00:00.000Z",
      },
      protocolReceipt: null,
      capabilityEpoch: 0,
      launchGrantId: "launch-grant-fixture",
      startedAt: "2026-07-18T01:00:00.000Z",
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    const { adapter } = adapterWithNoLiveHosts({ endedRuns, activeRun: run });

    await adapter.terminate(locator, {
      reason: "queen closed the agent",
      requestId: "request-fixture",
      mode: "graceful",
    });

    // A run left open would keep the agent looking busy after it is gone.
    expect(endedRuns).toEqual([run.runId]);
  });

  test("still refuses a locator this instance does not own", async () => {
    const endedRuns: string[] = [];
    const { adapter } = adapterWithNoLiveHosts({ endedRuns });

    // Absence excuses a missing host, never a missing claim of ownership.
    await expect(
      adapter.terminate(
        { ...locator, instanceId: "some-other-hive" },
        {
          reason: "queen closed the agent",
          requestId: "request-fixture",
          mode: "graceful",
        },
      ),
    ).rejects.toBeInstanceOf(TerminalHostBindingNotFoundError);
  });
});

describe("requireSessiondRootLocator", () => {
  test("accepts only a sessiond root subject", () => {
    const root = { ...locator, subject: { kind: "root" as const } };
    expect(requireSessiondRootLocator(root)).toEqual(root);
    expect(() => requireSessiondRootLocator(locator)).toThrow(
      "Queen has a mismatched",
    );
    expect(() =>
      requireSessiondRootLocator({ ...root, hostKind: "invalid" } as never),
    ).toThrow("Queen has a mismatched");
  });
});

// THE FAILURE IS A DATABASE ROW OUTLIVING ITS PROCESS, NOT A LEAKED PROCESS.
// Nothing survives here — the tree is fully reaped with an empty survivor list.
// What the platform cannot do is PROVE containment, so process_inspector reports
// `unknown` for a process-tree target by design. The old gate demanded an exact
// `terminated`, so it never ended the run and left the row at "running" forever.
// A stale "running" root row makes getActiveRootProviderRun report an ACTIVE
// root, and hive_run_bootstrap then binds to a dead run: a false accept, which
// is strictly worse than the refusal it replaces.
describe("a teardown the platform cannot positively prove still ends the run", () => {
  const activeRun: ProviderRun = {
    runId: "6f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
    agentId: "agent-fixture",
    terminal: locator,
    provider: "codex",
    model: "gpt-5",
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch: 0,
    launchGrantId: "launch-grant-fixture",
    startedAt: "2026-07-18T01:00:00.000Z",
    endedAt: null,
    state: "running",
    exitReason: null,
  };

  /** The row-J outcome: everything reaped, no survivors, escapees unprovable. */
  const rowJ: TerminationResult = {
    state: "unknown",
    exit: null,
    reap: {
      authority: "direct-parent",
      reaped: true,
      status: null,
      completeness: "complete",
    },
    survivors: [],
    completeness: "complete",
    diagnostics: ["process-tree-escapees-unaccounted"],
  };

  function adapterReturning(result: TerminationResult): {
    adapter: HiveTerminalHostAdapter;
    endedRuns: string[];
  } {
    const endedRuns: string[] = [];
    const bindings = new MemoryBindings();
    bindings.bindTerminalHostSession({ locator, visibility });
    bindings.completeTerminalHostSession(locator, {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
      geometry,
      visibility: createResult.inspection.visibility,
    });
    const adapter = new HiveTerminalHostAdapter(
      {
        waitForHostExit: async () => ({ kind: "inherited" as const }),
        issueAttach: async () => {
          throw new Error("issueAttach not under test");
        },
        create: async () => createResult,
        claimInput: async () => {
          throw new Error("claimInput not under test");
        },
        submitInput: async () => {
          throw new Error("submitInput not under test");
        },
        resize: async () => {
          throw new Error("resize not under test");
        },
        list: async () => [inspection],
        inspect: async () => inspection,
        terminate: async () => result,
      },
      bindings,
      locator.instanceId,
      {
        providerRuns: {
          getActiveProviderRunByTerminal: () => activeRun,
          endProviderRun: (runId: string) => {
            endedRuns.push(runId);
            return null;
          },
        },
      },
    );
    return { adapter, endedRuns };
  }

  test("the run is ended on the documented floor, so no 'running' row is left behind", async () => {
    const { adapter, endedRuns } = adapterReturning(rowJ);

    const projected = await adapter.terminate(locator, {
      reason: "stop agent agent-fixture",
      requestId: "request-fixture",
      mode: "immediate",
    });

    // The honest report is preserved: this is still not positive proof, and
    // nothing here promotes it to "terminated".
    expect(projected.state).toBe("unknown");
    expect(projected.survivors).toEqual([]);
    // The row is closed anyway, which is the whole point.
    expect(endedRuns).toEqual([activeRun.runId]);
  });

  // The loud fixture for the assertion above: an outcome that must NOT close the
  // row, proving the test can tell the two apart rather than closing every row.
  test("a survivor still leaves the run open", async () => {
    const { adapter, endedRuns } = adapterReturning({
      ...rowJ,
      state: "survivors",
      survivors: [
        {
          process: { processId: 4_100, startToken: "4100:123400" },
          reason: "still running",
        },
      ],
    });

    const projected = await adapter.terminate(locator, {
      reason: "stop agent agent-fixture",
      requestId: "request-fixture",
      mode: "immediate",
    });

    expect(projected.state).toBe("survivors");
    expect(endedRuns).toEqual([]);
  });
});
