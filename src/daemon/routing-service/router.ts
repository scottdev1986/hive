import { createHash } from "node:crypto";
import type { DatabaseHost } from "../../shared/database-host";
import type { CapabilityProvider } from "../../schemas/capability";
import type {
  RouteCandidateInspection,
  RouteCandidateRefusal,
  RouteInspection,
} from "../../schemas/routing-inspection";
import {
  type CandidateEffort,
  effectiveWeight,
  modelPolicyState,
  type RouteCandidate,
  type RoutePolicy,
  type RoutingCategory,
  type RoutingPolicy,
  resolveRoute,
  routeShares,
  routeTargetKey,
} from "../../schemas/routing-policy";
export { routeShares } from "../../schemas/routing-policy";
import { AuthorizedLaunch, type LaunchGateChecks } from "./authorized-launch";
import {
  type LaunchDecision,
  RoutingDecisionStore,
} from "../routing-decision-store";

export type { LaunchDecision } from "../routing-decision-store";

/** The router: resolve one configured candidate set, filter it through factual gates, select fairly with smooth weighted round-robin, and record the exact decision. Nothing here scores — no quota headroom, no price, no inferred model strength, no outcome learning. Facts filter; weights distribute; a wrong choice is recovered by the communication handoff, never predicted. */

/** One candidate's verdict for one decision. The refusal is the one bounded reason "no candidate" reports for this target. */
export interface CandidateEvaluation {
  candidate: RouteCandidate;
  eligible: boolean;
  effectiveEffort: string | null;
  refusal: RouteCandidateRefusal | null;
}

export interface RouteRequest {
  /** Idempotent: retrying the same requestId returns the existing decision instead of consuming another fair-selection slot — unless that decision already failed to launch, which frees the id for a fresh selection. */
  requestId: string;
  category: RoutingCategory;
  requirements: {
    reviewOfProvider: CapabilityProvider | null;
  };
  excludedPoolIds: string[];
}

/** inspect()'s input: which route to look at, and the same reviewer/exclusion facts a real spawn would carry — so a preview matches what select() would actually see. Unlike RouteRequest, there is no requestId or explicit pin: inspect never commits a decision, so idempotency and pinning do not apply. */
export interface RouteInspectionRequest {
  category: RoutingCategory;
  requirements: { reviewOfProvider: CapabilityProvider | null };
  excludedPoolIds?: string[];
}

export type RouteRefusal =
  | { kind: "never-configured"; detail: string }
  | {
      kind: "no-candidate";
      detail: string;
      evaluations: CandidateEvaluation[];
    };

export type RouteSelection =
  | {
      outcome: "selected";
      decision: LaunchDecision;
      authorized: AuthorizedLaunch;
    }
  | { outcome: "refused"; refusal: RouteRefusal };

export type CandidateGate = (candidate: {
  provider: CapabilityProvider;
  model: string;
  effort: CandidateEffort;
}) => Promise<
  | { authorized: AuthorizedLaunch; refusal?: never }
  | { authorized?: never; refusal: { gate: string; detail: string } }
>;

export interface RouterDependencies {
  db: Pick<DatabaseHost, "database">;
  readPolicy: () => RoutingPolicy;
  launchCooldown?: (
    candidate: AuthorizedLaunch,
  ) => { until: string; reason: string } | null;
  drainedPool?: (
    candidate: AuthorizedLaunch,
  ) => { pool: string; resetsAt: string | null } | null;
  poolsGoverning?: (candidate: AuthorizedLaunch) => string[];
}

export class HiveRouter {
  private readonly store: RoutingDecisionStore;

  constructor(private readonly deps: RouterDependencies) {
    this.store = new RoutingDecisionStore(deps.db);
  }

  /** One routed selection: resolve the route, evaluate every candidate once, and pick with smooth weighted round-robin inside one transaction. A category route that refuses everything does NOT fall through to global — resolution happened once, and the category was an explicit boundary. */
  async select(
    request: RouteRequest,
    gate: CandidateGate,
    now: Date = new Date(),
  ): Promise<RouteSelection> {
    const prior = this.decisionForRequest(request.requestId);
    if (prior !== null) {
      const minted = await gate(pinnedCandidate(prior));
      return minted.refusal !== undefined
        ? {
            outcome: "refused",
            refusal: {
              kind: "no-candidate",
              detail:
                `the recorded decision for request ${request.requestId} ` +
                `(${prior.provider}/${prior.model}) no longer passes the launch gate: ` +
                minted.refusal.detail,
              evaluations: [],
            },
          }
        : {
            outcome: "selected",
            decision: prior,
            authorized: minted.authorized,
          };
    }

    // Selection retries on a policy edit mid-evaluation: a decision is never committed against a replaced document.
    for (;;) {
      const policy = this.deps.readPolicy();
      const resolved = resolveRoute(policy, request.category);
      if (resolved === null) {
        return {
          outcome: "refused",
          refusal: {
            kind: "never-configured",
            detail:
              `category ${request.category} has no route and no global route ` +
              "is configured. Configure one in the Model Control Center.",
          },
        };
      }
      const { route } = resolved;
      const evaluations: CandidateEvaluation[] = [];
      const eligible: {
        candidate: RouteCandidate;
        authorized: AuthorizedLaunch;
      }[] = [];
      for (const candidate of route.candidates) {
        const evaluation = await this.evaluate(candidate, request, gate, now);
        evaluations.push(evaluation.evaluation);
        if (evaluation.authorized !== undefined) {
          eligible.push({ candidate, authorized: evaluation.authorized });
        }
      }
      if (eligible.length === 0) {
        return {
          outcome: "refused",
          refusal: {
            kind: "no-candidate",
            detail: `every candidate of the ${resolved.scope} route was refused`,
            evaluations,
          },
        };
      }
      const digest = routeDigest(route);
      const committed = this.store.immediate(() => {
        if (this.deps.readPolicy().revision !== policy.revision) return null;
        const selected = this.smoothSelect(
          digest,
          route,
          eligible.map((entry) => entry.candidate),
          now,
        );
        const winner = eligible.find((entry) => entry.candidate === selected);
        if (winner === undefined) {
          throw new Error(
            "router selected a candidate outside the eligible set",
          );
        }
        const decision: LaunchDecision = {
          decisionId: crypto.randomUUID(),
          requestId: request.requestId,
          policyRevision: policy.revision,
          routeDigest: digest,
          category: request.category,
          provider: selected.provider,
          model: selected.model,
          effort: winner.authorized.effort ?? null,
          reason: route.mode === "hive-equal" ? "hive-equal" : "user-weight",
          selectedAt: now.toISOString(),
        };
        this.insertDecision(decision);
        return { decision, authorized: winner.authorized };
      });
      if (committed === null) continue;
      return { outcome: "selected", ...committed };
    }
  }

  async inspect(
    request: RouteInspectionRequest,
    gate?: CandidateGate,
    now: Date = new Date(),
  ): Promise<RouteInspection> {
    const policy = this.deps.readPolicy();
    const resolved = resolveRoute(policy, request.category);
    const base = {
      schemaVersion: 1 as const,
      category: request.category,
      policyRevision: policy.revision,
      inspectedAt: now.toISOString(),
    };
    if (resolved === null) {
      return {
        ...base,
        scope: null,
        mode: null,
        routeDigest: null,
        candidates: [],
        refusal: {
          kind: "never-configured",
          detail:
            `category ${request.category} has no route and no global route ` +
            "is configured. Configure one in the Model Control Center.",
        },
        balance: [],
      };
    }
    const { scope, route } = resolved;
    const effectiveGate = gate ?? policyGate(policy);
    const evaluations: CandidateEvaluation[] = [];
    for (const candidate of route.candidates) {
      const { evaluation } = await this.evaluate(
        candidate,
        {
          requestId: "inspect",
          category: request.category,
          requirements: request.requirements,
          excludedPoolIds: request.excludedPoolIds ?? [],
        },
        effectiveGate,
        now,
      );
      evaluations.push(evaluation);
    }
    const configuredShares = new Map(
      routeShares(route).map((entry) => [
        routeTargetKey(entry.candidate),
        entry.share,
      ]),
    );
    const eligibleTotal = evaluations
      .filter((entry) => entry.eligible)
      .reduce(
        (sum, entry) => sum + effectiveWeight(route.mode, entry.candidate),
        0,
      );
    const candidates: RouteCandidateInspection[] = evaluations.map((entry) => {
      const weight = effectiveWeight(route.mode, entry.candidate);
      return {
        candidate: entry.candidate,
        effectiveWeight: weight,
        configuredShare:
          configuredShares.get(routeTargetKey(entry.candidate)) ?? 0,
        liveShare:
          entry.eligible && eligibleTotal > 0 ? weight / eligibleTotal : 0,
        eligible: entry.eligible,
        effectiveEffort: entry.effectiveEffort,
        refusal: entry.refusal,
      };
    });
    const digest = routeDigest(route);
    return {
      ...base,
      scope,
      mode: route.mode,
      routeDigest: digest,
      candidates,
      refusal:
        eligibleTotal > 0
          ? null
          : {
              kind: "no-candidate",
              detail: `every candidate of the ${scope} route was refused`,
            },
      balance: this.balanceRows(digest).map((row) => {
        const [provider, model] = row.candidateKey.split("\0");
        return {
          provider: provider as CapabilityProvider,
          model: model ?? "",
          current: row.current,
        };
      }),
    };
  }

  /** An explicit pin's decision. The pin already passed the full launch gate in the spawner; it bypasses weighted selection and never mutates balance, but the launch is still attributable to a recorded decision. */
  recordExplicitDecision(
    requestId: string,
    category: RoutingCategory,
    authorized: AuthorizedLaunch,
    now: Date = new Date(),
  ): LaunchDecision {
    const prior = this.decisionForRequest(requestId);
    if (prior !== null) return prior;
    const decision: LaunchDecision = {
      decisionId: crypto.randomUUID(),
      requestId,
      policyRevision: this.deps.readPolicy().revision,
      routeDigest: null,
      category,
      provider: authorized.tool,
      model: authorized.model,
      effort: authorized.effort ?? null,
      reason: "explicit",
      selectedAt: now.toISOString(),
    };
    this.insertDecision(decision);
    return decision;
  }

  recordLaunchResult(
    decisionId: string,
    result: "started" | "launch-failed",
  ): void {
    this.store.recordLaunchResult(decisionId, result);
  }

  private async evaluate(
    candidate: RouteCandidate,
    request: RouteRequest,
    gate: CandidateGate,
    now: Date,
  ): Promise<{
    evaluation: CandidateEvaluation;
    authorized?: AuthorizedLaunch;
  }> {
    const refused = (
      gateName: string,
      detail: string,
      retryAt: string | null = null,
    ): { evaluation: CandidateEvaluation } => ({
      evaluation: {
        candidate,
        eligible: false,
        effectiveEffort: null,
        refusal: { gate: gateName, detail, retryAt },
      },
    });
    if (
      request.requirements.reviewOfProvider !== null &&
      candidate.provider === request.requirements.reviewOfProvider
    ) {
      return refused(
        "reviewer-separation",
        `${candidate.provider} authored the work under review`,
      );
    }
    const gated = await gate(candidate);
    if (gated.refusal !== undefined) {
      return refused(gated.refusal.gate, gated.refusal.detail);
    }
    const authorized = gated.authorized;
    const cooldown = this.deps.launchCooldown?.(authorized) ?? null;
    if (cooldown !== null && new Date(cooldown.until) > now) {
      return refused(
        "route-health",
        `recently failed to start (${cooldown.reason})`,
        cooldown.until,
      );
    }
    const drained = this.deps.drainedPool?.(authorized) ?? null;
    if (drained !== null) {
      return refused(
        "pool-exclusion",
        `quota pool ${drained.pool} is drained`,
        drained.resetsAt,
      );
    }
    if (request.excludedPoolIds.length > 0) {
      const governing = this.deps.poolsGoverning?.(authorized) ?? [];
      const excluded = governing.find((pool) =>
        request.excludedPoolIds.includes(pool),
      );
      if (excluded !== undefined) {
        return refused(
          "pool-exclusion",
          `quota pool ${excluded} was proven drained for this request`,
        );
      }
    }
    return {
      evaluation: {
        candidate,
        eligible: true,
        effectiveEffort: authorized.effort ?? null,
        refusal: null,
      },
      authorized,
    };
  }

  /** Smooth weighted round-robin over the eligible candidates: everyone earns its effective weight, the highest balance wins and pays back the round's total. Deterministic, restart-safe, and bounded — the requested ratio is followed without random streaks. Only currently eligible candidates earn: an excluded candidate accrues no catch-up credit while absent. */
  private smoothSelect(
    digest: string,
    route: RoutePolicy,
    eligible: RouteCandidate[],
    now: Date,
  ): RouteCandidate {
    const balances = new Map<string, number>(
      this.balanceRows(digest).map((row) => [row.candidateKey, row.current]),
    );
    let total = 0;
    for (const candidate of eligible) {
      const weight = effectiveWeight(route.mode, candidate);
      total += weight;
      const key = routeTargetKey(candidate);
      balances.set(key, (balances.get(key) ?? 0) + weight);
    }
    const selected = [...eligible].sort((left, right) => {
      const gap =
        (balances.get(routeTargetKey(right)) ?? 0) -
        (balances.get(routeTargetKey(left)) ?? 0);
      return gap !== 0
        ? gap
        : routeTargetKey(left).localeCompare(routeTargetKey(right));
    })[0];
    if (selected === undefined) {
      throw new Error("smooth selection requires an eligible candidate");
    }
    const selectedKey = routeTargetKey(selected);
    balances.set(selectedKey, (balances.get(selectedKey) ?? 0) - total);
    for (const candidate of eligible) {
      const key = routeTargetKey(candidate);
      this.store.writeBalance(
        digest,
        key,
        balances.get(key) ?? 0,
        now.toISOString(),
      );
    }
    return selected;
  }

  private balanceRows(
    digest: string,
  ): { candidateKey: string; current: number }[] {
    return this.store.balanceRows(digest);
  }

  private decisionForRequest(requestId: string): LaunchDecision | null {
    return this.store.decisionForRequest(requestId);
  }

  private insertDecision(decision: LaunchDecision): void {
    this.store.insertDecision(decision);
  }
}

/** The decision's exact target as a re-gateable candidate, for idempotent retries: the recorded effort is the instruction now. */
function pinnedCandidate(decision: LaunchDecision): {
  provider: CapabilityProvider;
  model: string;
  effort: CandidateEffort;
} {
  return {
    provider: decision.provider,
    model: decision.model,
    effort:
      decision.effort === null
        ? { mode: "none" }
        : { mode: "exact", value: decision.effort },
  };
}

/** inspect()'s default gate: the policy's own consent decides eligibility — no live discovery, no availability probe. Resolution and availability always pass; enablement reads modelPolicyState the same way the store's own spawner-facing adapter does. Minting through AuthorizedLaunch.gate (rather than bypassing its private constructor) means the resulting candidate is a real AuthorizedLaunch, so it can still reach a caller-supplied launchCooldown/drainedPool/poolsGoverning dependency unchanged. */
function policyGate(policy: RoutingPolicy): CandidateGate {
  const checks: LaunchGateChecks = {
    resolution: () => null,
    enablement: (candidate) => {
      const { state } = modelPolicyState(
        policy,
        candidate.tool,
        candidate.model,
      );
      return state === "enabled"
        ? null
        : `${candidate.tool}/${candidate.model} is not enabled in the Model Control Center`;
    },
    availability: () => null,
    effort: (candidate) => ({ effort: candidate.effort, refusal: null }),
  };
  return async (candidate) => {
    const raw = {
      tool: candidate.provider,
      model: candidate.model,
      ...(candidate.effort.mode === "exact"
        ? { effort: candidate.effort.value }
        : {}),
    };
    const result = await AuthorizedLaunch.gate(raw, checks);
    return result.refusal !== undefined
      ? {
          refusal: {
            gate: result.refusal.reason,
            detail: result.refusal.detail,
          },
        }
      : { authorized: result.authorized };
  };
}

/** The balance key: a digest of the resolved route's mode, targets, efforts, and effective weights. A real route change starts a fresh balance; edits elsewhere in the policy do not. */
export function routeDigest(route: RoutePolicy): string {
  const canonical = [...route.candidates]
    .sort((left, right) =>
      routeTargetKey(left).localeCompare(routeTargetKey(right)),
    )
    .map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      effort: candidate.effort,
      weight: effectiveWeight(route.mode, candidate),
    }));
  return createHash("sha256")
    .update(JSON.stringify({ mode: route.mode, candidates: canonical }))
    .digest("hex");
}
