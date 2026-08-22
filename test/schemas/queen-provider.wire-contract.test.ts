import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityProviderSchema } from "../../src/schemas/capability";
import {
  QUEEN_PROVIDER_CHANGE_STATES,
  QueenProviderProjectionSchema,
  QueenRootHealthSchema,
} from "../../src/schemas/queen-provider";

/**
 * THE DAEMON HALF OF THE QUEEN PROVIDER WIRE CONTRACT.
 *
 * `workspace/Tests/WorkspaceCoreTests/Fixtures/queen-provider-corpus.json` is
 * decoded by the Swift screen. This test proves every value row is a document
 * the daemon may legitimately emit. Health is forward-compatible: the Swift
 * client preserves unknown words, while dedicated tests pin the exact current
 * queen vocabulary without multiplying projection-availability fixture rows.
 */
describe("queen provider wire contract (shared with the Swift screen decoder)", () => {
  const corpus: Array<{ availability: string; value: unknown }> = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../../workspace/Tests/WorkspaceCoreTests/Fixtures/queen-provider-corpus.json",
      ),
      "utf8",
    ),
  );
  const projections = corpus
    .filter((row) => row.value !== null)
    .map((row) => QueenProviderProjectionSchema.parse(row.value));

  test("every value row is a document the daemon may legitimately emit", () => {
    for (const row of corpus) {
      if (row.value === null) continue;
      const parsed = QueenProviderProjectionSchema.safeParse(row.value);
      expect(`${row.availability}: ${parsed.error?.message ?? "valid"}`).toBe(
        `${row.availability}: valid`,
      );
    }
  });

  test("the rows without a value carry no projection to misread", () => {
    // unknown and unauthorized observed nothing. A fabricated projection here
    // would let the screen render a state the daemon never reported.
    const absent = corpus
      .filter((row) => row.value === null)
      .map((row) => row.availability);
    expect(absent.sort()).toEqual(["unauthorized", "unknown"]);
  });

  test("the fixture exercises EVERY change state a client can see", () => {
    const states = [...new Set(projections.map((p) => p.change.state))].sort();
    expect(states).toEqual([...QUEEN_PROVIDER_CHANGE_STATES].sort());
  });

  test("the fixture retains legacy health values and the nullable v1 reading", () => {
    const healths = [...new Set(projections.map((p) => p.health))];
    for (const value of ["spawning", "working", "idle", "exited"] as const) {
      expect(healths).toContain(value);
    }
    expect(healths).toContain(null);
  });

  test("the schema accepts every exact queen status", () => {
    for (const value of QueenRootHealthSchema.options) {
      expect(QueenRootHealthSchema.parse(value)).toBe(value);
    }
  });

  test("the fixture covers an unobserved root and a contradicted record", () => {
    expect(projections.some((p) => p.liveProvider === null)).toBe(true);
    // A record that contradicts itself must also surrender its health claim.
    const contradicted = projections.filter((p) => p.contradicted);
    expect(contradicted.length).toBeGreaterThan(0);
    for (const projection of contradicted) expect(projection.health).toBeNull();
  });

  test("every row offers every vendor, so no key reads as an unknown vendor", () => {
    for (const projection of projections) {
      expect(Object.keys(projection.vendors).sort()).toEqual(
        [...CapabilityProviderSchema.options].sort(),
      );
    }
  });

  test("a failed change explains itself, and no other state invents a failure", () => {
    for (const projection of projections) {
      if (projection.change.state === "failed") {
        expect(projection.change.failure).not.toBeNull();
      } else {
        expect(projection.change.failure).toBeNull();
      }
    }
  });

  test("revisions are decimal STRINGS, and one exceeds what a Double holds exactly", () => {
    for (const projection of projections) {
      expect(projection.change.revision).toBeTypeOf("string");
    }
    // A revision past 2^53 decodes fine as a string and silently truncates as a
    // number. The fixture carries one so an Int-based decoder cannot pass.
    const widest = projections
      .map((p) => BigInt(p.change.revision))
      .reduce((a, b) => (a > b ? a : b));
    expect(widest).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});
