import { createHash } from "node:crypto";
import type { ReapDependencies } from "../teardown";
import {
  hiveInstanceSuffix,
  hiveTmuxSocketName,
} from "../tmux-sessions";
import {
  TmuxAdapter,
  type TmuxAdapterOptions,
  type TmuxEngine,
} from "../../adapters/tmux";
import type { AgentRecord } from "../../schemas/agent";
import type {
  AttachGrant,
  AttachRequest,
  AutomatedInput,
  CaptureRequest,
  CaptureResult,
  CreateResult,
  InputReceipt,
  ResizeResult,
  SessionEvent,
  SessionHost,
  SessionInspection,
  SessionLocator,
  SessionSpec,
  TerminalGeometry,
  TerminationRequest,
  TerminationResult,
  VisibilityLease,
  VisibilityRequest,
} from "./contract";
import {
  mintTmuxSessionLocator,
  sessionInstanceId,
} from "./locators";

export { mintTmuxSessionLocator } from "./locators";
export type { TmuxAdapterOptions, TmuxEngine } from "../../adapters/tmux";

export const DEFAULT_TMUX_GEOMETRY: TerminalGeometry = {
  columns: 80,
  rows: 24,
  widthPx: 640,
  heightPx: 384,
  cellWidthPx: 8,
  cellHeightPx: 16,
};

const ATTACH_GRANT_MS = 30_000;
const VISIBILITY_LEASE_MS = 15_000;
const EVENT_RETENTION = 256;

type BindingOptions = Readonly<{
  expectedExecutable?: string;
  geometry?: TerminalGeometry;
  capabilityEpoch?: number;
  extraRoots?: () => Promise<readonly number[]>;
  beforeTerminate?: () => void | Promise<void>;
}>;

type Binding = {
  locator: SessionLocator;
  tmuxSession: string;
  expectedExecutable: string;
  geometry: TerminalGeometry;
  capabilityEpoch: number;
  extraRoots?: () => Promise<readonly number[]>;
  beforeTerminate?: () => void | Promise<void>;
};

export type LegacyUnboundTmuxSession = Readonly<{
  tmuxSession: string;
  locator: null;
  presence: "unknown";
  complete: false;
  evidenceAt: string;
  diagnosticIds: readonly ["TMUX_LEGACY_UNBOUND"];
}>;

export type TmuxListResult = Readonly<{
  inspections: readonly SessionInspection[];
  legacyUnbound: readonly LegacyUnboundTmuxSession[];
  complete: boolean;
}>;

export class LegacyUnboundTmuxSessionsError extends Error {
  constructor(readonly sessions: readonly LegacyUnboundTmuxSession[]) {
    super(
      `tmux contains ${sessions.length} legacy session(s) without persisted SessionLocator bindings`,
    );
    this.name = "LegacyUnboundTmuxSessionsError";
  }
}

export interface TmuxSessionHostOptions {
  adapter?: TmuxEngine;
  adapterOptions?: TmuxAdapterOptions;
  socketName?: string;
  now?: () => Date;
  reap?: ReapDependencies;
}

/**
 * tmux SessionHost conformance notes
 *
 * tmux cannot enforce one-use attach grants or visibility leases. issueAttach
 * therefore returns an empty token and an advisory expiry, while
 * renewVisibility records only an advisory deadline; neither is authority or
 * evidence that a viewer attached. tmux also has no durable output/checkpoint
 * sequence, retained exit record, host start token, input arbiter, or event
 * journal. Those fields stay at explicit unavailable values and inspections
 * remain incomplete. The in-process event stream is ordered but not durable
 * and emits no fabricated heartbeats. A transport failure becomes `unknown`,
 * never an absent/exited result. Live sessions without a persisted exact
 * binding are surfaced as typed `legacyUnbound` entries rather than assigned
 * invented locators.
 */
export class TmuxSessionHost implements SessionHost {
  private readonly adapter: TmuxEngine;
  private readonly now: () => Date;
  private readonly reap?: ReapDependencies;
  private readonly bindings = new Map<string, Binding>();
  private readonly receipts = new Map<string, InputReceipt>();
  private readonly events: SessionEvent[] = [];
  private readonly subscribers = new Set<(event: SessionEvent) => void>();
  private eventSeq = 0n;

  constructor(options: TmuxSessionHostOptions = {}) {
    this.adapter = options.adapter ??
      new TmuxAdapter(options.socketName, options.adapterOptions);
    this.now = options.now ?? (() => new Date());
    this.reap = options.reap;
  }

  bind(
    locator: SessionLocator,
    tmuxSession: string,
    options: BindingOptions = {},
  ): void {
    if (locator.hostKind !== "tmux") {
      throw new Error("TmuxSessionHost accepts only hostKind=tmux locators");
    }
    const key = locatorKey(locator);
    const existing = this.bindings.get(key);
    if (existing !== undefined && existing.tmuxSession !== tmuxSession) {
      throw new Error("SessionLocator is already bound to another tmux session");
    }
    this.bindings.set(key, {
      locator,
      tmuxSession,
      expectedExecutable: options.expectedExecutable ?? existing?.expectedExecutable ?? "unknown",
      geometry: options.geometry ?? existing?.geometry ?? DEFAULT_TMUX_GEOMETRY,
      capabilityEpoch: options.capabilityEpoch ?? existing?.capabilityEpoch ?? 0,
      ...(options.extraRoots === undefined
        ? existing?.extraRoots === undefined ? {} : { extraRoots: existing.extraRoots }
        : { extraRoots: options.extraRoots }),
      ...(options.beforeTerminate === undefined
        ? existing?.beforeTerminate === undefined
          ? {}
          : { beforeTerminate: existing.beforeTerminate }
        : { beforeTerminate: options.beforeTerminate }),
    });
  }

  async create(spec: SessionSpec, initialInput: Uint8Array): Promise<CreateResult> {
    const binding = this.binding(spec.locator);
    if (await this.adapter.hasSession(binding.tmuxSession)) {
      throw new Error("SessionLocator is already present");
    }
    binding.expectedExecutable = spec.expectedExecutable;
    binding.geometry = spec.geometry;
    binding.capabilityEpoch = spec.capabilityEpoch;
    await this.adapter.newSession(
      binding.tmuxSession,
      spec.cwd,
      commandForSpec(spec),
      spec.geometry,
    );
    if (initialInput.byteLength > 0) {
      if (this.adapter.sendBytes === undefined) {
        throw new Error("tmux engine cannot accept initial input bytes");
      }
      await this.adapter.sendBytes(binding.tmuxSession, initialInput, {
        submit: "none",
      });
    }
    const inspection = await this.inspect(spec.locator);
    if (inspection.presence !== "present") {
      throw new Error("tmux create readback did not prove the session present");
    }
    this.emit(spec.locator, "created", { presence: "present" });
    return { locator: spec.locator, inspection, created: true };
  }

  async inspect(locator: SessionLocator): Promise<SessionInspection> {
    const binding = this.binding(locator);
    const evidenceAt = this.now().toISOString();
    let present: boolean;
    try {
      present = await this.adapter.hasSession(binding.tmuxSession);
    } catch {
      return this.inspection(binding, {
        presence: "unknown",
        evidenceAt,
        diagnosticIds: ["TMUX_TRANSPORT_UNKNOWN"],
      });
    }
    if (!present) {
      return this.inspection(binding, {
        presence: "lost",
        evidenceAt,
        diagnosticIds: ["TMUX_ABSENCE_WITHOUT_EXIT_RECORD"],
      });
    }

    let viewerCount = 0;
    let providerRoot: SessionInspection["providerRoot"] = null;
    let geometry = binding.geometry;
    const diagnosticIds = ["TMUX_CONFORMANCE_DEGRADED"];
    try {
      viewerCount = this.adapter.listClientTtys === undefined
        ? 0
        : (await this.adapter.listClientTtys(binding.tmuxSession)).length;
      if (this.adapter.listClientTtys === undefined) {
        diagnosticIds.push("TMUX_VIEWERS_UNKNOWN");
      }
    } catch {
      diagnosticIds.push("TMUX_VIEWERS_UNKNOWN");
    }
    try {
      if (this.adapter.paneState === undefined) {
        diagnosticIds.push("TMUX_GEOMETRY_UNKNOWN");
      } else {
        const pane = await this.adapter.paneState(binding.tmuxSession);
        geometry = geometryFromPane(binding.geometry, pane.columns, pane.rows);
        binding.geometry = geometry;
      }
    } catch {
      diagnosticIds.push("TMUX_GEOMETRY_UNKNOWN");
    }
    try {
      const [pid] = this.adapter.listPanePids === undefined
        ? []
        : await this.adapter.listPanePids(binding.tmuxSession);
      if (pid !== undefined) providerRoot = await processIdentity(pid);
      if (providerRoot === null) diagnosticIds.push("TMUX_PROCESS_IDENTITY_INCOMPLETE");
    } catch {
      diagnosticIds.push("TMUX_PROCESS_ROOT_UNKNOWN");
    }
    return this.inspection(binding, {
      presence: "present",
      evidenceAt,
      viewerCount,
      providerRoot,
      geometry,
      diagnosticIds,
    });
  }

  async list(instanceId: string): Promise<readonly SessionInspection[]> {
    const result = await this.listDetailed(instanceId);
    if (!result.complete) {
      throw new LegacyUnboundTmuxSessionsError(result.legacyUnbound);
    }
    return result.inspections;
  }

  async listDetailed(instanceId: string): Promise<TmuxListResult> {
    let sessions: readonly string[];
    try {
      if (this.adapter.listSessions === undefined) {
        return { inspections: [], legacyUnbound: [], complete: false };
      }
      sessions = await this.adapter.listSessions();
    } catch {
      return { inspections: [], legacyUnbound: [], complete: false };
    }
    const live = new Set(sessions);
    const boundNames = new Set<string>();
    const inspections: SessionInspection[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.locator.instanceId !== instanceId) continue;
      boundNames.add(binding.tmuxSession);
      inspections.push(await this.inspect(binding.locator));
    }
    const legacyUnbound = [...live]
      .filter((session) => !boundNames.has(session))
      .map((tmuxSession): LegacyUnboundTmuxSession => ({
        tmuxSession,
        locator: null,
        presence: "unknown",
        complete: false,
        evidenceAt: this.now().toISOString(),
        diagnosticIds: ["TMUX_LEGACY_UNBOUND"],
      }));
    return {
      inspections,
      legacyUnbound,
      complete: legacyUnbound.length === 0,
    };
  }

  async capture(
    locator: SessionLocator,
    request: CaptureRequest,
  ): Promise<CaptureResult> {
    const binding = this.binding(locator);
    if (this.adapter.paneState === undefined) {
      throw new Error("tmux engine cannot capture coherent pane metadata");
    }
    const pane = await this.adapter.paneState(binding.tmuxSession);
    const raw = request.include === "visible-text"
      ? await this.adapter.capturePane(binding.tmuxSession)
      : null;
    const lines = raw?.split("\n") ?? [];
    const truncated = raw !== null && lines.length > request.maxRows;
    const text = raw === null
      ? null
      : (truncated ? lines.slice(-request.maxRows).join("\n") : raw);
    const bytes = new TextEncoder().encode(text ?? "");
    return {
      locator,
      outputSeq: "0",
      columns: pane.columns,
      rows: pane.rows,
      screen: "primary",
      cursor: {
        row: pane.cursorRow,
        column: pane.cursorColumn,
        visible: pane.cursorVisible,
      },
      text,
      truncated,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async issueAttach(
    locator: SessionLocator,
    request: AttachRequest,
  ): Promise<AttachGrant> {
    const inspection = await this.inspect(locator);
    if (inspection.presence !== "present") {
      throw new Error("Cannot attach to a tmux session that is not proven present");
    }
    await this.resize(locator, request.geometry);
    return {
      locator,
      endpoint: "tmux-compatibility",
      token: "",
      expiresAt: new Date(this.now().getTime() + ATTACH_GRANT_MS).toISOString(),
      engineBuildId: locator.engineBuildId ?? "tmux-build-unknown",
      checkpointSeq: "0",
      outputSeq: "0",
      operations: request.operations,
    };
  }

  async compatibilityAttach(
    locator: SessionLocator,
    request: AttachRequest,
  ): Promise<Readonly<{ grant: AttachGrant; tmuxSession: string; socketName: string }>> {
    const binding = this.binding(locator);
    return {
      grant: await this.issueAttach(locator, request),
      tmuxSession: binding.tmuxSession,
      socketName: this.adapter.getSocketName?.() ?? "",
    };
  }

  compatibilitySessionName(locator: SessionLocator): string {
    return this.binding(locator).tmuxSession;
  }

  locatorForCompatibilitySession(tmuxSession: string): SessionLocator | null {
    const matches = [...this.bindings.values()]
      .filter((binding) => binding.tmuxSession === tmuxSession);
    if (matches.length !== 1) return null;
    return matches[0]!.locator;
  }

  compatibilityEndpoint(
    tmuxSession: string,
  ): Readonly<{ tmuxSession: string; socketName: string }> {
    return {
      tmuxSession,
      socketName: this.adapter.getSocketName?.() ?? "",
    };
  }

  compatibilityLaunchCommand(
    tmuxSession: string,
    cwd: string,
    argv: readonly string[],
  ): string[] {
    const socketName = this.adapter.getSocketName?.() ?? "";
    return [
      "tmux",
      ...(socketName === "" ? [] : ["-L", socketName]),
      "new-session",
      "-s",
      tmuxSession,
      "-c",
      cwd,
      ...argv,
      ";",
      "set-option",
      "-g",
      "mouse",
      "on",
    ];
  }

  async renewVisibility(
    locator: SessionLocator,
    request: VisibilityRequest,
  ): Promise<VisibilityLease> {
    const inspection = await this.inspect(locator);
    if (inspection.presence !== "present") {
      throw new Error("Cannot renew visibility for a session not proven present");
    }
    return {
      locator,
      state: "active",
      expiresAt: new Date(this.now().getTime() + VISIBILITY_LEASE_MS).toISOString(),
      openTerminalRevision: request.openTerminalRevision,
    };
  }

  async resize(
    locator: SessionLocator,
    geometry: TerminalGeometry,
  ): Promise<ResizeResult> {
    validateGeometry(geometry);
    const binding = this.binding(locator);
    if (this.adapter.resizeSession === undefined) {
      throw new Error("tmux engine cannot resize sessions");
    }
    await this.adapter.resizeSession(binding.tmuxSession, geometry);
    binding.geometry = geometry;
    const revision = this.emit(locator, "resized", { geometry }).revision;
    return { locator, geometry, revision };
  }

  async writeAutomated(
    locator: SessionLocator,
    input: AutomatedInput,
  ): Promise<InputReceipt> {
    const prior = this.receipts.get(input.idempotencyKey);
    if (prior !== undefined) return prior;
    const binding = this.binding(locator);
    if (input.recipientGeneration !== locator.generation) {
      throw new Error("Automated input recipient generation is stale");
    }
    if (input.capabilityEpoch !== binding.capabilityEpoch) {
      throw new Error("Automated input capability epoch is stale");
    }
    const actualSha = createHash("sha256").update(input.bytes).digest("hex");
    if (actualSha !== input.sha256) {
      throw new Error("Automated input sha256 does not match bytes");
    }
    let receipt: InputReceipt;
    try {
      if (this.adapter.sendBytes === undefined) {
        throw new Error("tmux engine cannot inject bytes");
      }
      await this.adapter.sendBytes(binding.tmuxSession, input.bytes, {
        interrupt: input.providerStrategy.includes("interrupt"),
        submit: input.submit,
      });
      receipt = {
        transactionId: input.transactionId,
        messageId: input.messageId,
        state: "written",
        byteRange: null,
        providerObservation: "unavailable",
        evidenceAt: this.now().toISOString(),
        diagnosticId: "TMUX_PROVIDER_RECEIPT_UNAVAILABLE",
      };
      this.emit(locator, "input-written", {
        transactionId: input.transactionId,
        messageId: input.messageId,
      });
    } catch {
      receipt = {
        transactionId: input.transactionId,
        messageId: input.messageId,
        state: "in-doubt",
        byteRange: null,
        providerObservation: "unavailable",
        evidenceAt: this.now().toISOString(),
        diagnosticId: "TMUX_INPUT_IN_DOUBT",
      };
    }
    this.receipts.set(input.idempotencyKey, receipt);
    return receipt;
  }

  async terminate(
    locator: SessionLocator,
    _request: TerminationRequest,
  ): Promise<TerminationResult> {
    const binding = this.binding(locator);
    const errors: Array<{ phase: string; code: string; diagnosticId: string }> = [];
    let captured: Awaited<ReturnType<typeof import("../teardown")["captureProcessTree"]>> = [];
    try {
      const roots = [
        ...await (this.adapter.listPanePids?.(binding.tmuxSession) ?? Promise.resolve([])),
        ...await (binding.extraRoots?.() ?? Promise.resolve([])),
      ];
      const teardown = await import("../teardown");
      captured = await teardown.captureProcessTree(
        roots,
        this.reap ?? teardown.defaultReapDependencies(),
      );
    } catch {
      errors.push({
        phase: "capture-process-tree",
        code: "UNKNOWN",
        diagnosticId: "TMUX_PROCESS_CAPTURE_UNKNOWN",
      });
    }
    try {
      await binding.beforeTerminate?.();
    } catch {
      errors.push({
        phase: "before-terminate",
        code: "FAILED",
        diagnosticId: "TMUX_BEFORE_TERMINATE_FAILED",
      });
    }
    try {
      if (this.adapter.killSession === undefined) {
        throw new Error("tmux engine cannot terminate sessions");
      }
      await this.adapter.killSession(binding.tmuxSession, { ignoreMissing: true });
    } catch {
      errors.push({
        phase: "kill-session",
        code: "FAILED",
        diagnosticId: "TMUX_KILL_FAILED",
      });
    }
    let survivors: TerminationResult["survivors"] = [];
    if (captured.length > 0) {
      try {
        const teardown = await import("../teardown");
        const outcome = await teardown.reapCapturedTree(
          captured,
          this.reap ?? teardown.defaultReapDependencies(),
        );
        survivors = outcome.survivors.map((process) => ({
          pid: process.pid,
          startToken: "unknown",
          reason: process.command,
        }));
      } catch {
        errors.push({
          phase: "reap-process-tree",
          code: "UNKNOWN",
          diagnosticId: "TMUX_PROCESS_READBACK_UNKNOWN",
        });
      }
    }
    let absent = false;
    try {
      absent = !await this.adapter.hasSession(binding.tmuxSession);
    } catch {
      errors.push({
        phase: "absence-readback",
        code: "UNKNOWN",
        diagnosticId: "TMUX_ABSENCE_UNKNOWN",
      });
    }
    const state = survivors.length > 0
      ? "survivors"
      : absent && errors.length === 0 ? "terminated" : "unknown";
    this.emit(locator, "terminated", { state });
    return { locator, state, exit: null, survivors, errors };
  }

  async terminateLegacyTmuxSession(tmuxSession: string): Promise<void> {
    if (this.adapter.killSession === undefined) {
      throw new Error("tmux engine cannot terminate sessions");
    }
    await this.adapter.killSession(tmuxSession, { ignoreMissing: true });
  }

  async writeLegacyTmuxSession(
    tmuxSession: string,
    bytes: Uint8Array,
    options: Readonly<{ interrupt?: boolean; submit?: "none" | "return" | "control-enter" }> = {},
  ): Promise<void> {
    if (this.adapter.sendBytes === undefined) {
      throw new Error("tmux engine cannot inject bytes");
    }
    await this.adapter.sendBytes(tmuxSession, bytes, options);
  }

  async inspectLegacyTmuxSession(
    tmuxSession: string,
  ): Promise<Readonly<{
    presence: "present" | "lost" | "unknown";
    panePids: readonly number[];
    clientTtys: readonly string[];
  }>> {
    try {
      if (!await this.adapter.hasSession(tmuxSession)) {
        return { presence: "lost", panePids: [], clientTtys: [] };
      }
      return {
        presence: "present",
        panePids: await (this.adapter.listPanePids?.(tmuxSession) ??
          Promise.resolve([])),
        clientTtys: await (this.adapter.listClientTtys?.(tmuxSession) ??
          Promise.resolve([])),
      };
    } catch {
      return { presence: "unknown", panePids: [], clientTtys: [] };
    }
  }

  async sessionProcessRoots(locator: SessionLocator): Promise<readonly number[]> {
    return await (this.adapter.listPanePids?.(this.binding(locator).tmuxSession) ??
      Promise.resolve([]));
  }

  async *subscribe(afterEventSeq: string): AsyncIterable<SessionEvent> {
    const cursor = parseSequence(afterEventSeq);
    for (const event of this.events) {
      if (BigInt(event.eventSeq) > cursor) yield event;
    }
    while (true) {
      let unsubscribe: (() => void) | undefined;
      const event = await new Promise<SessionEvent>((resolve) => {
        const subscriber = (value: SessionEvent) => resolve(value);
        this.subscribers.add(subscriber);
        unsubscribe = () => this.subscribers.delete(subscriber);
      });
      unsubscribe?.();
      yield event;
    }
  }

  private binding(locator: SessionLocator): Binding {
    const binding = this.bindings.get(locatorKey(locator));
    if (binding === undefined) {
      throw new Error("SessionLocator has no exact tmux compatibility binding");
    }
    return binding;
  }

  private inspection(
    binding: Binding,
    fields: Readonly<{
      presence: SessionInspection["presence"];
      evidenceAt: string;
      viewerCount?: number;
      providerRoot?: SessionInspection["providerRoot"];
      geometry?: TerminalGeometry;
      diagnosticIds: readonly string[];
    }>,
  ): SessionInspection {
    const viewerCount = fields.viewerCount ?? 0;
    return {
      schemaVersion: 1,
      locator: binding.locator,
      presence: fields.presence,
      complete: false,
      hostPid: null,
      hostStartToken: null,
      providerRoot: fields.providerRoot ?? null,
      expectedExecutable: binding.expectedExecutable,
      executableVerified: false,
      outputSeq: "0",
      checkpointSeq: "0",
      checkpointAvailable: false,
      input: { state: "unavailable", ownerViewerId: null, claimId: null },
      viewerCount,
      geometry: fields.geometry ?? binding.geometry,
      resources: {},
      visibility: {
        state: viewerCount > 0 ? "visible" : "attaching",
        workspaceSessionId: "",
        openTerminalRevision: "",
        expiresAt: "1970-01-01T00:00:00.000Z",
      },
      exit: null,
      survivors: [],
      evidenceAt: fields.evidenceAt,
      diagnosticIds: fields.diagnosticIds,
    };
  }

  private emit(
    locator: SessionLocator,
    kind: string,
    data: Readonly<Record<string, unknown>>,
  ): SessionEvent {
    this.eventSeq += 1n;
    const eventSeq = this.eventSeq.toString();
    const event: SessionEvent = {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      eventSeq,
      locator,
      kind,
      revision: eventSeq,
      occurredAt: this.now().toISOString(),
      data,
    };
    this.events.push(event);
    if (this.events.length > EVENT_RETENTION) this.events.shift();
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }
}

export function mintAgentTmuxSessionLocator(
  agentId: string,
  generation = 1,
  hiveHome?: string,
): SessionLocator {
  return mintTmuxSessionLocator(
    hiveHome === undefined ? hiveInstanceSuffix() : sessionInstanceId(hiveHome),
    { kind: "agent", agentId },
    generation,
  );
}

export function mintRootTmuxSessionLocator(
  generation = 1,
  hiveHome?: string,
): SessionLocator {
  return mintTmuxSessionLocator(
    hiveHome === undefined ? hiveInstanceSuffix() : sessionInstanceId(hiveHome),
    { kind: "root" },
    generation,
  );
}

export function requireAgentSessionLocator(
  agent: Pick<AgentRecord, "id" | "sessionLocator" | "tmuxSession">,
): SessionLocator {
  const locator = agent.sessionLocator;
  if (locator === undefined) {
    throw new Error(
      `Agent ${agent.id} has no persisted SessionLocator; migrate the compatibility row before addressing its tmux session`,
    );
  }
  if (
    locator.hostKind !== "tmux" || locator.subject.kind !== "agent" ||
    locator.subject.agentId !== agent.id
  ) {
    throw new Error(`Agent ${agent.id} has a mismatched SessionLocator`);
  }
  if (agent.tmuxSession.length === 0) {
    throw new Error(`Agent ${agent.id} has no tmux compatibility binding`);
  }
  return locator;
}

export function bindAgentSession(
  host: TmuxSessionHost,
  agent: Pick<
    AgentRecord,
    "id" | "sessionLocator" | "tmuxSession" | "capabilityEpoch" | "tool"
  >,
  options: Omit<BindingOptions, "capabilityEpoch" | "expectedExecutable"> = {},
): SessionLocator {
  const locator = requireAgentSessionLocator(agent);
  host.bind(locator, agent.tmuxSession, {
    ...options,
    capabilityEpoch: agent.capabilityEpoch,
    expectedExecutable: agent.tool,
  });
  return locator;
}

export function nextAgentSessionLocator(
  agent: Pick<AgentRecord, "id" | "sessionLocator">,
): SessionLocator {
  const current = agent.sessionLocator;
  if (current === undefined) {
    throw new Error(
      `Agent ${agent.id} must persist its legacy locator before creating a successor generation`,
    );
  }
  if (current.subject.kind !== "agent" || current.subject.agentId !== agent.id) {
    throw new Error(`Agent ${agent.id} has a mismatched SessionLocator`);
  }
  return mintTmuxSessionLocator(
    current.instanceId,
    current.subject,
    current.generation + 1,
  );
}

export function tmuxSessionSpec(
  agent: Pick<
    AgentRecord,
    | "id"
    | "sessionLocator"
    | "tool"
    | "toolSessionId"
    | "worktreePath"
    | "readOnly"
    | "capabilityEpoch"
  >,
  command: string,
  expectedExecutable: string,
  launchGrantId: string,
  geometry: TerminalGeometry = DEFAULT_TMUX_GEOMETRY,
): SessionSpec {
  if (agent.worktreePath === null) {
    throw new Error(`Agent ${agent.id} has no worktree for session creation`);
  }
  return {
    schemaVersion: 1,
    locator: requireAgentSessionLocator({
      ...agent,
      tmuxSession: "bound-by-caller",
    }),
    provider: agent.tool,
    toolSessionId: agent.toolSessionId ?? null,
    cwd: agent.worktreePath,
    argv: ["/bin/sh", "-lc", command],
    environment: {},
    expectedExecutable,
    readOnly: agent.readOnly,
    capabilityEpoch: agent.capabilityEpoch,
    geometry,
    launchGrantId,
    launchGrantRevision: 1,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function commandForSpec(spec: SessionSpec): string {
  const environment = Object.entries(spec.environment).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    return `${name}=${shellQuote(value)}`;
  });
  const command = spec.argv.length === 3 && spec.argv[0] === "/bin/sh" &&
      spec.argv[1] === "-lc"
    ? spec.argv[2]
    : shellJoin(spec.argv);
  return [...environment, command].join(" ");
}

function locatorKey(locator: SessionLocator): string {
  const subject = locator.subject.kind === "root"
    ? "root"
    : `agent:${locator.subject.agentId}`;
  return [
    locator.instanceId,
    subject,
    locator.generation,
    locator.sessionId,
    locator.hostKind,
  ].join("\0");
}

function geometryFromPane(
  prior: TerminalGeometry,
  columns: number,
  rows: number,
): TerminalGeometry {
  return {
    columns,
    rows,
    widthPx: Math.max(1, Math.round(columns * prior.cellWidthPx)),
    heightPx: Math.max(1, Math.round(rows * prior.cellHeightPx)),
    cellWidthPx: prior.cellWidthPx,
    cellHeightPx: prior.cellHeightPx,
  };
}

function validateGeometry(geometry: TerminalGeometry): void {
  if (
    !Number.isSafeInteger(geometry.columns) ||
    !Number.isSafeInteger(geometry.rows) ||
    geometry.columns < 1 || geometry.rows < 1 ||
    geometry.columns > 1_000 || geometry.rows > 1_000 ||
    geometry.columns * geometry.rows > 250_000 ||
    geometry.widthPx <= 0 || geometry.heightPx <= 0 ||
    geometry.cellWidthPx <= 0 || geometry.cellHeightPx <= 0
  ) {
    throw new Error("Invalid terminal geometry");
  }
}

function parseSequence(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Event sequence must be an unsigned decimal string");
  }
  return BigInt(value);
}

async function processIdentity(
  pid: number,
): Promise<SessionInspection["providerRoot"]> {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-o", "pgid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0) return null;
  const match = stdout.trim().match(/^(.*\d{4})\s+([1-9][0-9]*)$/);
  if (match === null) return null;
  return {
    pid,
    startToken: match[1]!,
    processGroupId: Number(match[2]),
  };
}

export const defaultTmuxSocketName = hiveTmuxSocketName;
