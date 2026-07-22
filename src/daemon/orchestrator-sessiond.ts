import { isAbsolute } from "node:path";
import { z } from "zod";
import { CapabilityProviderSchema, ORCHESTRATOR_NAME } from "../schemas";
import {
  domainUuidV7Schema,
} from "../schemas/session-protocol";
import type { SessionInspection, SessionSpec } from "./session-host/contract";
import type { HiveTerminalHostAdapter } from "./session-host/hive-terminal-host";
import { DEFAULT_TMUX_GEOMETRY } from "./session-host/tmux-host";
import type { TerminalHostBindingStore } from "./session-host/terminal-host-binding";
import {
  ROOT_VISIBILITY_ID,
  type WorkspaceVisibilityAuthority,
} from "./session-host/workspace-visibility";
import {
  RootSessiondLocatorSchema,
  mintRootSessiondLocator,
} from "./orchestrator-host";

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
  visibility: Pick<WorkspaceVisibilityAuthority, "prepare" | "admit">;
  instanceId: string;
  sleep?: (milliseconds: number) => Promise<void>;
  environment?: Readonly<Record<string, string | undefined>>;
  onRunning?: () => Promise<void>;
}

const VISIBILITY_RETRY_MS = 100;
const INSPECTION_RETRY_MS = 250;

/** Owns the one root provider generation. Pending state is intentionally
 * reconstructible rather than separately persisted: requestId deterministically
 * names the locator, while the completed binding and every queued message are
 * durable. Retrying after a daemon restart therefore resumes the exact create. */
export class OrchestratorSessiondController {
  private current: OrchestratorSessiondSnapshot | null = null;
  private abort: AbortController | null = null;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: OrchestratorSessiondDependencies) {
    this.sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  async start(input: OrchestratorSessiondLaunch): Promise<OrchestratorSessiondSnapshot> {
    if (this.current?.requestId === input.requestId) return this.current;
    if (
      this.current !== null &&
      (this.current.state === "awaiting-visibility" || this.current.state === "running")
    ) {
      throw new Error("a queen sessiond generation is already active");
    }
    const prepared = await this.dependencies.visibility.prepare();
    if (prepared === null) {
      throw new Error("sessiond engine identity is unavailable");
    }
    const locator = mintRootSessiondLocator({
      requestId: input.requestId,
      instanceId: this.dependencies.instanceId,
      engineBuildId: prepared.engineBuildId,
      bindings: this.dependencies.bindings.listTerminalHostBindings(
        this.dependencies.instanceId,
      ),
    });
    this.current = {
      requestId: input.requestId,
      locator,
      state: "awaiting-visibility",
      exitCode: null,
      diagnostic: null,
    };
    const abort = new AbortController();
    this.abort = abort;
    void this.run(input, locator, abort.signal).finally(() => {
      if (this.abort === abort) this.abort = null;
    });
    return this.current;
  }

  snapshot(): OrchestratorSessiondSnapshot | null {
    return this.current;
  }

  /** Ends admission/inspection waits when their daemon owner is stopping.
   * The host itself is terminated separately by the daemon's verified
   * teardown; this only prevents a detached controller task from waiting
   * forever after its authority is gone. */
  cancel(reason: string): void {
    const current = this.current;
    if (current === null ||
        (current.state !== "awaiting-visibility" && current.state !== "running")) {
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

  private async run(
    input: OrchestratorSessiondLaunch,
    locator: OrchestratorSessiondSnapshot["locator"],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let admission = null;
      while (admission === null && !signal.aborted) {
        admission = await this.dependencies.visibility.admit({
          agentId: ROOT_VISIBILITY_ID,
          agentName: ORCHESTRATOR_NAME,
        });
        if (admission === null) await this.wait(VISIBILITY_RETRY_MS, signal);
      }
      if (signal.aborted || admission === null) return;
      if (admission.engineBuildId !== locator.engineBuildId) {
        throw new Error("queen sessiond engine admission changed");
      }
      const existing = this.dependencies.bindings.getTerminalHostBindingByLocator(locator);
      if (existing?.createEvidence === undefined) {
        await this.dependencies.terminalHost.create(
          this.sessionSpec(input, locator),
          new Uint8Array(),
          { locator, visibility: admission.visibility },
        );
      }
      if (signal.aborted) return;
      // The Workspace's first publish can race ahead of create evidence, so
      // the generic renewal sweep correctly skips it. Renew explicitly only
      // after create is durably bound; otherwise the initial 15-second lease
      // can expire before the next publisher tick and kill queen silently.
      await this.dependencies.terminalHost.renewVisibility(
        locator,
        admission.visibility,
      );
      if (signal.aborted) return;
      this.current = {
        requestId: input.requestId,
        locator,
        state: "running",
        exitCode: null,
        diagnostic: null,
      };
      await this.dependencies.onRunning?.();
      if (signal.aborted) return;
      await this.monitor(input.requestId, locator, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.current = {
        requestId: input.requestId,
        locator,
        state: "failed",
        exitCode: null,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
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
  ): SessionSpec {
    return {
      schemaVersion: 1,
      locator,
      provider: input.provider,
      toolSessionId: null,
      cwd: input.cwd,
      argv: input.argv,
      environment: {
        ...Object.fromEntries(
          Object.entries(this.dependencies.environment ?? process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...input.environment,
      },
      expectedExecutable: input.expectedExecutable,
      readOnly: false,
      capabilityEpoch: 0,
      geometry: DEFAULT_TMUX_GEOMETRY,
      launchGrantId: input.requestId,
      launchGrantRevision: 1,
    };
  }
}
