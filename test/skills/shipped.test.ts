import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED_SKILLS, shippedSkillsFor } from "../../src/skills/shipped";

/**
 * The question these tests answer is not "did we call the function" — it is
 * "does a user who has only the binary actually get the skills". Hive ships as
 * a `bun build --compile` executable, so the only honest proof is to compile
 * one, delete nothing, take the binary somewhere with no Hive checkout in
 * sight, run it, and look at what appears on disk.
 */

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

test("every shipped skill carries real content and vendor-required frontmatter", () => {
  expect(SHIPPED_SKILLS.map((skill) => skill.name).sort()).toEqual([
    "code-review",
    "hive-claude",
    "hive-codex",
    "hive-grok",
    "hive-memory",
    "karpathy-guidelines",
  ]);

  for (const skill of SHIPPED_SKILLS) {
    // An empty string is exactly what a broken embed produces, so the content
    // assertions are the point of this test, not decoration.
    expect(skill.content.length).toBeGreaterThan(100);
    // Codex requires both `name` and `description` in frontmatter, and the name
    // has to be the directory name or the skill is unaddressable.
    const frontmatter = skill.content.split("---")[1] ?? "";
    expect(frontmatter).toContain(`name: ${skill.name}`);
    expect(frontmatter).toMatch(/\ndescription: \S/);
  }
});

test("each vendor is offered the skills written for it", () => {
  expect(shippedSkillsFor("claude").map((skill) => skill.name)).toEqual([
    "hive-claude",
    "hive-memory",
    "karpathy-guidelines",
    "code-review",
  ]);
  expect(shippedSkillsFor("codex").map((skill) => skill.name)).toEqual([
    "hive-codex",
    "hive-memory",
    "karpathy-guidelines",
    "code-review",
  ]);
  expect(shippedSkillsFor("grok").map((skill) => skill.name)).toEqual([
    "hive-grok",
    "hive-memory",
    "karpathy-guidelines",
    "code-review",
  ]);
});

test(
  "a compiled binary installs the shipped skills with no checkout to read from",
  async () => {
    const root = await tempRoot("hive-compiled-skills-");
    const entry = join(root, "entry.ts");
    const binary = join(root, "install-skills");
    const target = join(root, "someones-repo");

    // The entry imports the same installer `hive init` and the spawner call, so
    // this compiles the real code path rather than a re-implementation of it.
    const installer = join(import.meta.dir, "../../src/adapters/skills.ts");
    await writeFile(
      entry,
      `import { installShippedSkills } from ${JSON.stringify(installer)};\n` +
        `const root = process.argv[2]!;\n` +
        `await installShippedSkills(root, "claude");\n` +
        `await installShippedSkills(root, "codex");\n` +
        `await installShippedSkills(root, "grok");\n`,
    );

    const compile = Bun.spawnSync([
      "bun",
      "build",
      "--compile",
      entry,
      "--outfile",
      binary,
    ]);
    expect(compile.stderr.toString()).toEqual("");
    expect(compile.exitCode).toEqual(0);

    // Run it from the temp directory, not the repo: if the embed were a lie and
    // the skills were being read off disk, there is nothing here to read.
    const run = Bun.spawnSync([binary, target], { cwd: root });
    expect(run.stderr.toString()).toEqual("");
    expect(run.exitCode).toEqual(0);

    for (const skill of SHIPPED_SKILLS) {
      for (const tool of skill.tools) {
        const native = tool === "claude"
          ? join(".claude", "skills")
          : join(".agents", "skills");
        const installed = await readFile(
          join(target, native, skill.name, "SKILL.md"),
          "utf8",
        );
        expect(installed).toEqual(skill.content);
        expect(installed.length).toBeGreaterThan(100);
      }
    }

    // The negative half of the vendor contract: Claude's skill does not land in
    // Codex's directory, and vice versa.
    expect(
      await Bun.file(join(target, ".claude", "skills", "hive-codex", "SKILL.md"))
        .exists(),
    ).toEqual(false);
    expect(
      await Bun.file(join(target, ".agents", "skills", "hive-claude", "SKILL.md"))
        .exists(),
    ).toEqual(false);
  },
  30_000,
);
