import { describe, expect, test } from "bun:test";
import { accountBillingFromUsage, modelCost } from "./usage-credits";

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

describe("what a model costs is measured, not dated", () => {
  const billing = accountBillingFromUsage(LIVE, AT);

  test("Fable is ON PLAN today, after the date the constant says it is not", () => {
    // The whole point. The shipped constant says Fable is off-plan as of
    // 2026-07-12; the vendor says it has a plan pool that is 12% used. The
    // measurement wins, and it is the reason the date has to go.
    const cost = modelCost(billing, "Fable");
    expect(cost.state).toBe("on-plan");
    expect(cost.detail).toContain("Fable pool 12% used");
  });

  test("a model with no ceiling of its own is judged by the account pool", () => {
    // Opus is absent from `model_scoped` and is plainly plan-billed. Reading its
    // absence as "no plan coverage" would disable it — absence is not false, in a
    // costume.
    expect(modelCost(billing, "Opus").state).toBe("on-plan");
  });

  test("an exhausted pool with credits OFF is unpayable, and says why", () => {
    const spent = accountBillingFromUsage({
      ...LIVE,
      rate_limits: {
        ...LIVE.rate_limits,
        extra_usage: { is_enabled: false, disabled_reason: "not set up" },
        model_scoped: [{ display_name: "Fable", utilization: 100 }],
      },
    }, AT);
    const cost = modelCost(spent, "Fable");
    expect(cost.state).toBe("unpayable");
    expect(cost.detail).toContain("usage credits are off");
    expect(cost.detail).toContain("not set up");
  });

  test("an exhausted pool with credits ON spends real money — so it must be asked", () => {
    const spent = accountBillingFromUsage({
      ...LIVE,
      rate_limits: {
        ...LIVE.rate_limits,
        extra_usage: { is_enabled: true },
        spend: { enabled: true },
        model_scoped: [{ display_name: "Fable", utilization: 100 }],
      },
    }, AT);
    const cost = modelCost(spent, "Fable");
    expect(cost.state).toBe("spends-credits");
    expect(cost.detail).toContain("real money");
  });

  test("an exhausted pool with UNREADABLE credits is unknown, and is not auto-routed", () => {
    const spent = accountBillingFromUsage({
      rate_limits: {
        five_hour: { utilization: 100 },
        model_scoped: [{ display_name: "Fable", utilization: 100 }],
      },
    }, AT);
    expect(modelCost(spent, "Fable").state).toBe("unknown");
  });
});
