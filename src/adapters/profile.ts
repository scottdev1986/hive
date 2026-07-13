/**
 * The repo profile is a derived cache in per-project Hive state. It regenerates
 * when its determining inputs change; `.hive/profile.override.toml` is the only
 * human-owned layer. Machine-specific runtime values are never persisted here.
 */
import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  stat,
  writeFile,
  mkdir,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
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

// Resolve state through the primary worktree so linked agent worktrees share
// one durable project identity and profile.

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

/** The directory Hive keeps this project's derived state in. */
export function projectStateDir(root: string): string {
  const { hiveUuid } = resolveHandshakeProject(primaryWorktree(root));
  return join(getHiveHome(), "projects", hiveUuid);
}

export function profilePath(root: string): string {
  return join(projectStateDir(root), "profile.toml");
}

export function overridePath(root: string): string {
  return join(root, OVERRIDE_RELATIVE_PATH);
}

// TOML has no null; optional profile fields are represented by omitted keys.

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

const DerivedProfileWireSchema = z.strictObject({
  schema_version: z.number().int().positive(),
  docs: z.strictObject({
    briefable: z.array(z.string()),
    briefable_directories: z.array(z.string()),
    primary: z.string().optional(),
  }),
  commands: z.strictObject({
    build: z.string().optional(),
    test: z.string().optional(),
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    run: z.string().optional(),
  }),
  conventions: z.strictObject({
    agents_file: z.string().optional(),
    language: z.string().optional(),
    package_manager: z.string().optional(),
    monorepo: z.boolean(),
  }),
  entry_points: z.strictObject({ ranked: z.array(z.string()) }),
  fingerprint: z.strictObject({
    generated: z.string(),
    hive_version: z.string(),
    commit: z.string().optional(),
    inputs_hash: z.string(),
  }),
});

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
  const wire = DerivedProfileWireSchema.safeParse(raw);
  if (!wire.success) return null;
  const value = wire.data;
  return RepoProfileSchema.parse({
    schemaVersion: value.schema_version,
    docs: {
      briefable: value.docs.briefable,
      briefableDirectories: value.docs.briefable_directories,
      primary: value.docs.primary ?? null,
    },
    commands: {
      build: value.commands.build ?? null,
      test: value.commands.test ?? null,
      typecheck: value.commands.typecheck ?? null,
      lint: value.commands.lint ?? null,
      run: value.commands.run ?? null,
    },
    conventions: {
      agentsFile: value.conventions.agents_file ?? null,
      language: value.conventions.language ?? null,
      packageManager: value.conventions.package_manager ?? null,
      monorepo: value.conventions.monorepo,
    },
    entryPoints: value.entry_points.ranked,
    fingerprint: {
      generated: value.fingerprint.generated,
      hiveVersion: value.fingerprint.hive_version,
      commit: value.fingerprint.commit ?? null,
      inputsHash: value.fingerprint.inputs_hash,
    },
  });
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

const ProfileOverrideWireSchema = z.strictObject({
  commands: z.strictObject({
    build: z.string().optional(),
    test: z.string().optional(),
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    run: z.string().optional(),
  }).optional(),
  docs: z.strictObject({
    primary: z.string().optional(),
    briefable_add: z.array(z.string()).optional(),
  }).optional(),
});

/** Read `.hive/profile.override.toml`. Absence and malformed TOML mean no
 * override; valid TOML with an unknown or mistyped key is refused visibly. */
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
  if (Object.keys(raw).length === 0) return null;
  const wire = ProfileOverrideWireSchema.safeParse(raw);
  if (!wire.success) {
    const issues = wire.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid profile override at ${overridePath(root)}: ${issues}`);
  }
  const commands = wire.data.commands ?? {};
  const docs = wire.data.docs ?? {};
  return ProfileOverrideSchema.parse({
    commands: {
      ...(commands.build === undefined ? {} : { build: commands.build }),
      ...(commands.test === undefined ? {} : { test: commands.test }),
      ...(commands.typecheck === undefined ? {} : { typecheck: commands.typecheck }),
      ...(commands.lint === undefined ? {} : { lint: commands.lint }),
      ...(commands.run === undefined ? {} : { run: commands.run }),
    },
    docs: {
      ...(docs.primary === undefined ? {} : { primary: docs.primary }),
      briefableAdd: docs.briefable_add ?? [],
    },
  });
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

// Hash only inputs that determine the profile. The Git tree itself would make
// unrelated commits invalidate a still-correct cache.

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

/** Fingerprint bootstrap inputs from the current tree, including newly added
 * docs that cannot appear in a cached allowlist. */
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

// Walk depth and file caps. Doc discovery sits on the spawn path, so a
// pathological directory must not be able to hang a spawn.
const DOC_WALK_MAX_DEPTH = 8;
const DOC_WALK_MAX_FILES = 500;

/** The `.md` files under one doc directory, read from disk rather than from
 * `git ls-files`: a doc is briefable because it is *there*, not because it is
 * tracked. `docs/` may be gitignored local working state and still be exactly
 * what an agent needs briefing on.
 *
 * The walk is scoped to `<root>/<dir>` and recurses only within it. That scope
 * is load-bearing: it is why dropping `ls-files`' ignore-filtering costs
 * nothing. A walk from the repo root would descend into `node_modules/`,
 * `dist/`, and — worst — `.hive/worktrees/<agent>/`, which holds a full
 * checkout of the repo, its own `docs/` included, and would duplicate the
 * corpus once per live agent. Keep it scoped. */
async function listMarkdownUnder(root: string, dir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > DOC_WALK_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return; // Absent or unreadable: no docs, which is not an error.
    }
    for (const entry of entries) {
      if (found.length >= DOC_WALK_MAX_FILES) return;
      // Symlinks are skipped outright rather than resolved: a doc directory has
      // no business leaving the repo, and following one could.
      if (entry.isSymbolicLink()) continue;
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) await walk(`${path}/`, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
    }
  };

  await walk(dir, 1);
  return found.sort();
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

/** Markdown link targets, without anchors or queries. Bare filename mentions
 * do not vote in primary-document ranking. */
function citedPaths(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(\s*<?([^)<>\s]+)/g)) {
    targets.push(match[1]!);
  }
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s<>]+)/gm)) {
    targets.push(match[1]!);
  }
  return targets
    .map((target) => target.split("#")[0]!.split("?")[0]!)
    .filter((target) => target.length > 0);
}

/** Rank by inbound Markdown links with a small design-role boost. Returns null
 * when the corpus has neither citations nor a design-role document. */
export function rankPrimaryDoc(
  docs: string[],
  corpus: Array<{ path: string; text: string }>,
): string | null {
  if (docs.length === 0) return null;
  const basename = (p: string): string => p.split("/").pop() ?? p;
  const citations = corpus.map((file) => ({
    path: file.path,
    // Cited by basename, so a relative prefix (`../SPEC.md`, `./SPEC.md`) still
    // resolves to the doc it names.
    targets: citedPaths(file.text).map(basename),
  }));
  const score = new Map<string, number>();
  for (const doc of docs) {
    const name = basename(doc);
    let inbound = 0;
    for (const file of citations) {
      if (file.path === doc) continue;
      inbound += file.targets.filter((target) => target === name).length;
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

/** Return the effective profile, regenerating drift before exposing it. Races
 * converge because generation is deterministic and writes are atomic. */
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
