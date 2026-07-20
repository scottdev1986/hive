import { connect, type Socket } from "node:net";
import type { z } from "zod";
import {
  AppliedPayloadSchema,
  ClaimAcquirePayloadSchema,
  ClaimResultPayloadSchema,
  ErrorPayloadSchema,
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPES,
  HelloPayloadSchema,
  HostAttachPayloadSchema,
  InputSubmitPayloadSchema,
  PingPongPayloadSchema,
  SESSION_PROTOCOL_MINOR_RANGE,
  SESSION_PROTOCOL_VERSION,
  TERMINAL_LIMITS,
  WelcomePayloadSchema,
  type FrameTypeName,
} from "../../schemas/session-protocol";
import {
  encodeSessiondFrame,
  SessiondProtocolError,
  SessiondWireError,
  type SessiondFrame,
} from "./sessiond-host";
import type { TerminalGeometry } from "../../schemas/session-protocol";
import type { SessionLocator, AttachGrant } from "./contract";
import type { SessionRef, InputReceipt } from "./terminal-host-contract";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const frameNames = new Map<number, FrameTypeName>(
  Object.entries(FRAME_TYPES).map(([name, code]) => [code, name as FrameTypeName]),
);

/**
 * Stream-tolerant §20 frame decoder for the viewer wire.
 *
 * The daemon's control-only {@link SessiondFrameDecoder} rejects any frame with
 * `streamSeq != 0`; a HOST_ATTACH connection immediately receives SNAPSHOT/OUTPUT
 * stream frames that carry a nonzero byte offset in `streamSeq`. This decoder
 * accepts both and leaves ordering/correlation to the client.
 */
class ViewerFrameDecoder {
  private buffered = new Uint8Array();

  constructor(private controlFrameMaxBytes = TERMINAL_LIMITS.controlJsonBytesPerFrame) {}

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
        throw new SessiondProtocolError("sessiond frame exceeds the negotiated v1 cap");
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
  /** Opens the host.sock UDS named by the grant endpoint. Overridable in tests. */
  connect?: (endpoint: string) => Promise<Socket>;
  handshakeTimeoutMs?: number;
}

/**
 * A single daemon-side §20 viewer connection to a neutral host's `host.sock`.
 *
 * It performs the frozen attach handshake (HELLO(viewer)+grant → WELCOME →
 * HOST_ATTACH) and then, on one open connection, acquires an automation input
 * claim, submits one transaction, and releases the claim. The claim lives in the
 * host keyed by this connection's viewer id; closing the socket drops it
 * (`onViewerDetached`), so claim → submit → release MUST share this one
 * connection — which is why this is not projected through the per-call
 * connect/close of {@link SessiondHost.claimInput}/`submitInput`.
 *
 * Incoming OUTPUT frames are acknowledged with the §20 APPLIED high-water so the
 * host does not backpressure the viewer during the inject; SNAPSHOT/EVENT frames
 * are consumed and PING is answered.
 */
export class SessiondViewerAttachClient {
  private readonly decoder = new ViewerFrameDecoder();
  private readonly pending = new Map<bigint, PendingResponse>();
  private nextRequestId = 1n;
  private closed = false;
  private failure: Error | null = null;
  private maxInputTransactionBytes = TERMINAL_LIMITS.inputTransactionBytes;
  private outputHighWater = 0n;
  private activeClaimToken: string | null = null;

  private constructor(
    private readonly socket: Socket,
    private readonly deps: ViewerAttachDependencies,
  ) {
    socket.on("data", (chunk) =>
      this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("sessiond viewer connection closed")));
  }

  /** Connect, complete the viewer handshake, and return an attached client. */
  static async attach(
    deps: ViewerAttachDependencies,
  ): Promise<SessiondViewerAttachClient> {
    const open = deps.connect ?? defaultConnect;
    const socket = await open(deps.grant.endpoint);
    const client = new SessiondViewerAttachClient(socket, deps);
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
      throw new SessiondProtocolError("sessiond host WELCOME does not match this attach");
    }
    this.maxInputTransactionBytes = welcome.limits.maxInputTransactionBytes;
    this.decoder.setControlFrameMaxBytes(welcome.limits.controlFrameMaxBytes);

    // HOST_ATTACH is unsolicited — the host answers by streaming SNAPSHOT/OUTPUT,
    // never a correlated frame — so it is sent fire-and-forget.
    const hostAttach = HostAttachPayloadSchema.parse({
      schemaVersion: 1,
      locator: this.deps.locator,
      token: this.deps.grant.token,
      geometry: this.deps.geometry,
      afterSeq: this.deps.grant.outputSeq,
    });
    this.outputHighWater = BigInt(this.deps.grant.outputSeq);
    this.writeFrame("HOST_ATTACH", 0, 0n, textEncoder.encode(JSON.stringify(hostAttach)));
  }

  /**
   * Acquire an automation claim and submit one input transaction on this
   * connection. Returns the frozen receipt, or `null` when the arbiter declines
   * the claim (a human owns or orphaned it) — never steal a held human claim
   * (I3/I4). The caller marks `injected`, never `applied`.
   */
  async injectAutomated(request: Readonly<{
    session: SessionRef;
    writer: string;
    transactionId: string;
    idempotencyKey: string;
    bytes: Uint8Array;
    leaseMilliseconds: number;
  }>): Promise<InputReceipt | null> {
    if (request.bytes.byteLength > this.maxInputTransactionBytes) {
      throw new SessiondWireError(
        "PAYLOAD_TOO_LARGE",
        `automated input is ${request.bytes.byteLength} bytes; host cap is ${this.maxInputTransactionBytes}`,
        null,
      );
    }
    const claimPayload = ClaimAcquirePayloadSchema.parse({
      schemaVersion: 1,
      session: request.session,
      writer: request.writer,
      kind: "automation",
      leaseMilliseconds: request.leaseMilliseconds,
      idempotencyKey: `${request.idempotencyKey}:claim`,
    });
    const claimResult = this.decodeResponse(
      await this.request("CLAIM_ACQUIRE", "CLAIM_RESULT", 0, claimPayload),
      ClaimResultPayloadSchema,
    ).result;
    if (claimResult.state !== "granted") {
      // Denied/unknown — a human owns the arbiter or it is unavailable. Leave the
      // envelope queued; the arbiter, not this client, is the never-steal truth.
      return null;
    }
    this.activeClaimToken = claimResult.claim.token;

    const submitPayload = InputSubmitPayloadSchema.parse({
      schemaVersion: 1,
      session: request.session,
      claimToken: claimResult.claim.token,
      transactionId: request.transactionId,
      idempotencyKey: request.idempotencyKey,
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
      throw new SessiondProtocolError("sessiond returned a non-input result for INPUT_SUBMIT");
    }
    return applied.receipt;
  }

  /** Release any held claim (best effort) and close the socket. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.activeClaimToken !== null && this.failure === null) {
      const release = {
        schemaVersion: 1,
        session: {
          key: this.deps.locator.sessionId,
          incarnation: String(this.deps.locator.generation),
        },
        claimToken: this.activeClaimToken,
        kind: "submit",
      };
      try {
        this.writeFrame("CLAIM_RELEASE", 0, 0n, textEncoder.encode(JSON.stringify(release)));
      } catch {
        // The host also frees the claim on our disconnect; a failed release is
        // not worth surfacing over the receipt we already have.
      }
    }
    this.activeClaimToken = null;
    // Graceful half-close flushes the release before FIN; a hard destroy could
    // drop it. The host frees the claim either way (onViewerDetached).
    this.socket.end();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failure ?? new Error("sessiond viewer connection closed"));
    }
    this.pending.clear();
  }

  private request(
    requestType: FrameTypeName,
    responseType: FrameTypeName,
    flags: number,
    payload: unknown,
  ): Promise<SessiondFrame> {
    if (this.closed) return Promise.reject(this.failure ?? new Error("viewer connection is closed"));
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
    const frame = encodeSessiondFrame({ type, flags, requestId, streamSeq, payload });
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
      throw new SessiondProtocolError("sessiond returned a response outside the frozen schema");
    }
    return result.data;
  }

  private receive(chunk: Uint8Array): void {
    let frames: SessiondFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("invalid sessiond frame"));
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
      case "SNAPSHOT_BEGIN":
      case "SNAPSHOT_BYTES":
      case "EVENT":
      case "DETACH":
        // Consumed: the daemon injector does not render, but must drain the
        // stream so the socket buffer does not stall.
        return;
      default:
        this.resolvePending(frame);
    }
  }

  private answerPing(frame: SessiondFrame): void {
    if (frame.flags !== 0 || !PingPongPayloadSchema.safeParse(safeJson(frame.payload)).success) {
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
  }

  private acknowledgeOutput(frame: SessiondFrame): void {
    const throughSeq = frame.streamSeq + BigInt(frame.payload.byteLength);
    if (throughSeq <= this.outputHighWater) return;
    this.outputHighWater = throughSeq;
    const ack = {
      schemaVersion: 1,
      resultKind: "output",
      throughSeq: throughSeq.toString(),
    };
    try {
      this.writeFrame("APPLIED", 0, 0n, textEncoder.encode(JSON.stringify(ack)));
    } catch {
      // A failed ack only risks backpressure; the inflight request will still
      // resolve or time out on its own.
    }
  }

  private resolvePending(frame: SessiondFrame): void {
    const pending = this.pending.get(frame.requestId);
    if (pending === undefined) {
      // An uncorrelated control frame on the viewer wire is a protocol break.
      this.fail(new SessiondProtocolError("sessiond returned an uncorrelated response"));
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
      pending.reject(new SessiondProtocolError("sessiond returned the wrong response frame"));
      return;
    }
    pending.resolve(frame);
  }

  private errorFromFrame(frame: SessiondFrame): Error {
    if (frame.flags !== (FRAME_FLAGS.response | FRAME_FLAGS.final | FRAME_FLAGS.error)) {
      return new SessiondProtocolError("sessiond returned a malformed error frame");
    }
    const parsed = ErrorPayloadSchema.safeParse(safeJson(frame.payload));
    return parsed.success
      ? new SessiondWireError(parsed.data.code, parsed.data.message, parsed.data.diagnosticId)
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
  }
}

function safeJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(payload));
  } catch {
    return null;
  }
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
