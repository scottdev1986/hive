import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// #58: `scripts/vendor-ghostty.sh verify` silently no-oped when TMPDIR was
// inside the repo (the default .dev/tmp): git apply resolved the ENCLOSING
// hive repository, treated the temp tree as a subdirectory, ignored every
// patched path, and exited 0 without changing anything — so the still-patched
// tree was compared against the base tree and verify failed with "base tree
// mismatch" on a perfectly correct vendor tree. That broke `make test` for
// every agent using the repo-default TMPDIR.
//
// This drives the real script against the real vendor tree with TMPDIR nested
// inside the repo — the exact failing configuration.

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
    // Positive control on the instrument: a script that silently did nothing
    // must not pass — the success banner names the verified trees.
    expect(stdout).toContain("vendored Ghostty verified");
    expect(stderr).not.toContain("tree mismatch");
    expect(run.exitCode).toBe(0);
  },
  120_000,
);
