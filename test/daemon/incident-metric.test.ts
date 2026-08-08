import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  computeMemoryMetric,
  type MemoryMetric,
} from "../../src/daemon/incident-ledger/metric";
import type { IncidentExposure } from "../../src/schemas/incident-exposure";

// The two calibration cases are real, observed on 2026-08-10, and the agent
// counts below are the ones that were recorded for them. Wall-clock figures and
// any cost attached to an incident nobody timed are round fixture numbers chosen
// so the arithmetic in each assertion is checkable by eye; they are not
// measurements and no assertion here depends on their being accurate. What is
// being calibrated is which bucket each case lands in.

const BUN_SPAWN = "bun-env-mutation-never-reaches-spawned-children";
const SKILL_DRIFT = "shipped-skill-bytes-differ-from-checkout";

let nextId = 0;
function exposureId(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
}

function hit(
  signature: string,
  observedAt: string,
  cost: { agentRuns: number; wallMs: number },
  citedArticleIds: readonly string[] = [],
): Extract<IncidentExposure, { outcome: "hit" }> {
  return {
    exposureId: exposureId(),
    signature,
    observedAt,
    citedArticleIds,
    outcome: "hit",
    cost,
  };
}

function avoided(
  signature: string,
  observedAt: string,
  witness: "recurrence-predicate" | "citation-only",
  citedArticleIds: readonly string[] = [],
): IncidentExposure {
  return {
    exposureId: exposureId(),
    signature,
    observedAt,
    citedArticleIds,
    outcome: "avoided",
    witness,
  };
}

function totalReward(metric: MemoryMetric): {
  agentRuns: number;
  wallMs: number;
} {
  return Object.values(metric.articleReward).reduce(
    (sum, reward) => ({
      agentRuns: sum.agentRuns + reward.agentRuns,
      wallMs: sum.wallMs + reward.wallMs,
    }),
    { agentRuns: 0, wallMs: 0 },
  );
}

describe("calibration against the 2026-08-10 cases", () => {
  // Both cases were observed on 2026-08-10, so that day is the window and
  // anything earlier is the history that makes a signature already-known.
  const DAY = "2026-08-10T00:00:00.000Z";

  // The pitfall was covered by an article, esme cited it before acting, and the
  // trap was designed around. The exposure is witnessed by the predicate that
  // reproduces the original incident — a test that mutates process.env and then
  // calls Bun.spawn — so the citation is attribution, not the detection.
  const bunSpawnPriorIncident = hit(BUN_SPAWN, "2026-08-09T10:00:00.000Z", {
    agentRuns: 2,
    wallMs: 3_600_000,
  });
  const bunSpawnAvoided = avoided(
    BUN_SPAWN,
    "2026-08-10T14:00:00.000Z",
    "recurrence-predicate",
    ["repo/testing/bun-env-mutation-never-reaches-spawned-children"],
  );

  // Five bytes of skill drift sent two agents and a queen chasing a shipping
  // leak that did not exist. Nothing covered it, and nothing had covered it
  // before: this is the first of its kind.
  const skillDriftIncident = hit(SKILL_DRIFT, "2026-08-10T20:00:00.000Z", {
    agentRuns: 3,
    wallMs: 7_200_000,
  });

  test("the covered-and-avoided case scores as an avoided repeat", () => {
    const metric = computeMemoryMetric(
      [bunSpawnPriorIncident, bunSpawnAvoided],
      DAY,
    );

    expect(metric.avoidedRepeats).toBe(1);
    expect(metric.repeatIncidents).toBe(0);
    expect(metric.repeatIncidentRate).toBe(0);
    expect(metric.avoidedRepeatCost).toEqual(bunSpawnPriorIncident.cost);
    expect(metric.novelIncidents).toBe(0);
    expect(metric.unverifiedAvoidedRepeats).toBe(0);
    expect(metric.articleReward).toEqual({
      "repo/testing/bun-env-mutation-never-reaches-spawned-children":
        bunSpawnPriorIncident.cost,
    });
  });

  test("the uncovered case scores as an admission opportunity, not a repeat", () => {
    const metric = computeMemoryMetric([skillDriftIncident], DAY);

    expect(metric.novelIncidents).toBe(1);
    expect(metric.repeatIncidents).toBe(0);
    expect(metric.avoidedRepeats).toBe(0);
    // A first-of-kind failure is outside the rate entirely. Counting it in the
    // denominator would make the rate move with how many new kinds of bug get
    // written, which is not a property of memory delivery.
    expect(metric.repeatIncidentRate).toBeNull();
    expect(metric.repeatIncidentCost).toEqual({ agentRuns: 0, wallMs: 0 });
    expect(metric.avoidedRepeatCost).toEqual({ agentRuns: 0, wallMs: 0 });
  });

  test("both cases classify correctly in one ledger", () => {
    const metric = computeMemoryMetric(
      [bunSpawnPriorIncident, bunSpawnAvoided, skillDriftIncident],
      DAY,
    );

    expect(metric.avoidedRepeats).toBe(1);
    expect(metric.novelIncidents).toBe(1);
    expect(metric.repeatIncidents).toBe(0);
    expect(metric.repeatIncidentRate).toBe(0);
    expect(metric.avoidedRepeatCost).toEqual(bunSpawnPriorIncident.cost);
  });
});

describe("adding articles cannot improve the score", () => {
  const ledger: readonly IncidentExposure[] = [
    hit(BUN_SPAWN, "2026-08-09T10:00:00.000Z", {
      agentRuns: 2,
      wallMs: 3_600_000,
    }),
    avoided(BUN_SPAWN, "2026-08-10T14:00:00.000Z", "recurrence-predicate", [
      "article-a",
    ]),
    hit(SKILL_DRIFT, "2026-08-10T20:00:00.000Z", {
      agentRuns: 3,
      wallMs: 7_200_000,
    }),
  ];

  test("citing more articles leaves both co-primary numbers untouched", () => {
    const before = computeMemoryMetric(ledger, null);
    const padded = ledger.map((exposure) => ({
      ...exposure,
      citedArticleIds: [
        ...exposure.citedArticleIds,
        ...Array.from({ length: 50 }, (_, index) => `padding-${index}`),
      ],
    }));
    const after = computeMemoryMetric(padded, null);

    expect(after.repeatIncidentRate).toBe(before.repeatIncidentRate);
    expect(after.avoidedRepeatCost).toEqual(before.avoidedRepeatCost);
    expect(after.avoidedRepeats).toBe(before.avoidedRepeats);
    expect(after.novelIncidents).toBe(before.novelIncidents);
  });

  test("padding a citation list dilutes the articles it names", () => {
    const before = computeMemoryMetric(ledger, null);
    const padded = ledger.map((exposure) =>
      exposure.outcome === "avoided"
        ? {
            ...exposure,
            citedArticleIds: ["article-a", "article-b", "article-c"],
          }
        : exposure,
    );
    const after = computeMemoryMetric(padded, null);

    const claimedBefore = before.articleReward["article-a"];
    const claimedAfter = after.articleReward["article-a"];
    expect(claimedAfter?.agentRuns).toBeLessThan(claimedBefore?.agentRuns ?? 0);
    // Conservation: the pool was fixed before any citation was read, so the
    // extra names split it rather than enlarging it.
    expect(totalReward(after)).toEqual(after.avoidedRepeatCost);
    expect(totalReward(before)).toEqual(before.avoidedRepeatCost);
  });

  test("an agent's own citation is never enough to earn an avoided repeat", () => {
    const claimed = [
      ...ledger,
      avoided(BUN_SPAWN, "2026-08-11T09:00:00.000Z", "citation-only", [
        "article-a",
      ]),
      avoided(BUN_SPAWN, "2026-08-11T10:00:00.000Z", "citation-only", [
        "article-a",
      ]),
    ];
    const before = computeMemoryMetric(ledger, null);
    const after = computeMemoryMetric(claimed, null);

    expect(after.unverifiedAvoidedRepeats).toBe(2);
    expect(after.avoidedRepeats).toBe(before.avoidedRepeats);
    expect(after.repeatIncidentRate).toBe(before.repeatIncidentRate);
    expect(after.avoidedRepeatCost).toEqual(before.avoidedRepeatCost);
    expect(after.articleReward).toEqual(before.articleReward);
  });

  test("avoiding a trap that has never bitten here earns nothing", () => {
    const metric = computeMemoryMetric(
      [
        avoided(
          "never-seen-signature",
          "2026-08-10T14:00:00.000Z",
          "recurrence-predicate",
          ["article-a"],
        ),
      ],
      null,
    );

    expect(metric.avoidedRepeats).toBe(0);
    expect(metric.repeatIncidentRate).toBeNull();
    expect(metric.avoidedRepeatCost).toEqual({ agentRuns: 0, wallMs: 0 });
    expect(metric.articleReward).toEqual({});
  });
});

describe("the pair sees success that a repeat rate alone cannot", () => {
  const priorCost = { agentRuns: 4, wallMs: 14_400_000 };

  test("perfect delivery is distinguishable from a quiet ledger", () => {
    const history = [hit(BUN_SPAWN, "2026-08-01T10:00:00.000Z", priorCost)];
    const perfect = computeMemoryMetric(
      [
        ...history,
        avoided(BUN_SPAWN, "2026-08-10T10:00:00.000Z", "recurrence-predicate"),
        avoided(BUN_SPAWN, "2026-08-11T10:00:00.000Z", "recurrence-predicate"),
      ],
      "2026-08-05T00:00:00.000Z",
    );
    const quiet = computeMemoryMetric(history, "2026-08-05T00:00:00.000Z");

    // Both worlds have zero repeat incidents. The rate alone cannot tell them
    // apart, and on the queen's original formula both read as success.
    expect(perfect.repeatIncidents).toBe(0);
    expect(quiet.repeatIncidents).toBe(0);
    // The co-primary cost separates them: one avoided real damage twice, the
    // other was never tested.
    expect(perfect.avoidedRepeatCost).toEqual({
      agentRuns: 8,
      wallMs: 28_800_000,
    });
    expect(quiet.avoidedRepeatCost).toEqual({ agentRuns: 0, wallMs: 0 });
    expect(perfect.repeatIncidentRate).toBe(0);
    expect(quiet.repeatIncidentRate).toBeNull();
  });

  test("delivery failures are counted where they are, not hidden in the rate", () => {
    const metric = computeMemoryMetric(
      [
        hit(BUN_SPAWN, "2026-08-01T10:00:00.000Z", priorCost),
        hit(
          BUN_SPAWN,
          "2026-08-10T10:00:00.000Z",
          { agentRuns: 1, wallMs: 600_000 },
          ["article-a"],
        ),
        avoided(BUN_SPAWN, "2026-08-11T10:00:00.000Z", "recurrence-predicate"),
      ],
      null,
    );

    expect(metric.repeatIncidents).toBe(1);
    expect(metric.avoidedRepeats).toBe(1);
    expect(metric.repeatIncidentRate).toBe(0.5);
    expect(metric.deliveryFailures).toBe(1);
    expect(metric.repeatIncidentCost).toEqual({
      agentRuns: 1,
      wallMs: 600_000,
    });
  });
});

describe("windowing", () => {
  test("history before the window still makes a signature known", () => {
    const ledger = [
      hit(BUN_SPAWN, "2026-08-01T10:00:00.000Z", {
        agentRuns: 2,
        wallMs: 3_600_000,
      }),
      hit(BUN_SPAWN, "2026-08-10T10:00:00.000Z", {
        agentRuns: 1,
        wallMs: 600_000,
      }),
    ];
    const metric = computeMemoryMetric(ledger, "2026-08-05T00:00:00.000Z");

    expect(metric.repeatIncidents).toBe(1);
    expect(metric.novelIncidents).toBe(0);
    expect(metric.repeatIncidentRate).toBe(1);
    // Only the in-window incident is charged; the one that taught us is not
    // paid for twice.
    expect(metric.repeatIncidentCost).toEqual({
      agentRuns: 1,
      wallMs: 600_000,
    });
  });

  test("exposures are ordered by instant, not by string", () => {
    const later = hit(BUN_SPAWN, "2026-08-10T09:00:00.000Z", {
      agentRuns: 1,
      wallMs: 600_000,
    });
    const earlier = hit(BUN_SPAWN, "2026-08-10T10:00:00.000+02:00", {
      agentRuns: 2,
      wallMs: 3_600_000,
    });
    // earlier is 08:00Z, so it precedes later despite sorting after it as text.
    const metric = computeMemoryMetric([later, earlier], null);

    expect(metric.novelIncidents).toBe(1);
    expect(metric.repeatIncidents).toBe(1);
    expect(metric.repeatIncidentCost).toEqual({
      agentRuns: 1,
      wallMs: 600_000,
    });
  });
});

describe("the ledger", () => {
  test("round-trips both kinds of exposure", () => {
    const db = new HiveDatabase(":memory:");
    const incident = hit(SKILL_DRIFT, "2026-08-10T20:00:00.000Z", {
      agentRuns: 3,
      wallMs: 7_200_000,
    });
    const dodged = avoided(
      BUN_SPAWN,
      "2026-08-10T14:00:00.000Z",
      "recurrence-predicate",
      ["repo/testing/bun-env-mutation-never-reaches-spawned-children"],
    );

    db.recordIncidentExposure(incident);
    db.recordIncidentExposure(dodged);
    const stored = db.listIncidentExposures();

    // Positive control: an empty read here would be indistinguishable from a
    // working reader over an empty world, so assert the writes are visible
    // before trusting any zero this reader ever reports.
    expect(stored.length).toBe(2);
    expect(stored).toEqual([dodged, incident]);
    db.close();
  });

  test("re-recording the same exposure does not double-count it", () => {
    const db = new HiveDatabase(":memory:");
    const incident = hit(SKILL_DRIFT, "2026-08-10T20:00:00.000Z", {
      agentRuns: 3,
      wallMs: 7_200_000,
    });

    db.recordIncidentExposure(incident);
    db.recordIncidentExposure(incident);

    expect(db.listIncidentExposures().length).toBe(1);
    db.close();
  });
});
