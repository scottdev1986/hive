import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { z } from "zod";
import {
  FRAME_FLAGS,
  HostRegisterPayloadSchema,
} from "../../schemas";
import type { CreateResult } from "./contract";
import {
  encodeSessiondFrame,
  SessiondFrameDecoder,
  SessiondProtocolError,
} from "./sessiond-host";

/**
 * Launches a terminal host and takes its registration, without a broker.
 *
 * The broker existed between Hive and its terminals as the only thing able to
 * hand a socketpair down to a forked child. It is not in the terminal data path
 * — a viewer already connects straight to `host.sock` — so what it actually
 * provided on this path was a descriptor handoff, and one process doing that
 * for thirty-one concurrent launches is the 31-wide bottleneck: its connection
 * threads park inside multi-second boots and stop accepting, so creates that
 * never started fail at HELLO.
 *
 * Here the direction is inverted. Hive listens on a socket named for exactly
 * one host, spawns the host pointing at it, and the host dials in. The path is
 * per-host, so accepting one connection on it is unambiguous without a
 * correlation token, and the accepted stream is private and identical to the
 * socketpair the broker used — every byte after this point is the same wire.
 */

/** HVB1, the private launcher-to-host bootstrap codec (`boot_envelope.zig`). */
const BOOT_MAGIC = "HVB1";
const BOOT_HEADER_BYTES = 48;
const ADOPTION_SECRET_BYTES = 32;

/** The host answers its registration on this id, and expects the acknowledgement
 * to carry it back (`host_registration.zig`). */
const REGISTRATION_REQUEST_ID = 2n;

function encodeBootMessage(
  specJson: string,
  initialInput: Uint8Array,
  adoptionSecret: Uint8Array,
): Uint8Array {
  if (adoptionSecret.byteLength !== ADOPTION_SECRET_BYTES) {
    throw new SessiondProtocolError(
      "host adoption secret must be exactly 32 bytes",
    );
  }
  const spec = new TextEncoder().encode(specJson);
  const bytes = new Uint8Array(
    BOOT_HEADER_BYTES + spec.byteLength + initialInput.byteLength,
  );
  bytes.set(new TextEncoder().encode(BOOT_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, spec.byteLength);
  view.setUint32(8, initialInput.byteLength);
  // 12..16 stay zero: the host fails closed on a nonzero reserved field.
  bytes.set(adoptionSecret, 16);
  bytes.set(spec, BOOT_HEADER_BYTES);
  bytes.set(initialInput, BOOT_HEADER_BYTES + spec.byteLength);
  return bytes;
}

export type HostLaunchRequest = Readonly<{
  hiveHome: string;
  /** Names the per-host socket, so one accept needs no correlation token. */
  sessionId: string;
  /** Absolute path to the `hive-sessiond` executable. */
  executablePath: string;
  /** The exact CREATE_BEGIN JSON the host validates against the frozen schema. */
  specJson: string;
  initialInput: Uint8Array;
  adoptionSecret: Uint8Array;
  /** How long the host has to boot a login shell and a vendor CLI and answer. */
  readyTimeoutMilliseconds: number;
}>;

type RegisteredRecord = Extract<
  z.infer<typeof HostRegisterPayloadSchema>,
  { record: unknown }
>["record"];

export type LaunchedHost = Readonly<{
  /**
   * The spawned process handle, retained by the caller.
   *
   * Dropping it lets the runtime finalize the subprocess, which can reap a host
   * that is running perfectly well — the terminal dies for no reason anyone can
   * see in its own record.
   */
  process: ReturnType<typeof Bun.spawn>;
  /** The launch readback the host published: identity plus evidence. */
  record: RegisteredRecord;
  hostPid: number;
  /**
   * The control stream, still open.
   *
   * The broker closed this after acknowledging, which is why a host had no way
   * to reach Hive afterward and why readiness had to be polled. Holding it is
   * what lets a terminal report its own state.
   */
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
        // A host that failed to boot reports it as a typed ERROR rather than
        // dying silently; surfacing it here keeps the real cause instead of a
        // downstream "never registered".
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

export async function launchHost(
  request: HostLaunchRequest,
): Promise<LaunchedHost> {
  // `sun_path` is 104 bytes on macOS, and a HIVE_HOME under /var/folders is
  // most of that before any suffix — a socket named inside the hive home dies
  // as NameTooLong, surfacing as a host that never dialed. The listener
  // therefore lives in its own short directory: unique per launch, 0700, and
  // removed as soon as the host is on the stream.
  // The host writes its record under this tree and fails closed if it is not
  // already there. The broker's Runtime.open used to create it; with no broker,
  // it is the launcher's to make.
  // A host whose working directory is gone fails deep inside its own boot as a
  // bare FileNotFound, naming nothing. The directory belongs to the caller, so
  // the check belongs here, where the answer can say which path was missing.
  const workingDirectory = (
    JSON.parse(request.specJson) as { cwd?: unknown }
  ).cwd;
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

  // Both roots are created before any host runs. A host creates whichever of
  // these it finds missing, so two hosts booting at the same instant race each
  // other and one loses with FileNotFound — measured as two lost terminals in a
  // thirty-one wide burst. Creating them here means no host ever has to.
  await mkdir(join(request.hiveHome, "neutral"), {
    recursive: true,
    mode: 0o700,
  });

  const hostDirectory = join(
    request.hiveHome,
    "runtime",
    "sessiond",
    "hosts",
    request.sessionId,
  );
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  // The host reads its adoption capability from this file at boot; the secret
  // in the boot message is checked against it. The broker wrote it before
  // launching, and it fails closed if the file is absent.
  await writeFile(join(hostDirectory, "adopt.cap"), request.adoptionSecret, {
    mode: 0o600,
  });

  const pendingDirectory = join("/tmp", `hv-${randomBytes(4).toString("hex")}`);
  await mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(pendingDirectory, "h.sock");

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const cleanup = async () => {
    server.close();
    await rm(pendingDirectory, { recursive: true, force: true });
  };

  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      // The launcher's dynamic-linker settings are not the host's to inherit.
      if (value === undefined || name.startsWith("DYLD_")) continue;
      environment[name] = value;
    }
    environment.HIVE_HOME = request.hiveHome;
    environment.HIVE_HOST_CONTROL_SOCKET = socketPath;

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
    control.write(
      encodeBootMessage(
        request.specJson,
        request.initialInput,
        request.adoptionSecret,
      ),
    );

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

    // The durable recovery record. The broker wrote this after taking a
    // registration, and nothing else ever did — without it a host is invisible
    // to anything that enumerates terminals from disk, including recovery after
    // a daemon restart. Written atomically so a reader never sees half a
    // record.
    const recordJson = `${JSON.stringify({
      schemaVersion: 1,
      ...record,
      socketRelativePath: "host.sock",
      createdAt: new Date().toISOString(),
    })}\n`;
    const recordPath = join(hostDirectory, "record.json");
    const pendingPath = `${recordPath}.pending`;
    await writeFile(pendingPath, recordJson, { mode: 0o600 });
    await rename(pendingPath, recordPath);

    // The listener's work is done the moment the host is on the stream; the
    // stream itself stays open as the terminal's channel to Hive.
    await cleanup();
    return { record, hostPid: child.pid, control, process: child };
  } catch (error) {
    child?.kill();
    await cleanup();
    // A host that failed to boot names no path. Re-check the inputs the
    // launcher is responsible for, so the failure says which one moved rather
    // than leaving a bare FileNotFound to guess at.
    const missing: string[] = [];
    for (const path of [
      workingDirectory,
      hostDirectory,
      join(hostDirectory, "adopt.cap"),
      join(request.hiveHome, "neutral"),
    ]) {
      try {
        await stat(path);
      } catch {
        missing.push(path);
      }
    }
    if (missing.length > 0) {
      throw new HostLaunchError(
        `${error instanceof Error ? error.message : String(error)} (missing after launch: ${missing.join(", ")})`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The create readback, projected from what the host published.
 *
 * The broker built this from the same registration and returned it as CREATED;
 * with no broker in the path, the projection happens here. Foreground is
 * deliberately `unknown`: a terminal that has just registered has a shell and
 * no provider yet, and claiming otherwise would invent evidence.
 */
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
      input: { state: "FREE", ownerViewerId: null, claimId: null },
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
