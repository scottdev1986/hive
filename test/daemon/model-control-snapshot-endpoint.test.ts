// The Workspace endpoint is an authenticated HTTP view of the existing
// model-control snapshot builder, not a second implementation of its schema.

import { describe, expect, test } from "bun:test";
import {
  buildModelControlSnapshot,
  type ModelControlSnapshot,
} from "../../src/cli/model-control";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { QuotaConfigSchema } from "../../src/schemas/quota";
import { QuotaLedger } from "../../src/usage-service/quota-ledger";
import type {
  QuotaProbe,
  QuotaProbeResult,
} from "../../src/usage-service/quota-sources";
import { QuotaService } from "../../src/usage-service/usage-quota";

const dependencies = {
  discover: async (
    provider: "claude" | "codex" | "grok" | "kimi" | "opencode",
  ) => ({
    status: "unavailable" as const,
    reason: `${provider} fixture`,
  }),
  readBilling: async () => null,
  daemonPort: () => 43110,
  quota: async () => [],
  tokenUsage: async () => ({
    generatedAt: "2026-07-30T20:00:00.000Z",
    currentSessionId: null,
    sessions: [],
    attribution: "control-lower-bound" as const,
  }),
  now: () => new Date("2026-07-30T20:00:00.000Z"),
};

function harness(
  snapshot?: () => Promise<ModelControlSnapshot>,
  quota?: (db: HiveDatabase) => QuotaService,
): HiveDaemon {
  const db = new HiveDatabase(":memory:");
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      spawn: async () => {
        throw new Error("no spawn");
      },
    },
    repoRoot: "/tmp/hive-model-control-snapshot-endpoint",
    ...(snapshot === undefined ? {} : { modelControlSnapshot: snapshot }),
    ...(quota === undefined ? {} : { quota: quota(db) }),
  });
}

class StubProbe implements QuotaProbe {
  calls = 0;

  constructor(
    readonly provider: "grok",
    private readonly result: QuotaProbeResult,
  ) {}

  read(): Promise<QuotaProbeResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

const withProbe =
  (probe: QuotaProbe) =>
  (db: HiveDatabase): QuotaService =>
    new QuotaService(
      new QuotaLedger(db),
      QuotaConfigSchema.parse({}),
      () => new Date("2026-08-15T15:55:00.000Z"),
      [probe],
    );

describe("model-control HTTP endpoints", () => {
  test("has no live-discovery fallback when no stored projection is configured", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await daemon.fetch(
      new Request("http://hive/model-control/snapshot", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "the daemon has no model-control projection configured",
    });
    await daemon.stop();
  });

  test("wraps the CLI facts in the daemon-owned Workspace view", async () => {
    const expected = await buildModelControlSnapshot(dependencies);
    const daemon = harness(() => buildModelControlSnapshot(dependencies));
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await daemon.fetch(
      new Request("http://hive/model-control/snapshot", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      observedAt: expected.generatedAt,
      snapshot: expected,
      routing: {
        policy: { schemaVersion: 3 },
        categories: expect.any(Array),
      },
      providers: expect.any(Object),
      tokenSessions: [],
    });
    await daemon.stop();
  });

  test("normal snapshot load does not probe, but the refresh action does", async () => {
    const probe = new StubProbe("grok", {
      status: "ok",
      pools: [],
      catalog: [],
    });
    const daemon = harness(
      () => buildModelControlSnapshot(dependencies),
      withProbe(probe),
    );
    const { token } = daemon.capabilities.mint("user", "user");
    const headers = { Authorization: `Bearer ${token}` };

    const snapshot = await daemon.fetch(
      new Request("http://hive/model-control/snapshot", { headers }),
    );
    expect(snapshot.status).toBe(200);
    expect(probe.calls).toBe(0);

    const refresh = await daemon.fetch(
      new Request("http://hive/model-control/probe-refresh", {
        method: "POST",
        headers,
      }),
    );
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toEqual([
      {
        provider: "grok",
        status: "ok",
        pools: 0,
        observedAt: null,
        startedAt: "2026-08-15T15:55:00.000Z",
        completedAt: "2026-08-15T15:55:00.000Z",
        delivery: "started",
      },
    ]);
    expect(probe.calls).toBe(1);
    await daemon.stop();
  });

  test("a failed provider probe returns its honest reason", async () => {
    const probe = new StubProbe("grok", {
      status: "unavailable",
      reason: "fake Grok surface refused the probe",
    });
    const daemon = harness(
      () => buildModelControlSnapshot(dependencies),
      withProbe(probe),
    );
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await daemon.fetch(
      new Request("http://hive/model-control/probe-refresh", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        provider: "grok",
        status: "unavailable",
        pools: 0,
        reason: "fake Grok surface refused the probe",
        observedAt: null,
        startedAt: "2026-08-15T15:55:00.000Z",
        completedAt: "2026-08-15T15:55:00.000Z",
        delivery: "started",
      },
    ]);
    expect(probe.calls).toBe(1);
    await daemon.stop();
  });

  test("refuses missing and non-user credentials", async () => {
    const daemon = harness(() => buildModelControlSnapshot(dependencies));
    expect(
      (await daemon.fetch(new Request("http://hive/model-control/snapshot")))
        .status,
    ).toBe(401);
    const { token } = daemon.capabilities.mint("agent", "writer");
    expect(
      (
        await daemon.fetch(
          new Request("http://hive/model-control/snapshot", {
            headers: { Authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await daemon.fetch(
          new Request("http://hive/model-control/probe-refresh", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await daemon.fetch(
          new Request("http://hive/model-control/probe-refresh", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(403);
    await daemon.stop();
  });
});
