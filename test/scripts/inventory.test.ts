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
