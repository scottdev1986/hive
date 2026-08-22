import type { MeasuredProviderCapabilities } from "../../../schemas/capability";
import { definedFields } from "../../../shared/defined-fields";
import type {
  NormalizedProviderEvent,
  PermissionDecision,
  ProtocolProbe,
  ProviderCapabilitySnapshot,
  ProviderModel,
  ProviderRuntimeAdapter,
  ProviderSession,
  ProviderSpawn,
  SessionResume,
  SessionStart,
  SubmissionReceipt,
  TurnSubmission,
  VendorCommand,
  VendorSessionRef,
} from "./types";

class EventQueue {
  private readonly buffered: NormalizedProviderEvent[] = [];
  private readonly waiting: ((
    value: IteratorResult<NormalizedProviderEvent>,
  ) => void)[] = [];
  private ended = false;

  push(event: NormalizedProviderEvent): void {
    if (this.ended) throw new Error("fake driver: push after close");
    const waiter = this.waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    this.buffered.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<NormalizedProviderEvent>> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

type EmittableEvent<T = NormalizedProviderEvent> =
  T extends NormalizedProviderEvent
    ? Omit<T, "sequence" | "occurredAt" | "raw"> & { raw?: unknown }
    : never;

export interface FakeSubmissionRecord {
  readonly clientInputId: string;
  readonly text: string;
  readonly vendorSessionId: string;
}

export class FakeProviderSession implements ProviderSession {
  readonly capabilities: MeasuredProviderCapabilities;
  readonly adapterChild = null;
  readonly submissions: FakeSubmissionRecord[] = [];
  readonly cancelledTurns: string[] = [];
  readonly permissionDecisions: PermissionDecision[] = [];
  /** Session open path audit: which recovery methods the launch actually called. */
  readonly sessionCalls: Array<
    | { kind: "newSession"; input: SessionStart }
    | { kind: "resumeSession"; input: SessionResume }
  > = [];
  modelIds: readonly string[] = [];
  models: readonly ProviderModel[] = [];
  permissionModes: readonly string[] = [];
  readonly modeSwitches: string[] = [];
  readonly modelSwitches: {
    vendorSessionId: string;
    model: string;
    effort?: string;
  }[] = [];
  readonly commandRoutes = new Set<string>();
  readonly ranCommands: string[] = [];
  readonly ranCommandInputs: {
    vendorSessionId: string;
    name: string;
    arguments?: string;
  }[] = [];
  closed = false;

  private readonly queue = new EventQueue();
  private sequence = 0;
  private clock = 0;
  private sessionCounter = 0;
  private commands: readonly VendorCommand[] = [];
  /** Set by the test so a submission can answer accepted, rejected, or unknown. */
  submitOutcome: SubmissionReceipt["outcome"] = "accepted";

  constructor(capabilities: MeasuredProviderCapabilities) {
    this.capabilities = capabilities;
  }

  get events(): AsyncIterable<NormalizedProviderEvent> {
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.queue.next() }),
    };
  }

  emit(event: EmittableEvent): NormalizedProviderEvent {
    this.sequence += 1;
    this.clock += 1;
    // SAFETY: The surrounding code already established this contract.
    const value = {
      ...event,
      sequence: this.sequence,
      occurredAt: new Date(this.clock).toISOString(),
      raw: event.raw ?? { fake: event.kind },
    } as NormalizedProviderEvent;
    this.queue.push(value);
    return value;
  }

  setCommands(commands: readonly VendorCommand[]): void {
    this.commands = commands;
  }

  newSession(input: SessionStart): Promise<VendorSessionRef> {
    this.sessionCalls.push({ kind: "newSession", input });
    this.sessionCounter += 1;
    return Promise.resolve({
      vendorSessionId: `fake-session-${this.sessionCounter}`,
      replayedHistory: false,
    });
  }

  resumeSession(input: SessionResume): Promise<VendorSessionRef> {
    this.sessionCalls.push({ kind: "resumeSession", input });
    return Promise.resolve({
      vendorSessionId: input.vendorSessionId,
      replayedHistory: input.style === "load",
    });
  }

  submit(input: TurnSubmission): Promise<SubmissionReceipt> {
    this.submissions.push({
      clientInputId: input.clientInputId,
      text: input.text,
      vendorSessionId: input.session.vendorSessionId,
    });
    return Promise.resolve({
      clientInputId: input.clientInputId,
      outcome: this.submitOutcome,
      turnId: null,
    });
  }

  cancel(turnId: string): Promise<void> {
    this.cancelledTurns.push(turnId);
    return Promise.resolve();
  }

  respondToPermission(input: PermissionDecision): Promise<void> {
    this.permissionDecisions.push(input);
    return Promise.resolve();
  }

  setPermissionMode(mode: string): Promise<string> {
    this.modeSwitches.push(mode);
    return Promise.resolve(mode);
  }

  listCommands(): Promise<readonly VendorCommand[]> {
    return Promise.resolve(this.commands);
  }

  listModelIds(): Promise<readonly string[]> {
    return Promise.resolve(this.modelIds);
  }

  listModelCatalog(): Promise<readonly ProviderModel[]> {
    if (this.models.length > 0) return Promise.resolve(this.models);
    return Promise.resolve(
      this.modelIds.map((id) => ({
        id,
        displayName: id,
        description: null,
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      })),
    );
  }

  setModel(input: {
    readonly vendorSessionId: string;
    readonly model: string;
    readonly effort?: string;
  }): Promise<void> {
    this.modelSwitches.push({ ...input });
    return Promise.resolve();
  }

  runCommand(input: {
    readonly vendorSessionId: string;
    readonly name: string;
    readonly arguments?: string;
  }): Promise<boolean> {
    if (!this.commandRoutes.has(input.name)) return Promise.resolve(false);
    this.ranCommands.push(input.name);
    this.ranCommandInputs.push({ ...input });
    return Promise.resolve(true);
  }

  snapshot(): Promise<ProviderCapabilitySnapshot> {
    const observedAt = new Date(this.clock).toISOString();
    return Promise.resolve({
      provider: this.capabilities.provider,
      source: "session",
      observedAt,
      catalog: { status: "unavailable", reason: "fake catalog not supplied" },
      measurements: { ...this.capabilities.measured },
      ...definedFields({ absences: this.capabilities.absences }),
      commands: [...this.commands],
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.queue.end();
    return Promise.resolve();
  }
}

export function fakeCapabilities(
  overrides: Partial<MeasuredProviderCapabilities> = {},
): MeasuredProviderCapabilities {
  return {
    provider: "claude",
    runtime: {
      executable: "/fake/provider",
      version: "0.0.0-fake",
      transport: "fake",
      workingDirectory: "/fake/cwd",
    },
    measured: {
      newSession: "supported",
      prompt: "supported",
      cancel: "supported",
      permissions: "supported",
      streamingText: "supported",
      toolLifecycle: "supported",
      sessionRecovery: "supported",
    },
    handshake: { fake: true },
    ...overrides,
  };
}

export class FakeProviderAdapter implements ProviderRuntimeAdapter {
  readonly id = "fake" as const;
  readonly transport = "fake" as const;
  session: FakeProviderSession | null = null;

  constructor(
    private readonly capabilities: MeasuredProviderCapabilities = fakeCapabilities(),
  ) {}

  probe(executable: string): Promise<ProtocolProbe> {
    const observedAt = new Date(0).toISOString();
    return Promise.resolve({
      provider: this.capabilities.provider,
      source: "probe",
      observedAt,
      catalog: { status: "unavailable", reason: "fake catalog not supplied" },
      measurements: { ...this.capabilities.measured },
      ...definedFields({ absences: this.capabilities.absences }),
      commands: [],
      executable,
      version: this.capabilities.runtime.version,
      transport: "fake",
      verdict: "compatible",
    });
  }

  connect(_spawn: ProviderSpawn): Promise<ProviderSession> {
    const session = new FakeProviderSession(this.capabilities);
    this.session = session;
    return Promise.resolve(session);
  }
}
