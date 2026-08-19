import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "../../schemas/capability";
import type { ProviderRun } from "../../schemas/provider-run";
import { domainUuidV7Schema } from "../../schemas/primitives";
import {
  mintRootSessiondLocator,
  OrchestratorSessiondStateSchema,
  RootSessiondLocatorSchema,
} from "./orchestrator-host-contract";
import { providerTerminalEnvironment } from "../session-host/provider-terminal-environment";
import type {
  SessionInspection,
  SessionSpec,
} from "../session-host/session-host-contract";
import type { HiveTerminalHostAdapter } from "../session-host/hive-terminal-host";
import { shellJoin } from "../../shared/shell-quote";
import {
  type ShellSessionLaunch,
  shellSessionLaunch,
} from "../session-host/shell-session";
import type { TerminalHostBindingStore } from "../session-host/terminal-host-binding";
import type { WorkspaceVisibilityAuthority } from "../session-host/workspace-visibility";

export const OrchestratorSessiondLaunchSchema = z
  .strictObject({
    requestId: domainUuidV7Schema("req"),
    providerRunId: z.string().uuid(),
    provider: CapabilityProviderSchema,
    cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute"),
    argv: z.tuple([z.string().min(1)], z.string()).readonly(),
    environment: z.record(z.string(), z.string()).readonly(),
    expectedExecutable: z.string().min(1),
    model: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),
    targetGeneration: z.number().int().nonnegative().optional(),
  })
  .readonly();

export type OrchestratorSessiondLaunch = z.infer<
  typeof OrchestratorSessiondLaunchSchema
>;

/** A headless root: a real sessiond-backed shell with no vendor CLI launched inside it — the same session model every provider is stopped down to (shell-session.ts's "leave an ordinary login zsh behind"), just started there directly rather than reached by stopping a provider. No provider/argv/expectedExecutable: there is no vendor to name. */
export const HeadlessOrchestratorSessiondLaunchSchema = z
  .strictObject({
    requestId: domainUuidV7Schema("req"),
    providerRunId: z.string().uuid(),
    cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute"),
    environment: z.record(z.string(), z.string()).readonly(),
    targetGeneration: z.number().int().nonnegative().optional(),
  })
  .readonly();

export type HeadlessOrchestratorSessiondLaunch = z.infer<
  typeof HeadlessOrchestratorSessiondLaunchSchema
>;

export const OrchestratorSessiondSnapshotSchema = z
  .strictObject({
    requestId: domainUuidV7Schema("req"),
    locator: RootSessiondLocatorSchema,
    state: OrchestratorSessiondStateSchema,
    exitCode: z.number().int().nullable(),
    diagnostic: z.string().nullable(),
  })
  .readonly();

export type OrchestratorSessiondSnapshot = z.infer<
  typeof OrchestratorSessiondSnapshotSchema
>;

export interface OrchestratorSessiondDependencies {
  terminalHost: Pick<
    HiveTerminalHostAdapter,
    "create" | "inspect" | "reconcileProviderRun" | "terminate" | "waitForExit"
  >;
  providerRuns: Readonly<{
    getActiveProviderRunByTerminal(
      terminal: ProviderRun["terminal"],
    ): ProviderRun | null;
    insertProviderRun(run: ProviderRun): ProviderRun;
  }>;
  bindings: TerminalHostBindingStore;
  visibility: Pick<WorkspaceVisibilityAuthority, "prepareAgentCreation">;
  instanceId: string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  inheritedObservationFailureTimeoutMs?: number;
  environment?: Readonly<Record<string, string | undefined>>;
}

const CREATION_POLICY_RETRY_MS = 100;
const INSPECTION_RETRY_MS = 250;
const INHERITED_OBSERVATION_FAILURE_TIMEOUT_MS = 95_000;

type HostOrigin = "managed" | "inherited";

/** The one shape createSession() needs, whether the caller is a vendor-backed start() or a headless startHeadless(): a headless launch simply supplies provider/model/effort as null and a shell built from an empty command. */
interface SessionCreateParams {
  requestId: string;
  providerRunId: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  targetGeneration?: number;
  provider: CapabilityProvider | null;
  shell: ShellSessionLaunch;
  model: string | null;
  effort: string | null;
}

/** Owns the one root provider generation. Creation is private: no locator is published until the host and its durable binding both exist. */
export class OrchestratorSessiondController {
  private current: OrchestratorSessiondSnapshot | null = null;
  private readonly terminalWaiters = new Set<
    Readonly<{ requestId: string; settle: () => void }>
  >();
  private starting: Readonly<{
    requestId: string;
    promise: Promise<OrchestratorSessiondSnapshot>;
    abort: AbortController;
  }> | null = null;
  private abort: AbortController | null = null;
  private inputReady = false;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly inheritedObservationFailureTimeoutMs: number;

  constructor(private readonly dependencies: OrchestratorSessiondDependencies) {
    this.sleep =
      dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
    this.now = dependencies.now ?? Date.now;
    this.inheritedObservationFailureTimeoutMs =
      dependencies.inheritedObservationFailureTimeoutMs ??
      INHERITED_OBSERVATION_FAILURE_TIMEOUT_MS;
  }

  async start(
    input: OrchestratorSessiondLaunch,
  ): Promise<OrchestratorSessiondSnapshot> {
    return await this.startGeneration(input.requestId, (signal) =>
      this.createSession(
        {
          requestId: input.requestId,
          providerRunId: input.providerRunId,
          cwd: input.cwd,
          environment: input.environment,
          targetGeneration: input.targetGeneration,
          provider: input.provider,
          shell: shellSessionLaunch(shellJoin(input.argv)),
          model: input.model ?? null,
          effort: input.effort ?? null,
        },
        "unmanaged",
        signal,
      ),
    );
  }

  /** Opens a headless root: same one-generation discipline, locator, binding, session creation, and exit-monitor machinery as a vendor start() — createSession() is the one path both go through. The only thing that differs is what "ready" means: a vendor launch waits for a foreign process to take the foreground ("unmanaged"); a headless root has none to wait for, so it waits for the foreground to settle on the shell itself ("shell-idle") — the same state a stopped provider already leaves behind. */
  async startHeadless(
    input: HeadlessOrchestratorSessiondLaunch,
  ): Promise<OrchestratorSessiondSnapshot> {
    return await this.startGeneration(input.requestId, (signal) =>
      this.createSession(
        {
          requestId: input.requestId,
          providerRunId: input.providerRunId,
          cwd: input.cwd,
          environment: input.environment,
          targetGeneration: input.targetGeneration,
          provider: null,
          shell: shellSessionLaunch(""),
          model: null,
          effort: null,
        },
        "shell-idle",
        signal,
      ),
    );
  }

  /** The one-root-generation guard, shared verbatim by every way a root can be opened: at most one launch in flight, at most one running root, regardless of what is behind it. */
  private async startGeneration(
    requestId: string,
    creator: (signal: AbortSignal) => Promise<OrchestratorSessiondSnapshot>,
  ): Promise<OrchestratorSessiondSnapshot> {
    if (this.current?.requestId === requestId) return this.current;
    if (this.starting?.requestId === requestId)
      return await this.starting.promise;
    if (this.starting !== null || this.current?.state === "running") {
      throw new Error("a queen sessiond generation is already active");
    }
    this.inputReady = false;
    const abort = new AbortController();
    const promise = creator(abort.signal);
    this.starting = { requestId, promise, abort };
    return await promise.finally(() => {
      if (this.starting?.promise === promise) this.starting = null;
    });
  }

  snapshot(): OrchestratorSessiondSnapshot | null {
    return this.current;
  }

  /** Waits for the exact request to finish. Timeout and disconnect return its current snapshot; absence returns null so the caller can reconnect through the idempotent start path. */
  async waitForTerminal(
    requestId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<OrchestratorSessiondSnapshot | null> {
    const snapshot = this.snapshotForRequest(requestId);
    if (
      snapshot === null ||
      snapshot.state === "exited" ||
      snapshot.state === "failed" ||
      signal?.aborted === true
    ) {
      return snapshot;
    }
    return await new Promise<OrchestratorSessiondSnapshot | null>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        this.terminalWaiters.delete(waiter);
        if (timeout !== undefined) clearTimeout(timeout);
        signal?.removeEventListener("abort", settle);
        resolve(this.snapshotForRequest(requestId));
      };
      const waiter = { requestId, settle };
      this.terminalWaiters.add(waiter);
      timeout = setTimeout(settle, timeoutMs);
      signal?.addEventListener("abort", settle, { once: true });
    });
  }

  markInputReady(): void {
    if (this.current?.state === "running") this.inputReady = true;
  }

  isInputReady(): boolean {
    return this.current?.state === "running" && this.inputReady;
  }

  /** Ends admission/inspection waits when their daemon owner is stopping. The host itself is terminated separately by the daemon's verified teardown; this only prevents a detached controller task from waiting forever after its authority is gone. */
  cancel(reason: string): void {
    this.starting?.abort.abort(reason);
    const current = this.current;
    if (current === null || current.state !== "running") {
      return;
    }
    this.abort?.abort(reason);
    this.setCurrent({
      ...current,
      state: "failed",
      exitCode: null,
      diagnostic: `queen sessiond controller canceled: ${reason}`,
    });
  }

  /** The one path every root's session comes up through, vendor-backed or headless. readiness is parameterised rather than hardcoded: "the root is ready" no longer means "a vendor process arrived" (create()'s old, transport-coupled definition), it means "the session reached the caller-named foreground state" — unmanaged for a vendor launch, shell-idle for a headless one. Bind, wait loop, ProviderRun insert, error handling, and the exit-monitor reap are the same code for both; only that one predicate and the params it reads (provider/model/effort, which stay null for a headless root) differ. */
  private async createSession(
    params: SessionCreateParams,
    expectedForeground: "unmanaged" | "shell-idle",
    signal: AbortSignal,
  ): Promise<OrchestratorSessiondSnapshot> {
    let locator: OrchestratorSessiondSnapshot["locator"] | null = null;
    let createdInspection: SessionInspection | null = null;
    try {
      let policy = null;
      while (policy === null && !signal.aborted) {
        policy = await this.dependencies.visibility.prepareAgentCreation();
        if (policy === null) await this.wait(CREATION_POLICY_RETRY_MS, signal);
      }
      if (signal.aborted || policy === null) {
        throw new Error("queen sessiond creation canceled");
      }
      locator = mintRootSessiondLocator({
        requestId: params.requestId,
        instanceId: this.dependencies.instanceId,
        engineBuildId: policy.engineBuildId,
        bindings: this.dependencies.bindings.listTerminalHostBindings(
          this.dependencies.instanceId,
        ),
      });
      if (
        params.targetGeneration !== undefined &&
        locator.generation !== params.targetGeneration
      ) {
        throw new Error(
          `queen launch names generation ${params.targetGeneration}; durable bindings require ${locator.generation}`,
        );
      }
      const existing =
        this.dependencies.bindings.getTerminalHostBindingByLocator(locator);
      let hostOrigin: HostOrigin = "inherited";
      if (existing?.createEvidence === undefined) {
        const created = await this.dependencies.terminalHost.create(
          this.sessionSpec(params, locator, policy.geometry),
          { locator, visibility: policy.visibility },
        );
        createdInspection = created.inspection;
        hostOrigin = "managed";
      }
      if (signal.aborted) throw new Error("queen sessiond creation canceled");
      if (
        this.dependencies.providerRuns.getActiveProviderRunByTerminal(
          locator,
        ) === null
      ) {
        let inspection: SessionInspection | null =
          createdInspection?.foreground.state === expectedForeground
            ? createdInspection
            : null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (inspection !== null) break;
          const candidate =
            await this.dependencies.terminalHost.inspect(locator);
          if (candidate.foreground.state === expectedForeground) {
            inspection = candidate;
            break;
          }
          if (candidate.presence !== "present" || signal.aborted) break;
          await this.wait(25, signal);
        }
        if (
          inspection === null ||
          inspection.foreground.state !== expectedForeground
        ) {
          throw new Error(
            `queen sessiond launch never reached its expected foreground (${expectedForeground})`,
          );
        }
        this.dependencies.providerRuns.insertProviderRun({
          runId: params.providerRunId,
          agentId: null,
          terminal: locator,
          provider: params.provider,
          model: params.model,
          effort: params.effort,
          conversationId: null,
          capabilityEpoch: 0,
          launchGrantId: params.requestId,
          startedAt: inspection.evidenceAt,
          endedAt: null,
          adapterChild: null,
          protocolReceipt: null,
          state: "running",
          exitReason: null,
        });
      }
      if (signal.aborted) throw new Error("queen sessiond creation canceled");
      const ready: OrchestratorSessiondSnapshot = {
        requestId: params.requestId,
        locator,
        state: "running",
        exitCode: null,
        diagnostic: null,
      };
      this.setCurrent(ready);
      const monitorAbort = new AbortController();
      this.abort = monitorAbort;
      void this.monitor(
        params.requestId,
        locator,
        hostOrigin,
        monitorAbort.signal,
      ).finally(() => {
        if (this.abort === monitorAbort) this.abort = null;
      });
      return ready;
    } catch (error) {
      // A launch that could not be verified is not a terminal that must die. Do not terminate here: the terminal and provider may be running even when verification fails, and a failed termination leaves a killed host with no audit.
      if (locator !== null) {
        this.dependencies.bindings.releaseUncreatedTerminalHostSession(locator);
      }
      throw error;
    }
  }

  private async monitor(
    requestId: string,
    locator: OrchestratorSessiondSnapshot["locator"],
    hostOrigin: HostOrigin,
    signal: AbortSignal,
  ): Promise<void> {
    let result: Awaited<
      ReturnType<
        OrchestratorSessiondDependencies["terminalHost"]["waitForExit"]
      >
    >;
    try {
      result = await this.dependencies.terminalHost.waitForExit(
        locator,
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      this.failMonitor(
        requestId,
        locator,
        `queen sessiond exit wait failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (signal.aborted || result.kind === "aborted") return;
    if (result.kind === "managed-exit") {
      let inspection: SessionInspection;
      try {
        this.dependencies.terminalHost.reconcileProviderRun(locator);
        inspection = await this.dependencies.terminalHost.inspect(locator);
      } catch {
        if (signal.aborted) return;
        this.finishMonitor(requestId, locator, result.exitCode, null);
        return;
      }
      if (signal.aborted) return;
      this.finishMonitor(
        requestId,
        locator,
        inspection.exit?.code ?? result.exitCode,
        inspection.visibility.state === "expired"
          ? "sessiond visibility expired; supervisor will relaunch if agents remain"
          : null,
      );
      return;
    }
    if (hostOrigin === "managed") {
      this.failMonitor(
        requestId,
        locator,
        "queen sessiond managed host lost its exit handle",
      );
      return;
    }
    await this.monitorInheritedHost(requestId, locator, signal);
  }

  private async monitorInheritedHost(
    requestId: string,
    locator: OrchestratorSessiondSnapshot["locator"],
    signal: AbortSignal,
  ): Promise<void> {
    let unobservableSince: number | null = null;
    while (!signal.aborted) {
      let inspection: SessionInspection | null = null;
      try {
        this.dependencies.terminalHost.reconcileProviderRun(locator);
        inspection = await this.dependencies.terminalHost.inspect(locator);
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      if (inspection?.presence === "present") {
        unobservableSince = null;
      } else if (inspection !== null && inspection.presence !== "unknown") {
        this.finishMonitor(
          requestId,
          locator,
          inspection.exit?.code ?? null,
          inspection.visibility.state === "expired"
            ? "sessiond visibility expired; supervisor will relaunch if agents remain"
            : null,
        );
        return;
      } else {
        unobservableSince ??= this.now();
        if (
          this.now() - unobservableSince >=
          this.inheritedObservationFailureTimeoutMs
        ) {
          this.failMonitor(
            requestId,
            locator,
            "queen sessiond inherited host could no longer be observed",
          );
          return;
        }
      }
      await this.wait(INSPECTION_RETRY_MS, signal);
    }
  }

  private finishMonitor(
    requestId: string,
    locator: OrchestratorSessiondSnapshot["locator"],
    exitCode: number | null,
    diagnostic: string | null,
  ): void {
    this.setCurrent({
      requestId,
      locator,
      state: "exited",
      exitCode: exitCode ?? 1,
      diagnostic,
    });
  }

  private failMonitor(
    requestId: string,
    locator: OrchestratorSessiondSnapshot["locator"],
    diagnostic: string,
  ): void {
    this.setCurrent({
      requestId,
      locator,
      state: "failed",
      exitCode: null,
      diagnostic,
    });
  }

  private snapshotForRequest(
    requestId: string,
  ): OrchestratorSessiondSnapshot | null {
    return this.current?.requestId === requestId ? this.current : null;
  }

  private setCurrent(snapshot: OrchestratorSessiondSnapshot): void {
    this.current = snapshot;
    if (snapshot.state !== "exited" && snapshot.state !== "failed") return;
    for (const waiter of this.terminalWaiters) {
      if (waiter.requestId === snapshot.requestId) waiter.settle();
    }
  }

  private async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        cleanup();
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.sleep(milliseconds).then(
        () => {
          cleanup();
          resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private sessionSpec(
    params: SessionCreateParams,
    locator: OrchestratorSessiondSnapshot["locator"],
    geometry: SessionSpec["geometry"],
  ): SessionSpec {
    return {
      schemaVersion: 1,
      locator,
      provider: params.provider,
      toolSessionId: null,
      cwd: params.cwd,
      argv: params.shell.argv,
      environment: {
        ...providerTerminalEnvironment({
          ...(this.dependencies.environment ?? process.env),
          ...params.environment,
        }),
        ...params.shell.env,
      },
      expectedExecutable: params.shell.expectedExecutable,
      readOnly: false,
      capabilityEpoch: 0,
      geometry,
      launchGrantId: params.requestId,
      launchGrantRevision: 1,
    };
  }
}
