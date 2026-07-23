import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBriefableDocs, rankPrimaryDoc } from "../../src/adapters/briefing-docs";

// --- synthetic repo helpers -------------------------------------------------

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hive-briefing-docs-"));
}

function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function write(root: string, relativePath: string, body: string): Promise<void> {
  const full = join(root, relativePath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body);
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message, "--no-gpg-sign"]);
}

// --- primary-doc ranking ----------------------------------------------------

describe("rankPrimaryDoc", () => {
  test("picks the most inbound-linked doc as primary", () => {
    const primary = rankPrimaryDoc(["SPEC.md", "NOTES.md"], [
      { path: "README.md", text: "see [the spec](SPEC.md) and [again](./SPEC.md)" },
      { path: "NOTES.md", text: "one ref to [SPEC](../SPEC.md#routing)" },
    ]);
    expect(primary).toBe("SPEC.md");
  });

  test("reference-style links and anchors are citations too", () => {
    expect(rankPrimaryDoc(["NOTES.md", "TODO.md"], [
      { path: "TODO.md", text: "the plan is in [notes][n]\n\n[n]: NOTES.md#plan" },
    ])).toBe("NOTES.md");
  });

  test("a doc that merely TALKS ABOUT another doc does not vote for it", () => {
    const primary = rankPrimaryDoc(["SPEC.md", "CLAUDE.md"], [
      { path: "SPEC.md", text: "the design" },
      { path: "README.md", text: "the design lives in [the spec](SPEC.md)" },
      {
        path: "docs/grok-contract.md",
        text: [
          "Grok ingests the repository's CLAUDE.md even with compat off.",
          "CLAUDE.md was written for another vendor's agents.",
          "Follow CLAUDE.md's engineering conventions, but your brief wins.",
          "The repository's CLAUDE.md is not addressed to you.",
        ].join("\n"),
      },
    ]);
    // CLAUDE.md is named four times and linked zero times. It is not the primary.
    expect(primary).toBe("SPEC.md");
  });

  test("mentions cannot outvote a citation, however many there are", () => {
    // The effect, stated as starkly as it can be: one link beats a hundred
    // mentions, because a mention is not evidence of anything.
    const shouting = Array.from({ length: 100 }, () => "NOTES.md").join(" ");
    expect(rankPrimaryDoc(["GUIDE.md", "NOTES.md"], [
      { path: "chatter.md", text: shouting },
      { path: "index.md", text: "start at [the guide](GUIDE.md)" },
    ])).toBe("GUIDE.md");
  });

  test("a repo whose docs cite nothing and carry no design role has no primary", () => {
    expect(rankPrimaryDoc(["notes.md", "todo.md"], [
      { path: "notes.md", text: "grocery list" },
      { path: "todo.md", text: "call the bank" },
    ])).toBeNull();
  });

  test("a design-role name is primary even before anything cites it", () => {
    expect(rankPrimaryDoc(["DESIGN.md"], [{ path: "DESIGN.md", text: "" }]))
      .toBe("DESIGN.md");
  });
});

// --- docs are discovered on disk, not through git ---------------------------

describe("a doc is briefable because it is there, not because git tracks it", () => {
  test("a gitignored, untracked docs/ is still discovered and still ranks primary", async () => {
    const root = await tempRepo();
    try {
      git(root, ["init"]);
      await write(root, ".gitignore", "docs/\nresearch/\n");
      await write(root, "CLAUDE.md", "# conventions\n");
      await write(root, "README.md", "See [the spec](SPEC.md) for the design.");
      await write(root, "SPEC.md", "# Spec\n");
      await write(root, "docs/design.md", "the design, per [SPEC](../SPEC.md)");
      await write(
        root,
        "research/notes.md",
        "background reading on [the spec](../SPEC.md)",
      );
      commitAll(root, "init");

      // Positive control: prove the fixture really is untracked, or the rest of
      // this test asserts nothing. An empty `ls-files` here is the whole point.
      const tracked = Bun.spawnSync(["git", "-C", root, "ls-files"])
        .stdout.toString();
      expect(tracked).not.toContain("docs/");
      expect(tracked).not.toContain("research/");

      const docs = await discoverBriefableDocs(root);
      expect(docs.briefable).toContain("docs/design.md");
      expect(docs.briefable).toContain("research/notes.md");
      expect(docs.briefableDirectories).toContain("docs/");
      expect(docs.briefableDirectories).toContain("research/");
      // The ignored docs are what cite SPEC.md, so losing them would silently
      // hand `primary` to whatever is left. This is the regression that
      // untracking docs/ caused, and this line is what catches it coming back.
      expect(docs.primary).toBe("SPEC.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the walk is scoped to the doc directories — an agent worktree cannot duplicate the corpus", async () => {
    const root = await tempRepo();
    try {
      git(root, ["init"]);
      await write(root, "SPEC.md", "# Spec\n");
      await write(root, "docs/design.md", "cites SPEC.md");
      // A Hive agent worktree is a full checkout of the repo, docs and all. A
      // walk from the repo root would find this copy and every other agent's,
      // growing the corpus once per live agent. node_modules is the same trap.
      await write(root, ".hive/worktrees/agent/docs/design.md", "a copy");
      await write(root, ".hive/worktrees/agent/SPEC.md", "a copy");
      await write(root, "node_modules/pkg/docs/readme.md", "vendor noise");
      commitAll(root, "init");

      const docs = await discoverBriefableDocs(root);
      expect(docs.briefable).toEqual(["SPEC.md", "docs/design.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
