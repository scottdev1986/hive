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

  test("a blocked candidate stays visible without being treated as unavailable", async () => {
    const catalog = await readBenchmarkCatalog({
      mode: "shadow",
      discovery,
      sources: [{
        sourceId: "blocked",
        async read() {
          return {
            sourceId: "blocked",
            status: "blocked",
            detail: "blocked by user policy",
            releaseDate: null,
            fetchedAt: null,
            models: new Map(),
          };
        },
      }],
    });
    expect(catalog).toMatchObject({ status: "blocked" });
    expect(catalog.detail).toContain("1 blocked");
  });

  test("a blocked candidate does not make a healthy active source partial", async () => {
    const source = (sourceId: string, status: "current" | "blocked") => ({
      sourceId,
      async read() {
        return {
          sourceId,
          status,
          detail: status,
          releaseDate: status === "current" ? "2026-06-25" : null,
          fetchedAt: status === "current" ? "2026-07-12T00:00:00.000Z" : null,
          models: new Map(),
        };
      },
    });
    const catalog = await readBenchmarkCatalog({
      mode: "shadow",
      discovery,
      sources: [source("active", "current"), source("candidate", "blocked")],
    });
    expect(catalog.status).toBe("current");
    expect(catalog.sources[1]?.status).toBe("blocked");
  });
});
