import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadHiveConfig,
  loadRoutingFloors,
  loadRoutingPins,
} from "../config/load";
import type {
  CapabilityProvider,
  CapabilityRecord,
  DerivedRouting,
  ProviderDiscovery,
  RoutingTier,
} from "../schemas";
import {
  deriveRouting,
  RoutingSnapshotSchema,
} from "../schemas";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
  type CapabilityDiscoveryResult,
} from "./capability-discovery";
import {
  poolAvailability,
  readBillingWithMemory,
  spendRisk,
  type AccountBillings,
} from "./usage-credits";
import {
  readBenchmarkCatalog,
  type BenchmarkCatalog,
  type BenchmarkMode,
  type InventoryBenchmark,
} from "./benchmarks";
import { configuredBenchmarkSources } from "./benchmark-sources";

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

export type InventoryRole = {
  tier: RoutingTier;
  use: "primary" | "quota-fallback";
  preferredProvider: boolean;
  effort: string | null;
};

export type InventoryModel = {
  vendor: CapabilityProvider;
  canonicalId: string;
  variant: string | null;
  displayName: string | null;
  aliases: string[];
  effortLevels:
    | { state: "known"; values: string[] }
    | { state: "unknown"; reason: string };
  entitlement: "entitled" | "not-entitled" | "unknown";
  hidden: "hidden" | "visible" | "unknown";
  plan: {
    status: "covered" | "unavailable" | "would-spend" | "unknown";
    detail: string;
  };
  routedCandidate: boolean;
  roles: InventoryRole[];
  when: string;
  provenance: {
    observedAt: string;
    surface: string;
    cliVersion: string;
  };
  benchmarks: InventoryBenchmark[];
  benchmarkComparison: {
    status: "unknown" | "single-source" | "unassessed";
    detail: string;
  };
};

export type ModelInventory = {
  observedAt: string;
  complete: boolean;
  discoveredCount: number;
  renderedCount: number;
  providers: Record<
    CapabilityProvider,
    { status: "ok"; count: number } | { status: "unavailable"; reason: string }
  >;
  benchmarks: {
    status: BenchmarkCatalog["status"] | "not-inspected";
    detail: string;
    sources: BenchmarkCatalog["sources"];
  };
  models: InventoryModel[];
  warnings: string[];
};

export type ModelInventoryInput = {
  discovery: Record<CapabilityProvider, ProviderDiscovery>;
  routing: DerivedRouting;
  billing?: AccountBillings | null;
  benchmarks?: ReadonlyMap<string, InventoryBenchmark[]>;
  benchmarkCatalog?: BenchmarkCatalog;
  now?: Date;
};

export type ModelInventoryReaderOptions = {
  discover?: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult>;
  readBilling?: typeof readBillingWithMemory;
  readConsent?: (canonicalId: string) => "approved" | "denied" | "pending" | "none";
  now?: () => Date;
  benchmarks?: ReadonlyMap<string, InventoryBenchmark[]>;
  readBenchmarks?: (
    mode: BenchmarkMode,
    discovery: Record<CapabilityProvider, ProviderDiscovery>,
  ) => Promise<BenchmarkCatalog>;
};

async function readSnapshot() {
  const file = Bun.file(join(hiveHome(), "routing-snapshot.json"));
  if (!(await file.exists())) return null;
  const parsed = RoutingSnapshotSchema.safeParse(
    await file.json().catch(() => null),
  );
  return parsed.success ? parsed.data : null;
}

export async function readModelInventory(
  options: ModelInventoryReaderOptions = {},
): Promise<ModelInventory> {
  const now = options.now?.() ?? new Date();
  const discover = options.discover ?? (async (provider) =>
    provider === "claude"
      ? await new ClaudeCapabilityProbe().read()
      : await new CodexCapabilityProbe().read());
  const readBilling = options.readBilling ?? readBillingWithMemory;
  const config = await loadHiveConfig();
  const [pins, floors, snapshot, claude, codex, claudeBilling, codexBilling] =
    await Promise.all([
      loadRoutingPins(),
      loadRoutingFloors(),
      readSnapshot(),
      discover("claude"),
      discover("codex"),
      readBilling("claude"),
      readBilling("codex"),
    ]);
  const discovery = { claude, codex };
  const benchmarkCatalog = await (
    options.readBenchmarks?.(config.benchmarks.mode, discovery) ??
      readBenchmarkCatalog({
        mode: config.benchmarks.mode,
        discovery,
        sources: configuredBenchmarkSources(),
      })
  );
  const billing: AccountBillings = {
    ...(claudeBilling === null ? {} : { claude: claudeBilling }),
    ...(codexBilling === null ? {} : { codex: codexBilling }),
  };
  const routing = deriveRouting({
    discovery,
    pins,
    floors,
    snapshot,
    // The same evidence the live spawn path uses, so the inventory's roles and
    // efforts are the ones a spawn would actually launch with.
    benchmarks: benchmarkCatalog.models,
    billing,
    costConsent: options.readConsent,
    now,
  });
  const inventory = buildModelInventory({
    discovery,
    routing,
    billing,
    benchmarks: options.benchmarks ?? benchmarkCatalog.models,
    benchmarkCatalog,
    now,
  });
  return {
    ...inventory,
    warnings: [
      ...routing.warnings,
      ...benchmarkCatalog.sources
        .filter((source) => source.status !== "current")
        .map((source) => source.detail),
      ...inventory.warnings,
    ],
  };
}

const recordMatches = (record: CapabilityRecord, model: string): boolean =>
  record.canonicalId === model || record.launchToken === model ||
  record.aliases.includes(model);

function concreteModel(
  provider: CapabilityProvider,
  model: string | null,
  discovery: ProviderDiscovery,
): string | null {
  if (model === null) return null;
  if (model !== "default") return model;
  return discovery.status === "ok" &&
      discovery.effectiveDefault.model.state === "known"
    ? discovery.effectiveDefault.model.value
    : null;
}

function rolesFor(record: CapabilityRecord, input: ModelInventoryInput): InventoryRole[] {
  const roles: InventoryRole[] = [];
  const discovery = input.discovery[record.provider];
  for (const tier of input.routing.tiers) {
    const cell = tier[record.provider];
    const primary = concreteModel(record.provider, cell.model.value, discovery);
    if (primary !== null && recordMatches(record, primary)) {
      roles.push({
        tier: tier.tier,
        use: "primary",
        preferredProvider: tier.tool.value === record.provider,
        effort: cell.effort.value,
      });
    }
    for (const alternative of cell.chain) {
      const concrete = concreteModel(record.provider, alternative, discovery);
      if (concrete !== null && recordMatches(record, concrete)) {
        roles.push({
          tier: tier.tier,
          use: "quota-fallback",
          preferredProvider: tier.tool.value === record.provider,
          effort: cell.effort.value,
        });
      }
    }
  }
  return roles;
}

function whenUsed(record: CapabilityRecord, roles: readonly InventoryRole[]): string {
  if (roles.length === 0) {
    return record.hidden.state === "known" && record.hidden.value
      ? "Not used automatically: the vendor marks this model hidden."
      : "Not currently used by any automatic route; an explicit user request may still select it.";
  }
  return roles.map((role) => {
    const route = role.preferredProvider
      ? `${role.tier} work when ${record.provider} is the preferred provider`
      : `${role.tier} work when ${record.provider} is explicitly requested or preferred routes lack capacity`;
    return role.use === "primary"
      ? `Primary for ${route}`
      : `Quota fallback for ${route}`;
  }).join("; ") + ".";
}

function planStatus(
  record: CapabilityRecord,
  billing: AccountBillings | null | undefined,
): InventoryModel["plan"] {
  const account = billing?.[record.provider];
  if (account === undefined || record.displayName === null) {
    return {
      status: "unknown",
      detail: account === undefined
        ? "Hive has no current plan or billing reading for this provider."
        : "The vendor catalog supplied no display name to join to its plan pools.",
    };
  }
  const availability = poolAvailability(account, record.displayName);
  if (availability.state === "exhausted") {
    return { status: "unavailable", detail: availability.detail };
  }
  const risk = spendRisk(account, record.displayName);
  return risk.state === "no-spend"
    ? { status: "covered", detail: risk.detail }
    : { status: risk.state, detail: risk.detail };
}

export function buildModelInventory(input: ModelInventoryInput): ModelInventory {
  const records = (["claude", "codex"] as const).flatMap((provider) => {
    const discovery = input.discovery[provider];
    return discovery.status === "ok" ? discovery.records : [];
  });
  const models = records.map((record): InventoryModel => {
    const roles = rolesFor(record, input);
    const benchmarkKey = `${record.provider}\0${record.canonicalId}`;
    return {
      vendor: record.provider,
      canonicalId: record.canonicalId,
      variant: record.variant,
      displayName: record.displayName,
      aliases: [...record.aliases],
      effortLevels: record.supportedEffortLevels.state === "known"
        ? { state: "known", values: [...record.supportedEffortLevels.value] }
        : {
            state: "unknown",
            reason: record.supportedEffortLevels.reason,
          },
      entitlement: record.entitled.state === "unknown"
        ? "unknown"
        : record.entitled.value
        ? "entitled"
        : "not-entitled",
      hidden: record.hidden.state === "unknown"
        ? "unknown"
        : record.hidden.value
        ? "hidden"
        : "visible",
      plan: planStatus(record, input.billing),
      routedCandidate: roles.length > 0,
      roles,
      when: whenUsed(record, roles),
      provenance: {
        observedAt: record.observedAt,
        surface: record.entitled.surface,
        cliVersion: record.cliVersion,
      },
      benchmarks: [...(input.benchmarks?.get(benchmarkKey) ?? [])],
      benchmarkComparison: comparisonFor(
        input.benchmarks?.get(benchmarkKey) ?? [],
      ),
    };
  }).sort((left, right) =>
    left.vendor.localeCompare(right.vendor) ||
    left.canonicalId.localeCompare(right.canonicalId) ||
    (left.variant ?? "").localeCompare(right.variant ?? "")
  );
  const providers = Object.fromEntries(
    (["claude", "codex"] as const).map((provider) => {
      const discovery = input.discovery[provider];
      return [provider, discovery.status === "ok"
        ? { status: "ok" as const, count: discovery.records.length }
        : { status: "unavailable" as const, reason: discovery.reason }];
    }),
  ) as ModelInventory["providers"];
  const warnings = (["claude", "codex"] as const).flatMap((provider) => {
    const discovery = input.discovery[provider];
    return discovery.status === "unavailable"
      ? [`${provider} discovery unavailable: ${discovery.reason}`]
      : [];
  });
  return {
    observedAt: (input.now ?? new Date()).toISOString(),
    complete: models.length === records.length &&
      Object.values(input.discovery).every((provider) => provider.status === "ok"),
    discoveredCount: records.length,
    renderedCount: models.length,
    providers,
    benchmarks: input.benchmarkCatalog === undefined ? {
      status: "not-inspected",
      detail: "Benchmark sources were not inspected for this inventory.",
      sources: [],
    } : {
      status: input.benchmarkCatalog.status,
      detail: input.benchmarkCatalog.detail,
      sources: input.benchmarkCatalog.sources,
    },
    models,
    warnings,
  };
}

function comparisonFor(
  benchmarks: readonly InventoryBenchmark[],
): InventoryModel["benchmarkComparison"] {
  const sources = new Set(benchmarks.map((row) => row.sourceId));
  if (sources.size === 0) {
    return { status: "unknown", detail: "No matching published result." };
  }
  if (sources.size === 1) {
    return {
      status: "single-source",
      detail: "No independent corroborating measurement matches this model and effort.",
    };
  }
  return {
    status: "unassessed",
    detail:
      "Multiple sources are shown separately; no materiality threshold is approved, so Hive does not average or grade their disagreement.",
  };
}

export function formatModelInventory(inventory: ModelInventory): string {
  const lines = [
    `Model inventory — ALL DISCOVERED MODELS (${inventory.renderedCount}/${inventory.discoveredCount}, ${
      inventory.complete ? "complete" : "INCOMPLETE"
    })`,
    `Benchmarks — ${inventory.benchmarks.status}: ${inventory.benchmarks.detail}`,
  ];
  for (const provider of ["claude", "codex"] as const) {
    const status = inventory.providers[provider];
    lines.push(
      "",
      status.status === "ok"
        ? `${provider} — ${status.count} discovered`
        : `${provider} — UNAVAILABLE: ${status.reason}`,
    );
    for (const model of inventory.models.filter((entry) => entry.vendor === provider)) {
      const identity = model.variant === null
        ? model.canonicalId
        : `${model.canonicalId}[${model.variant}]`;
      const efforts = model.effortLevels.state === "known"
        ? model.effortLevels.values.join(", ") || "none advertised"
        : `unknown (${model.effortLevels.reason})`;
      lines.push(
        `  ${identity}`,
        `    entitlement ${model.entitlement}; plan ${model.plan.status}; hidden ${model.hidden}`,
        `    effort      ${efforts}`,
        `    when        ${model.when}`,
        `    discovered  ${model.provenance.observedAt} via ${model.provenance.surface}, CLI ${model.provenance.cliVersion}`,
      );
      if (model.benchmarks.length === 0) {
        lines.push("    benchmark   unknown — no matching published result");
      } else {
        for (const benchmark of model.benchmarks) {
          const scores = Object.entries(benchmark.scores)
            .map(([name, score]) => `${name}=${score}`)
            .join(", ");
          lines.push(
            `    benchmark   ${benchmark.sourceId} effort=${benchmark.effort}; ${scores}; ${benchmark.source} release ${benchmark.releaseDate}, fetched ${benchmark.fetchedAt}`,
          );
        }
      }
      lines.push(
        `    compare     ${model.benchmarkComparison.status} — ${model.benchmarkComparison.detail}`,
      );
    }
  }
  for (const warning of inventory.warnings) lines.push(`\n! ${warning}`);
  return lines.join("\n");
}
