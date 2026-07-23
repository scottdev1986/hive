import { describe, expect, test } from "bun:test";
import { known, unknown, type CapabilityRecord } from "../../src/schemas/capability";
import { identifyModelVendor, type ProviderDiscovery } from "../../src/schemas/routing-derivation";

const AT = "2026-07-12T12:00:00.000Z";

function record(provider: "claude" | "codex", model: string, aliases: string[] = []): CapabilityRecord {
  const surface = provider === "claude" ? "claude.initialize" : "codex.model/list";
  return {
    provider,
    accountFingerprint: `${provider}:test`,
    cliVersion: "test",
    canonicalId: model,
    variant: null,
    launchToken: model,
    displayName: model,
    aliases,
    entitled: known(true, surface, AT),
    hidden: known(false, surface, AT),
    supportsEffort: unknown("surface-silent", surface, AT),
    supportedEffortLevels: unknown("surface-silent", surface, AT),
    defaultEffort: unknown("surface-silent", surface, AT),
    observedAt: AT,
  };
}

const effectiveDefault = (provider: "claude" | "codex") => ({
  provider,
  model: unknown<string>("field-absent", provider === "claude" ? "claude.initialize" : "codex.config/read", AT),
  effort: unknown<string>("field-absent", provider === "claude" ? "claude.initialize" : "codex.config/read", AT),
});

describe("identifyModelVendor", () => {
  test("identifies canonical ids, launch tokens, and aliases from vendor catalogs", () => {
    const discovery: Partial<Record<"claude" | "codex", ProviderDiscovery>> = {
      claude: { status: "ok", records: [record("claude", "claude-fable-5", ["best"])], effectiveDefault: effectiveDefault("claude") },
      codex: { status: "ok", records: [record("codex", "gpt-5.4")], effectiveDefault: effectiveDefault("codex") },
    };
    expect(identifyModelVendor("best", discovery)).toEqual({ state: "claimed", provider: "claude" });
    expect(identifyModelVendor("gpt-5.4", discovery)).toEqual({ state: "claimed", provider: "codex" });
  });

  test("fails closed when catalogs are unreadable, collide, or claim nothing", () => {
    const unreadable = { claude: { status: "unavailable", reason: "offline" } } as const;
    expect(identifyModelVendor("mystery", unreadable).state).toBe("unreadable");

    const collision: Partial<Record<"claude" | "codex" | "grok", ProviderDiscovery>> = {
      claude: { status: "ok", records: [record("claude", "shared")], effectiveDefault: effectiveDefault("claude") },
      codex: { status: "ok", records: [record("codex", "shared")], effectiveDefault: effectiveDefault("codex") },
      grok: { status: "ok", records: [], effectiveDefault: { provider: "grok", model: unknown<string>("field-absent", "grok.models", AT), effort: unknown<string>("field-absent", "grok.models", AT) } },
    };
    expect(identifyModelVendor("shared", collision).state).toBe("unreadable");
    expect(identifyModelVendor("absent", collision)).toEqual({ state: "unclaimed" });
  });
});
