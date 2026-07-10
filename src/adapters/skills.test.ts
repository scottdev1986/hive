import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { provisionSkills } from "./skills";

const tempRoots: string[] = [];

async function makeSkill(
  root: string,
  name: string,
  marker: string,
): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `# ${marker}\n`);
  return resolve(path);
}

async function linkTarget(path: string): Promise<string> {
  return resolve(dirname(path), await readlink(path));
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("skill provisioning", () => {
  test.each([
    ["claude", join(".claude", "skills")],
    ["codex", join(".agents", "skills")],
  ] as const)(
    "links canonical repo and global skills for %s",
    async (tool, nativeDirectory) => {
      const root = await mkdtemp(join(tmpdir(), `hive-skills-${tool}-`));
      tempRoots.push(root);
      const worktree = join(root, "worktree");
      const global = join(root, "global-skills");
      const repo = join(worktree, ".hive", "skills");
      const globalOnly = await makeSkill(global, "global-only", "global");
      await makeSkill(global, "shared", "global shared");
      const repoShared = await makeSkill(repo, "shared", "repo shared");
      const repoOnly = await makeSkill(repo, "repo-only", "repo");
      await mkdir(join(global, "not-a-skill"), { recursive: true });

      await provisionSkills(worktree, tool, global);
      await provisionSkills(worktree, tool, global);

      const native = join(worktree, nativeDirectory);
      expect(await linkTarget(join(native, "global-only"))).toEqual(globalOnly);
      expect(await linkTarget(join(native, "shared"))).toEqual(repoShared);
      expect(await linkTarget(join(native, "repo-only"))).toEqual(repoOnly);
      expect((await lstat(join(native, "shared"))).isSymbolicLink()).toEqual(
        true,
      );
      await expect(realpath(join(native, "not-a-skill"))).rejects.toThrow();
    },
  );

  test("preserves vendor-only skills and rejects same-name ambiguity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-conflict-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    const native = join(worktree, ".claude", "skills");
    await makeSkill(native, "vendor-only", "vendor");
    await makeSkill(native, "shared", "vendor shared");
    await makeSkill(join(worktree, ".hive", "skills"), "shared", "canonical");

    await expect(provisionSkills(worktree, "claude", join(root, "global")))
      .rejects.toThrow("native path already exists");
    expect(await readFile(join(native, "vendor-only", "SKILL.md"), "utf8"))
      .toEqual("# vendor\n");
  });

  test("does nothing when neither canonical source exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-empty-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true });

    await provisionSkills(worktree, "codex", join(root, "missing-global"));

    await expect(realpath(join(worktree, ".agents"))).rejects.toThrow();
  });
});
