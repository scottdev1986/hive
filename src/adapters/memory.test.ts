import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryIndex,
  deleteMemoryFact,
  discoverMemoryFacts,
  getGlobalMemoryRoot,
  getRepoMemoryRoot,
  listMemoryFacts,
  parseMemoryFile,
  readMemoryFact,
  serializeMemoryFile,
  writeMemoryFact,
} from "./memory";

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  // Restore the env var before deleting the directories it may still point
  // at, so no later test (in this file or the process) can read a home that
  // was just removed from disk.
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-memory-"));
  tempRoots.push(root);
  process.env.HIVE_HOME = await mkdtemp(join(tmpdir(), "hive-memory-home-"));
  tempRoots.push(process.env.HIVE_HOME);
  return root;
}

describe("Markdown fact serialization", () => {
  test("round-trips title, date, tags, and body through frontmatter", () => {
    const serialized = serializeMemoryFile({
      title: "The login test is flaky",
      date: "2026-06-01",
      tags: ["testing", "ci"],
      body: "Race condition in session setup.",
    });
    expect(serialized).toContain("title: The login test is flaky");
    expect(serialized).toContain("tags: [testing, ci]");

    const parsed = parseMemoryFile(
      "flaky-login-test",
      "repo",
      "/fake/flaky-login-test.md",
      serialized,
    );
    expect(parsed).toEqual({
      id: "flaky-login-test",
      scope: "repo",
      title: "The login test is flaky",
      body: "Race condition in session setup.",
      tags: ["testing", "ci"],
      date: "2026-06-01",
      path: "/fake/flaky-login-test.md",
    });
  });

  test("tolerates a file with no frontmatter by treating the whole thing as body", () => {
    const parsed = parseMemoryFile(
      "no-frontmatter",
      "global",
      "/fake/no-frontmatter.md",
      "Just a plain note.",
    );
    expect(parsed.title).toEqual("no-frontmatter");
    expect(parsed.body).toEqual("Just a plain note.");
    expect(parsed.tags).toEqual([]);
  });

  test("parses an empty tags array", () => {
    const parsed = parseMemoryFile(
      "no-tags",
      "repo",
      "/fake/no-tags.md",
      "---\ntitle: No tags\ndate: 2026-01-01\ntags: []\n---\n\nBody.\n",
    );
    expect(parsed.tags).toEqual([]);
  });
});

describe("Markdown fact CRUD", () => {
  test("writes a new repo fact with a slug derived from the title", async () => {
    const root = await makeRoot();
    const fact = await writeMemoryFact(root, {
      scope: "repo",
      title: "The login test is flaky!",
      body: "Race condition in session setup.",
    });
    expect(fact.id).toEqual("the-login-test-is-flaky");
    expect(fact.path).toEqual(
      join(getRepoMemoryRoot(root), "the-login-test-is-flaky.md"),
    );
    expect(await readFile(fact.path, "utf8")).toContain(
      "title: The login test is flaky!",
    );
  });

  test("disambiguates a colliding slug instead of overwriting", async () => {
    const root = await makeRoot();
    const first = await writeMemoryFact(root, {
      scope: "repo",
      title: "Retry flakiness",
      body: "First fact.",
    });
    const second = await writeMemoryFact(root, {
      scope: "repo",
      title: "Retry flakiness",
      body: "Second, unrelated fact.",
    });
    expect(first.id).toEqual("retry-flakiness");
    expect(second.id).toEqual("retry-flakiness-2");
    expect(await readMemoryFact(root, "repo", "retry-flakiness")).toMatchObject({
      body: "First fact.",
    });
  });

  test("an explicit id overwrites that fact in place", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, {
      scope: "global",
      id: "cli-distribution",
      title: "Python's CLI story",
      body: "Bad.",
    });
    const updated = await writeMemoryFact(root, {
      scope: "global",
      id: "cli-distribution",
      title: "Python's CLI story",
      body: "Bad, use Bun instead.",
    });
    expect(updated.id).toEqual("cli-distribution");
    const facts = await discoverMemoryFacts(root, "global");
    expect(facts.length).toEqual(1);
    expect(facts[0]?.body).toEqual("Bad, use Bun instead.");
  });

  test("readMemoryFact returns null for a missing fact", async () => {
    const root = await makeRoot();
    expect(await readMemoryFact(root, "repo", "nope")).toBeNull();
  });

  test("deleteMemoryFact removes the file and reports whether it existed", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, {
      scope: "repo",
      id: "gone-soon",
      title: "Gone soon",
      body: "Temp.",
    });
    expect(await deleteMemoryFact(root, "repo", "gone-soon")).toEqual(true);
    expect(await readMemoryFact(root, "repo", "gone-soon")).toBeNull();
    expect(await deleteMemoryFact(root, "repo", "gone-soon")).toEqual(false);
  });

  test("listMemoryFacts merges both scopes, correctly tagged", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, {
      scope: "repo",
      title: "Repo lesson",
      body: "Local.",
    });
    await writeMemoryFact(root, {
      scope: "global",
      title: "Global lesson",
      body: "Everywhere.",
    });
    const facts = await listMemoryFacts(root);
    expect(facts.map((fact) => [fact.scope, fact.title]).sort()).toEqual([
      ["global", "Global lesson"],
      ["repo", "Repo lesson"],
    ]);
  });

  test("discovering an empty or missing scope directory yields no facts", async () => {
    const root = await makeRoot();
    expect(await discoverMemoryFacts(root, "repo")).toEqual([]);
    expect(getGlobalMemoryRoot()).toContain("memory");
  });
});

describe("merged memory index for context injection", () => {
  test("is empty when neither scope has facts", async () => {
    const root = await makeRoot();
    expect(await buildMemoryIndex(root)).toEqual("");
  });

  test("lists newest-first, one line per fact, scoped and dated", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, {
      scope: "repo",
      id: "older",
      title: "Older repo fact",
      body: "x",
      date: "2026-01-01",
    });
    await writeMemoryFact(root, {
      scope: "global",
      id: "newer",
      title: "Newer global fact",
      body: "x",
      date: "2026-06-01",
    });
    const index = await buildMemoryIndex(root);
    const lines = index.split("\n");
    const newerLine = lines.findIndex((line) => line.includes("newer"));
    const olderLine = lines.findIndex((line) => line.includes("older"));
    expect(newerLine).toBeGreaterThan(-1);
    expect(olderLine).toBeGreaterThan(newerLine);
    expect(index).toContain(
      "- [global] newer (2026-06-01): Newer global fact",
    );
    expect(index).toContain("- [repo] older (2026-01-01): Older repo fact");
  });

  test("caps entries and notes what was omitted", async () => {
    const root = await makeRoot();
    for (let i = 0; i < 35; i += 1) {
      await writeMemoryFact(root, {
        scope: "repo",
        id: `fact-${String(i).padStart(2, "0")}`,
        title: `Fact ${i}`,
        body: "x",
        date: `2026-01-${String((i % 27) + 1).padStart(2, "0")}`,
      });
    }
    const index = await buildMemoryIndex(root);
    const entryLines = index.split("\n").filter((line) => line.startsWith("- "));
    expect(entryLines.length).toEqual(30);
    expect(index).toContain("5 older facts omitted");
  });
});
