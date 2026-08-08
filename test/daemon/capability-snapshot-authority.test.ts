import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ProviderCapabilitySnapshot } from "../../src/adapters/providers/protocol/types";
import {
  CapabilitySnapshotAuthority,
  CapabilitySnapshotStore,
} from "../../src/daemon/provider-capabilities/snapshot-authority";
import {
  type CapabilityRecord,
  known,
  unknown,
} from "../../src/schemas/capability";

const OLD = "2026-08-02T18:00:00.000Z";
const NOW = "2026-08-02T20:00:00.000Z";

function record(
  canonicalId: string,
  efforts: readonly string[],
  observedAt: string,
): CapabilityRecord {
  return {
    provider: "opencode",
    accountFingerprint: "opencode:fixture",
    cliVersion: "1.18.11",
    canonicalId,
    variant: null,
    launchToken: canonicalId,
    displayName: canonicalId,
    aliases: [],
    entitled: known(true, "opencode.models", observedAt),
    hidden: unknown("surface-silent", "opencode.models", observedAt),
    supportsEffort: unknown("surface-silent", "opencode.models", observedAt),
    supportedEffortLevels: known([...efforts], "opencode.models", observedAt),
    defaultEffort: unknown("surface-silent", "opencode.models", observedAt),
    observedAt,
  };
}

function snapshot(
  source: "probe" | "session",
  observedAt: string,
  records: CapabilityRecord[],
  measurements: ProviderCapabilitySnapshot["measurements"] = {},
): ProviderCapabilitySnapshot {
  return {
    provider: "opencode",
    source,
    observedAt,
    catalog: {
      status: "ok",
      records,
      effectiveDefault: {
        provider: "opencode",
        model: known(
          records[0]?.canonicalId ?? "default",
          "opencode.config",
          observedAt,
        ),
        effort: unknown("surface-silent", "opencode.config", observedAt),
      },
    },
    measurements,
    commands: [],
  };
}

function database(): Database {
  return new Database(":memory:");
}

describe("the authoritative capability snapshot", () => {
  test("persists one probe for every reader instead of launching another transport", async () => {
    const db = database();
    const store = new CapabilitySnapshotStore(db);
    let probes = 0;
    const first = new CapabilitySnapshotAuthority(
      store,
      async () => {
        probes += 1;
        return {
          ...snapshot("probe", NOW, [record("model-a", ["high"], NOW)]),
          executable: "/fixture/opencode",
          version: "1.18.11",
          transport: "acp" as const,
          verdict: "compatible" as const,
        };
      },
      () => new Date(NOW),
    );
    expect((await first.discover("opencode")).status).toBe("ok");

    const reopened = new CapabilitySnapshotAuthority(
      new CapabilitySnapshotStore(db),
      async () => {
        probes += 1;
        throw new Error("fresh persisted snapshot should win");
      },
      () => new Date(NOW),
    );
    expect((await reopened.discover("opencode")).status).toBe("ok");
    expect(probes).toBe(1);
    db.close();
  });

  test("coalesces concurrent refreshes and keeps the last measured snapshot on failure", async () => {
    const db = database();
    const store = new CapabilitySnapshotStore(db);
    store.write(snapshot("probe", OLD, [record("model-a", ["low"], OLD)]));
    let probes = 0;
    const authority = new CapabilitySnapshotAuthority(
      store,
      async () => {
        probes += 1;
        throw new Error("provider unavailable");
      },
      () => new Date(NOW),
    );
    const [left, right] = await Promise.all([
      authority.snapshot("opencode"),
      authority.snapshot("opencode"),
    ]);
    expect(probes).toBe(1);
    expect(left.catalog).toEqual(right.catalog);
    expect(left.observedAt).toBe(OLD);
    db.close();
  });

  test("a silent provider cannot hold a cached projection read open", async () => {
    const db = database();
    const store = new CapabilitySnapshotStore(db);
    store.write(snapshot("probe", OLD, [record("model-a", ["low"], OLD)]));
    const authority = new CapabilitySnapshotAuthority(
      store,
      () => new Promise(() => {}),
      () => new Date(NOW),
      60_000,
      5,
    );

    expect((await authority.snapshot("opencode")).observedAt).toBe(OLD);
    db.close();
  });

  test("connected facts outrank a stale probe without dropping its other models", async () => {
    const db = database();
    const store = new CapabilitySnapshotStore(db);
    store.write(
      snapshot(
        "probe",
        OLD,
        [record("shared", ["low"], OLD), record("probe-only", ["medium"], OLD)],
        { modelCatalog: "supported", questions: "supported" },
      ),
    );
    const authority = new CapabilitySnapshotAuthority(
      store,
      async () => {
        throw new Error("a connected session does not launch a second probe");
      },
      () => new Date(NOW),
    );
    authority.recordConnected(
      "session-1",
      snapshot(
        "session",
        NOW,
        [record("shared", ["high"], NOW), record("session-only", [], NOW)],
        {
          modelCatalog: "supported",
          commandCatalog: "supported",
          questions: "unknown",
        },
      ),
    );

    const value = await authority.snapshot("opencode");
    expect(
      value.catalog.status === "ok"
        ? value.catalog.records.map((entry) => entry.canonicalId)
        : [],
    ).toEqual(["shared", "probe-only", "session-only"]);
    if (value.catalog.status !== "ok") throw new Error("catalog unavailable");
    expect(value.catalog.records[0]?.supportedEffortLevels).toMatchObject({
      state: "known",
      value: ["high"],
      observedAt: NOW,
    });
    expect(value.measurements.modelCatalog).toBe("supported");
    expect(value.measurements.questions).toBe("supported");
    expect(value.measurements.permissions).toBeUndefined();
    expect(value.commands).toEqual([]);
    db.close();
  });

  test("current reads stored facts without launching a provider probe", () => {
    const db = database();
    const store = new CapabilitySnapshotStore(db);
    store.write(snapshot("probe", OLD, [record("model-a", ["low"], OLD)]));
    let probes = 0;
    const authority = new CapabilitySnapshotAuthority(store, async () => {
      probes += 1;
      return snapshot("probe", NOW, [record("model-b", ["high"], NOW)]);
    });

    const value = authority.current("opencode");
    expect(value?.observedAt).toBe(OLD);
    expect(probes).toBe(0);
    db.close();
  });

  test("a connected account never inherits models from another account's probe", async () => {
    const db = database();
    const store = new CapabilitySnapshotStore(db);
    store.write(
      snapshot("probe", OLD, [
        record("shared", ["low"], OLD),
        record("old-account-only", ["low"], OLD),
      ]),
    );
    const authority = new CapabilitySnapshotAuthority(store, async () => {
      throw new Error("connected session is authoritative");
    });
    authority.recordConnected(
      "session-2",
      snapshot("session", NOW, [
        {
          ...record("shared", ["high"], NOW),
          accountFingerprint: "opencode:different-account",
        },
      ]),
    );

    const value = await authority.snapshot("opencode");
    expect(
      value.catalog.status === "ok"
        ? value.catalog.records.map((entry) => entry.canonicalId)
        : [],
    ).toEqual(["shared"]);
    db.close();
  });
});
