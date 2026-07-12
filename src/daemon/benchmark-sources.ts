import type { BenchmarkSourceAdapter } from "./benchmarks";
import { liveBenchSource } from "./livebench";

export type BenchmarkSourceEligibility = {
  publiclyFetchable: boolean;
  requiresAuthentication: boolean;
  requiresTosAcceptance: boolean;
  datedScores: boolean;
  machineReadable: boolean;
  reputable: boolean;
};

export const sourceIsEligible = (
  source: BenchmarkSourceEligibility,
): boolean =>
  source.publiclyFetchable && !source.requiresAuthentication &&
  !source.requiresTosAcceptance && source.datedScores &&
  source.machineReadable && source.reputable;

const liveBenchEligibility: BenchmarkSourceEligibility = {
  publiclyFetchable: true,
  requiresAuthentication: false,
  requiresTosAcceptance: false,
  datedScores: true,
  machineReadable: true,
  reputable: true,
};

const activeSource = (
  adapter: BenchmarkSourceAdapter,
  eligibility: BenchmarkSourceEligibility,
): BenchmarkSourceAdapter => {
  if (!sourceIsEligible(eligibility)) {
    throw new Error(`${adapter.sourceId} does not satisfy benchmark source policy`);
  }
  return adapter;
};

/** Every registered source must clear the eligibility gate; LiveBench is the only one today. */
export const configuredBenchmarkSources = (): BenchmarkSourceAdapter[] => [
  activeSource(liveBenchSource(), liveBenchEligibility),
];
