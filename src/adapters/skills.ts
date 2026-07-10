import {
  lstat,
  mkdir,
  readdir,
  readlink,
  stat,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SkillTool = "claude" | "codex";

const NATIVE_SKILL_DIRECTORIES: Record<SkillTool, string> = {
  claude: join(".claude", "skills"),
  codex: join(".agents", "skills"),
};

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

function hiveHome(): string {
  return Bun.env.HIVE_HOME ?? join(homedir(), ".hive");
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

export async function provisionSkills(
  worktreePath: string,
  tool: SkillTool,
  globalSkillsPath = join(hiveHome(), "skills"),
): Promise<void> {
  const nativeRoot = join(worktreePath, NATIVE_SKILL_DIRECTORIES[tool]);
  const globalSkills = await discoverSkills(globalSkillsPath);
  const repoSkills = await discoverSkills(join(worktreePath, ".hive", "skills"));

  // Repository skills intentionally override global skills of the same name.
  const skills = new Map([...globalSkills, ...repoSkills]);
  if (skills.size === 0) {
    return;
  }

  await mkdir(nativeRoot, { recursive: true });
  await Promise.all(
    [...skills.entries()].map(([name, source]) =>
      linkSkill(source, join(nativeRoot, name))
    ),
  );
}
