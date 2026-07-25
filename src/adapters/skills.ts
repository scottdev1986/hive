import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  unknownVendor,
} from "../schemas";
import { SHIPPED_SKILLS, shippedSkillsFor } from "../skills/shipped";

/** The shared vendor enum keeps skill provisioning exhaustive. */
export type SkillTool = CapabilityProvider;

/** Project skill roots are vendor contracts; an unknown vendor must fail
 * before any directory is chosen or written. */
export function nativeSkillDirectory(tool: SkillTool): string {
  switch (tool) {
    case "claude":
      return join(".claude", "skills");
    case "codex":
      return join(".agents", "skills");
    case "grok":
      return join(".agents", "skills");
    case "kimi":
      return join(".agents", "skills");
    case "opencode":
      return join(".opencode", "skills");
    default:
      return unknownVendor(tool, "native skill directory");
  }
}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

function hiveHome(): string {
  return Bun.env.HIVE_HOME ?? join(homedir(), ".hive");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function isSkillDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, "SKILL.md"))).isFile();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function discoverSkills(root: string): Promise<Map<string, string>> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return new Map();
    }
    throw error;
  }

  const skills = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const path = resolve(root, entry.name);
    if (await isSkillDirectory(path)) {
      skills.set(entry.name, path);
    }
  }
  return skills;
}

/**
 * The user's skills in one source root, for one vendor.
 *
 * `<root>/<skill>` reaches every vendor; `<root>/<vendor>/<skill>` reaches that
 * vendor only. A directory named exactly after a vendor is always a bucket, so
 * a skill cannot be named after one — the ambiguity is resolved here rather
 * than discovered later, and the vendor bucket wins a name it shares with an
 * all-vendor skill.
 */
async function discoverSkillsFor(
  root: string,
  tool: SkillTool,
): Promise<Map<string, string>> {
  const shared = await discoverSkills(root);
  for (const vendor of CAPABILITY_PROVIDERS) {
    shared.delete(vendor);
  }
  for (const [name, source] of await discoverSkills(join(root, tool))) {
    shared.set(name, source);
  }
  return shared;
}

/**
 * Every skill the user has, for one vendor, from both source roots.
 *
 * Both roots are read from outside any worktree — `~/.hive/skills` and the
 * *primary checkout's* `.hive/skills` — because a worktree is checked out from
 * a commit and would otherwise show only skills that had been committed. Read
 * from the primary, a skill behaves the same whether it is uncommitted,
 * committed, or gitignored, which is the only rule a person can hold in their
 * head. This mirrors how memory resolves `.hive/memory`.
 */
async function userSkillsFor(
  repoRoot: string,
  tool: SkillTool,
  globalSkillsPath: string,
): Promise<Map<string, string>> {
  const global = await discoverSkillsFor(globalSkillsPath, tool);
  // The repository's skills intentionally override global ones of the name.
  for (const [name, source] of await discoverSkillsFor(
    join(repoRoot, ".hive", "skills"),
    tool,
  )) {
    global.set(name, source);
  }
  return global;
}

/**
 * Where a worktree records the skill symlinks Hive actually created in it.
 *
 * Provenance is remembered, not re-derived. Re-listing the sources later
 * answers "what would provisioning produce right now", which is a different
 * question from "what did Hive put here", and the two disagree exactly where it
 * costs the most: a source deleted after the spawn drops out of the live
 * listing, while vendors sharing one native directory put another vendor's
 * skills — and another vendor's *name* for a skill — into the live listing for
 * a worktree that was never provisioned for them.
 */
export const SKILL_LINK_MANIFEST = ".hive/skill-links.json";

/**
 * The symlinks `provisionSkills` created in one worktree, as worktree-relative
 * paths mapped to the source each was pointed at. No manifest means Hive
 * created none; an unreadable one throws, because a caller that deletes on
 * "nothing here" must never be told that by a failed read.
 */
export async function provisionedSkillLinks(
  worktreePath: string,
): Promise<Map<string, string>> {
  const raw = await readFile(
    join(worktreePath, SKILL_LINK_MANIFEST),
    "utf8",
  ).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (raw === null) return new Map();
  return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
}

/** Merged, never replaced: a link Hive created stays Hive's while it is still
 * on disk, even once a later spawn no longer produces it. */
async function recordProvisionedLinks(
  worktreePath: string,
  links: Map<string, string>,
): Promise<void> {
  const recorded = await provisionedSkillLinks(worktreePath);
  for (const [path, source] of links) {
    recorded.set(path, source);
  }
  const manifest = join(worktreePath, SKILL_LINK_MANIFEST);
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(
    manifest,
    `${JSON.stringify(Object.fromEntries(recorded), null, 2)}\n`,
  );
}

async function linkSkill(source: string, destination: string): Promise<void> {
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      const target = await readlink(destination);
      if (resolve(dirname(destination), target) === source) {
        return;
      }
    }
    // A byte-identical real copy (e.g. an install artifact that was
    // accidentally committed, so every fresh worktree carries it) IS the
    // skill — replace it with the canonical link instead of refusing.
    if (existing.isDirectory()) {
      const [shipped, wanted] = await Promise.all([
        readFile(join(destination, "SKILL.md"), "utf8").catch(() => null),
        readFile(join(source, "SKILL.md"), "utf8").catch(() => null),
      ]);
      if (shipped !== null && shipped === wanted) {
        await rm(destination, { recursive: true, force: true });
        return symlink(source, destination, "dir");
      }
    }
    throw new Error(
      `Cannot provision skill "${destination}": the native path already exists and does not link to ${source}`,
    );
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await symlink(source, destination, "dir");
}

/** What installing Hive's shipped skills into one directory did. Every skill
 * lands in exactly one of these buckets, and only `installed` wrote anything. */
export interface SkillInstallReport {
  tool: SkillTool;
  /** The vendor directory, relative to the root — for the summary line. */
  nativeDirectory: string;
  /** Whether that directory had to be created (a fresh repo) or already existed. */
  createdDirectory: boolean;
  /** Written now: nothing was there (or `--force` accepted the shipped copy). */
  installed: string[];
  /** Already byte-identical to the shipped version. */
  unchanged: string[];
  /** Present and different. Left alone — the human's copy wins until `--force`. */
  drifted: string[];
  /** The name is taken by a skill the user provides themselves (a symlink from
   * their own `.hive/skills`). Theirs wins; Hive does not write through it. */
  userOwned: string[];
  /** Not written, because another vendor installed in this same root reads the
   * same directory and this skill is not addressed to it. Never silent: the
   * caller reports it, because a skill that quietly did not install is
   * indistinguishable from one that failed to. */
  withheld: string[];
}

/** Every vendor that reads `tool`'s project skill directory in this root. */
export function skillReaders(
  tool: SkillTool,
  coresident: readonly SkillTool[] = [],
): SkillTool[] {
  const directory = nativeSkillDirectory(tool);
  const readers = new Set<SkillTool>([tool]);
  for (const other of coresident) {
    if (nativeSkillDirectory(other) === directory) readers.add(other);
  }
  return [...readers];
}

/** Shared directories may contain a skill only when every reader is an
 * intended recipient. Single-vendor roots still receive vendor-only skills. */
export function skillAddressesEveryReader(
  skill: { tools: SkillTool[] },
  readers: readonly SkillTool[],
): boolean {
  return readers.every((reader) => skill.tools.includes(reader));
}

/** Install without overwriting human files or writing through user symlinks.
 * Shared roots withhold skills not addressed to every reader. */
export async function installShippedSkills(
  root: string,
  tool: SkillTool,
  options: { force?: boolean; coresidentVendors?: readonly SkillTool[] } = {},
): Promise<SkillInstallReport> {
  const nativeDirectory = nativeSkillDirectory(tool);
  const nativeRoot = join(root, nativeDirectory);
  const readers = skillReaders(tool, options.coresidentVendors ?? []);
  const report: SkillInstallReport = {
    tool,
    nativeDirectory,
    createdDirectory: !(await pathExists(nativeRoot)),
    installed: [],
    unchanged: [],
    drifted: [],
    userOwned: [],
    withheld: [],
  };

  for (const skill of shippedSkillsFor(tool)) {
    if (!skillAddressesEveryReader(skill, readers)) {
      report.withheld.push(skill.name);
      continue;
    }
    const destination = join(nativeRoot, skill.name);
    const existing = await lstat(destination).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });

    if (existing?.isSymbolicLink()) {
      report.userOwned.push(skill.name);
      continue;
    }

    const skillFile = join(destination, "SKILL.md");
    const current =
      existing === null
        ? null
        : await readFile(skillFile, "utf8").catch((error: unknown) => {
            if (isMissingFileError(error)) return null;
            throw error;
          });

    if (current === skill.content) {
      report.unchanged.push(skill.name);
      continue;
    }
    if (current !== null && options.force !== true) {
      report.drifted.push(skill.name);
      continue;
    }

    await mkdir(destination, { recursive: true });
    await writeFile(skillFile, skill.content);
    report.installed.push(skill.name);
  }

  return report;
}

/**
 * Make one worktree's vendor skill directory true, at spawn.
 *
 * There is one story for how a skill reaches an agent, and it is this function
 * plus `installShippedSkills` — which is the same install, run at a different
 * moment. Hive's own skills are *in the binary*, so they are laid down here for
 * every agent regardless of what the user's repo happens to contain; the user's
 * own skills are symlinked in from the primary checkout and `~/.hive/skills`.
 * The user's skills are linked first and a linked name is never written
 * through, so precedence reads off the code: **a skill the user wrote beats a
 * skill Hive ships.**
 */
export async function provisionSkills(
  repoRoot: string,
  worktreePath: string,
  tool: SkillTool,
  globalSkillsPath = join(hiveHome(), "skills"),
): Promise<void> {
  // Before any disk work: an unknown vendor must not get the user's own skills
  // symlinked into a directory chosen for a different CLI, and must not get a
  // half-provisioned worktree that a later read would call provisioned.
  const nativeDirectory = nativeSkillDirectory(tool);
  const skills = await userSkillsFor(repoRoot, tool, globalSkillsPath);
  if (skills.size > 0) {
    await mkdir(join(worktreePath, nativeDirectory), { recursive: true });
    const links = new Map(
      [...skills.entries()].map(
        ([name, source]) => [join(nativeDirectory, name), source] as const,
      ),
    );
    await Promise.all(
      [...links.entries()].map(([path, source]) =>
        linkSkill(source, join(worktreePath, path)),
      ),
    );
    // After the links exist, so a failed staging never leaves a path recorded
    // as Hive's that Hive did not create.
    await recordProvisionedLinks(worktreePath, links);
  }

  await installShippedSkills(worktreePath, tool);
  await removeForeignShippedSkills(worktreePath, tool);
}

/**
 * Codex and Grok share `.agents/skills`. A reused single-vendor worktree may
 * retain the other vendor's contracts, so remove only byte-identical Hive
 * copies. User symlinks and modified files are never touched.
 *
 * This runs at spawn, not multi-vendor init: one shared checkout cannot hide a
 * file from only one of two readers, while each agent worktree has one reader.
 */
async function removeForeignShippedSkills(
  root: string,
  tool: SkillTool,
): Promise<void> {
  const nativeRoot = join(root, nativeSkillDirectory(tool));
  const mine = new Set(shippedSkillsFor(tool).map((skill) => skill.name));

  for (const skill of SHIPPED_SKILLS) {
    if (mine.has(skill.name)) continue;
    const destination = join(nativeRoot, skill.name);
    const existing = await lstat(destination).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (existing === null || existing.isSymbolicLink()) continue;

    const current = await readFile(join(destination, "SKILL.md"), "utf8").catch(
      (error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      },
    );
    // Only Hive's own, unmodified copy. Anything else is the human's.
    if (current !== skill.content) continue;
    await rm(destination, { recursive: true, force: true });
  }
}
