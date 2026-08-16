import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../../test/temp-root";

// A temporary tree nested inside the repository must still be treated as an
// independent apply target. Otherwise git resolves the enclosing repository,
// ignores the patched paths, and exits successfully without applying anything.
// This drives the real script and vendor tree with that directory layout.
//
// It runs in the native gate (`bun run test:sessiond`, which starts it by
// path) rather than in the ordinary Bun suite, because it drives the whole
// vendor verifier — an rsync of the vendored Ghostty tree, a reverse and
// forward replay of the patch series, two write-trees and a recursive diff.
// Measured at 111.92s in a 312.88s suite of 3487 tests: one test, 36.9% of all
// measured test time, with the second-slowest at 2.66s. The gate that watches
// main runs the Bun suite alone, and that budget cannot carry a whole-tree
// vendor proof. The native gate already qualifies vendor/ghostty — it runs two
// `zig build test-lib-vt` passes over it — so this is where it belongs.

const root = join(import.meta.dir, "../..");
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
  // The work this drives is measured at 111.92s at rest and 166.87s on a
  // machine running a five-agent fleet, so a 120s allowance was below the
  // thing it was timing: it reported the load, not the verifier. Five times
  // the at-rest cost stops it measuring the machine and leaves it catching
  // only a verifier that has genuinely hung. Every assertion above is
  // unchanged; the only thing raised is the deadline.
  600_000,
);
