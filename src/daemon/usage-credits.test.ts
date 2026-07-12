import { describe, expect, test } from "bun:test";
import {
  accountBillingFromCodexRateLimits,
  accountBillingFromUsage,
  spendRisk,
} from "./usage-credits";

const AT = "2026-07-12T00:00:00.000Z";

/**
 * The VERBATIM billing blocks claude 2.1.207 returned on 2026-07-12 — after the
 * date the shipped constant claims Fable moved to usage-credit billing. Note what
 * it actually says: credits are OFF, and Fable is sitting on a plan-scoped pool
 * with 88% of it unused. Both facts are load-bearing and neither is a guess.
 */
const LIVE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12, resets_at: "2026-07-12T04:19:59Z" },
    seven_day: { utilization: 10, resets_at: "2026-07-18T18:59:59Z" },
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      disabled_reason: null,
    },
    spend: {
      enabled: false,
      can_purchase_credits: false,
      can_toggle: false,
      disclaimer: "Usage credits cover you when you hit your plan limits.",
    },
    model_scoped: [
      { display_name: "Fable", utilization: 12, resets_at: "2026-07-18T19:00:00Z" },
    ],
  },
};

const LIVE_CODEX = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1 },
    secondary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 2 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    planType: "prolite",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1 },
      secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 2 },
      credits: null,
    },
  },
};

describe("the positive control: the reader sees real values before it trusts an absence", () => {
  test("it reads the live payload's credit flag as a KNOWN false", () => {
    // This is the control. `known(false)` and `unknown` are different states, and
    // only a reader that produces `known` here has proven it is looking at the
    // right key. A typo would produce `unknown` — and if `unknown` were treated
    // as "off", the typo and the truth would be indistinguishable.
    const billing = accountBillingFromUsage(LIVE, AT);
    expect(billing.creditsEnabled).toEqual({
      state: "known",
      value: false,
      surface: "claude.get_usage",
      observedAt: AT,
    });
    expect(billing.modelUtilization).toEqual({ fable: 12 });
    expect(billing.generalUtilization.state).toBe("known");
  });

  test("it reads a KNOWN true when the vendor says credits are on", () => {
    const on = {
      ...LIVE,
      rate_limits: {
        ...LIVE.rate_limits,
        extra_usage: { is_enabled: true },
        spend: { enabled: true },
      },
    };
    expect(accountBillingFromUsage(on, AT).creditsEnabled).toMatchObject({
      state: "known",
      value: true,
    });
  });

  test("a MISSING credit key is unknown, NEVER false", () => {
    // The bug this exists to prevent: a guessed or renamed key reads back as
    // absent, absent renders as "credits off", "credits off" renders as "this
    // model cannot run" — and Hive silently disables a model the user is happily
    // using, with every test still green.
    const silent = {
      ...LIVE,
      rate_limits: { five_hour: { utilization: 12, resets_at: null } },
    };
    const billing = accountBillingFromUsage(silent, AT);
    expect(billing.creditsEnabled.state).toBe("unknown");
    expect(billing.creditsEnabled).not.toMatchObject({ value: false });
  });

  test("two vendor blocks that contradict each other are malformed, not 'probably off'", () => {
    const split = {
      ...LIVE,
      rate_limits: {
        ...LIVE.rate_limits,
        extra_usage: { is_enabled: true },
        spend: { enabled: false },
      },
    };
    expect(accountBillingFromUsage(split, AT).creditsEnabled).toMatchObject({
      state: "unknown",
      reason: "malformed",
    });
  });
});

describe("Codex paid overflow uses the same guard without inventing auto-top-up state", () => {
  test("the live keys produce populated plan controls and an UNKNOWN overflow switch", () => {
    const billing = accountBillingFromCodexRateLimits(LIVE_CODEX, AT);
    expect(billing.generalUtilization).toEqual({
      state: "known",
      value: 41,
      surface: "codex.account/rateLimits/read",
      observedAt: AT,
    });
    expect(billing.modelUtilization).toEqual({
      "gpt-5.3-codex-spark": 7,
    });
    // false/zero says there is no balance now. It cannot say auto-top-up is off.
    expect(billing.creditsEnabled).toMatchObject({
      state: "unknown",
      reason: "surface-silent",
    });
  });

  test("today's 41%/23% headroom never asks, despite unobservable auto-top-up", () => {
    const risk = spendRisk(
      accountBillingFromCodexRateLimits(LIVE_CODEX, AT),
      "GPT-5.6-Sol",
    );
    expect(risk.state).toBe("no-spend");
    expect(risk.detail).toContain("41% used");
  });

  test("credits present + exhausted plan asks about real money", () => {
    const billing = accountBillingFromCodexRateLimits({
      ...LIVE_CODEX,
      rateLimits: {
        ...LIVE_CODEX.rateLimits,
        primary: { ...LIVE_CODEX.rateLimits.primary, usedPercent: 100 },
        credits: { hasCredits: true, unlimited: false, balance: "100" },
      },
    }, AT);
    const risk = spendRisk(billing, "GPT-5.6-Sol");
    expect(risk.state).toBe("would-spend");
    expect(risk.detail).toContain("real money");
  });

  test("zero balance + exhausted plan asks and names auto-top-up uncertainty", () => {
    const billing = accountBillingFromCodexRateLimits({
      ...LIVE_CODEX,
      rateLimits: {
        ...LIVE_CODEX.rateLimits,
        primary: { ...LIVE_CODEX.rateLimits.primary, usedPercent: 100 },
      },
    }, AT);
    const risk = spendRisk(billing, "GPT-5.6-Sol");
    expect(risk.state).toBe("would-spend");
    expect(risk.detail).toContain("auto-top-up");
    expect(risk.detail).toContain("may purchase credits");
  });
});

describe("the spend guard keys on MONEY, never on a model name", () => {
  const billing = accountBillingFromUsage(LIVE, AT);

  test("with credits OFF, nothing can be charged — so the guard NEVER fires", () => {
    // The load-bearing case, and the state of this account today. A request past
    // the plan limit is REFUSED, not billed. A guard that nags a user who cannot
    // be charged is a broken guard, and one he learns to click through is worse
    // than none.
    const spent = accountBillingFromUsage({
      ...LIVE,
      rate_limits: {
        ...LIVE.rate_limits,
        five_hour: { utilization: 100, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 100 }],
      },
    }, AT);
    // Even with every pool exhausted, credits being off means no charge is
    // possible, so there is nothing to ask about.
    expect(spendRisk(spent, "Fable").state).toBe("no-spend");
    expect(spendRisk(spent, "Opus").state).toBe("no-spend");
    expect(spendRisk(spent, "Fable").detail).toContain("refused, not billed");
  });

  test("Fable gets no special treatment: on plan, it is simply not a spend", () => {
    expect(spendRisk(billing, "Fable").state).toBe("no-spend");
    // And neither does anything else. There is no model list in this guard.
    expect(spendRisk(billing, "Opus").state).toBe("no-spend");
    expect(spendRisk(billing, "Some-Model-Nobody-Has-Heard-Of").state)
      .toBe("no-spend");
  });

  test("credits ON + an exhausted pool WOULD spend money -> ask", () => {
    const spent = accountBillingFromUsage({
      ...LIVE,
      rate_limits: {
        ...LIVE.rate_limits,
        extra_usage: { is_enabled: true },
        spend: { enabled: true },
        model_scoped: [{ display_name: "Fable", utilization: 100 }],
      },
    }, AT);
    const risk = spendRisk(spent, "Fable");
    expect(risk.state).toBe("would-spend");
    expect(risk.detail).toContain("real money");
  });

  test("credits ON but the plan still covers it -> no ask, no nagging", () => {
    const on = accountBillingFromUsage({
      ...LIVE,
      rate_limits: {
        ...LIVE.rate_limits,
        extra_usage: { is_enabled: true },
        spend: { enabled: true },
      },
    }, AT);
    // A false positive here is what trains a user to click through the prompt,
    // which destroys the guard as surely as a false negative empties his wallet.
    expect(spendRisk(on, "Fable").state).toBe("no-spend");
  });

  test("an exhausted pool with UNREADABLE credits resolves to ASK, never to spend", () => {
    const murky = accountBillingFromUsage({
      rate_limits: {
        five_hour: { utilization: 100 },
        model_scoped: [{ display_name: "Fable", utilization: 100 }],
      },
    }, AT);
    expect(spendRisk(murky, "Fable").state).toBe("would-spend");
    expect(spendRisk(murky, "Fable").detail).toContain("cannot read");
  });

  test("no plan reading at all is unknown, and unknown asks", () => {
    const blind = accountBillingFromUsage({ rate_limits: {} }, AT);
    expect(spendRisk(blind, "Fable").state).toBe("unknown");
    expect(spendRisk(blind, "Fable").detail).toContain("will not spend your money");
  });
});
