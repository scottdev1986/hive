import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BILLING_MEMORY_TTL_MINUTES,
  poolAvailability,
  readBillingWithMemory,
  spendRisk,
  type AccountBilling,
} from "./usage-credits";
import { known, unknown } from "../schemas/capability";

/**
 * The availability fix, and the outage that motivated it.
 *
 * Two different questions were being answered by one function, and the confusion
 * cost us both an outage and a misroute:
 *   "would this cost him money?"  -> the spend guard. Asks him.
 *   "can this model even run?"    -> availability. Never asks him; picks another.
 */

const AT = "2026-07-12T02:00:00.000Z";
const NOW = new Date("2026-07-12T02:05:00.000Z");

const billing = (overrides: Partial<AccountBilling> = {}): AccountBilling => ({
  creditsEnabled: known(false, "claude.get_usage", AT),
  disabledReason: null,
  generalUtilization: known(30, "claude.get_usage", AT),
  modelUtilization: {},
  ...overrides,
});

/** What the vendor's telemetry endpoint returned when it went quiet at 01:40. */
const SILENT = billing({
  creditsEnabled: unknown("surface-silent", "claude.get_usage", AT),
  generalUtilization: unknown("field-absent", "claude.get_usage", AT),
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hive-billing-"));
  Bun.env.HIVE_HOME = home;
});
afterEach(async () => {
  delete Bun.env.HIVE_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("an exhausted pool nothing can pay for means UNAVAILABLE, not free", () => {
  test("spent pool + credits OFF: the vendor refuses it, so it cannot run", () => {
    const spent = billing({ modelUtilization: { fable: 100 } });
    // The spend guard is not wrong — there is genuinely no charge...
    expect(spendRisk(spent, "Fable").state).toBe("no-spend");
    // ...but "no charge" was being read as "use it", and the vendor will refuse
    // the request. That is the misroute the user predicted: deep would keep
    // landing on a model that cannot run instead of falling through to Opus.
    expect(poolAvailability(spent, "Fable").state).toBe("exhausted");
  });

  test("spent pool + credits ON: money could pay, so it is the guard's question", () => {
    const spent = billing({
      creditsEnabled: known(true, "claude.get_usage", AT),
      modelUtilization: { fable: 100 },
    });
    expect(poolAvailability(spent, "Fable").state).toBe("available");
    expect(spendRisk(spent, "Fable").state).toBe("would-spend");
  });

  test("NO dedicated pool is the normal case, never 'unknown-and-excluded'", () => {
    // Measured live 2026-07-12: modelUtilization = {"fable": 17}. Opus, Sonnet and
    // Haiku have NO model-scoped pool at all — they draw on the plan pool. If pool
    // ABSENCE meant "exclude", the fallthrough target would exclude itself and
    // nothing on the account could route.
    const normal = billing({ modelUtilization: { fable: 17 } });
    expect(poolAvailability(normal, "Default (recommended)").state).toBe("available");
    expect(poolAvailability(normal, "Sonnet").state).toBe("available");
    // And the model that DOES have a pool, with headroom, stays available: he pays
    // for that capacity and excluding it early is the harm the deleted cutoff did.
    expect(poolAvailability(normal, "Fable").state).toBe("available");
  });

  test("it keys on money and metering, never on a model's name", () => {
    // The same rule, on a model that is not Fable and not even Claude.
    const spent = billing({ modelUtilization: { "some-future-model": 100 } });
    expect(poolAvailability(spent, "Some-Future-Model").state).toBe("exhausted");
  });
});

describe("the billing reader heals itself", () => {
  test("a quiet surface falls back to the last good reading, at its true age", async () => {
    let calls = 0;
    const warnings: string[] = [];
    // First call: the surface answers. It is remembered.
    await readBillingWithMemory("claude", {
      read: async () => billing({ modelUtilization: { fable: 17 } }),
      now: () => new Date(AT),
    });
    // Now it goes quiet. Without the memory this refused every Claude spawn.
    const healed = await readBillingWithMemory("claude", {
      read: async () => {
        calls += 1;
        return SILENT;
      },
      now: () => NOW,
      warn: (message) => warnings.push(message),
    });
    // It retried before giving up on the live surface.
    expect(calls).toBe(2);
    // And it recovered the fact that decides everything: credits are OFF, so
    // nothing can be charged and there is no reason to refuse the launch.
    expect(healed!.creditsEnabled).toEqual(known(false, "claude.get_usage", AT));
    expect(spendRisk(healed!, "Fable").state).toBe("no-spend");
    // Loudly, once — not silently, and not on every spawn.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("5m old");
  });

  test("a memory past its TTL expires: the honest unknown comes back", async () => {
    await readBillingWithMemory("claude", {
      read: async () => billing(),
      now: () => new Date(AT),
    });
    const stale = await readBillingWithMemory("claude", {
      read: async () => SILENT,
      now: () => new Date(
        Date.parse(AT) + (BILLING_MEMORY_TTL_MINUTES + 1) * 60_000,
      ),
      warn: () => {},
    });
    // Not a confident guess dressed as a measurement: unknown, so the guard asks.
    expect(stale!.creditsEnabled.state).toBe("unknown");
  });

  test("with no memory at all, a quiet surface stays honestly unknown", async () => {
    const cold = await readBillingWithMemory("claude", {
      read: async () => SILENT,
      now: () => NOW,
      warn: () => {},
    });
    expect(cold!.creditsEnabled.state).toBe("unknown");
  });

  test("it climbs back up by itself when the surface answers again", async () => {
    await readBillingWithMemory("claude", {
      read: async () => billing({ generalUtilization: known(30, "claude.get_usage", AT) }),
      now: () => new Date(AT),
    });
    await readBillingWithMemory("claude", {
      read: async () => SILENT,
      now: () => NOW,
      warn: () => {},
    });
    // The vendor comes back. Nothing is pinned to the degraded state, and no
    // restart is needed: the next read is simply live again.
    const recovered = await readBillingWithMemory("claude", {
      read: async () => billing({ generalUtilization: known(44, "claude.get_usage", AT) }),
      now: () => NOW,
    });
    expect(recovered!.generalUtilization).toEqual(
      known(44, "claude.get_usage", AT),
    );
  });
});
