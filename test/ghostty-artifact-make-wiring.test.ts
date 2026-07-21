import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression on the MAKE WIRING, not on the shell scripts it calls.
//
// 65855caa detected a stale same-key GhosttyKit artifact correctly but hung the
// heal off the stamp rule as a .PHONY ORDER-ONLY prerequisite. GNU Make 3.81
// (what macOS ships) stats a target once and decides then whether to remake it,
// so deleting the stamp from a prerequisite's recipe changes nothing: the
// rebuild recipe never runs, the staging rule never runs, make exits 0 — and
// the stamp is gone. The poisoned artifact stayed staged, the Workspace app
// kept an engine build id sessiond did not share, and every pane attach failed
// the M3 engine fence as "renderer disconnected".
//
// These tests drive the REAL Makefile with NATIVE_CACHE pointed at a seeded
// cache, so a regression in the wiring bites here even if every script below
// it still passes its own unit tests.

const root = join(import.meta.dir, "..");
const lock = join(root, "native", "toolchain-lock.json");

const REBUILD = "building lock-pinned GhosttyKit";
const STAGE = "staging lock-pinned GhosttyKit for SwiftPM";

function lockValue(key: string): string {
  const parsed = JSON.parse(readFileSync(lock, "utf8")) as {
    ghostty: Record<string, string>;
    zig: { version: string };
  };
  return key === "zigVersion" ? parsed.zig.version : parsed.ghostty[key];
}

function lockSha(): string {
  const result = Bun.spawnSync(["/usr/bin/shasum", "-a", "256", lock], { stdout: "pipe" });
  return result.stdout.toString().slice(0, 16);
}

/**
 * Seeds a cache whose artifact records `source`, stamped for the current lock, plus the
 * already-staged xcframework the plan is compared against.
 *
 * Staging is seeded rather than read from the checkout: `make -n build` also plans a
 * restage whenever nothing is staged yet, which is true of any worktree where `make
 * build` has not run, and that restage says nothing about the artifact's identity.
 */
function seedCache(source: Record<string, string>): { cache: string; stamp: string; staged: string } {
  const cache = mkdtempSync(join(tmpdir(), "ghostty-make-wiring-"));
  const artifact = join(
    cache,
    "artifacts",
    `ghostty-${lockValue("commit")}-zig-${lockValue("zigVersion")}`,
  );
  mkdirSync(join(artifact, "GhosttyKit.xcframework"), { recursive: true });
  writeFileSync(
    join(artifact, "artifact-manifest.json"),
    JSON.stringify({ schemaVersion: 1, source }, null, 2),
  );
  const staged = join(cache, "staged", "GhosttyKit.xcframework");
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, "Info.plist"), "");
  const stamp = join(artifact, `.hive-lock-${lockSha()}.stamp`);
  writeFileSync(stamp, "");
  // Backdate it behind the staged Info.plist, so a planned restage can only come
  // from the stamp being remade — never from this fixture being the newer file.
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(stamp, old, old);
  return { cache, stamp, staged };
}

function lockedIdentity(): Record<string, string> {
  return Object.fromEntries(
    [
      "commit",
      "patchedTree",
      "patchSeriesSha256",
      "upstreamPublicHeaderSha256",
      "bridgeHeaderSha256",
      "symbolListSha256",
    ].map((key) => [key, lockValue(key)]),
  );
}

/**
 * `make build` is the plan under test: the public surface is exactly
 * clean/build/run/test, so the rebuild-and-restage wiring has to be reachable
 * from the command the user actually runs — there is no `ghosttykit` target to
 * aim at any more, and a prerequisite that stops being reachable from `build`
 * is the same silent staleness this file exists to catch.
 */
function planBuild(cache: string, staged: string): string {
  const result = Bun.spawnSync(["make", "-n", "build", `NATIVE_CACHE=${cache}`, `GHOSTTYKIT=${staged}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.stdout.toString() + result.stderr.toString();
}

test("a stale artifact wearing a current lock stamp is rebuilt and restaged", () => {
  // The incident's own drift: same upstream commit, regenerated patch series.
  const { cache, stamp, staged } = seedCache({
    ...lockedIdentity(),
    patchedTree: "d92dc8fe76f3cd7c13879b34c972c8eaa0ed3dcb",
    patchSeriesSha256:
      "ddeaf79284f0072f29d69dbf6580fd8f58eba98ceff11525f83f91f03f6e09e0",
  });
  expect(existsSync(stamp)).toBe(true);

  const plan = planBuild(cache, staged);
  expect(plan).toContain(REBUILD);
  expect(plan).toContain(STAGE);
  // The lying stamp is gone, so a later build cannot trust it either.
  expect(existsSync(stamp)).toBe(false);
});

test("an artifact recording the lock's source identity is left alone", () => {
  // Two-way control: without this, a heal that always fires would pass the
  // test above while forcing a 25-40 minute rebuild on every single make.
  const { cache, stamp, staged } = seedCache(lockedIdentity());

  const plan = planBuild(cache, staged);
  expect(plan).not.toContain(REBUILD);
  expect(plan).not.toContain(STAGE);
  expect(existsSync(stamp)).toBe(true);
});
