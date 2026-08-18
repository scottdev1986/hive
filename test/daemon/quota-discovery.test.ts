import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { type CapabilityRecord, known } from "../../src/schemas/capability";
import {
  QuotaConfigSchema,
  type QuotaLimit,
  type QuotaPoolStatus,
} from "../../src/schemas/quota";
import { QuotaLedger } from "../../src/usage-service/quota-ledger";
import {
  drainedWindowFor,
  measured,
} from "../../src/usage-service/quota-pool-status";
import { resolvedLimits } from "../../src/usage-service/quota-pools";
import {
  ClaudeQuotaProbe,
  type ClaudeUsageResponse,
  CodexQuotaProbe,
  type CodexRateLimitsResponse,
  catalogFromClaudeModels,
  catalogFromGrokInitialize,
  type GrokBillingResponse,
  GrokQuotaProbe,
  KimiQuotaProbe,
  orderRateLimitWindows,
  type QuotaProbe,
  type QuotaProbeResult,
  readingsFromClaudeUsage,
  readingsFromCodexResponse,
  readingsFromGrokBilling,
  readingsFromKimiUsages,
} from "../../src/usage-service/quota-sources";
import { QuotaService } from "../../src/usage-service/usage-quota";
import { required } from "../required";
import { authorizeForQuotaTest } from "./authorized-launch.test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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
      secondary: {
        usedPercent: 12,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    },
  },
};

const claudeUsage: ClaudeUsageResponse = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: {
      utilization: 6,
      resets_at: "2026-07-10T19:00:00.000000+00:00",
    },
    seven_day: {
      utilization: 42,
      resets_at: "2026-07-11T19:00:00.000000+00:00",
    },
    model_scoped: [
      {
        display_name: "Fable",
        utilization: 71,
        resets_at: "2026-07-11T19:00:00Z",
      },
    ],
  },
};

class StubProbe implements QuotaProbe {
  calls = 0;
  constructor(
    readonly provider: "claude" | "codex" | "grok",
    private readonly result: QuotaProbeResult,
  ) {}
  read(): Promise<QuotaProbeResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

function claudeWindowProbe(
  fiveHourUsed: number,
  fiveHourResetAt: Date,
  weeklyResetAt: Date,
): StubProbe {
  return new StubProbe("claude", {
    status: "ok",
    pools: readingsFromClaudeUsage(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: fiveHourUsed,
            resets_at: fiveHourResetAt.toISOString(),
          },
          seven_day: {
            utilization: 40,
            resets_at: weeklyResetAt.toISOString(),
          },
        },
      },
      "default",
      now.toISOString(),
    ),
    catalog: [],
  });
}

async function service(
  probes: QuotaProbe[] = [],
  limits: QuotaLimit[] = [],
  clock: () => Date = () => now,
): Promise<{ quota: QuotaService; db: HiveDatabase; ledger: QuotaLedger }> {
  const root = await mkdtemp(join(tmpdir(), "hive-quota-discovery-"));
  roots.push(root);
  const db = new HiveDatabase(join(root, "hive.db"));
  const ledger = new QuotaLedger(db);
  ledger.replaceModelCatalog(
    "claude",
    ["claude-fable-5", "claude-opus-4-8"].map((model) => ({
      provider: "claude" as const,
      modelId: model,
      displayName: model,
      discoveredAt: now.toISOString(),
    })),
  );
  ledger.replaceModelCatalog(
    "codex",
    ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.6-sol"].map((model) => ({
      provider: "codex" as const,
      modelId: model,
      displayName: model,
      discoveredAt: now.toISOString(),
    })),
  );
  ledger.replaceModelCatalog("grok", [
    {
      provider: "grok",
      modelId: "grok-4.5",
      displayName: "grok-4.5",
      discoveredAt: now.toISOString(),
    },
  ]);
  const quota = new QuotaService(
    ledger,
    QuotaConfigSchema.parse({ limits }),
    clock,
    probes,
  );
  return { quota, db, ledger };
}

test("a billing probe without a catalog preserves launch-catalog evidence", async () => {
  const probe = new StubProbe("codex", {
    status: "ok",
    pools: [],
    catalog: [],
  });
  const { quota, db, ledger } = await service([probe]);
  try {
    expect(ledger.modelVendorFromCatalog("gpt-5.3-codex")).toEqual({
      state: "claimed",
      provider: "codex",
    });
    await quota.refreshFromProviders(now, { force: true });
    expect(ledger.modelVendorFromCatalog("gpt-5.3-codex")).toEqual({
      state: "claimed",
      provider: "codex",
    });
  } finally {
    db.close();
  }
});

const pool = (quota: QuotaService, name: string, at = now): QuotaPoolStatus => {
  const status = quota
    .statuses(at)
    .find(
      (candidate) => !("configured" in candidate) && candidate.pool === name,
    );
  if (status === undefined || "configured" in status) {
    throw new Error(`expected a discovered pool named ${name}`);
  }
  return status;
};

// The parse is pinned against BYTES, not against a struct we typed by hand. A
// fixture we hand-author agrees with whatever keys the code happens to read, so
// it would keep passing after the vendor renamed one and every window went null.
// This payload is the verbatim `_x.ai/billing` result from grok 0.2.99 on a
// SuperGrok account, captured off the wire on 2026-07-13 (session-free ACP
// probe: initialize → initialized → `_x.ai/billing` {}).
describe("the real Grok payload, verbatim off the wire", () => {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/grok-billing-supergrok.json"),
      "utf8",
    ),
  ) as GrokBillingResponse;

  // Positive control: creditUsagePercent is the one gauge the weekly meter
  // reads. If it is renamed, this assertion fails instead of the meter
  // silently reporting null as "vendor is quiet".
  test("reads creditUsagePercent as the weekly used percent", () => {
    const [routable] = readingsFromGrokBilling(
      raw,
      "default",
      now.toISOString(),
    );
    expect(raw.config?.creditUsagePercent).toBe(2.0);
    expect(routable?.weekly?.usedPct).toBe(2.0);
    expect(routable?.weekly?.resetsAt).toBe("2026-07-19T17:18:56.768Z");
    expect(routable?.weekly?.windowMinutes).toBe(10_080);
    expect(routable?.label).toBe("SuperGrok");
    expect(routable?.models).toEqual(["*"]);
    expect(routable?.weeklyMeterState).toBe("metered");
  });

  test("reports five-hour as not-metered — the wire has no five-hour window", () => {
    const [routable] = readingsFromGrokBilling(
      raw,
      "default",
      now.toISOString(),
    );
    expect(routable?.fiveHour).toBeNull();
    expect(routable?.fiveHourMeterState).toBe("not-metered");
  });

  test("never maps money-rail zeros onto remaining quota", () => {
    // onDemandCap/Used/prepaidBalance are all 0 on this account. That is
    // paid-overflow-off, not "0% used" and not "empty tank".
    expect(raw.config?.onDemandCap?.val).toBe(0);
    expect(raw.config?.onDemandUsed?.val).toBe(0);
    expect(raw.config?.prepaidBalance?.val).toBe(0);
    const [routable] = readingsFromGrokBilling(
      raw,
      "default",
      now.toISOString(),
    );
    expect(routable?.weekly?.usedPct).toBe(2.0);
    expect(routable?.weekly?.usedPct).not.toBe(0);
  });

  test("a misspelled gauge key does not invent a reading", () => {
    const broken = {
      ...raw,
      config: {
        ...raw.config,
        creditUsagePercent: undefined,
        // Deliberate wrong key.
        credit_usage_percent: 2.0,
      },
    } as GrokBillingResponse;
    const [routable] = readingsFromGrokBilling(
      broken,
      "default",
      now.toISOString(),
    );
    // The 2.0 under the wrong key is never read.
    expect(routable?.weekly?.usedPct).not.toBe(2.0);
    // It reads 0, not unknown: xAI omits `creditUsagePercent` when usage rounds
    // to zero, and its own client decodes that absence as 0%.
    //
    // KNOWN HAZARD, and this fixture is exactly it: a genuine RENAME of the
    // gauge is indistinguishable from rounded-to-zero on the wire, so this
    // decode would report an empty meter for an account that might be full. The
    // vendor's own TUI has the same blind spot. Only pinning the payload's key
    // set catches a rename; this decode cannot.
    expect(routable?.weekly?.usedPct).toBe(0);
    expect(routable?.weekly?.resetsAt).toBe("2026-07-19T17:18:56.768Z");
    expect(routable?.weeklyMeterState).toBe("metered");
    expect(routable?.fiveHourMeterState).toBe("not-metered");
  });

  test("a gauge that is PRESENT but unreadable stays unknown", () => {
    // The other half of the decode, and the reason absence and malformation
    // must not collapse: here the vendor tried to tell us something and we
    // could not parse it. Reading that as 0 would publish an empty meter for a
    // pool we failed to measure. The surface is still recognisable, so the pool
    // survives — with an unknown meter.
    for (const bad of [150, -1]) {
      const [routable] = readingsFromGrokBilling(
        {
          ...raw,
          config: { ...raw.config, creditUsagePercent: bad },
        } as GrokBillingResponse,
        "default",
        now.toISOString(),
      );
      expect(routable?.weekly?.usedPct ?? null).toBeNull();
      expect(routable?.weeklyMeterState).toBe("unknown");
    }
    // A value that is not a number at all fails the schema, and the whole
    // payload is refused rather than half-read. Either way the one thing that
    // must never happen is a confident 0.
    for (const bad of [Number.NaN, "42" as unknown as number]) {
      expect(
        readingsFromGrokBilling(
          {
            ...raw,
            config: { ...raw.config, creditUsagePercent: bad },
          } as GrokBillingResponse,
          "default",
          now.toISOString(),
        ),
      ).toEqual([]);
    }
  });

  test("an empty billing config is not a pool at 0%", () => {
    // Absence decoding to 0 must not turn a payload that says nothing into a
    // confident "0% used". The surface has to be recognisable first.
    expect(
      readingsFromGrokBilling(
        { config: {} } as GrokBillingResponse,
        "default",
        now.toISOString(),
      ),
    ).toEqual([]);
  });

  test("status surfaces the weekly gauge and not-metered five-hour", async () => {
    const grok = new StubProbe("grok", {
      status: "ok",
      pools: readingsFromGrokBilling(raw, "default", now.toISOString()),
      catalog: [],
    });
    const { quota, db } = await service([grok]);
    try {
      await quota.refreshFromProviders(now, { force: true });
      const status = pool(quota, "subscription");
      expect(status.provider).toBe("grok");
      expect(status.fiveHour.availability).toBe("not-metered");
      expect(status.fiveHour.used).toBeNull();
      expect(status.weekly.availability).toBe("available");
      expect(status.weekly.used).toBe(2.0);
      expect(status.weekly.resetsAt).toBe("2026-07-19T17:18:56.768Z");
    } finally {
      db.close();
    }
  });

  test("GrokQuotaProbe folds the wire payload into pools", async () => {
    const result = await new GrokQuotaProbe(
      {
        readBilling: () => Promise.resolve({ billing: raw, catalog: [] }),
      },
      () => now,
    ).read();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pools[0]?.weekly?.usedPct).toBe(2.0);
  });

  test("catalogFromGrokInitialize reads model ids from the free init frame", () => {
    const entries = catalogFromGrokInitialize({
      _meta: {
        modelState: {
          availableModels: [
            { modelId: "grok-4.5", name: "Grok 4.5" },
            { modelId: "grok-composer-2.5-fast", name: "Composer 2.5" },
          ],
        },
      },
    });
    expect(entries).toEqual([
      { provider: "grok", modelId: "grok-4.5", displayName: "Grok 4.5" },
      {
        provider: "grok",
        modelId: "grok-composer-2.5-fast",
        displayName: "Composer 2.5",
      },
    ]);
  });
});

// The parse is pinned against BYTES, not against a struct we typed by hand. A
// fixture we hand-author agrees with whatever keys the code happens to read, so
// it would keep passing after the vendor renamed one and every window went null.
// This payload is the verbatim `account/rateLimits/read` reply from codex-cli
// 0.144.1 on a `prolite` account, captured off the wire on 2026-07-13.
describe("the real Codex payload, verbatim off the wire", () => {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/codex-rate-limits-prolite.json"),
      "utf8",
    ),
  ) as CodexRateLimitsResponse;

  // Reading the weekly at all is the positive control: it proves this parser can
  // see a value the vendor really sent. Without it, the null five-hour below
  // would be indistinguishable from a misspelled key reading back as absent.
  test("reads the weekly window the vendor actually sent", () => {
    const [routable] = readingsFromCodexResponse(
      raw,
      "default",
      now.toISOString(),
    );
    expect(routable?.weekly?.usedPct).toBe(31);
    expect(routable?.weekly?.windowMinutes).toBe(10_080);
    expect(routable?.label).toBe("prolite");
  });

  // This plan meters ONE window. `secondary` is null on the wire and `primary`
  // carries the weekly bucket, so there is no five-hour reading to be had — and
  // Hive must not manufacture one. The UI's job is to not mount a meter for it
  // (MeterDerivation.usage), never to fill it with a guess.
  test("reports no five-hour window, because the payload has none", () => {
    const [routable] = readingsFromCodexResponse(
      raw,
      "default",
      now.toISOString(),
    );
    expect(raw.rateLimits.secondary).toBeNull();
    expect(routable?.fiveHour).toBeNull();
  });

  test("keeps the reading authoritative — an absent window is not a failed probe", () => {
    const [routable] = readingsFromCodexResponse(
      raw,
      "default",
      now.toISOString(),
    );
    expect(routable?.confidence).toBe("authoritative");
    expect(routable?.source).toBe("provider");
  });

  test("status carries no synthesized figures for the window this plan does not meter", async () => {
    const codex = new StubProbe("codex", {
      status: "ok",
      pools: readingsFromCodexResponse(raw, "default", now.toISOString()),
      catalog: [],
    });
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now, { force: true });
      const candidate = required(
        (
          await authorizeForQuotaTest([
            { tool: "codex", model: "gpt-5.3-codex" },
          ])
        )[0],
      );
      const spent = quota.reserveLaunch("spent", candidate, "complex_coding");
      await quota.reconcile(
        spent.id,
        undefined,
        "estimated",
        "2026-07-10T12:10:00.000Z",
      );
      quota.reserveLaunch("active", candidate, "complex_coding");

      expect(pool(quota, "codex").fiveHour).toEqual({
        availability: "not-metered",
        unit: "percent",
        allowance: null,
        used: null,
        reserved: null,
        reservedIsEstimate: null,
        remaining: null,
        remainingPct: null,
        resetsAt: null,
        confidence: "authoritative",
        source: "provider",
        observedAt: now.toISOString(),
        windowMinutes: null,
      });
    } finally {
      db.close();
    }
  });
});

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
      secondary: {
        usedPercent: 20,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly?.usedPct).toBe(20);
    expect(windows.weekly?.windowMinutes).toBe(10_080);
  });

  test("ignores a window whose used percentage is not a finite number", () => {
    const windows = orderRateLimitWindows({
      primary: {
        usedPercent: Number.NaN,
        windowDurationMins: 300,
        resetsAt: null,
      },
      secondary: {
        usedPercent: -1,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly).toBeNull();
  });

  test("rejects percentages outside the provider's 0-100 scale", () => {
    const windows = orderRateLimitWindows({
      primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: null },
      secondary: {
        usedPercent: 20,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly?.usedPct).toBe(20);
  });

  test("does not label two weekly-length windows as five-hour plus weekly", () => {
    const windows = orderRateLimitWindows({
      primary: {
        usedPercent: 10,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
      secondary: {
        usedPercent: 20,
        windowDurationMins: 20_160,
        resetsAt: null,
      },
    });
    expect(windows.fiveHour).toBeNull();
    expect(windows.weekly?.usedPct).toBe(20);
    expect(windows.weekly?.windowMinutes).toBe(20_160);
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
    expect(
      readingsFromCodexResponse(
        { rateLimits: null } as unknown as CodexRateLimitsResponse,
        "default",
        now.toISOString(),
      ),
    ).toEqual([]);
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

  test("books against the discovered pool", async () => {
    const codex = new StubProbe("codex", await codexPools());
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      const reservation = quota.reserveLaunch(
        "sam",
        required(
          (
            await authorizeForQuotaTest([
              { tool: "codex", model: "gpt-5.3-codex" },
            ])
          )[0],
        ),
        "complex_coding",
      );
      expect(reservation.pool).toBe("codex");
      // The deep tier's percent estimate debits each window differently.
      expect(reservation.estimatedUnits).toBe(8);
      expect(reservation.estimatedWeeklyUnits).toBe(1.5);

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

  test("a spawn the provider's own numbers say will not fit books anyway (§R3)", async () => {
    const exhausted: CodexRateLimitsResponse = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: null },
        secondary: {
          usedPercent: 40,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
      },
    };
    const codex = new StubProbe("codex", await codexPools(exhausted));
    const { quota, db } = await service([codex]);
    try {
      await quota.refreshFromProviders(now);
      // Usage never refuses a spawn: the booking lands, against the measured,
      // nearly-spent pool it came from.
      const reservation = quota.reserveLaunch(
        "sam",
        required(
          (
            await authorizeForQuotaTest([
              { tool: "codex", model: "gpt-5.3-codex" },
            ])
          )[0],
        ),
        "complex_coding",
      );
      expect(reservation.pool).toBe("codex");
      expect(quota.ledger.getActiveReservationForAgent("sam")).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("notification-driven quota updates", () => {
  test("stores an app-server reading when no pool is configured", async () => {
    const { quota, db } = await service();
    try {
      quota.applyDiscoveredReadings(
        readingsFromCodexResponse(codexResponse, "default", now.toISOString()),
      );

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
      quota.applyDiscoveredReadings(
        readingsFromCodexResponse(codexResponse, "default", now.toISOString()),
      );
      const later = new Date(now.getTime() + 60_000).toISOString();
      quota.applyDiscoveredReadings(
        readingsFromCodexResponse(
          {
            rateLimits: {
              limitId: "codex",
              primary: {
                usedPercent: 61,
                windowDurationMins: 300,
                resetsAt: null,
              },
              secondary: {
                usedPercent: 41,
                windowDurationMins: 10_080,
                resetsAt: null,
              },
            },
          },
          "default",
          later,
        ),
      );
      const status = pool(quota, "codex", new Date(now.getTime() + 60_000));
      expect(status.fiveHour.used).toBe(61);
      expect(status.fiveHour.observedAt).toBe(later);
    } finally {
      db.close();
    }
  });

  test("still maps percentages onto an user's declared units when overridden", async () => {
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
      quota.applyDiscoveredReadings(
        readingsFromCodexResponse(codexResponse, "default", now.toISOString()),
      );
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
      const reservation = quota.reserveLaunch(
        "sam",
        required(
          (
            await authorizeForQuotaTest([
              { tool: "codex", model: "gpt-5.3-codex" },
            ])
          )[0],
        ),
        "simple_coding",
      );
      const spentAt = new Date(now.getTime() + 60_000);
      quota.markStarted(reservation.id, spentAt.toISOString());
      await quota.reconcile(
        reservation.id,
        undefined,
        "estimated",
        spentAt.toISOString(),
      );

      // A newer five-hour-only provider observation arrives; weekly must keep
      // the earlier reading plus the reconcile debit.
      const laterAt = new Date(now.getTime() + 120_000);
      await quota.observe({
        provider: "codex",
        account: "default",
        pool: "codex",
        fiveHourUsed: 60,
        weeklyUsed: 40.75,
        observedAt: laterAt.toISOString(),
        fiveHourResetAt: null,
        weeklyResetAt: null,
        source: "provider",
        confidence: "reported",
        fiveHourObservedAt: laterAt.toISOString(),
        fiveHourSource: "provider",
        fiveHourConfidence: "reported",
      });

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
      const reservation = quota.reserveLaunch(
        "sam",
        required(
          (
            await authorizeForQuotaTest([
              { tool: "codex", model: "gpt-5.3-codex" },
            ])
          )[0],
        ),
        "simple_coding",
      );
      const at = new Date(now.getTime() + 60_000);
      await quota.reconcile(
        reservation.id,
        undefined,
        "estimated",
        at.toISOString(),
      );

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
      const reservation = quota.reserveLaunch(
        "sam",
        required(
          (
            await authorizeForQuotaTest([
              { tool: "codex", model: "gpt-5.3-codex" },
            ])
          )[0],
        ),
        "simple_coding",
      );
      const at = new Date(now.getTime() + 60_000);
      // The provider says the run really cost 2% of the five-hour window.
      await quota.reconcile(reservation.id, 2, "provider", at.toISOString());

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

  test("rolls a non-exhausted Claude window at its known reset", async () => {
    let clock = now;
    const resetAt = new Date(now.getTime() + 10 * 60_000);
    const nextResetAt = new Date(resetAt.getTime() + 5 * 60 * 60_000);
    const claude = claudeWindowProbe(
      61,
      resetAt,
      new Date(now.getTime() + 3 * 24 * 60 * 60_000),
    );
    const { quota, db } = await service([claude], [], () => clock);
    try {
      await quota.refreshFromProviders(clock);
      expect(pool(quota, "subscription", clock).fiveHour.used).toBe(61);

      clock = new Date(resetAt.getTime() + 1);
      expect(pool(quota, "subscription", clock).fiveHour).toMatchObject({
        availability: "available",
        used: 0,
        resetsAt: nextResetAt.toISOString(),
        confidence: "estimated",
        source: "ledger",
        observedAt: resetAt.toISOString(),
      });
    } finally {
      db.close();
    }
  });

  test("a known reset rolls the window while an unobserved pool stays unknown", async () => {
    let clock = now;
    const resetAt = new Date(now.getTime() + 10 * 60_000);
    const nextResetAt = new Date(resetAt.getTime() + 5 * 60 * 60_000);
    const weeklyResetAt = new Date(now.getTime() + 3 * 24 * 60 * 60_000);
    const claude = claudeWindowProbe(100, resetAt, weeklyResetAt);
    const { quota, db } = await service([claude], [], () => clock);
    const unobserved = await service([], [], () => clock);
    try {
      await quota.refreshFromProviders(clock);
      const candidate = required(
        (
          await authorizeForQuotaTest([
            { tool: "claude", model: "claude-fable-5" },
          ])
        )[0],
      );
      quota.reserveLaunch("reset-crossing", candidate, "simple_coding");

      unobserved.ledger.upsertDiscoveredPool({
        provider: "claude",
        account: "default",
        pool: "unobserved",
        models: ["*"],
        label: null,
        fiveHourWindowMinutes: 300,
        weeklyWindowMinutes: 10_080,
        fiveHourMeterState: "metered",
        weeklyMeterState: "metered",
        discoveredAt: now.toISOString(),
        source: "provider",
      });

      const before = pool(quota, "subscription", clock);
      const unobservedBefore = pool(unobserved.quota, "unobserved", clock);
      expect(before.fiveHour).toMatchObject({
        availability: "available",
        used: 100,
        reserved: 4,
        remaining: 0,
        resetsAt: resetAt.toISOString(),
      });
      expect(drainedWindowFor([before])).toEqual({
        pool: "subscription",
        window: "fiveHour",
        resetsAt: resetAt.toISOString(),
      });
      expect(measured(unobservedBefore)).toBeNull();

      clock = new Date(resetAt.getTime() + 1);
      const after = pool(quota, "subscription", clock);
      expect(after.fiveHour).toMatchObject({
        availability: "available",
        allowance: 100,
        used: 0,
        reserved: 0,
        remaining: 100,
        remainingPct: 1,
        resetsAt: nextResetAt.toISOString(),
        confidence: "estimated",
        source: "ledger",
        observedAt: resetAt.toISOString(),
      });
      expect(after.weekly.used).toBe(40);
      expect(after.weekly.reserved).toBe(0.75);
      expect(measured(after)).not.toBeNull();
      expect(drainedWindowFor([after])).toBeNull();
      const unobservedAfter = pool(unobserved.quota, "unobserved", clock);
      expect(unobservedAfter).toEqual(unobservedBefore);
      expect(measured(unobservedAfter)).toBeNull();

      const postReset = quota.reserveLaunch(
        "post-reset",
        candidate,
        "simple_coding",
      );
      const spentAt = new Date(clock.getTime() + 60_000);
      await quota.reconcile(postReset.id, 2, "provider", spentAt.toISOString());
      clock = spentAt;
      expect(pool(quota, "subscription", clock).fiveHour).toMatchObject({
        used: 2,
        reserved: 0,
        remaining: 98,
        confidence: "estimated",
        source: "ledger",
      });

      clock = new Date(resetAt.getTime() + 31 * 60_000);
      const decayed = pool(quota, "subscription", clock);
      expect(decayed.fiveHour).toMatchObject({
        availability: "unknown",
        used: null,
        reserved: 0,
        resetsAt: nextResetAt.toISOString(),
        confidence: "missing",
        source: "none",
        observedAt: null,
      });
      expect(measured(decayed)).toBeNull();

      const providerObservedAt = new Date(clock.getTime() + 60_000);
      await quota.observe({
        provider: "claude",
        account: "default",
        pool: "subscription",
        fiveHourUsed: 25,
        weeklyUsed: 41,
        observedAt: providerObservedAt.toISOString(),
        fiveHourResetAt: nextResetAt.toISOString(),
        weeklyResetAt: weeklyResetAt.toISOString(),
        source: "provider",
        confidence: "reported",
      });
      clock = providerObservedAt;
      expect(pool(quota, "subscription", clock).fiveHour).toMatchObject({
        used: 25,
        resetsAt: nextResetAt.toISOString(),
        confidence: "reported",
        source: "provider",
        observedAt: providerObservedAt.toISOString(),
      });
    } finally {
      db.close();
      unobserved.db.close();
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
      expect(reports).toEqual([
        { provider: "codex", status: "skipped", pools: 0 },
      ]);
      expect(codex.calls).toBe(1);

      // Startup always asks, however fresh the stored reading looks.
      await quota.refreshFromProviders(now, { force: true });
      expect(codex.calls).toBe(2);
    } finally {
      db.close();
    }
  });

  test("an operator click queues behind an older probe and overlapping clicks share the successor", async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const probe: QuotaProbe = {
      provider: "grok",
      read: async () => {
        calls += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return { status: "ok", pools: [], catalog: [] };
      },
    };
    let current = now;
    const { quota, db } = await service([probe], [], () => current);
    try {
      const periodic = quota.refreshFromProviders(current, { force: true });
      await Promise.resolve();
      expect(calls).toBe(1);

      const firstRequest = new Date(now.getTime() + 1_000);
      current = firstRequest;
      const firstClick = quota.refreshFromProviders(firstRequest, {
        force: true,
        trigger: "operator",
      });
      const secondRequest = new Date(now.getTime() + 2_000);
      current = secondRequest;
      const overlappingClick = quota.refreshFromProviders(secondRequest, {
        force: true,
        trigger: "operator",
      });
      await Promise.resolve();
      expect(calls).toBe(1);

      releases[0]?.();
      for (let index = 0; index < 10 && calls < 2; index += 1) {
        await Promise.resolve();
      }
      expect(calls).toBe(2);
      releases[1]?.();

      const [, firstReports, overlappingReports] = await Promise.all([
        periodic,
        firstClick,
        overlappingClick,
      ]);
      expect(calls).toBe(2);
      expect(firstReports[0]?.delivery).toBe("queued");
      expect(overlappingReports[0]?.delivery).toBe("coalesced");
      expect(
        Date.parse(firstReports[0]?.startedAt ?? ""),
      ).toBeGreaterThanOrEqual(firstRequest.getTime());
      expect(
        Date.parse(overlappingReports[0]?.startedAt ?? ""),
      ).toBeGreaterThanOrEqual(secondRequest.getTime());
    } finally {
      db.close();
    }
  });

  test("repeated operator refreshes report the five-second vendor-call limit", async () => {
    let current = now;
    let calls = 0;
    const probe: QuotaProbe = {
      provider: "grok",
      read: () => {
        calls += 1;
        return Promise.resolve({ status: "ok", pools: [], catalog: [] });
      },
    };
    const { quota, db } = await service([probe], [], () => current);
    try {
      const first = await quota.refreshFromProviders(current, {
        force: true,
        trigger: "operator",
      });
      expect(first[0]?.status).toBe("ok");
      expect(calls).toBe(1);

      current = new Date(now.getTime() + 1_000);
      const limited = await quota.refreshFromProviders(current, {
        force: true,
        trigger: "operator",
      });
      expect(limited).toEqual([
        {
          provider: "grok",
          status: "rate-limited",
          pools: 0,
          reason:
            "operator probes are limited to one vendor call every 5 seconds",
          completedAt: current.toISOString(),
          retryAt: new Date(now.getTime() + 5_000).toISOString(),
          delivery: "rate-limited",
        },
      ]);
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });

  test("a user override does not silently disable discovery", async () => {
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

      // And the percentages land scaled onto the units the user declared.
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
      expect(quota.needsRefresh(new Date(now.getTime() + 16 * 60_000))).toBe(
        true,
      );
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
      expect(quota.probeError("claude")).toBe(
        "codex app-server is not signed in",
      );

      const status = quota
        .statuses(now)
        .find(
          (candidate) =>
            "configured" in candidate && candidate.provider === "claude",
        );
      if (status === undefined || !("configured" in status)) {
        throw new Error("expected an unknown-limits status for claude");
      }
      expect(status.confidence).toBe("missing");
      expect(status.probeError).toBe("codex app-server is not signed in");
      expect(status.recordedIsLocalEstimate).toBe(true);
      expect(status.reason).not.toContain("quota.toml");

      expect(
        alerts.some((alert) => alert.includes("could not read live quota")),
      ).toBe(true);
      expect(alerts.every((alert) => !alert.includes("quota.toml"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("an unmeasured pool is the normal case: routed and booked, no special mode", async () => {
    const { quota, db } = await service();
    try {
      const alerts: string[] = [];
      quota.setAlertSink(async (body) => void alerts.push(body));
      const reservation = quota.reserveLaunch(
        "sam",
        required(
          (
            await authorizeForQuotaTest([
              { tool: "codex", model: "gpt-5.3-codex" },
            ])
          )[0],
        ),
        "complex_coding",
      );
      expect(reservation.pool).toBe("unconfigured:gpt-5.3-codex");
      expect(quota.ledger.getActiveReservationForAgent("sam")).not.toBeNull();
      // An ordinary unmetered route is not an anomaly: nothing alerts for it.
      expect(alerts).toHaveLength(0);
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
        fiveHourMeterState: "metered",
        weeklyMeterState: "metered",
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
      readUsage: () =>
        Promise.reject(new Error("claude closed before answering")),
    });
    const result = await probe.read();
    expect(result).toEqual({
      status: "unavailable",
      reason: "claude closed before answering",
    });
  });

  test("ignores a window the provider declined to quantify", () => {
    const pools = readingsFromClaudeUsage(
      {
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: null, resets_at: null },
        },
      },
      "default",
      now.toISOString(),
    );
    expect(pools[0]?.fiveHour?.usedPct).toBe(10);
    expect(pools[0]?.weekly).toBeNull();
  });

  test("a partial read preserves a known meter instead of asserting absence", async () => {
    let pools = readingsFromClaudeUsage(
      claudeUsage,
      "default",
      now.toISOString(),
    );
    const probe: QuotaProbe = {
      provider: "claude",
      read: async () => ({ status: "ok", pools, catalog: [] }),
    };
    const { quota, db } = await service([probe]);
    try {
      await quota.refreshFromProviders(now, { force: true });
      const later = new Date(now.getTime() + 60_000);
      pools = readingsFromClaudeUsage(
        {
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 43, resets_at: null },
          },
        },
        "default",
        later.toISOString(),
      );
      await quota.refreshFromProviders(later, { force: true });

      const limit = resolvedLimits(quota.ledger, quota.config).find(
        (candidate) =>
          candidate.provider === "claude" && candidate.pool === "subscription",
      );
      expect(limit?.fiveHourMeterState).toBe("unknown");
      expect(limit?.fiveHourWindowMinutes).toBe(300);
      expect(pool(quota, "subscription", later).fiveHour.availability).not.toBe(
        "not-metered",
      );
    } finally {
      db.close();
    }
  });

  test("drops malformed and out-of-range usage instead of inventing headroom", () => {
    const partial = readingsFromClaudeUsage(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 101, resets_at: null },
          seven_day: { utilization: 20, resets_at: null },
        },
      },
      "default",
      now.toISOString(),
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]?.fiveHour).toBeNull();
    expect(partial[0]?.weekly?.usedPct).toBe(20);
    expect(
      readingsFromClaudeUsage(
        {
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: { model_scoped: {} },
        } as unknown as ClaudeUsageResponse,
        "default",
        now.toISOString(),
      ),
    ).toEqual([]);
  });
});

async function codexPools(
  response: CodexRateLimitsResponse = codexResponse,
): Promise<QuotaProbeResult> {
  return new CodexQuotaProbe(
    {
      readRateLimits: () => Promise.resolve({ limits: response, catalog: [] }),
    },
    () => now,
  ).read();
}

/**
 * A pool bound to no model gates nothing. A measured, fresh, provider-sourced
 * 99% on the Fable weekly cap still lets the orchestrator route deep-tier
 * agents onto claude-fable-5 if that reading is never joined to a model id — a
 * number you measure but never join to the decision is worth exactly as much
 * as no number. These tests hold the join.
 */
describe("pools gate the models they actually meter", () => {
  // Verbatim shape of a claude 2.1.207 `initialize` models[] block.
  const claudeModels = [
    {
      value: "default",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Default (recommended)",
    },
    {
      value: "opus[1m]",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Opus",
    },
    {
      value: "claude-fable-5[1m]",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
    },
  ];

  const exhaustedFable: ClaudeUsageResponse = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: "2026-07-10T19:00:00Z" },
      seven_day: { utilization: 61, resets_at: "2026-07-11T19:00:00Z" },
      // The provider names the model but gives no id: `scope.model.id` is null.
      model_scoped: [
        {
          display_name: "Fable",
          utilization: 99,
          resets_at: "2026-07-11T19:00:00Z",
        },
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
    const fable = resolvedLimits(quota.ledger, quota.config).find(
      (limit) => limit.pool === "weekly:Fable",
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
      catalog
        .filter((entry) => entry.modelId === modelId)
        .map((entry) => entry.displayName)
        .sort();
    // The 1M context upgrade is a plan property, not a different model, and an
    // alias is not a different model either. A pool named "Opus" must gate the
    // run whichever of its four names the spawn was pinned with.
    expect(namesOf("claude-opus-4-8")).toContain("Opus");
    expect(namesOf("claude-opus-4-8[1m]")).toContain("Opus");
    expect(namesOf("opus")).toContain("Opus");
    expect(namesOf("default")).toContain("Opus");
  });

  test("an exhausted model pool still books, against every pool that meters it (§R3)", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    const reservation = quota.reserveLaunch(
      "deep-worker",
      required(
        (
          await authorizeForQuotaTest([
            { tool: "claude", model: "claude-fable-5" },
          ])
        )[0],
      ),
      "complex_coding",
    );
    expect(reservation.model).toBe("claude-fable-5");
    // The booking still lands on the pool that will drain mid-work — that is
    // the drain handler's input, not a refusal's.
    expect(
      quota.ledger
        .activeReservations()
        .filter((row) => row.agentName === "deep-worker")
        .map((row) => row.pool)
        .sort(),
    ).toEqual(["subscription", "weekly:Fable"]);
    expect(
      quota.drainFor({ tool: "claude", model: "claude-fable-5" })?.pool,
    ).toBe("weekly:Fable");
  });

  test("a model with no meter of its own is metered by the general pool, never 'unknown'", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    // Opus has no dedicated weekly cap. Reporting that as an unconfigured gap
    // would invent a pool that does not exist — and an "unconstrained" model is
    // the most attractive route there is, so the phantom would pull traffic
    // onto itself.
    // (Codex does report a gap here, and should: this install probed only
    // Claude, so Hive has genuinely never read a Codex number. That is the honest
    // kind of unknown — it names a provider it cannot see, instead of inventing a
    // pool for a model it can.)
    const gaps = quota
      .statuses(now)
      .filter(
        (status) => "configured" in status && status.provider === "claude",
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

  test("account-wide provider readings never land in a model's own pool", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    // Account-wide windows belong to the subscription pool. Writing them under
    // the running model would overwrite Fable's measured 99% with the
    // account's 61% and destroy the reading the gate depends on.
    const at = new Date(now.getTime() + 60_000).toISOString();
    await quota.observe({
      provider: "claude",
      account: "default",
      pool: "subscription",
      fiveHourUsed: 12,
      weeklyUsed: 61,
      observedAt: at,
      fiveHourResetAt: null,
      weeklyResetAt: null,
      source: "provider",
      confidence: "reported",
      fiveHourObservedAt: at,
      fiveHourSource: "provider",
      fiveHourConfidence: "reported",
      weeklyObservedAt: at,
      weeklySource: "provider",
      weeklyConfidence: "reported",
    });
    expect(pool(quota, "weekly:Fable").weekly.used).toBe(99);
    expect(pool(quota, "subscription").weekly.used).toBe(61);
  });

  test("a mid-session model switch re-keys the run onto the meters it truly spends", async () => {
    const { quota, db } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    quota.reserveLaunch(
      "drifter",
      required(
        (
          await authorizeForQuotaTest([
            { tool: "claude", model: "claude-opus-4-8" },
          ])
        )[0],
      ),
      "complex_coding",
    );
    // A user switches the session to Fable. The agent is already running, so the
    // booking must follow it onto the Fable cap even though that cap is full —
    // refusing would not stop the burn, it would only hide it.
    await quota.reconcileAgentModel("drifter", "claude-fable-5");
    const active = db.database
      .query(
        "SELECT pool, model FROM quota_reservations WHERE agentName = ? AND status = 'active' ORDER BY pool",
      )
      .all("drifter") as { pool: string; model: string }[];
    expect(active.map((row) => row.pool)).toEqual([
      "subscription",
      "weekly:Fable",
    ]);
    expect(active.every((row) => row.model === "claude-fable-5")).toBe(true);
  });

  test("a capability-catalog overwrite still meters every id form of the model", async () => {
    const { quota } = await service([claudeProbe(exhaustedFable)]);
    await quota.refreshFromProviders(now, { force: true });
    const at = now.toISOString();
    const surface = "claude.initialize" as const;
    const record: CapabilityRecord = {
      provider: "claude",
      accountFingerprint: "account",
      cliVersion: "2.1.207",
      canonicalId: "claude-fable-5",
      variant: "1m",
      launchToken: "claude-fable-5",
      displayName: "Fable",
      aliases: ["fable"],
      entitled: known(true, surface, at),
      hidden: known(false, surface, at),
      supportsEffort: known(false, surface, at),
      supportedEffortLevels: known([], surface, at),
      defaultEffort: known("medium", surface, at),
      observedAt: at,
    };
    quota.replaceCapabilityCatalog("claude", [record]);
    expect(
      quota
        .poolsGoverning({ tool: "claude", model: "claude-fable-5[1m]" }, now)
        .map((item) => item.pool),
    ).toEqual(["subscription", "weekly:Fable"]);
  });

  test("a fresh general pool does not skip a still-unmeasured model cap", async () => {
    let calls = 0;
    let includeFable = false;
    const probe: QuotaProbe = {
      provider: "claude",
      read: async () => {
        calls += 1;
        return {
          status: "ok" as const,
          pools: readingsFromClaudeUsage(
            includeFable
              ? exhaustedFable
              : {
                  subscription_type: "max",
                  rate_limits_available: true,
                  rate_limits: {
                    five_hour: { utilization: 10, resets_at: null },
                    seven_day: { utilization: 20, resets_at: null },
                  },
                },
            "default",
            now.toISOString(),
          ),
          catalog: catalogFromClaudeModels(claudeModels),
        };
      },
    };
    const { quota, db } = await service([probe]);
    try {
      await quota.refreshFromProviders(now, { force: true });
      expect(calls).toBe(1);
      quota.ledger.upsertDiscoveredPool({
        provider: "claude",
        account: "default",
        pool: "weekly:Fable",
        models: [],
        label: "Fable",
        fiveHourWindowMinutes: null,
        weeklyWindowMinutes: 10_080,
        fiveHourMeterState: "not-metered",
        weeklyMeterState: "metered",
        discoveredAt: now.toISOString(),
        source: "provider",
      });
      includeFable = true;
      const reports = await quota.refreshFromProviders(now);
      expect(reports[0]?.status).toBe("ok");
      expect(calls).toBe(2);
    } finally {
      db.close();
    }
  });

  test("a stale discovered pool still books against itself, not unconfigured", async () => {
    let clock = now;
    const { quota, db } = await service(
      [claudeProbe(exhaustedFable)],
      [],
      () => clock,
    );
    try {
      await quota.refreshFromProviders(now, { force: true });
      clock = new Date(now.getTime() + 2 * 60 * 60_000);
      const reservation = quota.reserveLaunch(
        "sam",
        required(
          (
            await authorizeForQuotaTest([
              { tool: "claude", model: "claude-opus-4-8" },
            ])
          )[0],
        ),
        "simple_coding",
      );
      expect(reservation.pool).toBe("subscription");
    } finally {
      db.close();
    }
  });
});

/**
 * Launch cooldown: a route that never proved life is held back for a while,
 * and a proven start clears it at once. Ranking and passing over cooled-down
 * routes belongs to the router; what lives here is the record and the clock.
 */
const BOTH_ROUTES = await authorizeForQuotaTest([
  { tool: "claude" as const, model: "claude-opus-4-8" },
  { tool: "codex" as const, model: "gpt-5.6-sol" },
]);

describe("a route that cannot start is on cooldown", () => {
  const claudeRoute = required(BOTH_ROUTES[0]);
  const codexRoute = required(BOTH_ROUTES[1]);

  test("a launch that never proved life puts its route on cooldown", async () => {
    const { quota } = await service();
    const first = quota.reserveLaunch(
      "deep-worker",
      claudeRoute,
      "complex_coding",
    );
    // The agent never came up. failSpawn settles the reservation and says why.
    await quota.cancel(
      first.id,
      now.toISOString(),
      "no readiness signal within 15s",
    );

    const cooldown = quota.launchCooldown(claudeRoute);
    expect(cooldown).not.toBeNull();
    expect(cooldown?.reason).toContain("no readiness signal");
    // The other route carries no such evidence and stays clear.
    expect(quota.launchCooldown(codexRoute)).toBeNull();
  });

  test("reservation and launch cooldown are keyed by tool, model, and effort", async () => {
    const { quota } = await service();
    const xhigh = {
      tool: "codex" as const,
      model: "gpt-5.6-sol",
      effort: "xhigh",
    };
    const low = { tool: "codex" as const, model: "gpt-5.6-sol", effort: "low" };
    const failed = quota.reserveLaunch(
      "xhigh-run",
      required((await authorizeForQuotaTest([xhigh]))[0]),
      "complex_coding",
    );
    expect(failed).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
    await quota.cancel(failed.id, now.toISOString(), "model refused launch");

    expect(
      quota.ledger.routeHealth("codex", "gpt-5.6-sol", "xhigh")
        ?.consecutiveFailures,
    ).toBe(1);
    expect(quota.ledger.routeHealth("codex", "gpt-5.6-sol", "low")).toBeNull();
    expect(quota.launchCooldown(xhigh)).not.toBeNull();
    expect(quota.launchCooldown(low)).toBeNull();
  });

  test("the cooldown lifts the moment the route works again", async () => {
    const { quota } = await service();
    const failed = quota.reserveLaunch("a", codexRoute, "complex_coding");
    await quota.cancel(failed.id, now.toISOString(), "never started");
    expect(quota.launchCooldown(codexRoute)).not.toBeNull();

    // Someone fixes the underlying cause and a codex agent proves life. That is
    // the only evidence that matters, and it supersedes everything Hive
    // concluded from the failure — no user action, no expiry to wait out.
    const pinned = quota.reserveLaunch("b", codexRoute, "complex_coding");
    quota.markStarted(pinned.id, now.toISOString());
    expect(quota.launchCooldown(codexRoute)).toBeNull();
  });
});

describe("a spend belongs to the vendor whose model produced it", () => {
  test("the ledger refuses to bill a Claude model to the Codex meter", async () => {
    const { db } = await service();
    const ledger = new QuotaLedger(db);
    ledger.replaceModelCatalog("claude", [
      {
        provider: "claude",
        modelId: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        discoveredAt: now.toISOString(),
      },
    ]);
    const reserve = () =>
      ledger.reserveGroupUnchecked([
        {
          id: "r1",
          agentName: "oscar",
          provider: "codex",
          account: "default",
          pool: "codex",
          // The impossible pair tier routing can produce: tool=codex while the
          // caller pinned a Claude model. The ledger has to refuse it rather
          // than record a spend against a meter that cannot have produced it.
          model: "claude-opus-4-8",
          category: "simple_coding",
          estimatedUnits: 4,
          now: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      ]);
    expect(reserve).toThrow(/Refusing to bill claude model/);
  });

  test("spend attribution requires positive catalog evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-quota-catalog-evidence-"));
    roots.push(root);
    const db = new HiveDatabase(join(root, "hive.db"));
    const ledger = new QuotaLedger(db);
    let attempt = 0;
    const reserve = (model: string) =>
      ledger.reserveGroupUnchecked([
        {
          id: `catalog-evidence-${attempt++}`,
          agentName: "worker",
          provider: "codex",
          account: "default",
          pool: "codex",
          model,
          category: "simple_coding",
          estimatedUnits: 4,
          now: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      ]);

    expect(() => reserve("default")).toThrow(
      /positive vendor catalog evidence/,
    );
    expect(() => reserve("gpt-5-codex")).toThrow(
      /positive vendor catalog evidence/,
    );

    ledger.replaceModelCatalog("codex", [
      {
        provider: "codex",
        modelId: "gpt-5-codex",
        displayName: "GPT-5 Codex",
        discoveredAt: now.toISOString(),
      },
    ]);
    expect(reserve("gpt-5-codex").length).toBeGreaterThan(0);
  });
});

describe("kimi usage probe", () => {
  // The verified 2026-07-24 live response shape.
  const KIMI_USAGES = {
    user: { userId: "u", membership: { level: "LEVEL_ADVANCED" } },
    usage: {
      limit: "100",
      used: "40",
      remaining: "60",
      resetTime: "2026-07-29T21:38:00.343103Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "100",
          used: "1",
          remaining: "99",
          resetTime: "2026-07-24T18:38:00Z",
        },
      },
    ],
    parallel: { limit: "30" },
    authentication: { method: "METHOD_ACCESS_TOKEN", scope: "FEATURE_CODING" },
  };

  test("maps /usages onto a reported subscription pool with both windows", async () => {
    const probe = new KimiQuotaProbe(
      {
        readUsage: () =>
          Promise.resolve({ status: "ok", response: KIMI_USAGES }),
      },
      () => now,
    );
    const result = await probe.read();
    if (result.status !== "ok") throw new Error("expected a reading");
    expect(result.catalog).toEqual([]);
    expect(result.pools).toHaveLength(1);
    const [pool] = result.pools;
    expect(pool?.provider).toBe("kimi");
    expect(pool?.pool).toBe("subscription");
    // The vendor's own plan name, like Claude's subscription_type.
    expect(pool?.label).toBe("LEVEL_ADVANCED");
    expect(pool?.models).toEqual(["*"]);
    expect(pool?.fiveHour).toEqual({
      usedPct: 1,
      windowMinutes: 300,
      resetsAt: "2026-07-24T18:38:00.000Z",
    });
    expect(pool?.weekly).toEqual({
      usedPct: 40,
      windowMinutes: 7 * 24 * 60,
      resetsAt: "2026-07-29T21:38:00.343Z",
    });
    expect(pool?.fiveHourMeterState).toBe("metered");
    expect(pool?.weeklyMeterState).toBe("metered");
    expect(pool?.source).toBe("provider");
    // An undocumented endpoint: reported, never gospel.
    expect(pool?.confidence).toBe("reported");
  });

  test("the 300-minute rate window is five-hour wherever it sits in the array", () => {
    const pools = readingsFromKimiUsages(
      {
        usage: KIMI_USAGES.usage,
        limits: [
          {
            window: { duration: 3, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: "100", used: "90" },
          },
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "1" },
          },
        ],
      },
      "default",
      now.toISOString(),
    );
    expect(pools[0]?.fiveHour?.usedPct).toBe(1);
    expect(pools[0]?.fiveHour?.windowMinutes).toBe(300);
    // A window whose unit cannot be placed is dropped, never guessed.
    const unplaceable = readingsFromKimiUsages(
      {
        limits: [
          {
            window: { duration: 7, timeUnit: "TIME_UNIT_FORTNIGHT" },
            detail: { limit: "100", used: "50" },
          },
        ],
      },
      "default",
      now.toISOString(),
    );
    expect(unplaceable).toEqual([]);
  });

  test("does not label a non-300-minute rate window as five-hour", () => {
    const pools = readingsFromKimiUsages(
      {
        usage: KIMI_USAGES.usage,
        limits: [
          {
            window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "10" },
          },
        ],
      },
      "default",
      now.toISOString(),
    );
    expect(pools[0]?.fiveHour).toBeNull();
    expect(pools[0]?.fiveHourMeterState).toBe("unknown");
  });

  test("rejects percentages above 100 instead of publishing them", () => {
    const pools = readingsFromKimiUsages(
      {
        usage: { limit: "100", used: "101" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "-1" },
          },
        ],
      },
      "default",
      now.toISOString(),
    );
    expect(pools).toEqual([]);
  });

  test("a weekly-only payload keeps the weekly meter and says five-hour unknown", () => {
    const pools = readingsFromKimiUsages(
      { usage: KIMI_USAGES.usage },
      "default",
      now.toISOString(),
    );
    expect(pools[0]?.fiveHour).toBeNull();
    expect(pools[0]?.fiveHourMeterState).toBe("unknown");
    expect(pools[0]?.weekly?.usedPct).toBe(40);
    expect(pools[0]?.weeklyMeterState).toBe("metered");
  });

  test("a shape-changed payload is unavailable, never a confident zero", async () => {
    const probe = new KimiQuotaProbe({
      readUsage: () =>
        Promise.resolve({ status: "ok", response: { error: "changed" } }),
    });
    const result = await probe.read();
    expect(result).toEqual({
      status: "unavailable",
      reason: "kimi /usages returned no usable usage reading",
    });
    // Unparseable window numbers are not a reading either.
    const pools = readingsFromKimiUsages(
      {
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "zero", used: "1" },
          },
        ],
      },
      "default",
      now.toISOString(),
    );
    expect(pools).toEqual([]);
  });

  test("a quiet transport passes its reason through untouched", async () => {
    const probe = new KimiQuotaProbe({
      readUsage: () =>
        Promise.resolve({
          status: "unavailable",
          reason: "no readable kimi credential file",
        }),
    });
    const result = await probe.read();
    expect(result).toEqual({
      status: "unavailable",
      reason: "no readable kimi credential file",
    });
  });

  test("a rejected transport promise is normalized as unavailable", async () => {
    const probe = new KimiQuotaProbe({
      readUsage: () => Promise.reject(new Error("transport rejected")),
    });
    await expect(probe.read()).resolves.toEqual({
      status: "unavailable",
      reason: "transport rejected",
    });
  });
});
