import { describe, expect, test } from "bun:test";
import type { ProviderDiscovery } from "../schemas";
import {
  readBenchmarkCatalog,
  type BenchmarkSourceAdapter,
} from "./benchmarks";

const unavailable: ProviderDiscovery = {
  status: "unavailable",
  reason: "not installed",
};
const discovery = { claude: unavailable, codex: unavailable };

describe("benchmark catalog", () => {
  test("off is a hard source kill switch", async () => {
    let called = false;
    const source: BenchmarkSourceAdapter = {
      sourceId: "test",
      async read() {
        called = true;
        throw new Error("must not run");
      },
    };
    const catalog = await readBenchmarkCatalog({
      mode: "off",
      discovery,
      sources: [source],
    });
    expect(called).toBeFalse();
    expect(catalog).toMatchObject({ status: "off", sources: [] });
  });

  test("shadow mode without an approved source says so", async () => {
    const catalog = await readBenchmarkCatalog({ mode: "shadow", discovery });
    expect(catalog).toMatchObject({
      status: "not-configured",
      sources: [],
    });
    expect(catalog.detail).toContain("No benchmark source has user approval");
  });

  test("combines source measurements without judging or ranking them", async () => {
    const source = (
      sourceId: string,
      status: "current" | "last-good",
      score: number,
    ): BenchmarkSourceAdapter => ({
      sourceId,
      async read() {
        return {
          sourceId,
          status,
          detail: `${sourceId} ${status}`,
          releaseDate: "2026-06-25",
          fetchedAt: "2026-07-12T00:00:00.000Z",
          models: new Map([["codex\0gpt-discovered", [{
            sourceId,
            effort: "high",
            scores: { coding: score },
            source: `https://example.com/${sourceId}.json`,
            releaseDate: "2026-06-25",
            fetchedAt: "2026-07-12T00:00:00.000Z",
          }]]]),
        };
      },
    });
    const catalog = await readBenchmarkCatalog({
      mode: "shadow",
      discovery,
      sources: [source("one", "current", 80), source("two", "last-good", 70)],
    });
    expect(catalog.status).toBe("partial");
    expect(catalog.models.get("codex\0gpt-discovered")).toHaveLength(2);
    expect(catalog.models.get("codex\0gpt-discovered")?.map((row) => row.sourceId))
      .toEqual(["one", "two"]);
  });
});
