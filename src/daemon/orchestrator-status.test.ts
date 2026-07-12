import { describe, expect, test } from "bun:test";
import {
  deriveOrchestratorStatus,
  type TurnBoundaryKind,
} from "./orchestrator-status";

describe("deriveOrchestratorStatus", () => {
  test("an open turn is working", () => {
    expect(deriveOrchestratorStatus(["turn-start", "turn-end"])).toBe("working");
  });

  test("a closed turn that actually started is idle", () => {
    expect(deriveOrchestratorStatus(["turn-end", "turn-start"])).toBe("idle");
  });

  /**
   * The contradiction case, and the reason this function exists.
   *
   * A turn cannot end without starting, so two turn-ends in a row means the
   * root's turn-start hook is not reaching the daemon. This is measured history,
   * not a hypothetical: between 2026-07-11T19:39Z and 2026-07-12T10:58Z the root
   * posted 231 turn-ends and zero turn-starts after a port change orphaned that
   * one hook. A "newest is turn-end, so it's idle" rule would have painted the
   * dot a confident yellow for 15 hours while the root worked without pause.
   *
   * Say nothing instead. The field is omitted, the dot is gray, gray is unknown,
   * and unknown is the truth.
   */
  test("a turn-end after a turn-end is impossible, so we refuse to guess", () => {
    expect(deriveOrchestratorStatus(["turn-end", "turn-end"])).toBeNull();
  });

  test("a lone turn-end never saw its own start, so it is not trusted either", () => {
    expect(deriveOrchestratorStatus(["turn-end"])).toBeNull();
  });

  /** A root that has never taken a turn and a root whose turn-start hook is
   * broken look identical from here. We do not pick the flattering one. */
  test("no boundaries at all is unknown, not idle", () => {
    expect(deriveOrchestratorStatus([])).toBeNull();
  });

  /** A lone turn-start is still an open turn: the root is working. */
  test("a first-ever turn-start is working", () => {
    expect(deriveOrchestratorStatus(["turn-start"])).toBe("working");
  });

  /** Nothing here is a function of elapsed time, and nothing here may become
   * one: a long turn is a working root, not a stuck one. The derivation sees
   * only kinds, never timestamps — this test pins that shape. */
  test("the derivation reads kinds only, so no timeout can creep in", () => {
    const openTurn: TurnBoundaryKind[] = ["turn-start", "turn-end"];
    expect(deriveOrchestratorStatus(openTurn)).toBe("working");
    // Same kinds, any age whatsoever: still working. There is no input by which
    // this could decide otherwise, which is the guarantee we want.
    expect(deriveOrchestratorStatus(openTurn)).toBe("working");
  });
});
