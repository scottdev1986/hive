import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryIndex,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import type { MemoryWriteInput } from "../../src/schemas/memory";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-memory-brief-ranked-"));
  tempRoots.push(root);
  process.env.HIVE_HOME = await mkdtemp(
    join(tmpdir(), "hive-memory-brief-ranked-home-"),
  );
  tempRoots.push(process.env.HIVE_HOME);
  return root;
}

function memory(overrides: Partial<MemoryWriteInput>): MemoryWriteInput {
  return {
    scope: "repo",
    topic: "testing",
    title: "Test article",
    body: "Test body.",
    source: "agent",
    evidence: "Measured by the test",
    status: "unverified",
    supersedes: [],
    date: "2026-07-12",
    ...overrides,
  };
}

describe("buildMemoryIndex with brief-ranked recall", () => {
  test("brief-ranked path returns actual rows, not empty with omit-only message", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "ranked-article",
        title: "Memory indexing article",
        body: "Content about indexing.",
        topic: "memory",
      }),
    );
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "ranked-pitfall",
        kind: "pitfall",
        title: "Index parsing pitfall",
        body: "Regex must match real row format.",
        topic: "memory",
      }),
    );

    const index = await buildMemoryIndex(root, { brief: "memory indexing" });

    expect(index).not.toBe("");
    const lines = index.split("\n");

    const articleRows = lines.filter((line) => line.startsWith("- ["));
    expect(articleRows.length).toBeGreaterThan(0);

    const hasArticle = articleRows.some((row) =>
      row.includes("ranked-article"),
    );
    const hasPitfall = articleRows.some((row) =>
      row.includes("ranked-pitfall"),
    );
    expect(hasArticle || hasPitfall).toBe(true);
  });

  test("index rows match the rebuildScopeIndex format", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "format-check",
        title: "Format validation article",
        body: "Check row format.",
        topic: "format",
        status: "verified",
        verified: "2026-07-13",
      }),
    );

    const index = await buildMemoryIndex(root, { brief: "format" });
    const lines = index.split("\n");
    const rows = lines.filter((line) => line.startsWith("- ["));

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row).toMatch(/^- \[[^\]]+\] \S+ \(\d{4}-\d{2}-\d{2}\) \[[^\]]+\]/);
    }
  });

  test("brief-ranked path handles pitfalls correctly", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "pitfall-format",
        kind: "pitfall",
        title: "Pitfall format test",
        body: "Pitfall body.",
        topic: "pitfalls",
      }),
    );

    const index = await buildMemoryIndex(root, { brief: "pitfall" });
    const lines = index.split("\n");
    const rows = lines.filter((line) => line.startsWith("- ["));

    expect(rows.length).toBeGreaterThan(0);

    const pitfallRow = rows.find((row) => row.includes("pitfall-format"));
    expect(pitfallRow).toBeDefined();
    expect(pitfallRow).toContain("[pitfall]");
  });

  test("no matches for brief query returns header with omit message", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "unrelated-article",
        title: "Unrelated topic",
        body: "Nothing matching the query.",
        topic: "other",
      }),
    );

    const index = await buildMemoryIndex(root, {
      brief: "nonexistent query terms",
    });

    const lines = index.split("\n");
    const articleRows = lines.filter((line) => line.startsWith("- ["));

    expect(articleRows.length).toBe(0);
    expect(index).toContain("Hive memory index");
    expect(index).toContain("1 older article");
  });
});
