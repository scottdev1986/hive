import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOKEN_USAGE_ROLES,
  TokenUsageSnapshotSchema,
} from "../../src/schemas/token-usage";

/**
 * THE DAEMON HALF OF THE TOKEN-USAGE WIRE CONTRACT.
 *
 * `workspace/Tests/WorkspaceCoreTests/Fixtures/token-usage-wire.json` is decoded
 * by the Swift Usage screen (TokenUsageWireContractTests). This test proves the
 * same file is a document the daemon may legitimately EMIT, and — the part that
 * matters — that it still exercises every subject KIND the schema can produce.
 *
 * The shared fixture is the handshake between decoders. Adding a role to
 * `TOKEN_USAGE_ROLES` fails this test until the fixture carries it, so neither
 * side can change the kind axis alone.
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
          session.subjects.map((subject) => subject.role as string),
        ),
      ),
    ].sort();

    expect(fixtureRoles).toEqual(schemaRoles);
  });

  test("every session carries the three breakdown buckets", () => {
    const snapshot = TokenUsageSnapshotSchema.parse(fixture);
    for (const session of snapshot.sessions) {
      expect(session.fleet).toBeDefined();
      expect(session.hiveControl).toBeDefined();
      expect(session.workerSessions).toBeDefined();
    }
  });

  test("a Codex/Grok worker keeps a headline from cache reads with null cache-creation", () => {
    const snapshot = TokenUsageSnapshotSchema.parse(fixture);
    const bucket = required(snapshot.sessions[0]?.workerSessions);
    // The null-cache-subset lesson: a provider that reports cache READS but not
    // cache CREATION must not null the whole bucket. Reads survive; creation is
    // an honest null; the headline derives from reads alone.
    expect(bucket.counts).not.toBeNull();
    expect(bucket.counts?.cachedInputTokens).toBe(300);
    expect(bucket.counts?.cacheCreationInputTokens).toBeNull();
  });
});

import { required } from "../required";
