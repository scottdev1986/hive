import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import {
  encodeSessiondFrame,
  SessiondFrameDecoder,
  SessiondWireError,
  type SessiondFrame,
} from "./sessiond-host";
import { FRAME_FLAGS, FRAME_TYPES } from "../../schemas/session-protocol";
import { SessiondViewerAttachClient } from "./sessiond-viewer-attach";
import type { SessionLocator, AttachGrant } from "./contract";
import type { TerminalGeometry } from "../../schemas/session-protocol";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Let in-flight best-effort frames (CLAIM_RELEASE, OUTPUT acks) reach the host. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

const locator: SessionLocator = {
  schemaVersion: 1,
  instanceId: "hive-fixture",
  subject: { kind: "agent", agentId: "agent-maya" },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000101",
  hostKind: "sessiond",
  engineBuildId: "engine-fixture",
};

const geometry: TerminalGeometry = {
  columns: 80,
  rows: 24,
  widthPx: 640,
  heightPx: 384,
  cellWidthPx: 8,
  cellHeightPx: 16,
};

function grantFor(endpoint: string): AttachGrant {
  return {
    locator,
    endpoint,
    token: "grant-token-1",
    expiresAt: "2026-07-20T21:00:30.000Z",
    engineBuildId: "engine-fixture",
    checkpointSeq: "0",
    outputSeq: "0",
    operations: ["view", "human-input"],
  };
}

function welcomePayload(): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    schemaVersion: 1,
    protocol: { major: 1, minor: 0 },
    instanceId: locator.instanceId,
    endpointRole: "host",
    buildId: "engine-fixture",
    engineBuildId: "engine-fixture",
    connectionId: "1",
    serverEpoch: "1",
    limits: {
      controlFrameMaxBytes: 262144,
      maxInputTransactionBytes: 131072,
      streamChunkMaxBytes: 65536,
      automatedMessageMaxBytes: 1048576,
      viewerQueueMaxBytes: 8388608,
    },
  }));
}

function claimResult(state: "granted" | "denied"): Uint8Array {
  const result = state === "granted"
    ? {
      state: "granted",
      claim: {
        token: "claim-token-1",
        writer: "hive-daemon:fixture",
        kind: "automation",
        leaseExpiresAt: "2026-07-20T21:01:00.000Z",
      },
    }
    : { state: "denied", owner: null, diagnostic: "input already claimed" };
  return textEncoder.encode(JSON.stringify({ schemaVersion: 1, result }));
}

function inputReceipt(): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    schemaVersion: 1,
    resultKind: "input",
    receipt: {
      transactionId: "msg-1",
      stage: "written-to-terminal",
      byteRange: { start: "0", endExclusive: "12" },
      orderedAt: "12",
      availableCreditBytes: 4096,
      consumedByProcess: "not-claimed",
      completeness: "complete",
      diagnostic: null,
    },
  }));
}

function errorPayload(): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    schemaVersion: 1,
    code: "INPUT_BUSY",
    message: "input already claimed",
    diagnosticId: null,
  }));
}

type FakeHostOptions = Readonly<{
  claim?: "granted" | "denied";
  errorOnInput?: boolean;
  /** Bytes to stream as one OUTPUT frame after HOST_ATTACH, at streamSeq 0. */
  streamOutput?: Uint8Array;
}>;

type FakeHost = Readonly<{
  endpoint: string;
  received: SessiondFrame[];
  close: () => Promise<void>;
}>;

async function startFakeHost(options: FakeHostOptions = {}): Promise<FakeHost> {
  const endpoint = `/tmp/hvva-${crypto.randomUUID().slice(0, 8)}.sock`;
  const received: SessiondFrame[] = [];
  const server: Server = createServer((socket: Socket) => {
    const decoder = new SessiondFrameDecoder();
    socket.on("data", (chunk) => {
      let frames: SessiondFrame[];
      try {
        frames = decoder.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        received.push(frame);
        respond(socket, frame, options);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  return {
    endpoint,
    received,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        rmSync(endpoint, { force: true });
        resolve();
      });
    }),
  };
}

function respondFrame(
  socket: Socket,
  type: keyof typeof FRAME_TYPES,
  requestId: bigint,
  payload: Uint8Array,
): void {
  socket.write(encodeSessiondFrame({
    type,
    flags: FRAME_FLAGS.response | FRAME_FLAGS.final,
    requestId,
    streamSeq: 0n,
    payload,
  }));
}

function respond(socket: Socket, frame: SessiondFrame, options: FakeHostOptions): void {
  switch (frame.type) {
    case "HELLO":
      respondFrame(socket, "WELCOME", frame.requestId, welcomePayload());
      return;
    case "HOST_ATTACH":
      if (options.streamOutput !== undefined) {
        socket.write(encodeSessiondFrame({
          type: "OUTPUT",
          flags: 0,
          requestId: 1000n,
          streamSeq: 0n,
          payload: options.streamOutput,
        }));
      }
      return;
    case "CLAIM_ACQUIRE":
      respondFrame(socket, "CLAIM_RESULT", frame.requestId, claimResult(options.claim ?? "granted"));
      return;
    case "INPUT_SUBMIT":
      if (options.errorOnInput === true) {
        socket.write(encodeSessiondFrame({
          type: "ERROR",
          flags: FRAME_FLAGS.response | FRAME_FLAGS.final | FRAME_FLAGS.error,
          requestId: frame.requestId,
          streamSeq: 0n,
          payload: errorPayload(),
        }));
        return;
      }
      respondFrame(socket, "APPLIED", frame.requestId, inputReceipt());
      return;
    default:
      // CLAIM_RELEASE, APPLIED acks, PONG — nothing to answer.
      return;
  }
}

const hosts: FakeHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.close();
});

async function attachTo(options: FakeHostOptions = {}): Promise<{
  host: FakeHost;
  client: SessiondViewerAttachClient;
}> {
  const host = await startFakeHost(options);
  hosts.push(host);
  const client = await SessiondViewerAttachClient.attach({
    locator,
    grant: grantFor(host.endpoint),
    geometry,
    viewerId: "hive-daemon:fixture",
  });
  return { host, client };
}

test("completes HELLO→HOST_ATTACH→CLAIM_ACQUIRE→INPUT_SUBMIT and returns the receipt", async () => {
  const { host, client } = await attachTo();
  const receipt = await client.injectAutomated({
    session: { key: locator.sessionId, incarnation: "1" },
    writer: "hive-daemon:fixture",
    transactionId: "msg-1",
    idempotencyKey: "msg-1",
    bytes: textEncoder.encode("hello agent\n"),
    leaseMilliseconds: 60_000,
  });
  client.close();
  await settle();

  expect(receipt).not.toBeNull();
  expect(receipt?.stage).toBe("written-to-terminal");
  expect(receipt?.transactionId).toBe("msg-1");

  const types = host.received.map((frame) => frame.type);
  expect(types).toContain("HELLO");
  expect(types).toContain("HOST_ATTACH");
  expect(types).toContain("CLAIM_ACQUIRE");
  expect(types).toContain("INPUT_SUBMIT");
  // The claim holds and is cleanly released on the same connection.
  expect(types).toContain("CLAIM_RELEASE");

  const claim = host.received.find((f) => f.type === "CLAIM_ACQUIRE")!;
  expect(JSON.parse(textDecoder.decode(claim.payload)).kind).toBe("automation");

  const submit = host.received.find((f) => f.type === "INPUT_SUBMIT")!;
  expect(submit.flags).toBe(FRAME_FLAGS.contentSensitive);
  const submitBody = JSON.parse(textDecoder.decode(submit.payload));
  expect(submitBody.operation.encoding).toBe("base64");
  expect(Buffer.from(submitBody.operation.bytes, "base64").toString()).toBe("hello agent\n");
  expect(submitBody.claimToken).toBe("claim-token-1");
});

test("returns null and never submits when the arbiter denies the claim (never-steal)", async () => {
  const { host, client } = await attachTo({ claim: "denied" });
  const receipt = await client.injectAutomated({
    session: { key: locator.sessionId, incarnation: "1" },
    writer: "hive-daemon:fixture",
    transactionId: "msg-1",
    idempotencyKey: "msg-1",
    bytes: textEncoder.encode("hello agent\n"),
    leaseMilliseconds: 60_000,
  });
  client.close();

  expect(receipt).toBeNull();
  const types = host.received.map((frame) => frame.type);
  expect(types).toContain("CLAIM_ACQUIRE");
  expect(types).not.toContain("INPUT_SUBMIT");
  // No claim was granted, so there is nothing to release.
  expect(types).not.toContain("CLAIM_RELEASE");
});

test("acknowledges a streamed OUTPUT frame with the APPLIED high-water so the host does not backpressure", async () => {
  const output = textEncoder.encode("agent output line\n");
  const { host, client } = await attachTo({ streamOutput: output });
  // Give the OUTPUT frame time to arrive and be acknowledged before the RPC.
  await client.injectAutomated({
    session: { key: locator.sessionId, incarnation: "1" },
    writer: "hive-daemon:fixture",
    transactionId: "msg-1",
    idempotencyKey: "msg-1",
    bytes: textEncoder.encode("hi\n"),
    leaseMilliseconds: 60_000,
  });
  client.close();
  await settle();

  const acks = host.received.filter((f) =>
    f.type === "APPLIED" && JSON.parse(textDecoder.decode(f.payload)).resultKind === "output");
  expect(acks.length).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(textDecoder.decode(acks[0]!.payload)).throughSeq).toBe(String(output.byteLength));
});

test("rejects the inject when the host returns a typed ERROR for INPUT_SUBMIT", async () => {
  const { client } = await attachTo({ errorOnInput: true });
  await expect(client.injectAutomated({
    session: { key: locator.sessionId, incarnation: "1" },
    writer: "hive-daemon:fixture",
    transactionId: "msg-1",
    idempotencyKey: "msg-1",
    bytes: textEncoder.encode("hi\n"),
    leaseMilliseconds: 60_000,
  })).rejects.toBeInstanceOf(SessiondWireError);
  client.close();
});
