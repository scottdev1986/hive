import { describe, expect, test } from "bun:test";
import {
  known,
  type CapabilityRecord,
  unknown,
} from "../schemas";
import { validateEffort } from "./effort";

const observedAt = "2026-07-11T12:00:00.000Z";
const surface = "claude.initialize" as const;

function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    provider: "claude",
    accountFingerprint: "account",
    cliVersion: "2.1.207",
    canonicalId: "claude-opus-4-8",
    variant: null,
    launchToken: "claude-opus-4-8",
    displayName: null,
    aliases: ["opus"],
    entitled: known(true, surface, observedAt),
    hidden: unknown("surface-silent", surface, observedAt),
    supportsEffort: known(true, surface, observedAt),
    supportedEffortLevels: known(["low", "medium", "high"], surface, observedAt),
    defaultEffort: unknown("surface-silent", surface, observedAt),
    observedAt,
    ...overrides,
  };
}

describe("effort eligibility", () => {
  test("passes an advertised value verbatim", () => {
    expect(validateEffort(record(), "claude-opus-4-8", "high")).toEqual({
      effort: "high",
    });
  });

  test("rejects a positively excluded value and names the supported list", () => {
    expect(() => validateEffort(record(), "claude-opus-4-8", "xhigh"))
      .toThrow(
        "Cannot launch claude-opus-4-8 with effort xhigh: supported effort levels are low, medium, high",
      );
  });

  test("an explicit vendor refusal overrides a levels list", () => {
    expect(() =>
      validateEffort(record({
        supportsEffort: known(false, surface, observedAt),
      }), "claude-opus-4-8", "high")
    ).toThrow("does not support effort");
  });

  test("unknown is not false and passes through with a warning", () => {
    const result = validateEffort(record({
      supportedEffortLevels: unknown("field-absent", surface, observedAt),
    }), "claude-haiku-4-5", "low");
    expect(result.effort).toBe("low");
    expect(result.warning).toContain("does not report supported effort levels");
  });

  test("no record delegates validation to the CLI rather than guessing", () => {
    const result = validateEffort(undefined, "future-model", "ultra");
    expect(result.effort).toBe("ultra");
    expect(result.warning).toContain("No capability record");
  });
});
