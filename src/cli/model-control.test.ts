import { describe, expect, test } from "bun:test";
import { buildModelControlSnapshot } from "./model-control";
import type { CapabilityDiscoveryResult } from "../daemon/capability-discovery";
import type { AccountBilling } from "../daemon/usage-credits";
import {
  known,
  unknown,
  type CapabilityProvider,
  type CapabilityRecord,
} from "../schemas/capability";
import type { QuotaStatus } from "../schemas";

/**
 * Positive controls for the Model Control Center read surface. Every negative
 * this snapshot can report (unknown effort, null quota, no billing) is proven
 * against a fake that also produces the positive — so an all-null result in
 * the app points at a real gap, not a misspelled key.
 */

const AT = "2026-07-12T22:00:00.000Z";

function record(overrides: Partial<CapabilityRecord>): CapabilityRecord {
  return {
    provider: "claude",
    accountFingerprint: "abc123",
    cliVersion: "2.1.207",
    canonicalId: "claude-opus-4-8",
    variant: null,
    launchToken: "claude-opus-4-8",
    aliases: [],
    displayName: "Opus 4.8",
    entitled: known(true, "claude.initialize", AT),
    hidden: unknown("surface-silent", "claude.initialize", AT),
    supportsEffort: known(true, "claude.initialize", AT),
    supportedEffortLevels: known(["low", "medium", "high"], "claude.initialize", AT),
    defaultEffort: unknown("field-absent", "claude.initialize", AT),
    observedAt: AT,
    ...overrides,
  };
}

const discovery: Record<CapabilityProvider, CapabilityDiscoveryResult> = {
  claude: {
    status: "ok",
    records: [record({})],
    effectiveDefault: {
      provider: "claude",
      model: known("claude-opus-4-8", "claude.initialize", AT),
      effort: unknown("surface-silent", "claude.initialize", AT),
    },
  },
  codex: { status: "unavailable", reason: "codex CLI not signed in" },
  grok: {
    status: "ok",
    records: [
      record({
        provider: "grok",
        canonicalId: "grok-composer-2.5-fast",
        launchToken: "grok-composer-2.5-fast",
        displayName: null,
        // The vendor STATED there is no effort axis. This must survive to the
        // app as known(false) — never merged into "unknown".
        supportsEffort: known(false, "grok.models_cache", AT),
        supportedEffortLevels: unknown("field-absent", "grok.models_cache", AT),
      }),
    ],
    effectiveDefault: {
      provider: "grok",
      model: known("grok-4.5", "grok.models", AT),
      effort: unknown("surface-silent", "grok.models", AT),
    },
  },
};

const billings: Record<CapabilityProvider, AccountBilling | null> = {
  claude: {
    creditsEnabled: known(false, "claude.get_usage", AT),
    disabledReason: null,
    generalUtilization: known(63, "claude.get_usage", AT),
    modelUtilization: {},
    overflowUncertainty: null,
  },
  codex: null,
  grok: null,
};

const claudePool: QuotaStatus = {
  provider: "claude",
  account: "default",
  pool: "plan",
  origin: "discovered",
  overridesDiscovered: false,
  models: ["*"],
  label: null,
  routable: true,
  confidence: "reported",
  freshness: "fresh",
  source: "provider",
  fiveHour: {
    unit: "percent",
    allowance: 100,
    used: 63,
    reserved: 0,
    reservedIsEstimate: true,
    remaining: 37,
    remainingPct: 0.37,
    resetsAt: AT,
    confidence: "reported",
    source: "provider",
    observedAt: AT,
    windowMinutes: 300,
  },
  weekly: {
    unit: "percent",
    allowance: null,
    used: null,
    reserved: 0,
    reservedIsEstimate: true,
    remaining: null,
    remainingPct: null,
    resetsAt: null,
    confidence: "missing",
    source: "none",
    observedAt: null,
    windowMinutes: null,
  },
};

function fakeDependencies(overrides: {
  daemonPort?: () => number | null;
  quota?: (port: number) => Promise<QuotaStatus[]>;
} = {}) {
  return {
    discover: (provider: CapabilityProvider) => Promise.resolve(discovery[provider]),
    readBilling: (provider: CapabilityProvider) => Promise.resolve(billings[provider]),
    daemonPort: overrides.daemonPort ?? (() => 4483),
    quota: overrides.quota ?? ((_port: number) => Promise.resolve([claudePool])),
    now: () => new Date(AT),
  };
}

describe("buildModelControlSnapshot", () => {
  test("passes three-valued effort through verbatim", async () => {
    const snapshot = await buildModelControlSnapshot(fakeDependencies());
    const grok = snapshot.providers.grok;
    if (grok.status !== "ok") throw new Error("grok discovery should be ok");
    // Positive control: the vendor's stated no-effort-axis fact survives.
    expect(grok.records[0]?.supportsEffort).toEqual(
      known(false, "grok.models_cache", AT),
    );
    // And the level list stays separately unknown with its measured reason.
    expect(grok.records[0]?.supportedEffortLevels).toEqual(
      unknown("field-absent", "grok.models_cache", AT),
    );
    const claude = snapshot.providers.claude;
    if (claude.status !== "ok") throw new Error("claude discovery should be ok");
    expect(claude.records[0]?.supportedEffortLevels).toEqual(
      known(["low", "medium", "high"], "claude.initialize", AT),
    );
  });

  test("carries a real percent reading and a null weekly window untouched", async () => {
    const snapshot = await buildModelControlSnapshot(fakeDependencies());
    expect(snapshot.quota).not.toBeNull();
    const pool = snapshot.quota?.[0];
    if (pool === undefined || !("origin" in pool)) throw new Error("expected a pool");
    expect(pool.fiveHour.used).toBe(63);
    // A never-observed window stays null. Null is unknown, not zero.
    expect(pool.weekly.used).toBeNull();
  });

  test("no daemon → quota is null with a reason, never an empty list", async () => {
    const snapshot = await buildModelControlSnapshot(
      fakeDependencies({ daemonPort: () => null }),
    );
    expect(snapshot.quota).toBeNull();
    expect(snapshot.quotaError).toContain("no daemon");
  });

  test("a quota fetch failure is reported, not swallowed into empty", async () => {
    const snapshot = await buildModelControlSnapshot(fakeDependencies({
      quota: () => Promise.reject(new Error("hive_quota_status failed")),
    }));
    expect(snapshot.quota).toBeNull();
    expect(snapshot.quotaError).toContain("hive_quota_status failed");
  });

  test("grok is marked meterless; metered vendors are marked metered", async () => {
    const snapshot = await buildModelControlSnapshot(fakeDependencies());
    expect(snapshot.usageSurfaces.grok).toBe("none");
    expect(snapshot.usageSurfaces.claude).toBe("metered");
    expect(snapshot.usageSurfaces.codex).toBe("metered");
  });

  test("an unavailable provider keeps its measured reason", async () => {
    const snapshot = await buildModelControlSnapshot(fakeDependencies());
    expect(snapshot.providers.codex).toEqual({
      status: "unavailable",
      reason: "codex CLI not signed in",
    });
  });

  test("a probe that throws becomes unavailable-with-reason, not a blank card", async () => {
    const snapshot = await buildModelControlSnapshot({
      ...fakeDependencies(),
      discover: (provider: CapabilityProvider) =>
        provider === "claude"
          ? Promise.reject(new Error("claude CLI timed out"))
          : Promise.resolve(discovery[provider]),
    });
    expect(snapshot.providers.claude).toEqual({
      status: "unavailable",
      reason: "claude CLI timed out",
    });
    // The other vendors are untouched by claude's bad morning.
    expect(snapshot.providers.grok.status).toBe("ok");
  });

  test("billing passes through, including honest nulls", async () => {
    const snapshot = await buildModelControlSnapshot(fakeDependencies());
    // Positive control first: a real reading survives...
    expect(snapshot.billing.claude?.creditsEnabled).toEqual(
      known(false, "claude.get_usage", AT),
    );
    // ...so these nulls are measured absences, not a bad key.
    expect(snapshot.billing.grok).toBeNull();
    expect(snapshot.billing.codex).toBeNull();
  });

  test("the snapshot serializes to JSON the app contract can decode", async () => {
    const snapshot = await buildModelControlSnapshot(fakeDependencies());
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(roundTripped.generatedAt).toBe(AT);
    expect(Object.keys(roundTripped.providers).sort()).toEqual(
      ["claude", "codex", "grok"],
    );
    expect(
      roundTripped.providers.grok.records[0].supportsEffort.state,
    ).toBe("known");
    expect(
      roundTripped.providers.grok.records[0].supportsEffort.value,
    ).toBe(false);
  });
});
