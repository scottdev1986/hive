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
import { dirname, join, relative, resolve, sep } from "node:path";
import { getHiveHome } from "../hive-home/home";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  unknownVendor,
} from "../schemas/capability";
import { isErrnoCode } from "../shared/error-message";
import type { RoutingCategory } from "../schemas/routing-policy";
import {
  SKILL_CATEGORY_BUCKETS,
  SKILL_ROLES,
  skillBucketNames,
  unknownRole,
} from "../schemas/skill-address";
import {
  SHIPPED_SKILLS,
  shippedSkillAddresses,
  shippedSkillsFor,
} from "../skills/shipped";

export type SkillTool = CapabilityProvider;

export type SkillAudience =
  | { role: "queen"; tool: SkillTool }
  | { role: "agent"; tool: SkillTool; category?: RoutingCategory };

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

const isMissingFileError = <T>(error: T): error is T & { code: string } =>
  isErrnoCode(error, "ENOENT");

export function globalSkillsRoot(): string {
  return join(getHiveHome(), "skills");
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

export function skillOverlays(audience: SkillAudience): string[] {
  switch (audience.role) {
    case "queen":
      return ["queen", join("queen", audience.tool)];
    case "agent": {
      const base = ["agent", join("agent", audience.tool)];
      const category = audience.category;
      // `default` is a routing fallback chain, never a task an agent ran under, so it addresses no directory (schemas/skill-address.ts).
      if (category === undefined || category === "default") return base;
      return [
        ...base,
        join("agent", category),
        join("agent", audience.tool, category),
      ];
    }
    default:
      return unknownRole(audience, "skill overlays");
  }
}

function overlayLevel(overlay: string): "role" | "vendor" {
  return overlay.includes(sep) ? "vendor" : "role";
}

/** The user's skills in one source root, for one audience. A directory that names a bucket at its level is always a bucket, so a skill cannot be named after one — the ambiguity is resolved here rather than discovered later, and the bucket wins a name it shares with a skill. */
async function discoverSkillsFor(
  root: string,
  audience: SkillAudience,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const overlay of skillOverlays(audience)) {
    const buckets = new Set(
      skillBucketNames(audience.role, overlayLevel(overlay)),
    );
    for (const [name, source] of await discoverSkills(join(root, overlay))) {
      if (buckets.has(name)) continue;
      found.set(name, source);
    }
  }
  return found;
}

function addressableDirectories(): Set<string> {
  const directories = new Set<string>();
  for (const role of SKILL_ROLES) {
    for (const tool of CAPABILITY_PROVIDERS) {
      const audiences: SkillAudience[] =
        role === "queen"
          ? [{ role, tool }]
          : [
              { role, tool },
              ...SKILL_CATEGORY_BUCKETS.map((category) => ({
                role,
                tool,
                category,
              })),
            ];
      for (const audience of audiences) {
        for (const overlay of skillOverlays(audience)) directories.add(overlay);
      }
    }
  }
  return directories;
}

/** Skills nobody can be given: a `SKILL.md` sitting at a path no audience reads. This includes every unaddressed skill and every mis-ordered path (`agent/planning/claude/` rather than `agent/claude/planning/`). They are returned rather than skipped because a skill someone wrote that quietly stops loading is the worst failure this grammar can produce — the caller's job is to say so, with the path. */
export async function unaddressedSkills(root: string): Promise<string[]> {
  const addressable = addressableDirectories();
  const unaddressed: string[] = [];

  const walk = async (at: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, at), { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = at === "" ? entry.name : join(at, entry.name);
      if (await isSkillDirectory(join(root, path))) {
        if (!addressable.has(at)) unaddressed.push(path);
        continue;
      }
      await walk(path);
    }
  };

  await walk("");
  return unaddressed.sort();
}

/** Every skill the user has, for one vendor, from both source roots. Both roots are read from outside any worktree — `~/.hive/skills` and the *primary checkout's* `.hive/skills` — because a worktree is checked out from a commit and would otherwise show only skills that had been committed. Read from the primary, a skill behaves the same whether it is uncommitted, committed, or gitignored, which is the only rule a person can hold in their head. This mirrors how memory resolves `.hive/memory`. */
async function userSkillsFor(
  repoRoot: string,
  audience: SkillAudience,
  globalSkillsPath: string,
): Promise<Map<string, string>> {
  const global = await discoverSkillsFor(globalSkillsPath, audience);
  for (const [name, source] of await discoverSkillsFor(
    join(repoRoot, ".hive", "skills"),
    audience,
  )) {
    global.set(name, source);
  }
  return global;
}

/** Where a worktree records the skill symlinks Hive actually created in it. Provenance is remembered, not re-derived. Re-listing the sources later answers "what would provisioning produce right now", which is a different question from "what did Hive put here", and the two disagree exactly where it costs the most: a source deleted after the spawn drops out of the live listing, while vendors sharing one native directory put another vendor's skills — and another vendor's *name* for a skill — into the live listing for a worktree that was never provisioned for them. */
export const SKILL_LINK_MANIFEST = ".hive/skill-links.json";

/** The symlinks `provisionSkills` created in one worktree, as worktree-relative paths mapped to the source each was pointed at. No manifest means Hive created none; an unreadable one throws, because a caller that deletes on "nothing here" must never be told that by a failed read. */
export async function provisionedSkillLinks(
  worktreePath: string,
): Promise<Map<string, string>> {
  const raw = await readFile(
    join(worktreePath, SKILL_LINK_MANIFEST),
    "utf8",
  ).catch((error) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (raw === null) return new Map();
  // SAFETY: The surrounding code already established this contract.
  return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
}

/** Merged, never replaced: a link Hive created stays Hive's while it is still on disk, even once a later spawn no longer produces it. */
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
    // A byte-identical real copy (e.g. an install artifact that was accidentally committed, so every fresh worktree carries it) IS the skill — replace it with the canonical link instead of refusing.
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

export interface SkillInstallReport {
  tool: SkillTool;
  nativeDirectory: string;
  createdDirectory: boolean;
  installed: string[];
  /** Already byte-identical to the shipped version. */
  unchanged: string[];
  drifted: string[];
  userOwned: string[];
  /** Not written, because another vendor installed in this same root reads the same directory and this skill is not addressed to it. Never silent: the caller reports it, because a skill that quietly did not install is indistinguishable from one that failed to. */
  withheld: string[];
}

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

export function skillAddressesEveryReader(
  skill: { tools: SkillTool[] },
  readers: readonly SkillTool[],
): boolean {
  return readers.every((reader) => skill.tools.includes(reader));
}

export interface BaseSkillInstallReport {
  installed: string[];
  /** Already byte-identical. */
  unchanged: string[];
  drifted: string[];
}

export async function installBaseSkills(
  repoRoot: string,
  options: { force?: boolean } = {},
): Promise<BaseSkillInstallReport> {
  const report: BaseSkillInstallReport = {
    installed: [],
    unchanged: [],
    drifted: [],
  };
  const root = join(repoRoot, ".hive", "skills");

  for (const skill of SHIPPED_SKILLS) {
    for (const address of shippedSkillAddresses(skill)) {
      const directory = join(root, address, skill.name);
      const file = join(directory, "SKILL.md");
      const current = await readFile(file, "utf8").catch((error) => {
        if (isMissingFileError(error)) return null;
        throw error;
      });

      if (current === skill.content) {
        report.unchanged.push(join(address, skill.name));
        continue;
      }
      if (current !== null && options.force !== true) {
        report.drifted.push(join(address, skill.name));
        continue;
      }
      await mkdir(directory, { recursive: true });
      await writeFile(file, skill.content);
      report.installed.push(join(address, skill.name));
    }
  }
  return report;
}

export async function installShippedSkills(
  root: string,
  audience: SkillAudience,
  options: { force?: boolean; coresidentVendors?: readonly SkillTool[] } = {},
): Promise<SkillInstallReport> {
  return installShippedSkillsInto(
    join(root, nativeSkillDirectory(audience.tool)),
    audience,
    options,
  );
}

/** The same install, into a directory named outright. An agent's destination is derived from its worktree and its vendor's native path; a queen's is whatever her vendor gave Hive to work with — a plugin directory, a `--skills-dir`, a redirected home — and none of those are under a checkout. The choosing belongs to the caller, so this takes the answer. */
export async function installShippedSkillsInto(
  nativeRoot: string,
  audience: SkillAudience,
  options: { force?: boolean; coresidentVendors?: readonly SkillTool[] } = {},
): Promise<SkillInstallReport> {
  const tool = audience.tool;
  const nativeDirectory = nativeSkillDirectory(tool);
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

  for (const skill of shippedSkillsFor(audience)) {
    if (!skillAddressesEveryReader(skill, readers)) {
      report.withheld.push(skill.name);
      continue;
    }
    const destination = join(nativeRoot, skill.name);
    const existing = await lstat(destination).catch((error) => {
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
        : await readFile(skillFile, "utf8").catch((error) => {
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

/** Make one worktree's vendor skill directory true, at spawn. This function is the single path by which a skill reaches an agent, plus `installShippedSkills` — which is the same install, run at a different moment. Hive's own skills are *in the binary*, so they are laid down here for every agent regardless of what the user's repo happens to contain; the user's own skills are symlinked in from the primary checkout and `~/.hive/skills`. The user's skills are linked first and a linked name is never written through, so precedence reads off the code: **a skill the user wrote beats a skill Hive ships.** */
export async function provisionSkills(
  repoRoot: string,
  worktreePath: string,
  audience: SkillAudience,
  globalSkillsPath = globalSkillsRoot(),
): Promise<void> {
  // Before any disk work: an unknown vendor must not get the user's own skills symlinked into a directory chosen for a different CLI, and must not get a half-provisioned worktree that a later read would call provisioned.
  const nativeDirectory = nativeSkillDirectory(audience.tool);
  const staged = await stageUserSkills(
    repoRoot,
    join(worktreePath, nativeDirectory),
    audience,
    globalSkillsPath,
  );
  if (staged.size > 0) {
    // After the links exist, so a failed staging never leaves a path recorded as Hive's that Hive did not create.
    await recordProvisionedLinks(
      worktreePath,
      new Map(
        [...staged].map(([path, source]) => [
          relative(worktreePath, path),
          source,
        ]),
      ),
    );
  }

  await installShippedSkillsInto(join(worktreePath, nativeDirectory), audience);
  await removeForeignShippedSkillsFrom(
    join(worktreePath, nativeDirectory),
    audience,
  );
}

/** Symlink one audience's own skills into one directory, and say what was linked, keyed by the absolute path each link was created at. No manifest is written here. A worktree records its links because reconciliation later has to tell Hive's wiring from the agent's own work; a queen's directory belongs to Hive outright and is rebuilt at every launch, so there is nothing there to mistake for someone's work. */
async function stageUserSkills(
  repoRoot: string,
  destination: string,
  audience: SkillAudience,
  globalSkillsPath: string,
): Promise<Map<string, string>> {
  const skills = await userSkillsFor(repoRoot, audience, globalSkillsPath);
  if (skills.size === 0) return new Map();
  await mkdir(destination, { recursive: true });
  const links = new Map(
    [...skills.entries()].map(
      ([name, source]) => [join(destination, name), source] as const,
    ),
  );
  await Promise.all(
    [...links.entries()].map(([path, source]) => linkSkill(source, path)),
  );
  return links;
}

/** Everything one audience is owed, in a directory Hive chose rather than a worktree: the user's own skills, then Hive's shipped ones, then the prune. This is `provisionSkills` for a reader who has no checkout of their own — the queen, whose vendor hands Hive a plugin directory or a `--skills-dir` instead. The order and the precedence are the same, so a skill the user wrote still beats a skill Hive ships. */
export async function provisionSkillsInto(
  repoRoot: string,
  destination: string,
  audience: SkillAudience,
  globalSkillsPath = globalSkillsRoot(),
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await stageUserSkills(repoRoot, destination, audience, globalSkillsPath);
  await installShippedSkillsInto(destination, audience);
  await removeForeignShippedSkillsFrom(destination, audience);
}

/** Codex, Grok, and Kimi share `.agents/skills`. A reused single-vendor worktree may retain another vendor's contract, so remove only byte-identical Hive copies. User symlinks and modified files are never touched. Foreign is now anything this audience is not offered — another vendor's contract, and equally a skill for the other role or another category. A worktree reused by an agent of a different category would otherwise keep a contract addressed to work it was not sent to do. This runs at spawn, not multi-vendor init: one shared checkout cannot hide a file from only one of its readers, while each agent worktree has one reader. */
async function removeForeignShippedSkillsFrom(
  nativeRoot: string,
  audience: SkillAudience,
): Promise<void> {
  const mine = new Set(shippedSkillsFor(audience).map((skill) => skill.name));

  for (const skill of SHIPPED_SKILLS) {
    if (mine.has(skill.name)) continue;
    const destination = join(nativeRoot, skill.name);
    const existing = await lstat(destination).catch((error) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (existing === null || existing.isSymbolicLink()) continue;

    const current = await readFile(join(destination, "SKILL.md"), "utf8").catch(
      (error) => {
        if (isMissingFileError(error)) return null;
        throw error;
      },
    );
    if (current !== skill.content) continue;
    await rm(destination, { recursive: true, force: true });
  }
}
