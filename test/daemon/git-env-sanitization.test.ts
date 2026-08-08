// Every git invocation that decides project identity or landing must run with
// the hostile discovery variables stripped from the inherited environment.
//
// The hazard is real and silent: `GIT_DIR=<decoy> git -C <repo> rev-parse
// --git-common-dir` reports the decoy, not the repo. Hive's daemon inherits
// whatever environment launched it, so an unsanitized call mints a different
// project identity — a parallel `~/.hive/projects` tree — or points the landing
// gate at another repository's refs.
//
// The probe runs in a child process on purpose. Bun snapshots the environment
// at process start, so poisoning `process.env` from inside a test never reaches
// a `Bun.spawn` child: an in-process version of this test passes whether or not
// the call sites sanitize. Only a child born with the hostile variables already
// in its environ can tell the two apart.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const HOSTILE_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const;

const FIXTURE = join(import.meta.dir, "git-env-probe.fixture.ts");

interface ProbeResult {
  landingCommonDir: string;
  landingExitCode: number;
  grokRepositoryRoot: string | null;
  worktreePaths: string[];
  projectStateDir: string;
}

let base: string;
let repo: string;
let decoy: string;
let hiveHome: string;

beforeAll(() => {
  base = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-git-env-"));
  repo = join(base, "real");
  decoy = join(base, "decoy");
  hiveHome = join(base, "hive-home");
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "--bare", decoy], { stdio: "ignore" });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function probe(hostile: Record<string, string>): Promise<ProbeResult> {
  const child = Bun.spawn(["bun", FIXTURE, repo], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HIVE_HOME: hiveHome, ...hostile },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`probe failed: ${stderr}`);
  return JSON.parse(stdout) as ProbeResult;
}

describe("git discovery env is stripped at every identity call site", () => {
  test("a hostile GIT_DIR genuinely redirects git (positive control)", () => {
    const redirected = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_DIR: decoy } },
    ).trim();

    // Without this the assertions below would pass against a hazard that
    // never fires, which is exactly how an unsanitized call site stays green.
    expect(redirected).toEqual(decoy);
  });

  test("every call site ignores every hostile variable", async () => {
    // The clean run first, so the project registry mints this repo's uuid from
    // an honest environment; a redirected second run would key a second
    // project directory beside it.
    const clean = await probe({});
    const hostile = await probe(
      Object.fromEntries(HOSTILE_GIT_ENV.map((key) => [key, decoy])),
    );

    expect(hostile.landingExitCode).toEqual(0);
    expect(hostile.landingCommonDir).toEqual(join(repo, ".git"));
    expect(hostile.grokRepositoryRoot).toEqual(repo);
    expect(hostile.worktreePaths).toEqual([repo]);
    expect(hostile.projectStateDir).toEqual(clean.projectStateDir);
  });

  test("GIT_DIR alone is stripped", async () => {
    const clean = await probe({});
    const hostile = await probe({ GIT_DIR: decoy });

    expect(hostile.landingCommonDir).toEqual(join(repo, ".git"));
    expect(hostile.grokRepositoryRoot).toEqual(repo);
    expect(hostile.worktreePaths).toEqual([repo]);
    expect(hostile.projectStateDir).toEqual(clean.projectStateDir);
  });
});
