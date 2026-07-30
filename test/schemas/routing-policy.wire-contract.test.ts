import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EffortTargetSchema,
  ROUTING_CATEGORIES,
  RoutingPolicySchema,
  SelectionModeSchema,
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
    const schemaModes = EffortTargetSchema.options
      .map((option) => option.shape.mode.value as string)
      .sort();

    const policy = RoutingPolicySchema.parse(fixture);
    const fixtureModes = [
      ...new Set([
        ...policy.models.map((row) => row.effort.mode as string),
        ...Object.values(policy.chains)
          .flat()
          .map((link) => link.effort.mode as string),
      ]),
    ].sort();

    expect(fixtureModes).toEqual(schemaModes);
  });

  /**
   * Every category must appear in the shared fixture so the Settings screen can
   * show and edit every chain the daemon can route through. Adding a category
   * fails this test until both decoders name it.
   */
  test("the fixture exercises EVERY routing category the daemon can emit", () => {
    const schemaCategories = [...ROUTING_CATEGORIES].sort();

    const policy = RoutingPolicySchema.parse(fixture);
    const fixtureCategories = Object.keys(policy.chains).sort();

    expect(fixtureCategories).toEqual(schemaCategories);
  });

  /**
   * Selection is one mode for the whole document, so a single fixture cannot
   * exercise every value. Pinning the vocabulary here forces any new mode into
   * the Swift `SelectionMode` enum before either decoder accepts it alone.
   */
  test("the selection vocabulary is pinned, so a new mode must reach the Swift decoder", () => {
    expect([...SelectionModeSchema.options].sort()).toEqual([
      "auto",
      "choice",
      "never-configured",
    ]);

    const policy = RoutingPolicySchema.parse(fixture);
    expect(SelectionModeSchema.options as readonly string[]).toContain(
      policy.selection.global,
    );
  });
});
