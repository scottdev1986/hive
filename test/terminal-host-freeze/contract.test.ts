import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TERMINAL_HOST_CONTRACT_VERSION,
  type CreateRequest,
  type SessionRef,
  type TerminalEvent,
  type WindowSize,
} from "../../src/daemon/session-host/terminal-host-contract";
import {
  NEUTRAL_FIXTURE_VERSION,
  NeutralTerminalHostFixture,
  StaleIncarnationError,
  SubscriptionGapError,
  fixtureLimits,
  fixtureSubscriptionLimits,
} from "./neutral-fixture";

const encoder = new TextEncoder();
const initialWindow: WindowSize = {
  columns: 93,
  rows: 31,
  widthPixels: 1116,
  heightPixels: 620,
};

function request(
  key: string,
  changes: Partial<CreateRequest["command"]> = {},
  inputMode: "canonical" | "literal" = "literal",
): CreateRequest {
  return {
    key,
    idempotencyKey: `create-${key}`,
    command: {
      executable: "/usr/bin/printf",
      arguments: ["neutral consumer ✓"],
      workingDirectory: "/tmp/neutral terminal/工作",
      completeEnvironment: [
        { name: "LANG", value: "en_US.UTF-8" },
        { name: "TERM", value: "xterm-256color" },
      ],
      descriptorMap: [],
      ...changes,
    },
    terminalProfile: {
      inputMode,
      echo: false,
      signalCharacters: true,
      softwareFlowControl: true,
      eofByte: 4,
      startByte: 17,
      stopByte: 19,
      hangupOnLastClose: true,
    },
    initialWindow,
  };
}

async function drain(
  host: NeutralTerminalHostFixture,
  session: SessionRef,
  subscriptionId: string,
): Promise<readonly TerminalEvent[]> {
  const delivered: TerminalEvent[] = [];
  for await (const event of host.events({ session, subscriptionId })) delivered.push(event);
  return delivered;
}

const sequenceOf = (event: TerminalEvent): string => event.eventSequence;

async function createRunning(host: NeutralTerminalHostFixture, spec: CreateRequest): Promise<SessionRef> {
  const created = await host.create(spec);
  expect(created.outcome.state).toBe("running");
  return created.session;
}

async function claim(
  host: NeutralTerminalHostFixture,
  session: SessionRef,
  writer = "human-console",
  kind: "human" | "automation" = "human",
): Promise<string> {
  const result = await host.claimInput({
    session,
    writer,
    kind,
    leaseMilliseconds: 30_000,
    idempotencyKey: `claim-${writer}`,
  });
  expect(result.state).toBe("granted");
  if (result.state !== "granted") throw new Error("claim not granted");
  return result.claim.token;
}

async function assertA(host: NeutralTerminalHostFixture): Promise<void> {
  const spec = request("freeze-a");
  const first = await host.create(spec);
  const retry = await host.create(spec);
  expect(retry.session).toEqual(first.session);
  expect(first.outcome.state).toBe("running");
  if (first.outcome.state !== "running") throw new Error("not running");
  const evidence = first.outcome.jobControl;
  expect(evidence).toMatchObject({
    sessionLeader: true,
    controllingTerminal: true,
    standardStreamsShareTerminal: true,
    initialProfileAppliedBeforeExec: true,
    initialWindowAppliedBeforeExec: true,
    completeness: "complete",
  });
  expect(evidence.childSessionId).toBe(first.outcome.child.processId);
  expect(evidence.childProcessGroupId).toBe(evidence.foregroundProcessGroupId);
  expect(evidence.terminalIdentity.length).toBeGreaterThan(0);
  await expect(host.inspect({ ...first.session, incarnation: "stale-incarnation" }))
    .rejects.toBeInstanceOf(StaleIncarnationError);
}

async function assertB(host: NeutralTerminalHostFixture): Promise<void> {
  const cases = [
    [request("b-command", { executable: "missing:command" }), "command", "ENOENT"],
    [request("b-cwd", { workingDirectory: "invalid:directory" }), "working-directory", "ENOENT"],
    [request("b-env", { completeEnvironment: [{ name: "HUGE", value: "x".repeat(5000) }] }), "environment", "E2BIG"],
    [request("b-handle", {
      descriptorMap: [{
        handle: { token: "unmappable", sourceDisposition: "retain" },
        targetDescriptor: 7,
      }],
    }), "descriptor-transfer", "EBADF"],
  ] as const;
  for (const [spec, layer, osCode] of cases) {
    const result = await host.create(spec);
    expect(result.outcome).toMatchObject({ state: "exec-failed", layer, osCode });
  }
  expect(await host.list()).toHaveLength(0);
  const generic = await host.create(request("b-generic"));
  expect(generic.outcome).toMatchObject({ state: "running", execProof: "replacement-observed" });
}

async function assertC(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-c", {
    descriptorMap: [{
      handle: { token: "report-channel", sourceDisposition: "close-after-transfer" },
      targetDescriptor: 7,
    }],
  }));
  expect(host.survivingDescriptors(session)).toEqual([0, 1, 2, 7]);
  expect(host.sourceHandleWasClosed(session, "report-channel")).toBe(true);
}

async function assertD(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-d"));
  const claimToken = await claim(host, session);
  const firstInput = await host.submitInput({
    session,
    claimToken,
    transactionId: "d-input-1",
    idempotencyKey: "d-input-1",
    operation: { kind: "bytes", bytes: encoder.encode("before-resize") },
  });
  let priorOrder = Number(firstInput.orderedAt);
  for (let revision = 1; revision <= 20; revision += 1) {
    const window = {
      columns: 90 + revision,
      rows: 30 + revision,
      widthPixels: 900 + revision * 10,
      heightPixels: 600 + revision * 10,
    };
    const resized = await host.resize({
      session,
      window,
      revision: String(revision),
      idempotencyKey: `resize-${revision}`,
    });
    expect(resized.state).toBe("applied");
    if (resized.state !== "applied") throw new Error("resize not applied");
    expect(resized.readback).toEqual(window);
    expect(Number(resized.orderedAt)).toBeGreaterThan(priorOrder);
    priorOrder = Number(resized.orderedAt);
    const input = await host.submitInput({
      session,
      claimToken,
      transactionId: `d-input-${revision + 1}`,
      idempotencyKey: `d-input-${revision + 1}`,
      operation: { kind: "bytes", bytes: Uint8Array.of(revision) },
    });
    expect(Number(input.orderedAt)).toBeGreaterThan(priorOrder);
    priorOrder = Number(input.orderedAt);
  }
  expect(host.foregroundObservedWindow(session)).toEqual({
    columns: 110,
    rows: 50,
    widthPixels: 1100,
    heightPixels: 800,
  });
}

function patternChecksum(byteLength: number): number {
  const cycles = Math.floor(byteLength / 251);
  const remainder = byteLength % 251;
  return (cycles * 31_375 + remainder * (remainder - 1) / 2) >>> 0;
}

async function assertE(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-e"));
  host.setOutputPaused(session, true);
  host.setOutputPaused(session, false);
  const bytes = 100 * 1024 * 1024;
  const result = host.producePattern(session, bytes);
  expect(result.producedBytes).toBe(bytes);
  expect(result.checksum).toBe(patternChecksum(bytes));
  expect(result.retainedBytes).toBeLessThanOrEqual(fixtureLimits.outputRetentionBytes);
  expect(result.maxBufferedBytes).toBeLessThanOrEqual(fixtureLimits.outputRetentionBytes);
  expect(result.gapCount).toBe(1);
  expect(result.flowTransitions).toBe(2);
  const capabilities = {
    protocolVersions: ["1.0.0"],
    checkpointContentTypes: ["application/vnd.neutral-terminal-checkpoint"],
    buildId: "slow-viewer-1",
  };
  const disconnected = await host.attach({
    session,
    cursor: { afterEventSequence: "0", afterOutputOffset: "0", checkpoint: null },
    capabilities,
  });
  expect(disconnected.state).toBe("gap");
  if (disconnected.state !== "gap") throw new Error("retention gap not reported");
  const resumed = await host.attach({
    session,
    cursor: {
      afterEventSequence: "0",
      afterOutputOffset: disconnected.retainedOutput.start,
      checkpoint: null,
    },
    capabilities,
  });
  expect(resumed.state).toBe("attached");
  if (resumed.state !== "attached") throw new Error("retained attach failed");
  const acknowledgement = await host.acknowledgeOutput({
    session,
    attachmentId: resumed.attachmentId,
    throughEventSequence: resumed.cursor.afterEventSequence,
    throughOutputOffset: resumed.cursor.afterOutputOffset,
  });
  expect(acknowledgement.availableCreditBytes).toBe(fixtureLimits.outputHighWaterBytes);
}

async function assertF(host: NeutralTerminalHostFixture): Promise<void> {
  for (const [key, signal] of [["freeze-f-normal", null], ["freeze-f-signal", 15]] as const) {
    const session = await createRunning(host, request(key));
    const tail = encoder.encode(`tail:${key}`);
    const events = host.completeWithTail(session, tail, signal);
    expect(events.map((event) => event.kind)).toEqual([
      "output",
      "process-exited",
      "output-closed",
      "process-reaped",
    ]);
    const output = events[0];
    expect(output?.kind).toBe("output");
    if (output?.kind !== "output") throw new Error("tail missing");
    expect(output.bytes).toEqual(tail);
    const reaped = events[3];
    expect(reaped?.kind).toBe("process-reaped");
    if (reaped?.kind !== "process-reaped") throw new Error("reap missing");
    expect(reaped.reap).toMatchObject({ authority: "direct-parent", reaped: true });
  }
}

async function assertG(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-g"));
  const adopted = host.restartBroker(session);
  expect(adopted).toMatchObject({ lifecycle: "running", completeness: "complete" });
  expect(adopted.reap).toMatchObject({ authority: "direct-parent", reaped: false });
  const lost = host.loseParentAuthority(session);
  expect(lost.lifecycle).toBe("lost");
  expect(lost.exit).toBeNull();
  expect(lost.reap).toEqual({
    authority: "unavailable",
    reaped: false,
    status: null,
    completeness: "unavailable",
  });
}

async function assertH(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-h"));
  const chunks = [
    Uint8Array.of(0x1b, 0x5b, 0x33),
    Uint8Array.of(0x31, 0x6d, 0xf0, 0x9f),
    Uint8Array.of(0x98, 0x80, 0x1b, 0x5b, 0x30, 0x6d),
  ];
  for (const chunk of chunks) host.appendOutput(session, chunk);
  const cursorOffset = chunks[0]!.byteLength + chunks[1]!.byteLength;
  const attached = await host.attach({
    session,
    cursor: {
      afterEventSequence: "2",
      afterOutputOffset: String(cursorOffset),
      checkpoint: {
        contentType: "application/vnd.neutral-terminal-checkpoint",
        schemaVersion: "1",
        hash: "sha256:neutral-checkpoint",
        throughEventSequence: "0",
        throughOutputOffset: "0",
      },
    },
    capabilities: {
      protocolVersions: ["1.0.0"],
      checkpointContentTypes: ["application/vnd.neutral-terminal-checkpoint"],
      buildId: "generic-viewer-1",
    },
  });
  expect(attached.state).toBe("attached");
  if (attached.state !== "attached") throw new Error("attach failed");
  expect(attached.cursor.afterOutputOffset).toBe(String(cursorOffset));
  expect(host.replayFromOutput(session, Number(attached.cursor.afterOutputOffset))).toEqual(chunks[2]);
}

async function assertI(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-i"));
  const humanToken = await claim(host, session, "human", "human");
  const automation = await host.claimInput({
    session,
    writer: "automation",
    kind: "automation",
    leaseMilliseconds: 30_000,
    idempotencyKey: "claim-automation",
  });
  expect(automation.state).toBe("denied");
  const input = {
    session,
    claimToken: humanToken,
    transactionId: "i-transaction",
    idempotencyKey: "i-idempotency",
    operation: { kind: "bytes", bytes: encoder.encode("atomic-human-write") } as const,
  };
  const first = await host.submitInput(input);
  const retry = await host.submitInput(input);
  expect(retry).toEqual(first);
  expect(host.inputEffects(session)).toEqual(["bytes:18"]);
}

async function assertJ(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-j"));
  const survivor = host.addDescendant(session, true);
  const result = await host.terminate({
    session,
    mode: "immediate",
    target: "process-tree",
    deadline: "2026-07-17T12:00:02.000Z",
    idempotencyKey: "terminate-j",
  });
  expect(result.state).toBe("survivors");
  expect(result.survivors).toEqual([{
    process: survivor,
    reason: "created a new session outside containment",
  }]);
}

/** §11 row U. A subscription is a resumable cursor: it negotiates, resumes at a
 * host-reported position, delivers every retained event in host order exactly
 * once, releases retention by acknowledgement, reports a position outside
 * retention as an explicit gap, and keeps subscribers independent — including
 * through the incarnation's final, separately ordered facts. */
async function assertU(host: NeutralTerminalHostFixture): Promise<void> {
  const session = await createRunning(host, request("freeze-u"));
  const { retainedEventCount, unacknowledgedEventHighWater } = fixtureSubscriptionLimits;
  const reader = await host.subscribe({
    session,
    capabilities: { protocolVersions: ["1.0.0"] },
    limits: fixtureSubscriptionLimits,
    from: { position: "at", cursor: { eventSequence: "1", outputOffset: "0" } },
  });
  if (reader.state !== "subscribed") throw new Error(`expected subscribed, got ${reader.state}`);
  // The host reports the limits it will honour rather than echoing the offer.
  expect(reader.limits).toEqual(fixtureSubscriptionLimits);
  expect(reader.resumeFrom.eventSequence).toBe("1");

  // Exactly once: draining twice never repeats a delivered event, and a later
  // drain sees only what arrived after the previous one.
  host.appendOutput(session, encoder.encode("alpha"));
  host.appendOutput(session, encoder.encode("beta"));
  expect((await drain(host, session, reader.subscriptionId)).map(sequenceOf)).toEqual(["1", "2"]);
  expect(await drain(host, session, reader.subscriptionId)).toEqual([]);
  host.appendOutput(session, encoder.encode("gamma"));
  expect((await drain(host, session, reader.subscriptionId)).map(sequenceOf)).toEqual(["3"]);
  await host.acknowledgeEvents({
    session,
    subscriptionId: reader.subscriptionId,
    through: { eventSequence: "3", outputOffset: "0" },
  });

  // Exactly once at the INTERRUPTION boundary, which a full drain cannot see:
  // a subscriber that receives one event and abandons the stream before asking
  // for the next must not be redelivered that event when it resumes.
  host.appendOutput(session, encoder.encode("delta-1"));
  host.appendOutput(session, encoder.encode("delta-2"));
  const interrupted: string[] = [];
  for await (const event of host.events({ session, subscriptionId: reader.subscriptionId })) {
    interrupted.push(event.eventSequence);
    break;
  }
  expect(interrupted).toEqual(["4"]);
  expect((await drain(host, session, reader.subscriptionId)).map(sequenceOf)).toEqual(["5"]);

  // Independent subscribers: a second subscription starting at the current end
  // sees only what follows it, and draining either never moves the other.
  const tail = await host.subscribe({
    session,
    capabilities: { protocolVersions: ["1.0.0"] },
    limits: fixtureSubscriptionLimits,
    from: { position: "end" },
  });
  if (tail.state !== "subscribed") throw new Error(`expected subscribed, got ${tail.state}`);
  expect(tail.resumeFrom.eventSequence).toBe("6");
  expect(tail.subscriptionId).not.toBe(reader.subscriptionId);
  host.appendOutput(session, encoder.encode("epsilon"));
  expect((await drain(host, session, tail.subscriptionId)).map(sequenceOf)).toEqual(["6"]);
  expect((await drain(host, session, reader.subscriptionId)).map(sequenceOf)).toEqual(["6"]);

  // Delivery is bounded by negotiated credit, observed as behavior: once this
  // subscription holds high-water events delivered and unacknowledged, its own
  // drain yields nothing even though events are waiting...
  host.appendOutput(session, encoder.encode("zeta"));
  expect((await drain(host, session, reader.subscriptionId)).map(sequenceOf)).toEqual(["7"]);
  host.appendOutput(session, encoder.encode("eta"));
  expect(await drain(host, session, reader.subscriptionId)).toEqual([]);
  // ...and the session is not stalled by it: the other subscriber still moves.
  expect((await drain(host, session, tail.subscriptionId)).map(sequenceOf)).toEqual(["7", "8"]);

  // Acknowledgement RELEASES: it restores this subscription's credit, frees
  // retained storage, and lets delivery resume.
  const retainedBeforeAck = host.retainedEvents(session);
  const released = await host.acknowledgeEvents({
    session,
    subscriptionId: reader.subscriptionId,
    through: { eventSequence: "7", outputOffset: "0" },
  });
  expect(released.subscriptionId).toBe(reader.subscriptionId);
  expect(released.through.eventSequence).toBe("7");
  expect(released.availableEventCredit).toBe(unacknowledgedEventHighWater);
  expect(host.retainedEvents(session)).toBeLessThan(retainedBeforeAck);
  expect((await drain(host, session, reader.subscriptionId)).map(sequenceOf)).toEqual(["8"]);

  // An acknowledgement can never reach past what was delivered: a subscription
  // cannot release events it was never given.
  const overreach = await host.acknowledgeEvents({
    session,
    subscriptionId: tail.subscriptionId,
    through: { eventSequence: "9999", outputOffset: "0" },
  });
  expect(overreach.through.eventSequence).toBe("8");

  // Retention is a real bound on STORAGE, not a number that says it is bounded.
  for (let index = 0; index < retainedEventCount * 2; index += 1) {
    host.appendOutput(session, encoder.encode(`overflow-${index}`));
  }
  expect(host.retainedEvents(session)).toBeLessThanOrEqual(retainedEventCount);

  // A position below what retention still holds is reported explicitly, with
  // the missing range and a fresh-inspection requirement.
  const stale = await host.subscribe({
    session,
    capabilities: { protocolVersions: ["1.0.0"] },
    limits: fixtureSubscriptionLimits,
    from: { position: "at", cursor: { eventSequence: "1", outputOffset: "0" } },
  });
  if (stale.state !== "gap") throw new Error(`expected gap, got ${stale.state}`);
  expect(stale.missing.start).toBe("1");
  expect(Number(stale.missing.endExclusive)).toBeGreaterThan(1);
  expect(stale.freshInspection).toBe("required");

  // The subscriber that was evicted past loses its position as a typed failure
  // naming the missing range — never as a silent jump forward, and never by
  // fabricating an event.
  await expect(drain(host, session, reader.subscriptionId)).rejects
    .toBeInstanceOf(SubscriptionGapError);

  // Final events: an in-retention subscription receives the incarnation's
  // closing facts, separately ordered, with the authoritative reap last.
  const survivor = await host.subscribe({
    session,
    capabilities: { protocolVersions: ["1.0.0"] },
    limits: fixtureSubscriptionLimits,
    from: { position: "end" },
  });
  if (survivor.state !== "subscribed") throw new Error(`expected subscribed, got ${survivor.state}`);
  host.completeWithTail(session, encoder.encode("tail"), null);
  const final = await drain(host, session, survivor.subscriptionId);
  expect(final.map((event) => event.kind))
    .toEqual(["output", "process-exited", "output-closed", "process-reaped"]);
  expect(await drain(host, session, survivor.subscriptionId)).toEqual([]);
}

async function assertK(host: NeutralTerminalHostFixture): Promise<void> {
  const canonical = await createRunning(host, request("freeze-k-canonical", {}, "canonical"));
  const canonicalClaim = await claim(host, canonical, "canonical-human");
  await host.submitInput({
    session: canonical,
    claimToken: canonicalClaim,
    transactionId: "k-canonical-eof",
    idempotencyKey: "k-canonical-eof",
    operation: { kind: "canonical-end-of-file" },
  });
  const literal = await createRunning(host, request("freeze-k-literal", {}, "literal"));
  const literalClaim = await claim(host, literal, "literal-human");
  await host.submitInput({
    session: literal,
    claimToken: literalClaim,
    transactionId: "k-literal-byte",
    idempotencyKey: "k-literal-byte",
    operation: { kind: "bytes", bytes: Uint8Array.of(4) },
  });
  await host.submitInput({
    session: literal,
    claimToken: literalClaim,
    transactionId: "k-hangup",
    idempotencyKey: "k-hangup",
    operation: { kind: "hangup" },
  });
  expect(host.inputEffects(canonical)).toEqual(["canonical-eof"]);
  expect(host.inputEffects(literal)).toEqual(["literal-byte", "hangup"]);
  expect((await host.inspect(literal)).output.closed).toBe(true);
}

describe("terminal-host v1 shape freeze", () => {
  test("contract and fixture versions are exact", () => {
    expect(TERMINAL_HOST_CONTRACT_VERSION).toBe("1.0.0");
    expect(NEUTRAL_FIXTURE_VERSION).toBe("1.0.0");
  });

  test("the target vocabulary contains no product policy or syscall knobs", async () => {
    const source = await readFile(resolve(
      import.meta.dir,
      "../../src/daemon/session-host/terminal-host-contract.ts",
    ), "utf8");
    for (const forbidden of [
      "Hive", "provider", "worktree", "launchGrant", "Workspace", "tmux", "sessiond",
      "forkpty", "openpty", "setsid", "TIOCSCTTY", "TIOCSWINSZ", "TIOCGWINSZ",
    ]) expect(source).not.toContain(forbidden);
  });
});

describe("neutral fixture freeze A–K and U with mutation controls", () => {
  const cases = [
    ["A", assertA],
    ["B", assertB],
    ["C", assertC],
    ["D", assertD],
    ["E", assertE],
    ["F", assertF],
    ["G", assertG],
    ["H", assertH],
    ["I", assertI],
    ["J", assertJ],
    ["K", assertK],
    ["U", assertU],
  ] as const;

  for (const [id, assertion] of cases) {
    test(`${id}: semantic passes and its deliberate violation goes red`, async () => {
      await assertion(new NeutralTerminalHostFixture());
      await expect(assertion(new NeutralTerminalHostFixture(id))).rejects.toBeDefined();
    });
  }
});
