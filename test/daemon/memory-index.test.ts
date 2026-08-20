import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import {
  listMemoryFacts,
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
    // Born unverified: only a later session can verify, and these cases are
    // about indexing rather than verification.
    status: "unverified",
    supersedes: [],
    date: "2026-07-12",
    ...overrides,
  };
}

describe("MemoryIndex (SQLite FTS over Markdown facts)", () => {
  test("rebuild indexes every fact from disk and search finds them by title or body", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "flaky-login-test",
        title: "The login test is flaky",
        body: "Race condition in session setup causes intermittent failures.",
        tags: ["testing"],
      }),
    );
    await writeMemoryFact(
      root,
      memory({
        scope: "global",
        id: "cli-distribution",
        title: "Python's CLI distribution story",
        body: "Bad; prefer a single compiled binary.",
        tags: [],
      }),
    );

    const index = new MemoryIndex(new Database(":memory:"));
    const rebuilt = await index.rebuild(root);
    expect(rebuilt.count).toEqual(2);

    const byTitle = index.search("flaky");
    expect(byTitle.map((result) => result.id)).toEqual(["flaky-login-test"]);
    expect(byTitle[0]?.scope).toEqual("repo");
    expect(byTitle[0]?.snippet.toLowerCase()).toContain("race");

    const byBody = index.search("compiled binary");
    expect(byBody.map((result) => result.id)).toContain("cli-distribution");
  });

  test("scope filters restrict search to one scope", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "shared-term",
        title: "Repo note about caching",
        body: "caching details",
      }),
    );
    await writeMemoryFact(
      root,
      memory({
        scope: "global",
        id: "shared-term-global",
        title: "Global note about caching",
        body: "caching details",
      }),
    );
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    expect(index.search("caching", { scope: "repo" }).map((r) => r.id)).toEqual(
      ["shared-term"],
    );
    expect(
      index.search("caching", { scope: "global" }).map((r) => r.id),
    ).toEqual(["shared-term-global"]);
    expect(index.search("caching").length).toEqual(2);
  });

  test("upsertFact and removeFact keep the index in sync without a full rebuild", async () => {
    const root = await makeRoot();
    const index = new MemoryIndex(new Database(":memory:"));
    const fact = await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "incremental",
        title: "Incremental fact",
        body: "First body text.",
      }),
    );
    index.upsertFact(fact);
    expect(index.search("first").map((r) => r.id)).toEqual(["incremental"]);

    const updated = { ...fact, body: "Second body text entirely." };
    index.upsertFact(updated);
    expect(index.search("first")).toEqual([]);
    expect(index.search("second").map((r) => r.id)).toEqual(["incremental"]);

    index.removeFact("repo", "incremental");
    expect(index.search("second")).toEqual([]);
  });

  test("preserves tags containing spaces through the FTS row", async () => {
    const root = await makeRoot();
    const index = new MemoryIndex(new Database(":memory:"));
    const fact = await writeMemoryFact(
      root,
      memory({ id: "spaced-tag", tags: ["release gate", "memory"] }),
    );
    index.upsertFact(fact);

    expect(index.search("test")[0]?.tags).toEqual(["release gate", "memory"]);
  });

  test("an empty or non-matching query returns no results without throwing", async () => {
    const index = new MemoryIndex(new Database(":memory:"));
    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
    expect(index.search("nothing-matches-this")).toEqual([]);
  });

  test("query text with FTS5 special characters does not crash the search", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "special-chars",
        title: "npm publish -- danger",
        body: "Never run npm publish without approval.",
      }),
    );
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    expect(() =>
      index.search('npm publish -- "danger" (approval)'),
    ).not.toThrow();
    expect(
      index.search('npm publish -- "danger" (approval)').map((r) => r.id),
    ).toEqual(["special-chars"]);
  });

  // Three articles that between them cover "mail", "delivery" and "bug",
  // and no one of which covers all three — the shape an ordinary multi-word
  // brief meets in a real corpus.
  async function seedPartialOverlapCorpus(): Promise<string> {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "corpus-alpha",
        title: "Mail poll aborts on a missing receipt",
        body: "A mail item with no receipt aborts the whole poll wholesale.",
      }),
    );
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "corpus-bravo",
        title: "Delivery receipt rows are written after publish",
        body: "Each delivery row records that the mail item left the queue.",
      }),
    );
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "corpus-charlie",
        title: "Bug triage lane ordering",
        body: "Every reported bug is triaged before the sprint mail goes out.",
      }),
    );
    return root;
  }

  test("a multi-token query no single article covers in full still returns its parts", async () => {
    const root = await seedPartialOverlapCorpus();
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    const ids = index.search("mail delivery bug").map((result) => result.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("corpus-bravo");
    expect(ids).toContain("corpus-charlie");
  });

  test("a single-token query returns every article carrying that token", async () => {
    const root = await seedPartialOverlapCorpus();
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    expect(index.search("mail").length).toEqual(3);
  });

  // Ten short, term-dense articles plus one long pitfall that mentions the
  // term once: bm25 ranks the pitfall below all ten, so a caller taking the
  // top 8 and filtering to pitfalls afterwards sees nothing at all.
  async function seedPitfallBuriedCorpus(): Promise<string> {
    const root = await makeRoot();
    for (let index = 0; index < 10; index += 1) {
      await writeMemoryFact(
        root,
        memory({
          scope: "repo",
          id: `filler-${index}`,
          title: `Rebase notes ${index}`,
          body: "Rebase rebase rebase.",
        }),
      );
    }
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "buried-pitfall",
        kind: "pitfall",
        title: "Retried work silently loses commits",
        body:
          "A long account of an incident in which work was replayed after a " +
          "conflict was resolved by hand, the tooling reported success, and " +
          "the commits that had been picked earlier were quietly discarded " +
          "without any warning to the user who had asked for the rebase " +
          "and who then shipped the truncated history to everybody else.",
      }),
    );
    return root;
  }

  test("a kind filter narrows the search in SQL, so the limit applies to matching rows", async () => {
    const root = await seedPitfallBuriedCorpus();
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    // The precondition, asserted rather than assumed: the pitfall really is
    // ranked outside the window a caller would take.
    expect(
      index.search("rebase", { limit: 8 }).map((result) => result.id),
    ).not.toContain("buried-pitfall");

    expect(
      index
        .search("rebase", { limit: 8, kind: "pitfall" })
        .map((result) => result.id),
    ).toEqual(["buried-pitfall"]);
  });

  // One reviewed article plus three auto-harvest stubs carrying the
  // harvester's exact provenance signature. The stubs are short and
  // term-dense so bm25 puts every one of them above the article: if the
  // article comes back first, it is because the stubs were excluded and not
  // because they ranked badly.
  async function seedHarvestStubCorpus(): Promise<string> {
    const root = await makeRoot();
    for (let index = 0; index < 3; index += 1) {
      await writeMemoryFact(
        root,
        memory({
          scope: "repo",
          id: `stub-${index}`,
          topic: "pitfalls",
          kind: "pitfall",
          title: `Pitfall: broker broker ${index}`,
          body: "Broker broker broker.",
          tags: ["pitfall", "harvest"],
          source: "orchestrator",
          status: "unverified",
          verified: undefined,
        }),
      );
    }
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "reviewed-article",
        topic: "daemon",
        title: "Restart the broker before reattaching",
        body:
          "A reviewed account of why the session broker must be restarted " +
          "before a client reattaches to it, written up after the incident " +
          "was understood rather than at the moment it was noticed.",
        tags: ["daemon"],
        source: "user",
      }),
    );
    // An unverified article that is nobody's harvest candidate: a rescued
    // mechanism written up by hand and not yet re-checked. Most of the
    // corpus's real knowledge looks like this, which is why the quarantine
    // cannot key on status.
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "rescued-mechanism",
        topic: "daemon",
        title: "The broker reattach handshake, as far as it is understood",
        body:
          "Reconstructed from the code rather than observed: the broker " +
          "replays its buffer on reattach, and nobody has yet confirmed " +
          "what happens when the buffer has already wrapped.",
        tags: ["daemon"],
        source: "agent",
        status: "unverified",
        verified: undefined,
      }),
    );
    return root;
  }

  test("rebuild retires legacy harvest articles instead of hiding them", async () => {
    const root = await seedHarvestStubCorpus();
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    const facts = await listMemoryFacts(root);
    const ranked = index.search("broker").map((result) => result.id);
    expect(facts).toHaveLength(2);
    expect(facts.some((fact) => fact.tags.includes("harvest"))).toBe(false);
    expect(ranked.toSorted()).toEqual([
      "rescued-mechanism",
      "reviewed-article",
    ]);
  });

  test("widening never costs precision: a multi-token query some article covers in full returns only those", async () => {
    const root = await seedPartialOverlapCorpus();
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);

    expect(index.search("mail poll").map((result) => result.id)).toEqual([
      "corpus-alpha",
    ]);
  });

  test("rebuild is idempotent and reflects deletions from disk", async () => {
    const root = await makeRoot();
    await writeMemoryFact(
      root,
      memory({
        scope: "repo",
        id: "will-be-deleted",
        title: "Temporary fact",
        body: "Delete me.",
      }),
    );
    const index = new MemoryIndex(new Database(":memory:"));
    await index.rebuild(root);
    expect(index.search("temporary").length).toEqual(1);

    const { deleteMemoryFact } =
      await import("../../src/memory-service/memory-store");
    await deleteMemoryFact(root, "repo", "will-be-deleted");
    await index.rebuild(root);
    expect(index.search("temporary")).toEqual([]);
  });
});
