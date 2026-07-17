import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = join(import.meta.dir, "hive-bootstrap");

function run(...args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([launcher, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("pinned bootstrap launcher", () => {
  test("reports the immutable release pin for this architecture", () => {
    const result = run("pin");
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("version=0.0.37\n");
    expect(output).toContain(
      "commit=40c4efa447d45c71c63910d66d9bc263ff0c0534\n",
    );
    expect(output).toMatch(/asset=hive-darwin-(arm64|x64)\n/);
    expect(output).toMatch(/sha256=[0-9a-f]{64}\n/);
  });

  test("refuses runtime namespace escapes before daemon access", () => {
    const named = run("--instance", "other", "status");
    expect(named.exitCode).not.toBe(0);
    expect(named.stderr.toString()).toContain("exactly one runtime namespace");

    const update = run("update");
    expect(update.exitCode).not.toBe(0);
    expect(update.stderr.toString()).toContain("disabled for the immutable bootstrap");
  });

  test("finds the immutable pin when invoked through an installed symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-bootstrap-link-test-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const link = join(bin, "hive-bootstrap");
      await symlink(launcher, link);
      const result = Bun.spawnSync([link, "pin"], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("version=0.0.37\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
