import { z } from "zod";
import { hiveInstanceSuffix } from "../../hive-home/home";
import type { MailStore } from "../../mail-service/store";
import { isOrchestratorName, ORCHESTRATOR_NAME } from "../../schemas/agent";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "../../schemas/capability";
import {
  type QueenProviderProjection,
  type QueenProviderReceipt,
  SetLiveQueenProviderRequestSchema,
} from "../../schemas/queen-provider";
import {
  PrepareQueenLaunchRequestSchema,
  PrepareQueenLaunchResponseSchema,
  RecoveryRepliesRequestSchema,
} from "../../schemas/run-checkpoint";
import type {
  OrchestratorStatus,
  WorkspaceSnapshotV2,
} from "../../schemas/status-envelope";
import { errorMessage } from "../../shared/error-message";
import type {
  Action,
  Capability,
  Decision,
  Denial,
  RouteAuthorization,
} from "../authorization/authorization-service";
import type { HiveDatabase } from "../database/hive-database";
import type { ManifestJournal } from "../manifest-journal";
import type { OrchestratorSessiondController } from "../orchestrator-host/sessiond-controller";
import {
  type HiveTerminalHostAdapter,
  requireSessiondRootLocator,
} from "../session-host/hive-terminal-host";
import { mintSessionRequestId } from "../session-host/locators";
import {
  buildQueenProviderProjection,
  QueenProviderConflictError,
  QueenProviderControlStore,
  terminationFailureDetail,
} from "./projection";
import {
  type QueenBootMailbox,
  renderQueenBoardSnapshot,
} from "./queen-boot-capsule-service";
import { composeQueenCompactReload } from "./queen-pin";
import { SuccessionService, SuccessionStateError } from "./succession";

export interface QueenProviderServiceDependencies {
  db: HiveDatabase;
  mail: MailStore;
  queenBootMailbox: () => QueenBootMailbox;
  hierarchySnapshot: () => Promise<WorkspaceSnapshotV2>;
  journal: ManifestJournal;
  orchestratorSessiond: OrchestratorSessiondController | null;
  terminalHost: HiveTerminalHostAdapter;
  vendorAvailability: () => Record<CapabilityProvider, { available: boolean }>;
  rootObservation: (() => CapabilityProvider | null) | null;
  rootProviderStatus: (providerRunId: string) => OrchestratorStatus | null;
  authenticate: (request: Request, route: string) => Decision;
  denied: (decision: Denial) => Response;
  authorize: (
    capability: Capability,
    route: string,
    action: Action,
    subject: string | undefined,
    auditAllow?: boolean,
    allowReason?: string | null,
  ) => Decision;
  authorizeRoute: (
    request: Request,
    route: string,
    action: Action,
    options?: Readonly<{ withSubject?: boolean; auditAllow?: boolean }>,
  ) => RouteAuthorization;
  parseJsonBody: <T>(
    request: Request,
    schema: z.ZodType<T>,
  ) => Promise<
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly response: Response }
  >;
}

const json = <T>(value: T, init?: ResponseInit): Response =>
  Response.json(value, init);

export class QueenProviderService {
  private control: QueenProviderControlStore | null = null;
  private successionService: SuccessionService | null = null;

  constructor(private readonly deps: QueenProviderServiceDependencies) {}

  controlStore(): QueenProviderControlStore {
    if (this.control === null) {
      this.control = new QueenProviderControlStore(this.deps.db);
    }
    return this.control;
  }

  succession(): SuccessionService {
    if (this.successionService === null) {
      this.successionService = new SuccessionService({
        db: this.deps.db,
        mail: this.deps.mail,
        journal: this.deps.journal,
        instanceId: hiveInstanceSuffix(),
      });
    }
    return this.successionService;
  }

  /** What the daemon can prove about the root right now: the observed provider (or null), with the control store reconciled against it. Observation settles the provider change and nothing more — a succession completes only on the successor's own attestation, never on an observation. */
  private observeQueenRoot(): CapabilityProvider | null {
    const observed = this.observedQueenProvider();
    this.controlStore().reconcileObserved(observed);
    return observed;
  }

  /** The provider of the root terminal's RUNNING foreground process, or null. Read from the active provider run on the daemon's own root generation, after a reconcile pass so a dead process cannot linger as a live provider. Never read from a launch request: a queen that was asked for but never came up is null here, which is what makes the change state's `pending` honest. */
  private observedQueenProvider(): CapabilityProvider | null {
    if (this.deps.rootObservation !== null) return this.deps.rootObservation();
    const snapshot = this.deps.orchestratorSessiond?.snapshot() ?? null;
    if (snapshot === null || snapshot.state !== "running") return null;
    try {
      this.deps.terminalHost.reconcileProviderRun(snapshot.locator);
    } catch {}
    const run = this.deps.db.getActiveProviderRunByTerminal(snapshot.locator);
    return run !== null && run.state === "running" ? run.provider : null;
  }

  private queenProviderProjection(
    observed: CapabilityProvider | null,
  ): QueenProviderProjection {
    const control = this.controlStore().read();
    const run = this.deps.db.getActiveRootProviderRun(hiveInstanceSuffix());
    return buildQueenProviderProjection({
      instanceId: hiveInstanceSuffix(),
      signals: this.deps.db.recentOrchestratorSignals(ORCHESTRATOR_NAME),
      providerStatus:
        run === null ? null : this.deps.rootProviderStatus(run.runId),
      observedLiveProvider: observed,
      vendors: this.deps.vendorAvailability(),
      change: {
        state: control.state,
        revision: control.revision,
        failure: control.failure,
      },
      now: new Date(),
    });
  }

  replaceQueenForProviderChange(provider: CapabilityProvider): void {
    const snapshot = this.deps.orchestratorSessiond?.snapshot() ?? null;
    if (snapshot === null || snapshot.state !== "running") return;
    if (
      this.deps.db.getTerminalHostBindingByLocator(snapshot.locator)
        ?.createEvidence === undefined
    ) {
      return;
    }
    void this.deps.terminalHost
      .terminate(requireSessiondRootLocator(snapshot.locator), {
        mode: "immediate",
        reason: `queen provider change to ${provider}`,
        requestId: mintSessionRequestId(),
      })
      .then((terminated) => {
        const detail = terminationFailureDetail(terminated);
        if (detail !== null) {
          this.controlStore().reportLaunchFailure(provider, detail);
        }
      })
      .catch((error) => {
        this.controlStore().reportLaunchFailure(
          provider,
          `could not terminate the running root: ${errorMessage(error)}`,
        );
      });
  }

  /** `GET`/`POST /queen-provider` — the Queen Provider control surface. GET is the projection: the observed live provider, root health, vendor availability, and one opaque change state. POST is `setLiveQueenProvider`, compare-and-set on the projection's revision: an accepted change ends the running root, the supervisor's relaunch loop asks `/queen-succession/ steer` which vendor to bring up, and only the OBSERVATION of that vendor running flips the change back to idle. User-only on the write, exactly like autonomy: the queen must not choose her own successor. */
  async queenProviderEndpoint(request: Request): Promise<Response> {
    const route = "/queen-provider";
    const authenticated = this.deps.authenticate(request, route);
    if (!authenticated.ok) return this.deps.denied(authenticated);
    const store = this.controlStore();
    if (request.method === "GET") {
      // A poll surface (readback after a change): don't audit allows.
      const decision = this.deps.authorize(
        authenticated.capability,
        route,
        "status:read",
        undefined,
        false,
      );
      if (!decision.ok) return this.deps.denied(decision);
      const observed = this.observeQueenRoot();
      return json(this.queenProviderProjection(observed));
    }
    const decision = this.deps.authorize(
      authenticated.capability,
      route,
      "queen-provider:write",
      undefined,
    );
    if (!decision.ok) return this.deps.denied(decision);
    const parsed = await this.deps.parseJsonBody(
      request,
      SetLiveQueenProviderRequestSchema,
    );
    if (!parsed.ok) return parsed.response;
    const observed = this.observeQueenRoot();
    // A change that completed but was never read back must settle before the revision gate decides, or the caller would conflict against itself.
    let receipt: QueenProviderReceipt;
    try {
      receipt = store.accept(
        parsed.data.provider,
        parsed.data.expectedRevision,
        observed,
      );
    } catch (error) {
      if (error instanceof QueenProviderConflictError) {
        return json(
          {
            error: error.message,
            currentRevision: error.currentRevision,
            projection: this.queenProviderProjection(observed),
          },
          { status: 409 },
        );
      }
      throw error;
    }
    if (observed === parsed.data.provider) {
      store.reconcileObserved(observed);
    } else {
      this.replaceQueenForProviderChange(parsed.data.provider);
    }
    return json({
      receipt,
      projection: this.queenProviderProjection(this.observedQueenProvider()),
    });
  }

  /** `GET /queen-succession/steer` — the supervisor's relaunch steer: which vendor the NEXT root launch should run, null when the daemon has no opinion. The observation that settles the provider change happens here, on the supervisor's own poll; it never settles a succession — only the successor's own attestation does that. Deliberately not part of the client projection: the UI never sees a "desired" that observation has not confirmed. */
  queenSuccessionSteerEndpoint(request: Request): Response {
    const route = "/queen-succession/steer";
    const authorized = this.deps.authorizeRoute(request, route, "status:read", {
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    this.observeQueenRoot();
    return json({ tool: this.controlStore().launchTool() });
  }

  async queenSuccessionPrepareLaunchEndpoint(
    request: Request,
  ): Promise<Response> {
    const route = "/queen-succession/prepare-launch";
    const authorized = this.deps.authorizeRoute(
      request,
      route,
      "queen-provider:write",
    );
    if (!authorized.ok) return authorized.response;
    const parsed = await this.deps.parseJsonBody(
      request,
      PrepareQueenLaunchRequestSchema,
    );
    if (!parsed.ok) return parsed.response;
    const agents = this.deps.db
      .listAgents()
      .filter((agent) => !["dead", "done"].includes(agent.status))
      .map((agent) => ({
        agentName: agent.name,
        status: agent.status,
        branch: agent.branch,
        worktreePath: agent.worktreePath,
        lastEventAt: agent.lastEventAt,
      }));
    const prepared = this.succession().prepareLaunch({
      ...parsed.data,
      agents,
      replies: [],
      mailbox: this.deps.queenBootMailbox(),
      board: await this.deps.hierarchySnapshot(),
    });
    return json(PrepareQueenLaunchResponseSchema.parse(prepared));
  }

  /** `POST /queen-succession/replies` — the measured replies to the recovery requests, recorded against the open succession they belong to. The requests go out after the declaration; their replies land here, never folded into a record they do not name. */
  async queenSuccessionRepliesEndpoint(request: Request): Promise<Response> {
    const route = "/queen-succession/replies";
    const authorized = this.deps.authorizeRoute(
      request,
      route,
      "queen-provider:write",
    );
    if (!authorized.ok) return authorized.response;
    const parsed = await this.deps.parseJsonBody(
      request,
      RecoveryRepliesRequestSchema,
    );
    if (!parsed.ok) return parsed.response;
    try {
      return json(this.succession().recordRecoveryReplies(parsed.data));
    } catch (error) {
      if (error instanceof SuccessionStateError) {
        return json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
  }

  /** `GET /queen-succession/projection` — the internal read model: the latest verified checkpoint ref, the latest succession's state, and the contradictions still visible. Daemon-internal like the rest of the succession surface. */
  queenSuccessionProjectionEndpoint(request: Request): Response {
    const route = "/queen-succession/projection";
    const authorized = this.deps.authorizeRoute(request, route, "status:read", {
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    return json(this.succession().projection());
  }

  /** `POST /queen-succession/launch-failure` — the supervisor could not bring up the vendor it was steered to. Failing the pending change steers `steer` back to the prior provider, whose relaunch preserves the prior live Queen. */
  async queenSuccessionLaunchFailureEndpoint(
    request: Request,
  ): Promise<Response> {
    const route = "/queen-succession/launch-failure";
    const authorized = this.deps.authorizeRoute(
      request,
      route,
      "queen-provider:write",
    );
    if (!authorized.ok) return authorized.response;
    const parsed = await this.deps.parseJsonBody(
      request,
      z.strictObject({
        provider: CapabilityProviderSchema,
        detail: z.string().min(1),
      }),
    );
    if (!parsed.ok) return parsed.response;
    this.controlStore().reportLaunchFailure(
      parsed.data.provider,
      parsed.data.detail,
    );
    return json({ recorded: true });
  }

  /** `GET /queen/compact-reload` — pin plus a live board snapshot for the pane
   * to submit after the vendor rewrote the window. Orchestrator only: a worker
   * asking for the queen's mission is not a reader of this surface. */
  async queenCompactReloadEndpoint(request: Request): Promise<Response> {
    const route = "/queen/compact-reload";
    const authorized = this.deps.authorizeRoute(request, route, "status:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    if (!isOrchestratorName(authorized.capability.subject)) {
      return json(
        { error: "compact reload is an orchestrator surface" },
        { status: 403 },
      );
    }
    try {
      const board = await this.deps.hierarchySnapshot();
      return json(
        composeQueenCompactReload({
          boardText: renderQueenBoardSnapshot(board),
        }),
      );
    } catch (error) {
      return json(
        composeQueenCompactReload({
          boardText: null,
          unavailable: errorMessage(error),
        }),
      );
    }
  }
}
