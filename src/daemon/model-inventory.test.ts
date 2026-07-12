import { describe, expect, test } from "bun:test";
import {
  known,
  unknown,
  type CapabilityRecord,
  type DerivedRouting,
} from "../schemas";
import { buildModelInventory, formatModelInventory } from "./model-inventory";
import type { InventoryBenchmark } from "./benchmarks";

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

const routing: DerivedRouting = {
  derivedAt: AT,
  discovery,
  warnings: [],
  consentRequired: [],
  tiers: [{
    tier: "deep",
    kind: "coding",
    tool: { value: "claude", layer: "derived", reason: "test" },
    claude: {
      provider: "claude",
      model: { value: "claude-fable-5", layer: "derived", reason: "test" },
      effort: { value: "xhigh", layer: "derived", reason: "test" },
      chain: [],
      notes: [],
    },
    codex: {
      provider: "codex",
      model: { value: "gpt-spare", layer: "derived", reason: "test" },
      effort: { value: "medium", layer: "derived", reason: "test" },
      chain: ["gpt-hidden"],
      notes: [],
    },
    grok: {
      provider: "grok",
      model: { value: null, layer: "unknown", reason: "not in fixture" },
      effort: { value: null, layer: "unknown", reason: "not in fixture" },
      chain: [],
      notes: [],
    },
  }],
};

describe("model inventory", () => {
  test("renders every discovered record, including hidden and unrouted models", () => {
    const inventory = buildModelInventory({ discovery, routing, now: new Date(AT) });
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
        roles: [{ tier: "deep", use: "quota-fallback" }],
      });
  });

  test("explains primary, fallback, and unrouted use in plain words", () => {
    const inventory = buildModelInventory({ discovery, routing, now: new Date(AT) });
    expect(inventory.models[0]?.when).toContain("Primary for deep work");
    expect(inventory.models[1]?.when).toContain("Quota fallback for deep work");
    const unroutedRouting = {
      ...routing,
      tiers: routing.tiers.map((tier) => ({
        ...tier,
        codex: { ...tier.codex, chain: [] },
      })),
    };
    const unrouted = buildModelInventory({ discovery, routing: unroutedRouting });
    expect(unrouted.models.find((model) => model.canonicalId === "gpt-hidden")?.when)
      .toContain("Not used automatically");
  });

  test("renders the complete inventory and provenance for humans", () => {
    const text = formatModelInventory(
      buildModelInventory({ discovery, routing, now: new Date(AT) }),
    );
    expect(text).toContain("ALL DISCOVERED MODELS (3/3, INCOMPLETE)");
    expect(text).toContain("gpt-hidden");
    expect(text).toContain("Quota fallback for deep work");
    expect(text).toContain("CLI 0.144.1");
    expect(text).toContain("benchmark   unknown");
  });

  test("an unavailable fresh discovery is empty and explicitly incomplete", () => {
    const empty = buildModelInventory({
      discovery: {
        claude: { status: "unavailable", reason: "CLI not installed" },
        codex: { status: "unavailable", reason: "discovery has not run" },
        grok: { status: "unavailable", reason: "discovery has not run" },
      },
      routing: { ...routing, discovery: {
        claude: { status: "unavailable", reason: "CLI not installed" },
        codex: { status: "unavailable", reason: "discovery has not run" },
        grok: { status: "unavailable", reason: "discovery has not run" },
      } },
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

  test("corroborating sources stay separate without an approved materiality threshold", () => {
    const model = buildModelInventory({
      discovery,
      routing,
      benchmarks: new Map<string, InventoryBenchmark[]>([["claude\0claude-fable-5", [
        {
          sourceId: "other-bench",
          effort: "max",
          scores: { coding_index: 61 },
          source: "https://example.com/other-bench/2026-06.json",
          releaseDate: "2026-06",
          fetchedAt: AT,
        },
        {
          sourceId: "livebench",
          effort: "max",
          scores: { code_generation: 91.549 },
          source: "https://livebench.ai/table_2026_06_25.csv",
          releaseDate: "2026-06-25",
          fetchedAt: AT,
        },
      ]]]),
    }).models.find((entry) => entry.canonicalId === "claude-fable-5")!;
    expect(model.benchmarks).toHaveLength(2);
    expect(model.benchmarkComparison).toMatchObject({ status: "unassessed" });
    expect(model.benchmarkComparison.detail).toContain("does not average");
  });

  test("zero benchmark coverage never gates: an uncovered model keeps its routes and advertised efforts", () => {
    // Ruling: a discovered, entitled model — and every effort level it
    // advertises — must be routable. Benchmarks refine among capable
    // candidates when data exists; absence of data stays a visible "unknown"
    // and never excludes. No benchmarks are passed here at all.
    const inventory = buildModelInventory({ discovery, routing, now: new Date(AT) });
    const uncovered = inventory.models.find(
      (model) => model.canonicalId === "claude-fable-5",
    )!;
    expect(uncovered.benchmarks).toEqual([]);
    expect(uncovered.benchmarkComparison.status).toBe("unknown");
    expect(uncovered.routedCandidate).toBeTrue();
    expect(uncovered.roles).toContainEqual(
      expect.objectContaining({ tier: "deep", use: "primary" }),
    );
    expect(uncovered.effortLevels).toEqual({
      state: "known",
      values: ["high", "xhigh"],
    });
    expect(formatModelInventory(inventory)).toContain(
      "benchmark   unknown — no matching published result",
    );
  });
});
