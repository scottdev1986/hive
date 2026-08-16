import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const inventory = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "qa",
  "inventory.sh",
);
const assertGone = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "qa",
  "assert-qa-gone.sh",
);

function run(argv: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-b", "main"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(git.exitCode, git.stderr.toString()).toBe(0);
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  const add = Bun.spawnSync(["git", "add", "tracked.txt", ".gitignore"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(add.exitCode, add.stderr.toString()).toBe(0);
  const commit = Bun.spawnSync(["git", "commit", "-m", "seed"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hive-qa",
      GIT_AUTHOR_EMAIL: "qa@hive.local",
      GIT_COMMITTER_NAME: "hive-qa",
      GIT_COMMITTER_EMAIL: "qa@hive.local",
    },
  });
  expect(commit.exitCode, commit.stderr.toString()).toBe(0);
}

test("repo inventory compare is green on an unchanged tree and names both files", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-inventory-clean-"),
  );
  try {
    const repo = join(fixture, "repo");
    initRepo(repo);
    const before = join(fixture, "before");
    const after = join(fixture, "after");
    const captured = run([inventory, "capture-repo", repo, before]);
    expect(captured.exitCode, captured.stderr).toBe(0);
    expect(captured.stdout).toContain(repo);
    expect(captured.stdout).toContain(before);
    const recaptured = run([inventory, "capture-repo", repo, after]);
    expect(recaptured.exitCode, recaptured.stderr).toBe(0);
    const compared = run([inventory, "compare", before, after]);
    expect(compared.exitCode, compared.stderr + compared.stdout).toBe(0);
    expect(compared.stdout).toContain(`before: ${before}`);
    expect(compared.stdout).toContain(`after:  ${after}`);
    expect(compared.stdout).toContain("identical");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("repo inventory reds when an ignored stray is seeded — the positive control", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-inventory-red-"));
  try {
    const repo = join(fixture, "repo");
    initRepo(repo);
    const before = join(fixture, "before");
    const after = join(fixture, "after");
    expect(run([inventory, "capture-repo", repo, before]).exitCode).toBe(0);
    writeFileSync(join(repo, "ignored.txt"), "stray hive residue\n");
    expect(run([inventory, "capture-repo", repo, after]).exitCode).toBe(0);
    const compared = run([inventory, "compare", before, after]);
    expect(compared.exitCode).toBe(1);
    expect(compared.stdout + compared.stderr).toContain("DIFFER");
    expect(compared.stdout + compared.stderr).toContain("ignored.txt");
    expect(compared.stdout).toContain(`before: ${before}`);
    expect(compared.stdout).toContain(`after:  ${after}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("repo inventory reds on an untracked file the same way", () => {
  const fixture = mkdtempSync(
    join(OUTSIDE_REPO_TMPDIR, "hive-inventory-untracked-"),
  );
  try {
    const repo = join(fixture, "repo");
    initRepo(repo);
    const before = join(fixture, "before");
    const after = join(fixture, "after");
    expect(run([inventory, "capture-repo", repo, before]).exitCode).toBe(0);
    writeFileSync(join(repo, "untracked.txt"), "also residue\n");
    expect(run([inventory, "capture-repo", repo, after]).exitCode).toBe(0);
    const compared = run([inventory, "compare", before, after]);
    expect(compared.exitCode).toBe(1);
    expect(compared.stdout + compared.stderr).toContain("untracked.txt");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("assert-qa-gone prints every path and fails when one remains", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-qa-gone-"));
  try {
    const missing = join(fixture, "missing");
    const present = join(fixture, "present");
    writeFileSync(present, "still here\n");
    const red = run([assertGone, missing, present]);
    expect(red.exitCode).toBe(1);
    expect(red.stdout + red.stderr).toContain(`absent         ${missing}`);
    expect(red.stdout + red.stderr).toContain(`STILL PRESENT  ${present}`);
    rmSync(present);
    const green = run([assertGone, missing, present]);
    expect(green.exitCode, green.stderr).toBe(0);
    expect(green.stdout).toContain(`absent         ${missing}`);
    expect(green.stdout).toContain(`absent         ${present}`);
    expect(green.stdout).toContain("no listed qa path remains");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("isolation inventory ignores nested mutation and reds a new instance name", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-isolation-"));
  const isolation = join(
    import.meta.dir,
    "..",
    "..",
    "scripts",
    "qa",
    "isolation-inventory.sh",
  );
  try {
    const hive = join(fixture, ".hive");
    mkdirSync(join(hive, "instances", "dev-live"), { recursive: true });
    writeFileSync(join(hive, "instances", "dev-live", "hive.db-wal"), "live\n");
    const before = join(fixture, "before");
    const afterNested = join(fixture, "after-nested");
    const afterLeak = join(fixture, "after-leak");
    expect(run([isolation, hive, before]).exitCode).toBe(0);
    writeFileSync(
      join(hive, "instances", "dev-live", "hive.db-wal"),
      "changed\n",
    );
    expect(run([isolation, hive, afterNested]).exitCode).toBe(0);
    const nested = run([inventory, "compare", before, afterNested]);
    expect(nested.exitCode, nested.stderr + nested.stdout).toBe(0);
    mkdirSync(join(hive, "instances", "qa-leaked"));
    expect(run([isolation, hive, afterLeak]).exitCode).toBe(0);
    const leaked = run([inventory, "compare", before, afterLeak]);
    expect(leaked.exitCode).toBe(1);
    expect(leaked.stdout + leaked.stderr).toContain("qa-leaked");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("tree inventory records an absent root instead of inventing one", async () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-tree-absent-"));
  try {
    const missing = join(fixture, "no-such-dir");
    const out = join(fixture, "out");
    const captured = run([inventory, "capture-tree", missing, out]);
    expect(captured.exitCode, captured.stderr).toBe(0);
    expect(captured.stdout).toContain(missing);
    expect(await Bun.file(out).text()).toContain("state\tabsent");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
