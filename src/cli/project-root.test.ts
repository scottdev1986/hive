import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUTSIDE_REPO_TMPDIR } from "../../test/outside-repo-tmpdir";
import { projectRootOrCwd, resolveProjectRoot } from "./project-root";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, prefix));
  dirs.push(dir);
  return dir;
}

describe("resolveProjectRoot", () => {
  test("a repo subdirectory resolves to the worktree root", () => {
    const repo = tempDir("hive-project-root-");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const subdir = join(repo, "nested", "deeper");
    mkdirSync(subdir, { recursive: true });
    // Compare against the physical path: git reports physical paths.
    const root = realpathSync(repo);
    expect(resolveProjectRoot(subdir)).toEqual(root);
    expect(projectRootOrCwd(subdir)).toEqual(root);
  });

  test("outside a repo the root is null and the fallback is the directory itself", () => {
    const dir = tempDir("hive-not-a-repo-");
    expect(resolveProjectRoot(dir)).toEqual(null);
    // The fallback is the literal directory passed in, symlinks and all.
    expect(projectRootOrCwd(dir)).toEqual(dir);
  });
});
