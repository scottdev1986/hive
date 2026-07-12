import { homedir } from "node:os";
import { join } from "node:path";
import { loadRoutingFloors, loadRoutingPins } from "../config/load";
import type {
  CapabilityProvider,
  CapabilityRecord,
  DerivedCell,
  DerivedRouting,
  ProviderDiscovery,
  RoutingTier,
} from "../schemas";
import {
  deriveRouting,
  forEachProvider,
  providersOf,
  RoutingSnapshotSchema,
  unknownVendor,
} from "../schemas";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
  GrokCapabilityProbe,
  type CapabilityDiscoveryResult,
} from "./capability-discovery";
import {
  knownBillings,
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

export type InventoryModel = {
  vendor: CapabilityProvider;
  canonicalId: string;
  variant: string | null;
  displayName: string | null;
  aliases: string[];
  /**
   * Three-valued, because the vendor STATING there is no effort axis
   * (`known-none`) and Hive failing to read one (`unknown`) are different
   * facts, and a UI that collapses them renders a lie. `known` with an empty
   * list is a third thing again: a surface that listed zero levels without
   * saying whether the axis exists.
   */
  effortLevels:
    | { state: "known"; values: string[] }
    | { state: "known-none"; detail: string }
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
  now?: Date;
};

export type ModelInventoryReaderOptions = {
  discover?: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult>;
  readBilling?: typeof readBillingWithMemory;
  readConsent?: (canonicalId: string) => "approved" | "denied" | "pending" | "none";
  now?: () => Date;
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
  // Each vendor is probed by its own probe. A vendor with no probe throws here
  // rather than being read through Codex's, which would answer with Codex's
  // models under the new vendor's name.
  const discover = options.discover ?? (async (provider) => {
    switch (provider) {
      case "claude":
        return await new ClaudeCapabilityProbe().read();
      case "codex":
        return await new CodexCapabilityProbe().read();
      case "grok":
        return await new GrokCapabilityProbe().read();
      default:
        return unknownVendor(provider, "model inventory probe");
    }
  });
  const readBilling = options.readBilling ?? readBillingWithMemory;
  // Every vendor Hive knows is probed and billed, not a hardcoded pair.
  const [pins, floors, snapshot, discovery, billings] = await Promise.all([
    loadRoutingPins(),
    loadRoutingFloors(),
    readSnapshot(),
    forEachProvider((provider) => discover(provider)),
    forEachProvider((provider) => readBilling(provider)),
  ]);
  const billing: AccountBillings = knownBillings(billings);
  const routing = deriveRouting({
    discovery,
    pins,
    floors,
    snapshot,
    billing,
    costConsent: options.readConsent,
    now,
  });
  const inventory = buildModelInventory({
    discovery,
    routing,
    billing,
    now,
  });
  return {
    ...inventory,
    warnings: [...routing.warnings, ...inventory.warnings],
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
    // A provider the derivation has no column for yet is unrouted, not
    // unrenderable: its models still appear, with no roles.
    const cell = tier[record.provider] as DerivedCell | undefined;
    if (cell === undefined) continue;
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
  // The one legal enumeration: the whole vendor union plus anything extra the
  // discovery record carries. "unavailable" is a legal state below; a vendor
  // that is simply ABSENT from the output is not, so nothing here may iterate
  // a hand-typed list. The `undefined` arm is the completeness assertion: a
  // union vendor missing from the record (only a cast or foreign JSON can do
  // that) renders as unreadable instead of vanishing.
  const inventoryProviders = providersOf(input.discovery);
  const discoveryOf = (provider: CapabilityProvider): ProviderDiscovery | undefined =>
    input.discovery[provider] as ProviderDiscovery | undefined;
  const records = inventoryProviders.flatMap((provider) => {
    const discovery = discoveryOf(provider);
    return discovery?.status === "ok" ? discovery.records : [];
  });
  const models = records.map((record): InventoryModel => {
    const roles = rolesFor(record, input);
    return {
      vendor: record.provider,
      canonicalId: record.canonicalId,
      variant: record.variant,
      displayName: record.displayName,
      aliases: [...record.aliases],
      effortLevels:
        record.supportsEffort.state === "known" && !record.supportsEffort.value
          ? {
              state: "known-none",
              detail: "the vendor states this model has no effort axis",
            }
          : record.supportedEffortLevels.state === "known"
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
    };
  }).sort((left, right) =>
    left.vendor.localeCompare(right.vendor) ||
    left.canonicalId.localeCompare(right.canonicalId) ||
    (left.variant ?? "").localeCompare(right.variant ?? "")
  );
  const providers = Object.fromEntries(
    inventoryProviders.map((provider) => {
      const discovery = discoveryOf(provider);
      return [provider, discovery === undefined
        ? {
            status: "unavailable" as const,
            reason: "never probed: absent from the discovery input",
          }
        : discovery.status === "ok"
        ? { status: "ok" as const, count: discovery.records.length }
        : { status: "unavailable" as const, reason: discovery.reason }];
    }),
  ) as ModelInventory["providers"];
  const warnings = inventoryProviders.flatMap((provider) => {
    const discovery = discoveryOf(provider);
    if (discovery === undefined) {
      return [`${provider} discovery is missing entirely: never probed; rendered unavailable rather than dropped`];
    }
    return discovery.status === "unavailable"
      ? [`${provider} discovery unavailable: ${discovery.reason}`]
      : [];
  });
  return {
    observedAt: (input.now ?? new Date()).toISOString(),
    complete: models.length === records.length &&
      inventoryProviders.every((provider) => discoveryOf(provider)?.status === "ok"),
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
  for (const provider of providersOf(inventory.providers)) {
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
        : model.effortLevels.state === "known-none"
        ? `none — ${model.effortLevels.detail}`
        : `unknown (${model.effortLevels.reason})`;
      lines.push(
        `  ${identity}`,
        `    entitlement ${model.entitlement}; plan ${model.plan.status}; hidden ${model.hidden}`,
        `    effort      ${efforts}`,
        `    when        ${model.when}`,
        `    discovered  ${model.provenance.observedAt} via ${model.provenance.surface}, CLI ${model.provenance.cliVersion}`,
      );
    }
  }
  for (const warning of inventory.warnings) lines.push(`\n! ${warning}`);
  return lines.join("\n");
}
