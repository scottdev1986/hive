import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapIfUninitialized,
  bootstrapProfile,
  commitsBehind,
  computeFingerprint,
  evaluateProfile,
  loadProfile,
  profilePath,
  rankPrimaryDoc,
  serializeProfile,
  sizeIndexBudget,
  writeProfile,
} from "./profile";

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

// --- pure helpers -----------------------------------------------------------

describe("sizeIndexBudget", () => {
  test("floors at aider's 1k default and scales with file count", () => {
    expect(sizeIndexBudget(0)).toBe(1_000);
    expect(sizeIndexBudget(100)).toBe(1_000);
    expect(sizeIndexBudget(1_000)).toBe(4_000);
  });

  test("caps so a monorepo's map cannot drown every context", () => {
    expect(sizeIndexBudget(50_000)).toBe(8_000);
  });
});

describe("rankPrimaryDoc", () => {
  test("picks the most inbound-linked doc as primary", () => {
    const primary = rankPrimaryDoc(["SPEC.md", "NOTES.md"], [
      { path: "README.md", text: "see SPEC.md and SPEC.md again" },
      { path: "NOTES.md", text: "one ref to SPEC.md" },
    ]);
    expect(primary).toBe("SPEC.md");
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

// --- serialization round-trip ----------------------------------------------

describe("serialize / load round-trip", () => {
  test("survives a full write and re-read, omitting null fields", async () => {
    const root = await tempRepo();
    try {
      const original = await bootstrapProfile(root); // bare, mostly nulls
      await writeProfile(root, original);
      const reloaded = await loadProfile(root);
      expect(reloaded).toEqual(original);
      // A null command is dropped from the TOML, not written as `null`.
      const toml = serializeProfile(original);
      expect(toml).not.toContain("null");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --- deterministic bootstrap ------------------------------------------------

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
      // No build/run script beyond those; run is null, not invented.
      expect(profile.commands.run).toBeNull();
      expect(profile.entryPoints).toContain("src/index.ts");
      expect(profile.indexBudget.mapTokens).toBe(1_000);
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
      await write(root, "README.md", "See SPEC.md for the design. SPEC.md is canonical.");
      await write(root, "SPEC.md", "# Spec\n\n### 1. Thing\n\nbody\n");
      await write(root, "docs/research/x.md", "background, cites SPEC.md once");
      await write(root, "src/cli.ts", "console.log('hi')\n");
      commitAll(root, "init");

      const profile = await bootstrapProfile(root);
      expect(profile.docs.briefable).toContain("SPEC.md");
      expect(profile.docs.briefable).toContain("README.md");
      expect(profile.docs.briefable).toContain("docs/research/x.md");
      expect(profile.docs.briefableDirectories).toContain("docs/");
      // SPEC.md is cited more than anything else -> primary.
      expect(profile.docs.primary).toBe("SPEC.md");
      // Conventions pointer: CLAUDE.md exists, bun is the package manager,
      // workspaces make it a monorepo.
      expect(profile.conventions.agentsFile).toBe("CLAUDE.md");
      expect(profile.conventions.packageManager).toBe("bun");
      expect(profile.conventions.monorepo).toBe(true);
      // Bun-native command forms.
      expect(profile.commands.test).toBe("bun test");
      expect(profile.commands.typecheck).toBe("bun run typecheck");
      expect(profile.commands.run).toBe("bun run dev");
      expect(profile.entryPoints).toContain("src/cli.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --- staleness / fingerprint ------------------------------------------------

describe("evaluateProfile — staleness recomputed every start", () => {
  test("uninitialized until a profile is written", async () => {
    const root = await tempRepo();
    try {
      expect((await evaluateProfile(root)).state).toBe("uninitialized");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fresh right after bootstrap, stale once a declared input drifts", async () => {
    const root = await tempRepo();
    try {
      git(root, ["init"]);
      await write(root, "package.json", JSON.stringify({ scripts: { test: "bun test" } }));
      await write(root, "SPEC.md", "# Spec\n\nv1\n");
      commitAll(root, "init");
      await bootstrapIfUninitialized(root);

      expect((await evaluateProfile(root)).state).toBe("fresh");

      // Edit a declared input (the primary doc) and commit: the fingerprint no
      // longer matches, so the next start sees drift — and never blocks.
      await write(root, "SPEC.md", "# Spec\n\nv2 with more words\n");
      commitAll(root, "edit spec");

      const status = await evaluateProfile(root);
      expect(status.state).toBe("stale");
      if (status.state === "stale") {
        expect(status.commitsBehind).toBe(1);
        expect(status.note).toContain("hive init --refresh");
        // It still carries the usable (stale) profile, not nothing.
        expect(status.profile.docs.primary).toBe("SPEC.md");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("commitsBehind counts commits from the recorded commit to HEAD", async () => {
    const root = await tempRepo();
    try {
      git(root, ["init"]);
      await write(root, "a.txt", "1");
      commitAll(root, "c1");
      const first = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
        .stdout.toString().trim();
      await write(root, "b.txt", "2");
      commitAll(root, "c2");
      await write(root, "c.txt", "3");
      commitAll(root, "c3");
      expect(commitsBehind(root, first)).toBe(2);
      expect(commitsBehind(root, null)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a non-git repo still fingerprints, just without a commit", async () => {
    const root = await tempRepo();
    try {
      await write(root, "SPEC.md", "# Spec\n");
      const fp = await computeFingerprint(root, ["SPEC.md"]);
      expect(fp.commit).toBeNull();
      expect(fp.inputsHash.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// --- bootstrapIfUninitialized ----------------------------------------------

describe("bootstrapIfUninitialized", () => {
  test("writes once and then leaves an existing profile untouched", async () => {
    const root = await tempRepo();
    try {
      git(root, ["init"]);
      await write(root, "package.json", "{}");
      commitAll(root, "init");

      const first = await bootstrapIfUninitialized(root);
      expect(first.created).toBe(true);
      const bytes = await Bun.file(profilePath(root)).text();

      const second = await bootstrapIfUninitialized(root);
      expect(second.created).toBe(false);
      // The existing file is returned as-is, not rewritten.
      expect(await Bun.file(profilePath(root)).text()).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
