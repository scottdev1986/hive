import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CandidateEffortSchema,
  EffortTargetSchema,
  ROUTING_CATEGORIES,
  RouterModeSchema,
  RoutingPolicySchema,
} from "../../src/schemas/routing-policy";

/**
 * THE DAEMON HALF OF THE WORKSPACE WIRE CONTRACT.
 *
 * `workspace/Tests/WorkspaceCoreTests/Fixtures/routing-policy-wire.json` is
 * decoded by the Swift Settings screen (RoutingPolicyWireContractTests). This
 * test proves the same file is a document the daemon may legitimately EMIT,
 * and — the part that matters — that it still covers every enum value the
 * schema can produce.
 *
 * Every mode must appear in the shared fixture so both decoders exercise the
 * same vocabulary. Adding a mode fails this test until the fixture carries it;
 * neither side may change the schema alone.
 */
describe("routing policy wire contract (shared with the Swift Settings decoder)", () => {
  const fixturePath = join(
    import.meta.dir,
    "../../workspace/Tests/WorkspaceCoreTests/Fixtures/routing-policy-wire.json",
  );
  const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

  test("the fixture is a document the daemon may legitimately emit", () => {
    const parsed = RoutingPolicySchema.safeParse(fixture);
    expect(parsed.error?.message ?? "valid").toBe("valid");
    expect(parsed.success).toBe(true);
  });

  test("the fixture exercises EVERY effort mode the daemon can emit", () => {
    const policy = RoutingPolicySchema.parse(fixture);

    // Model rows carry the full 5-mode EffortTarget vocabulary, including
    // never-configured (the unanswered row state).
    const rowModes = EffortTargetSchema.options
      .map((option) => option.shape.mode.value as string)
      .sort();
    const fixtureRowModes = [
      ...new Set(policy.models.map((row) => row.effort.mode as string)),
    ].sort();
    expect(fixtureRowModes).toEqual(rowModes);

    // Route candidates always answer effort, so their vocabulary is the
    // 4-mode CandidateEffort — never-configured cannot appear on a candidate.
    const candidateModes = CandidateEffortSchema.options
      .map((option) => option.shape.mode.value as string)
      .sort();
    const routes = [
      ...Object.values(policy.categories),
      ...(policy.global === null ? [] : [policy.global]),
    ];
    const fixtureCandidateModes = [
      ...new Set(
        routes.flatMap((route) =>
          route.candidates.map((candidate) => candidate.effort.mode as string),
        ),
      ),
    ].sort();
    expect(fixtureCandidateModes).toEqual(candidateModes);
  });

  /**
   * Every category must appear in the shared fixture so the Settings screen
   * can show and edit every route the daemon can resolve through. Adding a
   * category fails this test until both decoders name it.
   */
  test("the fixture exercises EVERY routing category the daemon can emit, plus the global route", () => {
    const schemaCategories = [...ROUTING_CATEGORIES].sort();

    const policy = RoutingPolicySchema.parse(fixture);
    const fixtureCategories = Object.keys(policy.categories).sort();

    expect(fixtureCategories).toEqual(schemaCategories);
    expect(policy.global).not.toBeNull();
  });

  /**
   * Both router modes must reach the Swift decoder: pinning the vocabulary
   * forces any new mode into the shared fixture before either side accepts
   * it alone.
   */
  test("the router-mode vocabulary is pinned and fully exercised", () => {
    expect([...RouterModeSchema.options].sort()).toEqual([
      "hive-equal",
      "user-weighted",
    ]);

    const policy = RoutingPolicySchema.parse(fixture);
    const fixtureModes = [
      ...new Set(
        [
          ...Object.values(policy.categories),
          ...(policy.global === null ? [] : [policy.global]),
        ].map((route) => route.mode),
      ),
    ].sort();
    expect(fixtureModes).toEqual(["hive-equal", "user-weighted"]);
  });
});
