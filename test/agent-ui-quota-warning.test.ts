import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../src/schemas/capability";
import type {
  QuotaPoolStatus,
  QuotaStatus,
  QuotaWindowStatus,
} from "../src/schemas/quota";
import { QuotaWarningMonitor } from "../src/cli/agent-ui/quota-warning";

const RESET = "2026-08-10T17:50:00.000Z";

function window(remainingPct: number): QuotaWindowStatus {
  return {
    availability: "available",
    unit: "percent",
    allowance: 100,
    used: 100 - remainingPct * 100,
    reserved: 0,
    reservedIsEstimate: true,
    remaining: remainingPct * 100,
    remainingPct,
    resetsAt: RESET,
    confidence: "reported",
    source: "provider",
    observedAt: "2026-08-10T16:43:43.981Z",
    windowMinutes: 300,
  };
}

function pool(
  provider: CapabilityProvider,
  remainingPct: number,
): QuotaPoolStatus {
  return {
    provider,
    account: "default",
    pool: "subscription",
    origin: "discovered",
    overridesDiscovered: false,
    models: ["*"],
    label: null,
    routable: true,
    confidence: "reported",
    freshness: "fresh",
    source: "provider",
    fiveHour: window(remainingPct),
    weekly: window(0.8),
  };
}

describe("agent UI quota warnings", () => {
  test.each(CAPABILITY_PROVIDERS)(
    "%s uses the same measured threshold path",
    (provider) => {
      const monitor = new QuotaWarningMonitor(provider, provider);
      const notices = monitor.evaluate([pool(provider, 0.2)], null);

      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ level: "warning" });
      expect(notices[0]?.message).toContain("20% remaining");
      expect(notices[0]?.message).toContain("resets");
    },
  );

  test("escalates once, reports exhaustion, and rearms after recovery", () => {
    const monitor = new QuotaWarningMonitor("claude", "Claude Code");
    expect(monitor.evaluate([pool("claude", 0.2)], null)[0]?.level).toBe(
      "warning",
    );
    expect(monitor.evaluate([pool("claude", 0.15)], null)).toEqual([]);
    expect(monitor.evaluate([pool("claude", 0.09)], null)[0]?.level).toBe(
      "critical",
    );
    expect(monitor.evaluate([pool("claude", 0.05)], null)).toEqual([]);
    expect(monitor.evaluate([pool("claude", 0)], null)[0]?.level).toBe(
      "exhausted",
    );
    expect(monitor.evaluate([pool("claude", 0.5)], null)).toEqual([]);
    expect(monitor.evaluate([pool("claude", 0.2)], null)[0]?.level).toBe(
      "warning",
    );
  });

  test("unknown and unmetered capacity never become a made-up warning", () => {
    const unknown: QuotaStatus = {
      provider: "opencode",
      model: "*",
      configured: false,
      confidence: "missing",
      reason: "usage is unknown and routing is unconstrained",
      probeError: null,
      reserved: 0,
      fiveHourRecorded: 0,
      weeklyRecorded: 0,
      recordedIsLocalEstimate: true,
    };
    const monitor = new QuotaWarningMonitor("opencode", "OpenCode");

    expect(monitor.evaluate([unknown], null)).toEqual([]);
  });

  test("a model-scoped pool warns only while that model is active", () => {
    const scoped = { ...pool("claude", 0.08), models: ["fable-5"] };
    const monitor = new QuotaWarningMonitor("claude", "Claude Code");

    expect(monitor.evaluate([scoped], "opus-4.8")).toEqual([]);
    expect(monitor.evaluate([scoped], "fable-5")[0]?.level).toBe("critical");
  });
});
