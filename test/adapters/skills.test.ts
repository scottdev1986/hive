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
  nativeSkillDirectory,
  provisionSkills,
  skillAddressesEveryReader,
  skillReaders,
  unaddressedSkills,
} from "../../src/adapters/skills";
import { CAPABILITY_PROVIDERS } from "../../src/schemas";
import { shippedSkillsFor } from "../../src/skills/shipped";
import { required } from "../required";

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
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
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
      const primary = join(root, "primary");
      const worktree = join(root, "worktree");
      const global = join(root, "global-skills", "agent");
      const repo = join(primary, ".hive", "skills", "agent");
      const globalOnly = await makeSkill(global, "global-only", "global");
      await makeSkill(global, "shared", "global shared");
      const repoShared = await makeSkill(repo, "shared", "repo shared");
      const repoOnly = await makeSkill(repo, "repo-only", "repo");
      await mkdir(join(global, "not-a-skill"), { recursive: true });
      // The worktree's own copy is whatever was committed, which is why it is
      // not a source: this stale one must not win, and must not be linked.
      await makeSkill(
        join(worktree, ".hive", "skills", "agent"),
        "stale",
        "stale",
      );

      const audience = { role: "agent", tool } as const;
      await provisionSkills(
        primary,
        worktree,
        audience,
        join(root, "global-skills"),
      );
      await provisionSkills(
        primary,
        worktree,
        audience,
        join(root, "global-skills"),
      );

      const native = join(worktree, nativeDirectory);
      expect(await linkTarget(join(native, "global-only"))).toEqual(globalOnly);
      expect(await linkTarget(join(native, "shared"))).toEqual(repoShared);
      expect(await linkTarget(join(native, "repo-only"))).toEqual(repoOnly);
      expect((await lstat(join(native, "shared"))).isSymbolicLink()).toEqual(
        true,
      );
      await expect(realpath(join(native, "not-a-skill"))).rejects.toThrow();
      await expect(realpath(join(native, "stale"))).rejects.toThrow();
    },
  );

  test("a vendor bucket reaches that vendor and no other", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-vendor-"));
    tempRoots.push(root);
    const primary = join(root, "primary");
    const repo = join(primary, ".hive", "skills", "agent");
    const global = join(root, "global-skills");
    await makeSkill(repo, "everyone", "everyone");
    for (const owner of CAPABILITY_PROVIDERS) {
      await makeSkill(join(repo, owner), `only-${owner}`, owner);
    }

    for (const tool of CAPABILITY_PROVIDERS) {
      const worktree = join(root, `worktree-${tool}`);
      await provisionSkills(primary, worktree, { role: "agent", tool }, global);
      const native = join(worktree, nativeSkillDirectory(tool));

      expect(
        await readFile(join(native, "everyone", "SKILL.md"), "utf8"),
      ).toEqual("# everyone\n");
      // Inclusion is half the claim; the other four must be absent. Codex,
      // Grok and Kimi share `.agents/skills`, so this is where a bucket that
      // resolved to a directory rather than a vendor would leak.
      for (const owner of CAPABILITY_PROVIDERS) {
        const skill = join(native, `only-${owner}`, "SKILL.md");
        if (owner === tool) {
          expect(await readFile(skill, "utf8")).toEqual(`# ${owner}\n`);
        } else {
          await expect(readFile(skill, "utf8")).rejects.toThrow();
        }
      }
      // And the bucket itself is never staged as if it were a skill.
      await expect(realpath(join(native, tool))).rejects.toThrow();
    }
  });

  test("a bucket name is a bucket at its own level, so a skill cannot claim it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-bucketname-"));
    tempRoots.push(root);
    const primary = join(root, "primary");
    const worktree = join(root, "worktree");
    const skills = join(primary, ".hive", "skills");
    // A SKILL.md directly inside a bucket directory is the ambiguous case: it
    // looks like a skill named "claude", or "code_review". The bucket rule
    // wins at the level where the name is a bucket, so neither is staged —
    // stated here so the limitation is asserted, not discovered.
    await makeSkill(join(skills, "agent"), "claude", "claude");
    await makeSkill(join(skills, "agent"), "code_review", "code_review");
    // And the level matters: `planning` is a bucket under agent/ but an
    // ordinary name under queen/, who is spawned under no category at all.
    await makeSkill(join(skills, "queen"), "planning", "queen planning");

    const native = join(worktree, ".claude", "skills");
    await provisionSkills(
      primary,
      worktree,
      { role: "agent", tool: "claude", category: "code_review" },
      join(root, "global"),
    );
    await expect(realpath(join(native, "claude"))).rejects.toThrow();
    await expect(realpath(join(native, "code_review"))).rejects.toThrow();

    const queenWorktree = join(root, "queen");
    await provisionSkills(
      primary,
      queenWorktree,
      { role: "queen", tool: "claude" },
      join(root, "global"),
    );
    expect(
      await readFile(
        join(queenWorktree, ".claude", "skills", "planning", "SKILL.md"),
        "utf8",
      ),
    ).toEqual("# queen planning\n");
  });

  test("a skill nobody can be given is reported, never silently dropped", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-unaddressed-"));
    tempRoots.push(root);
    const skills = join(root, "skills");
    // Flat path with no role/vendor segments — unaddressed.
    await makeSkill(skills, "written-before-roles", "orphan");
    // Vendor-only path (no role segment) — unaddressed.
    await makeSkill(join(skills, "claude"), "vendor-no-role", "orphan");
    // Three segments in the wrong order (vendor before category) — unaddressed.
    await makeSkill(
      join(skills, "agent", "planning", "claude"),
      "backwards",
      "orphan",
    );
    // Correctly addressed, and so absent from the report.
    await makeSkill(join(skills, "agent", "claude"), "addressed", "fine");
    await makeSkill(join(skills, "agent", "planning"), "by-category", "fine");
    await makeSkill(
      join(skills, "agent", "claude", "planning"),
      "also",
      "fine",
    );
    await makeSkill(join(skills, "queen"), "hers", "fine");

    expect(await unaddressedSkills(skills)).toEqual([
      join("agent", "planning", "claude", "backwards"),
      join("claude", "vendor-no-role"),
      "written-before-roles",
    ]);
  });

  test("queen and agent are given different skills of the same name", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-roles-"));
    tempRoots.push(root);
    const primary = join(root, "primary");
    const skills = join(primary, ".hive", "skills");
    await makeSkill(join(skills, "queen"), "house-style", "queen's");
    await makeSkill(join(skills, "agent"), "house-style", "agent's");

    for (const [role, marker] of [
      ["queen", "queen's"],
      ["agent", "agent's"],
    ] as const) {
      const worktree = join(root, role);
      await provisionSkills(
        primary,
        worktree,
        { role, tool: "claude" },
        join(root, "global"),
      );
      expect(
        await readFile(
          join(worktree, ".claude", "skills", "house-style", "SKILL.md"),
          "utf8",
        ),
      ).toEqual(`# ${marker}\n`);
    }
  });

  test("the most specific address wins, and vendor loses to category", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-precedence-order-"));
    tempRoots.push(root);
    const primary = join(root, "primary");
    const agent = join(primary, ".hive", "skills", "agent");
    await makeSkill(agent, "rules", "all agents");
    await makeSkill(join(agent, "claude"), "rules", "claude agents");
    await makeSkill(join(agent, "planning"), "rules", "planners");
    await makeSkill(
      join(agent, "claude", "planning"),
      "rules",
      "claude planners",
    );

    const read = async (worktree: string): Promise<string> =>
      readFile(
        join(worktree, ".claude", "skills", "rules", "SKILL.md"),
        "utf8",
      );

    // No category: the vendor bucket is the most specific address that applies.
    const uncategorized = join(root, "uncategorized");
    await provisionSkills(
      primary,
      uncategorized,
      { role: "agent", tool: "claude" },
      join(root, "global"),
    );
    expect(await read(uncategorized)).toEqual("# claude agents\n");

    // With one, both remaining overlays apply and the narrowest wins.
    const planner = join(root, "planner");
    await provisionSkills(
      primary,
      planner,
      { role: "agent", tool: "claude", category: "planning" },
      join(root, "global"),
    );
    expect(await read(planner)).toEqual("# claude planners\n");
  });

  test("preserves vendor-only skills and rejects same-name ambiguity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-conflict-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    const native = join(worktree, ".claude", "skills");
    await makeSkill(native, "vendor-only", "vendor");
    await makeSkill(native, "shared", "vendor shared");
    await makeSkill(
      join(worktree, ".hive", "skills", "agent"),
      "shared",
      "canonical",
    );

    await expect(
      provisionSkills(
        worktree,
        worktree,
        { role: "agent", tool: "claude" },
        join(root, "global"),
      ),
    ).rejects.toThrow("native path already exists");
    expect(
      await readFile(join(native, "vendor-only", "SKILL.md"), "utf8"),
    ).toEqual("# vendor\n");
  });

  test("installs the shipped skills even when the user has none of their own", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-empty-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true });

    await provisionSkills(
      worktree,
      worktree,
      { role: "agent", tool: "codex" },
      join(root, "missing-global"),
    );

    // Hive's own skills come from the binary, not from the user's disk, so an
    // agent gets them in a repo that has never heard of Hive.
    for (const skill of shippedSkillsFor({ role: "agent", tool: "codex" })) {
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
    const foreign = required(
      shippedSkillsFor({ role: "agent", tool: "claude" }).find(
        (skill) => skill.name === "hive-claude",
      ),
    );

    // Plant a byte-identical foreign contract in the shared reader directory.
    await mkdir(join(native, foreign.name), { recursive: true });
    await writeFile(join(native, foreign.name, "SKILL.md"), foreign.content);

    await provisionSkills(
      worktree,
      worktree,
      { role: "agent", tool: "codex" },
      join(root, "missing-global"),
    );

    await expect(
      readFile(join(native, foreign.name, "SKILL.md"), "utf8"),
    ).rejects.toThrow();

    // And the agent's own skills are still there: the prune removed the foreign
    // contract, not the provisioning.
    for (const skill of shippedSkillsFor({ role: "agent", tool: "codex" })) {
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

    await provisionSkills(
      worktree,
      worktree,
      { role: "agent", tool: "codex" },
      join(root, "missing-global"),
    );

    expect(
      await readFile(join(native, "hive-claude", "SKILL.md"), "utf8"),
    ).toEqual(mine);
  });

  test("a skill is withheld from a directory a reader it is not addressed to would see", () => {
    const contract = required(
      shippedSkillsFor({ role: "agent", tool: "codex" }).find(
        (skill) => skill.name === "hive-codex",
      ),
    );
    const neutral = required(
      shippedSkillsFor({ role: "agent", tool: "codex" }).find(
        (skill) => skill.name === "hive-memory",
      ),
    );

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

    const report = await installShippedSkills(
      root,
      { role: "agent", tool: "codex" },
      {
        coresidentVendors: ["claude"],
      },
    );

    // Coresident Claude shares no skill directory with Codex: withhold nothing.
    expect(report.withheld).toEqual([]);
    for (const skill of shippedSkillsFor({ role: "agent", tool: "codex" })) {
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
    const shipped = required(
      shippedSkillsFor({ role: "agent", tool: "claude" }).find(
        (skill) => skill.name === "hive-claude",
      ),
    );

    const first = await installShippedSkills(root, {
      role: "agent",
      tool: "claude",
    });
    expect(first.installed).toContain("hive-claude");
    expect(first.createdDirectory).toEqual(true);

    // Running again changes nothing and says so.
    const again = await installShippedSkills(root, {
      role: "agent",
      tool: "claude",
    });
    expect(again.installed).toEqual([]);
    expect(again.unchanged).toContain("hive-claude");
    expect(again.createdDirectory).toEqual(false);

    // The user edits it. Their edit survives, and is reported as drift.
    await writeFile(edited, "# mine now\n");
    const drifted = await installShippedSkills(root, {
      role: "agent",
      tool: "claude",
    });
    expect(drifted.drifted).toEqual(["hive-claude"]);
    expect(drifted.installed).toEqual([]);
    expect(await readFile(edited, "utf8")).toEqual("# mine now\n");

    // --force is the only way their copy is replaced.
    const forced = await installShippedSkills(
      root,
      { role: "agent", tool: "claude" },
      { force: true },
    );
    expect(forced.installed).toContain("hive-claude");
    expect(await readFile(edited, "utf8")).toEqual(shipped.content);
  });

  test("a user's own skill of the same name wins over the shipped one", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-skills-precedence-"));
    tempRoots.push(root);
    const worktree = join(root, "worktree");
    const mine = await makeSkill(
      join(worktree, ".hive", "skills", "agent"),
      "karpathy-guidelines",
      "my own guidelines",
    );

    await provisionSkills(
      worktree,
      worktree,
      { role: "agent", tool: "claude" },
      join(root, "missing-global"),
    );

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
      required(
        shippedSkillsFor({ role: "agent", tool: "claude" }).find(
          (skill) => skill.name === "hive-claude",
        )?.content,
      ),
    );
  });
});
