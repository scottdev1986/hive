import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// A temporary tree nested inside the repository must still be treated as an
// independent apply target. Otherwise git resolves the enclosing repository,
// ignores the patched paths, and exits successfully without applying anything.
// This drives the real script and vendor tree with that directory layout.

const root = join(import.meta.dir, "..");
const vendorPresent = existsSync(join(root, "vendor", "ghostty", "build.zig"));

test.skipIf(!vendorPresent)(
  "vendor verify succeeds with the repo-default nested TMPDIR (#58)",
  () => {
    const tmpdir = join(root, ".dev", "tmp");
    mkdirSync(tmpdir, { recursive: true });
    const run = Bun.spawnSync(
      [join(root, "scripts", "vendor-ghostty.sh"), "verify"],
      {
        cwd: root,
        env: { ...process.env, TMPDIR: tmpdir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = run.stdout.toString();
    const stderr = run.stderr.toString();
    // The success banner proves the script reached the comparison.
    expect(stdout).toContain("vendored Ghostty verified");
    expect(stderr).not.toContain("tree mismatch");
    expect(run.exitCode).toBe(0);
  },
  120_000,
);
