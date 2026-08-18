import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { z } from "zod";
import {
  machineHiveHome,
  sessiondRuntimeRoot,
  sessiondStateRoot,
} from "../../hive-home/home";
import {
  FRAME_FLAGS,
  HostRegisterPayloadSchema,
} from "../../schemas/session-protocol";
import { errorMessage } from "../../shared/error-message";
import { hostDirectory, hostSocketPath, neutralRoot } from "./host-operations";
import type { CreateResult } from "./session-host-contract";
import {
  encodeSessiondFrame,
  SessiondFrameDecoder,
  SessiondProtocolError,
} from "./sessiond-host";

/** Launches a terminal host and takes its registration, without a broker. Hive listens on a socket named for exactly one host, spawns the host pointing at it, and the host dials in. The path is per-host, so accepting one connection on it is unambiguous without a correlation token. Per-host listeners also prevent multi-second boots from blocking unrelated launches on a shared accept loop. */

const BOOT_MAGIC = "HVB1";
const BOOT_HEADER_BYTES = 48;
const ADOPTION_SECRET_BYTES = 32;

const REGISTRATION_REQUEST_ID = 2n;

function encodeBootMessage(
  specJson: string,
  adoptionSecret: Uint8Array,
): Uint8Array {
  if (adoptionSecret.byteLength !== ADOPTION_SECRET_BYTES) {
    throw new SessiondProtocolError(
      "host adoption secret must be exactly 32 bytes",
    );
  }
  const spec = new TextEncoder().encode(specJson);
  const bytes = new Uint8Array(BOOT_HEADER_BYTES + spec.byteLength);
  bytes.set(new TextEncoder().encode(BOOT_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, spec.byteLength);
  // 8..16 stay zero: the host fails closed on a nonzero reserved field.
  bytes.set(adoptionSecret, 16);
  bytes.set(spec, BOOT_HEADER_BYTES);
  return bytes;
}

export type HostLaunchRequest = Readonly<{
  hiveHome: string;
  sessionId: string;
  /** Absolute path to the `hive-sessiond` executable. */
  executablePath: string;
  specJson: string;
  adoptionSecret: Uint8Array;
  readyTimeoutMilliseconds: number;
}>;

type RegisteredRecord = Extract<
  z.infer<typeof HostRegisterPayloadSchema>,
  { record: unknown }
>["record"];

export type LaunchedHost = Readonly<{
  /** The spawned process handle, retained by the caller. Dropping it lets the runtime finalize the subprocess, which can reap a host that is running perfectly well — the terminal dies for no reason anyone can see in its own record. */
  process: ReturnType<typeof Bun.spawn>;
  record: RegisteredRecord;
  hostPid: number;
  control: Socket;
}>;

/** A host that never dialed, never registered, or was refused. */
export class HostLaunchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostLaunchError";
  }
}

async function acceptOneConnection(
  server: Server,
  timeoutMilliseconds: number,
  onTimeout: () => void,
): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new HostLaunchError("host never dialed its control socket"));
    }, timeoutMilliseconds);
    timer.unref?.();
    server.once("connection", (socket) => {
      clearTimeout(timer);
      resolve(socket);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new HostLaunchError("host control socket failed", { cause: error }),
      );
    });
  });
}

/** Reads frames until the host's HOST_REGISTER arrives, or the budget runs out. */
async function readRegistration(
  control: Socket,
  timeoutMilliseconds: number,
): Promise<RegisteredRecord> {
  const decoder = new SessiondFrameDecoder();
  return await new Promise<RegisteredRecord>((resolve, reject) => {
    const finish = (outcome: () => void) => {
      clearTimeout(timer);
      control.off("data", onData);
      control.off("error", onError);
      control.off("close", onClose);
      outcome();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new HostLaunchError("host did not report READY in time")),
      );
    }, timeoutMilliseconds);
    timer.unref?.();
    const onError = (error: Error) =>
      finish(() =>
        reject(
          new HostLaunchError("host control stream failed", { cause: error }),
        ),
      );
    const onClose = () =>
      finish(() =>
        reject(new HostLaunchError("host closed before it registered")),
      );
    const onData = (chunk: Buffer) => {
      let frames: ReturnType<SessiondFrameDecoder["push"]>;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        finish(() =>
          reject(
            new HostLaunchError("host sent an invalid frame", { cause: error }),
          ),
        );
        return;
      }
      for (const frame of frames) {
        // A host that failed to boot reports it as a typed ERROR rather than dying silently; surfacing it here keeps the real cause instead of a downstream "never registered".
        if (frame.type === "ERROR") {
          const text = new TextDecoder().decode(frame.payload);
          finish(() =>
            reject(new HostLaunchError(`host startup failed: ${text}`)),
          );
          return;
        }
        if (frame.type !== "HOST_REGISTER") continue;
        if (frame.requestId !== REGISTRATION_REQUEST_ID) continue;
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder().decode(frame.payload));
        } catch (error) {
          finish(() =>
            reject(
              new HostLaunchError("host registration was not valid JSON", {
                cause: error,
              }),
            ),
          );
          return;
        }
        const parsed = HostRegisterPayloadSchema.safeParse(decoded);
        if (!parsed.success || !("record" in parsed.data)) {
          finish(() =>
            reject(new HostLaunchError("host registration failed validation")),
          );
          return;
        }
        const record = parsed.data.record;
        finish(() => resolve(record));
        return;
      }
    };
    control.on("data", onData);
    control.once("error", onError);
    control.once("close", onClose);
  });
}

/** macOS caps `sun_path` at 104 bytes including the terminator, so a bindable path is at most 103. */
const SUN_PATH_MAX_BYTES = 103;

export async function launchHost(
  request: HostLaunchRequest,
): Promise<LaunchedHost> {
  // `sun_path` is 104 bytes on macOS, and a HIVE_HOME under /var/folders is most of that before any suffix — a socket named inside the hive home dies as NameTooLong, surfacing as a host that never dialed. The listener therefore lives in its own short directory: unique per launch, 0700, and removed as soon as the host is on the stream. The host writes its record under this tree and fails closed if it is absent, so the launcher creates it before starting the host. A host whose working directory is gone fails deep inside its own boot as a bare FileNotFound, naming nothing. The directory belongs to the caller, so the check belongs here, where the answer can say which path was missing.
  const workingDirectory = (JSON.parse(request.specJson) as { cwd?: unknown })
    .cwd;
  if (typeof workingDirectory !== "string") {
    throw new HostLaunchError("create spec has no working directory");
  }
  try {
    await stat(workingDirectory);
  } catch (error) {
    throw new HostLaunchError(
      `working directory ${workingDirectory} does not exist`,
      { cause: error },
    );
  }

  // Every root is created before any host runs. A host creates whichever of these it finds missing, so two hosts booting at the same instant race each other and one loses with FileNotFound — measured as two lost terminals in a thirty-one wide burst. Creating them here means no host ever has to.
  const socketRoot = sessiondRuntimeRoot(request.hiveHome);
  const machineHome = machineHiveHome(request.hiveHome);
  const stateRoot = sessiondStateRoot(request.hiveHome);
  // The socket root lives under the machine home, so its length is the operator's rather than
  // Hive's, and a home long enough pushes every bind past macOS's `sun_path` ceiling. The host
  // preflights this too, but by then the only thing it can say is NameTooLong, which names neither
  // the limit nor the path that has to shrink. Refuse here, where both are still in hand.
  const hostSocket = hostSocketPath(request.hiveHome, request.sessionId);
  const hostSocketBytes = Buffer.byteLength(hostSocket);
  if (hostSocketBytes > SUN_PATH_MAX_BYTES) {
    // Derived from this launch's own path rather than restated, so the ceiling stays true if the
    // layout beneath the home ever changes.
    const homeCeiling =
      SUN_PATH_MAX_BYTES - (hostSocketBytes - Buffer.byteLength(machineHome));
    throw new HostLaunchError(
      `sessiond cannot bind a socket under ${machineHome}: ${hostSocket} is ${hostSocketBytes} bytes and macOS allows ${SUN_PATH_MAX_BYTES}. ` +
        `Hive spends a fixed ${hostSocketBytes - Buffer.byteLength(machineHome)} bytes below the machine home, so that home must be at most ${homeCeiling} bytes. ` +
        `Point HIVE_DEFAULT_HOME at a shorter path, or set HIVE_SESSIOND_ROOT to a short directory to hold the sockets alone.`,
    );
  }
  await mkdir(socketRoot, { recursive: true, mode: 0o700 });
  await mkdir(neutralRoot(request.hiveHome), {
    recursive: true,
    mode: 0o700,
  });

  const hostRuntimeDirectory = hostDirectory(
    request.hiveHome,
    request.sessionId,
  );
  await mkdir(hostRuntimeDirectory, { recursive: true, mode: 0o700 });
  // The host reads its adoption capability from this file at boot; the secret in the boot message is checked against it. The broker wrote it before launching, and it fails closed if the file is absent.
  await writeFile(
    join(hostRuntimeDirectory, "adopt.cap"),
    request.adoptionSecret,
    { mode: 0o600 },
  );

  // The boot handshake gets its own socket, thrown away as soon as the host is on the stream. It
  // is bound under the same socket root as the other two kinds rather than under `os.tmpdir()`,
  // which resolves to `/tmp` whenever TMPDIR is not exported — a launchd job, a cron entry or a
  // bare `sh -c` — and put the one remaining Hive path back in /tmp for as long as a host took to
  // boot. Under this root it also inherits the 0700 the launcher already established, so it needs
  // no private directory of its own. `.b` rather than `.s` so a boot socket and a session socket
  // cannot collide on one name, and eight hex characters so it costs exactly what they cost: the
  // ceiling this launcher refuses against is computed over the longest kind, and a third kind that
  // measured more than the other two would move that ceiling without moving the number.
  const bootSocketPath = join(
    socketRoot,
    `${randomBytes(4).toString("hex")}.b`,
  );

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bootSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const cleanup = async () => {
    server.close();
    await rm(bootSocketPath, { force: true });
  };

  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || name.startsWith("DYLD_")) continue;
      environment[name] = value;
    }
    // The host's whole filesystem footprint is these two roots; it reads no other Hive state, so they are the only locations it is told. They are two because they have two lifetimes: the socket root holds bound rendezvous nodes and must stay short enough for `sun_path`, while the state root holds the durable record, journal and checkpoints and must survive a reboot. Passing both resolved means the launcher and the host can never disagree about where either is.
    environment.HIVE_SESSIOND_ROOT = socketRoot;
    environment.HIVE_SESSIOND_STATE_ROOT = stateRoot;
    environment.HIVE_HOST_CONTROL_SOCKET = bootSocketPath;

    child = Bun.spawn([request.executablePath, "host"], {
      env: environment,
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
    });

    const control = await acceptOneConnection(
      server,
      request.readyTimeoutMilliseconds,
      () => child?.kill(),
    );
    control.write(encodeBootMessage(request.specJson, request.adoptionSecret));

    const record = await readRegistration(
      control,
      request.readyTimeoutMilliseconds,
    );

    control.write(
      encodeSessiondFrame({
        type: "HOST_REGISTER",
        flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
        requestId: REGISTRATION_REQUEST_ID,
        streamSeq: 0n,
        payload: new TextEncoder().encode(
          JSON.stringify({ schemaVersion: 1, accepted: true }),
        ),
      }),
    );

    // The durable recovery record. The broker wrote this after taking a registration, and nothing else ever did — without it a host is invisible to anything that enumerates terminals from disk, including recovery after a daemon restart. Written atomically so a reader never sees half a record.
    const recordJson = `${JSON.stringify({
      schemaVersion: 1,
      ...record,
      createdAt: new Date().toISOString(),
    })}\n`;
    const recordPath = join(hostRuntimeDirectory, "record.json");
    const pendingPath = `${recordPath}.pending`;
    await writeFile(pendingPath, recordJson, { mode: 0o600 });
    await rename(pendingPath, recordPath);

    await cleanup();
    return { record, hostPid: child.pid, control, process: child };
  } catch (error) {
    child?.kill();
    await cleanup();
    // A host that failed to boot names no path. Re-check the inputs the launcher is responsible for, so the failure says which one moved rather than leaving a bare FileNotFound to guess at.
    const missing: string[] = [];
    for (const path of [
      workingDirectory,
      hostRuntimeDirectory,
      join(hostRuntimeDirectory, "adopt.cap"),
      neutralRoot(request.hiveHome),
    ]) {
      try {
        await stat(path);
      } catch {
        missing.push(path);
      }
    }
    if (missing.length > 0) {
      throw new HostLaunchError(
        `${errorMessage(error)} (missing after launch: ${missing.join(", ")})`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** The create readback, projected from what the host published. The broker built this from the same registration and returned it as CREATED; with no broker in the path, the projection happens here. Foreground is deliberately `unknown`: a terminal that has just registered has a shell and no provider yet, and claiming otherwise would invent evidence. */
export function createResultFromRecord(
  record: RegisteredRecord,
  argv: readonly string[],
): CreateResult {
  return {
    locator: record.locator,
    created: true,
    inspection: {
      schemaVersion: 1,
      locator: record.locator,
      presence: "present",
      complete: true,
      hostPid: record.hostPid,
      hostStartToken: record.hostStartToken,
      shellRoot: {
        pid: record.processRoot.pid,
        startToken: record.processRoot.startToken,
        processGroupId: record.processRoot.processGroupId,
      },
      foreground: { state: "unknown", runId: null },
      expectedExecutable: record.expectedExecutable,
      executableVerified: argv[0] === record.expectedExecutable,
      outputSeq: record.outputSeq,
      checkpointSeq: record.checkpointSeq,
      checkpointAvailable: record.checkpointSeq !== "0",
      viewerCount: 0,
      geometry: record.geometry,
      resources: {},
      visibility: record.visibility,
      exit: null,
      survivors: [],
      evidenceAt: new Date().toISOString(),
      diagnosticIds: [],
    },
  };
}
