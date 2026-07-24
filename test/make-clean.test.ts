import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OUTSIDE_REPO_TMPDIR } from "./outside-repo-tmpdir";

const root = join(import.meta.dir, "..");

test("make clean removes dev state without following shared-memory symlinks", () => {
  const fixture = mkdtempSync(join(OUTSIDE_REPO_TMPDIR, "hive-make-clean-"));
  const dev = join(fixture, "dev");
  const devHome = join(fixture, "home");
  const sharedMemory = join(fixture, "shared-memory");
  try {
    mkdirSync(dev, { recursive: true });
    mkdirSync(devHome, { recursive: true });
    mkdirSync(sharedMemory, { recursive: true });
    writeFileSync(join(dev, "artifact"), "dev build\n");
    writeFileSync(join(devHome, "runtime-state"), "dev runtime\n");
    writeFileSync(join(sharedMemory, "article.md"), "live memory\n");
    symlinkSync(sharedMemory, join(devHome, "memory"));

    const result = Bun.spawnSync([
      "make",
      "clean",
      `DEV=${dev}`,
      `DEV_HOME=${devHome}`,
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, output).toBe(0);
    expect(existsSync(dev)).toBe(false);
    expect(existsSync(devHome)).toBe(false);
    expect(existsSync(join(sharedMemory, "article.md"))).toBe(true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
