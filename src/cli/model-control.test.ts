import { describe, expect, test } from "bun:test";
import { buildModelControlSnapshot } from "./model-control";
import {
  known,
  unknown,
  type CapabilityProvider,
} from "../schemas/capability";
import {
  buildModelControlSnapshotFixture,
  MODEL_CONTROL_SNAPSHOT_FIXTURE,
  modelControlSnapshotFixtureDependencies,
} from "../../scripts/test-fixtures/model-control-snapshot";

/**
 * Positive controls for the Model Control Center read surface. Every negative
 * this snapshot can report (unknown effort, null quota, no billing) is proven
 * against a fake that also produces the positive — so an all-null result in
 * the app points at a real gap, not a misspelled key.
 */

const AT = "2026-07-12T22:00:00.000Z";

describe("buildModelControlSnapshot", () => {
  test("passes three-valued effort through verbatim", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies(),
    );
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
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies(),
    );
    expect(snapshot.quota).not.toBeNull();
    const pool = snapshot.quota?.[0];
    if (pool === undefined || !("origin" in pool)) throw new Error("expected a pool");
    expect(pool.fiveHour.used).toBe(63);
    // A never-observed window stays null. Null is unknown, not zero.
    expect(pool.weekly.used).toBeNull();
  });

  test("no daemon → quota is null with a reason, never an empty list", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies({ daemonPort: () => null }),
    );
    expect(snapshot.quota).toBeNull();
    expect(snapshot.quotaError).toContain("no daemon");
  });

  test("a quota fetch failure is reported, not swallowed into empty", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies({
        quota: () => Promise.reject(new Error("hive_quota_status failed")),
      }),
    );
    expect(snapshot.quota).toBeNull();
    expect(snapshot.quotaError).toContain("hive_quota_status failed");
  });

  test("session token totals pass through without being inferred from quota", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies({
        tokenUsage: async () => ({
          generatedAt: AT,
          currentSessionId: null,
          sessions: [],
          attribution: "control-lower-bound",
        }),
      }),
    );
    expect(snapshot.tokenUsage?.attribution).toBe("control-lower-bound");
    expect(snapshot.tokenUsageError).toBeNull();
  });

  test("a token collector failure is unknown, never an empty measured session", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies({
        tokenUsage: async () => { throw new Error("token artifact unreadable"); },
      }),
    );
    expect(snapshot.tokenUsage).toBeNull();
    expect(snapshot.tokenUsageError).toContain("token artifact unreadable");
  });

  test("every known vendor is marked metered once its capacity surface is wired", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies(),
    );
    expect(snapshot.usageSurfaces.grok).toBe("metered");
    expect(snapshot.usageSurfaces.claude).toBe("metered");
    expect(snapshot.usageSurfaces.codex).toBe("metered");
  });

  test("an unavailable provider keeps its measured reason", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies(),
    );
    expect(snapshot.providers.codex).toEqual({
      status: "unavailable",
      reason: "codex CLI not signed in",
    });
  });

  test("a probe that throws becomes unavailable-with-reason, not a blank card", async () => {
    const dependencies = modelControlSnapshotFixtureDependencies();
    const discover = dependencies.discover;
    if (discover === undefined) throw new Error("fixture discover dependency is missing");
    const snapshot = await buildModelControlSnapshot({
      ...dependencies,
      discover: (provider: CapabilityProvider) =>
        provider === "claude"
          ? Promise.reject(new Error("claude CLI timed out"))
          : discover(provider),
    });
    expect(snapshot.providers.claude).toEqual({
      status: "unavailable",
      reason: "claude CLI timed out",
    });
    // The other vendors are untouched by claude's bad morning.
    expect(snapshot.providers.grok.status).toBe("ok");
  });

  test("billing passes through, including honest nulls", async () => {
    const snapshot = await buildModelControlSnapshot(
      modelControlSnapshotFixtureDependencies(),
    );
    // Positive control first: a real reading survives...
    expect(snapshot.billing.claude?.creditsEnabled).toEqual(
      known(false, "claude.get_usage", AT),
    );
    // ...so these nulls are measured absences, not a bad key.
    expect(snapshot.billing.grok).toBeNull();
    expect(snapshot.billing.codex).toBeNull();
  });

  test("the producer matches the checked-in app contract", async () => {
    const snapshot = await buildModelControlSnapshotFixture();
    const contract = await Bun.file(MODEL_CONTROL_SNAPSHOT_FIXTURE).json();
    expect(snapshot).toEqual(contract);
    expect(contract.generatedAt).toBe(AT);
    expect(Object.keys(contract.providers).sort()).toEqual(
      ["claude", "codex", "grok"],
    );
    expect(
      contract.providers.grok.records[0].supportsEffort.state,
    ).toBe("known");
    expect(
      contract.providers.grok.records[0].supportsEffort.value,
    ).toBe(false);
    expect(contract.usageSurfaces.grok).toBe("metered");
    expect(contract.quota[0].fiveHour.used).toBe(63);
  });
});
