/**
 * The repo profile — Hive's portability seam (SPEC.md decision 14).
 *
 * A structured record of this repo's doc names, commands, and shape, so every
 * mechanism that used to assume the hive repo's own layout (the scoped brief,
 * the orchestrator's citation guidance, the landing gate) reads a per-repo
 * answer instead of a compiled-in guess. Product code calls `ensureProfile` and
 * gets a typed object, never a Markdown fact body parsed out of prose.
 *
 * The profile is a **cache, not a document**. Everything in it is derived from
 * the tree by reading manifests and listing docs — tens of milliseconds, zero
 * model tokens — so there is nothing in it a human is meant to maintain, and no
 * reason to make anyone think about it. Two consequences run through this file:
 *
 *   - It lives in Hive's own per-project state directory
 *     (`~/.hive/projects/<hiveUuid>/profile.toml`), not in the repo. It is not
 *     the repo's business, it does not belong in anyone's diff, and it never
 *     goes stale in a way a human has to fix.
 *   - It regenerates *silently*. `ensureProfile` compares a fingerprint of the
 *     inputs that actually determine the profile and rewrites it when they
 *     drift. It prints nothing, asks for nothing, and there is no refresh
 *     command to forget to run.
 *
 * The one part a human owns is `.hive/profile.override.toml` — committed, small,
 * hand-edited, never written by Hive — which layers over the derived answers
 * when detection gets one wrong. See `ProfileOverrideSchema`.
 *
 * Machine-specific things — absolute worktree paths, the daemon port — are never
 * written here; they are rebuilt at runtime.
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PROFILE_SCHEMA_VERSION,
  ProfileOverrideSchema,
  RepoProfileSchema,
  type ProfileCommands,
  type ProfileOverride,
  type RepoProfile,
} from "../schemas/profile";
import { getHiveHome } from "../daemon/db";
import { resolveHandshakeProject } from "../daemon/project-identity";
import { HIVE_VERSION } from "../version";

/** The human-owned override, committed, relative to the repo root. The derived
 * profile has no repo-relative path at all — it is not in the repo. */
export const OVERRIDE_RELATIVE_PATH = ".hive/profile.override.toml";

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

// ---------------------------------------------------------------------------
// Where the profile lives. Hive keeps its own state in its own directory, one
// per project, keyed by the `hiveUuid` the project registry already mints —
// which is what makes this survive a repo being renamed or moved.
//
// The key is resolved from the repo's *primary* worktree, never the calling
// directory. Every agent runs in a linked worktree, and the registry gives a
// linked worktree its own identity; keying on the caller would hand each agent
// a private profile of its own branch. One repo, one profile.
// ---------------------------------------------------------------------------

/** Git helpers — cheap, best-effort. A directory that is not a Git checkout
 * profiles fine; it is simply its own project. */
function git(root: string, args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

/** The main working tree of `root`'s repo. `--git-common-dir` is the one
 * question whose answer is shared by every worktree of a repo: it names the main
 * `.git`, whose parent is the checkout the profile belongs to. */
function primaryWorktree(root: string): string {
  const common = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return common === null ? root : dirname(common);
}

// Resolving identity touches the registry, so memoize per root: a spawn-heavy
// daemon asks this question constantly and the answer cannot change under it.
const stateDirs = new Map<string, string>();

/** The directory Hive keeps this project's derived state in. */
export function projectStateDir(root: string): string {
  const cached = stateDirs.get(root);
  if (cached !== undefined) return cached;
  const { hiveUuid } = resolveHandshakeProject(primaryWorktree(root));
  const dir = join(getHiveHome(), "projects", hiveUuid);
  stateDirs.set(root, dir);
  return dir;
}

export function profilePath(root: string): string {
  return join(projectStateDir(root), "profile.toml");
}

export function overridePath(root: string): string {
  return join(root, OVERRIDE_RELATIVE_PATH);
}

// ---------------------------------------------------------------------------
// TOML serialization. Bun.TOML.parse handles reading; TOML has no stringifier,
// so we hand-write one for the profile's fixed shape (top-level int, tables of
// strings, string arrays, ints, and bools). A null field omits its key rather
// than emitting `null` (TOML has none): that is also how "which doc is primary,
// dropped when none" and "whether an AGENTS.md exists" express absence.
// ---------------------------------------------------------------------------

const tomlString = (value: string): string => JSON.stringify(value);
const tomlArray = (values: string[]): string =>
  `[${values.map(tomlString).join(", ")}]`;

function tableLines(
  entries: Array<[string, string | number | boolean | null]>,
): string[] {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (value === null) continue;
    if (typeof value === "string") lines.push(`${key} = ${tomlString(value)}`);
    else lines.push(`${key} = ${String(value)}`);
  }
  return lines;
}

export function serializeProfile(profile: RepoProfile): string {
  const sections: string[] = [];
  sections.push(`schema_version = ${profile.schemaVersion}`);

  sections.push(
    [
      "[docs]",
      `briefable = ${tomlArray(profile.docs.briefable)}`,
      `briefable_directories = ${tomlArray(profile.docs.briefableDirectories)}`,
      ...(profile.docs.primary === null
        ? []
        : [`primary = ${tomlString(profile.docs.primary)}`]),
    ].join("\n"),
  );

  sections.push(
    ["[commands]", ...tableLines([
      ["build", profile.commands.build],
      ["test", profile.commands.test],
      ["typecheck", profile.commands.typecheck],
      ["lint", profile.commands.lint],
      ["run", profile.commands.run],
    ])].join("\n"),
  );

  sections.push(
    ["[conventions]", ...tableLines([
      ["agents_file", profile.conventions.agentsFile],
      ["language", profile.conventions.language],
      ["package_manager", profile.conventions.packageManager],
      ["monorepo", profile.conventions.monorepo],
    ])].join("\n"),
  );

  sections.push(
    ["[entry_points]", `ranked = ${tomlArray(profile.entryPoints)}`].join("\n"),
  );

  sections.push(
    ["[fingerprint]", ...tableLines([
      ["generated", profile.fingerprint.generated],
      ["hive_version", profile.fingerprint.hiveVersion],
      ["commit", profile.fingerprint.commit],
      ["inputs_hash", profile.fingerprint.inputsHash],
    ])].join("\n"),
  );

  return `# Hive's derived profile of this repo — generated, cached, disposable.\n` +
    `# Hive rewrites this file whenever the repo drifts; nothing here is worth\n` +
    `# editing, because the next start will overwrite it. To *correct* a wrong\n` +
    `# answer, put it in the repo's ${OVERRIDE_RELATIVE_PATH}, which Hive never\n` +
    `# touches and always layers on top.\n\n` +
    sections.join("\n\n") + "\n";
}

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Parse and validate the derived profile. Returns null when it is absent or
 * unreadable — an uncached repo, not an error. Callers get the *effective*
 * profile from `ensureProfile`; this is the raw cache read. */
export async function loadDerivedProfile(root: string): Promise<RepoProfile | null> {
  let source: string;
  try {
    source = await readFile(profilePath(root), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(source) as Record<string, unknown>;
  } catch {
    return null;
  }
  const docs = (raw.docs ?? {}) as Record<string, unknown>;
  const commands = (raw.commands ?? {}) as Record<string, unknown>;
  const conventions = (raw.conventions ?? {}) as Record<string, unknown>;
  const entryPoints = (raw.entry_points ?? {}) as Record<string, unknown>;
  const fingerprint = (raw.fingerprint ?? {}) as Record<string, unknown>;

  const candidate = {
    schemaVersion: typeof raw.schema_version === "number"
      ? raw.schema_version
      : PROFILE_SCHEMA_VERSION,
    docs: {
      briefable: asStringArray(docs.briefable),
      briefableDirectories: asStringArray(docs.briefable_directories),
      primary: asString(docs.primary),
    },
    commands: {
      build: asString(commands.build),
      test: asString(commands.test),
      typecheck: asString(commands.typecheck),
      lint: asString(commands.lint),
      run: asString(commands.run),
    },
    conventions: {
      agentsFile: asString(conventions.agents_file),
      language: asString(conventions.language),
      packageManager: asString(conventions.package_manager),
      monorepo: conventions.monorepo === true,
    },
    entryPoints: asStringArray(entryPoints.ranked),
    fingerprint: {
      generated: asString(fingerprint.generated) ?? "1970-01-01",
      hiveVersion: asString(fingerprint.hive_version) ?? "unknown",
      commit: asString(fingerprint.commit),
      inputsHash: asString(fingerprint.inputs_hash) ?? "",
    },
  };
  const parsed = RepoProfileSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Write the profile atomically (temp + rename) so a concurrent reader never
 * sees a half-written file, and so two processes regenerating the same
 * deterministic content at once cannot corrupt it. Skips the write entirely when
 * the bytes would be identical, so an unchanged profile does not even churn its
 * mtime. */
export async function writeProfile(
  root: string,
  profile: RepoProfile,
): Promise<void> {
  const path = profilePath(root);
  const next = serializeProfile(profile);
  try {
    if ((await readFile(path, "utf8")) === next) return;
  } catch {
    // No readable profile yet — fall through and write one.
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, next);
  await rename(temporary, path);
}

// ---------------------------------------------------------------------------
// The override: the repo's committed correction of a derivation Hive got wrong.
// ---------------------------------------------------------------------------

/** Read `.hive/profile.override.toml`. Absent, malformed, or empty all mean the
 * same thing — no override — because a typo in a hand-edited file must degrade
 * to Hive's own answer, never break the session that reads it. */
export async function loadOverride(root: string): Promise<ProfileOverride | null> {
  let source: string;
  try {
    source = await readFile(overridePath(root), "utf8");
  } catch {
    return null;
  }
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(source) as Record<string, unknown>;
  } catch {
    return null;
  }
  // The file is written by a human, so its keys are TOML's snake_case; the schema
  // is the codebase's camelCase. Map them across explicitly — handing the raw
  // table to zod would let `briefable_add` parse "successfully" as an absent
  // field, and a correction that silently does nothing is worse than no file.
  const commands = (raw.commands ?? {}) as Record<string, unknown>;
  const docs = (raw.docs ?? {}) as Record<string, unknown>;
  const parsed = ProfileOverrideSchema.safeParse({
    commands: {
      ...(typeof commands.build === "string" ? { build: commands.build } : {}),
      ...(typeof commands.test === "string" ? { test: commands.test } : {}),
      ...(typeof commands.typecheck === "string"
        ? { typecheck: commands.typecheck }
        : {}),
      ...(typeof commands.lint === "string" ? { lint: commands.lint } : {}),
      ...(typeof commands.run === "string" ? { run: commands.run } : {}),
    },
    docs: {
      ...(typeof docs.primary === "string" ? { primary: docs.primary } : {}),
      briefableAdd: asStringArray(docs.briefable_add),
    },
  });
  return parsed.success ? parsed.data : null;
}

/** Layer a human's corrections over the derived answers. Commands replace,
 * `primary` replaces, and `briefableAdd` adds — nothing here can *remove* a doc
 * Hive found, because an override is a correction, not a second implementation
 * of the scan. */
export function applyOverride(
  profile: RepoProfile,
  override: ProfileOverride | null,
): RepoProfile {
  if (override === null) return profile;
  const commands: ProfileCommands = {
    build: override.commands.build ?? profile.commands.build,
    test: override.commands.test ?? profile.commands.test,
    typecheck: override.commands.typecheck ?? profile.commands.typecheck,
    lint: override.commands.lint ?? profile.commands.lint,
    run: override.commands.run ?? profile.commands.run,
  };
  const briefable = [
    ...new Set([...profile.docs.briefable, ...override.docs.briefableAdd]),
  ].sort();
  return {
    ...profile,
    commands,
    docs: {
      ...profile.docs,
      briefable,
      primary: override.docs.primary ?? profile.docs.primary,
    },
  };
}

// ---------------------------------------------------------------------------
// Fingerprint. A hash over the inputs that actually determine the profile: the
// current doc inventory, the manifests and lockfiles, the tracked-file count.
// Sizes stand in for contents — cheap, and a doc edit that changes a file's
// length is exactly the edit that can move the inbound-link ranking.
//
// It deliberately does NOT hash the Git tree. It used to, which meant every
// commit to any file marked the profile stale; a profile whose every derived
// field was still correct would announce itself as "20 commits stale" and ask to
// be refreshed by hand. Staleness now means the profile is *wrong*, and a
// profile that is wrong gets rewritten without anyone being told.
// ---------------------------------------------------------------------------

const MANIFEST_FILES = [
  "package.json",
  "tsconfig.json",
  "Makefile",
  "justfile",
  "Justfile",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
] as const;

const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

// Conventional entry files. They determine `entryPoints`, so their appearance or
// disappearance is drift, and the fingerprint has to see it.
const ENTRY_CANDIDATES = [
  "src/cli.ts",
  "src/index.ts",
  "src/main.ts",
  "index.ts",
  "index.js",
  "main.py",
  "cmd/main.go",
] as const;

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export interface FingerprintInputs {
  inputsHash: string;
  commit: string | null;
}

/**
 * Hash everything `bootstrapProfile` reads, without reading any of it whole.
 *
 * The doc inventory is re-listed rather than taken from the existing profile,
 * which is the difference between a fingerprint that notices a *new* doc and one
 * that cannot: a check driven by the recorded allowlist can only ever see the
 * files it already knows about.
 */
export async function computeFingerprint(root: string): Promise<FingerprintInputs> {
  const { briefable, briefableDirectories } = await inventoryDocPaths(root);
  const parts = [
    `docs:${briefable.join(",")}`,
    `docdirs:${briefableDirectories.join(",")}`,
  ];
  const sized = [
    ...briefable,
    ...MANIFEST_FILES,
    ...LOCKFILES,
    ...CONVENTION_FILES,
    ...ENTRY_CANDIDATES,
  ];
  for (const relativePath of [...new Set(sized)].sort()) {
    const size = await fileSize(join(root, relativePath));
    if (size !== null) parts.push(`${relativePath}:${size}`);
  }
  return {
    inputsHash: createHash("sha256").update(parts.join("\n")).digest("hex"),
    commit: git(root, ["rev-parse", "HEAD"]),
  };
}

// ---------------------------------------------------------------------------
// Deterministic generation — zero model tokens. Reads the manifests and docs and
// produces the profile that un-hardcodes the brief mechanism on any repo.
// ---------------------------------------------------------------------------

function detectPackageManager(root: string): string | null {
  const has = (name: string): boolean =>
    Bun.spawnSync(["test", "-e", join(root, name)]).exitCode === 0;
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json")) return "npm";
  if (has("Cargo.toml")) return "cargo";
  if (has("go.mod")) return "go";
  if (has("pyproject.toml")) return "poetry";
  return null;
}

interface PackageJson {
  scripts?: Record<string, string>;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  workspaces?: unknown;
}

async function readJson(path: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/** Turn a package.json script name into the concrete command a fresh shell runs,
 * respecting the detected package manager. Bun runs its own test runner and
 * `bun run <script>`; the npm-family use `<pm> run <script>` and `<pm> test`. */
function scriptCommand(
  pm: string | null,
  scriptName: string,
  isTest: boolean,
): string {
  const runner = pm ?? "npm";
  if (isTest) {
    return runner === "bun" ? "bun test" : `${runner} test`;
  }
  return runner === "bun" ? `bun run ${scriptName}` : `${runner} run ${scriptName}`;
}

function pickScript(
  scripts: Record<string, string>,
  names: string[],
): string | null {
  for (const name of names) {
    if (typeof scripts[name] === "string") return name;
  }
  return null;
}

async function detectCommands(
  root: string,
  pm: string | null,
  pkg: PackageJson | null,
): Promise<ProfileCommands> {
  const scripts = pkg?.scripts ?? {};
  const has = (names: string[]): string | null => pickScript(scripts, names);
  // `typecheck` has no `<pm> test`-style shortcut; a repo with a tsconfig but no
  // script still typechecks with `tsc --noEmit`, so fall back to that.
  const hasTsconfig =
    Bun.spawnSync(["test", "-e", join(root, "tsconfig.json")]).exitCode === 0;
  const typecheckScript = has(["typecheck", "tsc", "check-types", "types"]);
  const typecheck = typecheckScript !== null
    ? scriptCommand(pm, typecheckScript, false)
    : hasTsconfig
      ? (pm === "bun" ? "bunx tsc --noEmit" : "npx tsc --noEmit")
      : null;

  const testScript = has(["test"]);
  const buildScript = has(["build", "compile"]);
  const lintScript = has(["lint"]);
  const runScript = has(["start", "dev", "serve"]);

  return {
    build: buildScript !== null ? scriptCommand(pm, buildScript, false) : null,
    test: testScript !== null
      ? scriptCommand(pm, testScript, true)
      : (pm === "bun" ? "bun test" : null),
    typecheck,
    lint: lintScript !== null ? scriptCommand(pm, lintScript, false) : null,
    run: runScript !== null ? scriptCommand(pm, runScript, false) : null,
  };
}

// Directories a design/onboarding doc conventionally lives in. Scanned for
// `.md` files; only those that exist and hold docs become briefable directories.
const DOC_DIRECTORIES = [
  "docs/",
  "doc/",
  "research/",
  "rfcs/",
  "rfc/",
  "design/",
  ".github/",
] as const;

// Root-level docs worth briefing even though they are not in a doc directory.
// A design doc can be named anything (DESIGN.md, ARCHITECTURE.md, SPEC.md); we
// collect every root `.md` and let inbound-link ranking find the primary.
async function listRootMarkdown(root: string): Promise<string[]> {
  const out = git(root, ["ls-files", "*.md"]);
  if (out !== null) {
    // Root-level only: a nested path contains a slash. `git ls-files` already
    // omits ignored files, so `.hive/` runtime state never appears here.
    return out.split("\n").filter((f) => f.length > 0 && !f.includes("/"));
  }
  // Non-git repo: fall back to a directory read of the root.
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function listMarkdownUnder(root: string, dir: string): Promise<string[]> {
  const out = git(root, ["ls-files", `${dir}*.md`]);
  if (out !== null) {
    return out.split("\n").filter((f) => f.length > 0);
  }
  return [];
}

/** The doc inventory, by path only. Split out from `inventoryDocs` because the
 * fingerprint needs the *paths* on every start and must never pay for reading
 * the corpus, which only the primary-doc ranking requires. */
async function inventoryDocPaths(root: string): Promise<{
  rootDocs: string[];
  briefable: string[];
  briefableDirectories: string[];
}> {
  const rootDocs = await listRootMarkdown(root);
  const briefableDirectories: string[] = [];
  const dirDocs: string[] = [];
  for (const dir of DOC_DIRECTORIES) {
    const docs = await listMarkdownUnder(root, dir);
    if (docs.length > 0) {
      briefableDirectories.push(dir);
      dirDocs.push(...docs);
    }
  }
  const briefable = [...new Set([...rootDocs, ...dirDocs])].sort();
  return { rootDocs, briefable, briefableDirectories };
}

/** Rank docs by inbound links (how often each is referenced by path across the
 * corpus) with a small role boost, and return the most-cited as primary. This
 * is the doc-level analogue of aider's symbol ranking; the primary is "the one
 * everything else cites", whatever it is called. Returns null primary when the
 * corpus is empty or nothing is cited and no doc carries a design role. */
export function rankPrimaryDoc(
  docs: string[],
  corpus: Array<{ path: string; text: string }>,
): string | null {
  if (docs.length === 0) return null;
  const basename = (p: string): string => p.split("/").pop() ?? p;
  const score = new Map<string, number>();
  for (const doc of docs) score.set(doc, 0);
  for (const doc of docs) {
    const name = basename(doc);
    let inbound = 0;
    for (const file of corpus) {
      if (file.path === doc) continue;
      // Count references by basename (SPEC.md, DESIGN.md) — the form docs cite
      // each other with, robust to relative-path prefixes.
      const matches = file.text.split(name).length - 1;
      inbound += matches;
    }
    // Role boost: a design/architecture doc is a natural primary even in a young
    // repo where little cites it yet.
    const roleBoost = /^(spec|design|architecture|readme)\b/i.test(name) ? 1 : 0;
    score.set(doc, inbound + roleBoost);
  }
  const ranked = [...docs].sort((a, b) => (score.get(b)! - score.get(a)!));
  const best = ranked[0]!;
  return (score.get(best) ?? 0) > 0 ? best : null;
}

async function inventoryDocs(root: string): Promise<{
  briefable: string[];
  briefableDirectories: string[];
  primary: string | null;
}> {
  const { rootDocs, briefable, briefableDirectories } = await inventoryDocPaths(root);

  // Rank primarily against the root docs (a repo's primary design doc lives at
  // the root); read their text plus the directory docs to count links.
  const corpus: Array<{ path: string; text: string }> = [];
  for (const path of briefable) {
    try {
      corpus.push({ path, text: await readFile(join(root, path), "utf8") });
    } catch {
      // A listed doc that cannot be read simply contributes no links.
    }
  }
  const primary = rankPrimaryDoc(rootDocs, corpus);
  return { briefable, briefableDirectories, primary };
}

function detectConventionsFile(root: string): string | null {
  for (const name of CONVENTION_FILES) {
    if (Bun.spawnSync(["test", "-e", join(root, name)]).exitCode === 0) {
      return name;
    }
  }
  return null;
}

function detectLanguage(root: string, pm: string | null): string | null {
  const has = (name: string): boolean =>
    Bun.spawnSync(["test", "-e", join(root, name)]).exitCode === 0;
  if (has("tsconfig.json")) return "typescript";
  if (has("Cargo.toml")) return "rust";
  if (has("go.mod")) return "go";
  if (has("pyproject.toml")) return "python";
  if (pm === "bun" || pm === "npm" || pm === "pnpm" || pm === "yarn") {
    return "javascript";
  }
  return null;
}

async function detectMonorepo(root: string, pkg: PackageJson | null): Promise<boolean> {
  if (pkg?.workspaces !== undefined) return true;
  return (await fileSize(join(root, "pnpm-workspace.yaml"))) !== null;
}

function detectEntryPoints(root: string, pkg: PackageJson | null): string[] {
  const out: string[] = [];
  const push = (p: string | undefined): void => {
    if (typeof p === "string" && p.length > 0 && !out.includes(p)) out.push(p);
  };
  push(pkg?.main);
  push(pkg?.module);
  if (typeof pkg?.bin === "string") push(pkg.bin);
  else if (pkg?.bin !== undefined) {
    for (const value of Object.values(pkg.bin)) push(value);
  }
  // Conventional entry files that exist, when the manifest named none.
  for (const candidate of ENTRY_CANDIDATES) {
    if (Bun.spawnSync(["test", "-e", join(root, candidate)]).exitCode === 0) {
      push(candidate);
    }
  }
  return out.slice(0, 8);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Build the deterministic profile for `root` without writing it. Pure enough to
 * test against synthetic repos: everything it reads is a real file or a `git`
 * call, and it spends zero model tokens. */
export async function bootstrapProfile(root: string): Promise<RepoProfile> {
  const pm = detectPackageManager(root);
  const pkg = await readJson(join(root, "package.json"));
  const [commands, docs] = await Promise.all([
    detectCommands(root, pm, pkg),
    inventoryDocs(root),
  ]);
  const { inputsHash, commit } = await computeFingerprint(root);

  return RepoProfileSchema.parse({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    docs,
    commands,
    conventions: {
      agentsFile: detectConventionsFile(root),
      language: detectLanguage(root, pm),
      packageManager: pm,
      monorepo: await detectMonorepo(root, pkg),
    },
    entryPoints: detectEntryPoints(root, pkg),
    fingerprint: {
      generated: todayIsoDate(),
      hiveVersion: HIVE_VERSION,
      commit,
      inputsHash,
    },
  });
}

// ---------------------------------------------------------------------------
// The only entry point product code needs.
// ---------------------------------------------------------------------------

/**
 * The effective profile for `root`, generating or regenerating it as needed.
 *
 * Generation costs a `git ls-files`, a handful of `stat`s, and a read of the
 * repo's markdown — tens of milliseconds, zero model tokens. That measurement is
 * the whole design: because being wrong is cheap to fix, being wrong is not
 * worth *telling anyone about*. There is no stale state, no refresh command, and
 * no output on any path. A repo whose profile has drifted simply gets a correct
 * one before the caller sees it.
 *
 * Two processes racing here converge: generation is deterministic, and the write
 * is atomic and skipped when the bytes match.
 */
export async function ensureProfile(root: string): Promise<RepoProfile> {
  const cached = await loadDerivedProfile(root);
  if (cached !== null && cached.schemaVersion === PROFILE_SCHEMA_VERSION) {
    const { inputsHash } = await computeFingerprint(root);
    if (inputsHash === cached.fingerprint.inputsHash) {
      return applyOverride(cached, await loadOverride(root));
    }
  }
  return regenerateProfile(root);
}

/** Rebuild the profile from the tree unconditionally, ignoring the fingerprint.
 * Nothing in normal operation needs this — `ensureProfile` already regenerates
 * whenever the answer would change. It exists for `hive init --refresh`, as the
 * escape hatch for a detection you think is wrong and want to watch rerun. */
export async function regenerateProfile(root: string): Promise<RepoProfile> {
  const fresh = await bootstrapProfile(root);
  await writeProfile(root, fresh);
  return applyOverride(fresh, await loadOverride(root));
}
