import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverride,
  bootstrapProfile,
  computeFingerprint,
  ensureProfile,
  loadDerivedProfile,
  loadOverride,
  OVERRIDE_RELATIVE_PATH,
  overridePath,
  profilePath,
  projectStateDir,
  rankPrimaryDoc,
  regenerateProfile,
  serializeProfile,
} from "./profile";

// The profile is Hive's own cache, so every test here runs against a throwaway
// HIVE_HOME: the profiles land there, not in the synthetic repos, which is half
// of what these tests exist to prove.
let hiveHome: string;
const originalHiveHome = process.env.HIVE_HOME;

beforeAll(async () => {
  hiveHome = await mkdtemp(join(tmpdir(), "hive-home-"));
  process.env.HIVE_HOME = hiveHome;
});

afterAll(async () => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  await rm(hiveHome, { recursive: true, force: true });
});

// --- synthetic repo helpers -------------------------------------------------

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hive-profile-"));
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

/** A small, realistic repo: one design doc, one manifest, one entry point. */
async function repoWithSpec(): Promise<string> {
  const root = await tempRepo();
  git(root, ["init"]);
  await write(root, "package.json", JSON.stringify({ scripts: { test: "bun test" } }));
  await write(root, "bun.lock", "");
  await write(root, "SPEC.md", "# Spec\n\n### 1. Thing\n\nbody\n");
  await write(root, "src/index.ts", "export const x = 1;\n");
  commitAll(root, "init");
  return root;
}

// --- pure helpers -----------------------------------------------------------

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
    // The bug this ranking exists to not have. A document that discusses a
    // filename — a migration note, a skill explaining which conventions file a
    // vendor reads, this very sentence — used to cast one vote per mention, and
    // the primary doc every agent is briefed with moved because of prose.
    //
    // Measured on this repo: CLAUDE.md had 23 bare mentions and ZERO inbound
    // links, exactly as many mentions as SPEC.md. Under mention-counting a
    // single new doc naming CLAUDE.md four times was enough to flip the primary.
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

// --- where it lives ---------------------------------------------------------

describe("the profile is Hive's, not the repo's", () => {
  test("generating one writes nothing into the repo tree", async () => {
    const root = await repoWithSpec();
    try {
      await ensureProfile(root);

      // It is in Hive's per-project state dir...
      expect(profilePath(root).startsWith(hiveHome)).toBe(true);
      expect(await Bun.file(profilePath(root)).exists()).toBe(true);
      // ...and the repo is untouched: nothing to commit, nothing to diff.
      expect(await Bun.file(join(root, ".hive/profile.toml")).exists()).toBe(false);
      expect(
        Bun.spawnSync(["git", "-C", root, "status", "--porcelain"])
          .stdout.toString().trim(),
      ).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("every linked worktree of a repo reads the one project profile", async () => {
    const root = await repoWithSpec();
    const worktree = join(root, "wt");
    try {
      git(root, ["worktree", "add", "-b", "feature", worktree]);
      // An agent's worktree is a git checkout of its own, and the registry gives
      // it its own identity. The profile must still be the *project's*, or every
      // agent would silently profile its own branch.
      expect(projectStateDir(worktree)).toBe(projectStateDir(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a recreated path resolves a new project state directory", async () => {
    const parent = await tempRepo();
    const root = join(parent, "project");
    const identityHome = await mkdtemp(join(tmpdir(), "hive-home-recreated-"));
    try {
      process.env.HIVE_HOME = identityHome;
      await mkdir(root);
      const predecessor = projectStateDir(root);
      expect(predecessor.startsWith(identityHome)).toBe(true);

      await rm(root, { recursive: true, force: true });
      await mkdir(root);
      expect(() => projectStateDir(root)).toThrow("NEEDS_SETUP");

      // Stand in for the explicit operator setup after Hive refused the
      // recreated occupant. A fresh registration must receive fresh state.
      await rm(join(identityHome, "project-registry.json"));
      const successor = projectStateDir(root);
      expect(successor.startsWith(identityHome)).toBe(true);
      expect(successor).not.toBe(predecessor);
    } finally {
      process.env.HIVE_HOME = hiveHome;
      await rm(parent, { recursive: true, force: true });
      await rm(identityHome, { recursive: true, force: true });
    }
  });

  test("the same path resolves inside the active Hive instance", async () => {
    const root = await tempRepo();
    const otherHome = await mkdtemp(join(tmpdir(), "hive-home-other-"));
    try {
      const first = projectStateDir(root);
      expect(first.startsWith(hiveHome)).toBe(true);

      process.env.HIVE_HOME = otherHome;
      const second = projectStateDir(root);
      expect(second.startsWith(otherHome)).toBe(true);
      expect(second).not.toBe(first);
    } finally {
      process.env.HIVE_HOME = hiveHome;
      await rm(root, { recursive: true, force: true });
      await rm(otherHome, { recursive: true, force: true });
    }
  });
});

// --- deterministic generation -----------------------------------------------

describe("bootstrapProfile — bare repo (no docs, no AGENTS.md)", () => {
  test("un-hardcodes briefs with zero docs and no invented commands", async () => {
    const root = await tempRepo();
    try {
      git(root, ["init"]);
      await write(root, "package.json", JSON.stringify({
        scripts: { test: "vitest", build: "tsc", lint: "eslint ." },
      }));
      await write(root, "package-lock.json", "{}");
      await write(root, "tsconfig.json", "{}");
      await write(root, "src/index.ts", "export const x = 1;\n");
      commitAll(root, "init");

      const profile = await bootstrapProfile(root);
      // No docs: the allowlist is empty and there is no primary — the special
      // case simply drops away rather than assuming a doc name.
      expect(profile.docs.briefable).toEqual([]);
      expect(profile.docs.primary).toBeNull();
      expect(profile.conventions.agentsFile).toBeNull();
      // Commands are discovered from the manifest, resolved to the npm-family
      // package manager (a package-lock.json means npm).
      expect(profile.conventions.packageManager).toBe("npm");
      expect(profile.conventions.language).toBe("typescript");
      expect(profile.commands.test).toBe("npm test");
      expect(profile.commands.build).toBe("npm run build");
      expect(profile.commands.lint).toBe("npm run lint");
      // No run script; run is null, not invented.
      expect(profile.commands.run).toBeNull();
      expect(profile.entryPoints).toContain("src/index.ts");
      expect(profile.fingerprint.inputsHash.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bootstrapProfile — docs-rich repo", () => {
  test("inventories docs, picks the most-cited primary, records conventions", async () => {
    const root = await tempRepo();
    try {
      git(root, ["init"]);
      await write(root, "package.json", JSON.stringify({
        workspaces: ["packages/*"],
        scripts: { test: "bun test", typecheck: "tsc --noEmit", dev: "bun run src/cli.ts" },
        bin: { app: "src/cli.ts" },
      }));
      await write(root, "bun.lock", "");
      await write(root, "tsconfig.json", "{}");
      await write(root, "CLAUDE.md", "# conventions\n");
      await write(
        root,
        "README.md",
        "See [the spec](SPEC.md) for the design. [SPEC.md](./SPEC.md) is canonical.",
      );
      await write(root, "SPEC.md", "# Spec\n\n### 1. Thing\n\nbody\n");
      await write(root, "docs/research/x.md", "background, [cites](../SPEC.md) once");
      await write(root, "src/cli.ts", "console.log('hi')\n");
      commitAll(root, "init");

      const profile = await bootstrapProfile(root);
      expect(profile.docs.briefable).toContain("SPEC.md");
      expect(profile.docs.briefable).toContain("README.md");
      expect(profile.docs.briefable).toContain("docs/research/x.md");
      expect(profile.docs.briefableDirectories).toContain("docs/");
      // SPEC.md is cited more than anything else -> primary.
      expect(profile.docs.primary).toBe("SPEC.md");
      expect(profile.conventions.agentsFile).toBe("CLAUDE.md");
      expect(profile.conventions.packageManager).toBe("bun");
      expect(profile.conventions.monorepo).toBe(true);
      expect(profile.commands.test).toBe("bun test");
      expect(profile.commands.typecheck).toBe("bun run typecheck");
      expect(profile.commands.run).toBe("bun run dev");
      expect(profile.entryPoints).toContain("src/cli.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("round-trips through the file, omitting null fields", async () => {
    const root = await tempRepo();
    try {
      const original = await bootstrapProfile(root); // bare, mostly nulls
      await regenerateProfile(root);
      expect(await loadDerivedProfile(root)).toEqual(original);
      // A null command is dropped from the TOML, not written as `null`.
      expect(serializeProfile(original)).not.toContain("null");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("misspelled required cache keys force regeneration", async () => {
    const root = await repoWithSpec();
    try {
      await ensureProfile(root);
      const valid = await loadDerivedProfile(root);
      expect(valid?.schemaVersion).toBe(2);
      expect(valid?.docs.briefable).toContain("SPEC.md");

      const path = profilePath(root);
      const schemaTypo = (await Bun.file(path).text()).replace(
        "schema_version",
        "schema_verison",
      );
      await writeFile(path, schemaTypo);
      expect(await loadDerivedProfile(root)).toBeNull();
      expect((await ensureProfile(root)).schemaVersion).toBe(2);

      const docsTypo = (await Bun.file(path).text()).replace(
        "briefable =",
        "briefble =",
      );
      await writeFile(path, docsTypo);
      expect(await loadDerivedProfile(root)).toBeNull();
      expect((await ensureProfile(root)).docs.briefable).toContain("SPEC.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --- docs are discovered on disk, not through git ----------------------------

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

      const profile = await bootstrapProfile(root);
      expect(profile.docs.briefable).toContain("docs/design.md");
      expect(profile.docs.briefable).toContain("research/notes.md");
      expect(profile.docs.briefableDirectories).toContain("docs/");
      expect(profile.docs.briefableDirectories).toContain("research/");
      // The ignored docs are what cite SPEC.md, so losing them would silently
      // hand `primary` to whatever is left. This is the regression that
      // untracking docs/ caused, and this line is what catches it coming back.
      expect(profile.docs.primary).toBe("SPEC.md");
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

      const profile = await bootstrapProfile(root);
      expect(profile.docs.briefable).toEqual(["SPEC.md", "docs/design.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --- the fingerprint: what "stale" is allowed to mean -----------------------

describe("ensureProfile — regenerates when wrong, and only when wrong", () => {
  test("twenty commits that change nothing it derives leave it untouched", async () => {
    const root = await repoWithSpec();
    try {
      await ensureProfile(root);
      const before = await Bun.file(profilePath(root)).text();
      const stamp = (await stat(profilePath(root))).mtimeMs;

      // The bug this whole design exists to kill: the fingerprint used to hash
      // the Git tree, so *any* commit to *any* file marked the profile stale —
      // and the user got told it was "20 commits stale" and asked to fix it by
      // hand, about a profile whose every derived field was still correct.
      for (let i = 0; i < 20; i++) {
        await write(root, `src/feature-${i}.ts`, `export const f${i} = ${i};\n`);
        commitAll(root, `feature ${i}`);
      }

      const profile = await ensureProfile(root);
      expect(profile.docs.primary).toBe("SPEC.md");
      // Byte-identical, and not even rewritten: no drift, so no work.
      expect(await Bun.file(profilePath(root)).text()).toBe(before);
      expect((await stat(profilePath(root))).mtimeMs).toBe(stamp);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a new doc is drift: the allowlist picks it up with nobody asking", async () => {
    const root = await repoWithSpec();
    try {
      await ensureProfile(root);

      await write(root, "docs/design/api.md", "notes on the API\n");
      commitAll(root, "add a doc");

      // The fingerprint re-lists the docs rather than trusting the recorded
      // allowlist — a check driven by the old list could never see a new file.
      const profile = await ensureProfile(root);
      expect(profile.docs.briefable).toContain("docs/design/api.md");
      expect(profile.docs.briefableDirectories).toContain("docs/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a changed test command is drift", async () => {
    const root = await repoWithSpec();
    try {
      expect((await ensureProfile(root)).commands.test).toBe("bun test");

      await write(root, "package.json", JSON.stringify({
        scripts: { test: "bun test", lint: "eslint ." },
      }));
      commitAll(root, "add lint");

      expect((await ensureProfile(root)).commands.lint).toBe("bun run lint");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an uncommitted edit to a doc is drift too — the fingerprint is not about commits", async () => {
    const root = await repoWithSpec();
    try {
      const first = await computeFingerprint(root);
      await write(root, "SPEC.md", "# Spec\n\n### 1. Thing\n\na much longer body\n");
      const second = await computeFingerprint(root);
      expect(second.inputsHash).not.toBe(first.inputsHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a non-git directory profiles fine, just without a commit", async () => {
    const root = await tempRepo();
    try {
      await write(root, "SPEC.md", "# Spec\n");
      const fp = await computeFingerprint(root);
      expect(fp.commit).toBeNull();
      expect(fp.inputsHash.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --- the override: the half a human owns ------------------------------------

describe("the committed override layers over what Hive derived", () => {
  test("a corrected test command survives regeneration", async () => {
    const root = await repoWithSpec();
    try {
      expect((await ensureProfile(root)).commands.test).toBe("bun test");

      // The repo's real test command is not what detection guessed. This is the
      // one file a human owns, and Hive must never clobber it.
      await write(
        root,
        OVERRIDE_RELATIVE_PATH,
        '[commands]\ntest = "make test-ci"\n\n[docs]\nprimary = "README.md"\nbriefable_add = ["NOTES.md"]\n',
      );
      commitAll(root, "correct the test command");

      const profile = await ensureProfile(root);
      expect(profile.commands.test).toBe("make test-ci");
      expect(profile.docs.primary).toBe("README.md");
      expect(profile.docs.briefable).toContain("NOTES.md");
      // Untouched fields still come from the derivation.
      expect(profile.conventions.packageManager).toBe("bun");

      // A forced re-scan rewrites the cache and re-applies the override on top;
      // the override file itself is never written by Hive.
      const forced = await regenerateProfile(root);
      expect(forced.commands.test).toBe("make test-ci");
      expect(await Bun.file(overridePath(root)).text()).toContain("make test-ci");
      // What Hive cached is the *derivation*, not the override: they stay separable.
      expect((await loadDerivedProfile(root))?.commands.test).toBe("bun test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("absent is a no-op, and so is a broken one", async () => {
    const root = await repoWithSpec();
    try {
      expect(await loadOverride(root)).toBeNull();
      const derived = await ensureProfile(root);
      expect(applyOverride(derived, null)).toEqual(derived);

      // A typo in a hand-edited file degrades to Hive's answer. It must never be
      // the thing that stops a session.
      await write(root, OVERRIDE_RELATIVE_PATH, "commands = [[[not toml\n");
      expect(await loadOverride(root)).toBeNull();
      expect((await ensureProfile(root)).commands.test).toBe("bun test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a valid override key is read and a misspelling is refused", async () => {
    const root = await repoWithSpec();
    try {
      await write(
        root,
        OVERRIDE_RELATIVE_PATH,
        '[commands]\ntypecheck = "make types"\n',
      );
      expect((await loadOverride(root))?.commands.typecheck).toBe("make types");

      await write(
        root,
        OVERRIDE_RELATIVE_PATH,
        '[commands]\ntypcheck = "make types"\n',
      );
      expect(loadOverride(root)).rejects.toThrow("Invalid profile override");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
