import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

/**
 * Speaks the neutral host operation protocol directly to a terminal's own
 * socket, with no broker in between.
 *
 * The broker's role here was relay: it opened `host.sock` per request and
 * proxied the answer back. Hive already opens that socket itself for viewer
 * attach, so the relay bought nothing and cost the 31-wide accept loop — the
 * spawn path alone polls INSPECT dozens of times per agent, and every poll was
 * a fresh broker-to-host connection queued behind thirty other launches.
 *
 * NHOP is a private per-request protocol: connect, write one request, read one
 * response, close. There is no session, so a slow host delays only its own
 * caller.
 */

const REQUEST_MAGIC = "NHOP";
const RESPONSE_MAGIC = "NHRS";
const REQUEST_HEADER_BYTES = 54;
const RESPONSE_HEADER_BYTES = 9;
const SCHEMA_VERSION = 1;
const ADOPTION_SECRET_BYTES = 32;

/** `neutral_runtime.zig` Operation. */
export const HOST_OPERATIONS = {
  submitInput: 1,
  resize: 2,
  attach: 3,
  inspect: 4,
  pollExit: 5,
  reap: 6,
  terminate: 7,
} as const;

export type HostOperation = keyof typeof HOST_OPERATIONS;

export type HostSessionRef = Readonly<{ key: string; incarnation: string }>;

export class HostOperationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostOperationError";
  }
}

/** The host refused the request; its payload is the diagnostic, not a result. */
export class HostOperationRefused extends Error {
  constructor(readonly diagnostic: string) {
    super(`host refused the operation: ${diagnostic}`);
    this.name = "HostOperationRefused";
  }
}

export function hostDirectory(hiveHome: string, sessionId: string): string {
  return join(hiveHome, "runtime", "sessiond", "hosts", sessionId);
}

function lengthPrefix(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

/**
 * Where a host listens for neutral operations.
 *
 * This is NOT the launch record's directory: the neutral endpoint names its
 * own directory by hashing the session reference, so the path is derived here
 * exactly as `neutral_runtime.zig sessionDirectoryName` derives it — length
 * prefixes included, or two different sessions could collide.
 */
export function neutralDirectory(
  hiveHome: string,
  session: HostSessionRef,
): string {
  const key = Buffer.from(session.key, "utf8");
  const incarnation = Buffer.from(session.incarnation, "utf8");
  const digest = createHash("sha256")
    .update(lengthPrefix(key.byteLength))
    .update(key)
    .update(lengthPrefix(incarnation.byteLength))
    .update(incarnation)
    .digest();
  const name = `nh-${digest.toString("base64url")}`;
  return join(hiveHome, "neutral", name);
}

export function neutralSocketPath(
  hiveHome: string,
  session: HostSessionRef,
): string {
  return join(neutralDirectory(hiveHome, session), "host.sock");
}

/** The capability authorizing operations on this host. Not `adopt.cap`. */
export async function readControlSecret(
  hiveHome: string,
  session: HostSessionRef,
): Promise<Uint8Array> {
  const secret = await readFile(
    join(neutralDirectory(hiveHome, session), "control.cap"),
  );
  if (secret.byteLength !== ADOPTION_SECRET_BYTES) {
    throw new HostOperationError("host control capability is malformed");
  }
  return new Uint8Array(secret);
}

export async function readAdoptionSecret(
  hiveHome: string,
  sessionId: string,
): Promise<Uint8Array> {
  const secret = await readFile(
    join(hostDirectory(hiveHome, sessionId), "adopt.cap"),
  );
  if (secret.byteLength !== ADOPTION_SECRET_BYTES) {
    throw new HostOperationError("host adoption capability is malformed");
  }
  return new Uint8Array(secret);
}

function encodeRequest(
  operation: HostOperation,
  secret: Uint8Array,
  session: HostSessionRef,
  idempotencyKey: string,
  payload: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const key = encoder.encode(session.key);
  const incarnation = encoder.encode(session.incarnation);
  const idempotency = encoder.encode(idempotencyKey);
  const body = encoder.encode(payload);
  const bytes = new Uint8Array(
    REQUEST_HEADER_BYTES +
      key.byteLength +
      incarnation.byteLength +
      idempotency.byteLength +
      body.byteLength,
  );
  bytes.set(encoder.encode(REQUEST_MAGIC), 0);
  bytes[4] = SCHEMA_VERSION;
  bytes[5] = HOST_OPERATIONS[operation];
  bytes.set(secret, 6);
  const view = new DataView(bytes.buffer);
  view.setUint32(38, key.byteLength);
  view.setUint32(42, incarnation.byteLength);
  view.setUint32(46, idempotency.byteLength);
  view.setUint32(50, body.byteLength);
  let at = REQUEST_HEADER_BYTES;
  for (const part of [key, incarnation, idempotency, body]) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/**
 * One request, one response, one connection.
 *
 * The host answers a refusal as a typed payload rather than by closing, so a
 * refusal is returned to the caller instead of surfacing as a transport error.
 */
export async function callHost(options: {
  hiveHome: string;
  sessionId: string;
  session: HostSessionRef;
  operation: HostOperation;
  payload: string;
  secret: Uint8Array;
  idempotencyKey?: string;
  timeoutMilliseconds: number;
}): Promise<string> {
  const socketPath = neutralSocketPath(options.hiveHome, options.session);
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let socket: Socket;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      outcome();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new HostOperationError(`host ${options.operation} timed out`)),
      );
    }, options.timeoutMilliseconds);
    timer.unref?.();

    socket = connect(socketPath);
    socket.once("error", (error) =>
      finish(() =>
        reject(new HostOperationError("host socket failed", { cause: error })),
      ),
    );
    socket.once("connect", () => {
      socket.write(
        encodeRequest(
          options.operation,
          options.secret,
          options.session,
          options.idempotencyKey ?? "",
          options.payload,
        ),
      );
    });
    socket.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const buffered = Buffer.concat(chunks);
      if (buffered.byteLength < RESPONSE_HEADER_BYTES) return;
      if (buffered.subarray(0, 4).toString("latin1") !== RESPONSE_MAGIC) {
        finish(() =>
          reject(new HostOperationError("host response had invalid magic")),
        );
        return;
      }
      const status = buffered[4] ?? 1;
      if (status > 1) {
        finish(() =>
          reject(new HostOperationError("host response had invalid status")),
        );
        return;
      }
      const length = buffered.readUInt32BE(5);
      if (buffered.byteLength < RESPONSE_HEADER_BYTES + length) return;
      const body = buffered
        .subarray(RESPONSE_HEADER_BYTES, RESPONSE_HEADER_BYTES + length)
        .toString("utf8");
      finish(() => {
        if (status === 0) resolve(body);
        else reject(new HostOperationRefused(body));
      });
    });
    socket.once("close", () => {
      finish(() =>
        reject(new HostOperationError("host closed before it answered")),
      );
    });
  });
}

/**
 * Finds a live host's neutral endpoint: its session reference and the secret
 * that authorises operations on it.
 *
 * Neither is derivable. The incarnation is ENGINE-assigned, not the locator's
 * generation — building a reference from the generation is the #68 mistake and
 * fails as NOT_FOUND — and the operation capability is `control.cap`, which is
 * a different secret from the launch-time `adopt.cap`. Both are published by
 * the host in its own directory, so both are read from there.
 */
export async function resolveNeutralEndpoint(
  hiveHome: string,
  sessionId: string,
): Promise<{ session: HostSessionRef; secret: Uint8Array }> {
  const root = join(hiveHome, "neutral");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    throw new HostOperationError("no neutral host endpoints exist", {
      cause: error,
    });
  }
  for (const name of names) {
    if (!name.startsWith("nh-")) continue;
    let record: { session?: { key?: string; incarnation?: string } };
    try {
      record = JSON.parse(
        await readFile(join(root, name, "record.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const session = record.session;
    if (session?.key !== sessionId) continue;
    if (typeof session.incarnation !== "string") continue;
    const secret = await readFile(join(root, name, "control.cap"));
    if (secret.byteLength !== ADOPTION_SECRET_BYTES) {
      throw new HostOperationError("host control capability is malformed");
    }
    return {
      session: { key: session.key, incarnation: session.incarnation },
      secret: new Uint8Array(secret),
    };
  }
  throw new HostOperationError(
    `no neutral host endpoint for session ${sessionId}`,
  );
}

/**
 * Every neutral endpoint on this machine, read from the hosts' own published
 * records.
 *
 * The broker answered this from an in-memory registry it built by launching.
 * Hive no longer launches through it, so the registry cannot know these hosts;
 * the directory the hosts write to does.
 */
export async function listNeutralSessions(
  hiveHome: string,
): Promise<readonly HostSessionRef[]> {
  const root = join(hiveHome, "neutral");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    // No terminals have ever been created here. That is an empty list, not a
    // failure to enumerate.
    return [];
  }
  const sessions: HostSessionRef[] = [];
  for (const name of names) {
    if (!name.startsWith("nh-")) continue;
    try {
      const record = JSON.parse(
        await readFile(join(root, name, "record.json"), "utf8"),
      ) as { session?: { key?: string; incarnation?: string } };
      const session = record.session;
      if (typeof session?.key !== "string") continue;
      if (typeof session.incarnation !== "string") continue;
      sessions.push({ key: session.key, incarnation: session.incarnation });
    } catch {
      // A record being written right now is not an error for a reader.
    }
  }
  return sessions;
}
