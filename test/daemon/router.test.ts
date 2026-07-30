import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthorizedLaunch,
  type LaunchGateChecks,
} from "../../src/daemon/authorized-launch";
import { HiveDatabase } from "../../src/daemon/db";
import {
  type CandidateGate,
  HiveRouter,
  type LaunchDecision,
  type RouterDependencies,
  type RouteRefusal,
  type RouteRequest,
  type RouteSelection,
} from "../../src/daemon/router";
import type {
  CapabilityProvider,
  RouteCandidate,
  RoutingPolicy,
} from "../../src/schemas";
import { required } from "../required";

const NOW = new Date("2026-07-12T12:00:00.000Z");

const CLAUDE: RouteCandidate = {
  provider: "claude",
  model: "claude-fable-5",
  effort: { mode: "provider-controlled" },
  weight: 60,
};
const CODEX: RouteCandidate = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: { mode: "provider-controlled" },
  weight: 25,
};
const GROK: RouteCandidate = {
  provider: "grok",
  model: "grok-4.5",
  effort: { mode: "provider-controlled" },
  weight: 15,
};

function policyWith(
  overrides: Partial<Pick<RoutingPolicy, "global" | "categories">>,
): RoutingPolicy {
  return {
    schemaVersion: 3,
    revision: 1,
    updatedAt: NOW.toISOString(),
    provisional: false,
    providers: {},
    models: [],
    global: overrides.global ?? null,
    categories: overrides.categories ?? {},
  };
}

const permissiveChecks: LaunchGateChecks = {
  resolution: () => null,
  enablement: () => null,
  availability: () => null,
  capabilityFloor: () => null,
  effort: () => ({ refusal: null }),
};

async function mint(candidate: {
  provider: CapabilityProvider;
  model: string;
}): Promise<{ authorized: AuthorizedLaunch }> {
  const result = await AuthorizedLaunch.gate(
    { tool: candidate.provider, model: candidate.model },
    permissiveChecks,
  );
  if (result.refusal !== undefined) throw new Error(result.refusal.detail);
  return { authorized: result.authorized };
}

const permissiveGate: CandidateGate = (candidate) => mint(candidate);

function gateRefusing(...providers: CapabilityProvider[]): CandidateGate {
  return async (candidate) =>
    providers.includes(candidate.provider)
      ? {
          refusal: {
            gate: "enablement",
            detail: `${candidate.provider} is disabled`,
          },
        }
      : mint(candidate);
}

function request(
  requestId: string,
  overrides: Partial<Omit<RouteRequest, "requestId">> = {},
): RouteRequest {
  return {
    requestId,
    category: "default",
    requirements: { reviewOfProvider: null },
    excludedPoolIds: [],
    ...overrides,
  };
}

const opened: HiveDatabase[] = [];
function openDb(): HiveDatabase {
  const db = new HiveDatabase(":memory:");
  opened.push(db);
  return db;
}
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

function makeRouter(
  db: HiveDatabase,
  policy: RoutingPolicy,
  extra: Partial<RouterDependencies> = {},
): HiveRouter {
  return new HiveRouter({ db, readPolicy: () => policy, ...extra });
}

function selectedDecision(selection: RouteSelection): LaunchDecision {
  if (selection.outcome !== "selected") {
    throw new Error(`expected a selection, got ${JSON.stringify(selection)}`);
  }
  return selection.decision;
}

function refusalOf(selection: RouteSelection): RouteRefusal {
  if (selection.outcome !== "refused") {
    throw new Error("expected a refusal");
  }
  return selection.refusal;
}

async function selectProviders(
  router: HiveRouter,
  count: number,
  prefix: string,
  gate: CandidateGate = permissiveGate,
): Promise<CapabilityProvider[]> {
  const providers: CapabilityProvider[] = [];
  for (let index = 0; index < count; index += 1) {
    const selection = await router.select(
      request(`${prefix}-${index}`),
      gate,
      NOW,
    );
    providers.push(selectedDecision(selection).provider);
  }
  return providers;
}

function countBy(
  providers: CapabilityProvider[],
): Partial<Record<CapabilityProvider, number>> {
  const counts: Partial<Record<CapabilityProvider, number>> = {};
  for (const provider of providers) {
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return counts;
}

function balanceRows(
  db: HiveDatabase,
): { candidateKey: string; current: number }[] {
  return db.database
    .query(
      "SELECT candidateKey, current FROM routing_balance ORDER BY candidateKey",
    )
    .all() as { candidateKey: string; current: number }[];
}

describe("smooth weighted selection", () => {
  const weighted = policyWith({
    global: { mode: "user-weighted", candidates: [CLAUDE, CODEX, GROK] },
  });

  test("60/25/15 over 20 selections yields exactly 12/5/3, interleaved and deterministic", async () => {
    const router = makeRouter(openDb(), weighted);
    const providers = await selectProviders(router, 20, "wrr");
    expect(countBy(providers)).toEqual({ claude: 12, codex: 5, grok: 3 });
    // Smooth, not bursty: the schedule interleaves from the start instead of
    // paying the heaviest candidate its whole share up front.
    expect(new Set(providers.slice(0, 4)).size).toBeGreaterThan(1);
    const rerun = makeRouter(openDb(), weighted);
    expect(await selectProviders(rerun, 20, "wrr")).toEqual(providers);
  });

  test("hive-equal allocates equally while the stored weights stay intact", async () => {
    const route = {
      mode: "hive-equal" as const,
      candidates: [CLAUDE, CODEX, GROK],
    };
    const router = makeRouter(openDb(), policyWith({ global: route }));
    const selection = await router.select(
      request("first"),
      permissiveGate,
      NOW,
    );
    expect(selectedDecision(selection).reason).toBe("hive-equal");
    const providers = await selectProviders(router, 17, "eq");
    providers.push(selectedDecision(selection).provider);
    expect(countBy(providers)).toEqual({ claude: 6, codex: 6, grok: 6 });
    expect(route.candidates.map((candidate) => candidate.weight)).toEqual([
      60, 25, 15,
    ]);
  });

  test("balance persists across router instances: 10 + 10 equals an uninterrupted 20", async () => {
    const db = openDb();
    const first = await selectProviders(makeRouter(db, weighted), 10, "a");
    const second = await selectProviders(makeRouter(db, weighted), 10, "b");
    const uninterrupted = await selectProviders(
      makeRouter(openDb(), weighted),
      20,
      "c",
    );
    expect([...first, ...second]).toEqual(uninterrupted);
  });

  test("a candidate excluded by its gate accrues no catch-up while absent", async () => {
    const equal = policyWith({
      global: {
        mode: "user-weighted",
        candidates: [
          { ...CLAUDE, weight: 1 },
          { ...CODEX, weight: 1 },
        ],
      },
    });
    const router = makeRouter(openDb(), equal);
    const whileRefused = await selectProviders(
      router,
      4,
      "out",
      gateRefusing("codex"),
    );
    expect(whileRefused).toEqual(["claude", "claude", "claude", "claude"]);
    // Restored: codex rejoins the smooth alternation immediately — no burst of
    // repeated codex wins repaying the rounds it sat out.
    expect(await selectProviders(router, 4, "back")).toEqual([
      "claude",
      "codex",
      "claude",
      "codex",
    ]);
  });
});

describe("idempotent request ids", () => {
  test("the same requestId returns the same decision and consumes no extra slot, until the launch fails", async () => {
    const db = openDb();
    const router = makeRouter(
      db,
      policyWith({
        global: { mode: "user-weighted", candidates: [CLAUDE, CODEX, GROK] },
      }),
    );
    const first = selectedDecision(
      await router.select(request("dup"), permissiveGate, NOW),
    );
    const balances = balanceRows(db);
    const again = selectedDecision(
      await router.select(request("dup"), permissiveGate, NOW),
    );
    expect(again.decisionId).toBe(first.decisionId);
    expect(balanceRows(db)).toEqual(balances);
    router.recordLaunchResult(first.decisionId, "launch-failed");
    const fresh = selectedDecision(
      await router.select(request("dup"), permissiveGate, NOW),
    );
    expect(fresh.decisionId).not.toBe(first.decisionId);
  });
});

describe("eligibility gates", () => {
  test("a drained pool refuses the candidate with gate pool-exclusion and its reset time", async () => {
    const router = makeRouter(
      openDb(),
      policyWith({ global: { mode: "user-weighted", candidates: [GROK] } }),
      {
        drainedPool: (candidate) =>
          candidate.tool === "grok"
            ? { pool: "grok-managed", resetsAt: "2099-01-01T00:00:00.000Z" }
            : null,
      },
    );
    const refusal = refusalOf(
      await router.select(request("drained"), permissiveGate, NOW),
    );
    if (refusal.kind !== "no-candidate") throw new Error(refusal.kind);
    expect(required(refusal.evaluations[0]).refusal).toEqual({
      gate: "pool-exclusion",
      detail: "quota pool grok-managed is drained",
      retryAt: "2099-01-01T00:00:00.000Z",
    });
  });

  test("excludedPoolIds refuses candidates governed by that pool, for that request only", async () => {
    const router = makeRouter(
      openDb(),
      policyWith({ global: { mode: "user-weighted", candidates: [CODEX] } }),
      {
        poolsGoverning: (candidate) =>
          candidate.tool === "codex" ? ["shared-pool"] : [],
      },
    );
    const refusal = refusalOf(
      await router.select(
        request("excluded", { excludedPoolIds: ["shared-pool"] }),
        permissiveGate,
        NOW,
      ),
    );
    if (refusal.kind !== "no-candidate") throw new Error(refusal.kind);
    expect(required(refusal.evaluations[0]).refusal).toMatchObject({
      gate: "pool-exclusion",
      detail: expect.stringContaining("shared-pool"),
    });
    const clean = await router.select(request("clean"), permissiveGate, NOW);
    expect(selectedDecision(clean).provider).toBe("codex");
  });

  test("the reviewed provider is refused with gate reviewer-separation", async () => {
    const router = makeRouter(
      openDb(),
      policyWith({ global: { mode: "user-weighted", candidates: [CODEX] } }),
    );
    const refusal = refusalOf(
      await router.select(
        request("review", { requirements: { reviewOfProvider: "codex" } }),
        permissiveGate,
        NOW,
      ),
    );
    if (refusal.kind !== "no-candidate") throw new Error(refusal.kind);
    expect(required(refusal.evaluations[0]).refusal).toMatchObject({
      gate: "reviewer-separation",
    });
  });

  test("an active launch cooldown refuses with gate route-health and retryAt", async () => {
    const until = "2099-01-01T00:00:00.000Z";
    const router = makeRouter(
      openDb(),
      policyWith({ global: { mode: "user-weighted", candidates: [CLAUDE] } }),
      { launchCooldown: () => ({ until, reason: "spawn crashed" }) },
    );
    const refusal = refusalOf(
      await router.select(request("cooling"), permissiveGate, NOW),
    );
    if (refusal.kind !== "no-candidate") throw new Error(refusal.kind);
    expect(required(refusal.evaluations[0]).refusal).toEqual({
      gate: "route-health",
      detail: "recently failed to start (spawn crashed)",
      retryAt: until,
    });
  });
});

describe("route resolution", () => {
  test("a category route that refuses everything never falls through to global", async () => {
    const router = makeRouter(
      openDb(),
      policyWith({
        global: { mode: "user-weighted", candidates: [CLAUDE] },
        categories: {
          code_review: { mode: "user-weighted", candidates: [CODEX] },
        },
      }),
    );
    const gate = gateRefusing("codex");
    const refusal = refusalOf(
      await router.select(
        request("cat", { category: "code_review" }),
        gate,
        NOW,
      ),
    );
    expect(refusal.kind).toBe("no-candidate");
    // A category WITHOUT its own route resolves to global as usual.
    const viaGlobal = await router.select(
      request("uncat", { category: "planning" }),
      gate,
      NOW,
    );
    expect(selectedDecision(viaGlobal).provider).toBe("claude");
  });

  test("no category route and no global route is never-configured", async () => {
    const router = makeRouter(openDb(), policyWith({}));
    const refusal = refusalOf(
      await router.select(request("nothing"), permissiveGate, NOW),
    );
    expect(refusal.kind).toBe("never-configured");
  });
});

describe("explicit decisions", () => {
  test("recordExplicitDecision records reason explicit with no routeDigest and touches no balance", async () => {
    const db = openDb();
    const router = makeRouter(
      db,
      policyWith({
        global: { mode: "user-weighted", candidates: [CLAUDE, CODEX] },
      }),
    );
    await router.select(request("seed"), permissiveGate, NOW);
    const balances = balanceRows(db);
    const minted = await mint({ provider: "grok", model: "grok-4.5" });
    const decision = router.recordExplicitDecision(
      "pin-1",
      "default",
      minted.authorized,
      NOW,
    );
    expect(decision.reason).toBe("explicit");
    expect(decision.routeDigest).toBeNull();
    expect(decision.provider).toBe("grok");
    expect(balanceRows(db)).toEqual(balances);
  });
});
