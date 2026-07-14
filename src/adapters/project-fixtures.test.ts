import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeProfile } from "./profile";
import {
  AMBIGUOUS_SIGNALS,
  addHazards,
  ambiguousProject,
  disposeFixtures,
  driftProject,
  editPreservingSize,
  emptyProject,
  freshProject,
  LEGACY_PROFILE_TOML,
  legacyProfileProject,
  MONOREPO_WORKSPACES,
  monorepoProject,
  polyglotProject,
  SECRET_CANARY,
} from "./project-fixtures.test-support";

// These test the *fixtures*, not the profiler. A fixture that does not contain
// what its doc comment promises is worse than no fixture: it makes the
// acceptance test that consumes it pass for the wrong reason.

afterAll(disposeFixtures);

function gitOut(root: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return { code: result.exitCode, out: result.stdout.toString().trim() };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("polyglotProject", () => {
  test("keeps three ecosystems at the root, so no single language can describe it", async () => {
    const { root } = await polyglotProject();
    for (const manifest of ["Cargo.toml", "package.json", "pyproject.toml", "Makefile"]) {
      expect(await exists(join(root, manifest))).toBe(true);
    }
    // Two package managers' lockfiles, both real, both the repo's.
    expect(await exists(join(root, "Cargo.lock"))).toBe(true);
    expect(await exists(join(root, "pnpm-lock.yaml"))).toBe(true);
  });
});

describe("addHazards", () => {
  test("the symlink really escapes the project root", async () => {
    const { root, outsideRoot } = await polyglotProject();
    const escaped = await realpath(join(root, "external"));
    expect(escaped).toBe(await realpath(outsideRoot));
    expect(escaped.startsWith(await realpath(root))).toBe(false);
  });

  test("plants a nested .git that is not this repo's history", async () => {
    const { root } = await polyglotProject();
    expect(await exists(join(root, "vendor/legacy-lib/.git"))).toBe(true);
    // Distinct histories: the nested repo has no commits, the outer one does.
    expect(gitOut(root, ["rev-parse", "HEAD"]).code).toBe(0);
    expect(gitOut(join(root, "vendor/legacy-lib"), ["rev-parse", "HEAD"]).code).not.toBe(0);
  });

  test("plants dependency and build-output trees to skip", async () => {
    const { root } = await polyglotProject();
    expect(await exists(join(root, "node_modules/left-pad/index.js"))).toBe(true);
    expect(await exists(join(root, "target/debug/build.log"))).toBe(true);
    expect(await exists(join(root, "dist/bundle.js"))).toBe(true);
  });

  test("the credential file is on disk, untracked, and carries the canary", async () => {
    const { root } = await polyglotProject();
    expect(await readFile(join(root, ".env"), "utf8")).toContain(SECRET_CANARY);
    // check-ignore consults the index, so it only means anything for an
    // untracked path — .env is one, and README.md is the control proving the
    // check discriminates rather than always answering "ignored".
    expect(gitOut(root, ["check-ignore", "-q", ".env"]).code).toBe(0);
    expect(gitOut(root, ["check-ignore", "-q", "README.md"]).code).not.toBe(0);
    expect(gitOut(root, ["ls-files", ".env"]).out).toBe("");
  });

  test("is reusable on any fixture root", async () => {
    const root = await freshProject();
    const outsideRoot = await addHazards(root);
    expect(await exists(join(root, "node_modules"))).toBe(true);
    expect(await realpath(join(root, "external"))).toBe(await realpath(outsideRoot));
  });
});

describe("monorepoProject", () => {
  test("every workspace in the ground-truth table has its manifest on disk", async () => {
    const { root } = await monorepoProject();
    for (const workspace of MONOREPO_WORKSPACES) {
      expect(await exists(join(root, workspace.directory, workspace.manifest))).toBe(true);
    }
  });

  test("the frontend's scripts ARE the table's commands, and none invokes itself", async () => {
    const { root } = await monorepoProject();
    const frontend = MONOREPO_WORKSPACES.find((w) => w.directory === "frontend");
    expect(frontend).toBeDefined();

    const manifest = JSON.parse(
      await readFile(join(root, "frontend/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    // Structural, not substring: the script's value is exactly the command the
    // table promises a profiler should find.
    expect(manifest.scripts.test).toBe(frontend?.testCommand);
    expect(manifest.scripts.build).toBe(frontend?.buildCommand);

    // A script whose body re-invokes its own name is an infinite shell loop, and
    // a ground-truth table full of those would validate unrunnable commands.
    for (const [name, command] of Object.entries(manifest.scripts)) {
      expect(command).not.toContain(`pnpm ${name}`);
      expect(command).not.toContain(`npm run ${name}`);
    }
  });

  test("the backend is a virtual workspace whose members really exist", async () => {
    const { root } = await monorepoProject();
    const backend = MONOREPO_WORKSPACES.find((w) => w.directory === "backend");
    const manifest = await readFile(join(root, "backend/Cargo.toml"), "utf8");

    // A workspace with members and no package of its own. This does not make
    // `--workspace` necessary — absent `default-members`, bare `cargo test`
    // selects every member as well. It makes the *directory* necessary: the
    // manifest that names these crates exists only here, so the command resolves
    // only from here, which is the scoping the profile has to preserve.
    expect(manifest).toContain("[workspace]");
    expect(manifest).not.toContain("[package]");
    expect(backend?.testCommand).toContain("--workspace");
    for (const member of ["crates/api", "crates/store"]) {
      expect(manifest).toContain(member);
      expect(await exists(join(root, "backend", member, "Cargo.toml"))).toBe(true);
    }
  });

  test("the workspaces share no command, and the root has no ecosystem manifest", async () => {
    const { root } = await monorepoProject();
    const commands = MONOREPO_WORKSPACES.flatMap((w) => [w.testCommand, w.buildCommand]);
    expect(new Set(commands).size).toBe(commands.length);

    // The claim that makes a bare repo-wide command wrong: nothing at the root
    // is runnable on its own. Even the dispatcher has to `cd` into a workspace.
    expect(await exists(join(root, "package.json"))).toBe(false);
    expect(await exists(join(root, "Cargo.toml"))).toBe(false);
    for (const workspace of MONOREPO_WORKSPACES) {
      expect(await readFile(join(root, "Makefile"), "utf8"))
        .toContain(`cd ${workspace.directory} && ${workspace.testCommand}`);
    }
  });
});

describe("emptyProject / freshProject", () => {
  test("the empty project has no HEAD to read", async () => {
    const root = await emptyProject();
    expect(gitOut(root, ["rev-parse", "--git-dir"]).code).toBe(0);
    expect(gitOut(root, ["rev-parse", "HEAD"]).code).not.toBe(0);
  });

  test("the fresh project has a commit and nothing to infer a command from", async () => {
    const root = await freshProject();
    expect(gitOut(root, ["rev-parse", "HEAD"]).code).toBe(0);
    for (const manifest of ["package.json", "Cargo.toml", "Makefile", "pyproject.toml"]) {
      expect(await exists(join(root, manifest))).toBe(false);
    }
  });
});

describe("ambiguousProject", () => {
  test("every competing lockfile is present", async () => {
    const root = await ambiguousProject();
    for (const lockfile of AMBIGUOUS_SIGNALS.lockfiles) {
      expect(await exists(join(root, lockfile))).toBe(true);
    }
  });

  test("the rival test commands are both real and both disagree", async () => {
    const root = await ambiguousProject();
    for (const rival of AMBIGUOUS_SIGNALS.rivalTestCommands) {
      expect(await readFile(join(root, rival.file), "utf8")).toContain(rival.command);
    }
    const commands = AMBIGUOUS_SIGNALS.rivalTestCommands.map((rival) => rival.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});

describe("legacyProfileProject", () => {
  test("the human override is committed, so deleting it is data loss", async () => {
    const { root, overridePath } = await legacyProfileProject();
    expect(await readFile(overridePath, "utf8")).toContain("make test-ci");
    // Tracked, not merely present: this is the property the migration must honour.
    expect(gitOut(root, ["ls-files", "--error-unmatch", ".hive/profile.override.toml"]).code)
      .toBe(0);
  });

  test("the override contradicts the repo's own manifest, so a silent drop is visible", async () => {
    const { root, overridePath } = await legacyProfileProject();
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("bun test");
    expect(await readFile(overridePath, "utf8")).not.toContain("bun test");
  });

  test("the legacy profile lands in the caller's state dir, outside the repo", async () => {
    const { root, plantLegacyProfile } = await legacyProfileProject();
    // The caller owns this directory, so the caller cleans it up.
    const stateDir = await mkdtemp(join(tmpdir(), "hive-fixture-state-"));
    try {
      const path = await plantLegacyProfile(stateDir);

      const body = await readFile(path, "utf8");
      expect(body).toContain("schema_version = 2");
      // Omitted keys, not nulls: that is how the legacy format said "unknown".
      expect(body).toContain(`test = "bun test"`);
      expect(body).not.toContain("lint");
      // Derived data is local, never in the tree.
      expect(path.startsWith(await realpath(root))).toBe(false);
      expect(gitOut(root, ["status", "--porcelain", "-uall"]).out).toBe("");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("LEGACY_PROFILE_TOML fidelity", () => {
  // The one place that imports the code being replaced, and deliberately: a
  // migration test against an *approximation* of the legacy format proves
  // nothing. The builders stay import-free so the fixtures outlive the
  // serializer; this test is meant to be deleted along with it.
  test("is byte-for-byte what the legacy serializer emitted", () => {
    const emitted = serializeProfile({
      schemaVersion: 2,
      docs: { briefable: ["SPEC.md"], briefableDirectories: ["docs"], primary: "SPEC.md" },
      commands: {
        build: "bun run build",
        test: "bun test",
        typecheck: "bun run typecheck",
        // Unknown in the legacy format meant an omitted key, never a null.
        lint: null,
        run: null,
      },
      conventions: {
        agentsFile: "CLAUDE.md",
        language: "typescript",
        packageManager: "bun",
        monorepo: false,
      },
      entryPoints: ["src/cli.ts"],
      fingerprint: {
        generated: "2026-01-01",
        hiveVersion: "0.1.0",
        commit: "1111111111111111111111111111111111111111",
        inputsHash: "0".repeat(64),
      },
    });
    expect(LEGACY_PROFILE_TOML).toBe(emitted);
  });
});

describe("disposeFixtures", () => {
  test("removes the fixture root AND the outside-symlink target", async () => {
    const { root, outsideRoot } = await polyglotProject();
    const monorepo = await monorepoProject();
    expect(await exists(root)).toBe(true);
    expect(await exists(outsideRoot)).toBe(true);

    await disposeFixtures();

    // The outside root is the one a caller could not clean up on its own: it is
    // outside the fixture by construction, which is why disposal is a registry.
    expect(await exists(root)).toBe(false);
    expect(await exists(outsideRoot)).toBe(false);
    expect(await exists(monorepo.root)).toBe(false);
    expect(await exists(monorepo.outsideRoot)).toBe(false);
  });
});

describe("driftProject", () => {
  test("the drift changes the command and preserves the byte size", async () => {
    const fixture = await driftProject();
    const before = await stat(fixture.manifestPath);
    const bodyBefore = await readFile(fixture.manifestPath, "utf8");

    await fixture.applyDrift();

    const after = await stat(fixture.manifestPath);
    const bodyAfter = await readFile(fixture.manifestPath, "utf8");

    expect(after.size).toBe(before.size);
    expect(bodyAfter).not.toBe(bodyBefore);
    expect(bodyBefore).toContain(fixture.testCommandBefore);
    expect(bodyAfter).toContain(fixture.testCommandAfter);
    expect(bodyAfter).not.toContain(fixture.testCommandBefore);
  });

  test("editPreservingSize refuses an edit that would change the size", async () => {
    const fixture = await driftProject();
    await expect(
      editPreservingSize(fixture.manifestPath, "cargo test --lib", "cargo nextest run"),
    ).rejects.toThrow(/same-size/);
    // Refused means untouched.
    expect(await readFile(fixture.manifestPath, "utf8")).toContain("cargo test --lib");
  });

  test("editPreservingSize refuses when the text is not there", async () => {
    const fixture = await driftProject();
    await expect(
      editPreservingSize(fixture.manifestPath, "cargo test --all", "cargo test --doc"),
    ).rejects.toThrow(/does not contain/);
  });
});
