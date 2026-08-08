import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./temp-root";

// A temporary tree nested inside the repository must still be treated as an
// independent apply target. Otherwise git resolves the enclosing repository,
// ignores the patched paths, and exits successfully without applying anything.
// This drives the real script and vendor tree with that directory layout.

const root = join(import.meta.dir, "..");
const vendorPresent = existsSync(join(root, "vendor", "ghostty", "build.zig"));

test.skipIf(!vendorPresent)(
  "vendor verify succeeds with the repo-default nested TMPDIR (#58)",
  () => {
    const fixtureRoot = tempRoot("hive-vendor-verify-");
    const nestedTmpdir = join(fixtureRoot, ".dev", "tmp");
    mkdirSync(join(fixtureRoot, "scripts", "native"), { recursive: true });
    mkdirSync(join(fixtureRoot, "native"), { recursive: true });
    mkdirSync(join(fixtureRoot, "vendor"), { recursive: true });
    mkdirSync(nestedTmpdir, { recursive: true });
    cpSync(
      join(root, "scripts", "native", "vendor-ghostty.sh"),
      join(fixtureRoot, "scripts", "native", "vendor-ghostty.sh"),
    );
    cpSync(
      join(root, "native", "include"),
      join(fixtureRoot, "native", "include"),
      {
        recursive: true,
      },
    );
    for (const name of ["toolchain-lock.json", "ghostty-patches"]) {
      symlinkSync(
        join(root, "native", name),
        join(fixtureRoot, "native", name),
      );
    }
    symlinkSync(
      join(root, "vendor", "ghostty"),
      join(fixtureRoot, "vendor", "ghostty"),
    );
    const initialized = Bun.spawnSync(["git", "init", "--quiet", fixtureRoot]);
    expect(initialized.exitCode).toBe(0);
    const run = Bun.spawnSync(
      [join(fixtureRoot, "scripts", "native", "vendor-ghostty.sh"), "verify"],
      {
        cwd: fixtureRoot,
        env: { ...process.env, TMPDIR: nestedTmpdir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = run.stdout.toString();
    const stderr = run.stderr.toString();
    // The success banner proves the script reached the comparison.
    expect(stderr).toBe("");
    expect(stdout).toContain("vendored Ghostty verified");
    expect(stderr).not.toContain("tree mismatch");
    expect(run.exitCode).toBe(0);
  },
  120_000,
);
