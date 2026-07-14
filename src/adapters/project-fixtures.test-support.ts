// Synthetic input repositories for the agent-authored profiler's acceptance
// tests. These are *inputs only*: nothing here imports the profiler, and nothing
// here asserts what a profile should say. A fixture that imports the code under
// test cannot outlive it, and the migration fixture below has to — it models the
// state of a repo written by a Hive that no longer exists.
//
// The repo's idiom is programmatic temp repos (see profile.test.ts,
// cli/init.test.ts), not checked-in trees, so these are builders. Each returns a
// root under $TMPDIR; call `disposeFixtures()` from `afterAll` to remove every
// directory they created.

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- disposal ---------------------------------------------------------------

// Every temp directory this module creates, whether or not a builder hands it
// back. The symlink-escape target is the reason this is a registry rather than a
// handle on each fixture: it lives *outside* the fixture root by construction,
// so a caller who only knows the root cannot delete it even deliberately.
const created: string[] = [];

async function trackedMkdtemp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

/** Remove every directory these builders created. Call from `afterAll`. */
export async function disposeFixtures(): Promise<void> {
  const paths = created.splice(0, created.length);
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
}

// --- primitives -------------------------------------------------------------

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

async function initRepo(prefix: string): Promise<string> {
  const root = await trackedMkdtemp(`hive-fixture-${prefix}-`);
  git(root, ["init"]);
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message, "--no-gpg-sign"]);
}

// --- hazards ----------------------------------------------------------------

/** Planted in every file a profiler has no business reading. A profile that
 * contains this string read something it should not have. */
export const SECRET_CANARY = "hive-fixture-canary-do-not-read";

/**
 * The four traps, added to the fixtures big enough to hide them:
 *  - a symlink resolving *outside* the project root (a walker that follows it
 *    leaves the repo),
 *  - a nested `.git` (a vendored checkout — not this repo's history),
 *  - `node_modules/`, `vendor/`, `target/`, `dist/` (dependency and build-output
 *    trees a scan must skip, not inventory),
 *  - a credential-shaped file a profiler must never read.
 *
 * Returns the outside-the-root directory the symlink escapes to, so a test can
 * assert the profile never mentions it.
 */
export async function addHazards(root: string): Promise<string> {
  await write(root, ".gitignore", "node_modules/\nvendor/\ntarget/\ndist/\n.env\n");

  await write(root, "node_modules/left-pad/package.json", `{"name":"left-pad"}\n`);
  await write(root, "node_modules/left-pad/index.js", "module.exports = 1;\n");
  await write(root, "target/debug/build.log", "compiling\n");
  await write(root, "dist/bundle.js", "console.log(1)\n");

  // A vendored checkout: a real `.git` that is not this repo's.
  await mkdir(join(root, "vendor/legacy-lib"), { recursive: true });
  git(join(root, "vendor/legacy-lib"), ["init"]);
  await write(root, "vendor/legacy-lib/Cargo.toml", `[package]\nname = "vendored"\n`);

  // Credential-shaped, gitignored, present on disk — the realistic case.
  await write(root, ".env", `AWS_SECRET_ACCESS_KEY=${SECRET_CANARY}\n`);

  const outsideRoot = await trackedMkdtemp("hive-fixture-outside-");
  await writeFile(join(outsideRoot, "secrets.txt"), `${SECRET_CANARY}\n`);
  await symlink(outsideRoot, join(root, "external"));

  return outsideRoot;
}

// --- 1. polyglot ------------------------------------------------------------

/** A fixture carrying the hazard set. `outsideRoot` is where the `external`
 * symlink lands: nothing under it belongs to the project, so a profile that
 * names any path beneath it followed the symlink out of the repo. */
export interface HazardousFixture {
  root: string;
  outsideRoot: string;
}

/**
 * ACCEPTANCE: polyglot support.
 *
 * Three ecosystems rooted at the *same* directory: a Cargo crate, a pnpm
 * package, and a Makefile that drives both. Rooting them together is the point —
 * a profile with one `language` and one `package_manager` field cannot describe
 * this repo without discarding two thirds of it, whichever one it picks. Carries
 * the full hazard set.
 */
export async function polyglotProject(): Promise<HazardousFixture> {
  const root = await initRepo("polyglot");

  await write(root, "Cargo.toml", `[package]\nname = "engine"\nversion = "0.1.0"\n`);
  await write(root, "Cargo.lock", `[[package]]\nname = "engine"\n`);
  await write(root, "src/main.rs", "fn main() {}\n");

  await write(root, "package.json", `${JSON.stringify({
    name: "ui",
    scripts: { build: "vite build", test: "vitest run", lint: "eslint ." },
  }, null, 2)}\n`);
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await write(root, "index.ts", "export const ui = 1;\n");

  await write(root, "pyproject.toml", `[project]\nname = "tools"\n`);
  await write(root, "main.py", "print(1)\n");

  await write(
    root,
    "Makefile",
    "build:\n\tcargo build && pnpm build\n\ntest:\n\tcargo test && pnpm test\n",
  );
  await write(root, "README.md", "# polyglot\n");

  const outsideRoot = await addHazards(root);
  commitAll(root, "init");
  return { root, outsideRoot };
}

// --- 2. monorepo with scoped commands ---------------------------------------

export interface Workspace {
  /** Working directory the command must run in, relative to the repo root. */
  directory: string;
  /** The manifest, relative to `directory`, that these commands belong to. It is
   * what makes `directory` the place they run: `cargo` and `vitest` both resolve
   * their scope from the manifest they find in the working directory. */
  manifest: string;
  testCommand: string;
  buildCommand: string;
}

/**
 * The ground truth for `monorepoProject`. Every command below runs in its own
 * `directory` and nowhere else: `cargo test --workspace` from the repo root
 * fails, and so does `vitest run`. A profile recording a single repo-wide
 * command string is *provably* wrong against this table, not merely incomplete.
 *
 * These are the commands that actually do the work, never a package-manager
 * indirection that re-invokes the same script name — `pnpm test` as the value of
 * `scripts.test` is a shell loop, and a table of those would validate a profile
 * full of commands that cannot run.
 */
export const MONOREPO_WORKSPACES: readonly Workspace[] = [
  {
    directory: "backend",
    manifest: "Cargo.toml",
    testCommand: "cargo test --workspace",
    buildCommand: "cargo build --release",
  },
  {
    directory: "frontend",
    manifest: "package.json",
    testCommand: "vitest run",
    buildCommand: "vite build",
  },
];

/**
 * ACCEPTANCE: scoped commands.
 *
 * Two workspaces, two ecosystems, two working directories, no command in common.
 * The manifests literally contain the strings in `MONOREPO_WORKSPACES`, so a
 * test can compare a profile against that table.
 */
export async function monorepoProject(): Promise<HazardousFixture> {
  const root = await initRepo("monorepo");

  // A virtual workspace: no `[package]` of its own, just members. Note this does
  // not make `--workspace` *necessary* — with no `default-members`, a bare
  // `cargo test` here selects every member too. What the fixture pins is the
  // working directory: either command only resolves from `backend/`, because
  // that is where the manifest naming these crates lives.
  await write(root, "backend/Cargo.toml", [
    `[workspace]`,
    `members = ["crates/api", "crates/store"]`,
    `resolver = "2"`,
    ``,
  ].join("\n"));
  await write(root, "backend/Cargo.lock", `[[package]]\nname = "api"\n`);
  await write(root, "backend/crates/api/Cargo.toml", `[package]\nname = "api"\nversion = "0.1.0"\n`);
  await write(root, "backend/crates/api/src/main.rs", "fn main() {}\n");
  await write(root, "backend/crates/store/Cargo.toml", `[package]\nname = "store"\nversion = "0.1.0"\n`);
  await write(root, "backend/crates/store/src/lib.rs", "pub fn get() {}\n");

  // The scripts run the real tools. `"test": "pnpm test"` would invoke itself.
  await write(root, "frontend/package.json", `${JSON.stringify({
    name: "frontend",
    scripts: { build: "vite build", test: "vitest run" },
  }, null, 2)}\n`);
  await write(root, "frontend/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await write(root, "frontend/src/index.ts", "export const app = 1;\n");

  // No *ecosystem* manifest at the root — only a dispatcher, and one that has to
  // `cd` into each workspace to do anything. The working directory is not a
  // detail of these commands; it is part of them.
  await write(root, "Makefile", [
    "test:",
    "\tcd backend && cargo test --workspace",
    "\tcd frontend && vitest run",
    "",
  ].join("\n"));
  await write(root, "README.md", "# monorepo\n");

  const outsideRoot = await addHazards(root);
  commitAll(root, "init");
  return { root, outsideRoot };
}

// --- 3. empty / fresh -------------------------------------------------------

/**
 * ACCEPTANCE: explicit unknowns, fresh projects.
 *
 * `git init` and nothing else: no files, no commit, therefore no HEAD. Every
 * derived field is unknown, and the commit is unknown *too* — the case that
 * catches a profiler assuming `git rev-parse HEAD` always answers.
 */
export async function emptyProject(): Promise<string> {
  return initRepo("empty");
}

/**
 * ACCEPTANCE: explicit unknowns, fresh projects.
 *
 * A day-one repo: one README, one commit, no manifest, no lockfile, no source.
 * There is nothing here to guess a build or test command from, so a profile that
 * names one invented it.
 */
export async function freshProject(): Promise<string> {
  const root = await initRepo("fresh");
  await write(root, "README.md", "# fresh\n\nNothing here yet.\n");
  commitAll(root, "init");
  return root;
}

// --- 4. ambiguous / conflicted ----------------------------------------------

/** The contradictions planted in `ambiguousProject`, as data a test can assert
 * a profile surfaced rather than silently resolved. */
export const AMBIGUOUS_SIGNALS = {
  /** Three package managers claim this repo. Priority order is not evidence. */
  lockfiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  /** Two files disagree about how to run the tests. Neither is authoritative. */
  rivalTestCommands: [
    { file: "Makefile", command: "pytest -q" },
    { file: "package.json", command: "vitest run" },
  ],
} as const;

/**
 * ACCEPTANCE: conflict is not a guess.
 *
 * Three competing lockfiles and two rival test commands, with nothing in the
 * repo to break the tie. Any single answer here is a guess dressed as a fact:
 * the correct profile records the conflict, or records unknown. Note that a
 * priority-ordered detector (`bun > pnpm > yarn > npm`) will confidently return
 * `pnpm` — confidently, and for no reason.
 */
export async function ambiguousProject(): Promise<string> {
  const root = await initRepo("ambiguous");

  await write(root, "package.json", `${JSON.stringify({
    name: "conflicted",
    scripts: { test: "vitest run" },
  }, null, 2)}\n`);
  await write(root, "package-lock.json", `{"lockfileVersion":3}\n`);
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await write(root, "yarn.lock", "# yarn lockfile v1\n");

  await write(root, "Makefile", "test:\n\tpytest -q\n");
  await write(root, "pyproject.toml", `[project]\nname = "conflicted"\n`);

  await write(root, "README.md", "# conflicted\n");
  commitAll(root, "init");
  return root;
}

// --- 5. legacy profile + human override -------------------------------------

/** The committed, human-owned correction. Hive never writes this file — and a
 * migration must never delete it. Path and contents are literals on purpose:
 * this is an artifact of the *old* system, so it must not track the new one. */
export const LEGACY_OVERRIDE_RELATIVE_PATH = ".hive/profile.override.toml";

const LEGACY_OVERRIDE_TOML = [
  "# Human-owned. Hive never writes this file.",
  "",
  "[commands]",
  `test = "make test-ci"`,
  "",
  "[docs]",
  `primary = "SPEC.md"`,
  "",
].join("\n");

/** A v2 derived profile byte-for-byte as the legacy serializer emitted it,
 * header comment and all: TOML with no nulls, unknown commands represented by
 * *omitted* keys (`lint` and `run` here). Local derived data — a migration may
 * replace it freely.
 *
 * The literal keeps this module independent of the code being replaced. Fidelity
 * to the real serializer is not asserted here but in project-fixtures.test.ts,
 * which imports `serializeProfile` and compares byte-for-byte — that test is
 * meant to die with the legacy serializer, and this constant is not. */
export const LEGACY_PROFILE_TOML = [
  "# Hive's derived profile of this repo — generated, cached, disposable.",
  "# Hive rewrites this file whenever the repo drifts; nothing here is worth",
  "# editing, because the next start will overwrite it. To *correct* a wrong",
  "# answer, put it in the repo's .hive/profile.override.toml, which Hive never",
  "# touches and always layers on top.",
  "",
  "schema_version = 2",
  "",
  "[docs]",
  `briefable = ["SPEC.md"]`,
  `briefable_directories = ["docs"]`,
  `primary = "SPEC.md"`,
  "",
  "[commands]",
  `build = "bun run build"`,
  `test = "bun test"`,
  `typecheck = "bun run typecheck"`,
  "",
  "[conventions]",
  `agents_file = "CLAUDE.md"`,
  `language = "typescript"`,
  `package_manager = "bun"`,
  "monorepo = false",
  "",
  "[entry_points]",
  `ranked = ["src/cli.ts"]`,
  "",
  "[fingerprint]",
  `generated = "2026-01-01"`,
  `hive_version = "0.1.0"`,
  `commit = "1111111111111111111111111111111111111111"`,
  `inputs_hash = "0000000000000000000000000000000000000000000000000000000000000000"`,
  "",
].join("\n");

export interface LegacyProfileFixture {
  root: string;
  /** Absolute path to the committed override. Tracked by git — deleting it is
   * data loss, and the migration test exists to prove it does not happen. */
  overridePath: string;
  /**
   * Write the legacy derived profile into `stateDir`, returning its path.
   *
   * The state dir is a parameter rather than something this module computes,
   * because the *caller* owns the question of where derived state lives — the
   * fixture only knows what a legacy profile looked like.
   */
  plantLegacyProfile: (stateDir: string) => Promise<string>;
}

/**
 * ACCEPTANCE: migration. Derived data is disposable; tracked human files are not.
 *
 * A repo mid-migration: a legacy v2 profile in Hive's local state (replaceable)
 * and a committed `.hive/profile.override.toml` the team hand-wrote (never
 * silently deletable). The override deliberately contradicts what any detector
 * would find — the repo's `package.json` says `bun test`, the human says
 * `make test-ci` — so a migration that drops the override is visible in the
 * resulting commands, not just on disk.
 */
export async function legacyProfileProject(): Promise<LegacyProfileFixture> {
  const root = await initRepo("legacy");

  await write(root, "package.json", `${JSON.stringify({
    name: "legacy",
    scripts: { build: "bun run build", test: "bun test", typecheck: "tsc --noEmit" },
  }, null, 2)}\n`);
  await write(root, "bun.lock", "");
  await write(root, "SPEC.md", "# Spec\n");
  await write(root, "CLAUDE.md", "# Conventions\n");
  await write(root, "src/cli.ts", "export const cli = 1;\n");
  await write(root, LEGACY_OVERRIDE_RELATIVE_PATH, LEGACY_OVERRIDE_TOML);
  commitAll(root, "init");

  return {
    root,
    overridePath: join(root, LEGACY_OVERRIDE_RELATIVE_PATH),
    plantLegacyProfile: async (stateDir: string): Promise<string> => {
      await mkdir(stateDir, { recursive: true });
      const path = join(stateDir, "profile.toml");
      await writeFile(path, LEGACY_PROFILE_TOML);
      return path;
    },
  };
}

// --- 6. drift ---------------------------------------------------------------

/**
 * Replace `from` with `to` in `path`, refusing unless the two are the same
 * number of *bytes* — so the file's size is provably unchanged while its content
 * is not.
 *
 * This is the whole trap. The legacy fingerprint hashed `path:size` for each
 * manifest, so an edit like this one changed the repo's test command and left
 * the staleness hash bit-for-bit identical: the profile went wrong and nothing
 * noticed. Content drift has to be detected by content.
 */
export async function editPreservingSize(
  path: string,
  from: string,
  to: string,
): Promise<void> {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error(
      `not a same-size edit: ${Buffer.byteLength(from)} bytes -> ${Buffer.byteLength(to)}`,
    );
  }
  // Both sizes come from the bytes read, never from a second look at the file:
  // one read, one write, and no window in between for the file to change under
  // the check. Replacing a run of bytes with the same number of bytes is what
  // preserves the size, and that was already established above.
  const before = await readFile(path, "utf8");
  if (!before.includes(from)) throw new Error(`${path} does not contain ${from}`);
  await writeFile(path, before.replace(from, to));
}

export interface DriftFixture {
  root: string;
  /** The manifest whose command the drift rewrites. */
  manifestPath: string;
  testCommandBefore: string;
  testCommandAfter: string;
  /** Rewrite the test command without changing the file's byte size. */
  applyDrift: () => Promise<void>;
}

/**
 * ACCEPTANCE: content drift is detected by content, not by file size.
 *
 * A repo whose Makefile runs `cargo test --lib`, plus the same-size edit that
 * makes it run `cargo test --doc` — a different command, a byte-identical file
 * size. A profiler that fingerprints sizes reports this repo as unchanged.
 */
export async function driftProject(): Promise<DriftFixture> {
  const root = await initRepo("drift");
  const testCommandBefore = "cargo test --lib";
  const testCommandAfter = "cargo test --doc";

  await write(root, "Cargo.toml", `[package]\nname = "drifty"\nversion = "0.1.0"\n`);
  await write(root, "Makefile", `test:\n\t${testCommandBefore}\n`);
  await write(root, "src/main.rs", "fn main() {}\n");
  await write(root, "README.md", "# drifty\n");
  commitAll(root, "init");

  const manifestPath = join(root, "Makefile");
  return {
    root,
    manifestPath,
    testCommandBefore,
    testCommandAfter,
    applyDrift: () => editPreservingSize(manifestPath, testCommandBefore, testCommandAfter),
  };
}
