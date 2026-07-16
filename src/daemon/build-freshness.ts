/**
 * Is the running binary older than main?
 *
 * The daemon executes a compiled release binary. Code merged to main is inert
 * until `bun run build:release` and a daemon restart, and nothing used to say
 * so: a feature landed green and `hive_spawn --tool grok` still failed, because
 * the daemon was executing yesterday's code.
 *
 * The signal is the commit the binary was built from — `HIVE_COMMIT`, inlined
 * by `--define` at release-build time (see ../version.ts). Git knows what
 * commit main is at, so `git rev-list --count <buildCommit>..main` is an exact
 * count of the commits the running code does not contain.
 *
 * Why not mtime, which a one-off probe used: a file timestamp says when bytes
 * were written, not what code is in them. It cannot say WHICH commits are
 * missing, it moves when the file is copied or touched, and it compares a clock
 * against a clock rather than a commit against a commit. The build commit is
 * inside the artifact, cannot be forged by the environment, and — the point of
 * this whole exercise — cannot be answered by grepping the source tree, which
 * is exactly what a stale daemon makes look correct.
 *
 * When the binary carries no provenance (a dev build, `bun run src/cli.ts`), or
 * its commit is not in this repository, the answer is UNKNOWN. Never "fresh":
 * an "up to date" that means "I could not tell" is the bug this module exists
 * to kill.
 */
import { HIVE_COMMIT, HIVE_VERSION, IS_RELEASE_BUILD } from "../version";
import { runGit } from "./landing";

export interface BuildFreshness {
  /** stale: main has commits the running binary does not contain. */
  state: "current" | "stale" | "unknown";
  version: string;
  /** Commit the binary was built from; null in a build with no provenance. */
  buildCommit: string | null;
  mainCommit: string | null;
  commitsBehind: number | null;
  /** One line, always present, safe to show a human or an orchestrator. */
  message: string;
}

export interface BuildProvenance {
  isRelease: boolean;
  commit: string;
  version: string;
}

/** Exit code plus stdout is all this module needs from git. */
export type GitRunner = (args: string[]) => Promise<{
  exitCode: number;
  stdout: string;
}>;

const REBUILD = "Run `bun run build:release` and restart the daemon.";

export function runningBuildProvenance(): BuildProvenance {
  return {
    isRelease: IS_RELEASE_BUILD,
    commit: HIVE_COMMIT,
    version: HIVE_VERSION,
  };
}

const unknown = (version: string, commit: string | null, reason: string): BuildFreshness => ({
  state: "unknown",
  version,
  buildCommit: commit,
  mainCommit: null,
  commitsBehind: null,
  message: `Hive cannot tell whether the running binary is up to date with main: ${reason}. Code landed on main may or may not be live in this daemon.`,
});

/**
 * Explicit Hive-development diagnostic: compare the running binary's build
 * commit against the Hive source checkout's main.
 *
 * Never throws: a broken git, a missing main, or an unknown commit is an
 * honest UNKNOWN, not a failure and not a clean bill of health.
 * Generic project status must not call this function: an active project's
 * path, name, or local registry identity does not prove it is Hive's source.
 */
export async function checkHiveDevelopmentBuildFreshness(
  sourceRoot: string,
  git: GitRunner = (args) => runGit(sourceRoot, args),
  provenance: BuildProvenance = runningBuildProvenance(),
): Promise<BuildFreshness> {
  const { version, commit } = provenance;
  if (!provenance.isRelease || commit === "unknown") {
    return unknown(
      version,
      null,
      "this build carries no commit provenance (a dev build or a source checkout)",
    );
  }
  try {
    const main = await git(["rev-parse", "main"]);
    if (main.exitCode !== 0) {
      return unknown(version, commit, "this repository has no `main` branch to compare against");
    }
    const mainCommit = main.stdout.trim();
    const known = await git(["cat-file", "-e", `${commit}^{commit}`]);
    if (known.exitCode !== 0) {
      return unknown(
        version,
        commit,
        `the commit it was built from (${commit}) is not in this repository`,
      );
    }
    const behind = await git(["rev-list", "--count", `${commit}..main`]);
    const count = Number.parseInt(behind.stdout.trim(), 10);
    if (behind.exitCode !== 0 || !Number.isInteger(count)) {
      return unknown(version, commit, "git could not count the commits between it and main");
    }
    if (count === 0) {
      return {
        state: "current",
        version,
        buildCommit: commit,
        mainCommit,
        commitsBehind: 0,
        message:
          `Running binary ${version} was built from ${commit} and contains everything on main.`,
      };
    }
    return {
      state: "stale",
      version,
      buildCommit: commit,
      mainCommit,
      commitsBehind: count,
      message:
        `STALE BINARY: this daemon runs ${version}, built from ${commit}, which is ` +
        `${count} commit${count === 1 ? "" : "s"} behind main (${mainCommit.slice(0, 7)}). ` +
        `Anything landed on main since then is NOT live — merged is not running. ${REBUILD}`,
    };
  } catch (error) {
    return unknown(
      version,
      commit,
      `git failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
