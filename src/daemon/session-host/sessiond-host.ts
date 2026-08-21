import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { resolveHiveHome } from "../../hive-home/home";
import {
  AppliedPayloadSchema,
  AttachRequestPayloadSchema,
  CreateBeginPayloadSchema,
  FRAME_FLAGS,
  FRAME_HEADER,
  FRAME_TYPES,
  type FrameTypeName,
  InputSubmitPayloadSchema,
  InspectedPayloadSchema,
  ResizePayloadSchema,
  SESSION_PROTOCOL_MINOR_RANGE,
  SESSION_PROTOCOL_VERSION,
  SessionSpecSchema,
  TERMINAL_LIMITS,
  TerminatedPayloadSchema,
  TerminatePayloadSchema,
  type WireErrorCode,
} from "../../schemas/session-protocol";
import { systemClock } from "../../shared/clock";
import { errorMessage } from "../../shared/error-message";
import {
  adoptHost,
  captureHostTerminal,
  executableBuildHash,
  issueHostAttachGrant,
} from "./host-control";
import { createResultFromRecord, launchHost } from "./host-launcher";
import {
  callHost,
  hostDirectory,
  listNeutralSessions,
  readControlSecret,
} from "./host-operations";
import { sameSessionLocator } from "./locators";
import type {
  AttachGrant,
  AttachRequest,
  CaptureRequest,
  CaptureResult,
  CreateResult,
  SessionHost,
  SessionSpec,
} from "./session-host-contract";
import { resolveSessiondBinary } from "./sessiond-broker";

import {
  HiveTerminalBindingSchema,
  type TerminalHostBindingStore,
} from "./terminal-host-binding";
import type {
  InputReceipt,
  ResizeResult,
  SessionInspection,
  SessionRef,
  TerminalHost,
  TerminationResult,
} from "./terminal-host-contract";

export type LandedTerminalHost = Pick<
  TerminalHost,
  "submitInput" | "resize" | "inspect" | "list" | "terminate"
> &
  Pick<SessionHost, "create" | "capture" | "issueAttach"> &
  HostExitWaiter;

export type HostExitWaitResult =
  | Readonly<{ kind: "managed-exit"; exitCode: number | null }>
  | Readonly<{ kind: "inherited" }>
  | Readonly<{ kind: "aborted" }>;

export interface HostExitWaiter {
  waitForHostExit(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<HostExitWaitResult>;
}

const HostFinalExitSchema = z.object({
  schemaVersion: z.literal(1),
  exitCode: z.number().int().min(0).max(255).nullable(),
});

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
}>;

export interface SessiondControlClient {
  request<Result>(request: SessiondControlRequest<Result>): Promise<Result>;
  close(): void;
}

export interface SessiondHostOptions {
  repoRoot?: string;
  hiveHome?: string;
  launchHost?: typeof launchHost;
  callHost?: typeof callHost;
  readControlSecret?: typeof readControlSecret;
  listSessions?: typeof listNeutralSessions;
  adoptHost?: typeof adoptHost;
  captureHost?: typeof captureHostTerminal;
  connectDirect?: (session: SessionRef) => Promise<SessiondControlClient>;
  pendingBindings?: TerminalHostBindingStore;
  handshake?: () => Promise<void>;
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
  private readonly captureHost: typeof captureHostTerminal;

  constructor(options: SessiondHostOptions = {}) {
    this.hiveHome = resolveHiveHome(options.hiveHome);
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.launchHostProcess = options.launchHost ?? launchHost;
    this.callHostDirect = options.callHost ?? callHost;
    this.readControlSecret = options.readControlSecret ?? readControlSecret;
    this.listSessions = options.listSessions ?? listNeutralSessions;
    this.adoptHost = options.adoptHost ?? adoptHost;
    this.captureHost = options.captureHost ?? captureHostTerminal;
    this.connectDirect =
      options.connectDirect ??
      (async () => {
        throw new SessiondWireNotReadyError("direct host operations");
      });
    this.pendingBindings = options.pendingBindings ?? null;
  }

  async create(spec: SessionSpec): Promise<CreateResult> {
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
    // A create forks a host, a login shell and a vendor CLI, and the reply waits for all of it — against the same 10 s deadline an INSPECT gets. When a wide burst loses hosts to create timeouts, the two numbers that tell queueing apart from a slow launch are the only ones missing.
    const admittedAt = Date.now();
    let hostCreated = false;
    try {
      const adoptionSecret = new Uint8Array(randomBytes(32));
      const executablePath = resolveSessiondBinary({ repoRoot: this.repoRoot });
      // Only the real launcher needs the built binary on disk; an injected launcher owns its own launch story, including on a checkout that has never built the native host.
      if (executablePath === null && this.launchHostProcess === launchHost) {
        throw new SessiondProtocolError("hive-sessiond binary was not found");
      }
      try {
        const launched = await this.launchHostProcess({
          hiveHome: this.hiveHome,
          sessionId: locator.sessionId,
          executablePath: executablePath ?? "hive-sessiond",
          specJson: JSON.stringify(payload),
          adoptionSecret,
          readyTimeoutMilliseconds:
            TERMINAL_LIMITS.createRpcTimeoutMilliseconds,
        });
        hostCreated = true;
        // Both the stream and the process handle are retained: the stream is the terminal's channel to Hive, and dropping the handle can let the runtime reap a healthy host.
        this.hostControl.set(locator.sessionId, launched.control);
        this.hostProcess.set(locator.sessionId, launched.process);
        this.hostSecret.set(locator.sessionId, adoptionSecret);
        // The host refuses every control verb until ownership is proved, so adoption happens once here rather than per grant.
        await this.adoptHost({
          hiveHome: this.hiveHome,
          sessionId: locator.sessionId,
          locator,
          adoptionSecret,
          buildId:
            executablePath === null
              ? "unbuilt"
              : await executableBuildHash(executablePath),
        });
        return createResultFromRecord(launched.record, parsedSpec.argv);
      } finally {
        // Only the slow ones. A create that outruns half its budget separates "queued behind other creates" from "this launch is genuinely slow".
        const launchMs = Date.now() - admittedAt;
        if (launchMs * 2 >= TERMINAL_LIMITS.createRpcTimeoutMilliseconds) {
          console.error(
            `sessiond create ${locator.sessionId} was slow: ` +
              `${admittedAt - queuedAt}ms queued, ${launchMs}ms launching`,
          );
        }
      }
    } catch (error) {
      if (!hostCreated) {
        this.pendingBindings.releaseUncreatedTerminalHostSession(locator);
        throw error;
      }
      // The binding is the durable route back to a host that registered but
      // failed adoption or result validation. Dropping it would turn a created
      // terminal into an uninspectable launch and erase the distinction from a
      // refusal that happened before any host existed.
      throw new SessiondProtocolError(
        `sessiond host ${locator.sessionId} was created but launch finalization failed: ${errorMessage(error)}`,
      );
    }
  }

  private readonly hostControl = new Map<string, Socket>();
  private readonly hostProcess = new Map<
    string,
    ReturnType<typeof Bun.spawn>
  >();
  private readonly hostSecret = new Map<string, Uint8Array>();

  async waitForHostExit(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<HostExitWaitResult> {
    const child = this.hostProcess.get(sessionId);
    if (child === undefined) return { kind: "inherited" };
    if (signal.aborted) return { kind: "aborted" };
    const outcome = await new Promise<"exited" | "aborted">((resolve) => {
      let settled = false;
      const finish = (value: "exited" | "aborted"): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      void child.exited.then(() => finish("exited"));
    });
    if (outcome === "aborted") return { kind: "aborted" };
    return {
      kind: "managed-exit",
      exitCode: await this.readFinalExitCode(sessionId),
    };
  }

  private async readFinalExitCode(sessionId: string): Promise<number | null> {
    try {
      const value = HostFinalExitSchema.parse(
        JSON.parse(
          await readFile(
            join(hostDirectory(this.hiveHome, sessionId), "final.json"),
            "utf8",
          ),
        ),
      );
      return value.exitCode;
    } catch {
      return null;
    }
  }

  /** The engine build the hosts will actually run. The build belongs to the linked VT engine, not a running process, so ask the binary that will be executed without requiring a broker. */
  async discoverEngineBuildId(): Promise<string> {
    const executablePath = resolveSessiondBinary({ repoRoot: this.repoRoot });
    if (executablePath === null) {
      throw new SessiondProtocolError("hive-sessiond binary was not found");
    }
    const executableHash = await executableBuildHash(executablePath);
    const cached = this.engineBuildIdCache;
    if (cached?.executableHash === executableHash) return cached.engineBuildId;
    const child = Bun.spawn([executablePath, "engine-build-id"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const value = (await new Response(child.stdout).text()).trim();
    if (value.length === 0) {
      throw new SessiondProtocolError("hive-sessiond reported no engine build");
    }
    if ((await executableBuildHash(executablePath)) !== executableHash) {
      return await this.discoverEngineBuildId();
    }
    this.engineBuildIdCache = { executableHash, engineBuildId: value };
    return value;
  }

  private engineBuildIdCache: Readonly<{
    executableHash: string;
    engineBuildId: string;
  }> | null = null;

  /** The bounded visible-text read behind `hive_terminal_observe`. The host reads its libghostty grid directly. This does not attach a viewer, focus, claim, resize, or type. */
  async capture(
    locator: Parameters<SessionHost["capture"]>[0],
    request: CaptureRequest,
  ): Promise<CaptureResult> {
    const executablePath = resolveSessiondBinary({ repoRoot: this.repoRoot });
    if (executablePath === null) {
      throw new SessiondProtocolError("hive-sessiond binary was not found");
    }
    const capture = await this.captureHost({
      hiveHome: this.hiveHome,
      sessionId: locator.sessionId,
      locator,
      request,
      buildId: await executableBuildHash(executablePath),
    });
    if (!sameSessionLocator(capture.locator, locator)) {
      throw new SessiondProtocolError(
        "sessiond host capture returned a different terminal generation",
      );
    }
    return capture;
  }

  async issueAttach(
    locator: Parameters<SessionHost["issueAttach"]>[0],
    request: AttachRequest,
  ): Promise<AttachGrant> {
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
      now: systemClock,
    });
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

  /** Enumerates terminals from what the hosts themselves published. The broker answered this from a registry it built by launching; Hive launches directly now, so that registry cannot know these hosts. A host that cannot be reached is omitted rather than failing the whole enumeration — one dead terminal must not blind Hive to the rest. */
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
