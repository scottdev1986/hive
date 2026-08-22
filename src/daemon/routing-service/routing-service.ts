import { randomUUID } from "node:crypto";
import { RouteInspectionSchema } from "../../schemas/routing-inspection";
import {
  RoutingCategorySchema,
  RoutingPolicyMutationSchema,
} from "../../schemas/routing-policy";
import { errorMessage } from "../../shared/error-message";
import type {
  QuotaRefreshReport,
  QuotaService,
} from "../../usage-service/usage-quota";
import type {
  Action,
  Capability,
  Decision,
  Denial,
  RouteAuthorization,
} from "../authorization/authorization-service";
import type { HiveDatabase } from "../database/hive-database";
import {
  RoutingPolicyConflictError,
  RoutingPolicyStore,
} from "../routing-policy-store";
import { machineModelControlDatabase } from "./instance-settings";
import type { ModelControlSnapshot } from "./model-control-snapshot";
import { buildWorkspaceModelControlView } from "./model-control-view";
import { HiveRouter } from "./router";

export interface RoutingServiceDependencies {
  db: HiveDatabase;
  quota: QuotaService | undefined;
  modelControlSnapshot: () => Promise<ModelControlSnapshot>;
  forceQuotaRefresh: (() => Promise<QuotaRefreshReport[]>) | undefined;
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
}

const json = <T>(value: T, init?: ResponseInit): Response =>
  Response.json(value, init);

export class RoutingService {
  private routingPolicy: RoutingPolicyStore | null = null;
  private ownedModelControlDatabase: HiveDatabase | null = null;
  private routingInspector: HiveRouter | null = null;

  constructor(private readonly deps: RoutingServiceDependencies) {}

  /** Model Control is machine-wide state, so the store resolves the machine home rather than this daemon's own database. */
  private modelControlStore(): RoutingPolicyStore {
    if (this.routingPolicy === null) {
      const resolved = machineModelControlDatabase(this.deps.db);
      if (resolved.opened) this.ownedModelControlDatabase = resolved.database;
      this.routingPolicy = new RoutingPolicyStore(resolved.database);
    }
    return this.routingPolicy;
  }

  /** `GET`/`POST /routing/policy` — the Model Control Center's contract, via the `hive routing …` CLI. GET returns the whole policy document; POST applies one validated mutation with compare-and-set and returns the updated document. User-only in both directions: an enabled model here is consent to spend, and an agent granting itself consent would be self-authorization. */
  async routingPolicyEndpoint(request: Request): Promise<Response> {
    const authenticated = this.deps.authenticate(request, "/routing/policy");
    if (!authenticated.ok) return this.deps.denied(authenticated);
    const store = this.modelControlStore();
    if (request.method === "GET") {
      const decision = this.deps.authorize(
        authenticated.capability,
        "/routing/policy",
        "routing-policy:read",
        undefined,
        false,
      );
      if (!decision.ok) return this.deps.denied(decision);
      try {
        return json(store.read());
      } catch (error) {
        // A corrupt policy is a refusal, never an empty (permissive-looking) document — the error names the state so the user can repair it.
        return json({ error: errorMessage(error) }, { status: 500 });
      }
    }
    const decision = this.deps.authorize(
      authenticated.capability,
      "/routing/policy",
      "routing-policy:write",
      undefined,
    );
    if (!decision.ok) return this.deps.denied(decision);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid routing policy request" }, { status: 400 });
    }
    const mutation = RoutingPolicyMutationSchema.safeParse(body);
    if (!mutation.success) {
      return json({ error: mutation.error.message }, { status: 400 });
    }
    const operationId = randomUUID();
    try {
      const policy = store.apply(
        mutation.data,
        authenticated.capability.subject,
      );
      return json(policy, {
        headers: {
          "x-hive-operation-id": operationId,
          "x-hive-post-state-token": String(policy.revision),
        },
      });
    } catch (error) {
      if (error instanceof RoutingPolicyConflictError) {
        return json(
          { error: error.message, currentRevision: error.currentRevision },
          {
            status: 409,
            headers: {
              "x-hive-operation-id": operationId,
              "x-hive-post-state-token": String(error.currentRevision),
            },
          },
        );
      }
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  /** Serves the Workspace read model. The CLI builder supplies measured facts;
   * this daemon-owned boundary joins them to the current routing policy and
   * computes every semantic state the Swift client renders. */
  async modelControlSnapshotEndpoint(request: Request): Promise<Response> {
    const authorized = this.deps.authorizeRoute(
      request,
      "/model-control/snapshot",
      "routing-policy:read",
      { auditAllow: false },
    );
    if (!authorized.ok) return authorized.response;
    try {
      const snapshot = await this.deps.modelControlSnapshot();
      return json(
        buildWorkspaceModelControlView(
          snapshot,
          this.modelControlStore().read(),
        ),
      );
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  /** Forces the same provider refresh used by daemon startup and maintenance. The response keeps each provider's failure reason so the Workspace can refresh successful readings without presenting a failed one as confirmed. */
  async modelControlProbeRefreshEndpoint(request: Request): Promise<Response> {
    const route = "/model-control/probe-refresh";
    const authorized = this.deps.authorizeRoute(request, route, "quota:write");
    if (!authorized.ok) return authorized.response;
    if (this.deps.forceQuotaRefresh === undefined) {
      return json({ error: "Quota tracking is unavailable" }, { status: 503 });
    }
    try {
      return json(await this.deps.forceQuotaRefresh());
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  private routerForInspection(): HiveRouter {
    if (this.routingInspector === null) {
      const store = this.modelControlStore();
      const quota =
        this.deps.quota?.config.enabled === true ? this.deps.quota : undefined;
      this.routingInspector =
        quota === undefined
          ? new HiveRouter({
              db: this.deps.db,
              readPolicy: () => store.read(),
            })
          : new HiveRouter({
              db: this.deps.db,
              readPolicy: () => store.read(),
              launchCooldown: (candidate) => quota.launchCooldown(candidate),
              drainedPool: (candidate) => {
                const drained = quota.drainFor(candidate);
                return drained === null
                  ? null
                  : { pool: drained.pool, resetsAt: drained.resetsAt };
              },
              poolsGoverning: (candidate) =>
                quota.poolsGoverning(candidate).map((status) => status.pool),
            });
    }
    return this.routingInspector;
  }

  /** `GET /routing/inspect?category=<category>` — the Task Router screen's read-only preview: resolved route, per-candidate evaluation, effective weight/share, and current balance, without selecting or mutating anything. Same audience as `/routing/policy`: user-only, since this previews the routing that governs spend. */
  async routingInspectEndpoint(url: URL, request: Request): Promise<Response> {
    const authorized = this.deps.authorizeRoute(
      request,
      "/routing/inspect",
      "routing-policy:read",
      { auditAllow: false },
    );
    if (!authorized.ok) return authorized.response;
    const category = RoutingCategorySchema.safeParse(
      url.searchParams.get("category"),
    );
    if (!category.success) {
      return json(
        {
          error:
            "category must be one of: " +
            RoutingCategorySchema.options.join(", "),
        },
        { status: 400 },
      );
    }
    try {
      const inspection = await this.routerForInspection().inspect({
        category: category.data,
        requirements: { reviewOfProvider: null },
      });
      return json(RouteInspectionSchema.parse(inspection));
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  /** `GET /routing/escalations` — the measured wrong-model claims, read by the `hive routing` audit table. Same audience as `/routing/policy`: user-only, because the escalation record is spend-governance evidence. The daemon answers from the store it owns; a CLI never side-reads it. */
  routingEscalationsEndpoint(request: Request): Response {
    const authorized = this.deps.authorizeRoute(
      request,
      "/routing/escalations",
      "routing-policy:read",
      { auditAllow: false },
    );
    if (!authorized.ok) return authorized.response;
    return json(this.deps.db.listEscalations());
  }

  /** Drops the stores with their connection: a stale store would hand out a closed database rather than resolving a fresh one. */
  close(): void {
    this.ownedModelControlDatabase?.close();
    this.ownedModelControlDatabase = null;
    this.routingPolicy = null;
    this.routingInspector = null;
  }
}
