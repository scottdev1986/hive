import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryIndex,
  deleteMemoryFact,
  discoverMemoryFacts,
  factVerificationFlag,
  getRepoMemoryRoot,
  migrateLegacyMemory,
  readMemoryFact,
  writeMemoryFact,
} from "../../src/adapters/memory";
import type { MemoryWriteInput } from "../../src/schemas";

const roots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-memory-"));
  roots.push(root);
  process.env.HIVE_HOME = await mkdtemp(join(tmpdir(), "hive-memory-home-"));
  roots.push(process.env.HIVE_HOME);
  return root;
}

function input(
  overrides: Partial<MemoryWriteInput> = {},
): MemoryWriteInput {
  return {
    scope: "repo",
    topic: "testing",
    title: "The login test is flaky",
    body: "The current account of the failure.",
    source: "agent",
    evidence: "Measured in the integration suite with seed 42",
    status: "verified",
    kind: "article",
    supersedes: [],
    verified: "2026-07-12",
    date: "2026-07-12",
    ...overrides,
  };
}

describe("raw observations and compiled articles", () => {
  test("one write creates immutable raw evidence, a compiled article, index, and log", async () => {
    const root = await makeRoot();
    const written = await writeMemoryFact(root, input());

    expect(written.id).toBe("the-login-test-is-flaky");
    expect(written.path).toContain("/wiki/testing/");
    expect(written.rawPath).toContain("/raw/testing/2026-07-12-");
    expect(await readFile(written.rawPath, "utf8")).toContain("## Evidence");
    expect(await readFile(written.path, "utf8")).toContain("status: verified");
    expect(await readFile(
      join(getRepoMemoryRoot(root), "wiki", "index.md"),
      "utf8",
    )).toContain("[repo/testing] the-login-test-is-flaky");
    expect(await readFile(
      join(getRepoMemoryRoot(root), "wiki", "log.md"),
      "utf8",
    )).toContain("ingest | The login test is flaky");
  });

  test("normalizes NUL bytes before writing memory text", async () => {
    const root = await makeRoot();
    const written = await writeMemoryFact(root, input({
      title: "NUL\0 title",
      body: "Body\0 text",
      evidence: "Evidence\0 text",
      tags: ["tag\0value"],
    }));
    const paths = [
      written.rawPath,
      written.path,
      join(getRepoMemoryRoot(root), "wiki", "index.md"),
      join(getRepoMemoryRoot(root), "wiki", "log.md"),
    ];

    expect(written.title).toBe("NUL\uFFFD title");
    expect(written.body).toBe("Body\uFFFD text");
    for (const path of paths) {
      const contents = await readFile(path, "utf8");
      expect(contents).not.toContain("\0");
      expect(contents).toContain("\uFFFD");
    }
  });

  test("updating an article preserves both raw observations and supersession", async () => {
    const root = await makeRoot();
    const first = await writeMemoryFact(root, input({ id: "login-flake" }));
    const second = await writeMemoryFact(root, input({
      id: "login-flake",
      body: "The corrected current account.",
      evidence: "A deterministic reproducer disproved the race hypothesis",
      supersedes: ["login-flake"],
    }));

    expect(second.rawPath).not.toBe(first.rawPath);
    expect(await readFile(first.rawPath, "utf8")).toContain(
      "The current account of the failure.",
    );
    const article = await readMemoryFact(root, "repo", "login-flake");
    expect(article?.body).toBe("The corrected current account.");
    expect(article?.raw).toHaveLength(2);
    expect(article?.supersedes).toEqual(["login-flake"]);
  });

  test("a changed current account cannot omit its supersedes edge", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({ id: "login-flake" }));
    await expect(writeMemoryFact(root, input({
      id: "login-flake",
      body: "A different account.",
    }))).rejects.toThrow("requires supersedes: [login-flake]");
  });

  test("superseding a duplicate id removes its article and carries its raw evidence", async () => {
    const root = await makeRoot();
    const duplicate = await writeMemoryFact(root, input({
      id: "duplicate",
      title: "Duplicate account",
    }));
    const canonical = await writeMemoryFact(root, input({
      id: "canonical",
      title: "Canonical account",
      supersedes: ["duplicate"],
    }));
    expect(await readMemoryFact(root, "repo", "duplicate")).toBeNull();
    expect(canonical.supersededIds).toEqual(["duplicate"]);
    expect(canonical.raw.some((path) =>
      path.endsWith(duplicate.rawPath.split("/").at(-1)!)
    )).toBe(true);
  });

  test("rejects malformed writes before creating memory files", async () => {
    const root = await makeRoot();
    await expect(writeMemoryFact(root, {
      ...input(),
      topic: "Not A Topic",
    } as MemoryWriteInput)).rejects.toThrow("topic must be lowercase kebab-case");
    await expect(writeMemoryFact(root, {
      ...input(),
      verified: undefined,
    })).rejects.toThrow("verified date is required");
    await expect(writeMemoryFact(root, input({
      status: "conflicted",
      verified: undefined,
      body: "Two claims exist.",
    }))).rejects.toThrow("must annotate the disagreement");
    expect(await discoverMemoryFacts(root, "repo")).toEqual([]);
  });

  test("rejects an unresolved supersedes relationship", async () => {
    const root = await makeRoot();
    await expect(writeMemoryFact(root, input({
      supersedes: ["does-not-exist"],
    }))).rejects.toThrow("Superseded memory article not found");
  });

  test("does not permit an id to drift between topic directories", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({ id: "stable-id" }));
    await expect(writeMemoryFact(root, input({
      id: "stable-id",
      topic: "delivery",
    }))).rejects.toThrow("already belongs to topic testing");
  });

  test("delete removes only the compiled article, retaining raw evidence", async () => {
    const root = await makeRoot();
    const written = await writeMemoryFact(root, input({ id: "delete-me" }));
    expect(await deleteMemoryFact(root, "repo", "delete-me")).toBe(true);
    expect(await readMemoryFact(root, "repo", "delete-me")).toBeNull();
    expect(await readFile(written.rawPath, "utf8")).toContain("Observation");
  });

  test("a normalized-title duplicate under a different id is rejected with an update pointer", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({
      id: "quota-token-spend",
      title: "Quota: Token Spend!",
    }));

    await expect(writeMemoryFact(root, input({
      id: "spend-notes",
      title: "quota token spend",
      body: "The same fact, written twice.",
    }))).rejects.toThrow(
      'Duplicate memory article title: [repo] quota-token-spend already covers ' +
        '"Quota: Token Spend!". Re-issue as an update to that id: write with ' +
        'id "quota-token-spend" and supersedes: ["quota-token-spend"].',
    );
    // Nothing was written for the rejected duplicate.
    expect(await readMemoryFact(root, "repo", "spend-notes")).toBeNull();

    // Re-issued as an update to the named id, the write goes through.
    const updated = await writeMemoryFact(root, input({
      id: "quota-token-spend",
      title: "quota token spend",
      body: "The same fact, corrected in place.",
      supersedes: ["quota-token-spend"],
    }));
    expect(updated.id).toBe("quota-token-spend");
    expect((await readMemoryFact(root, "repo", "quota-token-spend"))?.body)
      .toBe("The same fact, corrected in place.");
  });

  test("genuinely different titles do not collide", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({
      id: "quota-token-spend",
      title: "Quota token spend",
    }));
    const other = await writeMemoryFact(root, input({
      id: "quota-spend-policy",
      title: "Quota spend policy",
    }));
    expect(other.id).toBe("quota-spend-policy");
  });

  test("delete is refused while another article's supersedes points at the target", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({ id: "old-fact", title: "Old fact" }));
    await writeMemoryFact(root, input({
      id: "new-fact",
      title: "New fact",
      supersedes: ["old-fact"],
    }));
    // The superseding write removed the old article; re-create it so a live
    // supersedes pointer (new-fact -> old-fact) targets a live article.
    await writeMemoryFact(root, input({ id: "old-fact", title: "Old fact" }));

    await expect(deleteMemoryFact(root, "repo", "old-fact")).rejects.toThrow(
      "Cannot delete memory article [repo] old-fact: still referenced in " +
        "supersedes by [repo] new-fact",
    );
    expect(await readMemoryFact(root, "repo", "old-fact")).not.toBeNull();

    // Once the referencing article is itself superseded away, the pointer is
    // gone and the delete goes through.
    await writeMemoryFact(root, input({
      id: "newest-fact",
      title: "Newest fact",
      supersedes: ["new-fact"],
    }));
    expect(await deleteMemoryFact(root, "repo", "old-fact")).toBe(true);
    expect(await readMemoryFact(root, "repo", "old-fact")).toBeNull();
  });

  test("validates ids before resolving filesystem paths", async () => {
    const root = await makeRoot();
    await expect(readMemoryFact(root, "repo", "../escape"))
      .rejects.toThrow("Invalid memory id");
  });
});

describe("spawn index", () => {
  test("injects compiled pointers only, newest first", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({
      id: "older",
      date: "2026-07-10",
      verified: "2026-07-10",
      body: "A body that must not be injected.",
    }));
    await writeMemoryFact(root, input({
      id: "newer",
      scope: "global",
      topic: "delivery",
    }));
    const index = await buildMemoryIndex(root);
    expect(index.indexOf("newer")).toBeLessThan(index.indexOf("older"));
    expect(index).toContain("[global/delivery]");
    expect(index).not.toContain("A body that must not be injected");
  });

  test("normalizes NUL bytes found in a pre-existing compiled article", async () => {
    const root = await makeRoot();
    const written = await writeMemoryFact(root, input({ id: "legacy-nul" }));
    const contaminated = (await readFile(written.path, "utf8"))
      .replace("The login test", "The login\0 test");
    await writeFile(written.path, contaminated);

    const index = await buildMemoryIndex(root);

    expect(index).not.toContain("\0");
    expect(index).toContain("The login\uFFFD test");
    expect(await readFile(
      join(getRepoMemoryRoot(root), "wiki", "index.md"),
      "utf8",
    )).not.toContain("\0");
  });

  test("caps the always-paid surface at 30 article rows", async () => {
    const root = await makeRoot();
    for (let index = 0; index < 35; index += 1) {
      await writeMemoryFact(root, input({
        id: `fact-${index}`,
        title: `Fact ${index}`,
      }));
    }
    const built = await buildMemoryIndex(root);
    expect(built.split("\n").filter((line) => line.startsWith("- [")))
      .toHaveLength(30);
    expect(built).toContain("5 older articles omitted");
    expect(Math.ceil(built.length / 4)).toBeLessThan(900);
  });

  test("an old pitfall outranks fresh articles within the cap", async () => {
    const root = await makeRoot();
    for (let index = 0; index < 35; index += 1) {
      await writeMemoryFact(root, input({
        id: `fresh-${index}`,
        title: `Fresh finding ${index}`,
      }));
    }
    await writeMemoryFact(root, input({
      id: "old-pitfall",
      title: "Do not trust the quota cache",
      kind: "pitfall",
      date: "2026-05-20",
      verified: "2026-05-20",
    }));
    const built = await buildMemoryIndex(root);
    const rows = built.split("\n").filter((line) => line.startsWith("- ["));
    expect(rows).toHaveLength(30);
    expect(rows[0]).toContain("old-pitfall");
    expect(rows[0]).toContain("[pitfall]");
    expect(built).toContain("6 older articles omitted");
  });

  test("an older article matching the brief outranks newer unrelated ones", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({
      id: "quota-reconciliation",
      title: "Quota tables double-count on retry",
      date: "2026-06-01",
      verified: "2026-06-01",
    }));
    await writeMemoryFact(root, input({
      id: "login-flake",
      title: "The login test is flaky",
    }));
    await writeMemoryFact(root, input({
      id: "deploy-freeze",
      title: "Deploys freeze under load",
    }));
    const built = await buildMemoryIndex(root, {
      brief: "Repair the quota tables reconciliation",
    });
    expect(built.indexOf("quota-reconciliation"))
      .toBeLessThan(built.indexOf("login-flake"));
    expect(built.indexOf("quota-reconciliation"))
      .toBeLessThan(built.indexOf("deploy-freeze"));
  });

  test("without a brief it degrades to pitfalls then newest, capped, no duplicates", async () => {
    const root = await makeRoot();
    await writeMemoryFact(root, input({
      id: "old-pitfall",
      title: "Old lesson",
      kind: "pitfall",
      date: "2026-05-01",
      verified: "2026-05-01",
    }));
    await writeMemoryFact(root, input({
      id: "newer-pitfall",
      title: "Newer lesson",
      kind: "pitfall",
      date: "2026-06-01",
      verified: "2026-06-01",
    }));
    for (let index = 0; index < 35; index += 1) {
      await writeMemoryFact(root, input({
        id: `fresh-${index}`,
        title: `Fresh finding ${index}`,
      }));
    }
    const built = await buildMemoryIndex(root);
    const rows = built.split("\n").filter((line) => line.startsWith("- ["));
    expect(rows).toHaveLength(30);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows[0]).toContain("newer-pitfall");
    expect(rows[1]).toContain("old-pitfall");
    expect(rows.slice(2).every((line) => !line.includes("[pitfall]")))
      .toBe(true);
    expect(built).toContain("7 older articles omitted");
  });

  test("the omitted count stays accurate when relevance ranking trims the cap", async () => {
    const root = await makeRoot();
    for (let index = 0; index < 31; index += 1) {
      await writeMemoryFact(root, input({
        id: `unrelated-${index}`,
        title: `Unrelated finding ${index}`,
      }));
    }
    await writeMemoryFact(root, input({
      id: "quota-reconciliation",
      title: "Quota tables double-count on retry",
      date: "2026-06-01",
      verified: "2026-06-01",
    }));
    const built = await buildMemoryIndex(root, {
      brief: "Repair the quota tables reconciliation",
    });
    const rows = built.split("\n").filter((line) => line.startsWith("- ["));
    expect(rows).toHaveLength(30);
    expect(rows[0]).toContain("quota-reconciliation");
    expect(built).toContain("2 older articles omitted");
  });

  test("surfaces verification status directly", () => {
    expect(factVerificationFlag({
      status: "conflicted",
      date: "2026-07-12",
    })).toBe("conflicted");
    expect(factVerificationFlag({
      status: "verified",
      date: "2026-07-12",
      verified: "2026-07-12",
    })).toBeNull();
  });
});

describe("legacy flat-memory migration", () => {
  test("preserves source bytes in raw and compiles current truth", async () => {
    const root = await makeRoot();
    const directory = getRepoMemoryRoot(root);
    await Bun.write(join(directory, "corrected-router.md"),
      "---\ntitle: CORRECTED: Router truth\ndate: 2026-07-11\ntags: [router]\n---\n\nThe corrected account.\n");
    const original = await readFile(join(directory, "corrected-router.md"), "utf8");

    const report = await migrateLegacyMemory(root);
    expect(report.scanned).toBe(1);
    expect(report.migrated).toBe(1);
    expect(report.flagged).toEqual([
      { scope: "repo", id: "corrected-router", status: "unverified" },
    ]);
    expect(report.alreadyMigrated).toEqual([]);
    expect(report.backups).toEqual([
      { scope: "repo", path: expect.stringContaining("memory-backups/legacy-v1-") },
    ]);
    const article = await readMemoryFact(root, "repo", "corrected-router");
    expect(article?.title).toBe("Router truth");
    expect(article?.topic).toBe("routing");
    expect(article?.source).toBe("legacy");
    expect(article?.status).toBe("unverified");
    const preserved = join(article!.path, "..", article!.raw[0]!);
    expect(await readFile(preserved, "utf8")).toBe(original);
    expect(await readFile(join(directory, "corrected-router.md"), "utf8"))
      .toBe(original);
    expect(await readFile(
      join(report.backups[0]!.path, "corrected-router.md"),
      "utf8",
    )).toBe(original);

    const beforeSecond = {
      raw: await readdir(join(directory, "raw", "routing")),
      articles: await readdir(join(directory, "wiki", "routing")),
      log: await readFile(join(directory, "wiki", "log.md"), "utf8"),
      backups: await readdir(join(root, ".hive", "memory-backups")),
    };
    const second = await migrateLegacyMemory(root);
    expect(second).toEqual({
      scanned: 1,
      migrated: 0,
      flagged: [],
      backups: [],
      alreadyMigrated: ["repo"],
    });
    expect(await readdir(join(directory, "raw", "routing"))).toEqual(beforeSecond.raw);
    expect(await readdir(join(directory, "wiki", "routing"))).toEqual(beforeSecond.articles);
    expect(await readFile(join(directory, "wiki", "log.md"), "utf8"))
      .toBe(beforeSecond.log);
    expect(await readdir(join(root, ".hive", "memory-backups")))
      .toEqual(beforeSecond.backups);
  });

  test("an empty store is a no-op", async () => {
    const root = await makeRoot();
    expect(await migrateLegacyMemory(root)).toEqual({
      scanned: 0,
      migrated: 0,
      flagged: [],
      backups: [],
      alreadyMigrated: [],
    });
    expect(await migrateLegacyMemory(root)).toEqual({
      scanned: 0,
      migrated: 0,
      flagged: [],
      backups: [],
      alreadyMigrated: [],
    });
  });

  test("refuses a migration marker whose backup key is unknown", async () => {
    const root = await makeRoot();
    const directory = getRepoMemoryRoot(root);
    await Bun.write(
      join(directory, "router.md"),
      "---\ntitle: Router\ndate: 2026-07-11\n---\n\nSource.\n",
    );
    await migrateLegacyMemory(root);
    await writeFile(
      join(directory, "wiki", ".legacy-migration-v1.json"),
      JSON.stringify({ bakcup: "/tmp/legacy-backup" }),
    );

    expect(migrateLegacyMemory(root)).rejects.toThrow(
      "Invalid legacy memory migration marker",
    );
  });

  test("backs up the whole corpus before a failed first compile write", async () => {
    const root = await makeRoot();
    const directory = getRepoMemoryRoot(root);
    const original = "---\ntitle: Router\ndate: 2026-07-11\ntags: [router]\n---\n\nSource.\n";
    await Bun.write(join(directory, "router.md"), original);
    const rawDirectory = join(directory, "raw", "routing");
    await mkdir(rawDirectory, { recursive: true });
    await writeFile(join(rawDirectory, "2026-07-11-router.md"), "different\n");

    await expect(migrateLegacyMemory(root)).rejects.toThrow(
      "already contains different evidence",
    );
    const backups = await readdir(join(root, ".hive", "memory-backups"));
    expect(backups).toHaveLength(1);
    expect(await readFile(
      join(root, ".hive", "memory-backups", backups[0]!, "router.md"),
      "utf8",
    )).toBe(original);
    expect(await readFile(join(directory, "router.md"), "utf8")).toBe(original);
    expect(await readFile(
      join(directory, "raw", "routing", "2026-07-11-router.md"),
      "utf8",
    )).toBe("different\n");
    expect(await readdir(join(directory, "wiki")).catch(() => [])).toEqual([]);
    expect((await readdir(join(root, ".hive"))).filter((name) =>
      name.startsWith("memory-restore-") || name.startsWith("memory-failed-")
    )).toEqual([]);
  });
});
