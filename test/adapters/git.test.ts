import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type GitResult, runGit, runGitSync } from "../../src/adapters/git";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

// Every case runs a real git against a real repository: the runner's contract
// is what git actually does with the argv it is handed, and a mocked spawn
// reports whatever the test expects either way.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

let base: string;
let repo: string;
let headSha: string;

beforeAll(() => {
  base = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-git-runner-"));
  repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "hive@example.invalid"]);
  git(repo, ["config", "user.name", "Hive Test"]);
  writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base", "--no-gpg-sign"]);
  headSha = git(repo, ["rev-parse", "HEAD"]);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("runGit", () => {
  test("captures stdout, stderr, and exit code untrimmed", async () => {
    const ok = await runGit(repo, ["rev-parse", "HEAD"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe(headSha);
    expect(ok.timedOut).toBe(false);

    const bad = await runGit(repo, ["rev-parse", "--verify", "no-such-ref"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("fatal");
    expect(bad.timedOut).toBe(false);
  });

  test("a fast failure is not a timeout — the bug the landing path shipped", async () => {
    const result = await runGit(repo, ["merge", "--ff-only", "no-such-branch"]);
    // Bun sets `Subprocess.killed` on *any* exited process, so a test of
    // `proc.killed && exitCode !== 0` reports a timeout for a command that
    // failed in milliseconds having said precisely what was wrong. `timedOut`
    // must come from the runner's own deadline firing, and nowhere else.
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("not something we can merge");
  });

  test("a git that outlives the deadline is killed and reported timedOut", async () => {
    const stub = join(base, "stub-bin");
    mkdirSync(stub);
    writeFileSync(join(stub, "git"), "#!/bin/sh\nexec sleep 60\n");
    chmodSync(join(stub, "git"), 0o755);

    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "git-timeout.fixture.ts"), repo, "100"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}` },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`timeout fixture failed: ${stderr}`);
    // SAFETY: The test owns this value and its fields.
    const result = JSON.parse(stdout) as GitResult;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("hostile-looking arguments reach git as literals, never a shell", async () => {
    // Substitution fires only if the string is evaluated by a shell on the
    // way to git. Argv spawning hands it over as one literal argument.
    const marker = join(base, "pwned-substitution");
    const substituted = await runGit(repo, [
      "rev-parse",
      "--verify",
      `refs/heads/$(touch ${marker})`,
    ]);
    expect(substituted.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);

    // A metacharacter-laden pattern is one argv element: git lists no branch
    // matching it and exits 0, and the `; touch` never runs as a command.
    const marker2 = join(base, "pwned-split");
    const listed = await runGit(repo, [
      "branch",
      "--list",
      `no-such-branch; touch ${marker2}`,
    ]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.trim()).toBe("");
    expect(existsSync(marker2)).toBe(false);
  });

  test("a cwd full of shell metacharacters is chdir'd, not interpreted", async () => {
    // If the cwd reached a shell unquoted this could never produce git's
    // answer: the name would be split, substituted, and executed instead.
    const markerInRunnerCwd = join(process.cwd(), "pwned-cwd");
    const evil = join(base, "evil $(touch pwned-cwd);rm -rf x");
    execFileSync("git", ["init", "-q", evil]);
    const result = await runGit(evil, ["rev-parse", "--is-inside-work-tree"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
    expect(existsSync(markerInRunnerCwd)).toBe(false);
  });
});

describe("runGitSync", () => {
  test("captures output and exit code", () => {
    const ok = runGitSync(repo, ["rev-parse", "HEAD"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe(headSha);

    const outside = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-git-plain-"));
    try {
      const bad = runGitSync(outside, ["rev-parse", "HEAD"]);
      expect(bad.exitCode).not.toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a hostile-looking argument is still one literal argument", () => {
    const marker = join(base, "pwned-sync");
    const result = runGitSync(repo, [
      "rev-parse",
      "--verify",
      `x$(touch ${marker})`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
