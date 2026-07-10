import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaConfigSchema, type QuotaLimit } from "../schemas";
import { HiveDatabase } from "./db";
import { QuotaLedger } from "./quota-ledger";
import { QuotaService } from "./quota";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

const claudeLimit: QuotaLimit = {
  provider: "claude",
  account: "personal",
  pool: "claude-subscription",
  models: ["claude-fable-5"],
  fiveHourAllowance: 200,
  weeklyAllowance: 1_000,
  weeklyWindow: "rolling",
  timezone: "UTC",
  resetWeekday: 1,
  resetHour: 0,
  resetMinute: 0,
  observationMaxAgeMinutes: 60,
};

const now = new Date("2026-07-09T12:00:00.000Z");

async function service(): Promise<{ quota: QuotaService; db: HiveDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "hive-quota-statusline-"));
  roots.push(root);
  const db = new HiveDatabase(join(root, "hive.db"));
  const quota = new QuotaService(
    new QuotaLedger(db),
    QuotaConfigSchema.parse({ limits: [claudeLimit] }),
    () => now,
  );
  return { quota, db };
}

const claude = { tool: "claude" as const, model: "claude-fable-5" };

const poolStatus = (quota: QuotaService) => {
  const status = quota.statuses(now)[0]!;
  if (!("fiveHour" in status)) throw new Error("expected a configured pool");
  return status;
};

describe("statusLine quota telemetry", () => {
  test("maps used percentages onto the configured allowance as a reported signal", async () => {
    const { quota, db } = await service();
    try {
      const observation = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 25, resetsAt: "2026-07-09T15:00:00.000Z" },
        sevenDay: { usedPct: 40, resetsAt: "2026-07-14T00:00:00.000Z" },
        observedAt: now.toISOString(),
      });

      expect(observation).toMatchObject({
        provider: "claude",
        account: "personal",
        pool: "claude-subscription",
        fiveHourUsed: 50, // 25% of 200
        weeklyUsed: 400, // 40% of 1000
        source: "statusline",
        // Semi-official: above a conservative estimate, below a real feed.
        confidence: "reported",
      });

      const status = poolStatus(quota);
      expect(status.confidence).toBe("reported");
      expect(status.freshness).toBe("fresh");
      expect(status.source).toBe("statusline");
      expect(status.fiveHour.used).toBe(50);
      expect(status.fiveHour.resetsAt).toBe("2026-07-09T15:00:00.000Z");
      expect(status.weekly.used).toBe(400);
    } finally {
      db.close();
    }
  });

  test("keeps the local estimate as the floor when the reading is lower", async () => {
    const { quota, db } = await service();
    try {
      // A completed deep run recorded 80 estimated units locally.
      const reservation = await quota.reserveControlRun({
        agentName: "maya",
        tier: "deep",
        controlMessageId: "control-1",
        ...claude,
      });
      quota.markStarted(reservation.id, now.toISOString());
      await quota.reconcile(reservation.id, 80, "estimated", now.toISOString());
      expect(poolStatus(quota).fiveHour.used).toBe(80);

      // statusLine optimistically claims only 10% (20 units) is used.
      await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 10, resetsAt: null },
        observedAt: now.toISOString(),
      });

      // max() of ledger and observation: an optimistic external number can
      // never free capacity inside the current window.
      expect(poolStatus(quota).fiveHour.used).toBe(80);
    } finally {
      db.close();
    }
  });

  test("tightens the picture when the reading is higher than the ledger", async () => {
    const { quota, db } = await service();
    try {
      await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 75, resetsAt: null },
        observedAt: now.toISOString(),
      });
      const status = poolStatus(quota);
      expect(status.fiveHour.used).toBe(150);
      expect(status.fiveHour.remaining).toBe(50);
    } finally {
      db.close();
    }
  });

  test("never downgrades a fresher authoritative provider feed", async () => {
    const { quota, db } = await service();
    try {
      await quota.observe({
        provider: "claude",
        account: "personal",
        pool: "claude-subscription",
        fiveHourUsed: 120,
        weeklyUsed: 300,
        observedAt: now.toISOString(),
        fiveHourResetAt: null,
        weeklyResetAt: null,
        source: "provider",
        confidence: "authoritative",
      });

      const skipped = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 5, resetsAt: null },
        observedAt: new Date(now.getTime() - 1_000).toISOString(),
      });

      expect(skipped).toBeNull();
      const status = poolStatus(quota);
      expect(status.confidence).toBe("authoritative");
      expect(status.fiveHour.used).toBe(120);
    } finally {
      db.close();
    }
  });

  test("a newer statusLine reading supersedes a stale authoritative one", async () => {
    const { quota, db } = await service();
    try {
      await quota.observe({
        provider: "claude",
        account: "personal",
        pool: "claude-subscription",
        fiveHourUsed: 20,
        weeklyUsed: 20,
        observedAt: new Date(now.getTime() - 60_000).toISOString(),
        fiveHourResetAt: null,
        weeklyResetAt: null,
        source: "provider",
        confidence: "authoritative",
      });
      const observation = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 50, resetsAt: null },
        observedAt: now.toISOString(),
      });
      expect(observation?.confidence).toBe("reported");
      expect(poolStatus(quota).fiveHour.used).toBe(100);
    } finally {
      db.close();
    }
  });

  test("carries a missing window forward instead of zeroing it", async () => {
    const { quota, db } = await service();
    try {
      await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 30, resetsAt: null },
        sevenDay: { usedPct: 60, resetsAt: "2026-07-14T00:00:00.000Z" },
        observedAt: new Date(now.getTime() - 600_000).toISOString(),
      });
      // A later render reports only the five-hour window.
      const observation = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 35, resetsAt: null },
        observedAt: now.toISOString(),
      });
      expect(observation?.fiveHourUsed).toBe(70);
      expect(observation?.weeklyUsed).toBe(600);
      expect(observation?.weeklyResetAt).toBe("2026-07-14T00:00:00.000Z");
    } finally {
      db.close();
    }
  });

  test("ignores a report with no windows and an unconfigured model", async () => {
    const { quota, db } = await service();
    try {
      expect(
        await quota.observeStatusline(claude, {
          observedAt: now.toISOString(),
        }),
      ).toBeNull();
      expect(
        await quota.observeStatusline(
          { tool: "claude", model: "some-other-model" },
          {
            fiveHour: { usedPct: 50, resetsAt: null },
            observedAt: now.toISOString(),
          },
        ),
      ).toBeNull();
      // With no observation, the local estimate remains the only signal.
      expect(poolStatus(quota).confidence).toBe("estimated");
    } finally {
      db.close();
    }
  });

  test("debounces an unchanged reading from the per-render status line", async () => {
    const { quota, db } = await service();
    try {
      const first = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 30, resetsAt: null },
        observedAt: now.toISOString(),
      });
      const second = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 30, resetsAt: null },
        observedAt: new Date(now.getTime() + 1_000).toISOString(),
      });
      expect(second?.observedAt).toBe(first!.observedAt);

      // A changed reading writes immediately.
      const third = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 31, resetsAt: null },
        observedAt: new Date(now.getTime() + 2_000).toISOString(),
      });
      expect(third?.fiveHourUsed).toBe(62);

      // An unchanged reading past the debounce window refreshes freshness.
      const fourth = await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 31, resetsAt: null },
        observedAt: new Date(now.getTime() + 400_000).toISOString(),
      });
      expect(fourth?.observedAt).toBe(
        new Date(now.getTime() + 400_000).toISOString(),
      );
    } finally {
      db.close();
    }
  });

  test("a stale statusLine observation degrades confidence rather than lying", async () => {
    const { quota, db } = await service();
    try {
      await quota.observeStatusline(claude, {
        fiveHour: { usedPct: 30, resetsAt: null },
        // observationMaxAgeMinutes is 60.
        observedAt: new Date(now.getTime() - 90 * 60_000).toISOString(),
      });
      const status = poolStatus(quota);
      expect(status.confidence).toBe("stale");
      expect(status.freshness).toBe("stale");
    } finally {
      db.close();
    }
  });
});
