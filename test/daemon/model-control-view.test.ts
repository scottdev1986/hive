import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ModelControlSnapshot } from "../../src/cli/model-control";
import { buildWorkspaceModelControlView } from "../../src/daemon/routing-service/model-control-view";
import {
  ROUTING_CATEGORIES,
  RoutingPolicySchema,
} from "../../src/schemas/routing-policy";
import { TokenUsageSnapshotSchema } from "../../src/schemas/token-usage-schema";
import { buildModelControlSnapshotFixture } from "../fixtures/builders/model-control-snapshot";

async function policy() {
  return RoutingPolicySchema.parse(
    await Bun.file(
      resolve(
        import.meta.dir,
        "../../workspace/Tests/WorkspaceCoreTests/Fixtures/routing-policy-wire.json",
      ),
    ).json(),
  );
}

describe("daemon-owned Workspace model-control view", () => {
  test("owns the complete category catalog and fail-closed routing states", async () => {
    const view = buildWorkspaceModelControlView(
      await buildModelControlSnapshotFixture(),
      await policy(),
    );

    expect(view.routing.categories.map(({ id }) => id)).toEqual([
      ...ROUTING_CATEGORIES,
    ]);
    expect(view.routing.categories.every(({ label }) => label.length > 0)).toBe(
      true,
    );
    expect(view.routing.modes).toEqual([
      expect.objectContaining({
        id: "user-weighted",
        label: "Weighted split",
        weightEditable: true,
      }),
      expect.objectContaining({
        id: "hive-equal",
        label: "Equal split",
        weightEditable: false,
      }),
    ]);
    expect(view.routing.defaultMode).toBe("hive-equal");
    expect(view.routing.weightRange).toEqual({
      minimum: 1,
      maximum: 100,
      defaultValue: 1,
    });
    expect(view.routing.providers.kimi?.state).toBe("unconfigured");
    expect(view.routing.providers.grok?.state).toBe("disabled");
    expect(
      view.routing.models.find(
        (row) => row.provider === "codex" && row.model === "gpt-5.6-sol",
      ),
    ).toMatchObject({ rowState: "unavailable" });
    expect(
      view.routing.catalog.some(
        (row) => row.provider === "codex" && row.model === "gpt-5.6-sol",
      ),
    ).toBe(false);
    expect(
      view.routing.catalog.find(
        (row) => row.provider === "claude" && row.model === "claude-opus-4-8",
      ),
    ).toMatchObject({
      startingEffort: { mode: "hive-decides" },
      effortOptions: expect.arrayContaining([
        expect.objectContaining({
          argument: "provider-controlled",
          effort: { mode: "provider-controlled" },
        }),
      ]),
    });
    expect(
      view.routing.models.find(
        (row) =>
          row.provider === "grok" && row.model === "grok-composer-2.5-fast",
      ),
    ).toMatchObject({
      state: "disabled",
      source: "provider",
      rowState: "disabled-by-provider",
      preferenceOn: false,
    });
  });

  test("owns quota, billing, model, and availability presentation", async () => {
    const snapshot = structuredClone(
      await buildModelControlSnapshotFixture(),
    ) as ModelControlSnapshot;
    const grok = snapshot.providers.grok;
    if (grok.status !== "ok" || grok.records[0] === undefined) {
      throw new Error("fixture must carry a Grok model");
    }
    grok.records[0].hidden = {
      state: "known",
      value: true,
      surface: "grok.models_cache",
      observedAt: snapshot.generatedAt,
    };
    snapshot.providers.kimi = {
      status: "unavailable",
      reason: "Kimi catalog probe timed out",
    };

    const view = buildWorkspaceModelControlView(snapshot, await policy());
    expect(view.providers.grok).toMatchObject({
      catalogState: "available",
      catalogReason: null,
    });
    expect(view.providers.claude?.billingChip).toBe("paid-overflow-off");
    expect(view.providers.claude?.usage).toMatchObject({
      state: "metered",
      windows: [
        {
          label: "5 hour window",
          meter: { state: "measured", usedPercent: 63 },
        },
        { label: "7 day window", meter: { state: "unknown" } },
      ],
    });
    expect(view.providers.opencode?.usage).toEqual({ state: "unmetered" });
    expect(view.providers.kimi).toMatchObject({
      catalogState: "unavailable",
      catalogReason: "Kimi catalog probe timed out",
      models: [],
    });
    expect(view.providers.grok?.models[0]).toMatchObject({
      name: "Composer 2.5 Fast",
      effortAxis: { state: "none" },
    });
    expect(
      view.routing.models.find(
        (row) =>
          row.provider === "grok" && row.model === "grok-composer-2.5-fast",
      )?.rowState,
    ).toBe("unavailable");
    expect(
      view.routing.catalog.some(
        (row) =>
          row.provider === "grok" && row.model === "grok-composer-2.5-fast",
      ),
    ).toBe(false);
  });

  test("owns token headlines, row grouping, and control share", async () => {
    const snapshot = await buildModelControlSnapshotFixture();
    snapshot.tokenUsage = TokenUsageSnapshotSchema.parse(
      await Bun.file(
        resolve(
          import.meta.dir,
          "../../workspace/Tests/WorkspaceCoreTests/Fixtures/token-usage-wire.json",
        ),
      ).json(),
    );

    const session = buildWorkspaceModelControlView(snapshot, await policy())
      .tokenSessions[0];
    expect(session?.fleet?.newTokens).toBe(880);
    expect(session?.hiveControl?.newTokens).toBe(600);
    expect(session?.workerSessions?.newTokens).toBe(280);
    expect(session?.rows.map(({ name }) => name)).toEqual([
      "Queen",
      "maya",
      "quinn",
    ]);
    expect(
      session?.rows.find(({ name }) => name === "quinn")?.unknownReason,
    ).toBe("grok has not reported token usage yet");
    expect(session?.controlSharePercent).toBeCloseTo((600 / 880) * 100);
  });
});
