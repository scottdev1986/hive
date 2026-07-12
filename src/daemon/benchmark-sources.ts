import type { BenchmarkSourceAdapter } from "./benchmarks";
import { liveBenchSource } from "./livebench";

/** LiveBench is active; Artificial Analysis is recorded but never contacted. */
export const configuredBenchmarkSources = (): BenchmarkSourceAdapter[] => [
  liveBenchSource(),
  {
    sourceId: "artificial-analysis",
    async read() {
      return {
        sourceId: "artificial-analysis",
        status: "blocked",
        detail:
          "Artificial Analysis requires API key + TOS acceptance; user policy forbids both; scores also lack evaluation dates.",
        releaseDate: null,
        fetchedAt: null,
        models: new Map(),
      };
    },
  },
];
