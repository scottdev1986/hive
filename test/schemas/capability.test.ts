import { describe, expect, expectTypeOf, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import {
  CAPABILITY_PROVIDERS,
  providersOf,
} from "../../src/schemas/capability";

const SRC_ROOT = join(import.meta.dir, "../../src");

describe("providersOf — the one legal record enumerator", () => {
  test("always returns the whole union, even over a partial record", () => {
    expect(providersOf({})).toEqual([...CAPABILITY_PROVIDERS]);
    expect(providersOf({ codex: 1 })).toEqual([...CAPABILITY_PROVIDERS]);
  });

  test("keys the union does not know are appended, never dropped", () => {
    interface NumberByName {
      readonly [name: string]: number;
    }
    const record: NumberByName = { claude: 1, zeta: 2, acme: 3 };
    expectTypeOf(providersOf(record)).toEqualTypeOf<string[]>();
    expect(providersOf(record)).toEqual([
      ...CAPABILITY_PROVIDERS,
      "acme",
      "zeta",
    ]);
  });
});

/** Prevents hand-written provider arrays from silently omitting a new vendor. */
describe("provider enumeration goes through the union", () => {
  test("no ad-hoc provider list survives outside provider.ts", async () => {
    const adHocList =
      /\[\s*"(?:claude|codex|grok)"\s*,\s*"(?:claude|codex|grok)"/;
    const offenders: string[] = [];
    for await (const path of new Glob("**/*.ts").scan(SRC_ROOT)) {
      if (path.endsWith(".test.ts")) continue;
      if (path === join("schemas", "provider.ts")) continue;
      const lines = (await Bun.file(join(SRC_ROOT, path)).text()).split("\n");
      lines.forEach((line, index) => {
        if (adHocList.test(line))
          offenders.push(`src/${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
