import { describe, expect, test } from "bun:test";
import {
  findMarkerAgents,
  isProductFailure,
  planTeardown,
  readbackAllowsRemoval,
  teardownReport,
} from "./agent-scenario-core";

describe("agent scenario failure paths", () => {
  test("does not claim clean teardown when no admitted agent was measured", () => {
    const plan = planTeardown([], "/qa-project");
    if (plan.kind !== "no-admission") throw new Error("expected no admission");
    const report = teardownReport(plan.kind);

    expect(report).toStartWith("INFRASTRUCTURE_RED");
    expect(report).not.toContain("teardown clean");
  });

  test("reconciles every admitted agent by marker after the spawn call errors", () => {
    const marker = "HIVE_QA_AGENT_SCENARIO_123";
    const admitted = ["first", "duplicate"].map((id) => ({
      id,
      taskDescription: `QA lifecycle marker ${marker}. Implement TASK 3.`,
    }));

    expect(
      findMarkerAgents(
        [{ id: "other", taskDescription: "unrelated" }, ...admitted],
        marker,
      ),
    ).toEqual(admitted);
  });

  test("falls back to the rig worktree root and blocks removal until it is empty", () => {
    const plan = planTeardown(
      [
        { worktreePath: null },
        { worktreePath: "/qa-project/.hive/worktrees/a" },
      ],
      "/qa-project",
    );

    expect(plan).toEqual({
      kind: "measure",
      readbackRoot: "/qa-project/.hive/worktrees",
    });
    expect(readbackAllowsRemoval(new Set(["42:99"]))).toBeFalse();
    expect(readbackAllowsRemoval(new Set())).toBeTrue();
  });

  test("preserves product classification through aggregate teardown failures", () => {
    const failure = new AggregateError([
      new Error("PRODUCT_RED acknowledgement timed out"),
      new Error("teardown failed"),
    ]);

    expect(isProductFailure(failure)).toBeTrue();
  });
});
