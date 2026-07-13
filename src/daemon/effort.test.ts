import { describe, expect, test } from "bun:test";
import {
  known,
  type CapabilityRecord,
  unknown,
} from "../schemas";
import { resolveAutoEffort, validateEffort } from "./effort";

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

describe("Hive-decides effort", () => {
  test("uses proved semantics rather than the vendor array order", () => {
    const grok = record({
      provider: "grok",
      canonicalId: "grok-4.5",
      launchToken: "grok-4.5",
      aliases: [],
      supportedEffortLevels: known(
        ["high", "medium", "low"],
        "grok.models_cache",
        observedAt,
      ),
      defaultEffort: known("high", "grok.models_cache", observedAt),
    });
    expect(resolveAutoEffort(grok, "simple_coding").effort).toBe("low");
    expect(resolveAutoEffort(grok, "complex_coding").effort).toBe("high");
  });

  test("standard uses the advertised default and complex uses Codex ultra", () => {
    const codex = record({
      provider: "codex",
      canonicalId: "gpt-5.6-sol",
      launchToken: "gpt-5.6-sol",
      aliases: [],
      supportsEffort: unknown("surface-silent", "codex.model/list", observedAt),
      supportedEffortLevels: known(
        ["ultra", "low", "max", "medium", "high", "xhigh"],
        "codex.model/list",
        observedAt,
      ),
      defaultEffort: known("medium", "codex.model/list", observedAt),
    });
    expect(resolveAutoEffort(codex, "standard_coding")).toMatchObject({
      effort: "medium",
      orderedLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(resolveAutoEffort(codex, "complex_coding").effort).toBe("ultra");
  });

  test("an unproved future spelling refuses AUTO but remains explicitly valid", () => {
    const future = record({
      supportedEffortLevels: known(["low", "warp"], surface, observedAt),
    });
    expect(() => resolveAutoEffort(future, "complex_coding"))
      .toThrow("does not know the ordering semantics of claude warp");
    expect(validateEffort(future, future.canonicalId, "warp").effort).toBe("warp");
  });

  test("a model that positively has no effort axis resolves to no flag", () => {
    expect(resolveAutoEffort(record({
      supportsEffort: known(false, surface, observedAt),
      supportedEffortLevels: known([], surface, observedAt),
    }), "complex_coding")).toEqual({
      orderedLevels: [],
      basis: "claude reports that this model has no effort setting",
    });
  });

  test("missing capability evidence refuses instead of choosing a default", () => {
    expect(() => resolveAutoEffort(undefined, "standard_coding"))
      .toThrow("requires a readable model capability record");
  });
});
