import { describe, expect, test } from "bun:test";
import { configuredBenchmarkSources } from "./benchmark-sources";

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
});
