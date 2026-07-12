import { describe, expect, test } from "bun:test";
import {
  MIN_JUDGED_SPAWNS,
  ShadowObservationSchema,
  summarizeShadow,
  type ShadowObservation,
} from "./routing-shadow";

const base: ShadowObservation = ShadowObservationSchema.parse({
  at: "2026-07-11T12:00:00.000Z",
  agent: "maya",
  tier: "deep",
  kind: "coding",
  actual: { tool: "claude", model: "claude-fable-5", effort: null },
  derived: { tool: "claude", model: "claude-fable-5", effort: null },
  layers: { tool: "derived", model: "derived", effort: "unknown" },
  reason: "manifest initial ∩ claude discovery",
  agrees: { tool: true, model: true, effort: true },
  ladderFallback: false,
  floorViolation: false,
  userPinned: false,
  manifestRevision: "initial",
  outcome: "launched",
  failureReason: null,
});

const observation = (overrides: Partial<ShadowObservation>): ShadowObservation => ({
  ...base,
  ...overrides,
});

const many = (count: number, overrides: Partial<ShadowObservation> = {}) =>
  Array.from({ length: count }, () => observation(overrides));

const criterion = (
  summary: ReturnType<typeof summarizeShadow>,
  id: string,
) => summary.criteria.find((entry) => entry.id === id)!;

const rollback = (
  summary: ReturnType<typeof summarizeShadow>,
  id: string,
) => summary.rollback.find((entry) => entry.id === id)!;

describe("the comparison", () => {
  test("agreement and divergence are counted per field, with the reason", () => {
    const summary = summarizeShadow([
      ...many(2),
      observation({
        derived: { tool: "claude", model: "claude-opus-4-8", effort: null },
        agrees: { tool: true, model: false, effort: true },
        reason: "manifest 2026-07-11.curated ∩ claude discovery",
      }),
    ]);
    expect(summary.judged).toBe(3);
    expect(summary.agreement.model).toBe(2);
    expect(summary.divergences).toEqual([{
      tier: "deep",
      field: "model",
      actual: "claude-fable-5",
      derived: "claude-opus-4-8",
      layer: "derived",
      reason: "manifest 2026-07-11.curated ∩ claude discovery",
      count: 1,
    }]);
  });

  test("a user-pinned spawn is recorded but judged against no criterion", () => {
    // The router did not choose it, so a divergence from it is not the router's
    // to answer for. Counting it would let a user's pin fail the flip.
    const summary = summarizeShadow([
      observation({
        userPinned: true,
        derived: { tool: "claude", model: "claude-opus-4-8", effort: null },
        agrees: { tool: true, model: false, effort: true },
        floorViolation: true,
      }),
    ]);
    expect(summary.spawns).toBe(1);
    expect(summary.judged).toBe(0);
    expect(summary.divergences).toEqual([]);
    expect(criterion(summary, "floor").verdict).toBe("unknown");
  });
});

describe("the flip criteria are checkable, and an unknown is never a pass", () => {
  test("the flip is not ready on a thin window, however clean it looks", () => {
    const summary = summarizeShadow(many(3));
    expect(criterion(summary, "volume").verdict).toBe("fail");
    expect(criterion(summary, "volume").detail).toContain("3 judged");
    expect(summary.flipReady).toBe(false);
  });

  test("a kind-floor violation by the derived choice fails the flip", () => {
    const summary = summarizeShadow([
      ...many(MIN_JUDGED_SPAWNS),
      observation({ floorViolation: true, ladderFallback: true }),
    ]);
    expect(criterion(summary, "floor").verdict).toBe("fail");
    expect(summary.flipReady).toBe(false);
  });

  test("a ladder-fallback rate over the threshold fails the flip", () => {
    const summary = summarizeShadow([
      ...many(MIN_JUDGED_SPAWNS),
      ...many(20, { ladderFallback: true }),
    ]);
    expect(criterion(summary, "ladder-rate").verdict).toBe("fail");
    expect(criterion(summary, "ladder-rate").detail).toContain("28.6%");
  });

  test("a divergent derived route is UNOBSERVABLE, not assumed good", () => {
    // Its route never ran, so nothing measured whether it would have launched.
    // Passing this criterion on silence would be the flip clearing itself by not
    // looking.
    const summary = summarizeShadow([
      ...many(MIN_JUDGED_SPAWNS),
      observation({ agrees: { tool: true, model: false, effort: true } }),
    ]);
    const contradicted = criterion(summary, "contradicted");
    expect(contradicted.verdict).toBe("unknown");
    expect(contradicted.detail).toContain("UNOBSERVABLE");
    expect(summary.flipReady).toBe(false);
  });

  test("an agreeing route that failed to launch IS a contradiction", () => {
    const summary = summarizeShadow([
      ...many(MIN_JUDGED_SPAWNS),
      observation({ outcome: "failed", failureReason: "model not entitled" }),
    ]);
    expect(criterion(summary, "contradicted").verdict).toBe("fail");
  });

  test("attribution and cost never self-certify", () => {
    const summary = summarizeShadow(many(MIN_JUDGED_SPAWNS));
    // Whether a divergence is a correct judgment or a resolution bug is not a
    // thing a machine can decide, and no model prices a planning unit today.
    expect(criterion(summary, "attributable").verdict).toBe("unknown");
    expect(criterion(summary, "cost").verdict).toBe("unknown");
    expect(criterion(summary, "cost").detail).toContain("NOT MEASURABLE TODAY");
    // So even a perfectly clean window is NOT flip-ready. The gate cannot be
    // cleared by the absence of evidence.
    expect(summary.flipReady).toBe(false);
  });
});

describe("the rollback trigger's baselines are measured, or declared missing", () => {
  test("the launch-failure baseline is a real rate over the actual routes", () => {
    const summary = summarizeShadow([
      ...many(8),
      ...many(2, { outcome: "failed", failureReason: "pane died" }),
    ]);
    const baseline = rollback(summary, "launch-failure-baseline");
    expect(baseline.verdict).toBe("pass");
    expect(baseline.detail).toContain("2 of 10");
    expect(baseline.detail).toContain("20.0%");
  });

  test("with no spawns, the baseline is unknown and the trigger is decorative", () => {
    const baseline = rollback(summarizeShadow([]), "launch-failure-baseline");
    expect(baseline.verdict).toBe("unknown");
    expect(baseline.detail).toContain("decorative");
  });

  test("the escalation baseline says plainly that nothing measures it", () => {
    // Hive counts no escalations anywhere — "escalation" is prompt wording, not
    // a metric. Reporting a rate here would be a number nobody measured.
    const escalation = rollback(summarizeShadow(many(80)), "escalation-baseline");
    expect(escalation.verdict).toBe("unknown");
    expect(escalation.detail).toContain("NOT MEASURED ANYWHERE IN HIVE");
  });
});
