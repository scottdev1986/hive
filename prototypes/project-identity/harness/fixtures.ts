import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "hive",
  GIT_AUTHOR_EMAIL: "hive@example.invalid",
  GIT_COMMITTER_NAME: "hive",
  GIT_COMMITTER_EMAIL: "hive@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function tempRoot(prefix = "hive-identity-"): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export function commitFile(repo: string, name: string, content = "x"): void {
  writeFileSync(join(repo, name), content);
  git(repo, "add", name);
  git(repo, "commit", "-qm", `add ${name}`);
}

export interface GitTopology {
  root: string;
  /** Primary checkout. */
  main: string;
  /** Plain subdirectory deep inside `main`. */
  nestedPath: string;
  /** An independent repository living inside `main`'s worktree. */
  innerRepo: string;
  /** A submodule checkout inside `main`. */
  submodule: string;
  /** `git worktree add` checkout of `main`. */
  linkedWorktree: string;
  /** A second, independent clone of `main`. */
  clone: string;
  /** A bare repository. */
  bare: string;
}

/** Build every Git topology the resolver must distinguish, in one temp root. */
export function buildGitTopology(root: string): GitTopology {
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  commitFile(main, "README.md");

  const nestedPath = join(main, "deep", "nested");
  mkdirSync(nestedPath, { recursive: true });

  const innerRepo = join(main, "inner");
  mkdirSync(innerRepo);
  git(innerRepo, "init", "-q", "-b", "main");
  commitFile(innerRepo, "inner.txt");

  const upstream = join(root, "submodule-origin");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  commitFile(upstream, "sub.txt");

  git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub");
  git(main, "commit", "-qm", "add submodule");
  const submodule = join(main, "sub");

  const linkedWorktree = join(root, "linked-wt");
  git(main, "worktree", "add", "-q", linkedWorktree, "-b", "feature");

  const clone = join(root, "clone");
  git(root, "-c", "protocol.file.allow=always", "clone", "-q", main, clone);

  const bare = join(root, "bare.git");
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare");

  return { root, main, nestedPath, innerRepo, submodule, linkedWorktree, clone, bare };
}

export interface DiskImage {
  mountPoint: string;
  detach(): void;
}

export class DiskImageUnavailable extends Error {}

/**
 * Attach a real APFS disk image with a chosen case behavior.
 *
 * `hdiutil` needs no privileges for a user-owned image, so both a case-sensitive and
 * a case-insensitive volume can be exercised on the same machine. Throws
 * DiskImageUnavailable where that is not possible, so callers can report `skipped`
 * rather than silently testing one volume twice.
 */
export function attachDiskImage(caseSensitive: boolean, root: string): DiskImage {
  const fs = caseSensitive ? "Case-sensitive APFS" : "APFS";
  const image = join(root, caseSensitive ? "cs.dmg" : "ci.dmg");
  const mountPoint = join(root, caseSensitive ? "mnt-cs" : "mnt-ci");
  mkdirSync(mountPoint, { recursive: true });
  try {
    execFileSync("hdiutil", ["create", "-size", "40m", "-fs", fs, "-volname", caseSensitive ? "HiveCS" : "HiveCI", "-quiet", image], { stdio: "ignore" });
    execFileSync("hdiutil", ["attach", image, "-nobrowse", "-quiet", "-mountpoint", mountPoint], { stdio: "ignore" });
  } catch (error) {
    throw new DiskImageUnavailable(`cannot attach ${fs} image: ${String(error)}`);
  }
  return {
    mountPoint: realpathSync.native(mountPoint),
    detach() {
      try {
        execFileSync("hdiutil", ["detach", mountPoint, "-quiet", "-force"], { stdio: "ignore" });
      } catch {
        /* the harness must not fail on cleanup */
      }
      rmSync(image, { force: true });
    },
  };
}
