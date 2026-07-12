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
import { SHIPPED_SKILLS, shippedSkillsFor } from "../skills/shipped";
import { unknownVendor, type CapabilityProvider } from "../schemas";

/**
 * The vendor a skill is installed for — the shared vendor enum, not a private
 * spelling of it.
 *
 * It used to be its own `"claude" | "codex"` alias, and that made this the one
 * file the enum collapse could not reach: a type alias is invisible to a fix
 * that rewrites schema references, so adding a vendor would have widened every
 * union in Hive except this one, and produced no compile error here to say so.
 * Skills are provisioned on EVERY spawn, so the failure would have been silent
 * and continuous: an agent launched with the wrong skills, or with none.
 */
export type SkillTool = CapabilityProvider;

/**
 * Where a vendor actually looks for project skills. Verified against the vendor
 * docs on 2026-07-11: Claude Code reads `.claude/skills/<name>/SKILL.md`, Codex
 * reads `.agents/skills/<name>/SKILL.md`. There is no shared location — the open
 * SKILL.md standard fixes the file format, not the directory — so one skill
 * authored once has to be delivered to two paths.
 *
 * A function, not a record, and exhaustive: every entry point into this file
 * needs the directory before it can write anything, so a vendor with no arm
 * fails here, loudly and by name, rather than installing Claude's skills into a
 * directory its CLI never reads. A record would have answered `undefined` and
 * let the failure surface as a path error naming no vendor at all.
 */
export function nativeSkillDirectory(tool: SkillTool): string {
  switch (tool) {
    case "claude":
      return join(".claude", "skills");
    case "codex":
      return join(".agents", "skills");
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
  let entries;
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

async function linkSkill(source: string, destination: string): Promise<void> {
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      const target = await readlink(destination);
      if (resolve(dirname(destination), target) === source) {
        return;
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
}

/**
 * Write Hive's shipped skills into one repo or worktree, for one vendor.
 *
 * The single rule, and the reason this is the only writer: **installing a skill
 * never destroys a file a human owns.** Absent → write it. Identical → say so
 * and move on. Different → leave it exactly as it is and report the drift; the
 * user asked for their version by editing it, and `--force` is how they ask for
 * ours back. A name occupied by the user's own skill is theirs, and we do not
 * write through the symlink to reach it.
 */
export async function installShippedSkills(
  root: string,
  tool: SkillTool,
  options: { force?: boolean } = {},
): Promise<SkillInstallReport> {
  const nativeDirectory = nativeSkillDirectory(tool);
  const nativeRoot = join(root, nativeDirectory);
  const report: SkillInstallReport = {
    tool,
    nativeDirectory,
    createdDirectory: !(await pathExists(nativeRoot)),
    installed: [],
    unchanged: [],
    drifted: [],
    userOwned: [],
  };

  for (const skill of shippedSkillsFor(tool)) {
    const destination = join(nativeRoot, skill.name);
    const existing = await lstat(destination).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });

    if (existing !== null && existing.isSymbolicLink()) {
      report.userOwned.push(skill.name);
      continue;
    }

    const skillFile = join(destination, "SKILL.md");
    const current = existing === null
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
 * own skills (`~/.hive/skills`, `<repo>/.hive/skills`) are symlinked in, as
 * before. The user's skills are linked first and a linked name is never written
 * through, so precedence reads off the code: **a skill the user wrote beats a
 * skill Hive ships.**
 */
export async function provisionSkills(
  worktreePath: string,
  tool: SkillTool,
  globalSkillsPath = join(hiveHome(), "skills"),
): Promise<void> {
  // Before any disk work: an unknown vendor must not get the user's own skills
  // symlinked into a directory chosen for a different CLI, and must not get a
  // half-provisioned worktree that a later read would call provisioned.
  const nativeRoot = join(worktreePath, nativeSkillDirectory(tool));
  const globalSkills = await discoverSkills(globalSkillsPath);
  const repoSkills = await discoverSkills(join(worktreePath, ".hive", "skills"));

  // Repository skills intentionally override global skills of the same name.
  const skills = new Map([...globalSkills, ...repoSkills]);
  if (skills.size > 0) {
    await mkdir(nativeRoot, { recursive: true });
    await Promise.all(
      [...skills.entries()].map(([name, source]) =>
        linkSkill(source, join(nativeRoot, name))
      ),
    );
  }

  await installShippedSkills(worktreePath, tool);
  await removeForeignShippedSkills(worktreePath, tool);
}

/**
 * Remove the skills Hive ships for a DIFFERENT vendor from this vendor's own
 * skill directory.
 *
 * Two vendors can share one directory — measured, not assumed: Grok scans
 * `.agents/skills`, which is exactly where Codex reads from. Both CLIs then
 * surface everything in it. `codex debug prompt-input` puts a foreign skill's
 * name and description straight into the model-visible prompt, and
 * `grok inspect --json` reports one with no `disabled` flag, which is to say
 * active. So the per-vendor filter in `shippedSkillsFor` decides what Hive
 * WRITES, and decides nothing at all about what the CLI READS.
 *
 * The consequence is a wrong-vendor contract, which is worse than no contract
 * because it is trusted: Hive's Grok skill tells an agent its exit code is not
 * success, its sandbox does not bind, and its MCP calls travel through a
 * profile-dependent wrapper. Every one of those is false for Codex, and all of
 * them are stated with total confidence.
 *
 * A skill directory is per-checkout state (`.agents/` and `.claude/` are
 * gitignored, so nothing arrives through git), which means a fresh worktree is
 * clean and only a REUSED one can hold a previous vendor's skills. That is the
 * case this closes.
 *
 * Two rules it inherits from `installShippedSkills`, because they are the same
 * rule: a symlink is the user's own skill and is never touched, and a file that
 * differs from what Hive ships was edited by a human and is theirs. Hive removes
 * only its own bytes.
 *
 * Deliberately NOT part of `installShippedSkills`: `hive init` calls that once
 * per detected vendor against the SAME root, so a prune there would have each
 * vendor delete the previous vendor's skills as it installed its own. This runs
 * only at spawn, where one worktree belongs to exactly one agent on exactly one
 * vendor.
 *
 * ---
 *
 * ACCEPTED RESIDUAL — the primary checkout. Read this before "finishing the job".
 *
 * In the repo root, after `hive init` with two CLIs that share a directory
 * installed, both vendors' contracts coexist in `.agents/skills` and each CLI
 * sees the other's. That is NOT fixed, and it is not an oversight:
 *
 * - It is a property of the vendors, not of Hive. Two CLIs genuinely read one
 *   directory. Hive cannot hide a skill from one of them without uninstalling it
 *   for the vendor that wants it.
 * - It does not touch Hive's agents. They live one-vendor-per-worktree, and the
 *   prune above is what guarantees that. The readers in the primary checkout are
 *   the human's own CLI sessions and the orchestrator — whose real instructions
 *   ride its spawn prompt, not a skill file.
 *
 * Two fixes were measured and REJECTED; do not re-propose them without new
 * evidence:
 *
 * 1. Install the Grok contract into Grok's private user scope (`~/.grok/skills`,
 *    which Codex cannot read) instead of the shared project directory. It fixes
 *    ONE DIRECTION of a symmetric leak: Grok reads its user scope AND the shared
 *    project dir, so Codex stops seeing the Grok contract while Grok goes on
 *    reading Codex's out of `.agents/skills`. A half-fix that looks complete is
 *    worse than none, because nobody re-examines a closed bug.
 * 2. The symmetric version — each vendor's contract into its own user scope.
 *    Measured to work (Grok does not read `~/.codex/skills`), and rejected
 *    anyway: it mutates user-global vendor state, which grok-integration-spec
 *    §15 names an explicit non-goal, and it would load a Hive contract into every
 *    session the user runs in every repo — including repos with no Hive, telling
 *    an agent to land through `hive_land` and report to an orchestrator that does
 *    not exist. Fixing a wrong-VENDOR contract in one repo by shipping a
 *    wrong-CONTEXT contract into all of them is not a trade worth making, and
 *    `hive uninstall` is per-repo, so nothing would cleanly own the file.
 *
 * The mitigation that remains is each skill's `description` naming its vendor in
 * the first clause ("Operating contract for a GROK CLI agent…"). That is a label:
 * it asks the model to notice and cooperate. It is defence in depth and it is not
 * the fix — which is exactly why the prune above exists.
 *
 * Measured 2026-07-12, codex-cli 0.144.1 / grok 0.2.93 (f00f96316d4b), by
 * planting uniquely-named probe skills and asking each CLI what its MODEL sees
 * (`codex debug prompt-input`; a Grok turn with every tool denied, so the skill
 * catalog was the only path to the probe token). A directory listing is not
 * evidence that the model reads it.
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

    const current = await readFile(join(destination, "SKILL.md"), "utf8")
      .catch((error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      });
    // Only Hive's own, unmodified copy. Anything else is the human's.
    if (current !== skill.content) continue;
    await rm(destination, { recursive: true, force: true });
  }
}
