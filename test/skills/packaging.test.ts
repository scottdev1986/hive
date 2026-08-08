import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  SHIPPED_SKILLS,
  shippedSkillAddresses,
} from "../../src/skills/shipped";
import { required } from "../required";

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
  "code-review",
  "hive-alignment",
  "hive-board-conventions",
  "hive-claude",
  "hive-codex",
  "hive-dispatch",
  "hive-escalation",
  "hive-grok",
  "hive-kimi",
  "hive-landing",
  "hive-mail-discipline",
  "hive-memory",
  "hive-opencode",
  "hive-succession",
  "hive-worktree-lifecycle",
  "karpathy-guidelines",
];

let workspace: string | undefined;
let fixtureRoot: string;
let binary: Buffer;

/**
 * The memory arm of the guard below hunts for the text of `.hive/memory/` inside
 * the binary — and a corpus that is not on disk cannot be hunted for. That
 * corpus is missing from every clone and every worktree, and permanently so:
 * `.hive/memory/` is deliberately ignored, because this repo is public and the
 * facts in it are internal. Only the machine Hive is developed on has the real
 * ones.
 *
 * The compile runs from a disposable copy of the source tree with a stand-in
 * corpus beside it. That leaves the checkout untouched while keeping the corpus
 * in the exact place a build that swept `.hive/memory/` would find it. The guard
 * must never run against an empty directory and pass.
 */
async function ensureMemoryCorpus(): Promise<void> {
  const root = join(fixtureRoot, ".hive", "memory");
  await mkdir(root, { recursive: true });
  for (let index = 1; index <= 6; index += 1) {
    await writeFile(
      join(root, `stand-in-memory-fact-${index}.md`),
      `Synthesized stand-in for Hive memory fact number ${index}, on disk only while the packaging guard runs.\n`,
    );
  }
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hive-packaging-"));
  fixtureRoot = join(workspace, "repo");
  await mkdir(fixtureRoot);
  const installedPackages = join(
    dirname(Bun.resolveSync("commander", repoRoot)),
    "..",
  );
  await Promise.all([
    cp(join(repoRoot, "src"), join(fixtureRoot, "src"), { recursive: true }),
    cp(join(repoRoot, "skills"), join(fixtureRoot, "skills"), {
      recursive: true,
    }),
    cp(join(repoRoot, "graphify.lock"), join(fixtureRoot, "graphify.lock")),
    symlink(installedPackages, join(fixtureRoot, "node_modules")),
  ]);
  await ensureMemoryCorpus();
  const outfile = join(workspace, "hive");
  const build = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      join(fixtureRoot, "src", "cli.ts"),
      "--outfile",
      outfile,
    ],
    // bun leaves a 61 MB `.<id>-00000000.bun-build` scratch copy of its
    // runtime in the process cwd on every --compile, success included. Run
    // from the owned workspace so the afterAll removal takes the scratch too;
    // repoRoot as cwd scattered the scratch beside the checkout.
    { cwd: workspace },
  );
  if (build.exitCode !== 0) {
    throw new Error(`could not compile the CLI: ${build.stderr.toString()}`);
  }
  binary = await readFile(outfile);
}, 60_000);

afterAll(async () => {
  if (workspace !== undefined)
    await rm(workspace, { recursive: true, force: true });
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
 * worthless. The fingerprint must detect Hive memory embedded in the binary.
 *
 * So fingerprint with the longest run of plain printable ASCII that no escape
 * rule touches. Those bytes survive bundling intact, and are found if — and only
 * if — the content really is in there.
 */
function fingerprint(contents: string, excluded?: string): string {
  return (
    contents
      .split(/[^\x20-\x7E]|["'`\\$]/)
      .map((run) => run.trim())
      .filter((run) => excluded === undefined || !excluded.includes(run))
      .sort((a, b) => b.length - a.length)[0] ?? ""
  );
}

interface DevOnlyContent {
  path: string;
  contents: string;
  canonical?: string;
}

function assertNoDevOnlyLeaks(
  artifact: Buffer,
  devOnly: readonly DevOnlyContent[],
): number {
  const leaked: string[] = [];
  let checked = 0;
  for (const { path, contents, canonical } of devOnly) {
    const mark = fingerprint(contents, canonical);
    // Too short to identify one source reliably, so it does not count as a
    // checked file in the coverage assertion below.
    if (mark.length < 40) continue;
    checked += 1;
    if (artifact.includes(Buffer.from(mark, "utf8"))) leaked.push(path);
  }
  if (leaked.length > 0) {
    throw new Error(
      `compiled binary contains dev-only fingerprints:\n${leaked.join("\n")}`,
    );
  }
  return checked;
}

test("the shipped skills directory matches the declared list exactly", async () => {
  // `skills/` is laid out by install address, so a skill's directory is a claim
  // about who receives it. Reading the tree back and checking that claim against
  // the declaration is what keeps the two from drifting: a skill filed under
  // `agent/claude/` while declared for every vendor would otherwise be a
  // mismatch nobody sees until someone reads the wrong directory and believes it.
  const entries = await readdir(join(repoRoot, "skills"), {
    withFileTypes: true,
    recursive: true,
  });
  const found = entries
    .filter((entry) => entry.isFile() && entry.name === "SKILL.md")
    .map((entry) => ({
      name: basename(entry.parentPath),
      address: relative(join(repoRoot, "skills"), dirname(entry.parentPath)),
    }));

  expect(found.map((skill) => skill.name).sort()).toEqual(
    EXPECTED_SHIPPED_SKILLS,
  );
  expect(SHIPPED_SKILLS.map((skill) => skill.name).sort()).toEqual(
    EXPECTED_SHIPPED_SKILLS,
  );

  for (const { name, address } of found) {
    const declared = SHIPPED_SKILLS.find((skill) => skill.name === name);
    expect(declared).toBeDefined();
    // One source copy per skill, at one of the addresses it installs to — a
    // skill with two audiences installs twice from the one file.
    expect(shippedSkillAddresses(required(declared))).toContain(address);
  }
});

test("the compiled binary carries every shipped skill", () => {
  for (const skill of SHIPPED_SKILLS) {
    expect(skill.content.length).toBeGreaterThan(100);
    expect(shipped(fingerprint(skill.content))).toEqual(true);
  }
});

test("the packaging guard separates drift from a planted leak", () => {
  const canonical =
    "PACKAGING_POSITIVE_CONTROL_SHARED_CANONICAL_TEXT is intentionally the longest run so shared shipped text cannot indict a stale local copy.";
  const control: DevOnlyContent = {
    path: join(
      repoRoot,
      ".hive",
      "skills",
      "packaging-positive-control",
      "SKILL.md",
    ),
    contents: `${canonical}\nPACKAGING_POSITIVE_CONTROL_DEV_ONLY_TEXT_94b73a6c proves the guard rejects text that exists only in local Hive state.`,
    canonical,
  };
  expect(shipped(canonical)).toEqual(false);

  const canonicalArtifact = Buffer.concat([
    binary,
    Buffer.from(canonical, "utf8"),
  ]);
  const devOnlyMark = fingerprint(control.contents, canonical);
  const planted = Buffer.concat([
    canonicalArtifact,
    Buffer.from(devOnlyMark, "utf8"),
  ]);
  expect(() => assertNoDevOnlyLeaks(planted, [control])).toThrow(control.path);
  expect(() =>
    assertNoDevOnlyLeaks(canonicalArtifact, [control]),
  ).not.toThrow();
});

/**
 * A byte-identical provisioned copy is shipped content in a local tree, not a
 * leak. A drifted copy can still share long runs with its canonical source, so
 * only its unique runs can prove that local text reached the binary. This does
 * not exempt the drift: if one of those unique runs ships, the guard fails.
 */
test("the compiled binary carries no Hive memory and no dev-only skill", async () => {
  const shippedContent = new Map(
    SHIPPED_SKILLS.map((skill) => [skill.name, skill.content]),
  );

  const devOnly: DevOnlyContent[] = [];
  for (const [rootBase, directory] of [
    [fixtureRoot, ".hive/memory"],
    [repoRoot, ".hive/skills"],
    [repoRoot, ".claude/skills"],
  ] as const) {
    const root = join(rootBase, directory);
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
      // Keyed on the directory that *contains* the file, not on the first
      // segment of its path: a skill's own directory is its name at whatever
      // depth it sits, and the role/vendor/category buckets under
      // `.hive/skills` put real depth between the root and the skill.
      const canonical = shippedContent.get(basename(entry.parentPath));
      const contents = await readFile(path, "utf8");
      if (canonical !== undefined && contents === canonical) continue;
      devOnly.push({ path, contents, canonical });
    }
  }
  // Guard the guard: with nothing found, every assertion below would pass while
  // proving nothing whatsoever.
  expect(devOnly.length).toBeGreaterThan(5);

  const checked = assertNoDevOnlyLeaks(binary, devOnly);
  expect(checked).toBeGreaterThan(5);
}, 15_000);
