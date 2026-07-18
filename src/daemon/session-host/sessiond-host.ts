import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { z } from "zod";
import {
  expectedDaemonHandshake,
  type DaemonHandshake,
} from "../handshake";
import { resolveHiveHome } from "../tmux-sessions";
import type {
  ClaimResult,
  CreateRequest,
  CreateResult,
  InputReceipt,
  ResizeResult,
  SessionInspection,
  SessionRef,
  TerminalHost,
  TerminationResult,
} from "./terminal-host-contract";
import {
  AppliedPayloadSchema,
  ClaimAcquirePayloadSchema,
  ClaimResultPayloadSchema,
  CreateBeginPayloadSchema,
  CreateCommitPayloadSchema,
  CreatedPayloadSchema,
  ErrorPayloadSchema,
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPES,
  HelloPayloadSchema,
  InspectPayloadSchema,
  InspectedPayloadSchema,
  InputSubmitPayloadSchema,
  ListPayloadSchema,
  ListedPayloadSchema,
  PingPongPayloadSchema,
  ResizePayloadSchema,
  SESSION_PROTOCOL_MINOR_RANGE,
  SESSION_PROTOCOL_VERSION,
  TERMINAL_LIMITS,
  TerminalHostCreateRequestSchema,
  TerminalHostCreateResultSchema,
  TerminatePayloadSchema,
  TerminatedPayloadSchema,
  WelcomePayloadSchema,
  type FrameTypeName,
  type WireErrorCode,
} from "../../schemas/session-protocol";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type LandedTerminalHost = Pick<
  TerminalHost,
  | "create"
  | "claimInput"
  | "submitInput"
  | "resize"
  | "inspect"
  | "list"
  | "terminate"
>;

export class SessiondProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessiondProtocolError";
  }
}

export class SessiondWireError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
    readonly diagnosticId: string | null,
  ) {
    super(`sessiond ${code}: ${message}`);
    this.name = "SessiondWireError";
  }
}

export class SessiondWireNotReadyError extends Error {
  constructor(readonly operation: string) {
    super(`sessiond ${operation} requires the frozen neutral host-attach wire`);
    this.name = "SessiondWireNotReadyError";
  }
}

export class SessiondBrokerUnavailableError extends Error {
  constructor(readonly socketPath: string, cause: unknown) {
    super(`sessiond broker is unavailable at ${socketPath}`, { cause });
    this.name = "SessiondBrokerUnavailableError";
  }
}

export type SessiondFrame = Readonly<{
  type: FrameTypeName;
  flags: number;
  requestId: bigint;
  streamSeq: bigint;
  payload: Uint8Array;
}>;

const frameNames = new Map<number, FrameTypeName>(
  Object.entries(FRAME_TYPES).map(([name, code]) => [code, name as FrameTypeName]),
);

export function encodeSessiondFrame(frame: SessiondFrame): Uint8Array {
  if (frame.payload.byteLength > TERMINAL_LIMITS.controlJsonBytesPerFrame) {
    throw new SessiondProtocolError("sessiond control frame exceeds the negotiated v1 cap");
  }
  const bytes = new Uint8Array(FRAME_HEADER.bytes + frame.payload.byteLength);
  bytes.set(FRAME_HEADER.magicBytes, FRAME_HEADER.offsets.magic);
  const view = new DataView(bytes.buffer);
  view.setUint8(FRAME_HEADER.offsets.major, SESSION_PROTOCOL_VERSION.major);
  view.setUint8(FRAME_HEADER.offsets.minor, SESSION_PROTOCOL_VERSION.minor);
  view.setUint16(FRAME_HEADER.offsets.type, FRAME_TYPES[frame.type]);
  view.setUint16(FRAME_HEADER.offsets.flags, frame.flags);
  view.setUint16(FRAME_HEADER.offsets.reserved, 0);
  view.setUint32(FRAME_HEADER.offsets.payloadLength, frame.payload.byteLength);
  view.setBigUint64(FRAME_HEADER.offsets.requestId, frame.requestId);
  view.setBigUint64(FRAME_HEADER.offsets.streamSeq, frame.streamSeq);
  bytes.set(frame.payload, FRAME_HEADER.bytes);
  return bytes;
}

export class SessiondFrameDecoder {
  private buffered = new Uint8Array();

  constructor(
    private controlFrameMaxBytes = TERMINAL_LIMITS.controlJsonBytesPerFrame,
  ) {}

  setControlFrameMaxBytes(value: number): void {
    this.controlFrameMaxBytes = value;
  }

  push(chunk: Uint8Array): SessiondFrame[] {
    const combined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    combined.set(this.buffered);
    combined.set(chunk, this.buffered.byteLength);
    this.buffered = combined;

    const frames: SessiondFrame[] = [];
    while (this.buffered.byteLength >= FRAME_HEADER.bytes) {
      const view = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        this.buffered.byteLength,
      );
      for (const [index, expected] of FRAME_HEADER.magicBytes.entries()) {
        if (this.buffered[index] !== expected) {
          throw new SessiondProtocolError("sessiond frame has invalid magic");
        }
      }
      if (
        view.getUint8(FRAME_HEADER.offsets.major) !== SESSION_PROTOCOL_VERSION.major ||
        view.getUint8(FRAME_HEADER.offsets.minor) < SESSION_PROTOCOL_MINOR_RANGE.min ||
        view.getUint8(FRAME_HEADER.offsets.minor) > SESSION_PROTOCOL_MINOR_RANGE.max
      ) {
        throw new SessiondProtocolError("sessiond frame has an unsupported protocol version");
      }
      const flags = view.getUint16(FRAME_HEADER.offsets.flags);
      if (
        (flags & ~FRAME_FLAGS.allowedMask) !== 0 ||
        view.getUint16(FRAME_HEADER.offsets.reserved) !== 0
      ) {
        throw new SessiondProtocolError("sessiond frame has invalid flags or reserved bits");
      }
      const typeCode = view.getUint16(FRAME_HEADER.offsets.type);
      const payloadLength = view.getUint32(FRAME_HEADER.offsets.payloadLength);
      if (payloadLength > this.controlFrameMaxBytes) {
        throw new SessiondProtocolError("sessiond control frame exceeds the negotiated v1 cap");
      }
      const frameLength = FRAME_HEADER.bytes + payloadLength;
      if (this.buffered.byteLength < frameLength) break;
      const type = frameNames.get(typeCode);
      if (type === undefined) {
        if ((typeCode & FRAME_HEADER.optionalTypeBit) !== 0) {
          this.buffered = this.buffered.slice(frameLength);
          continue;
        }
        throw new SessiondProtocolError(`sessiond returned unsupported frame type ${typeCode}`);
      }
      const requestId = view.getBigUint64(FRAME_HEADER.offsets.requestId);
      const streamSeq = view.getBigUint64(FRAME_HEADER.offsets.streamSeq);
      if (requestId === 0n || streamSeq !== 0n) {
        throw new SessiondProtocolError("sessiond control frame has invalid correlation fields");
      }
      frames.push({
        type,
        flags,
        requestId,
        streamSeq,
        payload: this.buffered.slice(FRAME_HEADER.bytes, frameLength),
      });
      this.buffered = this.buffered.slice(frameLength);
    }
    return frames;
  }
}

export type SessiondControlRequest<Result> = Readonly<{
  requestType: FrameTypeName;
  responseType: FrameTypeName;
  payload: unknown;
  responseSchema: z.ZodType<Result>;
  flags?: number;
}>;

export interface SessiondControlClient {
  request<Result>(request: SessiondControlRequest<Result>): Promise<Result>;
  close(): void;
}

type PendingRequest = {
  responseType: FrameTypeName;
  responseSchema: z.ZodType<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ActiveCreate = {
  readonly requestIds: Set<bigint>;
  reject: (error: Error) => void;
};

export type SessiondNegotiatedLimits = Readonly<{
  controlFrameMaxBytes: number;
  streamChunkMaxBytes: number;
  automatedMessageMaxBytes: number;
}>;

export class SessiondSocketClient implements SessiondControlClient {
  private nextRequestId = 1n;
  private readonly pending = new Map<bigint, PendingRequest>();
  private readonly decoder = new SessiondFrameDecoder();
  private closed = false;
  private controlFrameMaxBytes = TERMINAL_LIMITS.controlJsonBytesPerFrame;
  private streamChunkMaxBytes = TERMINAL_LIMITS.streamChunkBytes;
  private automatedMessageMaxBytes = TERMINAL_LIMITS.automatedMessageBytes;
  private activeCreate: ActiveCreate | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) =>
      this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("sessiond connection closed")));
  }

  static connect(path: string): Promise<SessiondSocketClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(new SessiondSocketClient(socket));
      });
    });
  }

  request<Result>(request: SessiondControlRequest<Result>): Promise<Result> {
    if (this.closed) return Promise.reject(new Error("sessiond connection is closed"));
    const requestId = this.nextRequestId++;
    const payload = textEncoder.encode(JSON.stringify(request.payload));
    if (payload.byteLength > this.controlFrameMaxBytes) {
      return Promise.reject(new SessiondProtocolError(
        "sessiond control frame exceeds the negotiated v1 cap",
      ));
    }
    const bytes = encodeSessiondFrame({
      type: request.requestType,
      flags: request.flags ?? 0,
      requestId,
      streamSeq: 0n,
      payload,
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`sessiond ${request.requestType} request timed out`));
      }, TERMINAL_LIMITS.controlRpcTimeoutMilliseconds);
      timeout.unref?.();
      this.pending.set(requestId, {
        responseType: request.responseType,
        responseSchema: request.responseSchema as z.ZodType<unknown>,
        resolve: (value) => resolve(value as Result),
        reject,
        timeout,
      });
      this.socket.write(bytes, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  createTransaction(
    beginPayload: z.infer<typeof CreateBeginPayloadSchema>,
    initialInput: Uint8Array,
  ): Promise<z.infer<typeof CreatedPayloadSchema>> {
    if (this.closed) return Promise.reject(new Error("sessiond connection is closed"));
    if (this.activeCreate !== null) {
      return Promise.reject(new SessiondProtocolError(
        "sessiond create transaction is already active",
      ));
    }
    if (initialInput.byteLength > this.automatedMessageMaxBytes) {
      return Promise.reject(new SessiondWireError(
        "PAYLOAD_TOO_LARGE",
        "create input exceeds the negotiated automated-message cap",
        null,
      ));
    }
    const input = initialInput.slice();

    let rejectActive!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectActive = reject;
    });
    const active: ActiveCreate = {
      requestIds: new Set(),
      reject: rejectActive,
    };
    this.activeCreate = active;
    const operation = this.writeCreateTransaction(beginPayload, input);
    return Promise.race([operation, interrupted]).finally(() => {
      if (this.activeCreate === active) this.activeCreate = null;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.fail(new Error("sessiond connection closed"));
  }

  setControlFrameMaxBytes(value: number): void {
    this.controlFrameMaxBytes = value;
    this.decoder.setControlFrameMaxBytes(value);
  }

  setNegotiatedLimits(limits: SessiondNegotiatedLimits): void {
    this.setControlFrameMaxBytes(limits.controlFrameMaxBytes);
    this.streamChunkMaxBytes = limits.streamChunkMaxBytes;
    this.automatedMessageMaxBytes = limits.automatedMessageMaxBytes;
  }

  private async writeCreateTransaction(
    beginPayload: z.infer<typeof CreateBeginPayloadSchema>,
    initialInput: Uint8Array,
  ): Promise<z.infer<typeof CreatedPayloadSchema>> {
    await this.writeNoResponseFrame(
      "CREATE_BEGIN",
      0,
      0n,
      textEncoder.encode(JSON.stringify(beginPayload)),
    );
    for (let offset = 0; offset < initialInput.byteLength; offset += this.streamChunkMaxBytes) {
      await this.writeNoResponseFrame(
        "CREATE_INPUT",
        FRAME_FLAGS.contentSensitive,
        BigInt(offset),
        initialInput.slice(offset, offset + this.streamChunkMaxBytes),
      );
    }
    const commit = CreateCommitPayloadSchema.parse({
      schemaVersion: 1,
      totalLength: initialInput.byteLength,
      sha256: createHash("sha256").update(initialInput).digest("hex"),
    });
    return this.request({
      requestType: "CREATE_COMMIT",
      responseType: "CREATED",
      payload: commit,
      responseSchema: CreatedPayloadSchema,
    });
  }

  private writeNoResponseFrame(
    type: "CREATE_BEGIN" | "CREATE_INPUT",
    flags: number,
    streamSeq: bigint,
    payload: Uint8Array,
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error("sessiond connection is closed"));
    const cap = type === "CREATE_INPUT"
      ? this.streamChunkMaxBytes
      : this.controlFrameMaxBytes;
    if (payload.byteLength > cap) {
      return Promise.reject(new SessiondProtocolError(
        "sessiond frame exceeds the negotiated v1 cap",
      ));
    }
    const requestId = this.nextRequestId++;
    this.activeCreate?.requestIds.add(requestId);
    const bytes = encodeSessiondFrame({
      type,
      flags,
      requestId,
      streamSeq,
      payload,
    });
    return new Promise((resolve, reject) => {
      this.socket.write(bytes, (error) => {
        if (error === null || error === undefined) {
          resolve();
          return;
        }
        this.activeCreate?.requestIds.delete(requestId);
        reject(error);
      });
    });
  }

  private receive(chunk: Uint8Array): void {
    let frames: SessiondFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("invalid sessiond frame"));
      return;
    }
    for (const frame of frames) this.receiveFrame(frame);
  }

  private receiveFrame(frame: SessiondFrame): void {
    if (frame.type === "PING") {
      let decoded: unknown;
      try {
        decoded = JSON.parse(textDecoder.decode(frame.payload));
      } catch {
        this.fail(new SessiondProtocolError("sessiond returned an invalid PING payload"));
        return;
      }
      if (frame.flags !== 0 || !PingPongPayloadSchema.safeParse(decoded).success) {
        this.fail(new SessiondProtocolError("sessiond returned an invalid PING frame"));
        return;
      }
      this.socket.write(encodeSessiondFrame({
        type: "PONG",
        flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
        requestId: frame.requestId,
        streamSeq: 0n,
        payload: frame.payload,
      }));
      return;
    }
    if (this.activeCreate?.requestIds.has(frame.requestId)) {
      this.fail(this.errorFromFrame(frame));
      return;
    }
    const pending = this.pending.get(frame.requestId);
    if (pending === undefined) {
      this.fail(new SessiondProtocolError("sessiond returned an uncorrelated response"));
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(frame.requestId);
    if (frame.type === "ERROR") {
      pending.reject(this.errorFromFrame(frame));
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(textDecoder.decode(frame.payload));
    } catch {
      pending.reject(new SessiondProtocolError("sessiond returned invalid JSON"));
      return;
    }
    if (
      frame.type !== pending.responseType ||
      frame.flags !== (FRAME_FLAGS.response | FRAME_FLAGS.final)
    ) {
      pending.reject(new SessiondProtocolError("sessiond returned the wrong response frame"));
      return;
    }
    const result = pending.responseSchema.safeParse(decoded);
    if (!result.success) {
      pending.reject(new SessiondProtocolError("sessiond returned a response outside the frozen schema"));
      return;
    }
    pending.resolve(result.data);
  }

  private errorFromFrame(frame: SessiondFrame): Error {
    if (
      frame.type !== "ERROR" ||
      frame.flags !== (FRAME_FLAGS.response | FRAME_FLAGS.final | FRAME_FLAGS.error)
    ) {
      return new SessiondProtocolError("sessiond returned a response to a no-response frame");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(textDecoder.decode(frame.payload));
    } catch {
      return new SessiondProtocolError("sessiond returned invalid JSON");
    }
    const error = ErrorPayloadSchema.safeParse(decoded);
    return error.success
      ? new SessiondWireError(
          error.data.code,
          error.data.message,
          error.data.diagnosticId,
        )
      : new SessiondProtocolError("sessiond returned an invalid error payload");
  }

  private fail(error: Error): void {
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
    this.activeCreate?.reject(error);
    this.activeCreate = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface SessiondHostOptions {
  repoRoot?: string;
  hiveHome?: string;
  handshake?: () => Promise<DaemonHandshake>;
  connectBroker?: () => Promise<SessiondControlClient>;
  connectDirect?: (session: SessionRef) => Promise<SessiondControlClient>;
}

async function connectBroker(
  path: string,
  handshake: DaemonHandshake,
): Promise<SessiondControlClient> {
  let client: SessiondSocketClient;
  try {
    client = await SessiondSocketClient.connect(path);
  } catch (error) {
    throw new SessiondBrokerUnavailableError(path, error);
  }
  try {
    const hello = HelloPayloadSchema.parse({
      schemaVersion: 1,
      buildId: handshake.buildHash,
      instanceId: handshake.instanceId,
      protocol: {
        major: SESSION_PROTOCOL_VERSION.major,
        minMinor: SESSION_PROTOCOL_MINOR_RANGE.min,
        maxMinor: SESSION_PROTOCOL_MINOR_RANGE.max,
      },
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
    const welcome = await client.request({
      requestType: "HELLO",
      responseType: "WELCOME",
      payload: hello,
      responseSchema: WelcomePayloadSchema,
    });
    if (
      welcome.endpointRole !== "broker" ||
      welcome.instanceId !== handshake.instanceId ||
      welcome.protocol.major !== SESSION_PROTOCOL_VERSION.major ||
      welcome.protocol.minor < SESSION_PROTOCOL_MINOR_RANGE.min ||
      welcome.protocol.minor > SESSION_PROTOCOL_MINOR_RANGE.max
    ) {
      throw new SessiondProtocolError("sessiond broker WELCOME does not match this daemon");
    }
    client.setNegotiatedLimits(welcome.limits);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export class SessiondHost implements LandedTerminalHost {
  private readonly connectBroker: () => Promise<SessiondControlClient>;
  private readonly connectDirect: (
    session: SessionRef,
  ) => Promise<SessiondControlClient>;

  constructor(options: SessiondHostOptions = {}) {
    const hiveHome = resolveHiveHome(options.hiveHome);
    const handshake = options.handshake ?? (() =>
      expectedDaemonHandshake(options.repoRoot ?? process.cwd()));
    this.connectBroker = options.connectBroker ?? (async () =>
      connectBroker(
        join(hiveHome, "runtime", "sessiond", "broker.sock"),
        await handshake(),
      ));
    this.connectDirect = options.connectDirect ?? (async () => {
      throw new SessiondWireNotReadyError("direct host operations");
    });
  }

  async create(request: CreateRequest): Promise<CreateResult> {
    const payload = TerminalHostCreateRequestSchema.parse(request);
    const broker = await this.connectBroker();
    try {
      return await broker.request({
        requestType: "CREATE_BEGIN",
        responseType: "CREATED",
        payload,
        responseSchema: TerminalHostCreateResultSchema,
      });
    } finally {
      broker.close();
    }
  }

  async claimInput(
    request: Parameters<TerminalHost["claimInput"]>[0],
  ): Promise<ClaimResult> {
    const payload = ClaimAcquirePayloadSchema.parse({ schemaVersion: 1, ...request });
    const host = await this.connectDirect(request.session);
    try {
      const response = await host.request({
        requestType: "CLAIM_ACQUIRE",
        responseType: "CLAIM_RESULT",
        payload,
        responseSchema: ClaimResultPayloadSchema,
      });
      return response.result;
    } finally {
      host.close();
    }
  }

  async submitInput(
    request: Parameters<TerminalHost["submitInput"]>[0],
  ): Promise<InputReceipt> {
    const operation = request.operation.kind === "bytes"
      ? {
        kind: "bytes" as const,
        encoding: "base64" as const,
        bytes: Buffer.from(request.operation.bytes).toString("base64"),
      }
      : request.operation;
    const payload = InputSubmitPayloadSchema.parse({
      schemaVersion: 1,
      ...request,
      operation,
    });
    const host = await this.connectDirect(request.session);
    try {
      const response = await host.request({
        requestType: "INPUT_SUBMIT",
        responseType: "APPLIED",
        flags: FRAME_FLAGS.contentSensitive,
        payload,
        responseSchema: AppliedPayloadSchema,
      });
      if (response.resultKind !== "input") {
        throw new SessiondProtocolError("sessiond returned a resize result for input");
      }
      return response.receipt;
    } finally {
      host.close();
    }
  }

  async resize(
    request: Parameters<TerminalHost["resize"]>[0],
  ): Promise<ResizeResult> {
    const payload = ResizePayloadSchema.parse({ schemaVersion: 1, ...request });
    const host = await this.connectDirect(request.session);
    try {
      const response = await host.request({
        requestType: "RESIZE",
        responseType: "APPLIED",
        payload,
        responseSchema: AppliedPayloadSchema,
      });
      if (response.resultKind !== "resize") {
        throw new SessiondProtocolError("sessiond returned an input result for resize");
      }
      return response.result;
    } finally {
      host.close();
    }
  }

  async inspect(session: SessionRef): Promise<SessionInspection> {
    const payload = InspectPayloadSchema.parse({ schemaVersion: 1, session });
    const broker = await this.connectBroker();
    try {
      const { schemaVersion: _, ...inspection } = await broker.request({
        requestType: "INSPECT",
        responseType: "INSPECTED",
        payload,
        responseSchema: InspectedPayloadSchema,
      });
      return inspection;
    } finally {
      broker.close();
    }
  }

  async list(): Promise<readonly SessionInspection[]> {
    const payload = ListPayloadSchema.parse({ schemaVersion: 1 });
    const broker = await this.connectBroker();
    try {
      const response = await broker.request({
        requestType: "LIST",
        responseType: "LISTED",
        payload,
        responseSchema: ListedPayloadSchema,
      });
      return response.entries;
    } finally {
      broker.close();
    }
  }

  async terminate(
    request: Parameters<TerminalHost["terminate"]>[0],
  ): Promise<TerminationResult> {
    const payload = TerminatePayloadSchema.parse({ schemaVersion: 1, ...request });
    const broker = await this.connectBroker();
    try {
      const { schemaVersion: _, ...result } = await broker.request({
        requestType: "TERMINATE",
        responseType: "TERMINATED",
        payload,
        responseSchema: TerminatedPayloadSchema,
      });
      return result;
    } finally {
      broker.close();
    }
  }
}
