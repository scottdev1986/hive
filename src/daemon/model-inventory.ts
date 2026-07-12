import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BEST_MODEL } from "../adapters/tools/models";
import { loadHiveConfig, loadRoutingPins } from "../config/load";
import { loadTrustedRoutingManifest } from "../config/routing-manifest";
import type {
  CapabilityProvider,
  CapabilityRecord,
  DerivedRouting,
  ProviderDiscovery,
  RoutingTier,
} from "../schemas";
import {
  defaultRoutingTable,
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

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

export type InventoryRole = {
  tier: RoutingTier;
  use: "primary" | "quota-fallback";
  preferredProvider: boolean;
  effort: string | null;
};

export type InventoryBenchmark = {
  effort: string;
  scores: Record<string, number>;
  source: string;
  releaseDate: string;
  fetchedAt: string;
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
  models: InventoryModel[];
  warnings: string[];
};

export type ModelInventoryInput = {
  discovery: Record<CapabilityProvider, ProviderDiscovery>;
  routing: DerivedRouting;
  billing?: AccountBillings | null;
  benchmarks?: ReadonlyMap<string, InventoryBenchmark[]>;
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
  const trusted = await loadTrustedRoutingManifest(config);
  const [pins, snapshot, claude, codex, claudeBilling, codexBilling] =
    await Promise.all([
      loadRoutingPins(),
      trusted.origin === "kill-switch" ? null : readSnapshot(),
      discover("claude"),
      discover("codex"),
      readBilling("claude"),
      readBilling("codex"),
    ]);
  const discovery = { claude, codex };
  const billing: AccountBillings = {
    ...(claudeBilling === null ? {} : { claude: claudeBilling }),
    ...(codexBilling === null ? {} : { codex: codexBilling }),
  };
  const routing = deriveRouting({
    manifest: trusted.manifest,
    manifestAbsentReason: trusted.detail,
    discovery,
    pins,
    snapshot,
    shipped: defaultRoutingTable(),
    billing,
    costConsent: options.readConsent,
    now,
  });
  const inventory = buildModelInventory({
    discovery,
    routing,
    billing,
    benchmarks: options.benchmarks,
    now,
  });
  return {
    ...inventory,
    warnings: [...trusted.warnings, ...routing.warnings, ...inventory.warnings],
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
  if (provider === "claude" && model === "best") return CLAUDE_BEST_MODEL;
  if (model !== "default") return model;
  return discovery.status === "ok" &&
      discovery.effectiveDefault.model.state === "known"
    ? discovery.effectiveDefault.model.value
    : null;
}

function rolesFor(
  record: CapabilityRecord,
  routing: DerivedRouting,
): InventoryRole[] {
  const roles: InventoryRole[] = [];
  const discovery = routing.discovery[record.provider];
  for (const tier of routing.tiers) {
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
    const roles = rolesFor(record, input.routing);
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
    complete: models.length === records.length,
    discoveredCount: records.length,
    renderedCount: models.length,
    providers,
    models,
    warnings,
  };
}

export function formatModelInventory(inventory: ModelInventory): string {
  const lines = [
    `Model inventory — ALL DISCOVERED MODELS (${inventory.renderedCount}/${inventory.discoveredCount}, ${
      inventory.complete ? "complete" : "INCOMPLETE"
    })`,
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
            `    benchmark   effort=${benchmark.effort}; ${scores}; ${benchmark.source} release ${benchmark.releaseDate}, fetched ${benchmark.fetchedAt}`,
          );
        }
      }
    }
  }
  for (const warning of inventory.warnings) lines.push(`\n! ${warning}`);
  return lines.join("\n");
}
