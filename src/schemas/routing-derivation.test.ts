import { describe, expect, test } from "bun:test";
import {
  known,
  unknown,
  type CapabilityRecord,
  type EffectiveDefault,
} from "./capability";
import type { AccountBilling } from "../daemon/usage-credits";
import {
  deriveRouting,
  snapshotOf,
  type DerivationInput,
  type ProviderDiscovery,
  type RoutingSnapshot,
} from "./routing-derivation";
import { FIRST_ROUTING_MANIFEST, type RoutingManifest } from "./routing-manifest";
import { DEFAULT_ROUTING, defaultRoutingTable } from "./routing";

const NOW = new Date("2026-07-11T12:00:00Z");
const FRESH = "2026-07-11T11:59:00Z";
const ANCIENT = "2026-06-01T00:00:00Z";

function record(
  provider: "claude" | "codex",
  canonicalId: string,
  overrides: Partial<CapabilityRecord> = {},
): CapabilityRecord {
  const surface = provider === "claude" ? "claude.initialize" : "codex.model/list";
  return {
    provider,
    accountFingerprint: "acct",
    cliVersion: provider === "claude" ? "2.1.207" : "0.144.1",
    canonicalId,
    variant: null,
    launchToken: canonicalId,
    displayName: null,
    aliases: [],
    entitled: known(true, surface, FRESH),
    hidden: unknown("surface-silent", surface, FRESH),
    supportsEffort: unknown("surface-silent", surface, FRESH),
    supportedEffortLevels: unknown("field-absent", surface, FRESH),
    defaultEffort: unknown("surface-silent", surface, FRESH),
    observedAt: FRESH,
    ...overrides,
  };
}

const CLAUDE_RECORDS = [
  record("claude", "claude-fable-5", { displayName: "Fable" }),
  record("claude", "claude-opus-4-8", {
    aliases: ["default"],
    displayName: "Opus",
  }),
  record("claude", "claude-sonnet-5", { displayName: "Sonnet" }),
  record("claude", "claude-haiku-4-5-20251001", { displayName: "Haiku" }),
];

const CODEX_RECORDS = [
  record("codex", "gpt-5.6-sol", {
    displayName: "GPT-5.6-Sol",
    supportedEffortLevels: known(
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "codex.model/list",
      FRESH,
    ),
    defaultEffort: known("medium", "codex.model/list", FRESH),
  }),
];

const CLAUDE_DEFAULT: EffectiveDefault = {
  provider: "claude",
  model: known("claude-opus-4-8", "claude.initialize", FRESH),
  effort: unknown("surface-silent", "claude.initialize", FRESH),
};

const CODEX_DEFAULT: EffectiveDefault = {
  provider: "codex",
  model: known("gpt-5.6-sol", "codex.config/read", FRESH),
  effort: known("xhigh", "codex.config/read", FRESH),
};

const ok = (
  records: CapabilityRecord[],
  effectiveDefault: EffectiveDefault,
): ProviderDiscovery => ({ status: "ok", records, effectiveDefault });

const down = (reason: string): ProviderDiscovery => ({
  status: "unavailable",
  reason,
});

const HEADROOM_BILLING = {
  claude: {
    creditsEnabled: known(false, "claude.get_usage", FRESH),
    disabledReason: null,
    generalUtilization: known(10, "claude.get_usage", FRESH),
    modelUtilization: {},
  },
  codex: {
    creditsEnabled: unknown(
      "surface-silent",
      "codex.account/rateLimits/read",
      FRESH,
    ),
    disabledReason: null,
    generalUtilization: known(
      10,
      "codex.account/rateLimits/read",
      FRESH,
    ),
    modelUtilization: {},
  },
} satisfies NonNullable<DerivationInput["billing"]>;

function input(overrides: Partial<DerivationInput> = {}): DerivationInput {
  return {
    manifest: FIRST_ROUTING_MANIFEST,
    discovery: {
      claude: ok(CLAUDE_RECORDS, CLAUDE_DEFAULT),
      codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
    },
    pins: {},
    snapshot: null,
    shipped: DEFAULT_ROUTING,
    billing: HEADROOM_BILLING,
    now: NOW,
    ...overrides,
  };
}

const tierOf = (derived: ReturnType<typeof deriveRouting>, tier: string) =>
  derived.tiers.find((entry) => entry.tier === tier)!;

describe("the resolution order: pin → derived → ladder", () => {
  test("the derived route is the manifest list intersected with discovery", () => {
    const deep = tierOf(deriveRouting(input()), "deep");
    expect(deep.claude.model.value).toBe("claude-fable-5");
    expect(deep.claude.model.layer).toBe("derived");
    expect(deep.claude.model.reason).toContain(FIRST_ROUTING_MANIFEST.revision);
    // The list remainder is the downshift chain, as data instead of a hardcoded
    // Fable→Opus splice.
    expect(deep.claude.chain).toEqual(["claude-opus-4-8"]);
    expect(deep.tool.value).toBe("claude");
    expect(deep.tool.layer).toBe("derived");
  });

  test("a pin wins over the derived route and keeps the tier's chain", () => {
    const derived = deriveRouting(
      input({ pins: { deep: { claude: { model: "claude-opus-4-8" } } } }),
    );
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-opus-4-8");
    expect(deep.claude.model.layer).toBe("pinned");
    expect(deep.claude.model.reason).toContain("routing.toml");
    // A pin narrows what its cell says, not what the tier may do: the manifest
    // chain still appends after it, and quota may still substitute from it.
    expect(deep.claude.chain).toEqual(["claude-fable-5"]);
  });

  test("a pinned tool wins over the manifest's preferred provider", () => {
    const derived = deriveRouting(input({ pins: { deep: { tool: "codex" } } }));
    expect(tierOf(derived, "deep").tool).toMatchObject({
      value: "codex",
      layer: "pinned",
    });
  });
});

describe("a pin is never silently overridden and never silently obeyed", () => {
  test("a pinned model discovery cannot vouch for is used, and said so", () => {
    const derived = deriveRouting(
      input({ pins: { deep: { claude: { model: "claude-imaginary-9" } } } }),
    );
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-imaginary-9");
    expect(deep.claude.notes.join(" ")).toContain("no capability record");
  });

  test("a pinned model beneath the coding floor spawns anyway, loudly", () => {
    const manifest: RoutingManifest = {
      ...FIRST_ROUTING_MANIFEST,
      models: {
        ...FIRST_ROUTING_MANIFEST.models,
        "claude-sonnet-5": {},
      },
    };
    const derived = deriveRouting(
      input({
        manifest,
        pins: { deep: { claude: { model: "claude-sonnet-5" } } },
      }),
    );
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-sonnet-5");
    expect(deep.claude.notes.join(" ")).toContain("not declared coding-capable");
  });
});

describe("capability is eligibility: unknown means excluded, never inferred", () => {
  test("a model with no codingCapable declaration never enters the list", () => {
    const manifest: RoutingManifest = {
      ...FIRST_ROUTING_MANIFEST,
      models: {
        // Fable's declaration is withdrawn; Opus keeps its. Nothing may infer
        // Fable's capability back from its name or its tier position.
        ...FIRST_ROUTING_MANIFEST.models,
        "claude-fable-5": {},
      },
    };
    const deep = tierOf(deriveRouting(input({ manifest })), "deep");
    expect(deep.claude.model.value).toBe("claude-opus-4-8");
    expect(deep.claude.model.layer).toBe("derived");
    expect(deep.claude.chain).toEqual([]);
  });

  test("an undeclared model reached by the ladder is named, not laundered", () => {
    const manifest: RoutingManifest = {
      ...FIRST_ROUTING_MANIFEST,
      models: {},
    };
    const deep = tierOf(deriveRouting(input({ manifest })), "deep");
    // Nothing survives the intersection, so the ladder reaches the account's
    // effective default — which no manifest vouches for, and the cell says so.
    expect(deep.claude.model.layer).toBe("ladder:provider-default");
    expect(deep.claude.notes.join(" ")).toContain("not declared coding-capable");
  });

  test("a stale record does not support derivation", () => {
    const stale = CLAUDE_RECORDS.map((entry) => ({
      ...entry,
      observedAt: ANCIENT,
    }));
    const deep = tierOf(
      deriveRouting(
        input({
          discovery: {
            claude: ok(stale, CLAUDE_DEFAULT),
            codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
          },
        }),
      ),
      "deep",
    );
    expect(deep.claude.model.layer).not.toBe("derived");
  });
});

describe("the fallback ladder, rung by rung", () => {
  const STAMP = {
    derivedAt: "2026-07-11T10:00:00Z",
    manifestRevision: "initial",
  };

  const SNAPSHOT: RoutingSnapshot = {
    tiers: {
      deep: {
        tool: { value: "claude", ...STAMP },
        claude: { model: "claude-fable-5", effort: null, ...STAMP },
        codex: { model: "gpt-5.6-sol", effort: "medium", ...STAMP },
      },
    },
  };

  const blind = { claude: down("claude is not signed in"), codex: down("no codex") };

  test("rung 1: the last-known-good snapshot, labelled with its age", () => {
    const deep = tierOf(
      deriveRouting(input({ discovery: blind, snapshot: SNAPSHOT })),
      "deep",
    );
    expect(deep.claude.model.value).toBe("claude-fable-5");
    expect(deep.claude.model.layer).toBe("ladder:last-known-good");
    expect(deep.claude.model.reason).toContain("2h old");
    expect(deep.claude.model.reason).toContain("stale");
  });

  test("rung 1 replays the effort it derived WITH that model, not another rung's", () => {
    // The snapshot derived gpt-5.6-sol at `medium`. Falling to the shipped
    // table's `high` for the effort would launch the snapshot's model at a value
    // nobody ever chose for it — a cross-author pairing the ordering forbids.
    const deep = tierOf(
      deriveRouting(input({ discovery: blind, snapshot: SNAPSHOT })),
      "deep",
    );
    expect(deep.codex.model.layer).toBe("ladder:last-known-good");
    expect(deep.codex.effort.value).toBe("medium");
    expect(deep.codex.effort.layer).toBe("ladder:last-known-good");
  });

  test("rung 2: the provider's EFFECTIVE default, not the catalog's flag", () => {
    // Discovery is up and answers `config/read`; the manifest is gone, so no
    // candidate list exists and the ladder runs.
    const deep = tierOf(
      deriveRouting(input({ manifest: null, snapshot: null })),
      "deep",
    );
    expect(deep.codex.model.value).toBe("gpt-5.6-sol");
    expect(deep.codex.model.layer).toBe("ladder:provider-default");
    expect(deep.codex.model.reason).toContain("codex.config/read");
    // The effort of an unflagged launch is the config's, not the catalog's
    // per-model recommendation: those are different machines.
    expect(deep.codex.effort.value).toBe("xhigh");
    expect(deep.codex.effort.layer).toBe("ladder:provider-default");
  });

  test("rung 3: the shipped table, and it is loud about being one", () => {
    const derived = deriveRouting(
      input({ manifest: null, snapshot: null, discovery: blind }),
    );
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("best");
    expect(deep.claude.model.layer).toBe("ladder:shipped-table");
    expect(derived.warnings.join(" ")).toContain("compiled-in table");
    // Deduplicated: one warning per (tier, field), not one per cell per rung.
    expect(new Set(derived.warnings).size).toBe(derived.warnings.length);
  });

  test("an expired manifest derives nothing and says which rung failed", () => {
    const derived = deriveRouting(
      input({ now: new Date("2026-09-01T00:00:00Z"), snapshot: null }),
    );
    expect(derived.manifest?.expired).toBe(true);
    expect(derived.warnings.join(" ")).toContain("expired");
  });
});

describe("the spend guard: consent attaches to money, not to a model", () => {
  // No date, no model list. The guard exists to protect the user's wallet, so it
  // fires on the only thing that can empty it: a spawn that would overflow his
  // plan into PAID usage credits.
  const billing = (
    creditsOn: boolean | null,
    fableUsed: number,
  ): AccountBilling => ({
    creditsEnabled: creditsOn === null
      ? unknown("field-absent", "claude.get_usage", FRESH)
      : known(creditsOn, "claude.get_usage", FRESH),
    disabledReason: null,
    generalUtilization: known(10, "claude.get_usage", FRESH),
    modelUtilization: { fable: fableUsed },
  });

  const named = (records: CapabilityRecord[], now: Date) =>
    records.map((entry) => ({
      ...entry,
      displayName: entry.canonicalId === "claude-fable-5" ? "Fable" : "Opus",
      observedAt: new Date(now.getTime() - 60_000).toISOString(),
    }));

  const derive = (input_: Partial<DerivationInput>) => {
    const now = input_.now ?? NOW;
    return deriveRouting(
      input({
        discovery: {
          claude: ok(named(CLAUDE_RECORDS, now), CLAUDE_DEFAULT),
          codex: ok(named(CODEX_RECORDS, now), CODEX_DEFAULT),
        },
        ...input_,
      }),
    );
  };
  const deepOf = (derived: ReturnType<typeof deriveRouting>) =>
    derived.tiers.find((entry) => entry.tier === "deep")!;
  const measured = (claude: AccountBilling) => ({
    ...HEADROOM_BILLING,
    claude,
  });

  test("credits OFF + pool spent: nothing is ASKED, and nothing is ROUTED there", () => {
    // This test used to assert the model was routed anyway, on the grounds that
    // nothing can be charged. Half right, and the half it got wrong was the
    // expensive half: "a request past the plan limit is REFUSED, not billed" — so
    // there is indeed no charge to ask about, AND the vendor will not run it. The
    // old expectation launched a deep agent onto a model that cannot answer.
    //
    // Both halves now hold. The spend guard stays silent (a guard that nags a user
    // who cannot be charged is a broken guard), and the router falls through to the
    // next capable model that CAN run. No prompt, no approval, no dead agent.
    const derived = derive({ billing: measured(billing(false, 100)) });
    expect(derived.consentRequired).toEqual([]);
    expect(deepOf(derived).claude.model.value).toBe("claude-opus-4-8");
  });

  test("credits OFF and on plan: Fable is an ordinary candidate, after the old cutoff date", () => {
    const derived = derive({
      now: new Date("2026-07-12T00:00:01Z"),
      billing: measured(billing(false, 13)),
    });
    expect(deepOf(derived).claude.model.value).toBe("claude-fable-5");
    expect(deepOf(derived).claude.model.layer).toBe("derived");
  });

  test("credits ON + exhausted pool: it would spend real money, so it ASKS", () => {
    const derived = derive({ billing: measured(billing(true, 100)) });
    expect(derived.consentRequired).toEqual([
      expect.objectContaining({ canonicalId: "claude-fable-5" }),
    ]);
    // And it is not auto-routed while the question is unanswered: pending is not
    // a yes, and silence is not consent.
    expect(deepOf(derived).claude.model.value).toBe("claude-opus-4-8");
    expect(deepOf(derived).claude.notes.join(" ")).toContain("WOULD SPEND YOUR MONEY");
  });

  test("credits ON but the plan still covers it: no ask, because there is no spend", () => {
    // A false positive here trains him to click through, which destroys the guard
    // as surely as a false negative empties his wallet.
    const derived = derive({ billing: measured(billing(true, 13)) });
    expect(derived.consentRequired).toEqual([]);
    expect(deepOf(derived).claude.model.value).toBe("claude-fable-5");
  });

  test("approved consent lets it route again", () => {
    const derived = derive({
      billing: measured(billing(true, 100)),
      costConsent: (model) => model === "claude-fable-5" ? "approved" : "none",
    });
    expect(deepOf(derived).claude.model.value).toBe("claude-fable-5");
  });

  test("UNKNOWN never authorizes a charge: it asks", () => {
    const derived = derive({ billing: measured(billing(null, 100)) });
    expect(derived.consentRequired).toHaveLength(1);
    expect(deepOf(derived).claude.model.value).toBe("claude-opus-4-8");
  });

  test("a PIN settles the ROUTE; it does not settle the MONEY", () => {
    // Reversed deliberately. A pin used to be read as consent to be charged, on
    // the grounds that naming a model is an instruction — and it is, but it is an
    // instruction about WHICH MODEL, not an agreement to pay for it. Choosing a
    // model and agreeing to be billed for it are different permissions.
    //
    // So the pin still WINS THE ROUTE — the router never overrules him, and the
    // model below is exactly the one he pinned — but a spawn that would really be
    // billed raises the consent request, and the spawn path asks him once and
    // remembers. He is never silently charged for a choice he made about routing.
    const derived = derive({
      billing: measured(billing(true, 100)),
      pins: { deep: { claude: { model: "claude-fable-5" } } },
    });
    expect(deepOf(derived).claude.model.value).toBe("claude-fable-5");
    expect(derived.consentRequired.map((entry) => entry.canonicalId))
      .toEqual(["claude-fable-5"]);
  });

  test("a pin with credits OFF is never asked about, because nothing can be charged", () => {
    const derived = derive({
      billing: measured(billing(false, 100)),
      pins: { deep: { claude: { model: "claude-fable-5" } } },
    });
    expect(derived.consentRequired).toEqual([]);
    expect(deepOf(derived).claude.model.value).toBe("claude-fable-5");
  });
});

/** FIRST_ROUTING_MANIFEST with every tier's chosen effort stripped, for tests
 * that exercise the rungs below the tier default. */
const manifestWithoutTierEfforts = (): RoutingManifest => ({
  ...FIRST_ROUTING_MANIFEST,
  tiers: Object.fromEntries(
    Object.entries(FIRST_ROUTING_MANIFEST.tiers).map((
      [tier, { defaultEffort: _, ...rest }],
    ) => [tier, rest]),
  ) as RoutingManifest["tiers"],
});

describe("effort resolves against the resolved model, never in parallel", () => {
  test("the manifest's tier effort governs a derived codex cell", () => {
    // The tier CHOOSES the effort (deep=high); the model's own advertised
    // default (medium) informs a human editing the manifest, never the cell.
    const deep = tierOf(deriveRouting(input()), "deep");
    expect(deep.codex.effort.value).toBe("high");
    expect(deep.codex.effort.layer).toBe("derived");
    expect(deep.codex.effort.reason).toContain("[deep].defaultEffort");
  });

  test("without a tier effort, codex falls to the model's advertised default", () => {
    const deep = tierOf(
      deriveRouting(input({ manifest: manifestWithoutTierEfforts() })),
      "deep",
    );
    expect(deep.codex.effort.value).toBe("medium");
    expect(deep.codex.effort.layer).toBe("derived");
    expect(deep.codex.effort.reason).toContain("codex.model/list");
  });

  test("a tier effort the model's record cannot ground is refused, not passed", () => {
    // The test claude records advertise no effort levels, so the tier's chosen
    // "high" has no vendor evidence behind it: a derived effort is refused
    // rather than guessed, and the refusal is named on the cell.
    const deep = tierOf(deriveRouting(input()), "deep");
    expect(deep.claude.effort.value).toBeNull();
    expect(deep.claude.effort.layer).toBe("unknown");
    expect(deep.claude.notes.join(" ")).toContain("advertises no effort levels");
  });

  test("a claude record that advertises the level gets the tier effort", () => {
    const records = [
      record("claude", "claude-fable-5", {
        displayName: "Fable",
        supportedEffortLevels: known(
          ["low", "medium", "high", "xhigh", "max"],
          "claude.initialize",
          FRESH,
        ),
      }),
      ...CLAUDE_RECORDS.slice(1),
    ];
    const deep = tierOf(
      deriveRouting(
        input({
          discovery: {
            claude: ok(records, CLAUDE_DEFAULT),
            codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
          },
        }),
      ),
      "deep",
    );
    expect(deep.claude.effort.value).toBe("high");
    expect(deep.claude.effort.layer).toBe("derived");
  });

  test("with neither tier effort nor a claude default, nothing fills the gap", () => {
    const deep = tierOf(
      deriveRouting(input({ manifest: manifestWithoutTierEfforts() })),
      "deep",
    );
    expect(deep.claude.effort.value).toBeNull();
    expect(deep.claude.effort.layer).toBe("unknown");
    expect(deep.claude.effort.reason).toContain("awaits the live statusLine");
  });

  test("the manifest's per-tier default outranks the model's own", () => {
    const manifest: RoutingManifest = {
      ...FIRST_ROUTING_MANIFEST,
      tiers: {
        ...FIRST_ROUTING_MANIFEST.tiers,
        cheap: { ...FIRST_ROUTING_MANIFEST.tiers.cheap!, defaultEffort: "low" },
      },
    };
    const cheap = tierOf(deriveRouting(input({ manifest })), "cheap");
    expect(cheap.codex.effort.value).toBe("low");
    expect(cheap.codex.effort.layer).toBe("derived");
  });

  test("a pinned effort the model never advertised is honoured and reported", () => {
    const derived = deriveRouting(
      input({ pins: { deep: { codex: { effort: "hyper" } } } }),
    );
    const deep = tierOf(derived, "deep");
    expect(deep.codex.effort.value).toBe("hyper");
    expect(deep.codex.effort.layer).toBe("pinned");
    expect(deep.codex.notes.join(" ")).toContain("not among the levels");
  });

  test("a manifest effort the model never advertised is refused, not passed", () => {
    const manifest: RoutingManifest = {
      ...FIRST_ROUTING_MANIFEST,
      tiers: {
        ...FIRST_ROUTING_MANIFEST.tiers,
        deep: { ...FIRST_ROUTING_MANIFEST.tiers.deep!, defaultEffort: "hyper" },
      },
    };
    const deep = tierOf(deriveRouting(input({ manifest })), "deep");
    expect(deep.codex.effort.value).toBeNull();
    expect(deep.codex.effort.layer).toBe("unknown");
    expect(deep.codex.notes.join(" ")).toContain("refused effort hyper");
  });

  test("a pinned model gets its own effort, never the primary candidate's", () => {
    // Pin a codex model whose record advertises a different default. A per-field
    // layer merge would hand it the effort derived for gpt-5.6-sol.
    const records = [
      ...CODEX_RECORDS,
      record("codex", "gpt-5.6-luna", {
        supportedEffortLevels: known(["low", "high"], "codex.model/list", FRESH),
        defaultEffort: known("low", "codex.model/list", FRESH),
      }),
    ];
    const derived = deriveRouting(
      input({
        discovery: {
          claude: ok(CLAUDE_RECORDS, CLAUDE_DEFAULT),
          codex: ok(records, CODEX_DEFAULT),
        },
        pins: { deep: { codex: { model: "gpt-5.6-luna" } } },
      }),
    );
    const deep = tierOf(derived, "deep");
    expect(deep.codex.model.value).toBe("gpt-5.6-luna");
    expect(deep.codex.effort.value).toBe("low");
  });
});

describe("the snapshot records only what was actually derived", () => {
  test("derived cells are kept; pinned and laddered ones are not", () => {
    const derived = deriveRouting(
      input({ pins: { deep: { claude: { model: "claude-opus-4-8" } } } }),
    );
    const snapshot = snapshotOf(derived)!;
    // The pinned claude cell is absent: replaying a user's pin as
    // "last-known-good derived" would credit their choice to the engine.
    expect(snapshot.tiers.deep?.claude).toBeNull();
    expect(snapshot.tiers.deep?.codex).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
      derivedAt: NOW.toISOString(),
      manifestRevision: FIRST_ROUTING_MANIFEST.revision,
    });
  });

  test("a run that derived nothing writes no snapshot to launder later", () => {
    const derived = deriveRouting(
      input({
        manifest: null,
        discovery: { claude: down("down"), codex: down("down") },
      }),
    );
    expect(snapshotOf(derived)).toBeNull();
  });

  test("a provider outage does not erase what the last healthy run derived", () => {
    // Run 1: both providers up. Run 2: codex is gone. Run 2 must not wipe the
    // codex cells — they are the whole reason rung 1 exists — and the cells it
    // carries forward keep their true age rather than being restamped as fresh.
    const healthy = snapshotOf(deriveRouting(input()));
    const later = new Date("2026-07-11T14:00:00Z");
    const degraded = snapshotOf(
      deriveRouting(
        input({
          now: later,
          discovery: {
            claude: ok(
              // Re-read at 13:59, so these are fresh at 14:00. (The records the
              // healthy run used would be two hours stale by now, and a stale
              // record does not support derivation.)
              CLAUDE_RECORDS.map((entry) => ({
                ...entry,
                observedAt: "2026-07-11T13:59:00Z",
              })),
              CLAUDE_DEFAULT,
            ),
            codex: down("codex is not installed"),
          },
        }),
      ),
      healthy,
    )!;
    expect(degraded.tiers.deep?.codex).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
      derivedAt: NOW.toISOString(),
      manifestRevision: FIRST_ROUTING_MANIFEST.revision,
    });
    // Claude was healthy in the degraded run, so its cell is restamped.
    expect(degraded.tiers.review?.claude?.derivedAt).toBe(
      "2026-07-11T14:00:00.000Z",
    );
  });
});
