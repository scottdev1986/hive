import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import {
  FRAME_FLAGS,
  type FrameTypeName,
  GrantRegisterPayloadSchema,
  HostAdoptPayloadSchema,
  SESSION_PROTOCOL_VERSION,
  TERMINAL_LIMITS,
} from "../../schemas";
import type { AttachGrant, AttachRequest, SessionLocator } from "./contract";
import {
  encodeSessiondFrame,
  SessiondFrameDecoder,
} from "./sessiond-host";
import { hostDirectory, HostOperationError } from "./host-operations";

/**
 * The host's own control wire, spoken directly.
 *
 * A terminal serves two sockets: neutral operations (see `host-operations.ts`)
 * and this one, which carries adoption and viewer-grant registration. The
 * broker was the only speaker of it; with the broker gone, Hive speaks it.
 *
 * Every exchange is one connection, one request, one response. There is no
 * handshake and no session, so a slow host delays only its own caller.
 */

/** The host correlates a control exchange on this id (`broker_host_client.zig`). */
const CONTROL_REQUEST_ID = 2n;

/** Unused attach grants expire after this long. */
const GRANT_LIFETIME_MS = 30_000;

function controlSocketPath(hiveHome: string, sessionId: string): string {
  return join(hostDirectory(hiveHome, sessionId), "host.sock");
}

/**
 * The connection handshake a host requires before any verb.
 *
 * The host compares the build id it is told here against the one carried by
 * adoption, so a mismatched executable is refused rather than adopted. Request
 * id 1 is the handshake's; every verb that follows uses id 2.
 */
function helloPayload(instanceId: string, buildId: string): unknown {
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

async function exchange(
  socketPath: string,
  type: FrameTypeName,
  payload: unknown,
  timeoutMilliseconds: number,
  hello: { instanceId: string; buildId: string },
  responseType: FrameTypeName = type,
): Promise<unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return await new Promise<unknown>((resolve, reject) => {
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
        finish(() =>
          reject(new HostOperationError(`host ${type} timed out`)),
        ),
      timeoutMilliseconds,
    );
    timer.unref?.();
    socket.once("error", (error) =>
      finish(() =>
        reject(new HostOperationError("host control socket failed", { cause: error })),
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
        frames = decoder.push(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        );
      } catch (error) {
        finish(() =>
          reject(new HostOperationError("host sent an invalid frame", { cause: error })),
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
        // The host answers on the request's id, response|final. Anything else
        // is a frame this exchange did not ask for.
        if (frame.requestId !== CONTROL_REQUEST_ID) continue;
        if (frame.flags !== (FRAME_FLAGS.response | FRAME_FLAGS.final)) continue;
        finish(() => {
          try {
            resolve(JSON.parse(new TextDecoder().decode(frame.payload)));
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

/**
 * Proves ownership of a host with its launch-time capability.
 *
 * The host refuses every control verb until this succeeds, so it runs once per
 * launch. The secret is the `adopt.cap` the launcher wrote — not the neutral
 * `control.cap`, which authorises a different wire.
 */
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
    // Only adoption is permitted on this challenge.
    operation: "adopt",
  });
  await exchange(
    controlSocketPath(options.hiveHome, options.sessionId),
    "HOST_ADOPT",
    payload,
    TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    { instanceId: options.locator.instanceId, buildId: options.buildId },
  );
}

/**
 * Issues a one-use viewer grant.
 *
 * The token is minted here and the host is told only its hash, so a grant that
 * leaks from disk cannot be replayed into an attach. The viewer connects to the
 * host's own socket with the token; Hive is not in that path.
 */
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
    controlSocketPath(options.hiveHome, options.sessionId),
    "GRANT_REGISTER",
    payload,
    TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    {
      instanceId: options.locator.instanceId,
      buildId: options.engineBuildId,
    },
  );
  const registered =
    typeof answer === "object" &&
    answer !== null &&
    (answer as { registered?: unknown }).registered === true;
  if (!registered) {
    throw new HostOperationError("host refused the viewer grant");
  }
  return {
    locator: options.locator,
    endpoint: controlSocketPath(options.hiveHome, options.sessionId),
    token,
    expiresAt,
    engineBuildId: options.engineBuildId,
    checkpointSeq: options.checkpointSeq,
    outputSeq: options.outputSeq,
    operations: options.request.operations,
  };
}

/**
 * The SHA-256 of the `hive-sessiond` executable.
 *
 * A host compares this against its own binary: adoption proves not just that
 * the caller holds the capability but that it is running the same build. It is
 * the executable's hash, NOT the engine build id — those are different values
 * and the host refuses a mismatch as unauthenticated.
 */
const executableHashes = new Map<string, Promise<string>>();

export function executableBuildHash(path: string): Promise<string> {
  const cached = executableHashes.get(path);
  if (cached !== undefined) return cached;
  const digest = readFile(path).then((bytes) =>
    createHash("sha256").update(bytes).digest("hex"),
  );
  executableHashes.set(path, digest);
  return digest;
}

/**
 * Asks the terminal to resolve an orphaned or held human input claim.
 *
 * The policy is the host's alone: it decides whether a claim is orphaned or
 * needs an explicit preemption, and reports those as different outcomes. Hive
 * adds nothing to that judgement — it only carries the question, which the
 * broker used to relay.
 */
export async function discardHostInputOrphan(options: {
  hiveHome: string;
  sessionId: string;
  locator: SessionLocator;
  mode: "orphaned" | "held";
  buildId: string;
}): Promise<unknown> {
  return await exchange(
    controlSocketPath(options.hiveHome, options.sessionId),
    "INPUT_ORPHAN_DISCARD",
    { schemaVersion: 1, locator: options.locator, mode: options.mode },
    TERMINAL_LIMITS.controlRpcTimeoutMilliseconds,
    { instanceId: options.locator.instanceId, buildId: options.buildId },
    "ORPHAN_DISCARDED",
  );
}
