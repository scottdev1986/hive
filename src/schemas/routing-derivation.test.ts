import { describe, expect, test } from "bun:test";
import {
  known,
  unknown,
  type CapabilityRecord,
  type EffectiveDefault,
} from "./capability";
import type { AccountBilling } from "../daemon/usage-credits";
import {
  DERIVED_FROM_DISCOVERY,
  deriveRouting,
  snapshotOf,
  TIER_EFFORT_POLICY,
  type DerivationInput,
  type ProviderDiscovery,
  type RoutingSnapshot,
} from "./routing-derivation";

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
    discovery: {
      claude: ok(CLAUDE_RECORDS, CLAUDE_DEFAULT),
      codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
    },
    pins: {},
    snapshot: null,
    billing: HEADROOM_BILLING,
    now: NOW,
    ...overrides,
  };
}

const tierOf = (derived: ReturnType<typeof deriveRouting>, tier: string) =>
  derived.tiers.find((entry) => entry.tier === tier)!;

describe("the derived route: the vendor's effective default, vouched live", () => {
  test("each cell derives the account's own effective default", () => {
    const deep = tierOf(deriveRouting(input()), "deep");
    expect(deep.claude.model.value).toBe("claude-opus-4-8");
    expect(deep.claude.model.layer).toBe("derived");
    expect(deep.claude.model.reason).toContain("effective unflagged launch");
    expect(deep.codex.model.value).toBe("gpt-5.6-sol");
    expect(deep.codex.model.layer).toBe("derived");
  });

  test("the tool is tier policy, and a pin outranks it", () => {
    const derived = deriveRouting(input({ pins: { deep: { tool: "codex" } } }));
    const deep = tierOf(derived, "deep");
    expect(deep.tool.value).toBe("codex");
    expect(deep.tool.layer).toBe("pinned");
    const cheap = tierOf(derived, "cheap");
    expect(cheap.tool.value).toBe("codex");
    expect(cheap.tool.layer).toBe("derived");
    expect(cheap.tool.reason).toContain("tier tool policy");
  });

  test("a coding cell says out loud that nothing vouches capability yet", () => {
    const deep = tierOf(deriveRouting(input()), "deep");
    expect(deep.claude.notes.join(" ")).toContain("no capability evidence");
  });

  test("an effective default no record vouches for is not derived", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(CLAUDE_RECORDS, {
          ...CLAUDE_DEFAULT,
          model: known("claude-mystery-6", "claude.initialize", FRESH),
        }),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBeNull();
    expect(deep.claude.notes.join(" ")).toContain("matches no record");
  });

  test("a stale record does not support derivation", () => {
    const stale = CLAUDE_RECORDS.map((entry) => ({
      ...entry,
      observedAt: ANCIENT,
    }));
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(stale, CLAUDE_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBeNull();
    expect(deep.claude.notes.join(" ")).toContain("stale record");
  });

  test("a discovery that declares no default is a refusal, not a guess", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(CLAUDE_RECORDS, {
          ...CLAUDE_DEFAULT,
          model: unknown("field-absent", "claude.initialize", FRESH),
        }),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBeNull();
    expect(deep.claude.model.reason).toContain("declared no usable default");
  });
});

describe("the pin: a standing user directive, never silently obeyed", () => {
  test("a pin wins the route and its conflicts are named", () => {
    const derived = deriveRouting(input({
      pins: { deep: { claude: { model: "claude-mystery-6" } } },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-mystery-6");
    expect(deep.claude.model.layer).toBe("pinned");
    expect(deep.claude.notes.join(" ")).toContain("no capability record");
  });

  test("a pin with only a stale record is honoured and reported", () => {
    const stale = [
      record("claude", "claude-fable-5", { observedAt: ANCIENT }),
      ...CLAUDE_RECORDS.slice(1),
    ];
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(stale, CLAUDE_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
      pins: { deep: { claude: { model: "claude-fable-5" } } },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-fable-5");
    expect(deep.claude.notes.join(" ")).toContain("stale record");
  });
});

// Fixture-only vendor ids for the floor tests below. Deliberately NOT real
// model names: a floor's actual allow-list is the user's own current,
// editable setting (never a durable Hive value), and the suite must not
// enshrine any particular choice of his as an expectation.
describe("capability floors: user-editable membership, unset by default", () => {
  const FIXTURE_WEAK = "fixture-vendor-weak";
  const FIXTURE_STRONG = "fixture-vendor-strong";
  const FIXTURE_FLAGSHIP = "fixture-vendor-flagship";

  const FLOOR_RECORDS = [
    record("claude", FIXTURE_WEAK, { displayName: "Weak" }),
    record("claude", FIXTURE_STRONG, { displayName: "Strong" }),
    record("claude", FIXTURE_FLAGSHIP, { displayName: "Flagship" }),
  ];

  const WEAK_DEFAULT: EffectiveDefault = {
    provider: "claude",
    model: known(FIXTURE_WEAK, "claude.initialize", FRESH),
    effort: unknown("surface-silent", "claude.initialize", FRESH),
  };
  const STRONG_DEFAULT: EffectiveDefault = {
    provider: "claude",
    model: known(FIXTURE_STRONG, "claude.initialize", FRESH),
    effort: unknown("surface-silent", "claude.initialize", FRESH),
  };

  const CLAUDE_FLOOR = { claude: { allow: [FIXTURE_STRONG, FIXTURE_FLAGSHIP] } };

  test("a below-floor derived candidate is excluded and the cell REFUSES, naming the floor", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, WEAK_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
      floors: CLAUDE_FLOOR,
    }));
    const standard = tierOf(derived, "standard");
    expect(standard.claude.model.value).toBeNull();
    expect(standard.claude.model.layer).toBe("unknown");
    expect(standard.claude.model.reason).toContain("capability floor");
    expect(standard.claude.model.reason).toContain(FIXTURE_WEAK);
    expect(derived.warnings.some((warning) => warning.includes("capability floor")))
      .toBe(true);
  });

  test("the review tier is floor-bound the same as deep and standard", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, WEAK_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
      floors: CLAUDE_FLOOR,
    }));
    const review = tierOf(derived, "review");
    expect(review.claude.model.value).toBeNull();
    expect(review.claude.model.reason).toContain("capability floor");
  });

  test("the cheap tier is exempt from the building floor", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, WEAK_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
      floors: CLAUDE_FLOOR,
    }));
    const cheap = tierOf(derived, "cheap");
    expect(cheap.claude.model.value).toBe(FIXTURE_WEAK);
    expect(cheap.claude.model.layer).toBe("derived");
  });

  test("a floor-clearing candidate routes and the evidence basis is named", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, STRONG_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
      floors: CLAUDE_FLOOR,
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe(FIXTURE_STRONG);
    expect(deep.claude.notes.join(" ")).toContain("clears the capability floor");
  });

  test("a pin below the floor is not honoured; derivation falls through and the conflict is named", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, STRONG_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
      pins: { standard: { claude: { model: FIXTURE_WEAK } } },
      floors: CLAUDE_FLOOR,
    }));
    const standard = tierOf(derived, "standard");
    // The effective default (the floor-clearing fixture) is what actually
    // routes — the pin never silently wins over the floor.
    expect(standard.claude.model.value).toBe(FIXTURE_STRONG);
    expect(standard.claude.model.layer).toBe("derived");
    expect(standard.claude.notes.join(" ")).toContain(
      "does not clear the capability floor",
    );
  });

  test("an unconfigured floor changes nothing — none is shipped, only the schema", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, WEAK_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
    }));
    const standard = tierOf(derived, "standard");
    expect(standard.claude.model.value).toBe(FIXTURE_WEAK);
    expect(standard.claude.model.layer).toBe("derived");
  });

  test("codex's floor is independent of claude's and excludes the same way", () => {
    const codexStrong = "fixture-codex-strong";
    const codexWeak = "fixture-codex-weak";
    const belowFloor: EffectiveDefault = {
      provider: "codex",
      model: known(codexWeak, "codex.config/read", FRESH),
      effort: unknown("surface-silent", "codex.config/read", FRESH),
    };
    const records = [record("codex", codexWeak, { displayName: "Codex Weak" })];
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, STRONG_DEFAULT),
        codex: ok(records, belowFloor),
      },
      floors: { codex: { allow: [codexStrong] } },
    }));
    const standard = tierOf(derived, "standard");
    expect(standard.codex.model.value).toBeNull();
    expect(standard.codex.model.reason).toContain("capability floor");
    expect(standard.codex.model.reason).toContain(codexWeak);
  });

  test("an optional note is carried through the schema, unread by enforcement", () => {
    const derived = deriveRouting(input({
      discovery: {
        claude: ok(FLOOR_RECORDS, STRONG_DEFAULT),
        codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
      },
      floors: {
        claude: { allow: [FIXTURE_STRONG], note: "picked for a specific project" },
      },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe(FIXTURE_STRONG);
  });
});

describe("availability and money gate the automatic choice", () => {
  const billing = (
    creditsOn: boolean | null,
    opusUsed: number,
  ): AccountBilling => ({
    creditsEnabled: creditsOn === null
      ? unknown("field-absent", "claude.get_usage", FRESH)
      : known(creditsOn, "claude.get_usage", FRESH),
    disabledReason: null,
    generalUtilization: known(10, "claude.get_usage", FRESH),
    modelUtilization: { opus: opusUsed },
  });

  test("an exhausted, unpayable default is refused as unavailable, silently to him", () => {
    const derived = deriveRouting(input({
      billing: { ...HEADROOM_BILLING, claude: billing(false, 100) },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBeNull();
    expect(deep.claude.notes.join(" ")).toContain("not routable");
    // No money is involved, so nothing asks him anything.
    expect(derived.consentRequired).toEqual([]);
  });

  test("an exhausted pool with credits ON asks him before spending", () => {
    const derived = deriveRouting(input({
      billing: { ...HEADROOM_BILLING, claude: billing(true, 100) },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBeNull();
    expect(deep.claude.notes.join(" ")).toContain("WOULD SPEND YOUR MONEY");
    expect(derived.consentRequired.map((entry) => entry.canonicalId))
      .toContain("claude-opus-4-8");
  });

  test("standing consent lets the guarded default route", () => {
    const derived = deriveRouting(input({
      billing: { ...HEADROOM_BILLING, claude: billing(true, 100) },
      costConsent: () => "approved",
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-opus-4-8");
    expect(derived.consentRequired).toEqual([]);
  });

  test("unreadable billing excludes the automatic route and asks", () => {
    const derived = deriveRouting(input({ billing: null }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBeNull();
    expect(derived.consentRequired.length).toBeGreaterThan(0);
  });

  test("a pinned model is never excluded by money, only asked about", () => {
    const derived = deriveRouting(input({
      billing: { ...HEADROOM_BILLING, claude: billing(true, 100) },
      pins: { deep: { claude: { model: "claude-opus-4-8" } } },
    }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-opus-4-8");
    expect(deep.claude.model.layer).toBe("pinned");
    expect(derived.consentRequired.map((entry) => entry.canonicalId))
      .toContain("claude-opus-4-8");
  });
});

describe("effort: chosen by tier policy, grounded in the live record", () => {
  test("the tier effort policy governs a derived codex cell", () => {
    const deep = tierOf(deriveRouting(input()), "deep");
    expect(deep.codex.effort.value).toBe(TIER_EFFORT_POLICY.deep);
    expect(deep.codex.effort.layer).toBe("derived");
    expect(deep.codex.effort.reason).toContain("tier effort policy");
    const cheap = tierOf(deriveRouting(input()), "cheap");
    expect(cheap.codex.effort.value).toBe("low");
  });

  test("a policy effort the record cannot ground is refused, not passed", () => {
    // The test claude records advertise no effort levels, so the tier's chosen
    // effort has no vendor evidence behind it: refused, and named on the cell.
    const deep = tierOf(deriveRouting(input()), "deep");
    expect(deep.claude.effort.value).toBeNull();
    expect(deep.claude.effort.layer).toBe("unknown");
    expect(deep.claude.notes.join(" ")).toContain("advertises no effort levels");
  });

  test("a claude record that advertises the level gets the tier effort", () => {
    const records = [
      CLAUDE_RECORDS[0]!,
      record("claude", "claude-opus-4-8", {
        aliases: ["default"],
        displayName: "Opus",
        supportedEffortLevels: known(
          ["low", "medium", "high", "xhigh", "max"],
          "claude.initialize",
          FRESH,
        ),
      }),
      ...CLAUDE_RECORDS.slice(2),
    ];
    const deep = tierOf(
      deriveRouting(input({
        discovery: {
          claude: ok(records, CLAUDE_DEFAULT),
          codex: ok(CODEX_RECORDS, CODEX_DEFAULT),
        },
      })),
      "deep",
    );
    expect(deep.claude.effort.value).toBe("high");
    expect(deep.claude.effort.layer).toBe("derived");
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

  test("a pinned model gets its own advertised default, not the tier policy", () => {
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

describe("the last-known-good rung guards discovery outages", () => {
  const STAMP = {
    derivedAt: "2026-07-11T10:00:00Z",
    manifestRevision: DERIVED_FROM_DISCOVERY,
  };

  const SNAPSHOT: RoutingSnapshot = {
    tiers: {
      deep: {
        tool: null,
        claude: { model: "claude-opus-4-8", effort: null, ...STAMP },
        codex: { model: "gpt-5.6-sol", effort: "high", ...STAMP },
      },
    },
  };

  const blind = { claude: down("claude is not signed in"), codex: down("no codex") };

  test("an outage rides the snapshot, labelled with its age, loudly", () => {
    const derived = deriveRouting(input({ discovery: blind, snapshot: SNAPSHOT }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBe("claude-opus-4-8");
    expect(deep.claude.model.layer).toBe("ladder:last-known-good");
    expect(deep.claude.model.reason).toContain("2h old");
    expect(derived.warnings.join(" ")).toContain("last-known-good");
  });

  test("the snapshot replays the effort derived WITH its model", () => {
    const deep = tierOf(
      deriveRouting(input({ discovery: blind, snapshot: SNAPSHOT })),
      "deep",
    );
    expect(deep.codex.effort.value).toBe("high");
    expect(deep.codex.effort.layer).toBe("ladder:last-known-good");
  });

  test("no discovery and no snapshot is a REFUSAL naming the CLI", () => {
    const derived = deriveRouting(input({ discovery: blind, snapshot: null }));
    const deep = tierOf(derived, "deep");
    expect(deep.claude.model.value).toBeNull();
    expect(deep.claude.model.layer).toBe("unknown");
    expect(deep.claude.model.reason).toContain("claude CLI");
    expect(deep.claude.model.reason).toContain("Hive ships no fallback");
    expect(derived.warnings.some((warning) => warning.includes("NO ROUTE")))
      .toBe(true);
  });
});

describe("the snapshot records only what was actually derived", () => {
  test("derived cells are kept; pinned ones are not; the source is stamped", () => {
    const derived = deriveRouting(
      input({ pins: { deep: { claude: { model: "claude-fable-5" } } } }),
    );
    const snapshot = snapshotOf(derived)!;
    // The pinned claude cell is absent: replaying a user's pin as
    // "last-known-good derived" would credit their choice to the engine.
    expect(snapshot.tiers.deep?.claude).toBeNull();
    expect(snapshot.tiers.deep?.codex).toEqual({
      model: "gpt-5.6-sol",
      effort: TIER_EFFORT_POLICY.deep,
      derivedAt: NOW.toISOString(),
      manifestRevision: DERIVED_FROM_DISCOVERY,
    });
  });

  test("a run that derived nothing writes no snapshot to launder later", () => {
    const derived = deriveRouting(
      input({ discovery: { claude: down("down"), codex: down("down") } }),
    );
    expect(snapshotOf(derived)).toBeNull();
  });

  test("a provider outage does not erase what the last healthy run derived", () => {
    const healthy = snapshotOf(deriveRouting(input()));
    const later = new Date("2026-07-11T14:00:00Z");
    const degraded = snapshotOf(
      deriveRouting(
        input({
          now: later,
          discovery: {
            claude: ok(
              CLAUDE_RECORDS.map((entry) => ({
                ...entry,
                observedAt: "2026-07-11T13:59:00Z",
              })),
              {
                ...CLAUDE_DEFAULT,
                model: known(
                  "claude-opus-4-8",
                  "claude.initialize",
                  "2026-07-11T13:59:00Z",
                ),
              },
            ),
            codex: down("codex is not installed"),
          },
        }),
      ),
      healthy,
    )!;
    // The codex cell survives at its true age.
    expect(degraded.tiers.deep?.codex).toEqual({
      model: "gpt-5.6-sol",
      effort: TIER_EFFORT_POLICY.deep,
      derivedAt: NOW.toISOString(),
      manifestRevision: DERIVED_FROM_DISCOVERY,
    });
    // Claude was healthy in the degraded run, so its cell is restamped.
    expect(degraded.tiers.review?.claude?.derivedAt).toBe(
      "2026-07-11T14:00:00.000Z",
    );
  });
});

describe("the live fit policy: benchmark evidence orders the real derivation", () => {
  const liveBenchRow = (effort: string, score: number) => ({
    sourceId: "livebench",
    effort,
    scores: { code_generation: score },
    releaseDate: "2026-06-25",
  });

  test("effort economy routes the lowest advertised effort measured within the band", () => {
    const derived = deriveRouting(input({
      benchmarks: new Map([["codex\0gpt-5.6-sol", [
        liveBenchRow("high", 90),
        liveBenchRow("medium", 87),
      ]]]),
    }));
    const cell = tierOf(derived, "deep").codex;
    // Tier policy routed "high"; medium is measured within 5 points of it, so
    // paying for high is waste and the policy routes medium — live, for real.
    expect(cell.effort.value).toBe("medium");
    expect(cell.effort.layer).toBe("derived");
    expect(cell.effort.reason).toContain("effort economy");
    expect(cell.effort.reason).toContain("code_generation=87");
    expect(cell.notes.some((note) => note.includes("fit policy (band=5"))).toBeTrue();
  });

  test("a materially weaker lower effort is not sufficient and the routed effort stands", () => {
    const derived = deriveRouting(input({
      benchmarks: new Map([["codex\0gpt-5.6-sol", [
        liveBenchRow("high", 90),
        liveBenchRow("medium", 80),
      ]]]),
    }));
    expect(tierOf(derived, "deep").codex.effort.value).toBe("high");
  });

  test("a pinned effort is the user's and the policy never moves it", () => {
    const derived = deriveRouting(input({
      pins: { deep: { codex: { effort: "high" } } },
      benchmarks: new Map([["codex\0gpt-5.6-sol", [
        liveBenchRow("high", 90),
        liveBenchRow("medium", 87),
      ]]]),
    }));
    const cell = tierOf(derived, "deep").codex;
    expect(cell.effort.value).toBe("high");
    expect(cell.effort.layer).toBe("pinned");
    expect(cell.notes.some((note) =>
      note.includes("effort is pinned and stays high")
    )).toBeTrue();
  });

  test("zero benchmark coverage changes nothing and the gap is named", () => {
    const bare = deriveRouting(input());
    const covered = deriveRouting(input({ benchmarks: new Map() }));
    for (const tier of ["deep", "standard", "cheap", "review"] as const) {
      expect(tierOf(covered, tier).codex.model.value)
        .toBe(tierOf(bare, tier).codex.model.value);
      expect(tierOf(covered, tier).codex.effort.value)
        .toBe(tierOf(bare, tier).codex.effort.value);
      expect(tierOf(covered, tier).claude.model.value)
        .toBe(tierOf(bare, tier).claude.model.value);
    }
    expect(tierOf(covered, "deep").codex.notes.some((note) =>
      note.includes("holds policy position")
    )).toBeTrue();
  });

  test("without a benchmark input the derivation is untouched — no note, no influence", () => {
    const derived = deriveRouting(input());
    expect(tierOf(derived, "deep").codex.notes.some((note) =>
      note.includes("fit policy")
    )).toBeFalse();
  });
});
