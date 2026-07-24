import { isAbsolute } from "node:path";
import { z } from "zod";
import { CapabilityProviderSchema } from "../schemas";
import {
  domainUuidV7Schema,
} from "../schemas/session-protocol";
import type { SessionInspection, SessionSpec } from "./session-host/contract";
import type { HiveTerminalHostAdapter } from "./session-host/hive-terminal-host";
import type { TerminalHostBindingStore } from "./session-host/terminal-host-binding";
import type { WorkspaceVisibilityAuthority } from "./session-host/workspace-visibility";
import {
  RootSessiondLocatorSchema,
  mintRootSessiondLocator,
} from "./orchestrator-host";
import { providerTerminalEnvironment } from "./provider-terminal-environment";
import {
  shellJoin,
  shellSessionLaunch,
  type ShellSessionLaunch,
} from "./session-host/shell-session";

export const OrchestratorSessiondLaunchSchema = z.strictObject({
  requestId: domainUuidV7Schema("req"),
  provider: CapabilityProviderSchema,
  cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute"),
  argv: z.tuple([z.string().min(1)], z.string()).readonly(),
  environment: z.record(z.string(), z.string()).readonly(),
  expectedExecutable: z.string().min(1),
}).readonly();

export type OrchestratorSessiondLaunch = z.infer<
  typeof OrchestratorSessiondLaunchSchema
>;

export const OrchestratorSessiondSnapshotSchema = z.strictObject({
  requestId: domainUuidV7Schema("req"),
  locator: RootSessiondLocatorSchema,
  state: z.enum(["awaiting-visibility", "running", "exited", "failed"]),
  exitCode: z.number().int().nullable(),
  diagnostic: z.string().nullable(),
}).readonly();

export type OrchestratorSessiondSnapshot = z.infer<
  typeof OrchestratorSessiondSnapshotSchema
>;

export interface OrchestratorSessiondDependencies {
  terminalHost: Pick<
    HiveTerminalHostAdapter,
    "create" | "inspect" | "renewVisibility"
  >;
  bindings: TerminalHostBindingStore;
  visibility: Pick<WorkspaceVisibilityAuthority, "prepareAgentCreation">;
  instanceId: string;
  sleep?: (milliseconds: number) => Promise<void>;
  environment?: Readonly<Record<string, string | undefined>>;
}

const CREATION_POLICY_RETRY_MS = 100;
const INSPECTION_RETRY_MS = 250;

/** Owns the one root provider generation. Creation is private: no locator is
 * published until the host and its durable binding both exist. */
export class OrchestratorSessiondController {
  private current: OrchestratorSessiondSnapshot | null = null;
  private starting: Readonly<{
    requestId: string;
    promise: Promise<OrchestratorSessiondSnapshot>;
    abort: AbortController;
  }> | null = null;
  private abort: AbortController | null = null;
  private inputReady = false;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: OrchestratorSessiondDependencies) {
    this.sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  async start(input: OrchestratorSessiondLaunch): Promise<OrchestratorSessiondSnapshot> {
    if (this.current?.requestId === input.requestId) return this.current;
    if (this.starting?.requestId === input.requestId) return await this.starting.promise;
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

  markInputReady(): void {
    if (this.current?.state === "running") this.inputReady = true;
  }

  isInputReady(): boolean {
    return this.current?.state === "running" && this.inputReady;
  }

  /** Ends admission/inspection waits when their daemon owner is stopping.
   * The host itself is terminated separately by the daemon's verified
   * teardown; this only prevents a detached controller task from waiting
   * forever after its authority is gone. */
  cancel(reason: string): void {
    this.starting?.abort.abort(reason);
    const current = this.current;
    if (current === null || current.state !== "running") {
      return;
    }
    this.abort?.abort(reason);
    this.current = {
      ...current,
      state: "failed",
      exitCode: null,
      diagnostic: `queen sessiond controller canceled: ${reason}`,
    };
  }

  private async create(
    input: OrchestratorSessiondLaunch,
    signal: AbortSignal,
  ): Promise<OrchestratorSessiondSnapshot> {
    let locator: OrchestratorSessiondSnapshot["locator"] | null = null;
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
      const existing = this.dependencies.bindings.getTerminalHostBindingByLocator(locator);
      if (existing?.createEvidence === undefined) {
        const shell = shellSessionLaunch(shellJoin(input.argv));
        await this.dependencies.terminalHost.create(
          this.sessionSpec(input, locator, policy.geometry, shell),
          shell.initialInput,
          { locator, visibility: policy.visibility },
        );
      }
      if (signal.aborted) throw new Error("queen sessiond creation canceled");
      await this.dependencies.terminalHost.renewVisibility(
        locator,
        policy.visibility,
      );
      if (signal.aborted) throw new Error("queen sessiond creation canceled");
      const ready: OrchestratorSessiondSnapshot = {
        requestId: input.requestId,
        locator,
        state: "running",
        exitCode: null,
        diagnostic: null,
      };
      this.current = ready;
      const monitorAbort = new AbortController();
      this.abort = monitorAbort;
      void this.monitor(input.requestId, locator, monitorAbort.signal).finally(() => {
        if (this.abort === monitorAbort) this.abort = null;
      });
      return ready;
    } catch (error) {
      if (locator !== null) {
        this.dependencies.bindings.releaseUncreatedTerminalHostSession(locator);
      }
      throw error;
    }
  }

  private async monitor(
    requestId: string,
    locator: OrchestratorSessiondSnapshot["locator"],
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let inspection: SessionInspection;
      try {
        inspection = await this.dependencies.terminalHost.inspect(locator);
      } catch {
        if (signal.aborted) return;
        await this.wait(INSPECTION_RETRY_MS, signal);
        continue;
      }
      if (signal.aborted) return;
      if (inspection.presence === "present" || inspection.presence === "unknown") {
        await this.wait(INSPECTION_RETRY_MS, signal);
        continue;
      }
      this.current = {
        requestId,
        locator,
        state: "exited",
        exitCode: inspection.exit?.code ?? 1,
        diagnostic: inspection.visibility.state === "expired"
          ? "sessiond visibility expired; supervisor will relaunch if agents remain"
          : null,
      };
      return;
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
