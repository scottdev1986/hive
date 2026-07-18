import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FRAME_FLAGS,
  FRAME_HEADER,
  HelloPayloadSchema,
  TerminalHostCreateRequestSchema,
} from "../../schemas/session-protocol";
import type { DaemonHandshake } from "../handshake";
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
  SessiondFrameDecoder,
  SessiondHost,
  SessiondProtocolError,
  SessiondWireNotReadyError,
  type SessiondControlClient,
  type SessiondControlRequest,
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

class RecordingClient implements SessiondControlClient {
  readonly requests: SessiondControlRequest<unknown>[] = [];
  closed = false;

  constructor(private readonly respond: (request: SessiondControlRequest<unknown>) => unknown) {}

  async request<Result>(request: SessiondControlRequest<Result>): Promise<Result> {
    this.requests.push(request as SessiondControlRequest<unknown>);
    return request.responseSchema.parse(this.respond(request as SessiondControlRequest<unknown>));
  }

  close(): void {
    this.closed = true;
  }
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

  test("handshakes and creates over the production Unix-socket path", async () => {
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
                  engineBuildId: null,
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
          } else {
            socket.write(encodeSessiondFrame({
              type: "CREATED",
              flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
              requestId: frame.requestId,
              streamSeq: 0n,
              payload: new TextEncoder().encode(JSON.stringify(createResult)),
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
      });
      await expect(host.create(createRequest)).resolves.toEqual(createResult);
      expect(received.map((frame) => frame.type)).toEqual([
        "HELLO",
        "PONG",
        "CREATE_BEGIN",
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
      expect(JSON.parse(new TextDecoder().decode(received[2]?.payload))).toEqual(
        createRequest,
      );
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
    const host = new SessiondHost({
      hiveHome: directory,
      handshake: async () => handshake,
    });

    const failure = host.list().catch((error) => error);
    await expect(failure).resolves.toBeInstanceOf(SessiondBrokerUnavailableError);
    await expect(failure).resolves.toMatchObject({
      socketPath: join(directory, "runtime", "sessiond", "broker.sock"),
    });
  });

  test("sends create as one exact CREATE_BEGIN and returns exact CREATED", async () => {
    const broker = new RecordingClient((request) => {
      expect(request.requestType).toBe("CREATE_BEGIN");
      expect(request.responseType).toBe("CREATED");
      expect(request.payload).toEqual(TerminalHostCreateRequestSchema.parse(createRequest));
      return createResult;
    });
    const host = new SessiondHost({ connectBroker: async () => broker });

    await expect(host.create(createRequest)).resolves.toEqual(createResult);
    expect(broker.requests).toHaveLength(1);
    expect(broker.closed).toBe(true);
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
