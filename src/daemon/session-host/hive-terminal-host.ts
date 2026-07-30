import { createHash } from "node:crypto";
import type { AgentRecord, ProviderRun } from "../../schemas";
import { macProcessIdentity } from "../lifecycle";
import type {
  AttachGrant,
  AttachRequest,
  CreateResult,
  SessionHost,
  SessionInspection,
  SessionLocator,
  SessionSpec,
  TerminationRequest,
  TerminationResult,
} from "./contract";
import { sameSessionLocator } from "./locators";
import { TERMINAL_SHELL } from "./shell-session";
import {
  type HiveTerminalBinding,
  HiveTerminalBindingSchema,
  type TerminalHostBindingStore,
} from "./terminal-host-binding";
import type {
  ClaimResult,
  InputReceipt,
  SessionInspection as NeutralSessionInspection,
  TerminationResult as NeutralTerminationResult,
  ResizeResult,
  SessionRef,
  TerminalHost,
} from "./terminal-host-contract";

/** Death of the verified zsh root is terminal death. Foreground provider
 * lifecycle is separate and must never strengthen this evidence. */
export function sessiondTerminalIsDead(
  inspection: Pick<SessionInspection, "presence" | "diagnosticIds">,
): boolean {
  return (
    inspection.presence === "exited" ||
    inspection.presence === "lost" ||
    inspection.diagnosticIds.includes("SESSIOND_EXECUTABLE_EVIDENCE_STALE")
  );
}

/** The foreground job ended while its zsh may still be alive. An unmanaged
 * command is alive, but it is not evidence for any agent run. */
export function sessiondForegroundJobIsDead(
  inspection: Pick<
    SessionInspection,
    "presence" | "diagnosticIds" | "foreground"
  >,
): boolean {
  return (
    sessiondTerminalIsDead(inspection) ||
    inspection.foreground.state === "shell-idle"
  );
}

export function sessiondAgentProviderRunIsDead(
  inspection: Pick<
    SessionInspection,
    "presence" | "diagnosticIds" | "foreground"
  >,
  activeRun: ProviderRun | null,
): boolean {
  return sessiondTerminalIsDead(inspection) || activeRun === null;
}

/**
 * Keep locator validation here, above the frozen neutral host. The backend
 * never learns agent IDs, Hive instances, generations, or visibility policy.
 */
export function requireSessiondAgentLocator(
  agent: Pick<AgentRecord, "id" | "sessionLocator">,
): HiveTerminalBinding["locator"] {
  const locator = agent.sessionLocator;
  if (
    locator === undefined ||
    locator.hostKind !== "sessiond" ||
    locator.subject.kind !== "agent" ||
    locator.subject.agentId !== agent.id
  ) {
    throw new Error(
      `Agent ${agent.id} has a mismatched sessiond SessionLocator`,
    );
  }
  return HiveTerminalBindingSchema.unwrap().shape.locator.parse(locator);
}

export function requireSessiondRootLocator(
  locator: SessionLocator | undefined,
): HiveTerminalBinding["locator"] {
  if (
    locator === undefined ||
    locator.hostKind !== "sessiond" ||
    locator.subject.kind !== "root"
  ) {
    throw new Error("Queen has a mismatched sessiond SessionLocator");
  }
  return HiveTerminalBindingSchema.unwrap().shape.locator.parse(locator);
}

type TerminalLifecycleHost = Pick<
  TerminalHost,
  "claimInput" | "submitInput" | "resize" | "inspect" | "list" | "terminate"
> &
  Pick<SessionHost, "create" | "issueAttach">;

export type HiveTerminalPolicy = Pick<
  HiveTerminalBinding,
  "locator" | "visibility"
>;

export interface HiveTerminalHostAdapterOptions {
  now?: () => Date;
  processIdentity?: (pid: number) => { startToken: string };
  processState?: (
    pid: number,
  ) => Promise<"running" | "stopped" | "gone" | "unknown">;
  signalProcessGroup?: (
    processGroupId: number,
    signal: "SIGSTOP" | "SIGCONT" | "SIGTERM" | "SIGKILL",
  ) => void;
  sleep?: (ms: number) => Promise<void>;
  providerRuns: ProviderRunStore;
}

export interface ProviderRunStore {
  getActiveProviderRunByTerminal(terminal: SessionLocator): ProviderRun | null;
  endProviderRun(
    runId: string,
    endedAt: string,
    exitReason: string,
  ): ProviderRun | null;
}

export class TerminalHostBindingNotFoundError extends Error {
  constructor() {
    super(
      "sessiond locator has no terminal-host binding in this Hive instance",
    );
    this.name = "TerminalHostBindingNotFoundError";
  }
}

export class TerminalHostBindingMismatchError extends Error {
  constructor() {
    super("sessiond returned evidence outside its Hive locator binding");
    this.name = "TerminalHostBindingMismatchError";
  }
}

export class TerminalHostBindingIncompleteError extends Error {
  constructor() {
    super("sessiond locator binding has no completed create evidence");
    this.name = "TerminalHostBindingIncompleteError";
  }
}

const TERMINATION_DEADLINE_MS = 10_000;
const VIEWER_COUNT_DIAGNOSTIC = "SESSIOND_VIEWER_COUNT_UNAVAILABLE";
const RESOURCES_DIAGNOSTIC = "SESSIOND_RESOURCES_UNAVAILABLE";
const INPUT_STATE_DIAGNOSTIC = "SESSIOND_INPUT_STATE_UNAVAILABLE";
const CONTROL_READBACK_ATTEMPTS = 40;
const CONTROL_READBACK_INTERVAL_MS = 25;

function sameSession(left: SessionRef, right: SessionRef): boolean {
  return left.key === right.key && left.incarnation === right.incarnation;
}

function presenceForLifecycle(
  lifecycle: NeutralSessionInspection["lifecycle"],
): SessionInspection["presence"] {
  switch (lifecycle) {
    case "creating":
    case "running":
      return "present";
    case "exited":
      return "exited";
    case "lost":
      return "lost";
    case "unknown":
      return "unknown";
  }
}

function terminationIdempotencyKey(
  requestId: string,
  session: SessionRef,
): string {
  return createHash("sha256")
    .update("hive-sessiond-terminate-v1\0")
    .update(requestId)
    .update("\0")
    .update(session.key)
    .update("\0")
    .update(session.incarnation)
    .digest("hex");
}

/** Hive policy adapter over the project-neutral frozen TerminalHost contract. */
export class HiveTerminalHostAdapter {
  constructor(
    private readonly host: TerminalLifecycleHost,
    private readonly bindings: TerminalHostBindingStore,
    private readonly instanceId: string,
    options: HiveTerminalHostAdapterOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.processIdentity = options.processIdentity ?? macProcessIdentity;
    this.processState =
      options.processState ??
      (async (pid) => {
        const child = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const stat = (await new Response(child.stdout).text()).trim();
        await child.exited;
        if (stat === "" || stat.startsWith("Z")) return "gone";
        return stat.startsWith("T") ? "stopped" : "running";
      });
    this.signalProcessGroup =
      options.signalProcessGroup ??
      ((processGroupId, signal) => process.kill(-processGroupId, signal));
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.providerRuns = options.providerRuns;
  }

  private readonly now: () => Date;
  private readonly processIdentity: (pid: number) => { startToken: string };
  private readonly processState: NonNullable<
    HiveTerminalHostAdapterOptions["processState"]
  >;
  private readonly signalProcessGroup: NonNullable<
    HiveTerminalHostAdapterOptions["signalProcessGroup"]
  >;
  private readonly sleep: NonNullable<HiveTerminalHostAdapterOptions["sleep"]>;
  private readonly providerRuns: ProviderRunStore;

  async pauseProvider(
    locator: SessionLocator,
    expected: ProviderRun,
  ): Promise<boolean> {
    if (!(await this.signalVerifiedGroup(locator, expected, "SIGSTOP")))
      return false;
    return this.waitForProviderState(locator, expected, "stopped");
  }

  async resumeProvider(
    locator: SessionLocator,
    expected: ProviderRun,
  ): Promise<boolean> {
    if (!(await this.signalVerifiedGroup(locator, expected, "SIGCONT")))
      return false;
    return this.waitForProviderState(locator, expected, "running");
  }

  async stopProvider(
    locator: SessionLocator,
    expected: ProviderRun,
  ): Promise<boolean> {
    if (!(await this.signalVerifiedGroup(locator, expected, "SIGTERM"))) {
      return this.waitForProviderStopped(locator, expected);
    }
    if (await this.waitForProviderStopped(locator, expected)) return true;
    if (!(await this.signalVerifiedGroup(locator, expected, "SIGKILL"))) {
      return this.waitForProviderStopped(locator, expected);
    }
    return this.waitForProviderStopped(locator, expected);
  }

  private async signalVerifiedGroup(
    locator: SessionLocator,
    expected: ProviderRun,
    signal: "SIGSTOP" | "SIGCONT" | "SIGTERM" | "SIGKILL",
  ): Promise<boolean> {
    if (!(await this.providerForegroundMatches(locator, expected)))
      return false;
    try {
      // Unlike C1 input, this read and signal cannot be one sessiond commit.
      // Re-check the exact leader token immediately before the group signal.
      // ESRCH is honest provider exit; token drift defeats pgid recycling.
      if (this.processIdentity(expected.pid).startToken !== expected.startToken)
        return false;
      this.signalProcessGroup(expected.foregroundProcessGroupId, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async providerForegroundMatches(
    locator: SessionLocator,
    expected: ProviderRun,
  ): Promise<boolean> {
    if (
      expected.state !== "running" ||
      !sameSessionLocator(expected.terminal, locator)
    ) {
      return false;
    }
    const inspection = await this.inspect(locator);
    return (
      inspection.presence === "present" &&
      inspection.shellRoot !== null &&
      inspection.foreground.state === "managed" &&
      inspection.foreground.runId === expected.runId &&
      inspection.foreground.pid === expected.pid &&
      inspection.foreground.startToken === expected.startToken &&
      inspection.foreground.foregroundProcessGroupId ===
        expected.foregroundProcessGroupId
    );
  }

  private async waitForProviderState(
    locator: SessionLocator,
    expected: ProviderRun,
    wanted: "running" | "stopped",
  ): Promise<boolean> {
    for (let attempt = 0; attempt < CONTROL_READBACK_ATTEMPTS; attempt += 1) {
      if (!(await this.providerForegroundMatches(locator, expected)))
        return false;
      if ((await this.processState(expected.pid)) === wanted) return true;
      await this.sleep(CONTROL_READBACK_INTERVAL_MS);
    }
    return false;
  }

  private async providerStopped(
    locator: SessionLocator,
    expected: ProviderRun,
  ): Promise<boolean> {
    const state = await this.processState(expected.pid);
    if (state !== "gone") return false;
    const inspection = await this.inspect(locator);
    if (
      inspection.presence !== "present" ||
      inspection.shellRoot === null ||
      inspection.foreground.state !== "shell-idle"
    ) {
      return false;
    }
    this.providerRuns.endProviderRun(
      expected.runId,
      this.now().toISOString(),
      "provider-stopped",
    );
    return true;
  }

  private async waitForProviderStopped(
    locator: SessionLocator,
    expected: ProviderRun,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < CONTROL_READBACK_ATTEMPTS; attempt += 1) {
      if (await this.providerStopped(locator, expected)) return true;
      await this.sleep(CONTROL_READBACK_INTERVAL_MS);
    }
    return false;
  }

  /** Lifecycle reconciliation is explicit and measured. Inspection stays
   * read-only, while callers that own lifecycle policy may close a run only
   * after its exact pid/start-token identity disappears. */
  reconcileProviderRun(locator: SessionLocator): ProviderRun | null {
    const active = this.providerRuns.getActiveProviderRunByTerminal(locator);
    if (active === null) return null;
    try {
      if (this.processIdentity(active.pid).startToken === active.startToken) {
        return active;
      }
    } catch {
      return active;
    }
    this.providerRuns.endProviderRun(
      active.runId,
      this.now().toISOString(),
      "provider-process-exited",
    );
    return null;
  }

  async create(
    spec: SessionSpec,
    initialInput: Uint8Array,
    policy: HiveTerminalPolicy,
  ): Promise<CreateResult> {
    if (policy.locator.instanceId !== this.instanceId) {
      throw new TerminalHostBindingNotFoundError();
    }
    if (!sameSessionLocator(spec.locator, policy.locator)) {
      throw new TerminalHostBindingMismatchError();
    }
    if (spec.expectedExecutable !== TERMINAL_SHELL) {
      throw new TerminalHostBindingMismatchError();
    }
    this.bindings.bindTerminalHostSession(policy);
    const result = await this.host.create(spec, initialInput);
    if (
      !sameSessionLocator(result.locator, policy.locator) ||
      !sameSessionLocator(result.inspection.locator, policy.locator) ||
      result.inspection.expectedExecutable !== spec.expectedExecutable ||
      result.inspection.visibility.workspaceSessionId !==
        policy.visibility.workspaceSessionId ||
      result.inspection.visibility.openTerminalRevision !==
        policy.visibility.openTerminalRevision
    ) {
      throw new TerminalHostBindingMismatchError();
    }
    this.bindings.completeTerminalHostSession(policy.locator, {
      expectedExecutable: spec.expectedExecutable,
      executableVerified: result.inspection.executableVerified,
      verifiedShellRoot: result.inspection.shellRoot,
      geometry: spec.geometry,
      visibility: result.inspection.visibility,
    });
    return result;
  }

  async list(instanceId: string): Promise<readonly SessionInspection[]> {
    if (instanceId !== this.instanceId) return [];
    const listed = await this.host.list();
    const inspections: SessionInspection[] = [];
    for (const binding of this.bindings.listTerminalHostBindings(instanceId)) {
      const matches = listed.filter(
        (inspection) => inspection.session.key === binding.locator.sessionId,
      );
      if (matches.length === 0) continue;
      if (matches.length !== 1) throw new TerminalHostBindingMismatchError();
      const [matchedInspection] = matches;
      if (matchedInspection === undefined) continue;
      let inspection = matchedInspection;
      if (
        inspection.checkpoints.retained > 0 &&
        inspection.checkpoints.newest === null
      ) {
        const inspected = await this.host.inspect(inspection.session);
        if (!sameSession(inspected.session, inspection.session)) {
          throw new TerminalHostBindingMismatchError();
        }
        inspection = inspected;
      }
      inspections.push(this.projectInspection(binding, inspection));
    }
    return inspections;
  }

  async claimInput(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["claimInput"]>[0], "session">,
  ): Promise<ClaimResult> {
    const { session } = await this.requireTransportBinding(locator);
    return this.host.claimInput({ ...request, session });
  }

  async submitInput(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["submitInput"]>[0], "session">,
  ): Promise<InputReceipt> {
    const { session } = await this.requireTransportBinding(locator);
    return this.host.submitInput({ ...request, session });
  }

  async resize(
    locator: HiveTerminalBinding["locator"],
    request: Omit<Parameters<TerminalHost["resize"]>[0], "session">,
  ): Promise<ResizeResult> {
    const { session } = await this.requireTransportBinding(locator);
    return this.host.resize({ ...request, session });
  }

  /** terminal-stack-transition.html#visibility one-use viewer attach, fenced by
   * the exact completed binding:
   * an unknown or incomplete locator never reaches the broker, and a grant
   * whose locator or engine drifted from the binding is refused here. */
  async issueAttach(
    locator: HiveTerminalBinding["locator"],
    request: AttachRequest,
  ): Promise<AttachGrant> {
    const binding = this.requireBinding(locator);
    if (binding.createEvidence === undefined) {
      throw new TerminalHostBindingIncompleteError();
    }
    const grant = await this.host.issueAttach(locator, request);
    if (
      !sameSessionLocator(grant.locator, locator) ||
      grant.engineBuildId !== locator.engineBuildId
    ) {
      throw new TerminalHostBindingMismatchError();
    }
    return grant;
  }

  async inspect(
    locator: HiveTerminalBinding["locator"],
  ): Promise<SessionInspection> {
    const { binding, session } = await this.requireTransportBinding(locator);
    const inspection = await this.host.inspect(session);
    if (!sameSession(inspection.session, session)) {
      throw new TerminalHostBindingMismatchError();
    }
    return this.projectInspection(binding, inspection);
  }

  async terminate(
    locator: HiveTerminalBinding["locator"],
    request: TerminationRequest,
  ): Promise<TerminationResult> {
    // A host this instance owns but can no longer see is already terminated,
    // and saying so is the only answer that leaves a way out. Requiring a LIVE
    // host to close a session would make both close paths depend on the thing
    // whose absence they are called to clean up. Fail-closed is right for a host that
    // might still be running; absence is not that case. Ownership is still
    // enforced, so another instance's locator is still refused.
    this.requireBinding(locator);
    const session = await this.findLiveSession(locator);
    const requestedAt = this.now();
    if (session === null) {
      this.bindings.recordTerminalHostTermination(locator, {
        reason: request.reason,
        requestId: request.requestId,
        requestedAt: requestedAt.toISOString(),
      });
      const active = this.providerRuns.getActiveProviderRunByTerminal(locator);
      if (active !== null) {
        this.providerRuns.endProviderRun(
          active.runId,
          requestedAt.toISOString(),
          "terminal-absent",
        );
      }
      return {
        locator,
        state: "terminated",
        // Absence is not an observed exit, and reporting one would be a
        // fabrication: nobody watched this host leave.
        exit: null,
        survivors: [],
        errors: [
          {
            phase: "neutral-control",
            code: "UNKNOWN",
            diagnosticId: "SESSIOND_HOST_ALREADY_ABSENT",
          },
        ],
      };
    }
    this.bindings.recordTerminalHostTermination(locator, {
      reason: request.reason,
      requestId: request.requestId,
      requestedAt: requestedAt.toISOString(),
    });
    const result = await this.host.terminate({
      session,
      mode: request.mode,
      target: "process-tree",
      deadline: new Date(
        requestedAt.getTime() + TERMINATION_DEADLINE_MS,
      ).toISOString(),
      idempotencyKey: terminationIdempotencyKey(request.requestId, session),
    });
    const projected = this.projectTermination(locator, result);
    if (projected.state === "terminated") {
      const active = this.providerRuns.getActiveProviderRunByTerminal(locator);
      if (active !== null) {
        this.providerRuns.endProviderRun(
          active.runId,
          this.now().toISOString(),
          result.reap.reaped ? "terminal-reaped" : "terminal-terminated",
        );
      }
    }
    return projected;
  }

  private projectInspection(
    binding: HiveTerminalBinding,
    inspection: NeutralSessionInspection,
  ): SessionInspection {
    const created = binding.createEvidence;
    if (created === undefined) throw new TerminalHostBindingIncompleteError();
    const diagnostics = new Set(inspection.diagnostics);
    diagnostics.add(VIEWER_COUNT_DIAGNOSTIC);
    diagnostics.add(RESOURCES_DIAGNOSTIC);

    const shellRoot =
      inspection.child !== null &&
      inspection.jobControl?.completeness === "complete"
        ? {
            pid: inspection.child.processId,
            startToken: inspection.child.startToken,
            processGroupId: inspection.jobControl.childProcessGroupId,
          }
        : null;
    if (inspection.lifecycle === "running" && shellRoot === null) {
      diagnostics.add("SESSIOND_SHELL_ROOT_UNAVAILABLE");
    }

    const executableVerified =
      inspection.lifecycle === "running" &&
      created.executableVerified &&
      created.verifiedShellRoot !== null &&
      inspection.child?.processId === created.verifiedShellRoot.pid &&
      inspection.child.startToken === created.verifiedShellRoot.startToken;
    if (!executableVerified) {
      diagnostics.add(
        created.executableVerified
          ? "SESSIOND_EXECUTABLE_EVIDENCE_STALE"
          : "SESSIOND_EXECUTABLE_UNVERIFIED",
      );
    }

    const checkpoint = inspection.checkpoints.newest;
    if (inspection.checkpoints.retained > 0 && checkpoint === null) {
      diagnostics.add("SESSIOND_CHECKPOINT_CURSOR_UNAVAILABLE");
    }

    const inputFree =
      inspection.inputOwner === null &&
      inspection.lifecycle === "running" &&
      inspection.completeness === "complete" &&
      inspection.diagnostics.length === 0;
    if (!inputFree) diagnostics.add(INPUT_STATE_DIAGNOSTIC);

    const pixelsDerived =
      inspection.window.value.widthPixels === 0 ||
      inspection.window.value.heightPixels === 0;
    if (pixelsDerived) {
      diagnostics.add("SESSIOND_PIXEL_GEOMETRY_DERIVED_NO_VIEWER");
    }
    const visibility =
      inspection.lifecycle !== "running" &&
      Date.parse(created.visibility.expiresAt) <= this.now().getTime()
        ? { ...created.visibility, state: "expired" as const }
        : created.visibility;
    const foreground = this.projectForeground(binding, inspection, shellRoot);

    return {
      schemaVersion: 1,
      locator: binding.locator,
      presence: presenceForLifecycle(inspection.lifecycle),
      complete:
        inspection.completeness === "complete" && diagnostics.size === 0,
      hostPid: inspection.host?.processId ?? null,
      hostStartToken: inspection.host?.startToken ?? null,
      shellRoot,
      foreground,
      expectedExecutable: created.expectedExecutable,
      executableVerified,
      outputSeq: inspection.output.retained.endExclusive,
      checkpointSeq: checkpoint?.throughEventSequence ?? "0",
      checkpointAvailable: checkpoint !== null,
      input: {
        state: inputFree ? "FREE" : "UNKNOWN",
        ownerViewerId: null,
        claimId: null,
      },
      viewerCount: 0,
      geometry: {
        columns: inspection.window.value.columns,
        rows: inspection.window.value.rows,
        widthPx:
          inspection.window.value.widthPixels ||
          inspection.window.value.columns * created.geometry.cellWidthPx,
        heightPx:
          inspection.window.value.heightPixels ||
          inspection.window.value.rows * created.geometry.cellHeightPx,
        cellWidthPx: created.geometry.cellWidthPx,
        cellHeightPx: created.geometry.cellHeightPx,
      },
      resources: {},
      visibility,
      exit: inspection.exit,
      survivors: inspection.survivors.map(({ process, reason }) => ({
        pid: process.processId,
        startToken: process.startToken,
        reason,
      })),
      evidenceAt: inspection.evidenceAt,
      diagnosticIds: [...diagnostics],
    };
  }

  private projectForeground(
    binding: HiveTerminalBinding,
    inspection: NeutralSessionInspection,
    shellRoot: SessionInspection["shellRoot"],
  ): SessionInspection["foreground"] {
    const active = this.providerRuns.getActiveProviderRunByTerminal(
      binding.locator,
    );
    if (inspection.lifecycle === "exited") {
      return { state: "unknown", runId: null };
    }
    if (
      inspection.lifecycle !== "running" ||
      shellRoot === null ||
      inspection.jobControl?.completeness !== "complete"
    ) {
      return { state: "unknown", runId: null };
    }
    const foregroundProcessGroupId =
      inspection.jobControl.foregroundProcessGroupId;
    if (foregroundProcessGroupId === shellRoot.processGroupId) {
      return { state: "shell-idle", runId: null };
    }
    let startToken: string;
    try {
      startToken = this.processIdentity(foregroundProcessGroupId).startToken;
    } catch {
      return { state: "unknown", runId: null };
    }
    const measured = {
      pid: foregroundProcessGroupId,
      startToken,
      foregroundProcessGroupId,
    };
    // pid and foregroundProcessGroupId coincide by construction here; the
    // start token is the independent identity evidence that defeats PID reuse.
    if (
      active !== null &&
      active.pid === measured.pid &&
      active.startToken === measured.startToken &&
      active.foregroundProcessGroupId === measured.foregroundProcessGroupId
    ) {
      return { state: "managed", runId: active.runId, ...measured };
    }
    return { state: "unmanaged", runId: null, ...measured };
  }

  private projectTermination(
    locator: HiveTerminalBinding["locator"],
    result: NeutralTerminationResult,
  ): TerminationResult {
    const diagnostics = new Set(result.diagnostics);
    const complete =
      result.completeness === "complete" &&
      result.reap.completeness === "complete";
    const terminated =
      result.state === "terminated" &&
      complete &&
      result.survivors.length === 0;
    if (!complete) diagnostics.add("SESSIOND_TERMINATION_INCOMPLETE");
    if (result.state === "terminated" && !result.reap.reaped) {
      diagnostics.add("SESSIOND_TERMINATION_UNREAPED");
    }
    if (result.state === "unknown" && diagnostics.size === 0) {
      diagnostics.add("SESSIOND_TERMINATION_UNKNOWN");
    }
    return {
      locator,
      state: terminated
        ? "terminated"
        : result.state === "survivors" || result.survivors.length > 0
          ? "survivors"
          : "unknown",
      exit: result.exit ?? result.reap.status,
      survivors: result.survivors.map(({ process, reason }) => ({
        pid: process.processId,
        startToken: process.startToken,
        reason,
      })),
      errors: [...diagnostics].map((diagnosticId) => ({
        phase: "neutral-control",
        code: "UNKNOWN",
        diagnosticId,
      })),
    };
  }

  private async requireTransportBinding(
    locator: HiveTerminalBinding["locator"],
  ): Promise<Readonly<{ binding: HiveTerminalBinding; session: SessionRef }>> {
    const binding = this.requireBinding(locator);
    const session = await this.findLiveSession(locator);
    if (session === null) throw new TerminalHostBindingNotFoundError();
    return { binding, session };
  }

  /** The session's ref if a host is still listed for it, else null. */
  private async findLiveSession(
    locator: HiveTerminalBinding["locator"],
  ): Promise<SessionRef | null> {
    const matches = (await this.host.list()).filter(
      (inspection) => inspection.session.key === locator.sessionId,
    );
    if (matches.length > 1) throw new TerminalHostBindingMismatchError();
    return matches[0]?.session ?? null;
  }

  private requireBinding(
    locator: HiveTerminalBinding["locator"],
  ): HiveTerminalBinding {
    if (locator.instanceId !== this.instanceId) {
      throw new TerminalHostBindingNotFoundError();
    }
    const binding = this.bindings.getTerminalHostBindingByLocator(locator);
    if (binding === null) throw new TerminalHostBindingNotFoundError();
    return binding;
  }
}
