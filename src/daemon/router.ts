import { createHash } from "node:crypto";
import {
  type CandidateEffort,
  type CapabilityProvider,
  effectiveWeight,
  resolveRoute,
  type RouteCandidate,
  type RoutePolicy,
  routeTargetKey,
  type RoutingCategory,
  type RoutingPolicy,
} from "../schemas";
import type { AuthorizedLaunch } from "./authorized-launch";
import type { HiveDatabase } from "./db";

/**
 * The router: resolve one configured candidate set, filter it through factual
 * gates, select fairly with smooth weighted round-robin, and record the exact
 * decision. Nothing here scores — no quota headroom, no price, no inferred
 * model strength, no outcome learning. Facts filter; weights distribute; a
 * wrong choice is recovered by the communication handoff, never predicted.
 */

/** One candidate's verdict for one decision. The refusal is the one bounded
 * reason "no candidate" reports for this target. */
export interface CandidateEvaluation {
  candidate: RouteCandidate;
  eligible: boolean;
  effectiveEffort: string | null;
  refusal: {
    gate: string;
    detail: string;
    retryAt: string | null;
  } | null;
}

export interface LaunchDecision {
  decisionId: string;
  requestId: string;
  policyRevision: number;
  /** Null for an explicit pin, which never touches weighted balance. */
  routeDigest: string | null;
  category: RoutingCategory;
  provider: CapabilityProvider;
  model: string;
  effort: string | null;
  reason: "explicit" | "user-weight" | "hive-equal";
  selectedAt: string;
}

export interface RouteRequest {
  /** Idempotent: retrying the same requestId returns the existing decision
   * instead of consuming another fair-selection slot — unless that decision
   * already failed to launch, which frees the id for a fresh selection. */
  requestId: string;
  category: RoutingCategory;
  requirements: {
    reviewOfProvider: CapabilityProvider | null;
  };
  /** Quota pools proven drained for this request (a handoff's exclusion). */
  excludedPoolIds: string[];
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

/**
 * The per-spawn launch gate, built by the spawner where discovery, consent,
 * availability, capability-floor, and effort resolution live. The router owns
 * WHICH candidates are asked and how one is chosen; the gate owns whether a
 * candidate may launch at all.
 */
export type CandidateGate = (candidate: {
  provider: CapabilityProvider;
  model: string;
  effort: CandidateEffort;
}) => Promise<
  | { authorized: AuthorizedLaunch; refusal?: never }
  | { authorized?: never; refusal: { gate: string; detail: string } }
>;

export interface RouterDependencies {
  db: Pick<HiveDatabase, "database">;
  readPolicy: () => RoutingPolicy;
  /** Active launch-failure cooldown for the exact route, from launch health.
   * Absent means no cooldown facts are available and every route is clear. */
  launchCooldown?: (
    candidate: AuthorizedLaunch,
  ) => { until: string; reason: string } | null;
  /** Proven drain for a pool governing this candidate, from quota lifecycle.
   * Unknown or unmetered stays eligible — unknown is not exhaustion. */
  drainedPool?: (
    candidate: AuthorizedLaunch,
  ) => { pool: string; resetsAt: string | null } | null;
  /** The pool names governing a candidate, for handoff exclusions. */
  poolsGoverning?: (candidate: AuthorizedLaunch) => string[];
}

export class HiveRouter {
  constructor(private readonly deps: RouterDependencies) {
    this.deps.db.database.exec(`
      CREATE TABLE IF NOT EXISTS launch_decisions (
        decisionId TEXT PRIMARY KEY,
        requestId TEXT NOT NULL,
        policyRevision INTEGER NOT NULL,
        routeDigest TEXT,
        category TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        reason TEXT NOT NULL,
        selectedAt TEXT NOT NULL,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS launch_decisions_request
        ON launch_decisions (requestId);
      CREATE TABLE IF NOT EXISTS routing_balance (
        routeDigest TEXT NOT NULL,
        candidateKey TEXT NOT NULL,
        current REAL NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (routeDigest, candidateKey)
      );
    `);
  }

  /**
   * One routed selection: resolve the route, evaluate every candidate once,
   * and pick with smooth weighted round-robin inside one transaction. A
   * category route that refuses everything does NOT fall through to global —
   * resolution happened once, and the category was an explicit boundary.
   */
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

    // Selection retries on a policy edit mid-evaluation: a decision is never
    // committed against a replaced document.
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
      const committed = this.deps.db.database
        .transaction(() => {
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
        })
        .immediate();
      if (committed === null) continue;
      return { outcome: "selected", ...committed };
    }
  }

  /**
   * An explicit pin's decision. The pin already passed the full launch gate in
   * the spawner; it bypasses weighted selection and never mutates balance, but
   * the launch is still attributable to a recorded decision.
   */
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

  /** The launch's fate, recorded on the decision that authored it. */
  recordLaunchResult(
    decisionId: string,
    result: "started" | "launch-failed",
  ): void {
    this.deps.db.database.run(
      "UPDATE launch_decisions SET result = ? WHERE decisionId = ?",
      [result, decisionId],
    );
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

  /**
   * Smooth weighted round-robin over the eligible candidates: everyone earns
   * its effective weight, the highest balance wins and pays back the round's
   * total. Deterministic, restart-safe, and bounded — the requested ratio is
   * followed without random streaks. Only currently eligible candidates earn:
   * an excluded candidate accrues no catch-up credit while absent.
   */
  private smoothSelect(
    digest: string,
    route: RoutePolicy,
    eligible: RouteCandidate[],
    now: Date,
  ): RouteCandidate {
    const balances = new Map<string, number>(
      (
        this.deps.db.database
          .query(
            "SELECT candidateKey, current FROM routing_balance WHERE routeDigest = ?",
          )
          .all(digest) as { candidateKey: string; current: number }[]
      ).map((row) => [row.candidateKey, row.current]),
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
      this.deps.db.database.run(
        `INSERT INTO routing_balance (routeDigest, candidateKey, current, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(routeDigest, candidateKey) DO UPDATE SET
           current = excluded.current,
           updatedAt = excluded.updatedAt`,
        [digest, key, balances.get(key) ?? 0, now.toISOString()],
      );
    }
    return selected;
  }

  private decisionForRequest(requestId: string): LaunchDecision | null {
    const row = this.deps.db.database
      .query(
        `SELECT * FROM launch_decisions
         WHERE requestId = ? AND (result IS NULL OR result = 'started')
         ORDER BY selectedAt DESC LIMIT 1`,
      )
      .get(requestId) as
      | (Omit<LaunchDecision, "routeDigest" | "effort"> & {
          routeDigest: string | null;
          effort: string | null;
          result: string | null;
        })
      | null;
    if (row === null) return null;
    const { result: _result, ...decision } = row;
    return decision as LaunchDecision;
  }

  private insertDecision(decision: LaunchDecision): void {
    this.deps.db.database.run(
      `INSERT INTO launch_decisions
        (decisionId, requestId, policyRevision, routeDigest, category,
         provider, model, effort, reason, selectedAt, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        decision.decisionId,
        decision.requestId,
        decision.policyRevision,
        decision.routeDigest,
        decision.category,
        decision.provider,
        decision.model,
        decision.effort,
        decision.reason,
        decision.selectedAt,
      ],
    );
  }
}

/** The decision's exact target as a re-gateable candidate, for idempotent
 * retries: the recorded effort is the instruction now. */
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

/**
 * The balance key: a digest of the resolved route's mode, targets, efforts,
 * and effective weights. A real route change starts a fresh balance; edits
 * elsewhere in the policy do not.
 */
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

/** Normalized expected shares for a route — the UI/CLI preview. */
export function routeShares(
  route: RoutePolicy,
): { candidate: RouteCandidate; effectiveWeight: number; share: number }[] {
  const total = route.candidates.reduce(
    (sum, candidate) => sum + effectiveWeight(route.mode, candidate),
    0,
  );
  return route.candidates.map((candidate) => {
    const weight = effectiveWeight(route.mode, candidate);
    return { candidate, effectiveWeight: weight, share: weight / total };
  });
}
