import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { macProcessIdentity } from "../../../src/daemon/lifecycle";
import type {
  CreateResult,
  SessionSpec,
} from "../../../src/daemon/session-host/contract";
import {
  HiveTerminalHostAdapter,
  requireSessiondRootLocator,
  TerminalHostBindingIncompleteError,
  TerminalHostBindingMismatchError,
  TerminalHostBindingNotFoundError,
} from "../../../src/daemon/session-host/hive-terminal-host";
import type {
  HiveTerminalBinding,
  TerminalHostBindingStore,
} from "../../../src/daemon/session-host/terminal-host-binding";
import type {
  SessionInspection,
  SessionRef,
  TerminationResult,
} from "../../../src/daemon/session-host/terminal-host-contract";
import type { ProviderRun } from "../../../src/schemas";
import { required } from "../../required";

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
        binding.terminationAudit === undefined,
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
    const unbound = {
      ...inspection,
      session: { key: "other", incarnation: "1" },
    };
    const terminateRequests: unknown[] = [];
    const directRequests: unknown[] = [];
    const host = {
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },

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
      {
        now: () => new Date("2026-07-18T01:00:00.000Z"),
        providerRuns,
      },
    );

    await expect(
      adapter.create(sessionSpec, new Uint8Array(), { locator, visibility }),
    ).resolves.toEqual(createResult);
    const createEvidence = {
      expectedExecutable: sessionSpec.expectedExecutable,
      executableVerified: true,
      verifiedShellRoot: createResult.inspection.shellRoot,
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
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },

      renewVisibility,
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
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },

      renewVisibility,
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
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },
      renewVisibility,
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
      pid: 4_100,
      startToken: "4100:123400",
      foregroundProcessGroupId: 4_100,
      capabilityEpoch: 0,
      launchGrantId: "launch-grant-fixture",
      startedAt: "2026-07-18T01:00:00.000Z",
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    let active: ProviderRun | null = run;
    let state: "running" | "stopped" | "gone" = "running";
    let foregroundProcessGroupId = run.foregroundProcessGroupId;
    const signals: Array<[number, string]> = [];
    const host = {
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },
      renewVisibility,
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
            pid === run.pid ? run.startToken : required(inspection.child).startToken,
        }),
        processState: async () => state,
        signalProcessGroup: (processGroupId, signal) => {
          signals.push([processGroupId, signal]);
          if (signal === "SIGSTOP") state = "stopped";
          if (signal === "SIGCONT") state = "running";
          if (signal === "SIGTERM") {
            state = "gone";
            foregroundProcessGroupId = required(inspection.jobControl)
              .childProcessGroupId;
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

  test("does not signal a recycled provider group after the immediate token re-read drifts", async () => {
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
      pid: 4_100,
      startToken: "4100:123400",
      foregroundProcessGroupId: 4_100,
      capabilityEpoch: 0,
      launchGrantId: "launch-grant-fixture",
      startedAt: "2026-07-18T01:00:00.000Z",
      endedAt: null,
      state: "running",
      exitReason: null,
    };
    let providerReads = 0;
    const signals: string[] = [];
    const adapter = new HiveTerminalHostAdapter(
      {
        issueAttach: async () => {
          throw new Error("issueAttach not under test");
        },
        renewVisibility,
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
              foregroundProcessGroupId: run.foregroundProcessGroupId,
            },
          },
        ],
        inspect: async () => ({
          ...inspection,
          jobControl: {
            ...required(inspection.jobControl),
            foregroundProcessGroupId: run.foregroundProcessGroupId,
          },
        }),
        terminate: async () => termination,
      },
      bindings,
      locator.instanceId,
      {
        processIdentity: (pid) => {
          if (pid !== run.pid) return { startToken: "4000:123400" };
          providerReads += 1;
          return {
            startToken:
              providerReads === 1 ? run.startToken : "4100:recycled",
          };
        },
        processState: async () => "running",
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
        pid,
        startToken: identity.startToken,
        foregroundProcessGroupId: pid,
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
          issueAttach: async () => {
            throw new Error("issueAttach not under test");
          },
          renewVisibility,
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

      for (
        let attempt = 0;
        attempt < 20 &&
        (await processGroupStates(pid)).every((member) => member.pid === pid);
        attempt += 1
      ) {
        await Bun.sleep(10);
      }
      expect(
        (await processGroupStates(pid)).some((member) => member.pid !== pid),
      ).toBe(true);
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
      issueAttach: async () => {
        throw new Error("issueAttach not under test");
      },

      renewVisibility,
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
      adapter.create(sessionSpec, new Uint8Array(), { locator, visibility }),
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
