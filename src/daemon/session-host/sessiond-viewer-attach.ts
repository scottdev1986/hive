import { connect, type Socket } from "node:net";
import type { z } from "zod";
import { definedFields } from "../../shared/defined-fields";
import { type JsonValue, safeJsonParse } from "../../shared/json";
import { isString } from "../../shared/is-record";
import {
  type TerminalGeometry,
  AppliedPayloadSchema,
  ErrorPayloadSchema,
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPES,
  type FrameTypeName,
  HelloPayloadSchema,
  HostAttachPayloadSchema,
  InputSubmitPayloadSchema,
  PingPongPayloadSchema,
  SESSION_PROTOCOL_MINOR_RANGE,
  SESSION_PROTOCOL_VERSION,
  TERMINAL_LIMITS,
  WelcomePayloadSchema,
} from "../../schemas/session-protocol";
import type { AttachGrant, SessionLocator } from "./session-host-contract";
import {
  encodeSessiondFrame,
  type SessiondFrame,
  SessiondProtocolError,
  SessiondWireError,
} from "./sessiond-host";
import type {
  ExpectedForeground,
  InputReceipt,
  SessionRef,
} from "./terminal-host-contract";
import { TerminalScreen } from "./terminal-screen";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const OUTPUT_REPLAY_TIMEOUT_MS = 1_000;
const OUTPUT_QUIET_MS = 120;
const OUTPUT_POLL_MS = 20;

const frameNames = new Map<number, FrameTypeName>(
  Object.entries(FRAME_TYPES).map(([name, code]) => [
    code,
    // SAFETY: The surrounding code already established this contract.
    name as FrameTypeName,
  ]),
);

class ViewerFrameDecoder {
  private buffered = new Uint8Array();

  constructor(
    private controlFrameMaxBytes = TERMINAL_LIMITS.controlJsonBytesPerFrame,
  ) {}

  setControlFrameMaxBytes(value: number): void {
    this.controlFrameMaxBytes = value;
  }

  push(chunk: Uint8Array): SessiondFrame[] {
    const combined = new Uint8Array(
      this.buffered.byteLength + chunk.byteLength,
    );
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
        view.getUint8(FRAME_HEADER.offsets.major) !==
          SESSION_PROTOCOL_VERSION.major ||
        view.getUint8(FRAME_HEADER.offsets.minor) <
          SESSION_PROTOCOL_MINOR_RANGE.min ||
        view.getUint8(FRAME_HEADER.offsets.minor) >
          SESSION_PROTOCOL_MINOR_RANGE.max
      ) {
        throw new SessiondProtocolError(
          "sessiond frame has an unsupported protocol version",
        );
      }
      const flags = view.getUint16(FRAME_HEADER.offsets.flags);
      if (
        (flags & ~FRAME_FLAGS.allowedMask) !== 0 ||
        view.getUint16(FRAME_HEADER.offsets.reserved) !== 0
      ) {
        throw new SessiondProtocolError(
          "sessiond frame has invalid flags or reserved bits",
        );
      }
      const typeCode = view.getUint16(FRAME_HEADER.offsets.type);
      const payloadLength = view.getUint32(FRAME_HEADER.offsets.payloadLength);
      if (payloadLength > this.controlFrameMaxBytes) {
        throw new SessiondProtocolError(
          "sessiond frame exceeds the negotiated v1 cap",
        );
      }
      const frameLength = FRAME_HEADER.bytes + payloadLength;
      if (this.buffered.byteLength < frameLength) break;
      const type = frameNames.get(typeCode);
      if (type === undefined) {
        if ((typeCode & FRAME_HEADER.optionalTypeBit) !== 0) {
          this.buffered = this.buffered.slice(frameLength);
          continue;
        }
        throw new SessiondProtocolError(
          `sessiond returned unsupported frame type ${typeCode}`,
        );
      }
      frames.push({
        type,
        flags,
        requestId: view.getBigUint64(FRAME_HEADER.offsets.requestId),
        streamSeq: view.getBigUint64(FRAME_HEADER.offsets.streamSeq),
        payload: this.buffered.slice(FRAME_HEADER.bytes, frameLength),
      });
      this.buffered = this.buffered.slice(frameLength);
    }
    return frames;
  }
}

type PendingResponse = {
  responseType: FrameTypeName;
  resolve: (frame: SessiondFrame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface ViewerAttachDependencies {
  locator: SessionLocator;
  grant: AttachGrant;
  geometry: TerminalGeometry;
  viewerId: string;
  connect?: (endpoint: string) => Promise<Socket>;
  handshakeTimeoutMs?: number;
}

export class SessiondViewerAttachClient {
  private readonly decoder = new ViewerFrameDecoder();
  private readonly pending = new Map<bigint, PendingResponse>();
  private nextRequestId = 1n;
  private closed = false;
  private failure: Error | null = null;
  private maxInputTransactionBytes = TERMINAL_LIMITS.inputTransactionBytes;
  private outputHighWater = 0n;
  private lastOutputAt = 0;
  private attachRequestId: bigint | null = null;
  private screen: TerminalScreen | null = null;
  private readonly outputDecoder = new TextDecoder("utf-8");
  private outputComplete = true;
  private outputWaiter: Readonly<{
    target: bigint;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> | null = null;

  private constructor(
    private readonly socket: Socket,
    private readonly deps: ViewerAttachDependencies,
    private readonly afterSeq: string,
  ) {
    socket.on("data", (chunk) =>
      this.receive(isString(chunk) ? Buffer.from(chunk) : chunk),
    );
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () =>
      this.fail(new Error("sessiond viewer connection closed")),
    );
  }

  static async attach(
    deps: ViewerAttachDependencies,
  ): Promise<SessiondViewerAttachClient> {
    return SessiondViewerAttachClient.connect(deps, deps.grant.outputSeq);
  }

  /** Read what the pane is currently showing, without taking input from it. The cursor is 0 — everything the host still retains — and not the grant's `checkpointSeq`. That field names the newest checkpoint, so attaching at it asks sessiond to replay only what follows the base state. A viewer that persisted between calls could add that delta to a screen it already held; this one is opened per observation and holds nothing, and it discards the SNAPSHOT_BYTES the host offers as the base. Skipping the base while dropping its snapshot can report a complete observation with none of the pane's existing text. Zero is also the one cursor sessiond will never refuse: above `output_seq` the host fails the attach outright rather than clamping. */
  static async observeOutput(deps: ViewerAttachDependencies): Promise<
    Readonly<{
      outputThrough: string;
      screen: string;
      completeness: "complete" | "gap";
    }>
  > {
    const client = await SessiondViewerAttachClient.connect(deps, "0", {
      columns: deps.geometry.columns,
      rows: deps.geometry.rows,
    });
    try {
      await client.settleReplay(deps.grant.outputSeq);
      return {
        outputThrough: client.outputHighWater.toString(),
        screen: client.screen?.text() ?? "",
        completeness: client.outputComplete ? "complete" : "gap",
      };
    } finally {
      client.close();
    }
  }

  private async settleReplay(target: string): Promise<void> {
    const through = BigInt(target);
    if (through > 0n) {
      await this.waitForOutput(target);
      return;
    }
    const deadline = Date.now() + OUTPUT_REPLAY_TIMEOUT_MS;
    for (;;) {
      const quietFor = Date.now() - this.lastOutputAt;
      if (this.lastOutputAt !== 0 && quietFor >= OUTPUT_QUIET_MS) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, OUTPUT_POLL_MS);
        timer.unref?.();
      });
    }
  }

  private static async connect(
    deps: ViewerAttachDependencies,
    afterSeq: string,
    render?: Readonly<{ columns: number; rows: number }>,
  ): Promise<SessiondViewerAttachClient> {
    const open = deps.connect ?? defaultConnect;
    const socket = await open(deps.grant.endpoint);
    const client = new SessiondViewerAttachClient(socket, deps, afterSeq);
    if (render !== undefined) {
      client.screen = new TerminalScreen(render.columns, render.rows);
    }
    try {
      await client.handshake();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private async handshake(): Promise<void> {
    const hello = HelloPayloadSchema.parse({
      schemaVersion: 1,
      buildId: `hive-daemon-viewer/${this.deps.locator.instanceId}`,
      instanceId: this.deps.locator.instanceId,
      protocol: {
        major: SESSION_PROTOCOL_VERSION.major,
        minMinor: SESSION_PROTOCOL_MINOR_RANGE.min,
        maxMinor: SESSION_PROTOCOL_MINOR_RANGE.max,
      },
      clientRole: "viewer",
      grantToken: this.deps.grant.token,
    });
    const welcomeFrame = await this.request("HELLO", "WELCOME", 0, hello);
    const welcome = this.decodeResponse(welcomeFrame, WelcomePayloadSchema);
    if (
      welcome.endpointRole !== "host" ||
      welcome.instanceId !== this.deps.locator.instanceId ||
      welcome.protocol.major !== SESSION_PROTOCOL_VERSION.major ||
      welcome.protocol.minor < SESSION_PROTOCOL_MINOR_RANGE.min ||
      welcome.protocol.minor > SESSION_PROTOCOL_MINOR_RANGE.max
    ) {
      throw new SessiondProtocolError(
        "sessiond host WELCOME does not match this attach",
      );
    }
    this.maxInputTransactionBytes = welcome.limits.maxInputTransactionBytes;
    this.decoder.setControlFrameMaxBytes(welcome.limits.controlFrameMaxBytes);

    const hostAttach = HostAttachPayloadSchema.parse({
      schemaVersion: 1,
      locator: this.deps.locator,
      token: this.deps.grant.token,
      geometry: this.deps.geometry,
      afterSeq: this.afterSeq,
    });
    this.outputHighWater = BigInt(this.afterSeq);
    const attachRequestId = this.nextRequestId++;
    this.attachRequestId = attachRequestId;
    this.writeFrame(
      "HOST_ATTACH",
      0,
      0n,
      textEncoder.encode(JSON.stringify(hostAttach)),
      attachRequestId,
    );
  }

  private waitForOutput(target: string): Promise<void> {
    const through = BigInt(target);
    if (this.outputHighWater >= through) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.outputWaiter = null;
        reject(new Error("sessiond output replay timed out"));
      }, OUTPUT_REPLAY_TIMEOUT_MS);
      timeout.unref?.();
      this.outputWaiter = { target: through, resolve, reject, timeout };
    });
  }

  async injectAutomated(
    request: Readonly<{
      session: SessionRef;
      transactionId: string;
      idempotencyKey: string;
      bytes: Uint8Array;
      action: "deliver" | "keys" | "submit";
      expectedForeground?: ExpectedForeground;
      isPromptPending?: () => boolean;
    }>,
  ): Promise<
    | Readonly<{ kind: "receipt"; receipt: InputReceipt }>
    | Readonly<{ kind: "stale" }>
  > {
    if (request.bytes.byteLength > this.maxInputTransactionBytes) {
      throw new SessiondWireError(
        "PAYLOAD_TOO_LARGE",
        `automated input is ${request.bytes.byteLength} bytes; host cap is ${this.maxInputTransactionBytes}`,
        null,
      );
    }
    if (request.isPromptPending?.() === false) return { kind: "stale" };

    const submitPayload = InputSubmitPayloadSchema.parse({
      schemaVersion: 1,
      session: request.session,
      provenance: "automation",
      action: request.action,
      transactionId: request.transactionId,
      idempotencyKey: request.idempotencyKey,
      ...definedFields({
        expectedForeground: request.expectedForeground,
      }),
      operation: {
        kind: "bytes",
        encoding: "base64",
        bytes: Buffer.from(request.bytes).toString("base64"),
      },
    });
    const applied = this.decodeResponse(
      await this.request(
        "INPUT_SUBMIT",
        "APPLIED",
        FRAME_FLAGS.contentSensitive,
        submitPayload,
      ),
      AppliedPayloadSchema,
    );
    if (applied.resultKind !== "input") {
      throw new SessiondProtocolError(
        "sessiond returned a non-input result for INPUT_SUBMIT",
      );
    }
    return { kind: "receipt", receipt: applied.receipt };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        this.failure ?? new Error("sessiond viewer connection closed"),
      );
    }
    this.pending.clear();
  }

  private request(
    requestType: FrameTypeName,
    responseType: FrameTypeName,
    flags: number,
    payload: JsonValue,
  ): Promise<SessiondFrame> {
    if (this.closed)
      return Promise.reject(
        this.failure ?? new Error("viewer connection is closed"),
      );
    const requestId = this.nextRequestId++;
    const bytes = textEncoder.encode(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`sessiond ${requestType} request timed out`));
      }, this.deps.handshakeTimeoutMs ?? TERMINAL_LIMITS.controlRpcTimeoutMilliseconds);
      timeout.unref?.();
      this.pending.set(requestId, { responseType, resolve, reject, timeout });
      try {
        this.writeFrame(requestType, flags, 0n, bytes, requestId);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeFrame(
    type: FrameTypeName,
    flags: number,
    streamSeq: bigint,
    payload: Uint8Array,
    requestId = this.nextRequestId++,
  ): void {
    const frame = encodeSessiondFrame({
      type,
      flags,
      requestId,
      streamSeq,
      payload,
    });
    this.socket.write(frame);
  }

  private decodeResponse<T>(frame: SessiondFrame, schema: z.ZodType<T>): T {
    let decoded: unknown;
    try {
      decoded = JSON.parse(textDecoder.decode(frame.payload));
    } catch {
      throw new SessiondProtocolError("sessiond returned invalid JSON");
    }
    const result = schema.safeParse(decoded);
    if (!result.success) {
      throw new SessiondProtocolError(
        "sessiond returned a response outside the frozen schema",
      );
    }
    return result.data;
  }

  private receive(chunk: Uint8Array): void {
    let frames: SessiondFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("invalid sessiond frame"),
      );
      return;
    }
    for (const frame of frames) this.dispatch(frame);
  }

  private dispatch(frame: SessiondFrame): void {
    switch (frame.type) {
      case "PING":
        this.answerPing(frame);
        return;
      case "OUTPUT":
        this.acknowledgeOutput(frame);
        return;
      case "ATTACH_READY":
        if (
          frame.requestId !== this.attachRequestId ||
          frame.flags !== (FRAME_FLAGS.response | FRAME_FLAGS.final) ||
          frame.payload.byteLength !== 0
        ) {
          this.fail(
            new SessiondProtocolError(
              "sessiond returned an invalid ATTACH_READY frame",
            ),
          );
        }
        return;
      case "SNAPSHOT_BEGIN":
      case "SNAPSHOT_BYTES":
      case "EVENT":
      case "DETACH":
        return;
      default:
        this.resolvePending(frame);
    }
  }

  private answerPing(frame: SessiondFrame): void {
    if (
      frame.flags !== 0 ||
      !PingPongPayloadSchema.safeParse(safeJson(frame.payload)).success
    ) {
      this.fail(
        new SessiondProtocolError("sessiond returned an invalid PING frame"),
      );
      return;
    }
    this.socket.write(
      encodeSessiondFrame({
        type: "PONG",
        flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
        requestId: frame.requestId,
        streamSeq: 0n,
        payload: frame.payload,
      }),
    );
  }

  private acknowledgeOutput(frame: SessiondFrame): void {
    const throughSeq = frame.streamSeq + BigInt(frame.payload.byteLength);
    if (throughSeq <= this.outputHighWater) return;
    if (frame.streamSeq !== this.outputHighWater) this.outputComplete = false;
    this.screen?.write(
      this.outputDecoder.decode(frame.payload, { stream: true }),
    );
    this.outputHighWater = throughSeq;
    this.lastOutputAt = Date.now();
    if (
      this.outputWaiter !== null &&
      this.outputHighWater >= this.outputWaiter.target
    ) {
      clearTimeout(this.outputWaiter.timeout);
      const resolve = this.outputWaiter.resolve;
      this.outputWaiter = null;
      resolve();
    }
    const ack = {
      schemaVersion: 1,
      resultKind: "output",
      throughSeq: throughSeq.toString(),
    };
    try {
      this.writeFrame(
        "APPLIED",
        0,
        0n,
        textEncoder.encode(JSON.stringify(ack)),
      );
    } catch {}
  }

  private resolvePending(frame: SessiondFrame): void {
    const pending = this.pending.get(frame.requestId);
    if (pending === undefined) {
      this.fail(
        new SessiondProtocolError("sessiond returned an uncorrelated response"),
      );
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(frame.requestId);
    if (frame.type === "ERROR") {
      pending.reject(this.errorFromFrame(frame));
      return;
    }
    if (
      frame.type !== pending.responseType ||
      frame.flags !== (FRAME_FLAGS.response | FRAME_FLAGS.final)
    ) {
      pending.reject(
        new SessiondProtocolError("sessiond returned the wrong response frame"),
      );
      return;
    }
    pending.resolve(frame);
  }

  private errorFromFrame(frame: SessiondFrame): Error {
    if (
      frame.flags !==
      (FRAME_FLAGS.response | FRAME_FLAGS.final | FRAME_FLAGS.error)
    ) {
      return new SessiondProtocolError(
        "sessiond returned a malformed error frame",
      );
    }
    const parsed = ErrorPayloadSchema.safeParse(safeJson(frame.payload));
    return parsed.success
      ? new SessiondWireError(
          parsed.data.code,
          parsed.data.message,
          parsed.data.diagnosticId,
        )
      : new SessiondProtocolError("sessiond returned an invalid error payload");
  }

  private fail(error: Error): void {
    if (this.failure === null) this.failure = error;
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.outputWaiter !== null) {
      clearTimeout(this.outputWaiter.timeout);
      this.outputWaiter.reject(error);
      this.outputWaiter = null;
    }
  }
}

function safeJson(payload: Uint8Array): JsonValue {
  return safeJsonParse(textDecoder.decode(payload)) ?? null;
}

function defaultConnect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}
