import type {
  CapabilityProvider,
  CapabilityRecord,
  EffortTarget,
  ProviderDiscovery,
  RoutingCategory,
  RoutingPolicy,
} from "../schemas";
import {
  emptyRoutingPolicy,
  forEachProvider,
  providersOf,
  ROUTING_CATEGORIES,
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

export type InventoryRole = {
  category: RoutingCategory;
  /** The link's position in the user's chain: 0 is the primary, everything
   * after is the fallback order the user wrote. */
  position: number;
  effort: EffortTarget;
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
  /** The user's routing policy — roles are read from its chains, verbatim. */
  policy: RoutingPolicy;
  billing?: AccountBillings | null;
  now?: Date;
};

export type ModelInventoryReaderOptions = {
  discover?: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult>;
  readBilling?: typeof readBillingWithMemory;
  /** The policy store read. Absent means no policy is readable — models then
   * carry no roles, they do not vanish. A corrupt store THROWS through here:
   * the inventory refuses rather than rendering a permissive-looking blank. */
  readPolicy?: () => RoutingPolicy;
  now?: () => Date;
};

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
  const [discovery, billings] = await Promise.all([
    forEachProvider((provider) => discover(provider)),
    forEachProvider((provider) => readBilling(provider)),
  ]);
  const billing: AccountBillings = knownBillings(billings);
  const policy = options.readPolicy?.() ??
    emptyRoutingPolicy(now.toISOString());
  return buildModelInventory({ discovery, policy, billing, now });
}

const recordMatches = (record: CapabilityRecord, model: string): boolean =>
  record.canonicalId === model || record.launchToken === model ||
  record.aliases.includes(model);

/** The roles the USER gave this model: its position in each category chain.
 * Read from policy verbatim — Hive infers nothing. */
function rolesFor(record: CapabilityRecord, input: ModelInventoryInput): InventoryRole[] {
  const roles: InventoryRole[] = [];
  for (const category of ROUTING_CATEGORIES) {
    const chain = input.policy.chains[category] ?? [];
    chain.forEach((entry, position) => {
      if (entry.provider === record.provider && recordMatches(record, entry.model)) {
        roles.push({ category, position, effort: entry.effort });
      }
    });
  }
  return roles;
}

function whenUsed(record: CapabilityRecord, roles: readonly InventoryRole[]): string {
  if (roles.length === 0) {
    return record.hidden.state === "known" && record.hidden.value
      ? "Not used automatically: the vendor marks this model hidden."
      : "Not in any category chain; an explicit user request may still select it.";
  }
  return roles.map((role) =>
    role.position === 0
      ? `Primary for ${role.category}`
      : `Fallback ${role.position} for ${role.category}`
  ).join("; ") + ".";
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
