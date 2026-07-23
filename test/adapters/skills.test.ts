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
import {
  installShippedSkills,
  provisionSkills,
  skillAddressesEveryReader,
  skillReaders,
} from "../../src/adapters/skills";
import { shippedSkillsFor } from "../../src/skills/shipped";

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

  test("installs the shipped skills even when the user has none of their own", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-empty-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true });

    await provisionSkills(worktree, "codex", join(root, "missing-global"));

    // Hive's own skills come from the binary, not from the user's disk, so an
    // agent gets them in a repo that has never heard of Hive.
    for (const skill of shippedSkillsFor("codex")) {
      expect(
        await readFile(
          join(worktree, ".agents", "skills", skill.name, "SKILL.md"),
          "utf8",
        ),
      ).toEqual(skill.content);
    }
  });

  test("a foreign vendor's Hive skill is removed from a reused worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-foreign-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    const native = join(worktree, ".agents", "skills");
    const foreign = shippedSkillsFor("claude").find(
      (skill) => skill.name === "hive-claude",
    )!;

    // Plant a byte-identical foreign contract in the shared reader directory.
    await mkdir(join(native, foreign.name), { recursive: true });
    await writeFile(join(native, foreign.name, "SKILL.md"), foreign.content);

    await provisionSkills(worktree, "codex", join(root, "missing-global"));

    await expect(
      readFile(join(native, foreign.name, "SKILL.md"), "utf8"),
    ).rejects.toThrow();

    // And the agent's own skills are still there: the prune removed the foreign
    // contract, not the provisioning.
    for (const skill of shippedSkillsFor("codex")) {
      expect(
        await readFile(join(native, skill.name, "SKILL.md"), "utf8"),
      ).toEqual(skill.content);
    }
  });

  test("a human's edited copy of a foreign skill is theirs, and survives", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-foreign-edited-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    const native = join(worktree, ".agents", "skills");

    // Same name Hive ships for another vendor, but the bytes are the human's.
    // Hive removes only its own copy; it does not get to delete someone's work
    // because the name collides with one of ours.
    const mine = "# mine, not Hive's\n";
    await mkdir(join(native, "hive-claude"), { recursive: true });
    await writeFile(join(native, "hive-claude", "SKILL.md"), mine);

    await provisionSkills(worktree, "codex", join(root, "missing-global"));

    expect(await readFile(join(native, "hive-claude", "SKILL.md"), "utf8"))
      .toEqual(mine);
  });

  test("a skill is withheld from a directory a reader it is not addressed to would see", () => {
    const contract = shippedSkillsFor("codex")
      .find((skill) => skill.name === "hive-codex")!;
    const neutral = shippedSkillsFor("codex")
      .find((skill) => skill.name === "hive-memory")!;

    expect(skillAddressesEveryReader(contract, ["codex"])).toBe(true);
    expect(skillAddressesEveryReader(neutral, ["codex"])).toBe(true);

    expect(skillAddressesEveryReader(contract, ["codex", "grok"])).toBe(false);
    expect(skillAddressesEveryReader(neutral, ["codex", "grok"])).toBe(true);
  });

  test("the rule is conditional on a SHARED directory, so one vendor changes nothing", () => {
    // The load-bearing condition. Claude and Codex do not share a directory
    // today, so Claude being installed alongside Codex adds no reader to Codex's
    // directory, and Codex's own contract installs untouched. Simplify this into
    // "never install a single-vendor skill" and every user who exists today
    // loses their contract.
    expect(skillReaders("codex", ["claude"])).toEqual(["codex"]);
    expect(skillReaders("claude", ["codex"])).toEqual(["claude"]);
    expect(skillReaders("codex", [])).toEqual(["codex"]);
  });

  test("a coresident vendor that shares no directory withholds nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-coresident-"));
    tempRoots.push(root);

    const report = await installShippedSkills(root, "codex", {
      coresidentVendors: ["claude"],
    });

    // The no-regression, asserted on disk rather than on the report: a machine
    // with both of today's CLIs installs exactly what it always did.
    expect(report.withheld).toEqual([]);
    for (const skill of shippedSkillsFor("codex")) {
      expect(
        await readFile(
          join(root, ".agents", "skills", skill.name, "SKILL.md"),
          "utf8",
        ),
      ).toEqual(skill.content);
    }
  });

  test("an edited skill is never clobbered, is reported, and yields to --force", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-drift-"));
    tempRoots.push(root);
    const edited = join(root, ".claude", "skills", "hive-claude", "SKILL.md");
    const shipped = shippedSkillsFor("claude").find(
      (skill) => skill.name === "hive-claude",
    )!;

    const first = await installShippedSkills(root, "claude");
    expect(first.installed).toContain("hive-claude");
    expect(first.createdDirectory).toEqual(true);

    // Running again changes nothing and says so.
    const again = await installShippedSkills(root, "claude");
    expect(again.installed).toEqual([]);
    expect(again.unchanged).toContain("hive-claude");
    expect(again.createdDirectory).toEqual(false);

    // The user edits it. Their edit survives, and is reported as drift.
    await writeFile(edited, "# mine now\n");
    const drifted = await installShippedSkills(root, "claude");
    expect(drifted.drifted).toEqual(["hive-claude"]);
    expect(drifted.installed).toEqual([]);
    expect(await readFile(edited, "utf8")).toEqual("# mine now\n");

    // --force is the only way their copy is replaced.
    const forced = await installShippedSkills(root, "claude", { force: true });
    expect(forced.installed).toContain("hive-claude");
    expect(await readFile(edited, "utf8")).toEqual(shipped.content);
  });

  test("a user's own skill of the same name wins over the shipped one", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-precedence-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    const mine = await makeSkill(
      join(worktree, ".hive", "skills"),
      "karpathy-guidelines",
      "my own guidelines",
    );

    await provisionSkills(worktree, "claude", join(root, "missing-global"));

    const native = join(worktree, ".claude", "skills");
    // Still their file, reached through their symlink — Hive did not write
    // through it, and did not replace it.
    expect(await linkTarget(join(native, "karpathy-guidelines"))).toEqual(mine);
    expect(
      await readFile(join(native, "karpathy-guidelines", "SKILL.md"), "utf8"),
    ).toEqual("# my own guidelines\n");
    // The shipped skill they did not override is still installed.
    expect(
      await readFile(join(native, "hive-claude", "SKILL.md"), "utf8"),
    ).toEqual(
      shippedSkillsFor("claude").find((skill) => skill.name === "hive-claude")!
        .content,
    );
  });
});
