import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
} from "./memory";
import type { MemoryWriteInput } from "../schemas";

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
    expect(report).toEqual({
      scanned: 1,
      migrated: 1,
      flagged: [{ scope: "repo", id: "corrected-router", status: "unverified" }],
    });
    const article = await readMemoryFact(root, "repo", "corrected-router");
    expect(article?.title).toBe("Router truth");
    expect(article?.topic).toBe("routing");
    expect(article?.source).toBe("legacy");
    expect(article?.status).toBe("unverified");
    const preserved = join(article!.path, "..", article!.raw[0]!);
    expect(await readFile(preserved, "utf8")).toBe(original);
    await expect(readFile(join(directory, "corrected-router.md"), "utf8"))
      .rejects.toThrow();
  });

  test("is idempotent after legacy files are consumed", async () => {
    const root = await makeRoot();
    expect(await migrateLegacyMemory(root)).toEqual({
      scanned: 0,
      migrated: 0,
      flagged: [],
    });
    expect(await migrateLegacyMemory(root)).toEqual({
      scanned: 0,
      migrated: 0,
      flagged: [],
    });
  });
});
