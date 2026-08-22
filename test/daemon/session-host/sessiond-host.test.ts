import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../../src/daemon/database/hive-database";
import { executableBuildHash } from "../../../src/daemon/session-host/host-control";
import type {
  CaptureResult,
  SessionSpec,
} from "../../../src/daemon/session-host/session-host-contract";
import { HiveTerminalHostAdapter } from "../../../src/daemon/session-host/hive-terminal-host";
import { hostDirectory } from "../../../src/daemon/session-host/host-operations";
import {
  encodeSessiondFrame,
  type SessiondControlClient,
  type SessiondControlRequest,
  SessiondCreateAdmissionDisabledError,
  SessiondFrameDecoder,
  SessiondHost,
  SessiondProtocolError,
  SessiondWireNotReadyError,
} from "../../../src/daemon/session-host/sessiond-host";
import type {
  HostLaunchRequest,
  LaunchedHost,
} from "../../../src/daemon/session-host/host-launcher";
import type { TerminalHostBindingStore } from "../../../src/daemon/session-host/terminal-host-binding";
import type {
  CreateRequest,
  CreateResult,
  InputReceipt,
  ResizeResult,
  SessionInspection,
  SessionRef,
  TerminationResult,
} from "../../../src/daemon/session-host/terminal-host-contract";
import {
  CreateBeginPayloadSchema,
  FRAME_FLAGS,
  FRAME_HEADER,
  SessionSpecSchema,
} from "../../../src/schemas/session-protocol";
import { required } from "../../required";
import type { JsonValue } from "../../../src/shared/json";

const session: SessionRef = {
  key: "neutral-session-key",
  incarnation: "neutral-incarnation-1",
};

const createRequest: CreateRequest = {
  key: session.key,
  idempotencyKey: "create-idempotency-1",
  command: {
    executable: "/bin/sh",
    arguments: ["-c", "read line; printf '%s' \"$line\""],
    workingDirectory: "/tmp",
    completeEnvironment: [{ name: "PATH", value: "/usr/bin:/bin" }],
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
  initialWindow: {
    columns: 80,
    rows: 24,
    widthPixels: 800,
    heightPixels: 480,
  },
};

const createResult: CreateResult = {
  session,
  outcome: {
    state: "running",
    child: { processId: 4100, startToken: "4100:123456" },
    execProof: "replacement-observed",
    jobControl: {
      sessionLeader: true,
      controllingTerminal: true,
      standardStreamsShareTerminal: true,
      childSessionId: 4100,
      childProcessGroupId: 4100,
      foregroundProcessGroupId: 4100,
      terminalIdentity: "/dev/ttys001",
      initialProfileAppliedBeforeExec: true,
      initialWindowAppliedBeforeExec: true,
      completeness: "complete",
    },
  },
  limits: {
    maxInputTransactionBytes: 131_072,
    maxInputQueueBytes: 1_048_576,
    maxOutputFrameBytes: 65_536,
    outputLowWaterBytes: 4_194_304,
    outputHighWaterBytes: 8_388_608,
    outputRetentionBytes: 67_108_864,
  },
};

const brokerLocator = {
  schemaVersion: 1 as const,
  instanceId: "instance-fixture",
  subject: { kind: "agent" as const, agentId: "agent-fixture" },
  generation: 1,
  sessionId: "ses_01890f6a-7b1c-7abc-8def-0123456789ab",
  hostKind: "sessiond" as const,
  engineBuildId: "engine-build-fixture",
};
const brokerGeometry = {
  columns: 80,
  rows: 24,
  widthPx: 800,
  heightPx: 480,
  cellWidthPx: 10,
  cellHeightPx: 20,
};
const brokerVisibility = {
  workspaceSessionId: "workspace-session-fixture",
  workspacePid: 4_200,
  workspaceStartToken: "4200:123400",
  openTerminalRevision: "1",
};
const createBeginPayload = CreateBeginPayloadSchema.parse({
  schemaVersion: 1,
  locator: brokerLocator,
  provider: "codex",
  toolSessionId: null,
  cwd: "/tmp",
  argv: ["/bin/zsh", "-lc", "printf ready"],
  environment: { PATH: "/usr/bin:/bin" },
  expectedExecutable: "/bin/zsh",
  readOnly: false,
  capabilityEpoch: 0,
  geometry: brokerGeometry,
  launchGrantId: "launch-grant-fixture",
  launchGrantRevision: 1,
  visibility: brokerVisibility,
});
const { visibility: _createVisibility, ...sessionSpecPayload } =
  createBeginPayload;
const sessionSpec: SessionSpec = SessionSpecSchema.parse(sessionSpecPayload);
const pendingBinding = {
  locator: brokerLocator,
  visibility: brokerVisibility,
};
const pendingBindings: TerminalHostBindingStore = {
  bindTerminalHostSession: (binding) => binding,
  releaseUncreatedTerminalHostSession: () => false,
  completeTerminalHostSession: (_locator, createEvidence) => ({
    ...pendingBinding,
    createEvidence,
  }),
  renewTerminalHostVisibility: (_locator, visibility, _lease) => ({
    ...pendingBinding,
    visibility,
  }),
  recordTerminalHostTermination: (_locator, terminationAudit) => ({
    ...pendingBinding,
    terminationAudit,
  }),
  recordTerminalHostTerminationEvidence: (_locator, terminationEvidence) => ({
    ...pendingBinding,
    terminationEvidence,
  }),
  getTerminalHostBindingByLocator: (locator) =>
    locator.sessionId === brokerLocator.sessionId ? pendingBinding : null,
  listTerminalHostBindings: (instanceId) =>
    instanceId === brokerLocator.instanceId ? [pendingBinding] : [],
};
const createdPayload = {
  schemaVersion: 1,
  locator: brokerLocator,
  created: true,
  inspection: {
    schemaVersion: 1,
    locator: brokerLocator,
    presence: "present",
    complete: true,
    hostPid: 4_000,
    hostStartToken: "4000:123400",
    shellRoot: {
      pid: 4_100,
      startToken: "4100:123456",
      processGroupId: 4_100,
    },
    foreground: { state: "unknown", runId: null },
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    outputSeq: "0",
    checkpointSeq: "0",
    checkpointAvailable: false,
    viewerCount: 0,
    geometry: brokerGeometry,
    resources: {},
    visibility: {
      state: "attaching",
      workspaceSessionId: brokerVisibility.workspaceSessionId,
      openTerminalRevision: brokerVisibility.openTerminalRevision,
      expiresAt: "2026-07-18T01:00:15.000Z",
    },
    exit: null,
    survivors: [],
    evidenceAt: "2026-07-18T01:00:00.000Z",
    diagnosticIds: [],
  },
} as const;

const launchedRecord = {
  locator: brokerLocator,
  hostPid: 4_000,
  hostStartToken: "4000:123400",
  processRoot: { pid: 4_100, startToken: "4100:123456", processGroupId: 4_100 },
  expectedExecutable: "/bin/zsh",
  executableBuildHash: "executable-build-hash",
  engineBuildId: brokerLocator.engineBuildId,
  protocol: { major: 1 as const, minor: 0 },
  geometry: brokerGeometry,
  state: "live" as const,
  outputSeq: "0",
  checkpointSeq: "0",
  visibility: {
    state: "attaching" as const,
    workspaceSessionId: brokerVisibility.workspaceSessionId,
    openTerminalRevision: brokerVisibility.openTerminalRevision,
    expiresAt: "2026-07-18T01:00:15.000Z",
  },
};

/** Records what Hive asked for, and answers as a booted host would. */
function recordingLauncher(
  outcome: () => LaunchedHost["record"] = () => launchedRecord,
  process: Readonly<{ exited: Promise<number> }> = {
    exited: new Promise<number>(() => {}),
  },
) {
  const requests: Array<{ specJson: string }> = [];
  return {
    requests,
    launch: async (request: HostLaunchRequest): Promise<LaunchedHost> => {
      requests.push({ specJson: request.specJson });
      return {
        record: outcome(),
        hostPid: launchedRecord.hostPid,
        // SAFETY: The test owns this value and its fields.
        control: { destroy() {} } as Socket,
        // SAFETY: The test owns this value and its fields.
        process: process as LaunchedHost["process"],
      };
    },
  };
}

/**
 * Answers direct host operations: enumeration from the hosts' own published
 * records, and INSPECT from the host itself. No broker is involved in either.
 */
function directInspect<T, U, V>(
  inspection: T,
  sessions?: readonly U[],
  terminationResult?: V,
) {
  return {
    // SAFETY: The test owns this value and its fields.
    callHost: (async (request: { operation: string }) => {
      const answer =
        request.operation === "terminate"
          ? (terminationResult ?? {})
          : inspection;
      // SAFETY: The test owns this value and its fields.
      return JSON.stringify({ schemaVersion: 1, ...(answer as object) });
    }) as never,
    // SAFETY: The test owns this value and its fields.
    readControlSecret: (async () => new Uint8Array(32)) as never,
    // SAFETY: The test owns this value and its fields.
    listSessions: (async () => sessions ?? []) as never,
    // SAFETY: The test owns this value and its fields.
    adoptHost: (async () => {}) as never,
  };
}

const receipt: InputReceipt = {
  transactionId: "transaction-1",
  stage: "written-to-terminal",
  byteRange: { start: "0", endExclusive: "11" },
  orderedAt: "1",
  availableCreditBytes: 131_061,
  consumedByProcess: "not-claimed",
  completeness: "complete",
  diagnostic: null,
};

const resize: ResizeResult = {
  state: "applied",
  revision: "2",
  readback: {
    columns: 111,
    rows: 37,
    widthPixels: 1_110,
    heightPixels: 740,
  },
  orderedAt: "2",
  foregroundProcessObservation: "not-claimed",
};

const checkpointBytes = new TextEncoder().encode("terminal-checkpoint");
const inspection: SessionInspection = {
  session,
  lifecycle: "running",
  completeness: "complete",
  host: { processId: 4_000, startToken: "4000:123400" },
  child: { processId: 4_100, startToken: "4100:123456" },
  jobControl:
    createResult.outcome.state === "running"
      ? createResult.outcome.jobControl
      : null,
  window: {
    value:
      resize.state === "applied"
        ? resize.readback
        : createRequest.initialWindow,
    revision: "2",
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
      opaqueBytes: checkpointBytes,
    },
  },
  exit: null,
  reap: {
    authority: "direct-parent",
    reaped: false,
    status: null,
    completeness: "complete",
  },
  descendants: [],
  survivors: [],
  evidenceAt: "2026-07-18T01:00:00.000Z",
  diagnostics: [],
};

const inspectionWire = {
  ...inspection,
  checkpoints: {
    ...inspection.checkpoints,
    newest:
      inspection.checkpoints.newest === null
        ? null
        : {
            ...inspection.checkpoints.newest,
            opaqueBytes: Buffer.from(checkpointBytes).toString("base64"),
          },
  },
};

const termination: TerminationResult = {
  state: "terminated",
  exit: {
    code: null,
    signal: 9,
    observedAt: "2026-07-18T01:00:01.000Z",
  },
  reap: {
    authority: "direct-parent",
    reaped: true,
    status: {
      code: null,
      signal: 9,
      observedAt: "2026-07-18T01:00:01.000Z",
    },
    completeness: "complete",
  },
  survivors: [],
  completeness: "complete",
  diagnostics: [],
};

class RecordingClient implements SessiondControlClient {
  readonly requests: SessiondControlRequest<unknown>[] = [];
  closed = false;

  constructor(
    private readonly respond: (
      request: SessiondControlRequest<unknown>,
    ) => object,
  ) {}

  async request<Result>(
    request: SessiondControlRequest<Result>,
  ): Promise<Result> {
    // SAFETY: The test owns this value and its fields.
    this.requests.push(request as SessiondControlRequest<unknown>);
    return request.responseSchema.parse(
      // SAFETY: The test owns this value and its fields.
      this.respond(request as SessiondControlRequest<unknown>),
    );
  }

  close(): void {
    this.closed = true;
  }
}

describe("sessiond wire framing", () => {
  test("encodes network-order headers and decodes split frames", () => {
    const payload = new TextEncoder().encode(
      '{"schemaVersion":1,"monoNanos":"7"}',
    );
    const encoded = encodeSessiondFrame({
      type: "PING",
      flags: 0,
      requestId: 42n,
      streamSeq: 0n,
      payload,
    });
    const view = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength,
    );
    expect(Array.from(encoded.subarray(0, 4))).toEqual(
      Array.from(FRAME_HEADER.magicBytes),
    );
    expect(view.getUint16(FRAME_HEADER.offsets.type)).toBe(0x0004);
    expect(view.getUint32(FRAME_HEADER.offsets.payloadLength)).toBe(
      payload.byteLength,
    );
    expect(view.getBigUint64(FRAME_HEADER.offsets.requestId)).toBe(42n);

    const decoder = new SessiondFrameDecoder();
    expect(decoder.push(encoded.slice(0, 19))).toEqual([]);
    const frames = decoder.push(encoded.slice(19));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: "PING",
      flags: 0,
      requestId: 42n,
      streamSeq: 0n,
      payload,
    });
  });

  test("rejects reserved header bits", () => {
    const encoded = encodeSessiondFrame({
      type: "PING",
      flags: 0,
      requestId: 1n,
      streamSeq: 0n,
      payload: new Uint8Array(),
    });
    new DataView(encoded.buffer).setUint16(FRAME_HEADER.offsets.reserved, 1);
    expect(() => new SessiondFrameDecoder().push(encoded)).toThrow(
      SessiondProtocolError,
    );
  });

  test("enforces the negotiated control-frame cap", () => {
    const encoded = encodeSessiondFrame({
      type: "PING",
      flags: 0,
      requestId: 1n,
      streamSeq: 0n,
      payload: new Uint8Array(2),
    });
    expect(() => new SessiondFrameDecoder(1).push(encoded)).toThrow(
      "sessiond control frame exceeds the negotiated v1 cap",
    );
  });

  test("ignores complete unknown optional frames", () => {
    const encoded = encodeSessiondFrame({
      type: "PING",
      flags: 0,
      requestId: 1n,
      streamSeq: 0n,
      payload: new Uint8Array(),
    });
    new DataView(encoded.buffer).setUint16(
      FRAME_HEADER.offsets.type,
      FRAME_HEADER.optionalTypeBit | 1,
    );
    expect(new SessiondFrameDecoder().push(encoded)).toEqual([]);
  });

  test("creates from a product spec and its pre-bound Workspace visibility", async () => {
    // Hive launches the host itself; the broker is not in this path at all.
    const launcher = recordingLauncher();
    const host = new SessiondHost({
      launchHost: launcher.launch,
      // SAFETY: The test owns this value and its fields.
      adoptHost: (async () => {}) as never,
      pendingBindings,
    });
    const result = await host.create(sessionSpec);
    expect(result.locator).toEqual(brokerLocator);
    expect(result.created).toBe(true);
    // A terminal that has only just registered has a shell and no provider, so
    // the foreground is unknown rather than invented.
    expect(result.inspection.foreground).toEqual({
      state: "unknown",
      runId: null,
    });
    expect(result.inspection.hostPid).toBe(launchedRecord.hostPid);
    expect(result.inspection.shellRoot).toEqual({
      pid: 4_100,
      startToken: "4100:123456",
      processGroupId: 4_100,
    });
    // The host receives exactly the negotiated CREATE_BEGIN document.
    expect(launcher.requests).toHaveLength(1);
    expect(JSON.parse(required(launcher.requests[0]).specJson)).toEqual(
      createBeginPayload,
    );
  });

  test("invalidates the executable digest when a build replaces the same path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-sessiond-hash-"));
    const executable = join(directory, "hive-sessiond");
    try {
      await writeFile(executable, "first-build");
      const first = await executableBuildHash(executable);
      const replacement = "replacement-sessiond-build";
      await writeFile(executable, replacement);
      const second = await executableBuildHash(executable);

      expect(second).not.toBe(first);
      expect(second).toBe(
        createHash("sha256").update(replacement).digest("hex"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("invalidates engine discovery when the executable identity changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-sessiond-engine-"));
    const executable = join(directory, "hive-sessiond");
    const previous = process.env.HIVE_SESSIOND_BIN;
    process.env.HIVE_SESSIOND_BIN = executable;
    try {
      await writeFile(executable, "#!/bin/sh\nprintf engine-one\n");
      await chmod(executable, 0o755);
      const host = new SessiondHost();
      await expect(host.discoverEngineBuildId()).resolves.toBe("engine-one");

      await writeFile(executable, "#!/bin/sh\nprintf replacement-engine-two\n");
      await expect(host.discoverEngineBuildId()).resolves.toBe(
        "replacement-engine-two",
      );
    } finally {
      if (previous === undefined) delete process.env.HIVE_SESSIOND_BIN;
      else process.env.HIVE_SESSIOND_BIN = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports whether an exit wait belongs to this daemon instance", async () => {
    const host = new SessiondHost();
    await expect(
      host.waitForHostExit(
        brokerLocator.sessionId,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "inherited" });
  });

  test("a managed host exit wakes its wait with durable child status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-sessiond-exit-wait-"));
    let releaseExit = (_code: number): void => {
      throw new Error("exit promise was not armed");
    };
    const exited = new Promise<number>((resolve) => {
      releaseExit = resolve;
    });
    const host = new SessiondHost({
      hiveHome: directory,
      launchHost: recordingLauncher(() => launchedRecord, { exited }).launch,
      // SAFETY: The test owns this value and its fields.
      adoptHost: (async () => {}) as never,
      pendingBindings,
    });

    try {
      await host.create(sessionSpec);
      let settled = false;
      const waiting = host
        .waitForHostExit(brokerLocator.sessionId, new AbortController().signal)
        .then((value) => {
          settled = true;
          return value;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      const stateDirectory = hostDirectory(directory, brokerLocator.sessionId);
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(
        join(stateDirectory, "final.json"),
        JSON.stringify({ schemaVersion: 1, exitCode: 37 }),
      );
      releaseExit(0);

      await expect(waiting).resolves.toEqual({
        kind: "managed-exit",
        exitCode: 37,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("canceling a managed exit wait releases it before host exit", async () => {
    const host = new SessiondHost({
      launchHost: recordingLauncher().launch,
      // SAFETY: The test owns this value and its fields.
      adoptHost: (async () => {}) as never,
      pendingBindings,
    });
    await host.create(sessionSpec);
    const abort = new AbortController();
    const waiting = host.waitForHostExit(brokerLocator.sessionId, abort.signal);

    abort.abort();

    await expect(waiting).resolves.toEqual({ kind: "aborted" });
  });

  test("releases the pending binding when the launch fails", async () => {
    const released: unknown[] = [];
    const bindings: TerminalHostBindingStore = {
      ...pendingBindings,
      releaseUncreatedTerminalHostSession: (candidate) => {
        released.push(candidate);
        return true;
      },
    };
    const host = new SessiondHost({
      launchHost: recordingLauncher(() => {
        throw new Error("host never registered");
      }).launch,
      // SAFETY: The test owns this value and its fields.
      adoptHost: (async () => {}) as never,
      pendingBindings: bindings,
    });

    await expect(host.create(sessionSpec)).rejects.toThrow(
      /host never registered/,
    );
    // Nothing was created, so the pending binding must not survive as a pane.
    expect(released).toEqual([brokerLocator]);
  });

  test("retains the binding when a created host fails finalization", async () => {
    const released: unknown[] = [];
    const bindings: TerminalHostBindingStore = {
      ...pendingBindings,
      releaseUncreatedTerminalHostSession: (candidate) => {
        released.push(candidate);
        return true;
      },
    };
    const host = new SessiondHost({
      launchHost: recordingLauncher().launch,
      // SAFETY: The test owns this value and its fields.
      adoptHost: (async () => {
        throw new Error("host refused stale executable digest");
      }) as never,
      pendingBindings: bindings,
    });

    await expect(host.create(sessionSpec)).rejects.toThrow(
      `sessiond host ${brokerLocator.sessionId} was created but launch finalization failed: host refused stale executable digest`,
    );
    expect(released).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    await expect(
      host.waitForHostExit(brokerLocator.sessionId, abort.signal),
    ).resolves.toEqual({ kind: "aborted" });
  });

  test("composes negotiated create through the adapter and a real binding database", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "hive-sessiond-create-scaffold-"),
    );
    const db = new HiveDatabase(join(directory, "hive.db"));
    const transportSession = {
      key: brokerLocator.sessionId,
      incarnation: "neutral-incarnation-scaffold",
    };
    const transportInspection = {
      ...inspectionWire,
      session: transportSession,
    };
    const brokers: RecordingClient[] = [];
    const host = new SessiondHost({
      pendingBindings: db,
      // Create launches the host directly; the broker seam below still serves
      // the read and renewal RPCs this test exercises.
      launchHost: recordingLauncher().launch,
      ...directInspect(transportInspection, [transportSession]),
    });
    const adapter = new HiveTerminalHostAdapter(
      host,
      db,
      brokerLocator.instanceId,
      { providerRuns: db },
    );

    try {
      const created = await adapter.create(sessionSpec, pendingBinding);
      // Evidence is stamped when it is taken, so it is checked as a fresh
      // instant rather than pinned to a fixture's frozen one.
      const evidenceAge =
        Date.now() - Date.parse(created.inspection.evidenceAt);
      expect(evidenceAge).toBeGreaterThanOrEqual(0);
      expect(evidenceAge).toBeLessThan(60_000);
      expect(created).toEqual({
        locator: brokerLocator,
        inspection: {
          ...createdPayload.inspection,
          evidenceAt: created.inspection.evidenceAt,
        },
        created: true,
      });
      const createEvidence = {
        expectedExecutable: sessionSpec.expectedExecutable,
        executableVerified: createdPayload.inspection.executableVerified,
        verifiedShellRoot: createdPayload.inspection.shellRoot,
        geometry: sessionSpec.geometry,
        // Renewed at create-return: the binding holds the lease's visibility,
        // not the launch record's.
        visibility: {
          state: "attaching" as const,
          workspaceSessionId: brokerVisibility.workspaceSessionId,
          openTerminalRevision: "1",
          expiresAt: "2026-07-18T01:00:15.000Z",
        },
      };
      expect(db.getTerminalHostBindingByLocator(brokerLocator)).toEqual({
        ...pendingBinding,
        createEvidence,
      });
      expect(
        db.database
          .query(
            `
        SELECT locatorInstanceId, locatorSessionId, locatorGeneration
        FROM terminal_host_bindings
      `,
          )
          .all(),
      ).toEqual([
        {
          locatorInstanceId: brokerLocator.instanceId,
          locatorSessionId: brokerLocator.sessionId,
          locatorGeneration: brokerLocator.generation,
        },
      ]);
      await expect(adapter.inspect(brokerLocator)).resolves.toEqual({
        schemaVersion: 1,
        locator: brokerLocator,
        presence: "present",
        complete: false,
        hostPid: 4_000,
        hostStartToken: "4000:123400",
        shellRoot: {
          pid: 4_100,
          startToken: "4100:123456",
          processGroupId: 4_100,
        },
        foreground: { state: "shell-idle", runId: null },
        expectedExecutable: "/bin/zsh",
        executableVerified: true,
        outputSeq: "19",
        checkpointSeq: "2",
        checkpointAvailable: true,
        viewerCount: 0,
        geometry: {
          columns: 111,
          rows: 37,
          widthPx: 1_110,
          heightPx: 740,
          cellWidthPx: 10,
          cellHeightPx: 20,
        },
        resources: {},
        visibility: {
          state: "attaching",
          workspaceSessionId: brokerVisibility.workspaceSessionId,
          openTerminalRevision: "1",
          expiresAt: "2026-07-18T01:00:15.000Z",
        },
        exit: null,
        survivors: [],
        evidenceAt: "2026-07-18T01:00:00.000Z",
        diagnosticIds: [
          "SESSIOND_VIEWER_COUNT_UNAVAILABLE",
          "SESSIOND_RESOURCES_UNAVAILABLE",
        ],
      });
      // No renewals on the wire at all. A create binds a terminal and returns;
      // keeping it alive is not something the daemon does, so nothing here may
      // put a per-terminal message on the critical path again.
      expect(
        brokers
          .flatMap((broker) => broker.requests)
          .map((request) => request.requestType),
        // Nothing reaches a broker: create launches the host, and list,
        // inspect and terminate are asked of the terminal itself.
      ).toEqual([]);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps production sessiond create admission explicitly disabled by default", async () => {
    const host = new SessiondHost({});
    await expect(host.create(sessionSpec)).rejects.toBeInstanceOf(
      SessiondCreateAdmissionDisabledError,
    );
  });

  test("captures the host-owned grid without attaching a replay viewer", async () => {
    const priorBinary = process.env.HIVE_SESSIOND_BIN;
    process.env.HIVE_SESSIOND_BIN = "/bin/echo";
    try {
      const measured: CaptureResult = {
        locator: brokerLocator,
        outputSeq: "21",
        columns: 80,
        rows: 24,
        rowStart: 4,
        screen: "alternate",
        cursor: { row: 22, column: 17, visible: true },
        text: "measured grid",
        styledText: "\u001b[7mmeasured grid\u001b[0m",
        truncated: true,
        sha256: "a".repeat(64),
        composer: null,
      };
      let requested: JsonValue = null;
      const host = new SessiondHost({
        hiveHome: "/tmp/hive-sessiond-capture-test",
        captureHost: async (options) => {
          requested = options;
          return measured;
        },
      });
      await expect(
        host.capture(brokerLocator, {
          include: "visible-text",
          maxRows: 20,
          expectedOutputSeq: "21",
        }),
      ).resolves.toEqual(measured);
      expect(requested).toMatchObject({
        sessionId: brokerLocator.sessionId,
        locator: brokerLocator,
        request: {
          include: "visible-text",
          maxRows: 20,
          expectedOutputSeq: "21",
        },
      });
    } finally {
      if (priorBinary === undefined) delete process.env.HIVE_SESSIOND_BIN;
      else process.env.HIVE_SESSIOND_BIN = priorBinary;
    }
  });

  test("projects provenance-tagged input and resize onto an attached neutral host", async () => {
    const respond = (request: SessiondControlRequest<unknown>) => {
      switch (request.requestType) {
        case "INPUT_SUBMIT":
          return { schemaVersion: 1, resultKind: "input", receipt };
        case "RESIZE":
          return { schemaVersion: 1, resultKind: "resize", result: resize };
        default:
          throw new Error(`unexpected request: ${request.requestType}`);
      }
    };
    const directClients: RecordingClient[] = [];
    const host = new SessiondHost({
      connectDirect: async (requested) => {
        expect(requested).toEqual(session);
        const direct = new RecordingClient(respond);
        directClients.push(direct);
        return direct;
      },
    });
    const inputRequest = {
      session,
      provenance: "automation" as const,
      action: "deliver" as const,
      transactionId: receipt.transactionId,
      idempotencyKey: "input-idempotency-1",
      operation: {
        kind: "bytes" as const,
        bytes: new TextEncoder().encode("wire-input\n"),
      },
    };
    const resizeRequest = {
      session,
      window:
        resize.state === "applied"
          ? resize.readback
          : createRequest.initialWindow,
      revision: "2",
      idempotencyKey: "resize-idempotency-1",
    };

    await expect(host.submitInput(inputRequest)).resolves.toEqual(receipt);
    await expect(host.submitInput(inputRequest)).resolves.toEqual(receipt);
    await expect(host.resize(resizeRequest)).resolves.toEqual(resize);

    const requests = directClients.flatMap((client) => client.requests);
    expect(requests.map((request) => request.requestType)).toEqual([
      "INPUT_SUBMIT",
      "INPUT_SUBMIT",
      "RESIZE",
    ]);
    expect(requests[0]?.flags).toBe(FRAME_FLAGS.contentSensitive);
    expect(requests[0]?.payload).toEqual(requests[1]?.payload);
    expect(requests[0]?.payload).toMatchObject({
      schemaVersion: 1,
      session,
      provenance: "automation",
      action: "deliver",
      transactionId: receipt.transactionId,
      idempotencyKey: "input-idempotency-1",
      operation: {
        kind: "bytes",
        encoding: "base64",
        bytes: Buffer.from("wire-input\n").toString("base64"),
      },
    });
    expect(directClients).toHaveLength(3);
    expect(directClients.every((client) => client.closed)).toBe(true);
  });

  test("projects frozen list, inspect and terminate straight to the host", async () => {
    const brokers: RecordingClient[] = [];
    const host = new SessiondHost({
      // INSPECT does not reach the broker: it is asked of the host itself.
      ...directInspect(inspectionWire, [session], termination),
    });

    await expect(host.list()).resolves.toEqual([inspection]);
    const inspected = await host.inspect(session);
    expect(inspected).toEqual(inspection);
    expect(Object.hasOwn(inspected, "schemaVersion")).toBe(false);
    const terminated = await host.terminate({
      session,
      mode: "immediate",
      target: "process-tree",
      deadline: "2026-07-18T01:00:02.000Z",
      idempotencyKey: "terminate-idempotency-1",
    });
    expect(terminated).toEqual(termination);
    expect(Object.hasOwn(terminated, "schemaVersion")).toBe(false);
    // No broker connection at all. Routing these through a relay costs an
    // authenticated HELLO each and puts one accept loop in front of the whole
    // fleet; asking the terminal that owns the answer removes both.
    expect(brokers).toHaveLength(0);
  });

  test("fails direct operations at the frozen wire-3 boundary by default", async () => {
    const host = new SessiondHost({});
    await expect(
      host.submitInput({
        session,
        provenance: "automation",
        action: "deliver",
        transactionId: receipt.transactionId,
        idempotencyKey: "input-idempotency-1",
        operation: { kind: "canonical-end-of-file" },
      }),
    ).rejects.toEqual(new SessiondWireNotReadyError("direct host operations"));
  });
});
