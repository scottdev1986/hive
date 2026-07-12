import { describe, expect, test } from "bun:test";
import {
  configuredBenchmarkSources,
  sourceIsEligible,
} from "./benchmark-sources";

describe("configured benchmark sources", () => {
  test("LiveBench is active while Artificial Analysis is policy-blocked", async () => {
    const sources = configuredBenchmarkSources();
    expect(sources.map((source) => source.sourceId)).toEqual([
      "livebench",
      "artificial-analysis",
    ]);
    const artificialAnalysis = sources[1]!;
    const result = await artificialAnalysis.read({
      claude: { status: "unavailable", reason: "not needed" },
      codex: { status: "unavailable", reason: "not needed" },
    });
    expect(result).toMatchObject({
      status: "blocked",
      releaseDate: null,
      fetchedAt: null,
    });
    expect(result.detail).toContain("user policy forbids both");
    expect(result.detail).not.toContain("not set");
  });

  test("authentication, TOS, and missing score dates are hard eligibility gates", () => {
    const eligible = {
      publiclyFetchable: true,
      requiresAuthentication: false,
      requiresTosAcceptance: false,
      datedScores: true,
      machineReadable: true,
      reputable: true,
    };
    expect(sourceIsEligible(eligible)).toBeTrue();
    expect(sourceIsEligible({ ...eligible, requiresAuthentication: true })).toBeFalse();
    expect(sourceIsEligible({ ...eligible, requiresTosAcceptance: true })).toBeFalse();
    expect(sourceIsEligible({ ...eligible, datedScores: false })).toBeFalse();
  });
});
