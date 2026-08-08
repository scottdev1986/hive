import { describe, expect, spyOn, test } from "bun:test";
import {
  memoryConsolidateCli,
  resolveConsolidationApplyTarget,
} from "../../src/cli/memory-consolidate";
import type { DaemonHandshake } from "../../src/daemon/lifecycle/daemon-lifecycle";
import type { ConsolidationReport } from "../../src/memory-service/consolidate";
import type { MemoryJobReceipt } from "../../src/schemas/memory-projections";

const HANDSHAKE: DaemonHandshake = {
  productVersion: "test",
  buildHash: "test-build",
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  capabilities: ["daemon-handshake-v1"],
  instanceId: "test-instance",
  hiveUuid: "test-project",
  identityKey: "test-identity",
  repoFamilyKey: null,
  generation: 1,
};

const EMPTY_REPORT: ConsolidationReport = {
  embedded: 0,
  scanned: 0,
  identical: [],
  similar: [],
  applied: [],
  skipped: [],
  failures: [],
};

const SUCCEEDED_RECEIPT: MemoryJobReceipt = {
  id: "00000001-consolidation-apply",
  kind: "consolidation-apply",
  state: "succeeded",
  requestedBy: "user",
  startedAt: "2026-08-07T12:00:00.000Z",
  finishedAt: "2026-08-07T12:00:01.000Z",
  progress: { step: "reading back", done: 1, total: 1 },
  summary: "2 vectors scanned, 1 identical and 0 similar pairs, 1 applied",
  error: null,
  readback: { wikiArticles: 1, ftsRows: 1 },
};

describe("memory consolidate CLI ownership", () => {
  test("a live matching daemon owns apply", async () => {
    expect(
      await resolveConsolidationApplyTarget("/repo", {
        hiveHome: () => "/instance-a",
        liveness: async () => "live",
        expectedHandshake: async () => HANDSHAKE,
        probeReuse: async () => ({ state: "authorized", port: 4317 }),
      }),
    ).toEqual({ state: "daemon", port: 4317 });
  });

  test("a stale lock with a dead owner permits offline apply", async () => {
    expect(
      await resolveConsolidationApplyTarget("/repo", {
        hiveHome: () => "/instance-a",
        liveness: async () => "dead",
      }),
    ).toEqual({ state: "offline" });
  });

  test("starting, stopping, or different-instance ownership fails closed", async () => {
    await expect(
      resolveConsolidationApplyTarget("/repo", {
        hiveHome: () => "/instance-a",
        liveness: async () => "unknown",
      }),
    ).rejects.toThrow(/ownership is unknown; refusing offline consolidation/);
  });

  test("a live daemon for a different project or build fails closed", async () => {
    await expect(
      resolveConsolidationApplyTarget("/repo", {
        hiveHome: () => "/instance-a",
        liveness: async () => "live",
        expectedHandshake: async () => HANDSHAKE,
        probeReuse: async () => ({
          state: "rejected",
          port: 4317,
          reason: "project identity differs",
        }),
      }),
    ).rejects.toThrow(/does not own this project\/build/);
  });

  test("live apply uses the daemon job and never the offline writer", async () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const daemonPorts: number[] = [];
    let offlineCalled = false;
    try {
      const exit = await memoryConsolidateCli(
        { apply: true },
        {
          projectRoot: () => "/repo",
          resolveApplyTarget: async () => ({ state: "daemon", port: 4317 }),
          runDaemonApply: async (port) => {
            daemonPorts.push(port);
            return SUCCEEDED_RECEIPT;
          },
          runOffline: async () => {
            offlineCalled = true;
            return EMPTY_REPORT;
          },
        },
      );
      expect(exit).toBe(0);
      expect(daemonPorts).toEqual([4317]);
      expect(offlineCalled).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  test("dead-daemon apply keeps the offline maintenance path", async () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    let offlineApply: boolean | undefined;
    let daemonCalled = false;
    try {
      const exit = await memoryConsolidateCli(
        { apply: true },
        {
          projectRoot: () => "/repo",
          resolveApplyTarget: async () => ({ state: "offline" }),
          runDaemonApply: async () => {
            daemonCalled = true;
            return SUCCEEDED_RECEIPT;
          },
          runOffline: async (_repoRoot, apply) => {
            offlineApply = apply;
            return EMPTY_REPORT;
          },
        },
      );
      expect(exit).toBe(0);
      expect(offlineApply).toBe(true);
      expect(daemonCalled).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
