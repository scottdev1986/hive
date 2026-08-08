import { describe, expect, test } from "bun:test";
import { superviseOrchestratorSession } from "../../src/cli/orchestrator-supervisor";
import type { PrepareQueenLaunchResponse } from "../../src/schemas/run-checkpoint";

const DIGEST = `sha256:${"a".repeat(64)}`;

function prepared(
  requestId: string,
  generation: number,
): PrepareQueenLaunchResponse {
  return {
    succession: {
      successionId: `qsc_00000000-0000-7000-8000-${String(generation).padStart(12, "0")}`,
      instanceId: "instance",
      revision: String(generation),
      createdAt: "2026-08-10T00:00:00.000Z",
      reason: generation === 1 ? "initial-boot" : "root-exit-with-live-agents",
      reasonDetail: "test",
      priorRootGeneration: generation - 1,
      newRootGeneration: null,
      proof: { kind: "no-checkpoint", detail: "none" },
      snapshot: [],
      replies: [],
      discrepancies: [],
      launchRequestId: requestId,
      bootCapsuleDigest: DIGEST,
      attestation: null,
    },
    targetGeneration: generation,
    bootCapsule: `capsule generation ${generation}`,
    bootCapsuleDigest: DIGEST,
    bootstrap: [],
    snapshot: [],
  };
}

describe("universal queen launch preparation", () => {
  test("initial boot prepares before launch and passes the boot capsule and generation", async () => {
    const calls: string[] = [];
    const result = await superviseOrchestratorSession({
      initialTool: "claude",
      desiredTool: async () => null,
      prepareLaunch: async (request) => {
        calls.push(`prepare:${request.reason}`);
        return prepared(request.requestId, 1);
      },
      launch: async (_tool, launch) => {
        calls.push(`launch:${launch.bootCapsule}:${launch.targetGeneration}`);
        return 0;
      },
      reportLaunchFailure: async () => {},
      fetchAgents: async () => [],
      sleep: async () => {},
      now: () => 20_000,
      report: () => {},
    });
    expect(result).toBe(0);
    expect(calls).toEqual([
      "prepare:initial-boot",
      "launch:capsule generation 1:1",
    ]);
  });

  test("a root exit with live workers prepares the next launch without a post-exit compiler", async () => {
    let launches = 0;
    const reasons: string[] = [];
    const result = await superviseOrchestratorSession({
      initialTool: "claude",
      desiredTool: async () => null,
      prepareLaunch: async (request) => {
        reasons.push(request.reason);
        return prepared(request.requestId, reasons.length);
      },
      launch: async () => (++launches === 1 ? 9 : 0),
      reportLaunchFailure: async () => {},
      fetchAgents: async () =>
        launches === 1
          ? [
              {
                id: "agent-1",
                name: "maya",
                status: "working",
                branch: "hive/maya",
                worktreePath: "/repo/maya",
                lastEventAt: "2026-08-10T00:00:00.000Z",
              } as never,
            ]
          : [],
      sleep: async () => {},
      now: () => launches * 20_000,
      report: () => {},
    });
    expect(result).toBe(0);
    expect(reasons).toEqual(["initial-boot", "root-exit-with-live-agents"]);
  });

  test("provider steering prepares a provider-change launch", async () => {
    let launches = 0;
    const reasons: string[] = [];
    const result = await superviseOrchestratorSession({
      initialTool: "claude",
      desiredTool: async () => (launches === 1 ? "codex" : null),
      prepareLaunch: async (request) => {
        reasons.push(request.reason);
        return prepared(request.requestId, reasons.length);
      },
      launch: async () => (++launches === 1 ? 1 : 0),
      reportLaunchFailure: async () => {},
      fetchAgents: async () => [],
      sleep: async () => {},
      now: () => launches * 20_000,
      report: () => {},
    });
    expect(result).toBe(0);
    expect(reasons).toEqual(["initial-boot", "provider-change"]);
  });
});
