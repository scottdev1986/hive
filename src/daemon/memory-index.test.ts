import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemoryFact } from "../adapters/memory";
import type { MemoryWriteInput } from "../schemas";
import { MemoryIndex } from "./memory-index";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-memory-index-"));
  tempRoots.push(root);
  process.env.HIVE_HOME = await mkdtemp(
    join(tmpdir(), "hive-memory-index-home-"),
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
    status: "verified",
    supersedes: [],
    verified: "2026-07-12",
    ...overrides,
  };
}

describe("MemoryIndex (SQLite FTS over Markdown facts)", () => {
  test("rebuild indexes every fact from disk and search finds them by title or body", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, memory({
      scope: "repo",
      id: "flaky-login-test",
      title: "The login test is flaky",
      body: "Race condition in session setup causes intermittent failures.",
      tags: ["testing"],
    }));
    await writeMemoryFact(root, memory({
      scope: "global",
      id: "cli-distribution",
      title: "Python's CLI distribution story",
      body: "Bad; prefer a single compiled binary.",
      tags: [],
    }));

    const index = new MemoryIndex(new Database(":memory:"));
    const count = await index.rebuild(root);
    expect(count).toEqual(2);

    const byTitle = index.search("flaky");
    expect(byTitle.map((result) => result.id)).toEqual(["flaky-login-test"]);
    expect(byTitle[0]?.scope).toEqual("repo");
    expect(byTitle[0]?.snippet.toLowerCase()).toContain("race");

    const byBody = index.search("compiled binary");
    expect(byBody.map((result) => result.id)).toEqual(["cli-distribution"]);
  });

  test("scope filters restrict search to one scope", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, memory({
      scope: "repo",
      id: "shared-term",
      title: "Repo note about caching",
      body: "caching details",
    }));
    await writeMemoryFact(root, memory({
      scope: "global",
      id: "shared-term-global",
      title: "Global note about caching",
      body: "caching details",
    }));
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    expect(index.search("caching", { scope: "repo" }).map((r) => r.id))
      .toEqual(["shared-term"]);
    expect(index.search("caching", { scope: "global" }).map((r) => r.id))
      .toEqual(["shared-term-global"]);
    expect(index.search("caching").length).toEqual(2);
  });

  test("upsertFact and removeFact keep the index in sync without a full rebuild", async () => {
    const root = await makeRoot();
    const index = new MemoryIndex(new Database(":memory:"));
    const fact = await writeMemoryFact(root, memory({
      scope: "repo",
      id: "incremental",
      title: "Incremental fact",
      body: "First body text.",
    }));
    index.upsertFact(fact);
    expect(index.search("first").map((r) => r.id)).toEqual(["incremental"]);

    const updated = { ...fact, body: "Second body text entirely." };
    index.upsertFact(updated);
    expect(index.search("first")).toEqual([]);
    expect(index.search("second").map((r) => r.id)).toEqual(["incremental"]);

    index.removeFact("repo", "incremental");
    expect(index.search("second")).toEqual([]);
  });

  test("an empty or non-matching query returns no results without throwing", async () => {
    const index = new MemoryIndex(new Database(":memory:"));
    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
    expect(index.search("nothing-matches-this")).toEqual([]);
  });

  test("query text with FTS5 special characters does not crash the search", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, memory({
      scope: "repo",
      id: "special-chars",
      title: "npm publish -- danger",
      body: "Never run npm publish without approval.",
    }));
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    expect(() => index.search('npm publish -- "danger" (approval)')).not
      .toThrow();
    expect(
      index.search('npm publish -- "danger" (approval)').map((r) => r.id),
    ).toEqual(["special-chars"]);
  });

  test("rebuild is idempotent and reflects deletions from disk", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, memory({
      scope: "repo",
      id: "will-be-deleted",
      title: "Temporary fact",
      body: "Delete me.",
    }));
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);
    expect(index.search("temporary").length).toEqual(1);

    const { deleteMemoryFact } = await import("../adapters/memory");
    await deleteMemoryFact(root, "repo", "will-be-deleted");
    await index.rebuild(root);
    expect(index.search("temporary")).toEqual([]);
  });
});
