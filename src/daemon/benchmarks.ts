import type { CapabilityProvider, ProviderDiscovery } from "../schemas";

export type BenchmarkMode = "shadow" | "off";

export type InventoryBenchmark = {
  sourceId: string;
  effort: string;
  scores: Record<string, number>;
  source: string;
  releaseDate: string;
  fetchedAt: string;
};

export type BenchmarkSourceStatus = {
  sourceId: string;
  status: "current" | "last-good" | "unavailable" | "blocked";
  detail: string;
  releaseDate: string | null;
  fetchedAt: string | null;
};

export type BenchmarkSourceResult = BenchmarkSourceStatus & {
  models: ReadonlyMap<string, InventoryBenchmark[]>;
};

export interface BenchmarkSourceAdapter {
  readonly sourceId: string;
  read(
    discovery: Record<CapabilityProvider, ProviderDiscovery>,
  ): Promise<BenchmarkSourceResult>;
}

export type BenchmarkCatalog = {
  status:
    | "off"
    | "not-configured"
    | "current"
    | "partial"
    | "last-good"
    | "unavailable"
    | "blocked";
  detail: string;
  sources: BenchmarkSourceStatus[];
  models: ReadonlyMap<string, InventoryBenchmark[]>;
};

export async function readBenchmarkCatalog(options: {
  mode: BenchmarkMode;
  discovery: Record<CapabilityProvider, ProviderDiscovery>;
  sources?: readonly BenchmarkSourceAdapter[];
}): Promise<BenchmarkCatalog> {
  if (options.mode === "off") {
    return {
      status: "off",
      detail: "Benchmark inspection is disabled by config.",
      sources: [],
      models: new Map(),
    };
  }
  const adapters = options.sources ?? [];
  if (adapters.length === 0) {
    return {
      status: "not-configured",
      detail: "No benchmark source has user approval.",
      sources: [],
      models: new Map(),
    };
  }
  const results = await Promise.all(adapters.map(async (adapter) => {
    try {
      return await adapter.read(options.discovery);
    } catch (error) {
      return {
        sourceId: adapter.sourceId,
        status: "unavailable" as const,
        detail: `${adapter.sourceId} failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        releaseDate: null,
        fetchedAt: null,
        models: new Map<string, InventoryBenchmark[]>(),
      };
    }
  }));
  const models = new Map<string, InventoryBenchmark[]>();
  for (const result of results) {
    for (const [key, measurements] of result.models) {
      models.set(key, [...(models.get(key) ?? []), ...measurements]);
    }
  }
  const statuses = results.map(({ models: _models, ...status }) => status);
  const current = statuses.filter((source) => source.status === "current").length;
  const lastGood = statuses.filter((source) => source.status === "last-good").length;
  const unavailable = statuses.filter((source) => source.status === "unavailable").length;
  const blocked = statuses.filter((source) => source.status === "blocked").length;
  const active = statuses.length - blocked;
  const status = active > 0 && current === active
    ? "current"
    : active > 0 && lastGood === active
    ? "last-good"
    : blocked === statuses.length
    ? "blocked"
    : active > 0 && unavailable === active
    ? "unavailable"
    : "partial";
  return {
    status,
    detail:
      `${current} current, ${lastGood} last-good, ${unavailable} unavailable, ${blocked} blocked source(s).`,
    sources: statuses,
    models,
  };
}
