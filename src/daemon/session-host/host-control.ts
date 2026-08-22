import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { isRecord, isString } from "../../shared/is-record";
import {
  CaptureRequestSchema,
  CaptureResultSchema,
  FRAME_FLAGS,
  type FrameTypeName,
  GrantRegisterPayloadSchema,
  HostAdoptPayloadSchema,
  SESSION_PROTOCOL_VERSION,
  TERMINAL_LIMITS,
} from "../../schemas/session-protocol";
import type {
  AttachGrant,
  AttachRequest,
  CaptureRequest,
  CaptureResult,
  SessionLocator,
} from "./session-host-contract";
import { type JsonValue, requireJsonValue } from "../../shared/json";
import { encodeSessiondFrame, SessiondFrameDecoder } from "./sessiond-host";
import { hostSocketPath, HostOperationError } from "./host-operations";

const CONTROL_REQUEST_ID = 2n;

const GRANT_LIFETIME_MS = 30_000;

type BrokerHelloPayload = {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly instanceId: string;
  readonly protocol: {
    readonly major: number;
    readonly minMinor: number;
    readonly maxMinor: number;
  };
  readonly clientRole: "broker";
};

/** The connection handshake a host requires before any verb. The host compares the build id it is told here against the one carried by adoption, so a mismatched executable is refused rather than adopted. Request id 1 is the handshake's; every verb that follows uses id 2. */
function helloPayload(instanceId: string, buildId: string): BrokerHelloPayload {
  return {
    schemaVersion: 1,
    buildId,
    instanceId,
    protocol: {
      major: SESSION_PROTOCOL_VERSION.major,
      minMinor: SESSION_PROTOCOL_VERSION.minor,
      maxMinor: SESSION_PROTOCOL_VERSION.minor,
    },
    clientRole: "broker",
  };
}

async function exchange<T>(
  socketPath: string,
  type: FrameTypeName,
  payload: T,
  timeoutMilliseconds: number,
  hello: { instanceId: string; buildId: string },
  responseType: FrameTypeName = type,
): Promise<JsonValue> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return await new Promise<JsonValue>((resolve, reject) => {
    const decoder = new SessiondFrameDecoder();
    let settled = false;
    const socket = connect(socketPath);
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      outcome();
    };
    const timer = setTimeout(
      () =>
        finish(() => reject(new HostOperationError(`host ${type} timed out`))),
      timeoutMilliseconds,
    );
    timer.unref?.();
    socket.once("error", (error) =>
      finish(() =>
        reject(
          new HostOperationError("host control socket failed", {
            cause: error,
          }),
        ),
      ),
    );
    socket.once("close", () =>
      finish(() =>
        reject(new HostOperationError("host closed before it answered")),
      ),
    );
    socket.once("connect", () => {
      socket.write(
        encodeSessiondFrame({
          type: "HELLO",
          flags: 0,
          requestId: 1n,
          streamSeq: 0n,
          payload: new TextEncoder().encode(
            JSON.stringify(helloPayload(hello.instanceId, hello.buildId)),
          ),
        }),
      );
    });
    socket.on("data", (chunk: Buffer | string) => {
      let frames: ReturnType<SessiondFrameDecoder["push"]>;
      try {
        frames = decoder.push(isString(chunk) ? Buffer.from(chunk) : chunk);
      } catch (error) {
        finish(() =>
          reject(
            new HostOperationError("host sent an invalid frame", {
              cause: error,
            }),
          ),
        );
        return;
      }
      for (const frame of frames) {
        // The verb is sent only once the host has welcomed the connection.
        if (frame.type === "WELCOME") {
          socket.write(
            encodeSessiondFrame({
              type,
              flags: 0,
              requestId: CONTROL_REQUEST_ID,
              streamSeq: 0n,
              payload: bytes,
            }),
          );
          continue;
        }
        if (frame.type === "ERROR") {
          finish(() =>
            reject(
              new HostOperationError(
                `host refused ${type}: ${new TextDecoder().decode(frame.payload)}`,
              ),
            ),
          );
          return;
        }
        if (frame.type !== responseType) continue;
        if (frame.requestId !== CONTROL_REQUEST_ID) continue;
        if (frame.flags !== (FRAME_FLAGS.response | FRAME_FLAGS.final))
          continue;
        finish(() => {
          try {
            resolve(
              requireJsonValue(
                JSON.parse(new TextDecoder().decode(frame.payload)),
                `host ${type} answer`,
              ),
            );
          } catch (error) {
            reject(
              new HostOperationError(`host ${type} answer was not JSON`, {
                cause: error,
              }),
            );
          }
        });
        return;
      }
    });
  });
}

/** Proves ownership of a host with its launch-time capability. The host refuses every control verb until this succeeds, so it runs once per launch. The secret is the `adopt.cap` the launcher wrote — not the neutral `control.cap`, which authorises a different wire. */
export async function adoptHost(options: {
  hiveHome: string;
  sessionId: string;
  locator: SessionLocator;
  adoptionSecret: Uint8Array;
  buildId: string;
}): Promise<void> {
  const payload = HostAdoptPayloadSchema.parse({
    schemaVersion: 1,
    adoptionSecretHex: Buffer.from(options.adoptionSecret).toString("hex"),
    expectedLocator: options.locator,
    brokerBuildId: options.buildId,
    protocol: {
      major: SESSION_PROTOCOL_VERSION.major,
      minor: SESSION_PROTOCOL_VERSION.minor,
    },
    operation: "adopt",
  });
  await exchange(
    hostSocketPath(options.hiveHome, options.sessionId),
    "HOST_ADOPT",
    payload,
    TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    { instanceId: options.locator.instanceId, buildId: options.buildId },
  );
}

/** Issues a one-use viewer grant. The token is minted here and the host is told only its hash, so a grant that leaks from disk cannot be replayed into an attach. The viewer connects to the host's own socket with the token; Hive is not in that path. */
export async function issueHostAttachGrant(options: {
  hiveHome: string;
  sessionId: string;
  locator: SessionLocator;
  request: AttachRequest;
  engineBuildId: string;
  checkpointSeq: string;
  outputSeq: string;
  now: () => Date;
}): Promise<AttachGrant> {
  const token = randomBytes(32).toString("hex");
  const grantTokenSha256 = `sha256:${createHash("sha256").update(token).digest("hex")}`;
  const expiresAt = new Date(
    options.now().getTime() + GRANT_LIFETIME_MS,
  ).toISOString();
  const payload = GrantRegisterPayloadSchema.parse({
    schemaVersion: 1,
    grantTokenSha256,
    viewerId: options.request.viewerId,
    operations: options.request.operations,
    expiresAt,
    geometry: options.request.geometry,
  });
  const answer = await exchange(
    hostSocketPath(options.hiveHome, options.sessionId),
    "GRANT_REGISTER",
    payload,
    TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    {
      instanceId: options.locator.instanceId,
      buildId: options.engineBuildId,
    },
  );
  const registered = isRecord(answer) && answer.registered === true;
  if (!registered) {
    throw new HostOperationError("host refused the viewer grant");
  }
  return {
    locator: options.locator,
    endpoint: hostSocketPath(options.hiveHome, options.sessionId),
    token,
    expiresAt,
    engineBuildId: options.engineBuildId,
    checkpointSeq: options.checkpointSeq,
    outputSeq: options.outputSeq,
    operations: options.request.operations,
  };
}

type ExecutableHashEntry = Readonly<{
  identity: string;
  digest: Promise<string>;
  token: symbol;
}>;

/** Hashing the multi-megabyte sessiond binary on every control request is wasted I/O, but its dev path is stable across in-place rebuilds. Cache against the file itself — including inode and nanosecond change metadata — so replacing or rewriting those bytes cannot leave a daemon authenticating the prior build. */
const executableHashes = new Map<string, ExecutableHashEntry>();

async function executableFileIdentity(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(
    ":",
  );
}

export async function executableBuildHash(path: string): Promise<string> {
  const identity = await executableFileIdentity(path);
  const cached = executableHashes.get(path);
  if (cached?.identity === identity) return await cached.digest;

  const token = Symbol(path);
  const digest = (async () => {
    const bytes = await readFile(path);
    const hashed = createHash("sha256").update(bytes).digest("hex");
    if ((await executableFileIdentity(path)) === identity) return hashed;
    if (executableHashes.get(path)?.token === token) {
      executableHashes.delete(path);
    }
    return await executableBuildHash(path);
  })();
  const entry = { identity, digest, token };
  executableHashes.set(path, entry);
  try {
    return await digest;
  } catch (error) {
    if (executableHashes.get(path)?.token === token) {
      executableHashes.delete(path);
    }
    throw error;
  }
}

export async function captureHostTerminal(options: {
  hiveHome: string;
  sessionId: string;
  locator: SessionLocator;
  request: CaptureRequest;
  buildId: string;
}): Promise<CaptureResult> {
  const answer = await exchange(
    hostSocketPath(options.hiveHome, options.sessionId),
    "HOST_CAPTURE",
    CaptureRequestSchema.parse(options.request),
    TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    { instanceId: options.locator.instanceId, buildId: options.buildId },
    "HOST_CAPTURED",
  );
  return CaptureResultSchema.parse(answer);
}
