/** The compiled landing fixture: the semantic half of the proof, and the reason this factory is not a health check.
 *
 * The defect this exists for started cleanly, answered its handshake, passed every liveness probe, and refused every landing in the fleet. A process that is alive is not a process that works, so nothing here asks whether the candidate is up. It asks the candidate to do the one thing the fleet actually needs from it and then reads the result out of git.
 *
 * Two measurements, both taken inside a binary compiled from the same source with the same build stamp as the candidate, so a stamp defect is present here exactly as it is present there:
 *
 * 1. Self-invocation. `hiveCliSpawnArgv` is the shared helper every part of Hive uses to re-invoke this exact build for a child process, and its answer depends on `IS_RELEASE_BUILD`, which is `HIVE_BUILD_HASH !== null`. A compiled binary whose stamp went missing believes it is a source checkout and produces `[hive, src/cli.ts]` — the compiled executable invoked as if it were Bun. So this runs the argv the helper returns and reports what came back. `--version` is not a substitute: it answers correctly under that defect, because reading a stamp is not running a program.
 *
 * 2. Landing post-state. A real fast-forward through the real `landBranch`, in a disposable repository, and then the answer is read back out of git — where `main` points afterwards and whether the branch commit is genuinely its ancestor. An exit code is not a post-state, and the failure being guarded against is precisely a landing path that returns something while moving nothing.
 *
 * This program reports measurements and reaches no verdict. The producer compiled it, and nothing the producer compiled is allowed to certify the producer's output — the attester reads this report and decides. Its exit code says only whether it managed to take the measurements. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hiveCliSpawnArgv } from "../daemon/lifecycle/daemon-lifecycle";
import { landBranch } from "../daemon/landing/landing-service";
import { IS_RELEASE_BUILD } from "../shared/version";

/** Passed to the child this binary spawns of itself. */
export const FIXTURE_CHILD_FLAG = "--deployd-fixture-child";

/** What a correctly invoked child prints. Any other output means the argv the candidate builds for its own children does not run. */
export const FIXTURE_CHILD_TOKEN = "hive-deployd-fixture-child-ok";

/** The branch the landing leg lands. */
const FIXTURE_BRANCH = "hive/deployd-fixture";

export interface SelfInvocationMeasurement {
  readonly argv: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LandingMeasurement {
  readonly branchCommit: string;
  readonly mainBeforeLand: string;
  readonly mainAfterLand: string;
  /** `git merge-base --is-ancestor <branchCommit> main`, read back after the land. Zero means main genuinely contains the commit. */
  readonly ancestorExitCode: number;
  readonly landError: string | null;
}

export interface FixtureReport {
  readonly execPath: string;
  readonly isReleaseBuild: boolean;
  readonly selfInvocation: SelfInvocationMeasurement;
  readonly landing: LandingMeasurement;
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hive-deployd",
      GIT_AUTHOR_EMAIL: "deployd@hive.invalid",
      GIT_COMMITTER_NAME: "hive-deployd",
      GIT_COMMITTER_EMAIL: "deployd@hive.invalid",
    },
  });
  return result.stdout.toString().trim();
}

function measureSelfInvocation(): SelfInvocationMeasurement {
  const argv = hiveCliSpawnArgv(IS_RELEASE_BUILD, process.execPath);
  const child = Bun.spawnSync([...argv, FIXTURE_CHILD_FLAG], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    argv,
    exitCode: child.exitCode,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString().trim(),
  };
}

async function measureLanding(workspace: string): Promise<LandingMeasurement> {
  const repo = join(workspace, "landing-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "base", "--no-gpg-sign"]);
  git(repo, ["checkout", "-q", "-b", FIXTURE_BRANCH]);
  writeFileSync(join(repo, "app.ts"), "export const v = 2;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "candidate work", "--no-gpg-sign"]);
  git(repo, ["checkout", "-q", "main"]);

  const branchCommit = git(repo, ["rev-parse", FIXTURE_BRANCH]);
  const mainBeforeLand = git(repo, ["rev-parse", "main"]);
  let landError: string | null = null;
  try {
    await landBranch(repo, FIXTURE_BRANCH);
  } catch (error) {
    landError = error instanceof Error ? error.message : String(error);
  }
  const ancestor = Bun.spawnSync([
    "git",
    "-C",
    repo,
    "merge-base",
    "--is-ancestor",
    branchCommit,
    "main",
  ]);
  return {
    branchCommit,
    mainBeforeLand,
    mainAfterLand: git(repo, ["rev-parse", "main"]),
    ancestorExitCode: ancestor.exitCode,
    landError,
  };
}

export async function main(args: string[]): Promise<void> {
  if (args.includes(FIXTURE_CHILD_FLAG)) {
    // A correctly stamped release binary re-invokes itself with no script argument, so the flag is the whole of argv. Anything ahead of it means this binary was handed a source entry script the way Bun would be — the defect, arriving exactly as it would in production.
    if (args.length !== 1) {
      console.error(
        `fixture child received ${JSON.stringify(args)}; a compiled Hive invokes itself with no script argument`,
      );
      process.exit(2);
    }
    console.log(FIXTURE_CHILD_TOKEN);
    return;
  }

  const workspace = args[args.indexOf("--workspace") + 1];
  if (!args.includes("--workspace") || workspace === undefined) {
    throw new Error("fixture requires --workspace <absolute directory>");
  }
  const report: FixtureReport = {
    execPath: process.execPath,
    isReleaseBuild: IS_RELEASE_BUILD,
    selfInvocation: measureSelfInvocation(),
    landing: await measureLanding(workspace),
  };
  console.log(JSON.stringify(report));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
