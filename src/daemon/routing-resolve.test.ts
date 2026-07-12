import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGoverningRoute, whatGoverns, type RoutingIo } from "./routing-resolve";
import { known, unknown } from "../schemas/capability";
import type { CapabilityRecord } from "../schemas";
import type { CapabilityDiscoveryResult } from "./capability-discovery";
import type { AccountBilling } from "./usage-credits";

/**
 * The flip's invariants. Each of these is a promise made to the user on the night
 * routing started governing his real work, and each is a promise that a passing
 * suite would otherwise let us make without keeping.
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
  modelUtilization: { "claude-fable-5": 100 },
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
  home = await mkdtemp(join(tmpdir(), "hive-flip-"));
  Bun.env.HIVE_HOME = home;
});

afterEach(async () => {
  delete Bun.env.HIVE_HOME;
  await rm(home, { recursive: true, force: true });
});

const config = (toml: string) => Bun.write(join(home, "config.toml"), toml);
const pins = (toml: string) => Bun.write(join(home, "routing.toml"), toml);

describe("the flip: derived routes govern live spawns", () => {
  test("by default the derived router governs, and it names concrete models", async () => {
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing).not.toBeNull();
    expect(governing!.route.tool).toBe("claude");
    expect(governing!.route.claude.model).toBe("claude-fable-5");
    // Not the shipped table's "best" alias: a launch token discovery vouches for.
    expect(governing!.route.claude.model).not.toBe("best");
  });

  test("the codex effort is the tier's chosen one, grounded in the record", async () => {
    // The manifest chooses deep=high; the record advertises high, so the choice
    // is grounded and passes. The model's own default (medium) informs a human
    // editing the manifest — it does not silently govern the cell.
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing!.route.codex.model).toBe("gpt-5.6-sol");
    expect(governing!.route.codex.effort).toBe("high");
  });

  test("a tier effort the record cannot ground is refused, not the shipped column's", async () => {
    // The shipped table's deep codex column also says high — but if the record
    // stopped advertising it, the engine must pass NO effort rather than let the
    // compiled-in column smuggle the same value through unvouched.
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
    expect(governing!.route.codex.model).toBe("gpt-5.6-sol");
    expect(governing!.route.codex.effort).toBeUndefined();
    expect(governing!.notes.join(" ")).toContain("refused effort high");
  });
});

describe("manifest expiry degrades loudly, never silently", () => {
  test("a spawn past validUntil resolves by ladder and names the expiry", async () => {
    // Nothing else changes: same discovery, same account, only the clock. The
    // compiled-in manifest has expired, so no cell derives from it — and the
    // route that governs this spawn must say so instead of quietly becoming
    // whatever the ladder found.
    const after = new Date("2026-09-01T00:00:00Z");
    const governing = await resolveGoverningRoute("deep", {
      ...io(),
      now: () => after,
    });
    expect(governing).not.toBeNull();
    expect(governing!.notes.join(" ")).toContain("EXPIRED");
    // The engine still governs (no null revert): expiry is a degraded
    // derivation, not the shipped-table escape hatch.
    expect(governing!.route.claude.model).not.toBe("best");
  });
});

describe("the escape hatches, and they are config, not code", () => {
  test('router = "shipped" reverts to the shipped table, live', async () => {
    await config('router = "shipped"\n');
    // A null is the whole revert: the caller keeps its pre-flip resolveRoute path.
    expect(await resolveGoverningRoute("deep", io())).toBeNull();
  });

  test('the kill switch routingManifest = "off" reverts every cell', async () => {
    await config('routingManifest = "off"\n');
    for (const tier of ["deep", "standard", "cheap", "review"] as const) {
      expect(await resolveGoverningRoute(tier, io())).toBeNull();
    }
  });

  test("both switches are re-read per call — no rebuild, no restart", async () => {
    expect(await resolveGoverningRoute("deep", io())).not.toBeNull();
    await config('router = "shipped"\n');
    // Same process, same module instance, no restart: the next spawn is reverted.
    expect(await resolveGoverningRoute("deep", io())).toBeNull();
    await config('router = "derived"\n');
    expect(await resolveGoverningRoute("deep", io())).not.toBeNull();
  });

  test("one function answers who governs, for the router and the shadow log alike", () => {
    expect(whatGoverns({ router: "derived" }, "built-in")).toBe("derived");
    expect(whatGoverns({ router: "derived" }, "installed")).toBe("derived");
    // Either switch alone is enough to revert.
    expect(whatGoverns({ router: "shipped" }, "installed")).toBe("shipped");
    expect(whatGoverns({ router: "derived" }, "kill-switch")).toBe("shipped");
  });
});

describe("what the flip may never break", () => {
  test("a routing.toml pin outranks the router, always", async () => {
    await pins('[deep]\ntool = "codex"\n\n[deep.claude]\nmodel = "claude-opus-4-8"\n');
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing!.route.tool).toBe("codex");
    expect(governing!.route.claude.model).toBe("claude-opus-4-8");
  });

  test("a pinned cell offers quota no alternatives to downshift onto", async () => {
    // The chain is the router's list of substitutes. Under a pin there must not be
    // one: a "downshift chain" beneath the user's explicit choice is the router
    // reserving the right to overrule it the moment a pool gets tight.
    await pins('[deep.claude]\nmodel = "claude-opus-4-8"\n');
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing!.chain.claude).toEqual([]);

    // Unpinned, the same tier DOES offer one — so the empty chain above is the
    // pin's doing and not an artifact of a manifest that lists nothing.
    await rm(join(home, "routing.toml"));
    const unpinned = await resolveGoverningRoute("deep", io());
    expect(unpinned!.chain.claude).toEqual(["claude-opus-4-8"]);
  });

  test("the spend guard still refuses to auto-route into a charge", async () => {
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: BILLED, codex: FREE }),
    );
    // Fable would be billed, so the router does not choose it on Hive's own
    // authority — and it says so rather than substituting in silence.
    expect(governing!.route.claude.model).not.toBe("claude-fable-5");
    expect(governing!.notes.join(" ")).toContain("WOULD SPEND YOUR MONEY");
  });

  test("an unreadable billing surface is not read as free", async () => {
    // Unknown resolves to ask, never to spend. A null billing read must not let a
    // billable model through on the grounds that nothing said it was billable.
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: null, codex: FREE }),
    );
    expect(governing!.notes.join(" ")).toContain("cannot rule out a charge");
  });

  test("an exhausted, unpayable model falls through to the next capable one", async () => {
    // The user's question, verbatim: "fable switches to usage credits only
    // tonight, and since we do not have credits, any time we want deep it should
    // automatically go to 4.8 WITHOUT USER NOTICE — correct?"  Now: correct.
    const creditOnly: AccountBilling = {
      creditsEnabled: known(false, "claude.get_usage", OBSERVED),
      disabledReason: null,
      generalUtilization: known(30, "claude.get_usage", OBSERVED),
      modelUtilization: { "claude-fable-5": 100 },
    };
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: creditOnly, codex: FREE }),
    );
    expect(governing!.route.claude.model).toBe("claude-opus-4-8");
    // WITHOUT USER NOTICE: an unrunnable model is not a decision he has to make.
    // No consent is requested, because no money is involved — the vendor would
    // simply refuse the request.
    expect(governing!.notes.join(" ")).not.toContain("WOULD SPEND YOUR MONEY");
    expect(governing!.notes.join(" ")).toContain("is not routable");
  });

  test("and the model he still pays for is NOT abandoned early", async () => {
    // The negative control, and it matters as much as the fallthrough: today Fable
    // still draws plan capacity he has already bought (pool 17%). Excluding it "to
    // be safe" is the exact harm the deleted cutoff was doing.
    const today: AccountBilling = {
      creditsEnabled: known(false, "claude.get_usage", OBSERVED),
      disabledReason: null,
      generalUtilization: known(30, "claude.get_usage", OBSERVED),
      modelUtilization: { "claude-fable-5": 17 },
    };
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: today, codex: FREE }),
    );
    expect(governing!.route.claude.model).toBe("claude-fable-5");
  });

  test("a pin settles the ROUTE; it never settles the MONEY", async () => {
    // Consent to route is not consent to spend. The pinned model still wins the
    // route — the router never overrules him — but a spawn that would really be
    // billed raises the consent request rather than quietly charging him.
    await pins('[deep.claude]\nmodel = "claude-fable-5"\n');
    const governing = await resolveGoverningRoute(
      "deep",
      io({ claude: BILLED, codex: FREE }),
    );
    expect(governing!.route.claude.model).toBe("claude-fable-5");
    expect(governing!.notes.join(" ")).toContain("WOULD SPEND YOUR MONEY");
  });

  test("the downshift chain is capability-floored, not just the primary", async () => {
    // Every model quota may downshift onto came through the manifest's declared
    // coding-capable list. The valve this replaces offered the account's discovered
    // default, which no floor had ever vetted.
    const governing = await resolveGoverningRoute("deep", io());
    expect(governing!.chain.claude).toEqual(["claude-opus-4-8"]);
    expect(governing!.chain.claude).not.toContain("claude-haiku-4-5-20251001");
  });
});
