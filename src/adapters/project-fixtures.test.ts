import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMBIGUOUS_SIGNALS,
  addHazards,
  ambiguousProject,
  driftProject,
  editPreservingSize,
  emptyProject,
  freshProject,
  legacyProfileProject,
  MONOREPO_WORKSPACES,
  monorepoProject,
  polyglotProject,
  SECRET_CANARY,
} from "./project-fixtures.test-support";

// These test the *fixtures*, not the profiler. A fixture that does not contain
// what its doc comment promises is worse than no fixture: it makes the
// acceptance test that consumes it pass for the wrong reason.

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
  test("each workspace's manifest really contains the command the table claims", async () => {
    const root = await monorepoProject();
    for (const workspace of MONOREPO_WORKSPACES) {
      const directory = join(root, workspace.directory);
      expect(await exists(directory)).toBe(true);

      const manifests = ["Cargo.toml", "package.json"];
      const bodies = await Promise.all(
        manifests.map(async (name) => {
          const path = join(directory, name);
          return (await exists(path)) ? await readFile(path, "utf8") : "";
        }),
      );
      const text = bodies.join("\n");
      expect(text).toContain(workspace.testCommand);
      expect(text).toContain(workspace.buildCommand);
    }
  });

  test("no workspace's command is the other's, and the root has no manifest of its own", async () => {
    const root = await monorepoProject();
    const [backend, frontend] = MONOREPO_WORKSPACES;
    expect(backend?.testCommand).not.toBe(frontend?.testCommand);
    // The claim that makes a bare repo-wide command wrong: there is nothing at
    // the root to run. Only the workspaces are runnable.
    expect(await exists(join(root, "package.json"))).toBe(false);
    expect(await exists(join(root, "Cargo.toml"))).toBe(false);
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
    const stateDir = await mkdtemp(join(tmpdir(), "hive-fixture-state-"));
    const path = await plantLegacyProfile(stateDir);

    const body = await readFile(path, "utf8");
    expect(body).toContain("schema_version = 2");
    // Omitted keys, not nulls: that is how the legacy format said "unknown".
    expect(body).toContain(`test = "bun test"`);
    expect(body).not.toContain("lint");
    // Derived data is local, never in the tree.
    expect(path.startsWith(await realpath(root))).toBe(false);
    expect(gitOut(root, ["status", "--porcelain", "-uall"]).out).toBe("");
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
