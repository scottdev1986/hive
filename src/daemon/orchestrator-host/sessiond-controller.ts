import { isAbsolute } from "node:path";
import { z } from "zod";
import { CapabilityProviderSchema } from "../../schemas/capability";
import type { ProviderRun } from "../../schemas/provider-run";
import { domainUuidV7Schema } from "../../schemas/session-protocol";
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
    if (this.current?.requestId === input.requestId) return this.current;
    if (this.starting?.requestId === input.requestId)
      return await this.starting.promise;
    if (this.starting !== null || this.current?.state === "running") {
      throw new Error("a queen sessiond generation is already active");
    }
    this.inputReady = false;
    const abort = new AbortController();
    const promise = this.create(input, abort.signal);
    this.starting = { requestId: input.requestId, promise, abort };
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

  private async create(
    input: OrchestratorSessiondLaunch,
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
        requestId: input.requestId,
        instanceId: this.dependencies.instanceId,
        engineBuildId: policy.engineBuildId,
        bindings: this.dependencies.bindings.listTerminalHostBindings(
          this.dependencies.instanceId,
        ),
      });
      if (
        input.targetGeneration !== undefined &&
        locator.generation !== input.targetGeneration
      ) {
        throw new Error(
          `queen launch names generation ${input.targetGeneration}; durable bindings require ${locator.generation}`,
        );
      }
      const existing =
        this.dependencies.bindings.getTerminalHostBindingByLocator(locator);
      let hostOrigin: HostOrigin = "inherited";
      if (existing?.createEvidence === undefined) {
        const shell = shellSessionLaunch(shellJoin(input.argv));
        const created = await this.dependencies.terminalHost.create(
          this.sessionSpec(input, locator, policy.geometry, shell),
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
          createdInspection?.foreground.state === "unmanaged"
            ? createdInspection
            : null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (inspection !== null) break;
          const candidate =
            await this.dependencies.terminalHost.inspect(locator);
          if (candidate.foreground.state === "unmanaged") {
            inspection = candidate;
            break;
          }
          if (candidate.presence !== "present" || signal.aborted) break;
          await this.wait(25, signal);
        }
        if (
          inspection === null ||
          inspection.foreground.state !== "unmanaged"
        ) {
          throw new Error(
            "queen provider launch has no new foreground process identity",
          );
        }
        this.dependencies.providerRuns.insertProviderRun({
          runId: input.providerRunId,
          agentId: null,
          terminal: locator,
          provider: input.provider,
          model: input.model ?? null,
          effort: input.effort ?? null,
          conversationId: null,
          capabilityEpoch: 0,
          launchGrantId: input.requestId,
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
        requestId: input.requestId,
        locator,
        state: "running",
        exitCode: null,
        diagnostic: null,
      };
      this.setCurrent(ready);
      const monitorAbort = new AbortController();
      this.abort = monitorAbort;
      void this.monitor(
        input.requestId,
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
    input: OrchestratorSessiondLaunch,
    locator: OrchestratorSessiondSnapshot["locator"],
    geometry: SessionSpec["geometry"],
    shell: ShellSessionLaunch,
  ): SessionSpec {
    return {
      schemaVersion: 1,
      locator,
      provider: input.provider,
      toolSessionId: null,
      cwd: input.cwd,
      argv: shell.argv,
      environment: providerTerminalEnvironment({
        ...(this.dependencies.environment ?? process.env),
        ...input.environment,
      }),
      expectedExecutable: shell.expectedExecutable,
      readOnly: false,
      capabilityEpoch: 0,
      geometry,
      launchGrantId: input.requestId,
      launchGrantRevision: 1,
    };
  }
}
