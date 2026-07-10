/**
 * The repo profile — Hive's portability seam (SPEC.md decision 14).
 *
 * A single committed `.hive/profile.toml` that records this repo's doc names,
 * commands, and shape, so every mechanism that used to assume the hive repo's
 * own layout (the scoped brief, the orchestrator's citation guidance, the
 * landing gate) reads a per-repo answer instead of a compiled-in guess. This
 * module is the *structured reader* the design demands: product code calls
 * `loadProfile` and gets a typed object, never a Markdown fact body parsed out
 * of prose.
 *
 * Two tiers, per the derive-then-refine split:
 *   - `bootstrapProfile` is the **deterministic** pass — zero model tokens,
 *     instant, run at the first session boundary in an uninitialized repo. It reads the
 *     package manager and commands out of the manifests, inventories docs, picks
 *     the most-cited as primary, and sizes the index budget from the file count.
 *   - `hive init` (src/cli/init.ts) is the richer, gated pass that enriches what
 *     the bootstrap could not.
 *
 * Machine-specific things — absolute worktree paths, the daemon port — are never
 * written here; they are rebuilt at runtime. The profile is pure repo facts,
 * which is exactly what makes it shareable.
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  PROFILE_SCHEMA_VERSION,
  RepoProfileSchema,
  type ProfileCommands,
  type RepoProfile,
} from "../schemas/profile";
import { HIVE_VERSION } from "../version";

export const PROFILE_RELATIVE_PATH = ".hive/profile.toml";

export function profilePath(root: string): string {
  return join(root, PROFILE_RELATIVE_PATH);
}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

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
    ["[index_budget]",
      `file_count = ${profile.indexBudget.fileCount}`,
      `map_tokens = ${profile.indexBudget.mapTokens}`,
    ].join("\n"),
  );

  sections.push(
    ["[fingerprint]", ...tableLines([
      ["generated", profile.fingerprint.generated],
      ["hive_version", profile.fingerprint.hiveVersion],
      ["commit", profile.fingerprint.commit],
      ["inputs_hash", profile.fingerprint.inputsHash],
    ])].join("\n"),
  );

  return `# .hive/profile.toml — Hive repo profile (SPEC.md decision 14).\n` +
    `# Committed structured truth: doc names, commands, and shape, so Hive's\n` +
    `# token economics hold on this repo without re-profiling. Written by Hive's\n` +
    `# bootstrap and enriched by \`hive init\`; do not hand-edit the fingerprint.\n\n` +
    sections.join("\n\n") + "\n";
}

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Parse and validate a `.hive/profile.toml`. Returns null when it is absent or
 * unreadable — an uninitialized repo, not an error. */
export async function loadProfile(root: string): Promise<RepoProfile | null> {
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
  const budget = (raw.index_budget ?? {}) as Record<string, unknown>;
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
    indexBudget: {
      fileCount: typeof budget.file_count === "number" ? budget.file_count : 0,
      mapTokens: typeof budget.map_tokens === "number" ? budget.map_tokens : 1_000,
    },
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
 * sees a half-written file, and so two processes bootstrapping the same
 * deterministic content at once cannot corrupt it. */
export async function writeProfile(
  root: string,
  profile: RepoProfile,
): Promise<void> {
  const path = profilePath(root);
  await mkdir(join(root, ".hive"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, serializeProfile(profile));
  await rename(temporary, path);
}

// ---------------------------------------------------------------------------
// Git helpers — cheap, best-effort. A repo that is not a Git checkout profiles
// fine; it just loses the commit-distance staleness signal.
// ---------------------------------------------------------------------------

function git(root: string, args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

function gitHead(root: string): string | null {
  return git(root, ["rev-parse", "HEAD"]);
}

function gitTreeHash(root: string): string | null {
  return git(root, ["rev-parse", "HEAD^{tree}"]);
}

/** Commits between the profile's recorded commit and current HEAD — the "N" in
 * "the profile is N commits stale". Null when either commit is unknown or the
 * recorded commit is not an ancestor (a rebase/force-push), where a count is
 * meaningless. */
export function commitsBehind(root: string, recorded: string | null): number | null {
  if (recorded === null) return null;
  const count = git(root, ["rev-list", "--count", `${recorded}..HEAD`]);
  if (count === null) return null;
  const n = Number(count);
  return Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Fingerprint. A hash over the profile's declared inputs (the doc set, the
// manifests and lockfile, the Git tree). The Git tree hash captures every
// committed content change in one call; per-file stat sizes catch uncommitted
// edits to the small declared set. Neither reads a large file whole, so the
// check stays "a few stats and hashes" and never sits on the hot path.
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

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** The set of files whose drift should trip staleness: the briefable docs plus
 * whichever manifests and lockfiles exist. Reproducible from the profile at any
 * later start, so generation and recompute hash the same set. */
async function declaredInputPaths(
  root: string,
  briefableDocs: string[],
): Promise<string[]> {
  const candidates = [
    ...briefableDocs,
    ...MANIFEST_FILES,
    ...LOCKFILES,
  ];
  const present: string[] = [];
  for (const relativePath of candidates) {
    if ((await fileSize(join(root, relativePath))) !== null) {
      present.push(relativePath);
    }
  }
  return [...new Set(present)].sort();
}

export interface FingerprintInputs {
  inputsHash: string;
  commit: string | null;
}

export async function computeFingerprint(
  root: string,
  briefableDocs: string[],
): Promise<FingerprintInputs> {
  const tree = gitTreeHash(root) ?? "";
  const inputs = await declaredInputPaths(root, briefableDocs);
  const parts = [`tree:${tree}`];
  for (const relativePath of inputs) {
    const size = await fileSize(join(root, relativePath));
    parts.push(`${relativePath}:${size ?? "missing"}`);
  }
  return {
    inputsHash: createHash("sha256").update(parts.join("\n")).digest("hex"),
    commit: gitHead(root),
  };
}

// ---------------------------------------------------------------------------
// Staleness evaluation, recomputed every start. Never blocks: a slightly stale
// allowlist beats none, so a drifted profile still drives the spawn while Hive
// notes that `hive init --refresh` would update it.
// ---------------------------------------------------------------------------

export type ProfileStatus =
  | { state: "uninitialized" }
  | { state: "fresh"; profile: RepoProfile }
  | {
      state: "stale";
      profile: RepoProfile;
      commitsBehind: number | null;
      note: string;
    };

export async function evaluateProfile(root: string): Promise<ProfileStatus> {
  const profile = await loadProfile(root);
  if (profile === null) return { state: "uninitialized" };
  const { inputsHash } = await computeFingerprint(root, profile.docs.briefable);
  if (inputsHash === profile.fingerprint.inputsHash) {
    return { state: "fresh", profile };
  }
  const behind = commitsBehind(root, profile.fingerprint.commit);
  const distance = behind === null
    ? "the tree has changed"
    : `the profile is ${behind} commit${behind === 1 ? "" : "s"} stale`;
  return {
    state: "stale",
    profile,
    commitsBehind: behind,
    note:
      `Hive repo profile: ${distance} since it was written. Spawns still use it ` +
      `(a slightly stale allowlist beats none); run \`hive init --refresh\` to update it.`,
  };
}

// ---------------------------------------------------------------------------
// Deterministic bootstrap — zero model tokens. Reads the manifests and docs and
// writes the profile that un-hardcodes the brief mechanism on any repo.
// ---------------------------------------------------------------------------

/** aider's `--map-tokens` scaled to the repo: the entry-point index budget must
 * grow with file count so a monorepo's map does not drown every context, and
 * stay bounded so it never dominates the brief. 1k floor (aider's default), 8k
 * ceiling. */
export function sizeIndexBudget(fileCount: number): number {
  return Math.min(8_000, Math.max(1_000, Math.round(fileCount * 4)));
}

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

  // Rank primarily against the root docs (a repo's primary design doc lives at
  // the root); read their text plus a sample of directory docs to count links.
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
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
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
  for (const candidate of [
    "src/cli.ts",
    "src/index.ts",
    "src/main.ts",
    "index.ts",
    "index.js",
    "main.py",
    "cmd/main.go",
  ]) {
    if (Bun.spawnSync(["test", "-e", join(root, candidate)]).exitCode === 0) {
      push(candidate);
    }
  }
  return out.slice(0, 8);
}

function countFiles(root: string): number {
  const out = git(root, ["ls-files"]);
  if (out === null) return 0;
  return out.split("\n").filter((line) => line.length > 0).length;
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
  const fileCount = countFiles(root);
  const { inputsHash, commit } = await computeFingerprint(root, docs.briefable);

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
    indexBudget: { fileCount, mapTokens: sizeIndexBudget(fileCount) },
    fingerprint: {
      generated: todayIsoDate(),
      hiveVersion: HIVE_VERSION,
      commit,
      inputsHash,
    },
  });
}

/** First-start bootstrap: if the repo has no profile, write the deterministic
 * one and report that it was created. Idempotent — an existing profile is left
 * untouched (staleness is a separate, non-writing check), so two processes
 * racing on first start converge on identical deterministic content. Returns
 * the action taken so the caller can print the single start-time line. */
export async function bootstrapIfUninitialized(
  root: string,
): Promise<{ created: boolean; profile: RepoProfile }> {
  const existing = await loadProfile(root);
  if (existing !== null) return { created: false, profile: existing };
  const profile = await bootstrapProfile(root);
  await writeProfile(root, profile);
  return { created: true, profile };
}
