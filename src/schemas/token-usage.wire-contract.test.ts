import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOKEN_USAGE_ROLES,
  TokenUsageSnapshotSchema,
} from "./token-usage";

/**
 * THE DAEMON HALF OF THE TOKEN-USAGE WIRE CONTRACT.
 *
 * `workspace/Tests/WorkspaceCoreTests/Fixtures/token-usage-wire.json` is decoded
 * by the Swift Usage screen (TokenUsageWireContractTests). This test proves the
 * same file is a document the daemon may legitimately EMIT, and — the part that
 * matters — that it still exercises every subject KIND the schema can produce.
 *
 * WHY: this is the exact failure class that shipped a Settings-killing decode
 * break here once already. Two suites stayed green while each side pinned its
 * OWN hand-written fixture, so a role/mode one side added went untested on the
 * other until it reached a user. The one shared fixture is the handshake: add a
 * role to `TOKEN_USAGE_ROLES` and THIS test fails until the fixture carries it,
 * at which point the Swift decoder is forced to face it too. Neither side may
 * change the kind axis alone.
 */
describe("token usage wire contract (shared with the Swift Usage decoder)", () => {
  const fixturePath = join(
    import.meta.dir,
    "../../workspace/Tests/WorkspaceCoreTests/Fixtures/token-usage-wire.json",
  );
  const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

  test("the fixture is a document the daemon may legitimately emit", () => {
    const parsed = TokenUsageSnapshotSchema.safeParse(fixture);
    expect(parsed.error?.message ?? "valid").toBe("valid");
    expect(parsed.success).toBe(true);
  });

  test("the fixture exercises EVERY subject role the daemon can emit", () => {
    const schemaRoles = [...TOKEN_USAGE_ROLES].sort();

    const snapshot = TokenUsageSnapshotSchema.parse(fixture);
    const fixtureRoles = [
      ...new Set(
        snapshot.sessions.flatMap((session) =>
          session.subjects.map((subject) => subject.role as string)
        ),
      ),
    ].sort();

    // A role the fixture never carries is a role the Swift decoder is never
    // tested against — exactly how a new wire kind ships broken. The guard is
    // what keeps the next role added to the axis honest.
    expect(fixtureRoles).toEqual(schemaRoles);
  });

  test("every session carries the three breakdown buckets", () => {
    const snapshot = TokenUsageSnapshotSchema.parse(fixture);
    for (const session of snapshot.sessions) {
      // strictObject parsing already requires these keys; asserting them here
      // documents that they are part of the contract, not optional daemon garnish.
      expect(session.fleet).toBeDefined();
      expect(session.hiveControl).toBeDefined();
      expect(session.workerSessions).toBeDefined();
    }
  });

  test("a Codex/Grok worker keeps a headline from cache reads with null cache-creation", () => {
    const snapshot = TokenUsageSnapshotSchema.parse(fixture);
    const bucket = snapshot.sessions[0]!.workerSessions;
    // The null-cache-subset lesson: a provider that reports cache READS but not
    // cache CREATION must not null the whole bucket. Reads survive; creation is
    // an honest null; the headline derives from reads alone.
    expect(bucket.counts).not.toBeNull();
    expect(bucket.counts?.cachedInputTokens).toBe(300);
    expect(bucket.counts?.cacheCreationInputTokens).toBeNull();
  });
});
