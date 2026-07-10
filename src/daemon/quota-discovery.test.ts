import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaConfigSchema, type QuotaLimit, type QuotaPoolStatus } from "../schemas";
import { HiveDatabase } from "./db";
import { QuotaLedger } from "./quota-ledger";
import { QuotaService, type CodexRateLimitsResponse } from "./quota";
import {
  ClaudeQuotaProbe,
  CodexQuotaProbe,
  readingsFromClaudeUsage,
  readingsFromCodexResponse,
  orderRateLimitWindows,
  type ClaudeUsageResponse,
  type QuotaProbe,
  type QuotaProbeResult,
} from "./quota-sources";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

const now = new Date("2026-07-10T12:00:00.000Z");
const epoch = (offsetMs: number): number =>
  Math.floor((now.getTime() + offsetMs) / 1_000);

const codexResponse: CodexRateLimitsResponse = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    planType: "pro",
    primary: {
      usedPercent: 57,
      windowDurationMins: 300,
      resetsAt: epoch(2 * 60 * 60_000),
    },
    secondary: {
      usedPercent: 40,
      windowDurationMins: 10_080,
      resetsAt: epoch(3 * 24 * 60 * 60_000),
    },
  },
  rateLimitsByLimitId: {
    codex_spark: {
      limitId: "codex_spark",
      limitName: "GPT-5.3-Codex-Spark",
      primary: null,
      secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: null },
    },
  },
};

const claudeUsage: ClaudeUsageResponse = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 6, resets_at: "2026-07-10T19:00:00.000000+00:00" },
    seven_day: { utilization: 42, resets_at: "2026-07-11T19:00:00.000000+00:00" },
    model_scoped: [
      { display_name: "Fable", utilization: 71, resets_at: "2026-07-11T19:00:00Z" },
    ],
  },
};

class StubProbe implements QuotaProbe {
  calls = 0;
  constructor(
    readonly provider: "claude" | "codex",
    private readonly result: QuotaProbeResult,
  ) {}
  read(): Promise<QuotaProbeResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

async function service(
  probes: QuotaProbe[] = [],
  limits: QuotaLimit[] = [],
  clock: () => Date = () => now,
): Promise<{ quota: QuotaService; db: HiveDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "hive-quota-discovery-"));
  roots.push(root);
  const db = new HiveDatabase(join(root, "hive.db"));
  const quota = new QuotaService(
    new QuotaLedger(db),
    QuotaConfigSchema.parse({ limits }),
    clock,
    probes,
  );
  return { quota, db };
}

const pool = (quota: QuotaService, name: string, at = now): QuotaPoolStatus => {
  const status = quota.statuses(at).find((candidate) =>
    !("configured" in candidate) && candidate.pool === name
  );
  if (status === undefined || "configured" in status) {
    throw new Error(`expected a discovered pool named ${name}`);
  }
  return status;
};

describe("window ordering", () => {
  test("identifies windows by duration, not by the name the provider gave them", () => {
    // A snapshot that lists the weekly bucket first must not invert the two.
    const windows = orderRateLimitWindows({
      primary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
      secondary: { usedPercent: 57, windowDurationMins: 300, resetsAt: null },
    });
    expect(windows.fiveHour?.usedPct).toBe(57);
    expect(windows.weekly?.usedPct).toBe(40);
  });

  test("refuses to guess which window an undated single reading describes", () => {
    const windows = orderRateLimitWindows({
      primary: { usedPercent: 40, windowDurationMins: null, resetsAt: null },
      secondary: null,
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly).toBeNull();
  });

  // An undated window sorted to the end would shove the dated weekly bucket into
  // the five-hour slot, filing 20% weekly usage as 20% five-hour usage.
  test("drops an undated window instead of misfiling the dated one beside it", () => {
    const windows = orderRateLimitWindows({
      primary: { usedPercent: 50, windowDurationMins: null, resetsAt: null },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: null },
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly?.usedPct).toBe(20);
    expect(windows.weekly?.windowMinutes).toBe(10_080);
  });

  test("ignores a window whose used percentage is not a finite number", () => {
    const windows = orderRateLimitWindows({
      primary: { usedPercent: Number.NaN, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: -1, windowDurationMins: 10_080, resetsAt: null },
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly).toBeNull();
  });

  test("rejects percentages outside the provider's 0-100 scale", () => {
    const windows = orderRateLimitWindows({
      primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: null },
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly?.usedPct).toBe(20);
  });

  test("treats an unrepresentable reset epoch as unknown", () => {
    const windows = orderRateLimitWindows({
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: Number.MAX_VALUE,
      },
      secondary: null,
    });
    expect(windows.fiveHour?.resetsAt).toBeNull();
  });

  test("drops malformed Codex response shapes instead of throwing", () => {
    expect(readingsFromCodexResponse(
      { rateLimits: null } as unknown as CodexRateLimitsResponse,
      "default",
      now.toISOString(),
    )).toEqual([]);
  });
});

describe("startup quota discovery", () => {
  test("reads real limits from the providers with no configuration at all", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      const reports = await quota.refreshFromProviders(now);
      expect(reports).toEqual([{ provider: "codex", status: "ok", pools: 2 }]);

      const routable = pool(quota, "codex");
      expect(routable.origin).toBe("discovered");
      expect(routable.routable).toBe(true);
      // The provider reports percentages, so the pool is denominated in percent.
      expect(routable.fiveHour.unit).toBe("percent");
      expect(routable.fiveHour.used).toBe(57);
      expect(routable.fiveHour.allowance).toBe(100);
      expect(routable.weekly.used).toBe(40);
      expect(routable.fiveHour.confidence).toBe("authoritative");
      expect(routable.fiveHour.source).toBe("provider");
      expect(routable.fiveHour.observedAt).toBe(now.toISOString());
      expect(routable.fiveHour.resetsAt).toBe(
        new Date(epoch(2 * 60 * 60_000) * 1_000).toISOString(),
      );

      // A metered sub-limit is visible but never routed onto: Hive will not guess
      // which concrete model a `limitId` names.
      const spark = pool(quota, "codex_spark");
      expect(spark.routable).toBe(false);
      expect(spark.label).toBe("GPT-5.3-Codex-Spark");
      expect(spark.weekly.used).toBe(12);
      expect(spark.fiveHour.used).toBeNull();
    } finally {
      db.close();
    }
  });

  test("routes and reserves against the discovered pool", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      const decision = await quota.routeAndReserve({
        agentName: "sam",
        tier: "deep",
        preferredTool: "codex",
        candidates: [{ tool: "codex", model: "gpt-5.3-codex" }],
      });
      expect(decision.tool).toBe("codex");
      expect(decision.reservation.pool).toBe("codex");
      // The deep tier's percent estimate debits each window differently.
      expect(decision.reservation.estimatedUnits).toBe(8);
      expect(decision.reservation.estimatedWeeklyUnits).toBe(1.5);

      const after = pool(quota, "codex");
      expect(after.fiveHour.reserved).toBe(8);
      expect(after.weekly.reserved).toBe(1.5);
      expect(after.fiveHour.remaining).toBeCloseTo(100 - 57 - 8, 5);
      expect(after.weekly.remaining).toBeCloseTo(100 - 40 - 1.5, 5);
      expect(after.fiveHour.reservedIsEstimate).toBe(true);
    } finally {
      db.close();
    }
  });

  test("refuses a spawn the provider's own numbers say will not fit", async () => {
    const exhausted: CodexRateLimitsResponse = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
      },
    };
    const codex = new StubProbe("codex", await codexPools(exhausted));
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      await expect(quota.routeAndReserve({
        agentName: "sam",
        tier: "deep",
        preferredTool: "codex",
        candidates: [{ tool: "codex", model: "gpt-5.3-codex" }],
      })).rejects.toThrow(/Quota pressure/);
    } finally {
      db.close();
    }
  });
});

describe("notification-driven quota updates", () => {
  // Regression: observeCodexRateLimits used to look up a configured pool first
  // and drop the reading when none existed, so an installation without a
  // quota.toml threw away every authoritative percentage Codex handed it.
  test("stores an app-server reading when no pool is configured", async () => {
    const { quota, db } = await service();
    try {
      const reading = await quota.observeCodexRateLimits(
        "gpt-5.3-codex",
        codexResponse,
        now.toISOString(),
      );
      expect(reading).toEqual({ fiveHourUsed: 57, weeklyUsed: 40 });

      const stored = quota.ledger.getObservation({
        provider: "codex",
        account: "default",
        pool: "codex",
      });
      expect(stored?.fiveHourUsed).toBe(57);
      expect(stored?.confidence).toBe("authoritative");
      expect(pool(quota, "codex").fiveHour.used).toBe(57);
    } finally {
      db.close();
    }
  });

  test("a later notification advances the reading", async () => {
    const { quota, db } = await service();
    try {
      await quota.observeCodexRateLimits("gpt-5.3-codex", codexResponse, now.toISOString());
      const later = new Date(now.getTime() + 60_000).toISOString();
      await quota.observeCodexRateLimits("gpt-5.3-codex", {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 61, windowDurationMins: 300, resetsAt: null },
          secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: null },
        },
      }, later);
      const status = pool(quota, "codex", new Date(now.getTime() + 60_000));
      expect(status.fiveHour.used).toBe(61);
      expect(status.fiveHour.observedAt).toBe(later);
    } finally {
      db.close();
    }
  });

  test("still maps percentages onto an operator's declared units when overridden", async () => {
    const override: QuotaLimit = {
      provider: "codex",
      account: "default",
      pool: "codex",
      models: ["*"],
      fiveHourAllowance: 200,
      weeklyAllowance: 1_000,
      weeklyWindow: "rolling",
      timezone: "UTC",
      resetWeekday: 1,
      resetHour: 0,
      resetMinute: 0,
      observationMaxAgeMinutes: 360,
    };
    const { quota, db } = await service([], [override]);
    try {
      const reading = await quota.observeCodexRateLimits(
        "gpt-5.3-codex",
        codexResponse,
        now.toISOString(),
      );
      // 57% of 200 units, 40% of 1000 units.
      expect(reading).toEqual({ fiveHourUsed: 114, weeklyUsed: 400 });
      const status = pool(quota, "codex");
      expect(status.origin).toBe("manual");
      expect(status.overridesDiscovered).toBe(true);
      expect(status.fiveHour.unit).toBe("units");
      expect(status.fiveHour.used).toBe(114);
    } finally {
      db.close();
    }
  });
});

describe("per-window accounting", () => {
  // Each window is observed on its own schedule. Using the row-level timestamp
  // as one cutoff for both would drop weekly spend recorded between an older
  // weekly reading and a newer five-hour one — headroom a concurrent spawn
  // would then overcommit.
  test("weekly spend between two readings is not swallowed by a newer five-hour cutoff", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);

      // Spend a standard run: 4% of five-hour, 0.75% of weekly.
      const decision = await quota.routeAndReserve({
        agentName: "sam",
        tier: "standard",
        preferredTool: "codex",
        candidates: [{ tool: "codex", model: "gpt-5.3-codex" }],
      });
      const spentAt = new Date(now.getTime() + 60_000);
      quota.markStarted(decision.reservation.id, spentAt.toISOString());
      await quota.reconcile(
        decision.reservation.id,
        undefined,
        "estimated",
        spentAt.toISOString(),
      );

      // A five-hour-only statusLine now arrives, newer than the weekly reading.
      const laterAt = new Date(now.getTime() + 120_000);
      await quota.observeStatusline(
        { tool: "codex", model: "gpt-5.3-codex" },
        {
          fiveHour: { usedPct: 60, resetsAt: null },
          observedAt: laterAt.toISOString(),
        },
      );

      const status = pool(quota, "codex", laterAt);
      // The weekly reading was 40%; the 0.75% spent after it must still count.
      expect(status.weekly.used).toBeCloseTo(40.75, 5);
    } finally {
      db.close();
    }
  });

  // Committing the five-hour estimate to the weekly ledger too would overstate
  // weekly spend ~5x for a percent pool, refusing spawns that would have fit.
  test("reconcile debits each window its own estimate", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      const decision = await quota.routeAndReserve({
        agentName: "sam",
        tier: "standard",
        preferredTool: "codex",
        candidates: [{ tool: "codex", model: "gpt-5.3-codex" }],
      });
      const at = new Date(now.getTime() + 60_000);
      await quota.reconcile(decision.reservation.id, undefined, "estimated", at.toISOString());

      const totals = quota.ledger.usageTotals(
        { provider: "codex", account: "default", pool: "codex" },
        new Date(now.getTime() - 5 * 60 * 60_000).toISOString(),
        new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString(),
      );
      expect(totals.fiveHour).toBe(4);
      expect(totals.weekly).toBe(0.75);
    } finally {
      db.close();
    }
  });

  test("a provider-reported actual scales the weekly debit by the estimated ratio", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      const decision = await quota.routeAndReserve({
        agentName: "sam",
        tier: "standard",
        preferredTool: "codex",
        candidates: [{ tool: "codex", model: "gpt-5.3-codex" }],
      });
      const at = new Date(now.getTime() + 60_000);
      // The provider says the run really cost 2% of the five-hour window.
      await quota.reconcile(decision.reservation.id, 2, "provider", at.toISOString());

      const totals = quota.ledger.usageTotals(
        { provider: "codex", account: "default", pool: "codex" },
        new Date(now.getTime() - 5 * 60 * 60_000).toISOString(),
        new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString(),
      );
      expect(totals.fiveHour).toBe(2);
      // 2% of five-hour, at the tier's 0.75/4 ratio, is 0.375% of the week.
      expect(totals.weekly).toBeCloseTo(0.375, 5);
    } finally {
      db.close();
    }
  });
});

describe("staleness", () => {
  test("does not treat a future-dated observation as fresh", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      const beforeObservation = new Date(now.getTime() - 1);
      const status = pool(quota, "codex", beforeObservation);
      expect(status.freshness).toBe("stale");
      expect(status.fiveHour.confidence).toBe("stale");
    } finally {
      db.close();
    }
  });

  test("keeps the number but downgrades its confidence once it ages out", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      // Discovered pools go stale at twice the refresh interval (30 minutes).
      const later = new Date(now.getTime() + 31 * 60_000);
      const status = pool(quota, "codex", later);
      expect(status.freshness).toBe("stale");
      expect(status.fiveHour.confidence).toBe("stale");
      // The measurement itself is preserved: staleness is not ignorance.
      expect(status.fiveHour.used).toBe(57);
      expect(status.fiveHour.observedAt).toBe(now.toISOString());
    } finally {
      db.close();
    }
  });

  // A reset voids the old reading. Reporting 0% would claim the account is
  // untouched, but the human spends this account outside Hive too — nobody has
  // measured the new window yet, so it is unknown until the next probe.
  test("a passed reset makes the window unknown, not zero", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      const later = new Date(now.getTime() + 3 * 60 * 60_000);
      const status = pool(quota, "codex", later);
      expect(status.fiveHour.used).toBeNull();
      expect(status.fiveHour.confidence).toBe("missing");
      // The weekly window has not reset, so its reading survives.
      expect(status.weekly.used).toBe(40);
      // And Hive re-probes rather than waiting out the refresh interval.
      expect(quota.needsRefresh(later)).toBe(true);
    } finally {
      db.close();
    }
  });

  // Probing costs a subprocess, and Claude's usage endpoint rate-limits under
  // polling. The free feeds keep a busy hive current; probes fill the gaps.
  test("skips a provider whose pools are already live, but never at startup", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now, { force: true });
      expect(codex.calls).toBe(1);

      const reports = await quota.refreshFromProviders(now);
      expect(reports).toEqual([{ provider: "codex", status: "skipped", pools: 0 }]);
      expect(codex.calls).toBe(1);

      // Startup always asks, however fresh the stored reading looks.
      await quota.refreshFromProviders(now, { force: true });
      expect(codex.calls).toBe(2);
    } finally {
      db.close();
    }
  });

  test("an operator override does not silently disable discovery", async () => {
    const override: QuotaLimit = {
      provider: "codex",
      account: "default",
      pool: "codex",
      models: ["*"],
      fiveHourAllowance: 200,
      weeklyAllowance: 1_000,
      weeklyWindow: "rolling",
      timezone: "UTC",
      resetWeekday: 1,
      resetHour: 0,
      resetMinute: 0,
      observationMaxAgeMinutes: 360,
    };
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex], [override]);
    try {
      // The pool has an allowance but no measurement, so the probe still runs.
      await quota.refreshFromProviders(now);
      expect(codex.calls).toBe(1);

      // And the percentages land scaled onto the units the operator declared.
      const status = pool(quota, "codex");
      expect(status.origin).toBe("manual");
      expect(status.fiveHour.unit).toBe("units");
      expect(status.fiveHour.used).toBe(114);
      expect(status.weekly.used).toBe(400);
      expect(status.fiveHour.confidence).toBe("authoritative");
    } finally {
      db.close();
    }
  });

  test("needsRefresh becomes true once the interval elapses", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      expect(quota.needsRefresh(now)).toBe(true);
      await quota.refreshFromProviders(now);
      expect(quota.needsRefresh(now)).toBe(false);
      expect(quota.needsRefresh(new Date(now.getTime() + 16 * 60_000))).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("provider unavailable", () => {
  test("reports unknown, invents no number, and blames no config file", async () => {
    const alerts: string[] = [];
    const claude = new StubProbe("claude", {
      status: "unavailable",
      reason: "codex app-server is not signed in",
    });
    const { quota, db } = await service([claude]);
    try {
      quota.setAlertSink(async (body) => void alerts.push(body));
      const reports = await quota.refreshFromProviders(now);
      expect(reports[0]).toMatchObject({ status: "unavailable" });
      expect(quota.probeError("claude")).toBe("codex app-server is not signed in");

      const status = quota.statuses(now).find((candidate) =>
        "configured" in candidate && candidate.provider === "claude"
      );
      if (status === undefined || !("configured" in status)) {
        throw new Error("expected an unknown-limits status for claude");
      }
      expect(status.confidence).toBe("missing");
      expect(status.probeError).toBe("codex app-server is not signed in");
      expect(status.recordedIsLocalEstimate).toBe(true);
      expect(status.reason).not.toContain("quota.toml");

      expect(alerts.some((alert) => alert.includes("could not read live quota"))).toBe(true);
      expect(alerts.every((alert) => !alert.includes("quota.toml"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("an unmeasured pool routes in compatibility mode instead of guessing", async () => {
    const { quota, db } = await service();
    try {
      const alerts: string[] = [];
      quota.setAlertSink(async (body) => void alerts.push(body));
      const decision = await quota.routeAndReserve({
        agentName: "sam",
        tier: "deep",
        preferredTool: "codex",
        candidates: [{ tool: "codex", model: "gpt-5.3-codex" }],
      });
      expect(decision.status).toMatchObject({
        configured: false,
        confidence: "missing",
      });
      expect(alerts[0]).toContain("headroom is unknown");
      expect(alerts[0]).not.toContain("quota.toml");
    } finally {
      db.close();
    }
  });

  test("a pool discovered but never measured reports unknown, not zero", async () => {
    const { quota, db } = await service();
    try {
      quota.ledger.upsertDiscoveredPool({
        provider: "codex",
        account: "default",
        pool: "codex",
        models: ["*"],
        label: null,
        fiveHourWindowMinutes: 300,
        weeklyWindowMinutes: 10_080,
        discoveredAt: now.toISOString(),
        source: "provider",
      });
      const status = pool(quota, "codex");
      expect(status.fiveHour.used).toBeNull();
      expect(status.fiveHour.remaining).toBeNull();
      expect(status.fiveHour.remainingPct).toBeNull();
      expect(status.fiveHour.allowance).toBeNull();
      expect(status.fiveHour.confidence).toBe("missing");
    } finally {
      db.close();
    }
  });
});

describe("claude usage probe", () => {
  test("maps get_usage onto a reported subscription pool", async () => {
    const probe = new ClaudeQuotaProbe(
      { readUsage: () => Promise.resolve(claudeUsage) },
      () => now,
    );
    const result = await probe.read();
    if (result.status !== "ok") throw new Error("expected a reading");
    const [subscription, scoped] = result.pools;
    expect(subscription?.pool).toBe("subscription");
    expect(subscription?.label).toBe("max");
    expect(subscription?.fiveHour?.usedPct).toBe(6);
    expect(subscription?.weekly?.usedPct).toBe(42);
    // `get_usage` is experimental, so its readings are reported, not gospel.
    expect(subscription?.confidence).toBe("reported");
    // A model-scoped weekly cap is recorded but never routed onto: the provider
    // gives a display name, not a concrete model id, and Hive will not guess.
    expect(scoped?.pool).toBe("weekly:Fable");
    expect(scoped?.models).toEqual([]);
    expect(scoped?.weekly?.usedPct).toBe(71);
  });

  test("an api-key account has no plan windows and says so", async () => {
    const probe = new ClaudeQuotaProbe({
      readUsage: () =>
        Promise.resolve({
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
        }),
    });
    const result = await probe.read();
    expect(result.status).toBe("unavailable");
  });

  test("a probe that throws degrades to unavailable, never to a number", async () => {
    const probe = new ClaudeQuotaProbe({
      readUsage: () => Promise.reject(new Error("claude closed before answering")),
    });
    const result = await probe.read();
    expect(result).toEqual({
      status: "unavailable",
      reason: "claude closed before answering",
    });
  });

  test("ignores a window the provider declined to quantify", () => {
    const pools = readingsFromClaudeUsage({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: null, resets_at: null },
      },
    }, "default", now.toISOString());
    expect(pools[0]?.fiveHour?.usedPct).toBe(10);
    expect(pools[0]?.weekly).toBeNull();
  });

  test("drops malformed and out-of-range usage instead of inventing headroom", () => {
    const partial = readingsFromClaudeUsage({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 101, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
      },
    }, "default", now.toISOString());
    expect(partial).toHaveLength(1);
    expect(partial[0]?.fiveHour).toBeNull();
    expect(partial[0]?.weekly?.usedPct).toBe(20);
    expect(readingsFromClaudeUsage({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { model_scoped: {} },
    } as unknown as ClaudeUsageResponse, "default", now.toISOString())).toEqual([]);
  });
});

async function codexPools(
  response: CodexRateLimitsResponse = codexResponse,
): Promise<QuotaProbeResult> {
  return new CodexQuotaProbe(
    { readRateLimits: () => Promise.resolve(response) },
    () => now,
  ).read();
}
