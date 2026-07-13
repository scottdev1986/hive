import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import {
  CAPABILITY_PROVIDERS,
  capabilityFreshness,
  providersOf,
} from "./capability";

const SRC_ROOT = join(import.meta.dir, "..");

describe("capability freshness", () => {
  const observedAt = "2026-07-13T12:00:00.000Z";

  test("accepts current evidence but rejects stale and future timestamps", () => {
    expect(capabilityFreshness(
      { observedAt },
      30,
      new Date("2026-07-13T12:29:00.000Z"),
    )).toBe("fresh");
    expect(capabilityFreshness(
      { observedAt },
      30,
      new Date("2026-07-13T12:31:00.000Z"),
    )).toBe("stale");
    expect(capabilityFreshness(
      { observedAt: "2026-07-13T12:01:00.000Z" },
      30,
      new Date(observedAt),
    )).toBe("stale");
  });
});

describe("providersOf — the one legal record enumerator", () => {
  test("always returns the whole union, even over a partial record", () => {
    expect(providersOf({})).toEqual([...CAPABILITY_PROVIDERS]);
    expect(providersOf({ codex: 1 })).toEqual([...CAPABILITY_PROVIDERS]);
  });

  test("keys the union does not know are appended, never dropped", () => {
    const record = { claude: 1, zeta: 2, acme: 3 } as Record<string, number>;
    expect(providersOf(record) as string[])
      .toEqual([...CAPABILITY_PROVIDERS, "acme", "zeta"]);
  });
});

/**
 * The tripwire behind the Grok-erasure fix: the ONLY place allowed to spell
 * out the vendor list is the union itself (`CapabilityProviderSchema` in
 * capability.ts). Every other enumeration must derive from it
 * (CAPABILITY_PROVIDERS / forEachProvider / providersOf), because a hand-typed
 * pair is exactly how a vendor stops existing: it is not rejected, not marked
 * unavailable — it silently never appears. This scan fails the build on any
 * ad-hoc array of two or more provider names in non-test source.
 */
describe("provider enumeration goes through the union", () => {
  test("no ad-hoc provider list survives outside capability.ts", async () => {
    const adHocList = /\[\s*"(?:claude|codex|grok)"\s*,\s*"(?:claude|codex|grok)"/;
    const offenders: string[] = [];
    for await (const path of new Glob("**/*.ts").scan(SRC_ROOT)) {
      if (path.endsWith(".test.ts")) continue;
      if (path === join("schemas", "capability.ts")) continue;
      const lines = (await Bun.file(join(SRC_ROOT, path)).text()).split("\n");
      lines.forEach((line, index) => {
        if (adHocList.test(line)) offenders.push(`src/${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
