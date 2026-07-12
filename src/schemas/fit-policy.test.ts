import { describe, expect, test } from "bun:test";
import {
  applyFitPolicy,
  CODING_SCORE_COLUMN,
  type FitCandidate,
} from "./fit-policy";

const row = (effort: string, score: number, releaseDate = "2026-06-25") => ({
  sourceId: "livebench",
  effort,
  scores: { code_generation: score },
  releaseDate,
});

const candidate = (
  canonicalId: string,
  options: { efforts?: string[] | null; rows?: ReturnType<typeof row>[] } = {},
): FitCandidate => ({
  token: canonicalId,
  canonicalId,
  advertisedEfforts: options.efforts === undefined ? null : options.efforts,
  rows: options.rows ?? [],
});

describe("fit policy ordering", () => {
  test("a material score difference places the higher-scored candidate first, with its basis", () => {
    const decision = applyFitPolicy({
      candidates: [
        candidate("claude-fable-5", { rows: [row("xhigh", 80)] }),
        candidate("claude-opus-4-8", { rows: [row("xhigh", 86)] }),
      ],
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.changed).toBeTrue();
    expect(decision.order.map((entry) => entry.canonicalId)).toEqual([
      "claude-opus-4-8",
      "claude-fable-5",
    ]);
    expect(decision.detail).toContain("placed claude-opus-4-8");
    expect(decision.detail).toContain("code_generation=86");
  });

  test("scores within the 5-point band are tied and the given order stands", () => {
    const decision = applyFitPolicy({
      candidates: [
        candidate("claude-fable-5", { rows: [row("xhigh", 84)] }),
        candidate("claude-opus-4-8", { rows: [row("xhigh", 86)] }),
      ],
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.changed).toBeFalse();
    expect(decision.order.map((entry) => entry.canonicalId)).toEqual([
      "claude-fable-5",
      "claude-opus-4-8",
    ]);
    expect(decision.detail).toContain("order stands");
  });

  test("ordering only, structurally: every decision returns exactly the candidates it was given", () => {
    const candidates = [
      candidate("covered", { rows: [row("xhigh", 90)] }),
      candidate("uncovered"),
      candidate("also-covered", { rows: [row("xhigh", 70)] }),
    ];
    const decision = applyFitPolicy({
      candidates,
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.order.map((entry) => entry.canonicalId).sort()).toEqual(
      ["also-covered", "covered", "uncovered"].sort(),
    );
    expect(decision.order).toHaveLength(3);
  });

  test("a zero-coverage candidate holds its position and never gates", () => {
    // The uncovered candidate sits between two measured ones that are
    // materially apart: the measured pair reorders around it, the uncovered
    // one keeps its exact slot, labeled with the consulted-and-empty ladder.
    const decision = applyFitPolicy({
      candidates: [
        candidate("low-scored", { rows: [row("xhigh", 70)] }),
        candidate("uncovered"),
        candidate("high-scored", { rows: [row("xhigh", 90)] }),
      ],
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.order.map((entry) => entry.canonicalId)).toEqual([
      "high-scored",
      "uncovered",
      "low-scored",
    ]);
    expect(decision.order[1]?.basis).toContain("holds policy position");
    expect(decision.order[1]?.score).toBeNull();
  });

  test("an advertised-but-unmeasured effort yields labeled ordinal inference, never a number", () => {
    const decision = applyFitPolicy({
      candidates: [
        candidate("claude-fable-5", {
          efforts: ["high", "xhigh"],
          rows: [row("xhigh", 90)],
        }),
      ],
      routedEffort: "high",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.changed).toBeFalse();
    expect(decision.order[0]?.score).toBeNull();
    expect(decision.order[0]?.basis).toContain("inferred: below claude-fable-5 xhigh");
    expect(decision.order[0]?.basis).toContain("ordinal only");
  });

  test("an unmapped kind leaves the policy inert, and says so", () => {
    const decision = applyFitPolicy({
      candidates: [candidate("claude-fable-5", { rows: [row("xhigh", 90)] })],
      routedEffort: "xhigh",
      column: null,
    });
    expect(decision.changed).toBeFalse();
    expect(decision.detail).toContain("no mapped score column");
  });
});

describe("effort economy", () => {
  test("routes the lowest advertised effort measured within the band of the routed one", () => {
    const decision = applyFitPolicy({
      candidates: [
        candidate("claude-fable-5", {
          efforts: ["high", "xhigh"],
          rows: [row("xhigh", 90), row("high", 87)],
        }),
      ],
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.changed).toBeTrue();
    expect(decision.effort).toMatchObject({ value: "high" });
    expect(decision.effort?.basis).toContain("code_generation=87");
    expect(decision.detail).toContain("routes high");
  });

  test("a materially weaker lower effort is not sufficient", () => {
    const decision = applyFitPolicy({
      candidates: [
        candidate("claude-fable-5", {
          efforts: ["high", "xhigh"],
          rows: [row("xhigh", 90), row("high", 82)],
        }),
      ],
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.changed).toBeFalse();
    expect(decision.effort).toBeNull();
  });

  test("an unmeasured lower effort is never 'sufficient' on inference alone", () => {
    const decision = applyFitPolicy({
      candidates: [
        candidate("claude-fable-5", {
          efforts: ["high", "xhigh"],
          rows: [row("xhigh", 90)],
        }),
      ],
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.changed).toBeFalse();
    expect(decision.effort).toBeNull();
  });

  test("unknown advertised efforts mean no economy call at all", () => {
    const decision = applyFitPolicy({
      candidates: [
        candidate("claude-fable-5", {
          efforts: null,
          rows: [row("xhigh", 90), row("high", 88)],
        }),
      ],
      routedEffort: "xhigh",
      column: CODING_SCORE_COLUMN,
    });
    expect(decision.effort).toBeNull();
  });
});
