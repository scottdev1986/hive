import { describe, expect, test } from "bun:test";
import {
  buildModelControlSnapshotFixture,
  MODEL_CONTROL_SNAPSHOT_FIXTURE,
} from "../scripts/test-fixtures/model-control-snapshot";

describe("the shared Model Control wire fixture", () => {
  test("is the exact document emitted by the TypeScript producer", async () => {
    const generated = await buildModelControlSnapshotFixture();
    const fixture = await Bun.file(MODEL_CONTROL_SNAPSHOT_FIXTURE).json();

    expect(fixture).toEqual(generated);
    expect(fixture.generatedAt).toBe("2026-07-12T22:00:00.000Z");
    expect(fixture.usageSurfaces.grok).toBe("metered");
    expect(fixture.providers.grok.records[0].supportsEffort)
      .toMatchObject({ state: "known", value: false });
    expect(fixture.providers.codex)
      .toEqual({ status: "unavailable", reason: "codex CLI not signed in" });
    expect(fixture.billing.claude.creditsEnabled)
      .toMatchObject({ state: "known", value: false });
    expect(fixture.quota[0].fiveHour.used).toBe(63);
    expect(fixture.quota[0].weekly.used).toBeNull();
  });
});
