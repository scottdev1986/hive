import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGoverningRoute, type RoutingIo } from "./routing-resolve";
import { known, unknown } from "../schemas/capability";
import type { CapabilityRecord } from "../schemas";
import type { CapabilityDiscoveryResult } from "./capability-discovery";
import type { AccountBilling } from "./usage-credits";

/**
 * The governing route's invariants, in the manifest-less world: every spawn
 * derives from live discovery + pins + last-known-good, a cell nothing can
 * author is a refusal the spawner fails on, and no config switch can revert to
 * a shipped table, because there is none.
 */

const NOW = new Date("2026-07-12T12:00:00Z");
const OBSERVED = "2026-07-12T11:59:00Z";

const record = (
  overrides: Partial<CapabilityRecord> & Pick<CapabilityRecord, "provider" | "canonicalId">,
): CapabilityRecord => ({
  accountFingerprint: "acct",
  cliVersion: "2.1.207",
  variant: null,
  launchToken: overrides.canonicalId,
  displayName: overrides.canonicalId,
  aliases: [],
  entitled: known(true, "claude.initialize", OBSERVED),
  hidden: unknown("surface-silent", "claude.initialize", OBSERVED),
  supportsEffort: unknown("surface-silent", "claude.initialize", OBSERVED),
  supportedEffortLevels: unknown("surface-silent", "claude.initialize", OBSERVED),
  defaultEffort: unknown("surface-silent", "claude.initialize", OBSERVED),
  observedAt: OBSERVED,
  ...overrides,
});

const CLAUDE: CapabilityDiscoveryResult = {
  status: "ok",
  records: [
    record({ provider: "claude", canonicalId: "claude-fable-5" }),
    record({ provider: "claude", canonicalId: "claude-opus-4-8" }),
    record({ provider: "claude", canonicalId: "claude-sonnet-5", aliases: ["sonnet"] }),
    record({
      provider: "claude",
      canonicalId: "claude-haiku-4-5-20251001",
      aliases: ["haiku"],
    }),
  ],
  effectiveDefault: {
    provider: "claude",
    model: known("claude-opus-4-8", "claude.initialize", OBSERVED),
    effort: unknown("surface-silent", "claude.initialize", OBSERVED),
  },
};

const CODEX: CapabilityDiscoveryResult = {
  status: "ok",
  records: [
    record({
      provider: "codex",
      canonicalId: "gpt-5.6-sol",
      cliVersion: "0.144.1",
      supportedEffortLevels: known(
        ["low", "medium", "high", "xhigh"],
        "codex.model/list",
        OBSERVED,
      ),
      defaultEffort: known("medium", "codex.model/list", OBSERVED),
    }),
  ],
  effectiveDefault: {
    provider: "codex",
    model: known("gpt-5.6-sol", "codex.config/read", OBSERVED),
    effort: known("xhigh", "codex.config/read", OBSERVED),
  },
};

/** Credits OFF: nothing can be charged, so the spend guard cannot fire. */
const FREE: AccountBilling = {
  creditsEnabled: known(false, "claude.get_usage", OBSERVED),
  disabledReason: null,
  generalUtilization: known(20, "claude.get_usage", OBSERVED),
  modelUtilization: {},
};

/** Credits ON and the pool exhausted: the next spawn is billed to the user. */
const BILLED: AccountBilling = {
  creditsEnabled: known(true, "claude.get_usage", OBSERVED),
  disabledReason: null,
  generalUtilization: known(100, "claude.get_usage", OBSERVED),
  modelUtilization: { "claude-opus-4-8": 100 },
};

const io = (billing: Record<"claude" | "codex", AccountBilling | null> = {
  claude: FREE,
  codex: FREE,
}): RoutingIo => ({
  discover: async (provider) => provider === "claude" ? CLAUDE : CODEX,
  readBilling: async (provider) => billing[provider],
  now: () => NOW,
});

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hive-governing-"));
  Bun.env.HIVE_HOME = home;
});

afterEach(async () => {
  delete Bun.env.HIVE_HOME;
  await rm(home, { recursive: true, force: true });
});

const config = (toml: string) => Bun.write(join(home, "config.toml"), toml);
const pins = (toml: string) => Bun.write(join(home, "routing.toml"), toml);

describe("the derivation engine governs every spawn", () => {
  test("it names concrete models, learned from the account itself", async () => {
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing).not.toBeNull();
    expect(governing!.tool).toBe("claude");
    expect(governing!.cells.claude.model).toBe("claude-opus-4-8");
    expect(governing!.cells.codex.model).toBe("gpt-5.6-sol");
  });

  test("the codex effort is the tier's chosen one, grounded in the record", async () => {
    // The policy chooses deep=high; the record advertises high, so the choice
    // is grounded and passes. The model's own default (medium) informs a human
    // editing the policy — it does not silently govern the cell.
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing!.cells.codex.effort).toBe("high");
  });

  test("a tier effort the record cannot ground is refused, not defaulted", async () => {
    const codex: CapabilityDiscoveryResult = {
      ...CODEX,
      records: [{
        ...CODEX.records[0]!,
        supportedEffortLevels: known(
          ["low", "medium"],
          "codex.model/list",
          OBSERVED,
        ),
      }],
    };
    const governing = await resolveGoverningRoute("deep", {
      ...io(),
      discover: async (provider) => provider === "claude" ? CLAUDE : codex,
    });
    expect(governing!.cells.codex.model).toBe("gpt-5.6-sol");
    expect(governing!.cells.codex.effort).toBeUndefined();
    expect(governing!.notes.join(" ")).toContain("refused effort high");
  });

  test("the old escape hatches are parsed but revert to nothing", async () => {
    // There is no shipped table left: `router = "shipped"` and
    // `routingManifest = "off"` still parse (a config written for an older
    // build must not brick this one) but the engine governs regardless.
    await config('router = "shipped"\nroutingManifest = "off"\n');
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing).not.toBeNull();
    expect(governing!.cells.claude.model).toBe("claude-opus-4-8");
  });
});

describe("what governs may never break", () => {
  test("a routing.toml pin outranks the engine, always", async () => {
    await pins('[deep]\ntool = "codex"\n\n[deep.claude]\nmodel = "claude-fable-5"\n');
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing!.tool).toBe("codex");
    expect(governing!.cells.claude.model).toBe("claude-fable-5");
  });

  test("a seeded routing.toml floor refuses a below-floor standard-tier claude resolution", async () => {
    await pins('[floors.claude]\nallow = ["claude-opus-4-8", "claude-fable-5"]\n');
    const sonnetDefault: CapabilityDiscoveryResult = {
      ...CLAUDE,
      effectiveDefault: {
        provider: "claude",
        model: known("claude-sonnet-5", "claude.initialize", OBSERVED),
        effort: unknown("surface-silent", "claude.initialize", OBSERVED),
      },
    };
    const governing = await resolveGoverningRoute("standard", {
      ...io(),
      discover: async (provider) => provider === "claude" ? sonnetDefault : CODEX,
    });
    expect(governing!.cells.claude.model).toBeNull();
    expect(governing!.cells.claude.reason).toContain("capability floor");
    expect(governing!.cells.claude.reason).toContain("claude-sonnet-5");
  });

  test("the same seeded floor leaves the cheap tier untouched", async () => {
    await pins('[floors.claude]\nallow = ["claude-opus-4-8", "claude-fable-5"]\n');
    const sonnetDefault: CapabilityDiscoveryResult = {
      ...CLAUDE,
      effectiveDefault: {
        provider: "claude",
        model: known("claude-sonnet-5", "claude.initialize", OBSERVED),
        effort: unknown("surface-silent", "claude.initialize", OBSERVED),
      },
    };
    const governing = await resolveGoverningRoute("cheap", {
      ...io(),
      discover: async (provider) => provider === "claude" ? sonnetDefault : CODEX,
    });
    expect(governing!.cells.claude.model).toBe("claude-sonnet-5");
  });

  test("no cell offers quota a downshift chain yet", async () => {
    // The manifest's ordered candidate lists are gone; until the benchmark
    // surface or user policy supplies one, there is nothing vetted to
    // downshift onto — an empty chain, not a guessed one.
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing!.chain.claude).toEqual([]);
    expect(governing!.chain.codex).toEqual([]);
  });

  test("the spend guard still refuses to auto-route into a charge", async () => {
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: BILLED, codex: FREE }),
    );
    // The account default would be billed, so the router does not choose it on
    // Hive's own authority — the cell refuses and says why; the codex column
    // still stands.
    expect(governing!.cells.claude.model).toBeNull();
    expect(governing!.notes.join(" ")).toContain("WOULD SPEND YOUR MONEY");
    expect(governing!.cells.codex.model).toBe("gpt-5.6-sol");
  });

  test("an unreadable billing surface is not read as free", async () => {
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: null, codex: FREE }),
    );
    expect(governing!.cells.claude.model).toBeNull();
    expect(governing!.notes.join(" ")).toContain("cannot rule out a charge");
  });

  test("an exhausted, unpayable default refuses as unavailable, not as a charge", async () => {
    const creditOnly: AccountBilling = {
      creditsEnabled: known(false, "claude.get_usage", OBSERVED),
      disabledReason: null,
      generalUtilization: known(30, "claude.get_usage", OBSERVED),
      modelUtilization: { "claude-opus-4-8": 100 },
    };
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: creditOnly, codex: FREE }),
    );
    expect(governing!.cells.claude.model).toBeNull();
    expect(governing!.notes.join(" ")).toContain("is not routable");
    expect(governing!.notes.join(" ")).not.toContain("WOULD SPEND YOUR MONEY");
  });
});

describe("outage and refusal", () => {
  const dead: RoutingIo = {
    discover: async () => ({
      status: "unavailable",
      reason: "not signed in",
    }),
    readBilling: async () => null,
    now: () => NOW,
  };

  test("a discovery outage rides the last-known-good snapshot, loudly", async () => {
    await writeFile(
      join(home, "routing-snapshot.json"),
      JSON.stringify({
        tiers: {
          deep: {
            tool: null,
            claude: {
              model: "claude-opus-4-8",
              effort: null,
              derivedAt: "2026-07-12T10:00:00Z",
              manifestRevision: "discovery",
            },
            codex: null,
          },
        },
      }),
    );
    const governing = await resolveGoverningRoute("deep", dead);
    expect(governing!.cells.claude.model).toBe("claude-opus-4-8");
    expect(governing!.cells.claude.reason).toContain("stale");
  });

  test("nothing derivable is a refusal that names what Hive needs", async () => {
    const governing = await resolveGoverningRoute("deep", dead);
    expect(governing!.cells.claude.model).toBeNull();
    expect(governing!.cells.claude.reason).toContain("claude CLI");
    expect(governing!.cells.codex.model).toBeNull();
    expect(governing!.cells.codex.reason).toContain("codex CLI");
  });
});
