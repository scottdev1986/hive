import {
  type AttachResult,
  type Checkpoint,
  type ClaimResult,
  type CreateRequest,
  type CreateResult,
  type ExitStatus,
  type HostLimits,
  type InputClaim,
  type InputReceipt,
  type JobControlEvidence,
  type LaunchFailureLayer,
  type OutputAcknowledgement,
  type ProcessIdentity,
  type ReapEvidence,
  type ResizeResult,
  type SessionInspection,
  type SessionRef,
  type SubscribeResult,
  type SubscriptionCapabilities,
  type SubscriptionCursor,
  type SubscriptionLimits,
  type SubscriptionStart,
  type EventAcknowledgement,
  type TerminalEvent,
  type TerminalHost,
  type TerminationResult,
  type WindowSize,
} from "../../src/daemon/session-host/terminal-host-contract";

export const NEUTRAL_FIXTURE_VERSION = "1.0.0" as const;
export type FreezeCase = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "U";

const AT = "2026-07-17T12:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

export const fixtureLimits: HostLimits = {
  maxInputTransactionBytes: 1024 * 1024,
  maxInputQueueBytes: 4 * 1024 * 1024,
  maxOutputFrameBytes: 64 * 1024,
  outputLowWaterBytes: 256 * 1024,
  outputHighWaterBytes: 512 * 1024,
  outputRetentionBytes: 1024 * 1024,
};

/** §11 retention is deliberately small here so bounded retention and the gap
 * it produces for a subscriber that never acknowledges are both reachable. */
export const fixtureSubscriptionLimits: SubscriptionLimits = {
  maxEventFrameBytes: 64 * 1024,
  retainedEventCount: 8,
  unacknowledgedEventLowWater: 2,
  unacknowledgedEventHighWater: 4,
};

/** §11 a subscription ends on a typed failure, and a broken subscription is
 * never evidence that the session itself changed — so falling out of retention
 * raises this, naming the missing range, and fabricates no event. */
export class SubscriptionGapError extends Error {
  constructor(readonly missing: Readonly<{ start: string; endExclusive: string }>) {
    super(`subscription fell out of retention: ${missing.start}..${missing.endExclusive}`);
  }
}

type SubscriptionState = {
  id: string;
  nextSequence: number;
  acknowledgedThrough: number;
};

type OutputChunk = Readonly<{ start: number; endExclusive: number; bytes: Uint8Array }>;

type RecordState = {
  ref: SessionRef;
  request: CreateRequest;
  host: ProcessIdentity;
  child: ProcessIdentity;
  jobControl: JobControlEvidence;
  window: WindowSize;
  windowRevision: number;
  eventSequence: number;
  mutationSequence: number;
  events: TerminalEvent[];
  retainedEventStart: number;
  subscriptions: Map<string, SubscriptionState>;
  outputChunks: OutputChunk[];
  outputEnd: number;
  retainedStart: number;
  outputClosed: boolean;
  gapCount: number;
  flowTransitions: number;
  outputPaused: boolean;
  maxBufferedBytes: number;
  inputOwner: InputClaim | null;
  inputReceipts: Map<string, InputReceipt>;
  inputEffects: string[];
  inputQueueBytes: number;
  foregroundWindow: WindowSize;
  survivingDescriptors: Set<number>;
  closedSourceHandles: Set<string>;
  lifecycle: SessionInspection["lifecycle"];
  exit: ExitStatus | null;
  reap: ReapEvidence;
  descendants: ProcessIdentity[];
  survivors: { process: ProcessIdentity; reason: string }[];
  checkpoint: Checkpoint;
};

export class StaleIncarnationError extends Error {}

export class NeutralTerminalHostFixture implements TerminalHost {
  readonly version = NEUTRAL_FIXTURE_VERSION;
  readonly fault: FreezeCase | null;
  readonly limits = fixtureLimits;
  private nextIncarnation = 1;
  private nextProcessId = 4100;
  private records = new Map<string, RecordState>();
  private creates = new Map<string, CreateResult>();

  constructor(fault: FreezeCase | null = null) {
    this.fault = fault;
  }

  async create(request: CreateRequest): Promise<CreateResult> {
    const retryKey = `${request.key}\0${request.idempotencyKey}`;
    const prior = this.creates.get(retryKey);
    if (prior) return prior;

    const ref = { key: request.key, incarnation: `inc-${this.nextIncarnation++}` };
    const failure = this.launchFailure(request);
    if (failure) {
      const result: CreateResult = {
        session: ref,
        outcome: {
          state: "exec-failed",
          layer: this.fault === "B" ? "exec-transition" : failure.layer,
          osCode: this.fault === "B" ? null : failure.osCode,
          diagnostic: failure.diagnostic,
        },
        limits: this.limits,
      };
      this.creates.set(retryKey, result);
      if (this.fault === "B") this.records.set(request.key, this.makeRecord(ref, request));
      return result;
    }

    const record = this.makeRecord(ref, request);
    this.records.set(request.key, record);
    const result: CreateResult = {
      session: ref,
      outcome: {
        state: "running",
        child: record.child,
        execProof: "replacement-observed",
        jobControl: record.jobControl,
      },
      limits: this.limits,
    };
    this.creates.set(retryKey, result);
    return result;
  }

  async claimInput(request: Readonly<{
    session: SessionRef;
    writer: string;
    kind: "human" | "automation";
    leaseMilliseconds: number;
    idempotencyKey: string;
  }>): Promise<ClaimResult> {
    const record = this.record(request.session);
    if (record.inputOwner && this.fault !== "I") {
      return { state: "denied", owner: record.inputOwner, diagnostic: "input already claimed" };
    }
    const claim: InputClaim = {
      token: `claim-${request.writer}-${request.idempotencyKey}`,
      writer: request.writer,
      kind: request.kind,
      leaseExpiresAt: FAR_FUTURE,
    };
    record.inputOwner = claim;
    return { state: "granted", claim };
  }

  async releaseInput(request: Readonly<{
    session: SessionRef;
    claimToken: string;
    idempotencyKey: string;
  }>): Promise<void> {
    const record = this.record(request.session);
    if (record.inputOwner?.token !== request.claimToken) throw new Error("claim fenced");
    record.inputOwner = null;
  }

  async submitInput(request: Readonly<{
    session: SessionRef;
    claimToken: string;
    transactionId: string;
    idempotencyKey: string;
    operation:
      | Readonly<{ kind: "bytes"; bytes: Uint8Array }>
      | Readonly<{ kind: "canonical-end-of-file" }>
      | Readonly<{ kind: "hangup" }>;
  }>): Promise<InputReceipt> {
    const record = this.record(request.session);
    const idempotency = `${request.transactionId}\0${request.idempotencyKey}`;
    const prior = record.inputReceipts.get(idempotency);
    if (prior) return prior;
    if (record.inputOwner?.token !== request.claimToken && this.fault !== "I") {
      return {
        transactionId: request.transactionId,
        stage: "rejected",
        byteRange: null,
        orderedAt: null,
        availableCreditBytes: this.limits.maxInputQueueBytes - record.inputQueueBytes,
        consumedByProcess: "not-claimed",
        completeness: "complete",
        diagnostic: "claim fenced",
      };
    }

    const bytes = request.operation.kind === "bytes" ? request.operation.bytes.byteLength : 0;
    if (bytes > this.limits.maxInputTransactionBytes ||
        bytes > this.limits.maxInputQueueBytes - record.inputQueueBytes) {
      return {
        transactionId: request.transactionId,
        stage: "rejected",
        byteRange: null,
        orderedAt: null,
        availableCreditBytes: this.limits.maxInputQueueBytes - record.inputQueueBytes,
        consumedByProcess: "not-claimed",
        completeness: "complete",
        diagnostic: "bounded input capacity exhausted",
      };
    }

    const start = record.inputQueueBytes;
    record.inputQueueBytes += bytes;
    const order = ++record.mutationSequence;
    if (request.operation.kind === "canonical-end-of-file") {
      record.inputEffects.push(record.request.terminalProfile.inputMode === "canonical"
        ? "canonical-eof"
        : "literal-eof-request-rejected");
    } else if (request.operation.kind === "hangup") {
      record.inputEffects.push("hangup");
      this.closeOutput(record, "terminal hangup");
    } else if (
      request.operation.bytes.byteLength === 1 &&
      request.operation.bytes[0] === record.request.terminalProfile.eofByte
    ) {
      record.inputEffects.push(
        record.request.terminalProfile.inputMode === "canonical" || this.fault === "K"
          ? "canonical-eof"
          : "literal-byte",
      );
    } else {
      record.inputEffects.push(`bytes:${request.operation.bytes.byteLength}`);
    }

    const receipt: InputReceipt = {
      transactionId: request.transactionId,
      stage: "written-to-terminal",
      byteRange: bytes === 0
        ? null
        : { start: String(start), endExclusive: String(start + bytes) },
      orderedAt: String(order),
      availableCreditBytes: this.limits.maxInputQueueBytes - record.inputQueueBytes,
      consumedByProcess: "not-claimed",
      completeness: "complete",
      diagnostic: null,
    };
    record.inputReceipts.set(idempotency, receipt);
    return receipt;
  }

  async resize(request: Readonly<{
    session: SessionRef;
    window: WindowSize;
    revision: string;
    idempotencyKey: string;
  }>): Promise<ResizeResult> {
    const record = this.record(request.session);
    const revision = Number(request.revision);
    if (!Number.isSafeInteger(revision) || revision <= record.windowRevision) {
      return { state: "stale", currentRevision: String(record.windowRevision) };
    }
    const priorOrder = record.mutationSequence;
    const order = ++record.mutationSequence;
    record.window = request.window;
    record.windowRevision = revision;
    if (this.fault !== "D") record.foregroundWindow = request.window;
    const readback = this.fault === "D"
      ? { ...request.window, rows: request.window.rows - 1 }
      : request.window;
    this.pushEvent(record, {
      kind: "resize-applied",
      revision: request.revision,
      readback,
    });
    return {
      state: "applied",
      revision: request.revision,
      readback,
      orderedAt: String(this.fault === "D" ? priorOrder : order),
      foregroundProcessObservation: "not-claimed",
    };
  }

  async attach(request: Readonly<{
    session: SessionRef;
    cursor: {
      afterEventSequence: string;
      afterOutputOffset: string;
      checkpoint: {
        contentType: string;
        schemaVersion: string;
        hash: string;
        throughEventSequence: string;
        throughOutputOffset: string;
      } | null;
    };
    capabilities: {
      protocolVersions: readonly string[];
      checkpointContentTypes: readonly string[];
      buildId: string;
    };
  }>): Promise<AttachResult> {
    const record = this.record(request.session);
    const offset = Number(request.cursor.afterOutputOffset);
    if (offset < record.retainedStart) {
      return {
        state: "gap",
        retainedOutput: {
          start: String(record.retainedStart),
          endExclusive: String(record.outputEnd),
        },
        requiredCheckpoint: record.checkpoint,
      };
    }
    if (!request.capabilities.protocolVersions.includes("1.0.0") ||
        !request.capabilities.checkpointContentTypes.includes(record.checkpoint.contentType)) {
      return { state: "unknown", diagnostic: "no compatible protocol/checkpoint" };
    }
    return {
      state: "attached",
      attachmentId: "attachment-neutral",
      negotiatedProtocol: "1.0.0",
      hostBuildId: "neutral-fixture-1.0.0",
      cursor: {
        ...request.cursor,
        afterOutputOffset: String(this.fault === "H" && offset > 0 ? offset - 1 : offset),
      },
      checkpoint: request.cursor.checkpoint ? null : record.checkpoint,
      limits: this.limits,
    };
  }

  async acknowledgeOutput(_request: Readonly<{
    session: SessionRef;
    attachmentId: string;
    throughEventSequence: string;
    throughOutputOffset: string;
  }>): Promise<OutputAcknowledgement> {
    return {
      throughEventSequence: _request.throughEventSequence,
      throughOutputOffset: _request.throughOutputOffset,
      availableCreditBytes: this.limits.outputHighWaterBytes,
    };
  }

  async inspect(session: SessionRef): Promise<SessionInspection> {
    return this.inspection(this.record(session));
  }

  async list(): Promise<readonly SessionInspection[]> {
    return [...this.records.values()].map((record) => this.inspection(record));
  }

  /** §11 negotiate, then resume. `resumeFrom` is where delivery WILL begin,
   * reported by the host rather than echoed from the request, and a position
   * below what retention still holds is a gap naming the missing range — never
   * a silent jump forward. */
  async subscribe(request: Readonly<{
    session: SessionRef;
    capabilities: SubscriptionCapabilities;
    limits: SubscriptionLimits;
    from: SubscriptionStart;
  }>): Promise<SubscribeResult> {
    const record = this.record(request.session);
    if (!request.capabilities.protocolVersions.includes("1.0.0")) {
      return { state: "unknown", diagnostic: "no compatible protocol" };
    }
    const from = request.from.position === "end"
      ? record.eventSequence + 1
      : Number(request.from.cursor.eventSequence);
    if (from < record.retainedEventStart) {
      return {
        state: "gap",
        missing: {
          start: String(from),
          endExclusive: String(record.retainedEventStart),
        },
        freshInspection: "required",
      };
    }
    const id = `subscription-${record.subscriptions.size + 1}-${record.ref.incarnation}`;
    record.subscriptions.set(id, { id, nextSequence: from, acknowledgedThrough: from - 1 });
    return {
      state: "subscribed",
      subscriptionId: id,
      negotiatedProtocol: "1.0.0",
      // The host selects the limits it will honour; it does not adopt what it
      // was offered, which is what makes this negotiated rather than assumed.
      limits: fixtureSubscriptionLimits,
      resumeFrom: {
        eventSequence: String(from),
        outputOffset: String(this.outputOffsetAt(record, from)),
      },
    };
  }

  /** §11 delivery for ONE subscription. Each subscription owns its own
   * position, so a subscription that is never drained neither delays nor
   * reorders another's events, and never stalls the session. */
  async *events(request: Readonly<{
    session: SessionRef;
    subscriptionId: string;
  }>): AsyncIterable<TerminalEvent> {
    const record = this.record(request.session);
    const subscription = record.subscriptions.get(request.subscriptionId);
    if (!subscription) throw new Error(`unknown subscription ${request.subscriptionId}`);
    if (subscription.nextSequence < record.retainedEventStart) {
      throw new SubscriptionGapError({
        start: String(subscription.nextSequence),
        endExclusive: String(record.retainedEventStart),
      });
    }
    const end = record.eventSequence;
    for (let sequence = subscription.nextSequence; sequence <= end; sequence += 1) {
      yield record.events[sequence - 1]!;
      subscription.nextSequence = sequence + 1;
    }
    if (this.fault === "U") subscription.nextSequence = end;
  }

  /** §11 retained events are released by acknowledgement on the same terms as
   * output. The release names its subscription, so one subscriber's
   * acknowledgement never releases what another has not been delivered. */
  async acknowledgeEvents(request: Readonly<{
    session: SessionRef;
    subscriptionId: string;
    through: SubscriptionCursor;
  }>): Promise<EventAcknowledgement> {
    const record = this.record(request.session);
    const subscription = record.subscriptions.get(request.subscriptionId);
    if (!subscription) throw new Error(`unknown subscription ${request.subscriptionId}`);
    subscription.acknowledgedThrough = Math.max(
      subscription.acknowledgedThrough,
      Number(request.through.eventSequence),
    );
    const unacknowledged = record.eventSequence - subscription.acknowledgedThrough;
    return {
      subscriptionId: subscription.id,
      through: {
        eventSequence: String(subscription.acknowledgedThrough),
        outputOffset: String(this.outputOffsetAt(record, subscription.acknowledgedThrough + 1)),
      },
      availableEventCredit: Math.max(
        0,
        fixtureSubscriptionLimits.unacknowledgedEventHighWater - unacknowledged,
      ),
    };
  }

  async terminate(request: Readonly<{
    session: SessionRef;
    mode: "graceful" | "immediate";
    target: "foreground-group" | "session-members" | "process-tree";
    deadline: string;
    idempotencyKey: string;
  }>): Promise<TerminationResult> {
    const record = this.record(request.session);
    const escaped = record.survivors;
    if (escaped.length > 0 && this.fault !== "J") {
      return {
        state: "survivors",
        exit: record.exit,
        reap: record.reap,
        survivors: escaped,
        completeness: "complete",
        diagnostics: ["one descendant escaped the selected containment target"],
      };
    }
    const exit: ExitStatus = { code: null, signal: request.mode === "immediate" ? 9 : 15, observedAt: AT };
    record.exit = exit;
    record.lifecycle = "exited";
    record.reap = {
      authority: "direct-parent",
      reaped: true,
      status: exit,
      completeness: "complete",
    };
    return {
      state: "terminated",
      exit,
      reap: record.reap,
      survivors: [],
      completeness: "complete",
      diagnostics: [],
    };
  }

  survivingDescriptors(session: SessionRef): readonly number[] {
    return [...this.record(session).survivingDescriptors].sort((a, b) => a - b);
  }

  sourceHandleWasClosed(session: SessionRef, token: string): boolean {
    return this.record(session).closedSourceHandles.has(token);
  }

  inputEffects(session: SessionRef): readonly string[] {
    return this.record(session).inputEffects;
  }

  foregroundObservedWindow(session: SessionRef): WindowSize {
    return this.record(session).foregroundWindow;
  }

  setOutputPaused(session: SessionRef, paused: boolean): void {
    const record = this.record(session);
    record.outputPaused = paused;
    record.flowTransitions += 1;
    this.pushEvent(record, { kind: "flow-control", outputPaused: paused });
  }

  producePattern(session: SessionRef, byteLength: number): Readonly<{
    producedBytes: number;
    retainedBytes: number;
    checksum: number;
    gapCount: number;
    maxBufferedBytes: number;
    flowTransitions: number;
  }> {
    const record = this.record(session);
    const cycles = Math.floor(byteLength / 251);
    const remainder = byteLength % 251;
    const checksum = (cycles * 31_375 + remainder * (remainder - 1) / 2) >>> 0;
    record.outputEnd += byteLength;
    const retainedBytes = Math.min(record.outputEnd, this.limits.outputRetentionBytes);
    record.retainedStart = record.outputEnd - retainedBytes;
    record.maxBufferedBytes = Math.max(record.maxBufferedBytes, retainedBytes);
    if (record.retainedStart > 0 && this.fault !== "E") record.gapCount = 1;
    return {
      producedBytes: byteLength,
      retainedBytes,
      checksum: this.fault === "E" ? (checksum + 1) >>> 0 : checksum,
      gapCount: record.gapCount,
      maxBufferedBytes: record.maxBufferedBytes,
      flowTransitions: record.flowTransitions,
    };
  }

  appendOutput(session: SessionRef, bytes: Uint8Array): void {
    const record = this.record(session);
    const start = record.outputEnd;
    record.outputEnd += bytes.byteLength;
    record.outputChunks.push({ start, endExclusive: record.outputEnd, bytes: bytes.slice() });
    this.pushEvent(record, {
      kind: "output",
      bytes: bytes.slice(),
      outputRange: { start: String(start), endExclusive: String(record.outputEnd) },
    });
  }

  replayFromOutput(session: SessionRef, offset: number): Uint8Array {
    const record = this.record(session);
    const parts: number[] = [];
    if (this.fault === "H" && offset > 0) {
      const prior = this.byteAt(record, offset - 1);
      if (prior !== null) parts.push(prior);
    }
    for (const chunk of record.outputChunks) {
      if (chunk.endExclusive <= offset) continue;
      const start = Math.max(offset, chunk.start) - chunk.start;
      parts.push(...chunk.bytes.slice(start));
    }
    return Uint8Array.from(parts);
  }

  completeWithTail(session: SessionRef, tail: Uint8Array, signal: number | null): readonly TerminalEvent[] {
    const record = this.record(session);
    if (this.fault === "F") this.closeOutput(record, "fault: closed before tail drain");
    else this.appendOutput(session, tail);
    const exit: ExitStatus = { code: signal === null ? 0 : null, signal, observedAt: AT };
    record.exit = exit;
    record.lifecycle = "exited";
    this.pushEvent(record, { kind: "process-exited", exit });
    if (!record.outputClosed) this.closeOutput(record, "terminal endpoint closed after drain");
    record.reap = {
      authority: "direct-parent",
      reaped: true,
      status: exit,
      completeness: "complete",
    };
    this.pushEvent(record, { kind: "process-reaped", reap: record.reap });
    return record.events;
  }

  restartBroker(session: SessionRef): SessionInspection {
    return this.inspection(this.record(session));
  }

  loseParentAuthority(session: SessionRef): SessionInspection {
    const record = this.record(session);
    record.lifecycle = this.fault === "G" ? "exited" : "lost";
    record.exit = this.fault === "G" ? { code: 0, signal: null, observedAt: AT } : null;
    record.reap = this.fault === "G"
      ? {
          authority: "durable-parent-record",
          reaped: true,
          status: record.exit,
          completeness: "complete",
        }
      : {
          authority: "unavailable",
          reaped: false,
          status: null,
          completeness: "unavailable",
        };
    return this.inspection(record);
  }

  addDescendant(session: SessionRef, escaped: boolean): ProcessIdentity {
    const record = this.record(session);
    const process = { processId: this.nextProcessId++, startToken: `start-${this.nextProcessId}` };
    record.descendants.push(process);
    if (escaped) record.survivors.push({ process, reason: "created a new session outside containment" });
    return process;
  }

  private launchFailure(request: CreateRequest): Readonly<{
    layer: LaunchFailureLayer;
    osCode: string;
    diagnostic: string;
  }> | null {
    if (request.command.executable.startsWith("missing:")) {
      return { layer: "command", osCode: "ENOENT", diagnostic: "executable not found" };
    }
    if (request.command.workingDirectory.startsWith("invalid:")) {
      return { layer: "working-directory", osCode: "ENOENT", diagnostic: "working directory unavailable" };
    }
    const environmentBytes = request.command.completeEnvironment.reduce(
      (total, entry) => total + entry.name.length + entry.value.length + 2,
      0,
    );
    if (environmentBytes > 4096) {
      return { layer: "environment", osCode: "E2BIG", diagnostic: "complete environment exceeds fixture limit" };
    }
    if (request.command.descriptorMap.some((mapping) => mapping.handle.token === "unmappable")) {
      return { layer: "descriptor-transfer", osCode: "EBADF", diagnostic: "handle cannot be transferred" };
    }
    return null;
  }

  private makeRecord(ref: SessionRef, request: CreateRequest): RecordState {
    const host = { processId: this.nextProcessId++, startToken: `start-${this.nextProcessId}` };
    const child = { processId: this.nextProcessId++, startToken: `start-${this.nextProcessId}` };
    const terminalIdentity = `terminal-${ref.incarnation}`;
    const jobControl: JobControlEvidence = {
      sessionLeader: this.fault !== "A",
      controllingTerminal: this.fault !== "A",
      standardStreamsShareTerminal: this.fault !== "A",
      childSessionId: child.processId,
      childProcessGroupId: child.processId,
      foregroundProcessGroupId: this.fault === "A" ? child.processId + 1 : child.processId,
      terminalIdentity,
      initialProfileAppliedBeforeExec: this.fault !== "A",
      initialWindowAppliedBeforeExec: this.fault !== "A",
      completeness: "complete",
    };
    const checkpoint: Checkpoint = {
      contentType: "application/vnd.neutral-terminal-checkpoint",
      schemaVersion: "1",
      hashAlgorithm: "sha256",
      hash: "sha256:neutral-checkpoint",
      throughEventSequence: "0",
      throughOutputOffset: "0",
      opaqueBytes: Uint8Array.of(0x43, 0x50, 0x31),
    };
    const survivingDescriptors = new Set([0, 1, 2]);
    const closedSourceHandles = new Set<string>();
    for (const mapping of request.command.descriptorMap) {
      survivingDescriptors.add(mapping.targetDescriptor);
      if (mapping.handle.sourceDisposition === "close-after-transfer") {
        closedSourceHandles.add(mapping.handle.token);
      }
    }
    if (this.fault === "C") survivingDescriptors.add(99);
    return {
      ref,
      request,
      host,
      child,
      jobControl,
      window: request.initialWindow,
      windowRevision: 0,
      eventSequence: 0,
      mutationSequence: 0,
      events: [],
      retainedEventStart: 1,
      subscriptions: new Map(),
      outputChunks: [],
      outputEnd: 0,
      retainedStart: 0,
      outputClosed: false,
      gapCount: 0,
      flowTransitions: 0,
      outputPaused: false,
      maxBufferedBytes: 0,
      inputOwner: null,
      inputReceipts: new Map(),
      inputEffects: [],
      inputQueueBytes: 0,
      foregroundWindow: request.initialWindow,
      survivingDescriptors,
      closedSourceHandles,
      lifecycle: "running",
      exit: null,
      reap: {
        authority: "direct-parent",
        reaped: false,
        status: null,
        completeness: "complete",
      },
      descendants: [],
      survivors: [],
      checkpoint,
    };
  }

  private record(session: SessionRef): RecordState {
    const record = this.records.get(session.key);
    if (!record || record.ref.incarnation !== session.incarnation) {
      throw new StaleIncarnationError(`stale incarnation for ${session.key}`);
    }
    return record;
  }

  private inspection(record: RecordState): SessionInspection {
    return {
      session: record.ref,
      lifecycle: record.lifecycle,
      completeness: record.lifecycle === "lost" ? "partial" : "complete",
      host: record.host,
      child: record.child,
      jobControl: record.jobControl,
      window: { value: record.window, revision: String(record.windowRevision) },
      output: {
        closed: record.outputClosed,
        retained: { start: String(record.retainedStart), endExclusive: String(record.outputEnd) },
      },
      checkpoints: { retained: 1, newest: record.checkpoint },
      inputOwner: record.inputOwner,
      exit: record.exit,
      reap: record.reap,
      descendants: record.descendants,
      survivors: record.survivors,
      evidenceAt: AT,
      diagnostics: record.lifecycle === "lost" ? ["parent authority unavailable"] : [],
    };
  }

  private pushEvent(
    record: RecordState,
    event: Omit<TerminalEvent, "session" | "eventSequence" | "occurredAt">,
  ): void {
    record.eventSequence += 1;
    record.events.push({
      ...event,
      session: record.ref,
      eventSequence: String(record.eventSequence),
      occurredAt: AT,
    } as TerminalEvent);
    // Retention is bounded and the session never stalls for a subscriber, so
    // an unacknowledged laggard is evicted past rather than blocking the
    // producer. It loses its position explicitly (SubscriptionGapError), never
    // silently.
    const retained = record.eventSequence - record.retainedEventStart + 1;
    if (retained > fixtureSubscriptionLimits.retainedEventCount) {
      record.retainedEventStart = record.eventSequence
        - fixtureSubscriptionLimits.retainedEventCount + 1;
    }
  }

  /** The output offset standing beside an event position, so a delivered event
   * and the output around it are comparable without a second clock. */
  private outputOffsetAt(record: RecordState, sequence: number): number {
    let offset = 0;
    for (const event of record.events) {
      if (Number(event.eventSequence) >= sequence) break;
      if (event.kind === "output") offset = Number(event.outputRange.endExclusive);
    }
    return offset;
  }

  private closeOutput(record: RecordState, reason: string): void {
    if (record.outputClosed) return;
    record.outputClosed = true;
    this.pushEvent(record, { kind: "output-closed", reason });
  }

  private byteAt(record: RecordState, offset: number): number | null {
    for (const chunk of record.outputChunks) {
      if (offset >= chunk.start && offset < chunk.endExclusive) return chunk.bytes[offset - chunk.start] ?? null;
    }
    return null;
  }
}
