import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  MutationExpectationSchema,
  mutationIntentSchema,
  mutationResultSchema,
  RunControlIntentSchema,
} from "../../src/schemas/run-control";

/**
 * THE DAEMON HALF OF THE RUN-CONTROL WIRE CONTRACT.
 *
 * `workspace/Tests/WorkspaceCoreTests/Fixtures/mutation-envelope-wire.json` is
 * decoded by the Swift client (MutationEnvelopeTests). This test proves the
 * same bytes decode with the daemon's schemas, so an intent the client encodes
 * is one the daemon accepts and a result the daemon emits is one the client can
 * read. Neither side may change the envelope alone.
 */
describe("mutation envelope wire contract (shared with the Swift client)", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../../workspace/Tests/WorkspaceCoreTests/Fixtures/mutation-envelope-wire.json",
      ),
      "utf8",
    ),
  ) as { intents: unknown[]; results: unknown[] };

  // Body and post-state are generic on both sides; the fixture exercises the
  // envelope, so this half leaves them open exactly as Swift's generics do.
  const IntentSchema = mutationIntentSchema(
    z.unknown(),
    MutationExpectationSchema,
  );
  const ResultSchema = mutationResultSchema(
    z.unknown(),
    MutationExpectationSchema,
  );

  test("every intent the client encodes decodes here", () => {
    for (const intent of fixture.intents) {
      const parsed = IntentSchema.safeParse(intent);
      expect(parsed.error?.message ?? "valid").toBe("valid");
    }
    expect(fixture.intents.length).toBe(3);
  });

  test("every result shape the client decodes is one this schema accepts", () => {
    for (const result of fixture.results) {
      const parsed = ResultSchema.safeParse(result);
      expect(parsed.error?.message ?? "valid").toBe("valid");
    }
    expect(fixture.results.length).toBe(2);
  });

  test("an expectation cannot carry the token its kind excludes", () => {
    const withEpoch = IntentSchema.safeParse({
      ...(fixture.intents[0] as Record<string, unknown>),
      expected: { kind: "revision", revision: "7", epoch: "3" },
    });
    expect(withEpoch.success).toBe(false);

    const withRevision = IntentSchema.safeParse({
      ...(fixture.intents[1] as Record<string, unknown>),
      expected: { kind: "epoch", epoch: "3", revision: "7" },
    });
    expect(withRevision.success).toBe(false);
  });

  test("an accepted outcome cannot carry a failure", () => {
    const parsed = ResultSchema.safeParse({
      ...(fixture.results[0] as Record<string, unknown>),
      outcome: {
        status: "accepted",
        failure: { code: "revision-conflict", message: "expected 7" },
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("a rejected outcome must say why", () => {
    const parsed = ResultSchema.safeParse({
      ...(fixture.results[1] as Record<string, unknown>),
      outcome: { status: "rejected" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("run-control bodies name exact facts", () => {
  const runId = "run_018f4f5e-0000-7000-8000-000000000001";

  test("a run-control intent must fence on revision AND epoch", () => {
    const intent = {
      schemaVersion: 1,
      intentId: "intent-pause",
      idempotencyKey: "key-pause",
      body: { operation: "run-pause", runId },
    };
    for (const expected of [
      { kind: "revision", revision: "1" },
      { kind: "epoch", epoch: "0" },
    ]) {
      expect(
        RunControlIntentSchema.safeParse({ ...intent, expected }).success,
      ).toBe(false);
    }
    // Positive control: the two-token form is the one that parses.
    expect(
      RunControlIntentSchema.safeParse({
        ...intent,
        expected: { kind: "revision-and-epoch", revision: "1", epoch: "0" },
      }).success,
    ).toBe(true);
  });
});
