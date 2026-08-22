import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthorizedLaunch,
  type LaunchGateChecks,
} from "../../src/daemon/routing-service/authorized-launch";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  type CandidateGate,
  HiveRouter,
  type LaunchDecision,
  type RouteRefusal,
  type RouteRequest,
  type RouterDependencies,
  type RouteSelection,
  routeDigest,
} from "../../src/daemon/routing-service/router";
import type { CapabilityProvider } from "../../src/schemas/capability";
import {
  type RouteCandidate,
  type RoutingPolicy,
  routeTargetKey,
} from "../../src/schemas/routing-policy";
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

function countBy(providers: CapabilityProvider[]) {
  const counts: Partial<Record<CapabilityProvider, number>> = {};
  for (const provider of providers) {
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return counts;
}

function balanceRows(
  db: HiveDatabase,
): { candidateKey: string; current: number }[] {
  // SAFETY: The test owns this value and its fields.
  return db.database
    .query(
      "SELECT candidateKey, current FROM routing_balance ORDER BY candidateKey",
    )
    .all() as { candidateKey: string; current: number }[];
}

function rowCount(db: HiveDatabase, table: string): number {
  return (
    // SAFETY: The test owns this value and its fields.
    (
      db.database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n
  );
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

describe("inspect", () => {
  test("never-configured: no candidates, empty balance, refusal names the category", async () => {
    const router = makeRouter(openDb(), policyWith({}));
    const inspection = await router.inspect(
      { category: "default", requirements: { reviewOfProvider: null } },
      permissiveGate,
      NOW,
    );
    expect(inspection.schemaVersion).toBe(1);
    expect(inspection.scope).toBeNull();
    expect(inspection.mode).toBeNull();
    expect(inspection.routeDigest).toBeNull();
    expect(inspection.candidates).toEqual([]);
    expect(inspection.balance).toEqual([]);
    expect(inspection.refusal).toEqual({
      kind: "never-configured",
      detail: expect.stringContaining("category default has no route"),
    });
  });

  test("resolves category, else global — matching resolveRoute exactly", async () => {
    const router = makeRouter(
      openDb(),
      policyWith({
        global: { mode: "user-weighted", candidates: [CLAUDE] },
        categories: {
          code_review: { mode: "user-weighted", candidates: [CODEX] },
        },
      }),
    );
    const own = await router.inspect(
      { category: "code_review", requirements: { reviewOfProvider: null } },
      permissiveGate,
      NOW,
    );
    expect(own.scope).toBe("code_review");
    const viaGlobal = await router.inspect(
      { category: "planning", requirements: { reviewOfProvider: null } },
      permissiveGate,
      NOW,
    );
    expect(viaGlobal.scope).toBe("global");
  });

  test("with nothing excluded, every candidate is eligible and liveShare equals configuredShare", async () => {
    const router = makeRouter(
      openDb(),
      policyWith({
        global: { mode: "user-weighted", candidates: [CLAUDE, CODEX, GROK] },
      }),
    );
    const inspection = await router.inspect(
      { category: "default", requirements: { reviewOfProvider: null } },
      permissiveGate,
      NOW,
    );
    expect(inspection.refusal).toBeNull();
    expect(inspection.routeDigest).toBe(
      routeDigest({ mode: "user-weighted", candidates: [CLAUDE, CODEX, GROK] }),
    );
    expect(inspection.candidates).toHaveLength(3);
    for (const row of inspection.candidates) {
      expect(row.eligible).toBe(true);
      expect(row.liveShare).toBeCloseTo(row.configuredShare, 10);
    }
    const claude = required(
      inspection.candidates.find((row) => row.candidate.provider === "claude"),
    );
    expect(claude.configuredShare).toBeCloseTo(0.6, 10);
    expect(claude.effectiveWeight).toBe(60);
  });

  // Acceptance row 07: "Exclude one shared quota pool; verify every exact
  // model governed by that pool becomes ineligible together" — and here,
  // that the remaining candidates' live share absorbs the excluded share
  // with no weight edited.
  test("a drained pool excludes its candidate and redistributes live share, leaving configured shares and weights untouched", async () => {
    const route = {
      mode: "user-weighted" as const,
      candidates: [CLAUDE, CODEX, GROK],
    };
    const router = makeRouter(openDb(), policyWith({ global: route }), {
      drainedPool: (candidate) =>
        candidate.tool === "grok"
          ? { pool: "grok-managed", resetsAt: "2099-01-01T00:00:00.000Z" }
          : null,
    });
    const inspection = await router.inspect(
      { category: "default", requirements: { reviewOfProvider: null } },
      permissiveGate,
      NOW,
    );
    // Weights are byte-identical to what was configured — nothing edited.
    expect(route.candidates.map((candidate) => candidate.weight)).toEqual([
      60, 25, 15,
    ]);
    expect(inspection.refusal).toBeNull();
    const grok = required(
      inspection.candidates.find((row) => row.candidate.provider === "grok"),
    );
    expect(grok.eligible).toBe(false);
    expect(grok.liveShare).toBe(0);
    // Configured share is unaffected by the exclusion — it is the stored-weight
    // preview, not a live redistribution.
    expect(grok.configuredShare).toBeCloseTo(0.15, 10);
    expect(grok.refusal).toEqual({
      gate: "pool-exclusion",
      detail: "quota pool grok-managed is drained",
      retryAt: "2099-01-01T00:00:00.000Z",
    });
    const claude = required(
      inspection.candidates.find((row) => row.candidate.provider === "claude"),
    );
    const codex = required(
      inspection.candidates.find((row) => row.candidate.provider === "codex"),
    );
    // 60/25/15 configured; with grok excluded the live split is 60/85, 25/85.
    expect(claude.liveShare).toBeCloseTo(60 / 85, 10);
    expect(codex.liveShare).toBeCloseTo(25 / 85, 10);
    // Both grew past their configured share — the exclusion moved weight that
    // no one edited.
    expect(claude.liveShare).toBeGreaterThan(claude.configuredShare);
    expect(codex.liveShare).toBeGreaterThan(codex.configuredShare);
  });

  test("excluding every candidate reports a top-level no-candidate refusal", async () => {
    const router = makeRouter(
      openDb(),
      policyWith({ global: { mode: "user-weighted", candidates: [GROK] } }),
      { drainedPool: () => ({ pool: "p", resetsAt: null }) },
    );
    const inspection = await router.inspect(
      { category: "default", requirements: { reviewOfProvider: null } },
      permissiveGate,
      NOW,
    );
    expect(inspection.refusal).toEqual({
      kind: "no-candidate",
      detail: "every candidate of the global route was refused",
    });
    expect(required(inspection.candidates[0]).liveShare).toBe(0);
  });

  test("reads the existing balance without writing to it", async () => {
    const db = openDb();
    const weighted = policyWith({
      global: { mode: "user-weighted", candidates: [CLAUDE, CODEX, GROK] },
    });
    const router = makeRouter(db, weighted);
    await selectProviders(router, 6, "seed");
    const before = balanceRows(db);
    expect(before.length).toBeGreaterThan(0);
    const inspection = await router.inspect(
      { category: "default", requirements: { reviewOfProvider: null } },
      permissiveGate,
      NOW,
    );
    expect(inspection.balance.length).toBe(before.length);
    for (const entry of inspection.balance) {
      const key = routeTargetKey({
        provider: entry.provider,
        model: entry.model,
      });
      const row = required(
        before.find((candidate) => candidate.candidateKey === key),
      );
      expect(entry.current).toBe(row.current);
    }
    expect(balanceRows(db)).toEqual(before);
  });

  test("5 repeated inspect() calls write zero rows to launch_decisions or routing_balance", async () => {
    const db = openDb();
    const router = makeRouter(
      db,
      policyWith({
        global: { mode: "user-weighted", candidates: [CLAUDE, CODEX, GROK] },
      }),
    );
    const decisionsBefore = rowCount(db, "launch_decisions");
    const balanceBefore = rowCount(db, "routing_balance");
    for (let i = 0; i < 5; i += 1) {
      await router.inspect(
        { category: "default", requirements: { reviewOfProvider: null } },
        permissiveGate,
        NOW,
      );
    }
    expect(rowCount(db, "launch_decisions")).toBe(decisionsBefore);
    expect(rowCount(db, "routing_balance")).toBe(balanceBefore);
  });

  test("without a supplied gate, the default policy gate refuses a disabled model", async () => {
    const policy: RoutingPolicy = {
      ...policyWith({
        global: { mode: "user-weighted", candidates: [CLAUDE] },
      }),
      providers: { claude: "disabled" },
    };
    const router = makeRouter(openDb(), policy);
    const inspection = await router.inspect({
      category: "default",
      requirements: { reviewOfProvider: null },
    });
    const claude = required(inspection.candidates[0]);
    expect(claude.eligible).toBe(false);
    expect(claude.refusal?.gate).toBe("enablement");
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
