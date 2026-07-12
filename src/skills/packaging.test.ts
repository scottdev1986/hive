import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { SHIPPED_SKILLS } from "./shipped";

/**
 * The packaging guard. Two obligations, and both are about a stranger's disk:
 *
 *   1. Everything in `skills/` is declared, and everything declared is in
 *      `skills/`. A skill dropped into the directory without being declared
 *      would never ship; a skill declared without existing would ship as an
 *      empty string. Either way CI fails here rather than in someone's repo.
 *
 *   2. None of Hive's own development kit can reach a user. `.hive/memory/` is a
 *      log of what *this project* learned, and the dev-only skills
 *      (`.hive/skills/hive-versioning`, `karpathy-docs`, and their `.claude/skills`
 *      symlinks) are instructions for working on Hive's own source tree. None of
 *      it belongs to the person who installed Hive.
 *
 * Both are checked against the artifact itself: we compile the same binary
 * `src/release/build.ts` ships (`bun build --compile src/cli.ts`) and read its
 * bytes. Nothing that is absent from that file can land on a user's machine, and
 * nothing present in it can be argued away.
 */

const repoRoot = join(import.meta.dir, "..", "..");

const EXPECTED_SHIPPED_SKILLS = [
  "hive-claude",
  "hive-codex",
  "hive-grok",
  "hive-memory",
  "karpathy-guidelines",
];

let workspace: string;
let binary: Buffer;
/** Set only when the memory corpus below is ours to delete again. */
let synthesizedMemory: string | undefined;

/**
 * The memory arm of the guard below hunts for the text of `.hive/memory/` inside
 * the binary — and a corpus that is not on disk cannot be hunted for. That
 * corpus is missing from every clone and every worktree, and permanently so:
 * `.hive/memory/` is deliberately ignored, because this repo is public and the
 * facts in it are internal. Only the machine Hive is developed on has the real
 * ones.
 *
 * So where the real facts exist we scan those, and where they do not we write a
 * stand-in corpus instead — before the compile, so it is on disk for the build
 * to sweep up if the build is ever going to. Either way the guard runs against
 * real bytes and would still fail on a build that swept the directory into the
 * artifact. What it must never do is run against an empty directory and pass.
 */
async function ensureMemoryCorpus(): Promise<void> {
  const root = join(repoRoot, ".hive", "memory");
  if (existsSync(root)) return;
  await mkdir(root, { recursive: true });
  synthesizedMemory = root;
  for (let index = 1; index <= 6; index += 1) {
    await writeFile(
      join(root, `stand-in-memory-fact-${index}.md`),
      `Synthesized stand-in for Hive memory fact number ${index}, on disk only while the packaging guard runs.\n`,
    );
  }
}

beforeAll(async () => {
  await ensureMemoryCorpus();
  workspace = await mkdtemp(join(tmpdir(), "hive-packaging-"));
  const outfile = join(workspace, "hive");
  const build = Bun.spawnSync(
    ["bun", "build", "--compile", join(repoRoot, "src", "cli.ts"), "--outfile", outfile],
    { cwd: repoRoot },
  );
  if (build.exitCode !== 0) {
    throw new Error(`could not compile the CLI: ${build.stderr.toString()}`);
  }
  binary = await readFile(outfile);
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  if (synthesizedMemory) await rm(synthesizedMemory, { recursive: true, force: true });
});

/** Is this text inside the shipped binary, byte for byte? */
function shipped(text: string): boolean {
  return binary.includes(Buffer.from(text, "utf8"));
}

/**
 * A fingerprint of a file: long enough to be unique to it, and — this is the
 * part that matters — chosen so that the bundler cannot hide it from us.
 *
 * The bundler inlines a file's text as a JavaScript string literal, and escapes
 * two kinds of character on the way: the ones that would end the literal (`"`,
 * `'`, a backtick, a backslash, `$`) and every non-ASCII one (an em dash becomes
 * `—`). Either kind turns the file's bytes into different bytes, so a naive
 * search for a file's longest line finds nothing *whether or not that file
 * leaked* — which is a guard that cannot fail, and a guard that cannot fail is
 * worthless. This was not hypothetical: the first version of this test could not
 * see a Hive memory that was genuinely embedded in the binary.
 *
 * So fingerprint with the longest run of plain printable ASCII that no escape
 * rule touches. Those bytes survive bundling intact, and are found if — and only
 * if — the content really is in there.
 */
function fingerprint(contents: string): string {
  return contents
    .split(/[^\x20-\x7E]|["'`\\$]/)
    .map((run) => run.trim())
    .sort((a, b) => b.length - a.length)[0] ?? "";
}

test("the shipped skills directory matches the declared list exactly", async () => {
  const entries = await readdir(join(repoRoot, "skills"), { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  expect(directories).toEqual(EXPECTED_SHIPPED_SKILLS);
  expect(SHIPPED_SKILLS.map((skill) => skill.name).sort()).toEqual(
    EXPECTED_SHIPPED_SKILLS,
  );

  for (const name of directories) {
    expect(await Bun.file(join(repoRoot, "skills", name, "SKILL.md")).exists())
      .toEqual(true);
  }
});

test("the compiled binary carries every shipped skill", () => {
  for (const skill of SHIPPED_SKILLS) {
    expect(skill.content.length).toBeGreaterThan(100);
    expect(shipped(fingerprint(skill.content))).toEqual(true);
  }
});

/**
 * No exemptions, deliberately. An earlier version of this test excused any dev
 * text that also appeared in a shipped skill — and that rule turned out to
 * swallow a real leak, because text pasted into a shipped skill exempts itself.
 * An exemption you can grant yourself by leaking is not an exemption. The
 * shipped guidance moved *out* of `.hive/skills/` rather than being copied, so
 * there is no dev file whose words are legitimately in the binary, and nothing
 * here needs excusing.
 */
test("the compiled binary carries no Hive memory and no dev-only skill", async () => {
  const shippedContent = new Map(
    SHIPPED_SKILLS.map((skill) => [skill.name, skill.content]),
  );

  const devOnly: string[] = [];
  for (const directory of [".hive/memory", ".hive/skills", ".claude/skills"]) {
    const root = join(repoRoot, directory);
    const entries = await readdir(root, {
      withFileTypes: true,
      recursive: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(entry.parentPath, entry.name);
      // Hive provisions verbatim copies of shipped skills into an agent
      // worktree's .claude/skills for the agent's own use. That's shipped
      // content living in a dev tree, not dev content leaking out, so it
      // isn't a hit here — but only when the bytes actually match the
      // canonical skills/ source; a diverged copy still counts as dev-only.
      const topLevel = relative(root, entry.parentPath).split(sep)[0] ?? "";
      const canonical = shippedContent.get(topLevel);
      if (canonical !== undefined && (await readFile(path, "utf8")) === canonical) {
        continue;
      }
      devOnly.push(path);
    }
  }
  // Guard the guard: with nothing found, every assertion below would pass while
  // proving nothing whatsoever.
  expect(devOnly.length).toBeGreaterThan(5);

  const leaked: string[] = [];
  let checked = 0;
  for (const path of devOnly) {
    const mark = fingerprint(await readFile(path, "utf8"));
    // Too short to be evidence of anything. Counted as unchecked rather than
    // quietly passed, so `checked` below stays an honest coverage number.
    if (mark.length < 40) continue;
    checked += 1;
    if (shipped(mark)) leaked.push(path);
  }

  expect(leaked).toEqual([]);
  expect(checked).toBeGreaterThan(5);
});
