import {
  createHash,
  createHash as nodeCreateHash,
  randomBytes,
} from "node:crypto";
import { connect, type Socket } from "node:net";
import type { z } from "zod";
import {
  AppliedPayloadSchema,
  AttachRequestPayloadSchema,
  ClaimAcquirePayloadSchema,
  ClaimResultPayloadSchema,
  CreateBeginPayloadSchema,
  CreateCommitPayloadSchema,
  CreatedPayloadSchema,
  ErrorPayloadSchema,
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPES,
  type FrameTypeName,
  HelloPayloadSchema,
  InputSubmitPayloadSchema,
  InspectedPayloadSchema,
  OrphanDiscardedPayloadSchema,
  OrphanDiscardPayloadSchema,
  PingPongPayloadSchema,
  ResizePayloadSchema,
  SESSION_PROTOCOL_MINOR_RANGE,
  SESSION_PROTOCOL_VERSION,
  SessionSpecSchema,
  TERMINAL_LIMITS,
  TerminatedPayloadSchema,
  TerminatePayloadSchema,
  WelcomePayloadSchema,
  type WireErrorCode,
} from "../../schemas/session-protocol";
import { type DaemonHandshake, expectedDaemonHandshake } from "../handshake";
import { resolveHiveHome } from "../instance-identity";
import { resolveSessiondBinary } from "../sessiond-broker";
import type {
  AttachGrant,
  AttachRequest,
  CaptureRequest,
  CaptureResult,
  CreateResult,
  SessionHost,
  SessionLocator,
  SessionSpec,
} from "./contract";
import {
  adoptHost,
  discardHostInputOrphan,
  executableBuildHash,
  issueHostAttachGrant,
} from "./host-control";
import { createResultFromRecord, launchHost } from "./host-launcher";
import {
  callHost,
  listNeutralSessions,
  readControlSecret,
} from "./host-operations";
import { observeSessiondOutput } from "./sessiond-output-observer";

import {
  HiveTerminalBindingSchema,
  type TerminalHostBindingStore,
} from "./terminal-host-binding";
import type {
  ClaimResult,
  InputReceipt,
  ResizeResult,
  SessionInspection,
  SessionRef,
  TerminalHost,
  TerminationResult,
} from "./terminal-host-contract";

const CAPTURE_COLUMNS = 200;
const CAPTURE_CELL_PX = 10;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Host-authorized resolution modes. A held claim is deliberately an
 * explicit preemption, never an accidental orphan discard. */
export type OrphanDiscardMode = "orphaned" | "held";

/** ORPHAN_DISCARDED is a typed host decision, not a boolean whose false
 * branch can erase the distinction between refusal and preemption. */
export type OrphanDiscardResult =
  | Readonly<{
      state: "discarded";
      priorOwnerViewerId: string;
      priorClaimId: string;
      orphanAgeMilliseconds: string;
      diagnostic: string;
    }>
  | Readonly<{
      state: "preempted";
      priorOwnerViewerId: string;
      priorClaimId: string;
      orphanAgeMilliseconds: null;
      diagnostic: string;
    }>
  | Readonly<{
      state: "refused";
      priorOwnerViewerId: string | null;
      priorClaimId: string | null;
      orphanAgeMilliseconds: string | null;
      diagnostic: string;
    }>;

export type LandedTerminalHost = Pick<
  TerminalHost,
  "claimInput" | "submitInput" | "resize" | "inspect" | "list" | "terminate"
> &
  Pick<SessionHost, "create" | "issueAttach">;

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

export class SessiondCreateAdmissionDisabledError extends Error {
  constructor() {
    super(
      "sessiond create admission requires a Workspace-owned pending open-terminal binding",
    );
    this.name = "SessiondCreateAdmissionDisabledError";
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
  Object.entries(FRAME_TYPES).map(([name, code]) => [
    code,
    name as FrameTypeName,
  ]),
);

export function encodeSessiondFrame(frame: SessiondFrame): Uint8Array {
  if (frame.payload.byteLength > TERMINAL_LIMITS.controlJsonBytesPerFrame) {
    throw new SessiondProtocolError(
      "sessiond control frame exceeds the negotiated v1 cap",
    );
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
          "sessiond control frame exceeds the negotiated v1 cap",
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
      const requestId = view.getBigUint64(FRAME_HEADER.offsets.requestId);
      const streamSeq = view.getBigUint64(FRAME_HEADER.offsets.streamSeq);
      if (requestId === 0n || streamSeq !== 0n) {
        throw new SessiondProtocolError(
          "sessiond control frame has invalid correlation fields",
        );
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
  /** Defaults to the control-RPC budget. Only a create overrides it: reading a
   * record and forking a shell plus a vendor CLI are not the same operation
   * and must not share one deadline. */
  timeoutMilliseconds?: number;
}>;

export interface SessiondControlClient {
  request<Result>(request: SessiondControlRequest<Result>): Promise<Result>;
  close(): void;
}

export interface SessiondBrokerClient extends SessiondControlClient {
  readonly engineBuildId: string | null;
  createTransaction(
    beginPayload: z.infer<typeof CreateBeginPayloadSchema>,
    initialInput: Uint8Array,
  ): Promise<z.infer<typeof CreatedPayloadSchema>>;
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

export class SessiondSocketClient implements SessiondBrokerClient {
  private nextRequestId = 1n;
  private readonly pending = new Map<bigint, PendingRequest>();
  private readonly decoder = new SessiondFrameDecoder();
  private closed = false;
  private controlFrameMaxBytes = TERMINAL_LIMITS.controlJsonBytesPerFrame;
  private streamChunkMaxBytes = TERMINAL_LIMITS.streamChunkBytes;
  private automatedMessageMaxBytes = TERMINAL_LIMITS.automatedMessageBytes;
  private activeCreate: ActiveCreate | null = null;
  private negotiatedEngineBuildId: string | null = null;
  get engineBuildId(): string | null {
    return this.negotiatedEngineBuildId;
  }

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) =>
      this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () =>
      this.fail(new Error("sessiond connection closed")),
    );
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
    if (this.closed)
      return Promise.reject(new Error("sessiond connection is closed"));
    const requestId = this.nextRequestId++;
    const payload = textEncoder.encode(JSON.stringify(request.payload));
    if (payload.byteLength > this.controlFrameMaxBytes) {
      return Promise.reject(
        new SessiondProtocolError(
          "sessiond control frame exceeds the negotiated v1 cap",
        ),
      );
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
      }, request.timeoutMilliseconds ??
        TERMINAL_LIMITS.controlRpcTimeoutMilliseconds);
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
    if (this.closed)
      return Promise.reject(new Error("sessiond connection is closed"));
    if (this.activeCreate !== null) {
      return Promise.reject(
        new SessiondProtocolError(
          "sessiond create transaction is already active",
        ),
      );
    }
    if (initialInput.byteLength > this.automatedMessageMaxBytes) {
      return Promise.reject(
        new SessiondWireError(
          "PAYLOAD_TOO_LARGE",
          "create input exceeds the negotiated automated-message cap",
          null,
        ),
      );
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

  setNegotiatedEngineBuildId(engineBuildId: string | null): void {
    this.negotiatedEngineBuildId = engineBuildId;
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
    for (
      let offset = 0;
      offset < initialInput.byteLength;
      offset += this.streamChunkMaxBytes
    ) {
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
      timeoutMilliseconds: TERMINAL_LIMITS.createRpcTimeoutMilliseconds,
    });
  }

  private writeNoResponseFrame(
    type: "CREATE_BEGIN" | "CREATE_INPUT",
    flags: number,
    streamSeq: bigint,
    payload: Uint8Array,
  ): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("sessiond connection is closed"));
    const cap =
      type === "CREATE_INPUT"
        ? this.streamChunkMaxBytes
        : this.controlFrameMaxBytes;
    if (payload.byteLength > cap) {
      return Promise.reject(
        new SessiondProtocolError(
          "sessiond frame exceeds the negotiated v1 cap",
        ),
      );
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
      this.fail(
        error instanceof Error ? error : new Error("invalid sessiond frame"),
      );
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
        this.fail(
          new SessiondProtocolError(
            "sessiond returned an invalid PING payload",
          ),
        );
        return;
      }
      if (
        frame.flags !== 0 ||
        !PingPongPayloadSchema.safeParse(decoded).success
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
      return;
    }
    if (this.activeCreate?.requestIds.has(frame.requestId)) {
      this.fail(this.errorFromFrame(frame));
      return;
    }
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
    let decoded: unknown;
    try {
      decoded = JSON.parse(textDecoder.decode(frame.payload));
    } catch {
      pending.reject(
        new SessiondProtocolError("sessiond returned invalid JSON"),
      );
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
    const result = pending.responseSchema.safeParse(decoded);
    if (!result.success) {
      pending.reject(
        new SessiondProtocolError(
          "sessiond returned a response outside the frozen schema",
        ),
      );
      return;
    }
    pending.resolve(result.data);
  }

  private errorFromFrame(frame: SessiondFrame): Error {
    if (
      frame.type !== "ERROR" ||
      frame.flags !==
        (FRAME_FLAGS.response | FRAME_FLAGS.final | FRAME_FLAGS.error)
    ) {
      return new SessiondProtocolError(
        "sessiond returned a response to a no-response frame",
      );
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
  /** Test seam: launch a terminal host. Defaults to the real launcher. */
  launchHost?: typeof launchHost;
  /** Test seam: speak to a host directly. Defaults to the real NHOP client. */
  callHost?: typeof callHost;
  /** Test seam: read a host's operation capability. */
  readControlSecret?: typeof readControlSecret;
  /** Test seam: enumerate published terminals. */
  listSessions?: typeof listNeutralSessions;
  /** Test seam: prove ownership of a freshly launched host. */
  adoptHost?: typeof adoptHost;
  /** Test seam: open the host's viewer wire for claim/input/resize. */
  connectDirect?: (session: SessionRef) => Promise<SessiondControlClient>;
  /** Bindings the create path requires; absent disables create admission. */
  pendingBindings?: TerminalHostBindingStore;
  /** Accepted and ignored. Nothing is dialled at startup any more — a host is
   * launched with a capability, so there is no handshake to present. */
  handshake?: () => Promise<unknown>;
}

export class SessiondHost implements LandedTerminalHost {
  private readonly connectDirect: (
    session: SessionRef,
  ) => Promise<SessiondControlClient>;
  private readonly pendingBindings: TerminalHostBindingStore | null;
  private readonly hiveHome: string;
  private readonly repoRoot: string;
  private readonly launchHostProcess: typeof launchHost;
  private readonly callHostDirect: typeof callHost;
  private readonly readControlSecret: typeof readControlSecret;
  private readonly listSessions: typeof listNeutralSessions;
  private readonly adoptHost: typeof adoptHost;

  constructor(options: SessiondHostOptions = {}) {
    const hiveHome = resolveHiveHome(options.hiveHome);
    this.hiveHome = hiveHome;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.launchHostProcess = options.launchHost ?? launchHost;
    this.callHostDirect = options.callHost ?? callHost;
    this.readControlSecret = options.readControlSecret ?? readControlSecret;
    this.listSessions = options.listSessions ?? listNeutralSessions;
    this.adoptHost = options.adoptHost ?? adoptHost;
    const _handshake =
      options.handshake ??
      (() => expectedDaemonHandshake(options.repoRoot ?? process.cwd()));
    this.connectDirect =
      options.connectDirect ??
      (async () => {
        throw new SessiondWireNotReadyError("direct host operations");
      });
    this.pendingBindings = options.pendingBindings ?? null;
  }

  async create(
    spec: SessionSpec,
    initialInput: Uint8Array,
  ): Promise<CreateResult> {
    if (this.pendingBindings === null) {
      throw new SessiondCreateAdmissionDisabledError();
    }
    const parsedSpec = SessionSpecSchema.parse(spec);
    const locator = HiveTerminalBindingSchema.unwrap().shape.locator.parse(
      parsedSpec.locator,
    );
    const binding =
      this.pendingBindings.getTerminalHostBindingByLocator(locator);
    if (binding === null) throw new SessiondCreateAdmissionDisabledError();
    const payload = CreateBeginPayloadSchema.parse({
      ...parsedSpec,
      visibility: binding.visibility,
    });
    const queuedAt = Date.now();
    // A create forks a host, a login shell and a vendor CLI, and the reply
    // waits for all of it — against the same 10 s deadline an INSPECT gets.
    // When a wide burst loses hosts to CREATE_COMMIT timeouts, the two numbers
    // that tell queueing apart from a slow launch are the only ones missing.
    const admittedAt = Date.now();
    try {
      // Hive launches the host itself. There is no broker between them: it was
      // never in the terminal data path, and one process handing descriptors to
      // thirty-one concurrent launches was the 31-wide ceiling — its connection
      // threads parked inside multi-second boots and stopped accepting, so
      // creates that never started failed at HELLO.
      const adoptionSecret = new Uint8Array(randomBytes(32));
      const executablePath = resolveSessiondBinary({ repoRoot: this.repoRoot });
      if (executablePath === null) {
        throw new SessiondProtocolError("hive-sessiond binary was not found");
      }
      try {
        const launched = await this.launchHostProcess({
          hiveHome: this.hiveHome,
          sessionId: locator.sessionId,
          executablePath,
          specJson: JSON.stringify(payload),
          initialInput,
          adoptionSecret,
          readyTimeoutMilliseconds:
            TERMINAL_LIMITS.createRpcTimeoutMilliseconds,
        });
        // Both the stream and the process handle are retained: the stream is
        // the terminal's channel to Hive, and dropping the handle can let the
        // runtime reap a healthy host.
        this.hostControl.set(locator.sessionId, launched.control);
        this.hostProcess.set(locator.sessionId, launched.process);
        this.hostSecret.set(locator.sessionId, adoptionSecret);
        // The host refuses every control verb until ownership is proved, so
        // adoption happens once here rather than per grant.
        await this.adoptHost({
          hiveHome: this.hiveHome,
          sessionId: locator.sessionId,
          locator,
          adoptionSecret,
          buildId: await executableBuildHash(executablePath),
        });
        return createResultFromRecord(launched.record, parsedSpec.argv);
      } finally {
        // Only the slow ones. A create that outruns half its budget separates
        // "queued behind other creates" from "this launch is genuinely slow".
        const launchMs = Date.now() - admittedAt;
        if (launchMs * 2 >= TERMINAL_LIMITS.createRpcTimeoutMilliseconds) {
          console.error(
            `sessiond create ${locator.sessionId} was slow: ` +
              `${admittedAt - queuedAt}ms queued, ${launchMs}ms launching`,
          );
        }
      }
    } catch (error) {
      // Nothing was created, so the pending binding must not survive as a pane.
      this.pendingBindings.releaseUncreatedTerminalHostSession(locator);
      throw error;
    }
  }

  /**
   * Each terminal's control stream, held open after registration.
   *
   * The broker closed this the moment it acknowledged, which is why a host had
   * no way to reach Hive afterwards and readiness had to be polled out of it.
   */
  private readonly hostControl = new Map<string, Socket>();
  private readonly hostProcess = new Map<
    string,
    ReturnType<typeof Bun.spawn>
  >();
  private readonly hostSecret = new Map<string, Uint8Array>();

  /**
   * The engine build the hosts will actually run.
   *
   * This used to be read from a broker's HELLO. It belongs to the linked VT
   * engine, not to any running process, so it is asked of the binary that will
   * be executed — which is the same answer without needing a broker to be up.
   */
  async discoverEngineBuildId(): Promise<string> {
    const cached = this.engineBuildIdCache;
    if (cached !== null) return cached;
    const executablePath = resolveSessiondBinary({ repoRoot: this.repoRoot });
    if (executablePath === null) {
      throw new SessiondProtocolError("hive-sessiond binary was not found");
    }
    const child = Bun.spawn([executablePath, "engine-build-id"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const value = (await new Response(child.stdout).text()).trim();
    if (value.length === 0) {
      throw new SessiondProtocolError("hive-sessiond reported no engine build");
    }
    this.engineBuildIdCache = value;
    return value;
  }

  private engineBuildIdCache: string | null = null;

  /**
   * INPUT_ORPHAN_DISCARD: ask the host for a typed, authorized resolution
   * of an orphaned or held human claim. The host alone may preempt a held claim,
   * and reports that distinct from an orphan discard. See
   * docs/incidents/2026-07-21-messaging-regression.md.
   */
  async discardInputOrphan(
    locator: SessionLocator,
    mode: OrphanDiscardMode,
  ): Promise<OrphanDiscardResult> {
    OrphanDiscardPayloadSchema.parse({ schemaVersion: 1, locator, mode });
    const executablePath = resolveSessiondBinary({ repoRoot: this.repoRoot });
    if (executablePath === null) {
      throw new SessiondProtocolError("hive-sessiond binary was not found");
    }
    const answer = await discardHostInputOrphan({
      hiveHome: this.hiveHome,
      sessionId: locator.sessionId,
      locator,
      mode,
      buildId: await executableBuildHash(executablePath),
    });
    const { schemaVersion: _, ...result } =
      OrphanDiscardedPayloadSchema.parse(answer);
    return result;
  }

  /**
   * The bounded visible-text read behind `hive_terminal_observe`.
   *
   * `capture` is deliberately absent from `LandedTerminalHost`, so nothing ever
   * supplied one and the queen's explicit "show me the screen" tool refused
   * every call with "SessionHost terminal observation is unavailable" — for
   * every vendor, in every deployment. That left observation with no CONTENT
   * path at all: the activity summary carries a derived one-liner, and the pane
   * itself was reachable only by interrupting the agent to ask what it did,
   * which is the one thing observation exists to avoid.
   *
   * It rides the same viewer attach the activity observer uses, because that is
   * the surface that already streams a pane's bytes to a reader who never takes
   * input. This does not focus, claim, resize, or type.
   */
  async capture(
    locator: Parameters<SessionHost["capture"]>[0],
    request: CaptureRequest,
  ): Promise<CaptureResult> {
    // The viewer declares a size for the attach; it never resizes the pane, and
    // the replayed bytes do not depend on it. The result reports the size that
    // produced the text rather than implying knowledge of the real window.
    const rows = Math.max(request.maxRows, 1);
    const geometry = {
      columns: CAPTURE_COLUMNS,
      rows,
      widthPx: CAPTURE_COLUMNS * CAPTURE_CELL_PX,
      heightPx: rows * CAPTURE_CELL_PX,
      cellWidthPx: CAPTURE_CELL_PX,
      cellHeightPx: CAPTURE_CELL_PX,
    } as const;
    const observed = await observeSessiondOutput(
      this,
      locator,
      geometry,
      `hive-daemon:capture:${locator.sessionId}`,
    );
    // The observer reconstructs the screen as the replay streams in, at the
    // geometry the attach declared, so what arrives here is already the cells a
    // terminal would be showing rather than the bytes that painted them.
    const rendered = observed?.screen ?? "";
    return {
      locator,
      outputSeq: observed?.outputThrough ?? "0",
      columns: geometry.columns,
      rows: geometry.rows,
      screen: "primary",
      cursor: { row: 0, column: 0, visible: false },
      text: request.include === "visible-text" ? rendered : null,
      // Truncated when rows were dropped OR the observer itself reported a gap:
      // a reader deciding whether to trust a tail needs both facts, and the
      // viewer's own 32KiB tail cap is exactly the case that would otherwise
      // present a partial screen as a whole one.
      // Truncated when the observer reported a gap: the viewer keeps a bounded
      // tail, so a long-running pane's earliest bytes are already gone and the
      // reconstruction starts mid-session. A reader deciding whether to trust a
      // screen needs to know that.
      truncated: observed?.completeness === "gap",
      sha256: nodeCreateHash("sha256").update(rendered, "utf8").digest("hex"),
    };
  }

  async issueAttach(
    locator: Parameters<SessionHost["issueAttach"]>[0],
    request: AttachRequest,
  ): Promise<AttachGrant> {
    // Validate the request on the way in, exactly as the wire projection did.
    AttachRequestPayloadSchema.parse({ schemaVersion: 1, locator, ...request });
    const inspection = await this.inspect({
      key: locator.sessionId,
      incarnation: String(locator.generation),
    }).catch(() => null);
    return await issueHostAttachGrant({
      hiveHome: this.hiveHome,
      sessionId: locator.sessionId,
      locator,
      request,
      engineBuildId: locator.engineBuildId,
      checkpointSeq:
        inspection?.checkpoints.newest?.throughEventSequence ?? "0",
      outputSeq: inspection?.output.retained.endExclusive ?? "0",
      now: () => new Date(),
    });
  }

  async claimInput(
    request: Parameters<TerminalHost["claimInput"]>[0],
  ): Promise<ClaimResult> {
    const payload = ClaimAcquirePayloadSchema.parse({
      schemaVersion: 1,
      ...request,
    });
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
    const operation =
      request.operation.kind === "bytes"
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
        throw new SessiondProtocolError(
          "sessiond returned a resize result for input",
        );
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
        throw new SessiondProtocolError(
          "sessiond returned an input result for resize",
        );
      }
      return response.result;
    } finally {
      host.close();
    }
  }

  /**
   * Asks the terminal directly.
   *
   * This used to travel daemon → broker → host, with the broker opening a fresh
   * connection to `host.sock` per request and relaying the answer. The spawn
   * path alone polls this dozens of times per agent, so at thirty-one wide
   * every poll queued behind other launches on one accept loop. The answer was
   * always the host's; now it is asked for directly.
   */
  async inspect(session: SessionRef): Promise<SessionInspection> {
    const secret = await this.readControlSecret(this.hiveHome, session);
    const body = await this.callHostDirect({
      hiveHome: this.hiveHome,
      sessionId: session.key,
      session,
      operation: "inspect",
      payload: JSON.stringify({ schemaVersion: 1, includeCheckpoint: true }),
      secret,
      timeoutMilliseconds: TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    });
    const { schemaVersion: _, ...inspection } = InspectedPayloadSchema.parse(
      JSON.parse(body),
    );
    return inspection;
  }

  /**
   * Enumerates terminals from what the hosts themselves published.
   *
   * The broker answered this from a registry it built by launching; Hive
   * launches directly now, so that registry cannot know these hosts. A host
   * that cannot be reached is omitted rather than failing the whole
   * enumeration — one dead terminal must not blind Hive to the rest.
   */
  async list(): Promise<readonly SessionInspection[]> {
    const sessions = await this.listSessions(this.hiveHome);
    const inspected = await Promise.all(
      sessions.map(async (session) => {
        try {
          return await this.inspect(session);
        } catch {
          return null;
        }
      }),
    );
    return inspected.filter((entry) => entry !== null);
  }

  async terminate(
    request: Parameters<TerminalHost["terminate"]>[0],
  ): Promise<TerminationResult> {
    const payload = TerminatePayloadSchema.parse({
      schemaVersion: 1,
      ...request,
    });
    const secret = await this.readControlSecret(this.hiveHome, request.session);
    const body = await this.callHostDirect({
      hiveHome: this.hiveHome,
      sessionId: request.session.key,
      session: request.session,
      operation: "terminate",
      payload: JSON.stringify(payload),
      secret,
      idempotencyKey: request.idempotencyKey,
      timeoutMilliseconds: TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    });
    const { schemaVersion: _, ...result } = TerminatedPayloadSchema.parse(
      JSON.parse(body),
    );
    return result;
  }
}
