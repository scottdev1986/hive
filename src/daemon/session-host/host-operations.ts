import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { sessiondRuntimeRoot, sessiondStateRoot } from "../../hive-home/home";

/** Speaks the neutral host operation protocol directly to a terminal's own socket, with no broker in between. Hive opens `host.sock` per request instead of routing frequent INSPECT polls through a shared accept loop. This keeps one slow host from delaying other terminals. NHOP is a private per-request protocol: connect, write one request, read one response, close. There is no session, so a slow host delays only its own caller. */

const REQUEST_MAGIC = "NHOP";
const RESPONSE_MAGIC = "NHRS";
const REQUEST_HEADER_BYTES = 54;
const RESPONSE_HEADER_BYTES = 9;
const SCHEMA_VERSION = 1;
const ADOPTION_SECRET_BYTES = 32;

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

export class HostOperationRefused extends Error {
  constructor(readonly diagnostic: string) {
    super(`host refused the operation: ${diagnostic}`);
    this.name = "HostOperationRefused";
  }
}

/** A host's own state directory: its adoption capability, recovery record, journal and checkpoints. Under `sessiondStateRoot`, which is where everything that must outlive the socket lives; only the socket itself stays in the short root that `sun_path` constrains. */
export function hostDirectory(hiveHome: string, sessionId: string): string {
  return join(sessiondStateRoot(hiveHome), "hosts", sessionId);
}

function lengthPrefix(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

/** The name a socket takes under the socket root: eight hex digits of the identity digest that already names the session's state directory, so each side derives it from the session it holds rather than being told. Mirrors `socketName` in `security_helpers.zig`, which the host binds with — the two must spell one name or a peer dials a socket nobody bound. Every name is the same length, which is what lets one preflight bound both socket kinds. */
function socketName(digest: Buffer): string {
  return `${digest.subarray(0, 4).toString("hex")}.s`;
}

export function hostSocketName(sessionId: string): string {
  return socketName(createHash("sha256").update(sessionId).digest());
}

export function neutralSocketName(session: HostSessionRef): string {
  return socketName(neutralDigest(session));
}

/** The socket a session host accepts control connections on. */
export function hostSocketPath(hiveHome: string, sessionId: string): string {
  return join(sessiondRuntimeRoot(hiveHome), hostSocketName(sessionId));
}

/** The directory every host publishes its neutral endpoint's record and capability under. A sibling of the host subtree, not a child, because the two are keyed differently: a host directory is named by the Hive session id, a neutral one by a digest of the session reference. That is also why `adopt.cap` lives under `hosts/` and `control.cap` here — two secrets with two jobs, one authenticating the launch handshake and one authorising every operation after it. Tidying them into one directory would collapse a security boundary, not a layout. */
export function neutralRoot(hiveHome: string): string {
  return join(sessiondStateRoot(hiveHome), "neutral");
}

function neutralDigest(session: HostSessionRef): Buffer {
  const key = Buffer.from(session.key, "utf8");
  const incarnation = Buffer.from(session.incarnation, "utf8");
  return createHash("sha256")
    .update(lengthPrefix(key.byteLength))
    .update(key)
    .update(lengthPrefix(incarnation.byteLength))
    .update(incarnation)
    .digest();
}

export function neutralDirectory(
  hiveHome: string,
  session: HostSessionRef,
): string {
  const name = `nh-${neutralDigest(session).toString("base64url")}`;
  return join(neutralRoot(hiveHome), name);
}

export function neutralSocketPath(
  hiveHome: string,
  session: HostSessionRef,
): string {
  return join(sessiondRuntimeRoot(hiveHome), neutralSocketName(session));
}

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

/** One request, one response, one connection. The host answers a refusal as a typed payload rather than by closing, so a refusal is returned to the caller instead of surfacing as a transport error. */
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

/** Finds a live host's neutral endpoint: its session reference and the secret that authorises operations on it. Neither is derivable. The incarnation is engine-assigned, not the locator's generation; building a reference from the generation fails as NOT_FOUND. The operation capability is `control.cap`, which is a different secret from the launch-time `adopt.cap`. Both are published by the host in its own directory, so both are read from there. */
/** Every neutral endpoint on this machine, read from the hosts' own published records. The broker answered this from an in-memory registry it built by launching. Hive no longer launches through it, so the registry cannot know these hosts; the directory the hosts write to does. */
export async function listNeutralSessions(
  hiveHome: string,
): Promise<readonly HostSessionRef[]> {
  const root = neutralRoot(hiveHome);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
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
    } catch {}
  }
  return sessions;
}

/** The sweep threshold for the socket tree, in nodes. Past this many rendezvous nodes under the socket root, a sweep is due. This module counts so the threshold can be checked against a fact; the sweep itself is a different change and must never travel with the counting. */
export const SOCKET_ROOT_SWEEP_THRESHOLD = 1000;

/** The number of nodes under the resolved socket root. Every entry counts — socket, file or directory — and a directory's contents count with it, because the tree holds nothing but rendezvous nodes and the directories that carry them. An absent root reads as zero rather than failing: a daemon that has never launched a host has nothing to count, and zero is the honest answer to the threshold question there. The tree is live while it is walked, so a node unbound between listing and reading contributes nothing rather than failing the count. */
export function countSocketRootNodes(hiveHome: string): number {
  let count = 0;
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      count += 1;
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };
  walk(sessiondRuntimeRoot(hiveHome));
  return count;
}
