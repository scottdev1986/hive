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
  catalogFromClaudeModels,
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
      { readUsage: () => Promise.resolve({ usage: claudeUsage, catalog: [] }) },
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
    // A model-scoped weekly cap arrives with a display name and no model id, so
    // the probe leaves it unbound; the binding is made against the provider's own
    // model catalog when the pool is resolved, never guessed here.
    expect(scoped?.pool).toBe("weekly:Fable");
    expect(scoped?.models).toEqual([]);
    expect(scoped?.weekly?.usedPct).toBe(71);
  });

  test("an api-key account has no plan windows and says so", async () => {
    const probe = new ClaudeQuotaProbe({
      readUsage: () =>
        Promise.resolve({
          usage: {
            subscription_type: null,
            rate_limits_available: false,
            rate_limits: null,
          },
          catalog: [],
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
    { readRateLimits: () => Promise.resolve({ limits: response, catalog: [] }) },
    () => now,
  ).read();
}

/**
 * The incident these exist for: on 2026-07-11 the orchestrator put two deep-tier
 * agents on claude-fable-5 while the Fable weekly pool sat at 99%. The number was
 * measured, fresh, and provider-sourced — and it gated nothing, because the pool
 * that carried it was bound to no model at all. A number you measure but never
 * join to the decision is worth exactly as much as no number.
 */
describe("pools gate the models they actually meter", () => {
  // Verbatim shape of a claude 2.1.207 `initialize` models[] block.
  const claudeModels = [
    {
      value: "default",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Default (recommended)",
    },
    { value: "opus[1m]", resolvedModel: "claude-opus-4-8[1m]", displayName: "Opus" },
    {
      value: "claude-fable-5[1m]",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
    },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
  ];

  const exhaustedFable: ClaudeUsageResponse = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: "2026-07-10T19:00:00Z" },
      seven_day: { utilization: 61, resets_at: "2026-07-11T19:00:00Z" },
      // The provider names the model but gives no id: `scope.model.id` is null.
      model_scoped: [
        { display_name: "Fable", utilization: 99, resets_at: "2026-07-11T19:00:00Z" },
      ],
    },
  };

  const claudeProbe = (usage: ClaudeUsageResponse): QuotaProbe =>
    new ClaudeQuotaProbe(
      {
        readUsage: () =>
          Promise.resolve({
            usage,
            catalog: catalogFromClaudeModels(claudeModels),
          }),
      },
      () => now,
    );

  test("binds a metered pool to its models through the provider's own catalog", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    const fable = quota.resolvedLimits().find((limit) =>
      limit.pool === "weekly:Fable"
    );
    // Discovered, not hardcoded: "Fable" is joined to the concrete id the CLI
    // says it resolves to, and every name that model answers to is bound with it
    // so a pin cannot dodge the meter.
    expect(fable?.models).toEqual(["claude-fable-5", "claude-fable-5[1m]"]);
    expect(fable?.routable).toBe(true);
  });

  test("every id form of a model is bound to the same meter", () => {
    const catalog = catalogFromClaudeModels(claudeModels);
    const namesOf = (modelId: string) =>
      catalog.filter((entry) => entry.modelId === modelId)
        .map((entry) => entry.displayName).sort();
    // The 1M context upgrade is a plan property, not a different model, and an
    // alias is not a different model either. A pool named "Opus" must gate the
    // run whichever of its four names the spawn was pinned with.
    expect(namesOf("claude-opus-4-8")).toContain("Opus");
    expect(namesOf("claude-opus-4-8[1m]")).toContain("Opus");
    expect(namesOf("opus")).toContain("Opus");
    expect(namesOf("default")).toContain("Opus");
  });

  test("an exhausted model pool refuses the spawn and says which pool blocked it", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    const spawn = quota.routeAndReserve({
      agentName: "deep-worker",
      tier: "deep",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: [{ tool: "claude", model: "claude-fable-5" }],
    });
    // This is the whole point: the general pool has 39% of its week left, so the
    // old code admitted the spawn happily. The model's own pool has 1%.
    await expect(spawn).rejects.toThrow(/weekly:Fable/);
    await expect(spawn).rejects.toThrow(/resets/);
  });

  test("falls back to a model whose meters have room, and reports real numbers", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    const decision = await quota.routeAndReserve({
      agentName: "deep-worker",
      tier: "deep",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: [
        { tool: "claude", model: "claude-fable-5" },
        { tool: "claude", model: "claude-opus-4-8" },
      ],
    });
    expect(decision.model).toBe("claude-opus-4-8");
    const status = decision.status;
    if ("configured" in status) throw new Error("expected a measured pool");
    expect(status.pool).toBe("subscription");
    expect(status.weekly.used).toBe(61);
  });

  test("a model with no meter of its own is metered by the general pool, never 'unknown'", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    // Opus has no dedicated weekly cap and never did. Reporting it as an
    // unconfigured gap invented a pool that does not exist — and an
    // "unconstrained" model is the most attractive route there is, so the phantom
    // actively pulled traffic onto itself.
    // (Codex still reports a gap here, and should: this install probed only
    // Claude, so Hive has genuinely never read a Codex number. That is the honest
    // kind of unknown — it names a provider it cannot see, instead of inventing a
    // pool for a model it can.)
    const gaps = quota.statuses(now).filter((status) =>
      "configured" in status && status.provider === "claude"
    );
    expect(gaps).toEqual([]);
    const governing = quota.poolsGoverning(
      { tool: "claude", model: "claude-opus-4-8" },
      now,
    );
    expect(governing.map((pool) => pool.pool)).toEqual(["subscription"]);
    expect(governing[0]?.weekly.used).toBe(61);
    expect(governing[0]?.weekly.confidence).not.toBe("missing");
  });

  test("a capped model is gated by BOTH its own pool and the general one", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    const governing = quota.poolsGoverning(
      { tool: "claude", model: "claude-fable-5" },
      now,
    );
    expect(governing.map((pool) => pool.pool)).toEqual([
      "subscription",
      "weekly:Fable",
    ]);
  });

  test("account-wide statusLine numbers never land in a model's own pool", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    // The statusLine reports the *account's* windows. Filing them under the
    // running model would overwrite Fable's measured 99% with the account's 61%
    // and destroy the very reading the gate depends on.
    await quota.observeStatusline(
      { tool: "claude", model: "claude-fable-5" },
      {
        fiveHour: { usedPct: 12, resetsAt: null },
        sevenDay: { usedPct: 61, resetsAt: null },
        observedAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    );
    expect(pool(quota, "weekly:Fable").weekly.used).toBe(99);
    expect(pool(quota, "subscription").weekly.used).toBe(61);
  });

  test("a mid-session model switch re-keys the run onto the meters it truly spends", async () => {
    const { quota, db } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    await quota.routeAndReserve({
      agentName: "drifter",
      tier: "deep",
      preferredTool: "claude",
      explicitTool: "claude",
      candidates: [{ tool: "claude", model: "claude-opus-4-8" }],
    });
    // A human switches the session to Fable. The agent is already running, so the
    // booking must follow it onto the Fable cap even though that cap is full —
    // refusing would not stop the burn, it would only hide it.
    await quota.reconcileAgentModel("drifter", "claude-fable-5");
    const active = db.database.query(
      "SELECT pool, model FROM quota_reservations WHERE agentName = ? AND status = 'active' ORDER BY pool",
    ).all("drifter") as { pool: string; model: string }[];
    expect(active.map((row) => row.pool)).toEqual([
      "subscription",
      "weekly:Fable",
    ]);
    expect(active.every((row) => row.model === "claude-fable-5")).toBe(true);
  });
});

/**
 * Headroom is not eligibility. Codex sitting at 0% weekly outscores Claude at
 * 63% every time, so ranking on headroom alone silently promoted the emptiest
 * pool over the question of whether a route could produce a working agent at
 * all — and on 2026-07-11 deep-tier Codex could not: Hive's readiness probe
 * killed any Codex agent that thought before its first tool call. A gate that
 * refuses an exhausted model only to hand the work to a dead route has
 * protected nothing.
 */
describe("a route that cannot start is not a route", () => {
  const both = [
    { tool: "claude" as const, model: "claude-opus-4-8" },
    { tool: "codex" as const, model: "gpt-5.6-sol" },
  ];

  const generalPool = (
    provider: "claude" | "codex",
    pool: string,
    fivePct: number,
    weekPct: number,
  ) => ({
    provider,
    account: "default",
    pool,
    label: null,
    models: ["*"],
    fiveHour: { usedPct: fivePct, windowMinutes: 300, resetsAt: null },
    weekly: { usedPct: weekPct, windowMinutes: 10_080, resetsAt: null },
    observedAt: now.toISOString(),
    source: "provider" as const,
    confidence: "authoritative" as const,
  });

  // Both providers measured and roomy, with codex the emptier of the two — so on
  // headroom alone codex wins every time.
  const healthy = async () => {
    const made = await service([
      new StubProbe("claude", {
        status: "ok",
        pools: [generalPool("claude", "subscription", 10, 60)],
        catalog: [],
      }),
      new StubProbe("codex", {
        status: "ok",
        pools: [generalPool("codex", "codex", 0, 0)],
        catalog: [],
      }),
    ]);
    await made.quota.refreshFromProviders(now, { force: true });
    return made;
  };

  test("headroom alone would pick the route that cannot start", async () => {
    const { quota } = await healthy();
    const decision = await quota.routeAndReserve({
      agentName: "deep-worker",
      tier: "deep",
      preferredTool: "claude",
      candidates: both,
    });
    // Baseline: this is the hazard. The emptiest pool wins on score.
    expect(decision.tool).toBe("codex");
  });

  test("a launch that never proved life takes its route out of the running", async () => {
    const { quota } = await healthy();
    const first = await quota.routeAndReserve({
      agentName: "deep-worker",
      tier: "deep",
      preferredTool: "claude",
      candidates: both,
    });
    expect(first.tool).toBe("codex");
    // The agent never came up. failSpawn settles the reservation and says why.
    await quota.cancel(
      first.reservation.id,
      now.toISOString(),
      "no readiness signal within 15s",
    );

    const second = await quota.routeAndReserve({
      agentName: "deep-worker-2",
      tier: "deep",
      preferredTool: "claude",
      candidates: both,
    });
    // Codex still has all the headroom in the world. It is still not chosen.
    expect(second.tool).toBe("claude");
    expect(second.warnings.join(" ")).toContain("failed to start");
    expect(second.warnings.join(" ")).toContain("no readiness signal");
  });

  test("the guard stops guarding the moment the route works again", async () => {
    const { quota } = await healthy();
    const failed = await quota.routeAndReserve({
      agentName: "a",
      tier: "deep",
      preferredTool: "claude",
      candidates: both,
    });
    await quota.cancel(failed.reservation.id, now.toISOString(), "never started");
    expect(
      (await quota.routeAndReserve({
        agentName: "b",
        tier: "deep",
        preferredTool: "claude",
        candidates: both,
      })).tool,
    ).toBe("claude");

    // Someone fixes the underlying cause and a codex agent proves life. That is
    // the only evidence that matters, and it supersedes everything Hive
    // concluded from the failure — no operator action, no expiry to wait out.
    const pinned = await quota.routeAndReserve({
      agentName: "c",
      tier: "deep",
      preferredTool: "codex",
      explicitTool: "codex",
      candidates: [both[1]!],
    });
    quota.markStarted(pinned.reservation.id, now.toISOString());

    expect(
      (await quota.routeAndReserve({
        agentName: "d",
        tier: "deep",
        preferredTool: "claude",
        candidates: both,
      })).tool,
    ).toBe("codex");
  });

  test("an only candidate still launches, quarantined or not, and warns", async () => {
    const { quota } = await healthy();
    const failed = await quota.routeAndReserve({
      agentName: "a",
      tier: "deep",
      preferredTool: "codex",
      explicitTool: "codex",
      candidates: [both[1]!],
    });
    await quota.cancel(failed.reservation.id, now.toISOString(), "never started");

    // A human pinning the one model Hive is currently sulking about must still
    // get their agent. Refusing everything helps nobody; the cooldown is Hive's
    // own recent bad luck, which is a weaker fact than a human's explicit ask.
    const pinned = await quota.routeAndReserve({
      agentName: "b",
      tier: "deep",
      preferredTool: "codex",
      explicitTool: "codex",
      candidates: [both[1]!],
    });
    expect(pinned.tool).toBe("codex");
    expect(pinned.warnings.join(" ")).toContain("no alternative");
  });
});

describe("a refusal names the way out, and never takes it", () => {
  test("an exhausted pool's refusal reports unspent reset credits without spending one", async () => {
    const { quota } = await service([
      new StubProbe("codex", {
        status: "ok",
        pools: [{
          provider: "codex",
          account: "default",
          pool: "codex",
          label: "prolite",
          models: ["*"],
          fiveHour: { usedPct: 100, windowMinutes: 300, resetsAt: null },
          weekly: { usedPct: 100, windowMinutes: 10_080, resetsAt: null },
          observedAt: now.toISOString(),
          source: "provider",
          confidence: "authoritative",
        }],
        catalog: [],
        // The account is holding four unspent "Full reset" grants, readable in
        // the same free call as the limits.
        resetCredits: 4,
      }),
    ]);
    await quota.refreshFromProviders(now, { force: true });

    const spawn = quota.routeAndReserve({
      agentName: "worker",
      tier: "deep",
      preferredTool: "codex",
      explicitTool: "codex",
      candidates: [{ tool: "codex", model: "gpt-5.6-sol" }],
    });
    // The human is told the door exists. Hive does not open it: burning a finite
    // credit to admit a spawn is the human's call, and an agent that can quietly
    // spend the user's scarce resources to get its own way is a bad agent —
    // looking helpful while doing it is exactly what makes it dangerous. There is
    // no call to account/rateLimitResetCredit/consume anywhere in Hive.
    await expect(spawn).rejects.toThrow(/4 unspent usage-limit reset credits/);
    await expect(spawn).rejects.toThrow(/will not spend one on its own/);
  });
});

describe("a spend belongs to the vendor whose model produced it", () => {
  test("the ledger refuses to bill a Claude model to the Codex meter", async () => {
    const { db } = await service();
    const ledger = new QuotaLedger(db);
    const reserve = () =>
      ledger.tryReserveGroup([{
        id: "r1",
        agentName: "oscar",
        provider: "codex",
        account: "default",
        pool: "codex",
        // Exactly the row sitting in the live ledger: tier routing picked
        // tool=codex while the caller had pinned a Claude model, and the ledger
        // recorded the impossible pair without ever asking whether it could exist.
        model: "claude-opus-4-8",
        tier: "standard",
        estimatedUnits: 4,
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        fiveHourStart: now.toISOString(),
        weeklyStart: now.toISOString(),
        supplementalFiveHourUsed: 0,
        supplementalWeeklyUsed: 0,
        fiveHourAllowance: 100,
        weeklyAllowance: 100,
        fiveHourFloor: 0,
        weeklyFloor: 0,
      }]);
    expect(reserve).toThrow(/Refusing to bill claude model/);
  });

  test("a model whose vendor cannot be placed is recorded, not guessed at", async () => {
    const { db } = await service();
    const ledger = new QuotaLedger(db);
    // `default` is a real Codex alias, and an unrecognised name may simply be
    // new. Only a *provable* contradiction is an impossible fact; Hive does not
    // get to guess which meter an unfamiliar model's spend belongs to.
    const result = ledger.tryReserveGroup([{
      id: "r2",
      agentName: "worker",
      provider: "codex",
      account: "default",
      pool: "codex",
      model: "default",
      tier: "standard",
      estimatedUnits: 4,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      fiveHourStart: now.toISOString(),
      weeklyStart: now.toISOString(),
      supplementalFiveHourUsed: 0,
      supplementalWeeklyUsed: 0,
      fiveHourAllowance: 100,
      weeklyAllowance: 100,
      fiveHourFloor: 0,
      weeklyFloor: 0,
    }]);
    expect(result.ok).toBe(true);
  });
});
