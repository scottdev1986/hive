import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateBeginPayloadSchema,
  CreatedPayloadSchema,
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPES,
  HelloPayloadSchema,
  SessionSpecSchema,
} from "../../schemas/session-protocol";
import { HiveDatabase } from "../db";
import type { DaemonHandshake } from "../handshake";
import { HiveTerminalHostAdapter } from "./hive-terminal-host";
import type { SessionSpec } from "./contract";
import type { TerminalHostBindingStore } from "./terminal-host-binding";
import type {
  ClaimResult,
  CreateRequest,
  CreateResult,
  InputReceipt,
  ResizeResult,
  SessionInspection,
  SessionRef,
  TerminationResult,
} from "./terminal-host-contract";
import {
  encodeSessiondFrame,
  SessiondBrokerUnavailableError,
  type SessiondBrokerClient,
  SessiondCreateAdmissionDisabledError,
  SessiondFrameDecoder,
  SessiondHost,
  SessiondProtocolError,
  SessiondSocketClient,
  SessiondWireError,
  SessiondWireNotReadyError,
  type SessiondControlClient,
  type SessiondControlRequest,
  type SessiondFrame,
} from "./sessiond-host";

const session: SessionRef = {
  key: "neutral-session-key",
  incarnation: "neutral-incarnation-1",
};

const handshake: DaemonHandshake = {
  productVersion: "0.0.0-dev",
  buildHash: "daemon-build-hash",
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  capabilities: ["daemon-handshake-v1"],
  instanceId: "instance-fixture",
  hiveUuid: "hive-fixture",
  identityKey: "identity-fixture",
  repoFamilyKey: null,
  generation: 1,
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
  argv: ["/bin/sh", "-lc", "printf ready"],
  environment: { PATH: "/usr/bin:/bin" },
  expectedExecutable: "/bin/sh",
  readOnly: false,
  capabilityEpoch: 0,
  geometry: brokerGeometry,
  launchGrantId: "launch-grant-fixture",
  launchGrantRevision: 1,
  visibility: brokerVisibility,
});
const { visibility: _createVisibility, ...sessionSpecPayload } = createBeginPayload;
const sessionSpec: SessionSpec = SessionSpecSchema.parse(sessionSpecPayload);
const pendingBinding = {
  locator: brokerLocator,
  visibility: brokerVisibility,
};
const pendingBindings: TerminalHostBindingStore = {
  bindTerminalHostSession: (binding) => binding,
  completeTerminalHostSession: (_locator, createEvidence) => ({
    ...pendingBinding,
    createEvidence,
  }),
  recordTerminalHostTermination: (_locator, terminationAudit) => ({
    ...pendingBinding,
    terminationAudit,
  }),
  getTerminalHostBindingByLocator: (locator) =>
    locator.sessionId === brokerLocator.sessionId ? pendingBinding : null,
  listTerminalHostBindings: (instanceId) =>
    instanceId === brokerLocator.instanceId ? [pendingBinding] : [],
};
const createdPayload = CreatedPayloadSchema.parse({
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
    providerRoot: { pid: 4_100, startToken: "4100:123456", processGroupId: 4_100 },
    expectedExecutable: "/bin/sh",
    executableVerified: true,
    outputSeq: "0",
    checkpointSeq: "0",
    checkpointAvailable: false,
    input: { state: "FREE", ownerViewerId: null, claimId: null },
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
});

const claim: ClaimResult = {
  state: "granted",
  claim: {
    token: "claim-token-1",
    writer: "writer-1",
    kind: "human",
    leaseExpiresAt: "2026-07-18T01:00:00.000Z",
  },
};

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
  jobControl: createResult.outcome.state === "running"
    ? createResult.outcome.jobControl
    : null,
  window: {
    value: resize.state === "applied" ? resize.readback : createRequest.initialWindow,
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
  inputOwner: claim.state === "granted" ? claim.claim : null,
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
    newest: inspection.checkpoints.newest === null
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

class RecordingClient implements SessiondBrokerClient {
  readonly requests: SessiondControlRequest<unknown>[] = [];
  readonly creates: Array<Readonly<{
    beginPayload: typeof createBeginPayload;
    initialInput: Uint8Array;
  }>> = [];
  closed = false;

  constructor(
    private readonly respond: (request: SessiondControlRequest<unknown>) => unknown,
    private readonly createRespond: () => unknown = () => createdPayload,
    readonly engineBuildId: string | null = null,
  ) {}

  async request<Result>(request: SessiondControlRequest<Result>): Promise<Result> {
    this.requests.push(request as SessiondControlRequest<unknown>);
    return request.responseSchema.parse(this.respond(request as SessiondControlRequest<unknown>));
  }

  async createTransaction(
    beginPayload: typeof createBeginPayload,
    initialInput: Uint8Array,
  ): Promise<typeof createdPayload> {
    this.creates.push({ beginPayload, initialInput: initialInput.slice() });
    return CreatedPayloadSchema.parse(this.createRespond());
  }

  close(): void {
    this.closed = true;
  }
}

class MockSocket extends EventEmitter {
  readonly writes: Uint8Array[] = [];
  destroyed = false;

  constructor(
    private readonly onFrame: (frame: SessiondFrame, socket: MockSocket) => void,
  ) {
    super();
  }

  write(
    chunk: Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean {
    const bytes = new Uint8Array(chunk);
    this.writes.push(bytes);
    callback?.(null);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const typeCode = view.getUint16(FRAME_HEADER.offsets.type);
    const type = Object.entries(FRAME_TYPES)
      .find(([, code]) => code === typeCode)?.[0] as SessiondFrame["type"] | undefined;
    if (type === undefined) throw new Error(`unexpected frame type ${typeCode}`);
    const payloadLength = view.getUint32(FRAME_HEADER.offsets.payloadLength);
    const frame: SessiondFrame = {
      type,
      flags: view.getUint16(FRAME_HEADER.offsets.flags),
      requestId: view.getBigUint64(FRAME_HEADER.offsets.requestId),
      streamSeq: view.getBigUint64(FRAME_HEADER.offsets.streamSeq),
      payload: bytes.slice(FRAME_HEADER.bytes, FRAME_HEADER.bytes + payloadLength),
    };
    queueMicrotask(() => this.onFrame(frame, this));
    return true;
  }

  receive(frame: SessiondFrame): void {
    this.emit("data", encodeSessiondFrame(frame));
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

const encodeJson = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

function createdResponse(frame: SessiondFrame): SessiondFrame {
  return {
    type: "CREATED",
    flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
    requestId: frame.requestId,
    streamSeq: 0n,
    payload: encodeJson(createdPayload),
  };
}

describe("sessiond wire framing", () => {
  test("encodes network-order headers and decodes split frames", () => {
    const payload = new TextEncoder().encode('{"schemaVersion":1,"monoNanos":"7"}');
    const encoded = encodeSessiondFrame({
      type: "PING",
      flags: 0,
      requestId: 42n,
      streamSeq: 0n,
      payload,
    });
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect([...encoded.slice(0, 4)]).toEqual([...FRAME_HEADER.magicBytes]);
    expect(view.getUint16(FRAME_HEADER.offsets.type)).toBe(0x0004);
    expect(view.getUint32(FRAME_HEADER.offsets.payloadLength)).toBe(payload.byteLength);
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
    expect(() => new SessiondFrameDecoder().push(encoded)).toThrow(SessiondProtocolError);
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

  test("writes exact BEGIN then empty-input COMMIT bytes and correlates CREATED to COMMIT", async () => {
    const socket = new MockSocket((frame, peer) => {
      if (frame.type === "CREATE_COMMIT") peer.receive(createdResponse(frame));
    });
    const client = new SessiondSocketClient(socket as unknown as Socket);

    await expect(client.createTransaction(
      createBeginPayload,
      new Uint8Array(),
    )).resolves.toEqual(createdPayload);

    expect(socket.writes).toEqual([
      encodeSessiondFrame({
        type: "CREATE_BEGIN",
        flags: 0,
        requestId: 1n,
        streamSeq: 0n,
        payload: encodeJson(createBeginPayload),
      }),
      encodeSessiondFrame({
        type: "CREATE_COMMIT",
        flags: 0,
        requestId: 2n,
        streamSeq: 0n,
        payload: encodeJson({
          schemaVersion: 1,
          totalLength: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        }),
      }),
    ]);
  });

  test("chunks exact raw CREATE_INPUT bytes at accumulated byte offsets", async () => {
    const socket = new MockSocket((frame, peer) => {
      if (frame.type === "CREATE_COMMIT") peer.receive(createdResponse(frame));
    });
    const client = new SessiondSocketClient(socket as unknown as Socket);
    client.setNegotiatedLimits({
      controlFrameMaxBytes: 262_144,
      streamChunkMaxBytes: 3,
      automatedMessageMaxBytes: 8,
    });
    const input = new TextEncoder().encode("abcdefg");

    await expect(client.createTransaction(createBeginPayload, input))
      .resolves.toEqual(createdPayload);

    expect(socket.writes).toEqual([
      encodeSessiondFrame({
        type: "CREATE_BEGIN",
        flags: 0,
        requestId: 1n,
        streamSeq: 0n,
        payload: encodeJson(createBeginPayload),
      }),
      encodeSessiondFrame({
        type: "CREATE_INPUT",
        flags: FRAME_FLAGS.contentSensitive,
        requestId: 2n,
        streamSeq: 0n,
        payload: new TextEncoder().encode("abc"),
      }),
      encodeSessiondFrame({
        type: "CREATE_INPUT",
        flags: FRAME_FLAGS.contentSensitive,
        requestId: 3n,
        streamSeq: 3n,
        payload: new TextEncoder().encode("def"),
      }),
      encodeSessiondFrame({
        type: "CREATE_INPUT",
        flags: FRAME_FLAGS.contentSensitive,
        requestId: 4n,
        streamSeq: 6n,
        payload: new TextEncoder().encode("g"),
      }),
      encodeSessiondFrame({
        type: "CREATE_COMMIT",
        flags: 0,
        requestId: 5n,
        streamSeq: 0n,
        payload: encodeJson({
          schemaVersion: 1,
          totalLength: 7,
          sha256: "7d1a54127b222502f5b79b5fb0803061152a44f92b37e23c6527baf665d4da9a",
        }),
      }),
    ]);
  });

  test("surfaces in_doubt from COMMIT without retrying", async () => {
    const socket = new MockSocket((frame, peer) => {
      if (frame.type !== "CREATE_COMMIT") return;
      peer.receive({
        type: "ERROR",
        flags: FRAME_FLAGS.response | FRAME_FLAGS.final | FRAME_FLAGS.error,
        requestId: frame.requestId,
        streamSeq: 0n,
        payload: encodeJson({
          schemaVersion: 1,
          code: "IN_DOUBT",
          message: "host launch state is indeterminate",
          diagnosticId: null,
        }),
      });
    });
    const client = new SessiondSocketClient(socket as unknown as Socket);

    const failure = client.createTransaction(createBeginPayload, new Uint8Array())
      .catch((error) => error);
    await expect(failure).resolves.toBeInstanceOf(SessiondWireError);
    await expect(failure).resolves.toMatchObject({ code: "IN_DOUBT" });
    expect(socket.writes).toHaveLength(2);
  });

  test("surfaces an ERROR correlated to no-response CREATE_BEGIN", async () => {
    const socket = new MockSocket((frame, peer) => {
      if (frame.type !== "CREATE_BEGIN") return;
      peer.receive({
        type: "ERROR",
        flags: FRAME_FLAGS.response | FRAME_FLAGS.final | FRAME_FLAGS.error,
        requestId: frame.requestId,
        streamSeq: 0n,
        payload: encodeJson({
          schemaVersion: 1,
          code: "NOT_READY",
          message: "production backend is not ready",
          diagnosticId: null,
        }),
      });
    });
    const client = new SessiondSocketClient(socket as unknown as Socket);

    const failure = client.createTransaction(createBeginPayload, new Uint8Array())
      .catch((error) => error);
    await expect(failure).resolves.toBeInstanceOf(SessiondWireError);
    await expect(failure).resolves.toMatchObject({ code: "NOT_READY" });
    expect(socket.destroyed).toBe(true);
  });

  test("rejects oversized or overlapping create transactions before writing", async () => {
    const socket = new MockSocket(() => undefined);
    const client = new SessiondSocketClient(socket as unknown as Socket);
    client.setNegotiatedLimits({
      controlFrameMaxBytes: 262_144,
      streamChunkMaxBytes: 3,
      automatedMessageMaxBytes: 3,
    });
    const oversized = client.createTransaction(
      createBeginPayload,
      new Uint8Array(4),
    ).catch((error) => error);
    await expect(oversized).resolves.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(socket.writes).toEqual([]);

    const first = client.createTransaction(createBeginPayload, new Uint8Array());
    await expect(client.createTransaction(createBeginPayload, new Uint8Array()))
      .rejects.toThrow("create transaction is already active");
    client.close();
    await expect(first).rejects.toThrow("sessiond connection closed");
  });

  test("handshakes and runs product create over the production Unix-socket path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-sessiond-host-test-"));
    const runtime = join(directory, "runtime", "sessiond");
    await mkdir(runtime, { recursive: true });
    const socketPath = join(runtime, "broker.sock");
    const received: ReturnType<SessiondFrameDecoder["push"]> = [];
    const server = createServer((socket) => {
      const decoder = new SessiondFrameDecoder();
      let helloRequestId: bigint | null = null;
      socket.on("data", (chunk) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        for (const frame of decoder.push(bytes)) {
          received.push(frame);
          if (frame.type === "HELLO") {
            helloRequestId = frame.requestId;
            socket.write(encodeSessiondFrame({
              type: "PING",
              flags: 0,
              requestId: 900n,
              streamSeq: 0n,
              payload: new TextEncoder().encode(
                '{"schemaVersion":1,"monoNanos":"7"}',
              ),
            }));
          } else if (frame.type === "PONG") {
            expect(frame.flags).toBe(FRAME_FLAGS.response | FRAME_FLAGS.final);
            socket.write(encodeSessiondFrame({
              type: "WELCOME",
              flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
              requestId: helloRequestId!,
              streamSeq: 0n,
              payload: new TextEncoder().encode(JSON.stringify({
                  schemaVersion: 1,
                  protocol: { major: 1, minor: 0 },
                  instanceId: handshake.instanceId,
                  endpointRole: "broker",
                  buildId: "sessiond-build-hash",
                  engineBuildId: brokerLocator.engineBuildId,
                  connectionId: "1",
                  serverEpoch: "1",
                  limits: {
                    controlFrameMaxBytes: 262_144,
                    maxInputTransactionBytes: 131_072,
                    streamChunkMaxBytes: 65_536,
                    automatedMessageMaxBytes: 1_048_576,
                    viewerQueueMaxBytes: 8_388_608,
                  },
                })),
            }));
          } else if (frame.type === "CREATE_COMMIT") {
            socket.write(encodeSessiondFrame({
              type: "CREATED",
              flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
              requestId: frame.requestId,
              streamSeq: 0n,
              payload: new TextEncoder().encode(JSON.stringify(createdPayload)),
            }));
          }
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const host = new SessiondHost({
        hiveHome: directory,
        handshake: async () => handshake,
        pendingBindings,
      });
      await expect(host.create(sessionSpec, new Uint8Array())).resolves.toEqual({
        locator: brokerLocator,
        inspection: createdPayload.inspection,
        created: true,
      });
      expect(received.map((frame) => frame.type)).toEqual([
        "HELLO",
        "PONG",
        "CREATE_BEGIN",
        "CREATE_COMMIT",
      ]);
      expect(HelloPayloadSchema.parse(JSON.parse(
        new TextDecoder().decode(received[0]?.payload),
      ))).toMatchObject({
        buildId: handshake.buildHash,
        instanceId: handshake.instanceId,
        clientRole: "daemon",
        daemonControl: {
          productVersion: handshake.productVersion,
          buildHash: handshake.buildHash,
          wireProtocol: handshake.wireProtocol,
          schemaEpoch: handshake.schemaEpoch,
          instanceId: handshake.instanceId,
          hiveUuid: handshake.hiveUuid,
          identityKey: handshake.identityKey,
          repoFamilyKey: handshake.repoFamilyKey,
        },
      });
      expect(JSON.parse(new TextDecoder().decode(received[2]?.payload)))
        .toEqual(createBeginPayload);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("SessiondHost landed frozen operations", () => {
  test("reports an absent production broker as explicit not-ready evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-sessiond-absent-"));
    try {
      const host = new SessiondHost({
        hiveHome: directory,
        handshake: async () => handshake,
      });

      const failure = host.list().catch((error) => error);
      await expect(failure).resolves.toBeInstanceOf(SessiondBrokerUnavailableError);
      await expect(failure).resolves.toMatchObject({
        socketPath: join(directory, "runtime", "sessiond", "broker.sock"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("creates from a product spec and its pre-bound Workspace visibility", async () => {
    const broker = new RecordingClient(() => {
      throw new Error("product create must use the transactional seam");
    }, () => createdPayload, brokerLocator.engineBuildId);
    const host = new SessiondHost({
      connectBroker: async () => broker,
      pendingBindings,
    });
    const initialInput = new TextEncoder().encode("initial input\n");

    await expect(host.create(sessionSpec, initialInput)).resolves.toEqual({
      locator: brokerLocator,
      inspection: createdPayload.inspection,
      created: true,
    });
    expect(broker.creates).toEqual([{
      beginPayload: createBeginPayload,
      initialInput,
    }]);
    expect(broker.requests).toHaveLength(0);
    expect(broker.closed).toBe(true);
  });

  test("composes negotiated create through the adapter and a real binding database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hive-sessiond-create-scaffold-"));
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
      connectBroker: async () => {
        const broker = new RecordingClient((request) => {
          switch (request.requestType) {
            case "LIST":
              return { schemaVersion: 1, entries: [transportInspection] };
            case "INSPECT":
              return { schemaVersion: 1, ...transportInspection };
            default:
              throw new Error(`unexpected request: ${request.requestType}`);
          }
        }, () => createdPayload, brokerLocator.engineBuildId);
        brokers.push(broker);
        return broker;
      },
    });
    const adapter = new HiveTerminalHostAdapter(host, db, brokerLocator.instanceId);

    try {
      await expect(adapter.create(
        sessionSpec,
        new Uint8Array(),
        pendingBinding,
      )).resolves.toEqual({
        locator: brokerLocator,
        inspection: createdPayload.inspection,
        created: true,
      });
      const createEvidence = {
        expectedExecutable: sessionSpec.expectedExecutable,
        executableVerified: createdPayload.inspection.executableVerified,
        verifiedProviderRoot: createdPayload.inspection.providerRoot,
        geometry: sessionSpec.geometry,
        visibility: createdPayload.inspection.visibility,
      };
      expect(db.getTerminalHostBindingByLocator(brokerLocator))
        .toEqual({ ...pendingBinding, createEvidence });
      expect(db.database.query(`
        SELECT locatorInstanceId, locatorSessionId, locatorGeneration
        FROM terminal_host_bindings
      `).all()).toEqual([{
        locatorInstanceId: brokerLocator.instanceId,
        locatorSessionId: brokerLocator.sessionId,
        locatorGeneration: brokerLocator.generation,
      }]);
      await expect(adapter.inspect(brokerLocator)).resolves.toEqual({
        schemaVersion: 1,
        locator: brokerLocator,
        presence: "present",
        complete: false,
        hostPid: 4_000,
        hostStartToken: "4000:123400",
        providerRoot: {
          pid: 4_100,
          startToken: "4100:123456",
          processGroupId: 4_100,
        },
        expectedExecutable: "/bin/sh",
        executableVerified: true,
        outputSeq: "19",
        checkpointSeq: "2",
        checkpointAvailable: true,
        input: { state: "UNKNOWN", ownerViewerId: null, claimId: null },
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
        visibility: createdPayload.inspection.visibility,
        exit: null,
        survivors: [],
        evidenceAt: "2026-07-18T01:00:00.000Z",
        diagnosticIds: [
          "SESSIOND_VIEWER_COUNT_UNAVAILABLE",
          "SESSIOND_RESOURCES_UNAVAILABLE",
          "SESSIOND_INPUT_STATE_UNAVAILABLE",
        ],
      });
      expect(brokers.flatMap((broker) => broker.creates)).toEqual([{
        beginPayload: createBeginPayload,
        initialInput: new Uint8Array(),
      }]);
      expect(brokers.flatMap((broker) => broker.requests)
        .map((request) => request.requestType)).toEqual(["LIST", "INSPECT"]);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps production sessiond create admission explicitly disabled by default", async () => {
    const host = new SessiondHost({
      connectBroker: async () => new RecordingClient(() => createdPayload),
    });
    await expect(host.create(sessionSpec, new Uint8Array()))
      .rejects.toBeInstanceOf(SessiondCreateAdmissionDisabledError);
  });

  test("discovers the broker engine without caching and closes the connection", async () => {
    const first = new RecordingClient(
      () => createdPayload,
      () => createdPayload,
      "engine-first",
    );
    const second = new RecordingClient(
      () => createdPayload,
      () => createdPayload,
      "engine-second",
    );
    const brokers = [first, second];
    const host = new SessiondHost({
      connectBroker: async () => brokers.shift()!,
    });

    await expect(host.discoverEngineBuildId()).resolves.toBe("engine-first");
    await expect(host.discoverEngineBuildId()).resolves.toBe("engine-second");
    expect(brokers).toEqual([]);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
  });

  test("refuses an absent or changed broker engine before CREATE_BEGIN", async () => {
    const absent = new RecordingClient(
      () => createdPayload,
      () => createdPayload,
      null,
    );
    const discovered = new RecordingClient(
      () => createdPayload,
      () => createdPayload,
      brokerLocator.engineBuildId,
    );
    const changed = new RecordingClient(
      () => createdPayload,
      () => createdPayload,
      "replacement-engine",
    );
    const absentHost = new SessiondHost({
      connectBroker: async () => absent,
      pendingBindings,
    });
    const brokers = [discovered, changed];
    const changedHost = new SessiondHost({
      connectBroker: async () => brokers.shift()!,
      pendingBindings,
    });

    await expect(absentHost.discoverEngineBuildId())
      .rejects.toThrow("did not publish its engine build");
    await expect(changedHost.discoverEngineBuildId())
      .resolves.toBe(brokerLocator.engineBuildId);
    await expect(changedHost.create(sessionSpec, new Uint8Array()))
      .rejects.toThrow("engine build changed before create");
    expect(absent.creates).toEqual([]);
    expect(changed.creates).toEqual([]);
    expect(brokers).toEqual([]);
  });

  test("projects claim, idempotent input, and resize onto an attached neutral host", async () => {
    const respond = (request: SessiondControlRequest<unknown>) => {
      switch (request.requestType) {
        case "CLAIM_ACQUIRE":
          return { schemaVersion: 1, result: claim };
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
      connectBroker: async () => new RecordingClient(() => createResult),
      connectDirect: async (requested) => {
        expect(requested).toEqual(session);
        const direct = new RecordingClient(respond);
        directClients.push(direct);
        return direct;
      },
    });
    const claimRequest = {
      session,
      writer: "writer-1",
      kind: "human" as const,
      leaseMilliseconds: 10_000,
      idempotencyKey: "claim-idempotency-1",
    };
    const inputRequest = {
      session,
      claimToken: "claim-token-1",
      transactionId: receipt.transactionId,
      idempotencyKey: "input-idempotency-1",
      operation: { kind: "bytes" as const, bytes: new TextEncoder().encode("wire-input\n") },
    };
    const resizeRequest = {
      session,
      window: resize.state === "applied" ? resize.readback : createRequest.initialWindow,
      revision: "2",
      idempotencyKey: "resize-idempotency-1",
    };

    await expect(host.claimInput(claimRequest)).resolves.toEqual(claim);
    await expect(host.submitInput(inputRequest)).resolves.toEqual(receipt);
    await expect(host.submitInput(inputRequest)).resolves.toEqual(receipt);
    await expect(host.resize(resizeRequest)).resolves.toEqual(resize);

    const requests = directClients.flatMap((client) => client.requests);
    expect(requests.map((request) => request.requestType)).toEqual([
      "CLAIM_ACQUIRE",
      "INPUT_SUBMIT",
      "INPUT_SUBMIT",
      "RESIZE",
    ]);
    expect(requests[1]?.flags).toBe(FRAME_FLAGS.contentSensitive);
    expect(requests[1]?.payload).toEqual(requests[2]?.payload);
    expect(requests[1]?.payload).toMatchObject({
      schemaVersion: 1,
      session,
      transactionId: receipt.transactionId,
      idempotencyKey: "input-idempotency-1",
      operation: {
        kind: "bytes",
        encoding: "base64",
        bytes: Buffer.from("wire-input\n").toString("base64"),
      },
    });
    expect(directClients).toHaveLength(4);
    expect(directClients.every((client) => client.closed)).toBe(true);
  });

  test("projects frozen list, inspect, and terminate through the broker", async () => {
    const brokers: RecordingClient[] = [];
    const host = new SessiondHost({
      connectBroker: async () => {
        const broker = new RecordingClient((request) => {
          switch (request.requestType) {
            case "LIST":
              expect(request.payload).toEqual({ schemaVersion: 1 });
              return { schemaVersion: 1, entries: [inspectionWire] };
            case "INSPECT":
              expect(request.payload).toEqual({ schemaVersion: 1, session });
              return { schemaVersion: 1, ...inspectionWire };
            case "TERMINATE":
              expect(request.payload).toEqual({
                schemaVersion: 1,
                session,
                mode: "immediate",
                target: "process-tree",
                deadline: "2026-07-18T01:00:02.000Z",
                idempotencyKey: "terminate-idempotency-1",
              });
              return { schemaVersion: 1, ...termination };
            default:
              throw new Error(`unexpected request: ${request.requestType}`);
          }
        });
        brokers.push(broker);
        return broker;
      },
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
    expect(brokers).toHaveLength(3);
    expect(brokers.every((broker) => broker.closed)).toBe(true);
  });

  test("fails direct operations at the frozen wire-3 boundary by default", async () => {
    const host = new SessiondHost({
      connectBroker: async () => new RecordingClient(() => createResult),
    });
    await expect(host.claimInput({
      session,
      writer: "writer-1",
      kind: "human",
      leaseMilliseconds: 10_000,
      idempotencyKey: "claim-idempotency-1",
    })).rejects.toEqual(new SessiondWireNotReadyError("direct host operations"));
  });
});
