// The prompt an agent is launched with and the files it was assembled from are
// two different generations whenever the daemon loaded before the last edit.
// That gap is silent: an agent reading old rules and a repo holding new ones
// look identical from either side, and it closes on a restart just as quietly.
//
// The stamp is what makes the gap comparable. Each injected block carries the
// digest of exactly the text the daemon injected, so "the prompt agrees with
// disk" is something a test can decide instead of something a reader has to
// notice.
//
// Every positive assertion here is paired with a stale-input probe, and each
// probe first asserts the same helper passes on the same inputs with only the
// staleness removed. A digest test that never sees a mismatching pair cannot
// tell a real comparison from a constant `true`, and a probe with no positive
// control cannot tell a real failure from a fixture that never loaded.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentStandards,
  loadAgentStandards,
} from "../../src/daemon/spawn/agent-standards";
import {
  buildAgentPrompt,
  memoryIndexDigest,
  memoryIndexLines,
  renderMemoryIndex,
  standardsDigest,
} from "../../src/daemon/spawn/spawner-impl";
import { queenBootCapsules } from "../../src/daemon/queen-provider-service/queen-boot-capsule-service";
import {
  buildMemoryIndex,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";

const REPO_ROOT = join(import.meta.dir, "../..");
const WORKTREE = { path: "/tmp/hive-digest-fixture", branch: "hive/digest" };
const TASK = "Prove the injected blocks name their source";

const tempRoots: string[] = [];
// Captured once, before any test can redirect it. Restoring whatever the
// variable happened to hold at the end of a test would delete a HIVE_HOME the
// runner set for the whole process, and the test files after this one would
// silently read the user's real memory instead.
const AMBIENT_HIVE_HOME = process.env.HIVE_HOME;

afterEach(async () => {
  if (AMBIENT_HIVE_HOME === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = AMBIENT_HIVE_HOME;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * A repo holding no memory at all, with global memory pointed at an empty
 * directory of its own.
 *
 * The user's real global memory would otherwise join the index and change
 * it between runs, which turns a digest comparison into a coin flip.
 */
async function emptyRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-digest-repo-"));
  const home = await mkdtemp(join(tmpdir(), "hive-digest-home-"));
  tempRoots.push(root, home);
  process.env.HIVE_HOME = home;
  return root;
}

/** The same isolated repo, holding the one article the digests are taken over. */
async function fixtureRepo(): Promise<string> {
  const root = await emptyRepo();
  await writeMemoryFact(root, {
    scope: "repo",
    id: "digest-fixture-article",
    title: "Digest fixture article",
    topic: "testing",
    body: "The index this test digests is built from this article.",
    source: "agent",
    evidence: "Written by the digest test.",
    status: "unverified",
    kind: "article",
    supersedes: [],
    date: "2026-07-25",
  });
  return root;
}

function assertStandardsStamp(prompt: string, onDisk: AgentStandards): void {
  expect(prompt).toContain(
    `Standards digest sha256:${standardsDigest(onDisk)}`,
  );
}

function assertMemoryStamp(prompt: string, onDisk: string): void {
  expect(prompt).toContain(
    `Memory index digest sha256:${memoryIndexDigest(onDisk)}`,
  );
}

test("the standards block carries the digest of the standards on disk", async () => {
  const standards = await loadAgentStandards(REPO_ROOT);
  const prompt = buildAgentPrompt("celia", TASK, WORKTREE, "", standards, {});
  // Loaded a second time on purpose: the comparison is against what the file
  // says now, not against the object the prompt was built from.
  assertStandardsStamp(prompt, await loadAgentStandards(REPO_ROOT));
});

test("an empty index leaves no memory artifacts in the assembled prompt", async () => {
  // A repo with nothing worth injecting is the ordinary case, not an edge one:
  // a fresh checkout has no articles, and a ranker is allowed to decline. What
  // must not happen is the prompt admitting it looked — a heading, a digest or
  // a "0 memories" placeholder all spend budget to say nothing, and each one
  // teaches the agent that an empty block means the corpus is empty.
  const root = await emptyRepo();
  const index = await buildMemoryIndex(root, { brief: TASK });
  // Asserting the input, not just the output: if retrieval ever starts
  // returning rows here, this fails rather than quietly checking a full index
  // against expectations written for an empty one.
  expect(index).toBe("");
  const prompt = buildAgentPrompt(
    "celia",
    TASK,
    WORKTREE,
    index,
    await loadAgentStandards(REPO_ROOT),
    {},
  );

  expect(prompt).toContain(TASK);
  expect(prompt).not.toContain("Hive memory index");
  expect(prompt).not.toContain("Knowledge index data");
  expect(prompt).not.toContain("Memory index digest");
  expect(prompt).not.toMatch(/\d+ older articles? omitted/);
  expect(prompt).not.toContain("0 memories");
});

test("standards that went stale between load and spawn show up as a digest mismatch", async () => {
  const standards = await loadAgentStandards(REPO_ROOT);
  const onDisk = await loadAgentStandards(REPO_ROOT);
  expect(() =>
    assertStandardsStamp(
      buildAgentPrompt("celia", TASK, WORKTREE, "", standards, {}),
      onDisk,
    ),
  ).not.toThrow();
  const stale: AgentStandards = {
    sections: standards.sections.map((section, index) =>
      index === 0
        ? { ...section, text: "A rule as it read before the last edit." }
        : section,
    ),
  };
  expect(() =>
    assertStandardsStamp(
      buildAgentPrompt("celia", TASK, WORKTREE, "", stale, {}),
      onDisk,
    ),
  ).toThrow();
});

test("the memory index block carries the digest of the index built from disk", async () => {
  const root = await fixtureRepo();
  const index = await buildMemoryIndex(root, { brief: TASK });
  expect(index).toContain("digest-fixture-article");
  const prompt = buildAgentPrompt(
    "celia",
    TASK,
    WORKTREE,
    index,
    await loadAgentStandards(REPO_ROOT),
    {},
  );
  assertMemoryStamp(prompt, await buildMemoryIndex(root, { brief: TASK }));
});

test("worker and queen automatic pushes render the same memory section", async () => {
  const root = await fixtureRepo();
  const index = await buildMemoryIndex(root, { brief: TASK });
  const section = renderMemoryIndex(
    memoryIndexLines(index),
    memoryIndexLines(index).length,
  );
  const worker = buildAgentPrompt(
    "celia",
    TASK,
    WORKTREE,
    index,
    await loadAgentStandards(REPO_ROOT),
    {},
  );
  const queen = queenBootCapsules.composeLaunchContext({
    policy: "pinned queen policy",
    memoryIndex: index,
  }).text;
  expect(section.text).toContain("## Knowledge index data");
  expect(worker).toContain(section.text);
  expect(queen).toContain(section.text);
});

test("crossing the entry cap is named in the delivered prompt, not buried in JSON", async () => {
  const root = await emptyRepo();
  for (let ordinal = 1; ordinal <= 31; ordinal += 1) {
    await writeMemoryFact(root, {
      scope: "repo",
      id: `cap-article-${ordinal}`,
      title: `Cap article ${ordinal}`,
      topic: "testing",
      body: "Entry used to cross the builder cap.",
      source: "agent",
      evidence: "Written by the cap-crossing test.",
      status: "unverified",
      kind: "article",
      supersedes: [],
      date: "2026-07-25",
    });
  }
  const index = await buildMemoryIndex(root, { brief: TASK });
  expect(index).toMatch(/\((\d+) older articles? omitted/);
  const prompt = buildAgentPrompt(
    "celia",
    TASK,
    WORKTREE,
    index,
    await loadAgentStandards(REPO_ROOT),
    {},
  );
  const warningAt = prompt.indexOf("CAP CROSSED:");
  const jsonAt = prompt.indexOf("knowledgeIndexData:");
  expect(warningAt).toBeGreaterThanOrEqual(0);
  expect(jsonAt).toBeGreaterThan(warningAt);
  expect(prompt).toMatch(/"omitted":[1-9]/);
  const encoded = prompt.match(/knowledgeIndexData: ("(?:[^"\\]|\\.)*")/)?.[1];
  const payload = JSON.parse(encoded ?? '""') as string;
  expect(payload).not.toMatch(/\d+ older articles? omitted/);
});

test("crossing the line cap is named in the delivered prompt", async () => {
  const index = `Hive memory index — compiled durable repo knowledge.\n- [repo/testing] ${"m".repeat(600)}`;
  const prompt = buildAgentPrompt(
    "celia",
    TASK,
    WORKTREE,
    index,
    await loadAgentStandards(REPO_ROOT),
    {},
  );
  const warningAt = prompt.indexOf("CAP CROSSED:");
  const jsonAt = prompt.indexOf("knowledgeIndexData:");
  expect(warningAt).toBeGreaterThanOrEqual(0);
  expect(jsonAt).toBeGreaterThan(warningAt);
  expect(prompt).toContain("truncated at 500 characters");
  expect(prompt).toMatch(/"truncated":[1-9]/);
});

test("a memory index that went stale between build and spawn shows up as a digest mismatch", async () => {
  const root = await fixtureRepo();
  const index = await buildMemoryIndex(root, { brief: TASK });
  const standards = await loadAgentStandards(REPO_ROOT);
  const onDisk = await buildMemoryIndex(root, { brief: TASK });
  expect(() =>
    assertMemoryStamp(
      buildAgentPrompt("celia", TASK, WORKTREE, index, standards, {}),
      onDisk,
    ),
  ).not.toThrow();
  const stale = `${index}\n- [repo/testing] a row that is no longer on disk`;
  expect(() =>
    assertMemoryStamp(
      buildAgentPrompt("celia", TASK, WORKTREE, stale, standards, {}),
      onDisk,
    ),
  ).toThrow();
});
