import { describe, expect, test } from "bun:test";
import { formatDerivedRouting } from "./routing";
import type { TrustedRoutingManifest } from "../config/routing-manifest";
import { known, unknown } from "../schemas/capability";
import {
  deriveRouting,
  DEFAULT_ROUTING,
  FIRST_ROUTING_MANIFEST,
  type ProviderDiscovery,
} from "../schemas";

const NOW = new Date("2026-07-11T12:00:00Z");

const down = (reason: string): ProviderDiscovery => ({
  status: "unavailable",
  reason,
});

const CODEX_UP: ProviderDiscovery = {
  status: "ok",
  records: [{
    provider: "codex",
    accountFingerprint: "acct",
    cliVersion: "0.144.1",
    canonicalId: "gpt-5.6-sol",
    variant: null,
    launchToken: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    aliases: [],
    entitled: known(true, "codex.model/list", "2026-07-11T11:59:00Z"),
    hidden: known(false, "codex.model/list", "2026-07-11T11:59:00Z"),
    supportsEffort: unknown("surface-silent", "codex.model/list", "2026-07-11T11:59:00Z"),
    supportedEffortLevels: known(["low", "medium"], "codex.model/list", "2026-07-11T11:59:00Z"),
    defaultEffort: known("medium", "codex.model/list", "2026-07-11T11:59:00Z"),
    observedAt: "2026-07-11T11:59:00Z",
  }],
  effectiveDefault: {
    provider: "codex",
    model: known("gpt-5.6-sol", "codex.config/read", "2026-07-11T11:59:00Z"),
    effort: known("xhigh", "codex.config/read", "2026-07-11T11:59:00Z"),
  },
};

const BUILT_IN: TrustedRoutingManifest = {
  manifest: FIRST_ROUTING_MANIFEST,
  origin: "built-in",
  detail: "no manifest installed; using the compiled-in manifest",
  warnings: [],
};

describe("the routing surface prints only what it derived", () => {
  const rendered = (discovery: Record<"claude" | "codex", ProviderDiscovery>) =>
    formatDerivedRouting(
      deriveRouting({
        manifest: FIRST_ROUTING_MANIFEST,
        discovery,
        pins: {},
        snapshot: null,
        shipped: DEFAULT_ROUTING,
        billing: {
          codex: {
            creditsEnabled: unknown(
              "surface-silent",
              "codex.account/rateLimits/read",
              "2026-07-11T11:59:00Z",
            ),
            disabledReason: null,
            generalUtilization: known(
              10,
              "codex.account/rateLimits/read",
              "2026-07-11T11:59:00Z",
            ),
            modelUtilization: {},
          },
        },
        now: NOW,
      }),
      NOW,
      BUILT_IN,
    );

  test("a value no layer could author prints as unknown, never as a guess", () => {
    const output = rendered({ claude: down("claude is not signed in"), codex: CODEX_UP });
    // Claude's whole column is unroutable, and the surface says so rather than
    // printing the shipped table's models as though they had been derived.
    expect(output).toContain("claude: UNAVAILABLE (claude is not signed in)");
    // Codex's effort was really derived, so it prints its value AND its source.
    expect(output).toContain("medium");
    expect(output).toContain("codex.model/list");
    // Claude's effort was not. It prints the em dash, and never a `medium` that
    // no vendor surface ever recommended.
    expect(output).toContain("—");
  });

  test("the header states that deriving is not routing", () => {
    const output = rendered({ claude: down("down"), codex: CODEX_UP });
    expect(output).toContain("INERT");
  });

  test("every fallback to the compiled-in table is named in the warnings", () => {
    const output = rendered({ claude: down("down"), codex: CODEX_UP });
    expect(output).toContain("WARNINGS");
    expect(output).toContain("ladder 3/shipped-table");
    expect(output).toContain("compatibility floor, not a derivation");
  });
});
