import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeQueenPluginRoot,
  grokQueenHome,
  provisionQueenSkills,
  queenSkillDelivery,
} from "../../src/adapters/queen-skills";
import { buildOrchestratorCommand } from "../../src/cli/orchestrator";
import { CAPABILITY_PROVIDERS } from "../../src/schemas/capability";
import { shippedSkillsFor } from "../../src/skills/shipped";

/**
 * The queen's skills, which every vendor delivers differently. These tests hold
 * the two halves that a wrong answer separates: what Hive writes to disk, and
 * what the launch says to make the vendor read it. A directory provisioned
 * where nothing looks is the failure mode with no error message.
 */

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<{ repo: string; queen: string }> {
  const root = await mkdtemp(join(tmpdir(), "hive-queen-skills-"));
  tempRoots.push(root);
  return { repo: join(root, "repo"), queen: join(root, "queen") };
}

async function makeSkill(path: string, marker: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `# ${marker}\n`);
}

test("every vendor is answered, and only codex is answered with nothing", () => {
  const queen = "/queen";
  const withoutDirectory = CAPABILITY_PROVIDERS.filter(
    (tool) => queenSkillDelivery(tool, queen).directory === null,
  );
  expect(withoutDirectory).toEqual(["codex"]);

  for (const tool of CAPABILITY_PROVIDERS) {
    const delivery = queenSkillDelivery(tool, queen);
    // Exactly one of the two is present: a vendor either has a directory of
    // her own or an explanation of what she reads instead. Neither is silence.
    expect(delivery.directory === null).toEqual(delivery.degraded !== null);
  }
});

test("grok's directory is the home the launch actually sets", () => {
  // The invariant that has no error case: grok reads `$GROK_HOME/skills` and
  // nowhere else, so provisioning and the launch environment must agree.
  expect(queenSkillDelivery("grok", "/queen").directory).toEqual(
    join(grokQueenHome("/queen"), "skills"),
  );
});

test("the launch carries what the vendor needs to read her directory", () => {
  const claude = buildOrchestratorCommand({
    tool: "claude",
    port: 4000,
    executable: "claude",
    queenSkillArgs: queenSkillDelivery("claude", "/queen").launchArgs,
  });
  expect(claude).toContain("--plugin-dir");
  expect(claude).toContain(claudeQueenPluginRoot("/queen"));
  // The flag that makes the plugin necessary is still there: without it the
  // repository's settings would reach her, with it project skills cannot.
  expect(claude).toContain("--setting-sources");

  // Codex has no directory, so it must add no flag at all rather than an
  // empty or invented one.
  expect(queenSkillDelivery("codex", "/queen").launchArgs).toEqual([]);
});

test("a queen is given her own skills, and not an agent's", async () => {
  const { repo, queen } = await workspace();
  const skills = join(repo, ".hive", "skills");
  await makeSkill(join(skills, "queen", "board-habits"), "hers");
  await makeSkill(join(skills, "queen", "claude", "claude-only"), "hers too");
  await makeSkill(join(skills, "agent", "house-style"), "an agent's");

  const delivery = await provisionQueenSkills(
    repo,
    "claude",
    queen,
    join(queen, "no-global-skills"),
  );
  const directory = delivery.directory ?? "";

  expect(
    await readFile(join(directory, "board-habits", "SKILL.md"), "utf8"),
  ).toEqual("# hers\n");
  expect(
    await readFile(join(directory, "claude-only", "SKILL.md"), "utf8"),
  ).toEqual("# hers too\n");
  await expect(
    readFile(join(directory, "house-style", "SKILL.md"), "utf8"),
  ).rejects.toThrow();

  // Hive's own: alignment, memory, and every pull-tier decision topic are
  // hers; the worktree contract and coding guidelines are not.
  expect(shippedSkillsFor({ role: "queen", tool: "claude" })).toHaveLength(9);
  for (const hers of [
    "hive-memory",
    "hive-alignment",
    "hive-board-conventions",
    "hive-dispatch",
    "hive-escalation",
    "hive-landing",
    "hive-mail-discipline",
    "hive-succession",
    "hive-worktree-lifecycle",
  ]) {
    expect(await readFile(join(directory, hers, "SKILL.md"), "utf8")).toContain(
      `name: ${hers}`,
    );
  }
  for (const absent of ["hive-claude", "karpathy-guidelines", "code-review"]) {
    await expect(
      readFile(join(directory, absent, "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  }
});

test("claude's plugin manifest names the namespace her skills arrive under", async () => {
  const { repo, queen } = await workspace();
  await mkdir(repo, { recursive: true });

  await provisionQueenSkills(repo, "claude", queen, join(queen, "no-global"));

  const manifest = JSON.parse(
    await readFile(
      join(claudeQueenPluginRoot(queen), ".claude-plugin", "plugin.json"),
      "utf8",
    ),
  ) as { name: string };
  // Skills from a plugin are addressed `<plugin>:<skill>`, so this string is
  // the queen's vocabulary, not a label: changing it renames every skill.
  expect(manifest.name).toEqual("hive");
});

test("provisioning twice leaves the same directory, not a second copy", async () => {
  const { repo, queen } = await workspace();
  await makeSkill(join(repo, ".hive", "skills", "queen", "twice"), "once");

  const global = join(queen, "no-global");
  await provisionQueenSkills(repo, "kimi", queen, global);
  const delivery = await provisionQueenSkills(repo, "kimi", queen, global);

  expect(
    await readFile(join(delivery.directory ?? "", "twice", "SKILL.md"), "utf8"),
  ).toEqual("# once\n");
  // kimi's flag replaces its own discovery, so the directory it names is the
  // whole surface and has to be the one that was just written.
  expect(delivery.launchArgs).toEqual([
    "--skills-dir",
    delivery.directory ?? "",
  ]);
});
