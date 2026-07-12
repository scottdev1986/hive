import { describe, expect, test } from "bun:test";
import {
  configuredBenchmarkSources,
  sourceIsEligible,
} from "./benchmark-sources";

describe("configured benchmark sources", () => {
  test("LiveBench is the sole registered source", () => {
    const sources = configuredBenchmarkSources();
    expect(sources.map((source) => source.sourceId)).toEqual(["livebench"]);
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
