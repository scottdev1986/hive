import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_PROVIDERS,
  known,
  unknown,
  type CapabilityRecord,
  type CapabilitySurface,
  type RoutingPolicy,
} from "../schemas";
import { buildModelInventory, formatModelInventory } from "./model-inventory";

const AT = "2026-07-11T12:00:00.000Z";

function record(
  provider: "claude" | "codex",
  canonicalId: string,
  options: { hidden?: boolean; efforts?: string[] } = {},
): CapabilityRecord {
  const surface = provider === "claude" ? "claude.initialize" : "codex.model/list";
  return {
    provider,
    accountFingerprint: `${provider}:test`,
    cliVersion: provider === "claude" ? "2.1.207" : "0.144.1",
    canonicalId,
    variant: null,
    launchToken: canonicalId,
    displayName: canonicalId,
    aliases: [],
    entitled: known(true, surface, AT),
    hidden: known(options.hidden ?? false, surface, AT),
    supportsEffort: unknown("surface-silent", surface, AT),
    supportedEffortLevels: options.efforts === undefined
      ? unknown("field-absent", surface, AT)
      : known(options.efforts, surface, AT),
    defaultEffort: unknown("surface-silent", surface, AT),
    observedAt: AT,
  };
}

const fable = record("claude", "claude-fable-5", { efforts: ["high", "xhigh"] });
const hidden = record("codex", "gpt-hidden", { hidden: true });
const spare = record("codex", "gpt-spare");

const discovery = {
  claude: {
    status: "ok" as const,
    records: [fable],
    effectiveDefault: {
      provider: "claude" as const,
      model: known("claude-fable-5", "claude.initialize", AT),
      effort: unknown<string>("surface-silent", "claude.initialize", AT),
    },
  },
  codex: {
    status: "ok" as const,
    records: [hidden, spare],
    effectiveDefault: {
      provider: "codex" as const,
      model: known("gpt-spare", "codex.config/read", AT),
      effort: known("medium", "codex.config/read", AT),
    },
  },
  grok: { status: "unavailable" as const, reason: "not in fixture" },
};

const policy: RoutingPolicy = {
  schemaVersion: 1,
  revision: 1,
  updatedAt: AT,
  provisional: false,
  providers: {},
  models: [],
  chains: {
    complex_coding: [
      { provider: "claude", model: "claude-fable-5", effort: { mode: "exact", value: "xhigh" } },
      { provider: "codex", model: "gpt-hidden", effort: { mode: "provider-controlled" } },
    ],
  },
  selection: { global: "spread", categories: {} },
};

describe("model inventory", () => {
  test("renders every discovered record, including hidden and unrouted models", () => {
    const inventory = buildModelInventory({ discovery, policy, now: new Date(AT) });
    expect(inventory.complete).toBe(false);
    expect(inventory.discoveredCount).toBe(3);
    expect(inventory.renderedCount).toBe(3);
    expect(inventory.models.map((model) => model.canonicalId)).toEqual([
      "claude-fable-5",
      "gpt-hidden",
      "gpt-spare",
    ]);
    expect(inventory.models.find((model) => model.canonicalId === "gpt-hidden"))
      .toMatchObject({
        hidden: "hidden",
        routedCandidate: true,
        roles: [{ category: "complex_coding", position: 1, effort: { mode: "provider-controlled" } }],
      });
  });

  test("explains primary, fallback, and unrouted use in plain words", () => {
    const inventory = buildModelInventory({ discovery, policy, now: new Date(AT) });
    expect(inventory.models[0]?.when).toContain("Primary for complex_coding");
    expect(inventory.models[1]?.when).toContain("Fallback 1 for complex_coding");
    const unroutedPolicy = {
      ...policy,
      chains: { complex_coding: [policy.chains.complex_coding![0]!] },
    };
    const unrouted = buildModelInventory({ discovery, policy: unroutedPolicy });
    expect(unrouted.models.find((model) => model.canonicalId === "gpt-hidden")?.when)
      .toContain("Not used automatically");
  });

  test("renders the complete inventory and provenance for humans", () => {
    const text = formatModelInventory(
      buildModelInventory({ discovery, policy, now: new Date(AT) }),
    );
    expect(text).toContain("ALL DISCOVERED MODELS (3/3, INCOMPLETE)");
    expect(text).toContain("gpt-hidden");
    expect(text).toContain("Fallback 1 for complex_coding");
    expect(text).toContain("CLI 0.144.1");
  });

  test("an unavailable fresh discovery is empty and explicitly incomplete", () => {
    const empty = buildModelInventory({
      discovery: {
        claude: { status: "unavailable", reason: "CLI not installed" },
        codex: { status: "unavailable", reason: "discovery has not run" },
        grok: { status: "unavailable", reason: "discovery has not run" },
      },
      policy,
    });
    expect(empty).toMatchObject({
      complete: false,
      discoveredCount: 0,
      renderedCount: 0,
      models: [],
    });
    const text = formatModelInventory(empty);
    expect(text).toContain("0/0, INCOMPLETE");
    expect(text).toContain("claude — UNAVAILABLE: CLI not installed");
    expect(text).toContain("codex — UNAVAILABLE: discovery has not run");
  });

  test("a discovered model keeps its routes and every advertised effort", () => {
    // Ruling: a discovered, entitled model — and every effort level it
    // advertises — must be routable.
    const inventory = buildModelInventory({ discovery, policy, now: new Date(AT) });
    const model = inventory.models.find(
      (entry) => entry.canonicalId === "claude-fable-5",
    )!;
    expect(model.routedCandidate).toBeTrue();
    expect(model.roles).toContainEqual(
      expect.objectContaining({ category: "complex_coding", position: 0 }),
    );
    expect(model.effortLevels).toEqual({
      state: "known",
      values: ["high", "xhigh"],
    });
  });
});

describe("provider completeness: unavailable is a legal state, absent is impossible", () => {
  test("every vendor in the union appears even when its discovery is unavailable — grok included", () => {
    const inventory = buildModelInventory({ discovery, policy, now: new Date(AT) });
    expect(Object.keys(inventory.providers).sort())
      .toEqual([...CAPABILITY_PROVIDERS].sort());
    expect(inventory.providers.grok)
      .toEqual({ status: "unavailable", reason: "not in fixture" });
    expect(inventory.warnings)
      .toContain("grok discovery unavailable: not in fixture");
    expect(formatModelInventory(inventory))
      .toContain("grok — UNAVAILABLE: not in fixture");
  });

  test("a fourth, fake provider appears everywhere — readable as itself, unreadable as unavailable — with no edit to any other file", () => {
    // The governing acceptance test in miniature: a vendor Hive's inventory
    // code was never edited for must still be IMPOSSIBLE to erase. It may be
    // unavailable; it may never be absent.
    const acme = {
      ...record("codex", "acme-omega-1", { efforts: [] }),
      provider: "acme",
      // The vendor STATES there is no effort axis — known-none, not unknown.
      supportsEffort: known(false, "acme.models" as CapabilitySurface, AT),
    } as unknown as CapabilityRecord;
    const okDiscovery = {
      ...discovery,
      acme: {
        status: "ok" as const,
        records: [acme],
        effectiveDefault: {
          provider: "acme",
          model: known("acme-omega-1", "acme.models" as CapabilitySurface, AT),
          effort: unknown<string>("surface-silent", "acme.models" as CapabilitySurface, AT),
        },
      },
    } as unknown as typeof discovery;

    const inventory = buildModelInventory({
      discovery: okDiscovery,
      policy, // the derivation knows nothing about acme; unrouted ≠ invisible
      now: new Date(AT),
    });
    expect((inventory.providers as Record<string, unknown>).acme)
      .toEqual({ status: "ok", count: 1 });
    const model = inventory.models.find(
      (entry) => entry.canonicalId === "acme-omega-1",
    );
    expect(model).toBeDefined();
    expect(model!.roles).toEqual([]);
    expect(model!.when).toContain("Not in any category chain");
    expect(model!.effortLevels).toMatchObject({ state: "known-none" });
    const text = formatModelInventory(inventory);
    expect(text).toContain("acme — 1 discovered");
    expect(text).toContain("acme-omega-1");

    const dark = buildModelInventory({
      discovery: {
        ...discovery,
        acme: { status: "unavailable" as const, reason: "no probe answered" },
      } as unknown as typeof discovery,
      policy,
      now: new Date(AT),
    });
    expect((dark.providers as Record<string, unknown>).acme)
      .toEqual({ status: "unavailable", reason: "no probe answered" });
    expect(dark.warnings).toContain("acme discovery unavailable: no probe answered");
    expect(formatModelInventory(dark)).toContain("acme — UNAVAILABLE: no probe answered");
  });

  test("a union vendor missing from the discovery record entirely is rendered unreadable, never dropped", () => {
    // Only a cast (or decoded JSON from another build) can produce this state,
    // which is exactly why it must fail visible instead of failing silent.
    const { grok: _grok, ...partial } = discovery;
    const inventory = buildModelInventory({
      discovery: partial as unknown as typeof discovery,
      policy,
      now: new Date(AT),
    });
    expect(inventory.providers.grok.status).toBe("unavailable");
    expect(inventory.complete).toBe(false);
    expect(inventory.warnings.some((warning) => warning.startsWith("grok "))).toBeTrue();
  });
});

describe("effort is three-valued at the inventory edge", () => {
  test("a vendor-stated missing effort axis is known-none — not unknown, and not known-empty", () => {
    const flat = {
      ...record("codex", "gpt-flat", { efforts: [] }),
      supportsEffort: known(false, "codex.model/list", AT),
    };
    const inventory = buildModelInventory({
      discovery: {
        ...discovery,
        codex: { ...discovery.codex, records: [flat] },
      },
      policy,
      now: new Date(AT),
    });
    const model = inventory.models.find((entry) => entry.canonicalId === "gpt-flat")!;
    expect(model.effortLevels).toMatchObject({ state: "known-none" });
    expect(formatModelInventory(inventory)).toContain("effort      none —");
  });

  test("an advertised-but-empty level list without a vendor statement stays known-empty, distinct from known-none", () => {
    const bare = record("codex", "gpt-bare", { efforts: [] });
    const inventory = buildModelInventory({
      discovery: {
        ...discovery,
        codex: { ...discovery.codex, records: [bare] },
      },
      policy,
      now: new Date(AT),
    });
    const model = inventory.models.find((entry) => entry.canonicalId === "gpt-bare")!;
    expect(model.effortLevels).toEqual({ state: "known", values: [] });
    expect(formatModelInventory(inventory)).toContain("none advertised");
  });

  test("an unreadable effort surface stays unknown with its reason", () => {
    const inventory = buildModelInventory({ discovery, policy, now: new Date(AT) });
    const model = inventory.models.find((entry) => entry.canonicalId === "gpt-spare")!;
    expect(model.effortLevels).toEqual({
      state: "unknown",
      reason: "field-absent",
    });
  });
});
