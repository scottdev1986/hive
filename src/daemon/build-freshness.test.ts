import { describe, expect, test } from "bun:test";
import {
  checkBuildFreshness,
  runningBuildProvenance,
  type GitRunner,
} from "./build-freshness";

const RELEASE = { isRelease: true, commit: "abc1234", version: "0.0.7" };

/** A git that answers from a table; anything unasked-for is an error, so a
 * test cannot accidentally pass on a command this module never ran. */
function fakeGit(answers: Record<string, { exitCode: number; stdout: string }>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected git: ${key}`);
    return answer;
  };
}

const ok = (stdout: string) => ({ exitCode: 0, stdout });
const fail = { exitCode: 1, stdout: "" };

describe("build freshness", () => {
  test("a release binary behind main is stale, and says how far behind", async () => {
    const freshness = await checkBuildFreshness(
      "/repo",
      fakeGit({
        "rev-parse main": ok("f00dcafef00dcafef00dcafef00dcafef00dcafe\n"),
        "cat-file -e abc1234^{commit}": ok(""),
        "rev-list --count abc1234..main": ok("12\n"),
      }),
      RELEASE,
    );
    expect(freshness.state).toBe("stale");
    expect(freshness.commitsBehind).toBe(12);
    expect(freshness.buildCommit).toBe("abc1234");
    expect(freshness.message).toContain("STALE BINARY");
    expect(freshness.message).toContain("12 commits behind main");
    expect(freshness.message).toContain("build:release");
  });

  test("a release binary at main's tip is current", async () => {
    const freshness = await checkBuildFreshness(
      "/repo",
      fakeGit({
        "rev-parse main": ok("abc1234\n"),
        "cat-file -e abc1234^{commit}": ok(""),
        "rev-list --count abc1234..main": ok("0\n"),
      }),
      RELEASE,
    );
    expect(freshness.state).toBe("current");
    expect(freshness.commitsBehind).toBe(0);
  });

  test("a build with no commit provenance is unknown, never current", async () => {
    const freshness = await checkBuildFreshness(
      "/repo",
      fakeGit({}),
      { isRelease: false, commit: "unknown", version: "0.0.0-dev" },
    );
    expect(freshness.state).toBe("unknown");
    expect(freshness.buildCommit).toBeNull();
    expect(freshness.message).toContain("cannot tell");
    expect(freshness.message).toContain("no commit provenance");
  });

  test("a build commit this repository does not have is unknown, never current", async () => {
    const freshness = await checkBuildFreshness(
      "/repo",
      fakeGit({
        "rev-parse main": ok("f00dcafe\n"),
        "cat-file -e abc1234^{commit}": fail,
      }),
      RELEASE,
    );
    expect(freshness.state).toBe("unknown");
    expect(freshness.message).toContain("abc1234");
    expect(freshness.message).toContain("not in this repository");
  });

  test("git failing is unknown, not a throw and not a clean bill of health", async () => {
    const freshness = await checkBuildFreshness(
      "/repo",
      async () => {
        throw new Error("git: command not found");
      },
      RELEASE,
    );
    expect(freshness.state).toBe("unknown");
    expect(freshness.message).toContain("git: command not found");
  });

  test("a repository with no main branch is unknown", async () => {
    const freshness = await checkBuildFreshness(
      "/repo",
      fakeGit({ "rev-parse main": fail }),
      RELEASE,
    );
    expect(freshness.state).toBe("unknown");
    expect(freshness.message).toContain("no `main` branch");
  });

  test("this test process is a source checkout, so its provenance is honest about that", () => {
    // The real constants, not an injected fake: a dev build must never claim a
    // release commit, which is what would make the whole check a decoration.
    expect(runningBuildProvenance().isRelease).toBe(false);
    expect(runningBuildProvenance().commit).toBe("unknown");
  });
});
