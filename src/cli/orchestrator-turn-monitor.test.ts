import { describe, expect, test } from "bun:test";

import type { TurnBoundaryKind } from "../daemon/orchestrator-status";
import {
  monitorNativeOrchestratorTurns,
  type NativeTurnArtifact,
} from "./orchestrator-turn-monitor";

const oldArtifact = { sessionId: "old", path: "/old/events.jsonl" };
const newArtifact = { sessionId: "new", path: "/new/events.jsonl" };

describe("native orchestrator turn monitor", () => {
  test("ignores the predecessor and reports a new session's open and closed turn", async () => {
    const controller = new AbortController();
    const located: Array<NativeTurnArtifact | null> = [oldArtifact, newArtifact];
    const states = [false, true];
    const reports: Array<[TurnBoundaryKind, string]> = [];
    const identified: string[] = [];
    let sleeps = 0;

    await monitorNativeOrchestratorTurns("old", controller.signal, {
      locate: async () => located.shift() ?? newArtifact,
      read: async () => states.shift() ?? true,
      identify: async (artifact) => { identified.push(artifact.sessionId); },
      report: async (kind, sessionId) => { reports.push([kind, sessionId]); },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 3) controller.abort();
      },
      warn: () => {},
    });

    expect(reports).toEqual([
      ["turn-start", "new"],
      ["turn-end", "new"],
    ]);
    expect(identified).toEqual(["new"]);
  });

  test("pairs a completed short turn first observed after it ended", async () => {
    const controller = new AbortController();
    const reports: TurnBoundaryKind[] = [];
    await monitorNativeOrchestratorTurns(null, controller.signal, {
      locate: async () => newArtifact,
      read: async () => true,
      report: async (kind) => { reports.push(kind); },
      sleep: async () => { controller.abort(); },
      warn: () => {},
    });
    expect(reports).toEqual(["turn-start", "turn-end"]);
  });

  test("missing artifacts remain unknown instead of becoming idle", async () => {
    const controller = new AbortController();
    const reports: TurnBoundaryKind[] = [];
    await monitorNativeOrchestratorTurns(null, controller.signal, {
      locate: async () => null,
      read: async () => true,
      report: async (kind) => { reports.push(kind); },
      sleep: async () => { controller.abort(); },
      warn: () => {},
    });
    expect(reports).toEqual([]);
  });

  test("a failed boundary report is retried without advancing state", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const reports: TurnBoundaryKind[] = [];
    const warnings: string[] = [];
    await monitorNativeOrchestratorTurns(null, controller.signal, {
      locate: async () => newArtifact,
      read: async () => false,
      report: async (kind) => {
        attempts += 1;
        if (attempts === 1) throw new Error("daemon unavailable");
        reports.push(kind);
      },
      sleep: async () => {
        if (attempts === 2) controller.abort();
      },
      warn: (message) => { warnings.push(message); },
    });
    expect(attempts).toEqual(2);
    expect(reports).toEqual(["turn-start"]);
    expect(warnings).toHaveLength(1);
  });
});
