import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile as writeFileRaw } from "node:fs/promises";
import {
  buildMemoryIndex,
  deleteMemoryFact,
  discoverMemoryFacts,
  factVerificationFlag,
  getGlobalMemoryRoot,
  getRepoMemoryRoot,
  listMemoryFacts,
  migrateLegacyMemory,
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

describe("Memory ID validation", () => {
  test("rejects IDs with directory traversal patterns", async () => {
    const root = await makeRoot();
    const traversalIds = [
      "../etc/passwd",
      "../../etc/hosts",
      "../../../root/.ssh/id_rsa",
      "fact/../../../etc/shadow",
      "normal/with/slashes",
    ];
    for (const id of traversalIds) {
      await expect(
        readMemoryFact(root, "repo", id),
      ).rejects.toThrow("Invalid memory id");
      await expect(
        writeMemoryFact(root, {
          scope: "repo",
          id,
          title: "Test",
          body: "Test",
        }),
      ).rejects.toThrow("Invalid memory id");
      await expect(
        deleteMemoryFact(root, "repo", id),
      ).rejects.toThrow("Invalid memory id");
    }
  });

  test("rejects empty IDs and IDs starting with non-alphanumeric", async () => {
    const root = await makeRoot();
    const invalidIds = ["", "-starts-with-dash", "_starts-with-underscore"];
    for (const id of invalidIds) {
      await expect(
        readMemoryFact(root, "repo", id),
      ).rejects.toThrow("Invalid memory id");
    }
  });

  test("allows valid IDs with alphanumeric start and [a-z0-9._-] chars", async () => {
    const root = await makeRoot();
    const validId = "valid-id_with.dots";
    const fact = await writeMemoryFact(root, {
      scope: "repo",
      id: validId,
      title: "Valid",
      body: "Test",
    });
    expect(fact.id).toEqual(validId);
    expect(await readMemoryFact(root, "repo", validId)).not.toBeNull();
    expect(await deleteMemoryFact(root, "repo", validId)).toEqual(true);
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
        // Verified >= date so the cap test isn't perturbed by staleness markers.
        source: "agent",
        verified: `2026-02-01`,
      });
    }
    const index = await buildMemoryIndex(root);
    const entryLines = index.split("\n").filter((line) => line.startsWith("- "));
    expect(entryLines.length).toEqual(30);
    expect(index).toContain("5 older facts omitted");
  });

  // SPEC decision 5: the injected index is a flat tax — one line at ~15–25
  // tokens, capped at 30 lines, so ~500 tokens no matter how large the store
  // grows. This asserts that per-line claim against a realistic fact set (real
  // slug ids and titles, like this repo's committed facts) so a change that
  // fattens the line or lifts the cap trips here. The fixed header/pointer is
  // separate constant overhead the ~500 figure does not count.
  test("the 30-line index tax measures ~500 tokens (~15-25/line) on a realistic full store", async () => {
    const root = await makeRoot();
    // Titles and ids sized like the repo's real facts (e.g.
    // "hive-workspace-restart-handoff", "codex-sandbox-doctored-types").
    const facts: Array<[string, string]> = [
      ["flaky-auth-integration-test", "The auth integration test is flaky"],
      ["codex-sandbox-doctored-types", "Codex sandbox doctored node_modules"],
      ["reindex-after-git-pull", "Reindex memory after an out-of-band pull"],
      ["terminal-title-profile-override", "Terminal titles need a bundled profile"],
      ["quota-window-duration-match", "Quota windows match by reported duration"],
    ];
    // 40 facts, 10 over the cap, with deliberately fat bodies that must never
    // reach the index — only a memory_read pays for a body.
    for (let i = 0; i < 40; i += 1) {
      const [slug, title] = facts[i % facts.length]!;
      await writeMemoryFact(root, {
        scope: i % 3 === 0 ? "global" : "repo",
        id: `${slug}-${String(i).padStart(2, "0")}`,
        title,
        body: "Detailed narrative reasoning. ".repeat(80),
        tags: ["testing", "ci", "durable"],
        date: `2026-${String((i % 12) + 1).padStart(2, "0")}-15`,
        source: "agent",
        verified: `2026-${String((i % 12) + 1).padStart(2, "0")}-16`,
      });
    }
    const index = await buildMemoryIndex(root);
    const entryLines = index.split("\n").filter((line) => line.startsWith("- "));
    expect(entryLines.length).toEqual(30);
    // chars/4 is the standard rough token estimate; no tokenizer is vendored.
    const lineTokens = Math.ceil(entryLines.join("\n").length / 4);
    const perLine = lineTokens / entryLines.length;
    // The spec's load-bearing claim: ~15-25 tokens per line, ~500 for 30 lines.
    expect(perLine).toBeGreaterThan(12);
    expect(perLine).toBeLessThan(28);
    expect(lineTokens).toBeGreaterThan(350);
    expect(lineTokens).toBeLessThan(800);
    // Flatness: the fat bodies never appear, so body size cannot move the tax.
    expect(index).not.toContain("Detailed narrative reasoning");
    // And the whole injected surface (header + pointer + lines) stays a few
    // hundred tokens, not thousands — the ceiling the section exists to hold.
    expect(Math.ceil(index.length / 4)).toBeLessThan(900);
  });

  test("marks unverified and stale facts, leaving a fresh verified fact clean", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, {
      scope: "repo",
      id: "never-checked",
      title: "Never verified",
      body: "x",
      date: "2026-03-01",
    });
    await writeMemoryFact(root, {
      scope: "repo",
      id: "went-stale",
      title: "Verified before its last edit",
      body: "x",
      date: "2026-03-02",
      source: "init",
      verified: "2026-01-01",
    });
    await writeMemoryFact(root, {
      scope: "repo",
      id: "fresh",
      title: "Confirmed after writing",
      body: "x",
      date: "2026-03-03",
      source: "agent",
      verified: "2026-03-03",
    });
    const index = await buildMemoryIndex(root);
    expect(index).toContain("- [repo] never-checked (2026-03-01): Never verified [unverified]");
    expect(index).toContain("- [repo] went-stale (2026-03-02): Verified before its last edit [stale]");
    expect(index).toContain("- [repo] fresh (2026-03-03): Confirmed after writing");
    expect(index).not.toContain("fresh (2026-03-03): Confirmed after writing [");
  });

  test("factVerificationFlag classifies against date as the freshness floor", () => {
    expect(factVerificationFlag({ date: "2026-01-01", verified: undefined }))
      .toEqual("unverified");
    expect(factVerificationFlag({ date: "2026-06-01", verified: "2026-05-01" }))
      .toEqual("stale");
    expect(factVerificationFlag({ date: "2026-06-01", verified: "2026-06-01" }))
      .toBeNull();
    expect(factVerificationFlag({ date: "2026-06-01", verified: "2026-07-01" }))
      .toBeNull();
  });

  test("points at the profile only when one exists, never restating it", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, {
      scope: "repo",
      id: "a-fact",
      title: "A narrative fact",
      body: "x",
      date: "2026-03-01",
      source: "agent",
      verified: "2026-03-01",
    });
    const withoutProfile = await buildMemoryIndex(root);
    expect(withoutProfile).not.toContain("profile.toml");

    await mkdir(join(root, ".hive"), { recursive: true });
    await writeFileRaw(join(root, ".hive", "profile.toml"), "primary_doc = \"SPEC.md\"\n");
    const withProfile = await buildMemoryIndex(root);
    expect(withProfile).toContain(".hive/profile.toml");
    // The pointer names the profile; it does not copy a profile field in.
    expect(withProfile).not.toContain("SPEC.md");
  });
});

describe("provenance and legacy migration", () => {
  test("round-trips source and verified through frontmatter", () => {
    const serialized = serializeMemoryFile({
      title: "Seeded by init",
      date: "2026-06-01",
      tags: ["gotcha"],
      body: "A derived, re-derivable lesson.",
      source: "init",
      verified: "2026-06-01",
    });
    expect(serialized).toContain("source: init");
    expect(serialized).toContain("verified: 2026-06-01");
    const parsed = parseMemoryFile("seeded", "repo", "/fake/seeded.md", serialized);
    expect(parsed.source).toEqual("init");
    expect(parsed.verified).toEqual("2026-06-01");
  });

  test("a legacy fact with no provenance parses as earned and unverified, preserved byte-for-byte", async () => {
    const root = await makeRoot();
    // Shaped exactly like the repo's real committed facts: title/date/tags,
    // no source/verified.
    const legacy =
      "---\ntitle: Hive Workspace restart handoff\ndate: 2026-07-10\ntags: [architecture, restart]\n---\n\nCanonical documents live under docs/architecture/.\n";
    await mkdir(getRepoMemoryRoot(root), { recursive: true });
    const path = join(getRepoMemoryRoot(root), "legacy-handoff.md");
    await writeFileRaw(path, legacy);

    const fact = await readMemoryFact(root, "repo", "legacy-handoff");
    expect(fact?.source).toBeUndefined();
    expect(fact?.verified).toBeUndefined();
    // Absence is the honest "unknown" encoding — recall flags it for re-check.
    expect(factVerificationFlag({ date: fact!.date, verified: fact!.verified }))
      .toEqual("unverified");
    // The migration never rewrote the file: it is preserved exactly.
    expect(await readFile(path, "utf8")).toEqual(legacy);
  });

  test("migrateLegacyMemory reports legacy facts and fabricates nothing", async () => {
    const root = await makeRoot();
    await mkdir(getRepoMemoryRoot(root), { recursive: true });
    await writeFileRaw(
      join(getRepoMemoryRoot(root), "old-one.md"),
      "---\ntitle: Old one\ndate: 2026-01-01\ntags: []\n---\n\nLegacy.\n",
    );
    // A fully-provenanced fact must not be reported.
    await writeMemoryFact(root, {
      scope: "repo",
      id: "new-one",
      title: "New one",
      body: "Earned.",
      date: "2026-06-01",
      source: "agent",
      verified: "2026-06-01",
    });
    const report = await migrateLegacyMemory(root);
    expect(report.scanned).toEqual(2);
    expect(report.stamped).toEqual(0);
    expect(report.legacy).toEqual([
      { scope: "repo", id: "old-one", missingSource: true, missingVerified: true },
    ]);
    // Idempotent and non-destructive: the legacy file is untouched, still legacy.
    const again = await migrateLegacyMemory(root);
    expect(again.legacy).toEqual(report.legacy);
  });

  test("an unrecognized source word degrades to legacy rather than throwing", () => {
    const parsed = parseMemoryFile(
      "weird",
      "repo",
      "/fake/weird.md",
      "---\ntitle: Weird\ndate: 2026-01-01\nsource: robot\ntags: []\n---\n\nBody.\n",
    );
    expect(parsed.source).toBeUndefined();
  });
});
