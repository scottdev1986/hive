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
 * WHY: capability-first routing added the effort mode "never-configured". The
 * Swift decoder had never heard of it, threw on the whole document, and the
 * Settings screen fell back to an in-memory store — every setting silently
 * stopped persisting, with a green test suite on both sides, because each side
 * only ever tested its own hand-written fixture.
 *
 * So: add a mode to the schema and THIS test fails until you add it to the
 * shared fixture, at which point the Swift decoder is forced to face it too.
 * The fixture is the handshake; neither side may change the schema alone.
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

    // An effort mode the fixture never carries is a mode the Swift decoder is
    // never tested against — exactly how "never-configured" shipped broken.
    expect(fixtureModes).toEqual(schemaModes);
  });

  /**
   * THE CATEGORY HALF OF THE HANDSHAKE, and the reason it exists: the effort
   * modes got this guard after they shipped broken, and CATEGORIES then drifted
   * the same way, unguarded. `standard_coding` lived in this schema for months
   * while the Swift enum had never heard of it — so the Settings screen, which
   * builds its cards from TaskCategory.allCases, could not show or edit that
   * chain, while the daemon happily routed real work through it. Two green
   * suites, one broken wire, exactly as before.
   *
   * So: add a category to the schema and THIS test fails until the fixture
   * carries a chain for it, at which point the Swift parity test is forced to
   * name it too.
   */
  test("the fixture exercises EVERY routing category the daemon can emit", () => {
    const schemaCategories = [...ROUTING_CATEGORIES].sort();

    const policy = RoutingPolicySchema.parse(fixture);
    const fixtureCategories = Object.keys(policy.chains).sort();

    // A category the fixture never carries is a category the Swift decoder is
    // never tested against — and a chain the user may never get to configure.
    expect(fixtureCategories).toEqual(schemaCategories);
  });

  /**
   * Selection is ONE mode for the whole document since per-category overrides
   * were removed, so no single fixture can exercise all three the way the
   * effort and category guards above do. The vocabulary is pinned literally
   * instead: add a mode to the schema and this fails, which is the prompt to
   * add it to the Swift `SelectionMode` enum — the decoder that would
   * otherwise throw on the whole document, exactly as "never-configured" did.
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
