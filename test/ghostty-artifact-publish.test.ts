import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: the GhosttyKit shared-cache key is ghostty-<commit>-zig-<ver>,
// which omits the patch series and the other locked inputs. The publish step
// in build-ghosttykit.sh kept any same-key incumbent that merely HAD an
// artifact-manifest.json — so when 689bc0a0 regenerated the patch series
// (same upstream commit, same zig), the freshly built engine was discarded,
// the stale incumbent was stamped as current, and the installed Workspace app
// embedded an engine build id that no longer matched sessiond's. Every pane
// attach then failed the M3 engine fence and surfaced as
// "renderer disconnected" while status plumbing stayed green.
//
// The fixtures below use the incident's real values: the incumbent records
// the pre-689bc0a0 patch series, the lock demands the regenerated one.

const root = join(import.meta.dir, "..");
const publish = join(root, "scripts", "publish-ghostty-artifact.sh");
const lockCheck = join(root, "scripts", "ghostty-artifact-lock-check.sh");

const GHOSTTY_COMMIT = "73534c4680a809398b396c94ac7f12fcccb7963d";
const OLD_PATCH_SHA =
  "ddeaf79284f0072f29d69dbf6580fd8f58eba98ceff11525f83f91f03f6e09e0";
const NEW_PATCH_SHA =
  "a7dd844d48ee71b0fc29c603db04cb86c02c54a8b5559252c456e7da7ee9b61a";
const OLD_TREE = "d92dc8fe76f3cd7c13879b34c972c8eaa0ed3dcb";
const NEW_TREE = "130bc9e74e4aed287d8778914b5ef077fcdf8fc4";
const HEADER_SHA =
  "36ca1c10cd07094abbf77cb14c2531899ca74c089a62f6f6cdeb07aa4927b2af";
const BRIDGE_SHA =
  "275ca6b8d3af85d9e9addcdc4f4e0edc599cd8fba2f93b19fd3d1f089688fafe";
const SYMBOL_SHA =
  "16e34bd7e3776904a8b5c13b69ebb3a883dcd071f090ac57e32f95cdb61139e9";

type SourceIdentity = {
  commit: string;
  patchedTree: string;
  patchSeriesSha256: string;
  upstreamPublicHeaderSha256: string;
  bridgeHeaderSha256: string;
  symbolListSha256: string;
};

const oldIdentity: SourceIdentity = {
  commit: GHOSTTY_COMMIT,
  patchedTree: OLD_TREE,
  patchSeriesSha256: OLD_PATCH_SHA,
  upstreamPublicHeaderSha256: HEADER_SHA,
  bridgeHeaderSha256: BRIDGE_SHA,
  symbolListSha256: SYMBOL_SHA,
};

const newIdentity: SourceIdentity = {
  ...oldIdentity,
  patchedTree: NEW_TREE,
  patchSeriesSha256: NEW_PATCH_SHA,
};

function writeArtifact(dir: string, source: SourceIdentity, marker: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "artifact-manifest.json"),
    JSON.stringify({ schemaVersion: 1, source, buildEnvironment: { optimizeMode: "ReleaseFast" } }, null, 2),
  );
  writeFileSync(join(dir, "engine-marker.txt"), marker);
}

function writeLock(path: string, ghostty: SourceIdentity): void {
  writeFileSync(path, JSON.stringify({ ghostty }, null, 2));
}

function manifestPatchSha(dir: string): string {
  const parsed = JSON.parse(
    readFileSync(join(dir, "artifact-manifest.json"), "utf8"),
  ) as { source: SourceIdentity };
  return parsed.source.patchSeriesSha256;
}

function run(cmd: string[]): { exitCode: number; stderr: string } {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

test("publish replaces a same-key incumbent built from a different patch series (689bc0a0)", () => {
  const base = mkdtempSync(join(tmpdir(), "ghostty-publish-"));
  const out = join(base, "build-tmp");
  const finalOut = join(base, `ghostty-${GHOSTTY_COMMIT}-zig-0.15.2`);
  const lock = join(base, "toolchain-lock.json");
  writeArtifact(finalOut, oldIdentity, "stale-engine");
  writeArtifact(out, newIdentity, "fresh-engine");
  writeLock(lock, newIdentity);
  // Positive control on the fixtures: the incumbent really is a different
  // patch series than the lock demands.
  expect(manifestPatchSha(finalOut)).toBe(OLD_PATCH_SHA);
  expect(manifestPatchSha(out)).toBe(NEW_PATCH_SHA);

  const result = run([publish, out, finalOut, lock]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  // The fresh build must win: keeping the stale incumbent here is the exact
  // failure that shipped a Workspace renderer refusing every attach.
  expect(manifestPatchSha(finalOut)).toBe(NEW_PATCH_SHA);
  expect(readFileSync(join(finalOut, "engine-marker.txt"), "utf8")).toBe("fresh-engine");
  expect(existsSync(out)).toBe(false);
});

test("publish keeps a same-key incumbent built from the same locked inputs (#46 race)", () => {
  const base = mkdtempSync(join(tmpdir(), "ghostty-publish-"));
  const out = join(base, "build-tmp");
  const finalOut = join(base, `ghostty-${GHOSTTY_COMMIT}-zig-0.15.2`);
  const lock = join(base, "toolchain-lock.json");
  writeArtifact(finalOut, newIdentity, "incumbent-engine");
  writeArtifact(out, newIdentity, "duplicate-engine");
  writeLock(lock, newIdentity);

  const result = run([publish, out, finalOut, lock]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  // The concurrent consumer's copy survives untouched; the duplicate is gone.
  expect(readFileSync(join(finalOut, "engine-marker.txt"), "utf8")).toBe("incumbent-engine");
  expect(existsSync(out)).toBe(false);
});

test("publish into an empty slot lands the fresh build", () => {
  const base = mkdtempSync(join(tmpdir(), "ghostty-publish-"));
  const out = join(base, "build-tmp");
  const finalOut = join(base, `ghostty-${GHOSTTY_COMMIT}-zig-0.15.2`);
  const lock = join(base, "toolchain-lock.json");
  writeArtifact(out, newIdentity, "fresh-engine");
  writeLock(lock, newIdentity);

  const result = run([publish, out, finalOut, lock]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(manifestPatchSha(finalOut)).toBe(NEW_PATCH_SHA);
  expect(existsSync(out)).toBe(false);
});

test("lock check accepts a matching artifact and refuses every drifted field", () => {
  const base = mkdtempSync(join(tmpdir(), "ghostty-lockcheck-"));
  const lock = join(base, "toolchain-lock.json");
  writeLock(lock, newIdentity);

  // Positive control: an artifact recording the lock's identity passes.
  const matching = join(base, "matching");
  writeArtifact(matching, newIdentity, "engine");
  expect(run([lockCheck, matching, lock]).exitCode).toBe(0);

  // Each single-field drift is refused — including the incident's pair.
  for (const [field, value] of [
    ["commit", "0000000000000000000000000000000000000000"],
    ["patchedTree", OLD_TREE],
    ["patchSeriesSha256", OLD_PATCH_SHA],
    ["upstreamPublicHeaderSha256", "0".repeat(64)],
    ["bridgeHeaderSha256", "0".repeat(64)],
    ["symbolListSha256", "0".repeat(64)],
  ] as const) {
    const drifted = join(base, `drift-${field}`);
    writeArtifact(drifted, { ...newIdentity, [field]: value }, "engine");
    expect({ field, exitCode: run([lockCheck, drifted, lock]).exitCode })
      .toEqual({ field, exitCode: 1 });
  }
});

test("lock check fails closed on missing manifest, missing key, and empty value", () => {
  const base = mkdtempSync(join(tmpdir(), "ghostty-lockcheck-"));
  const lock = join(base, "toolchain-lock.json");
  writeLock(lock, newIdentity);

  const missing = join(base, "missing");
  mkdirSync(missing, { recursive: true });
  expect(run([lockCheck, missing, lock]).exitCode).toBe(1);

  const truncated = join(base, "truncated");
  mkdirSync(truncated, { recursive: true });
  const { patchSeriesSha256: _omitted, ...partial } = newIdentity;
  writeFileSync(
    join(truncated, "artifact-manifest.json"),
    JSON.stringify({ schemaVersion: 1, source: partial }),
  );
  expect(run([lockCheck, truncated, lock]).exitCode).toBe(1);

  const empty = join(base, "empty");
  writeArtifact(empty, { ...newIdentity, patchSeriesSha256: "" }, "engine");
  expect(run([lockCheck, empty, lock]).exitCode).toBe(1);
});

test("lock check refuses a source-matching Debug artifact", () => {
  const base = mkdtempSync(join(tmpdir(), "ghostty-lockcheck-"));
  const lock = join(base, "toolchain-lock.json");
  const artifact = join(base, "debug-artifact");
  writeLock(lock, newIdentity);
  writeArtifact(artifact, newIdentity, "debug-engine");
  const manifest = join(artifact, "artifact-manifest.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { buildEnvironment: { optimizeMode: string } };
  parsed.buildEnvironment.optimizeMode = "Debug";
  writeFileSync(manifest, JSON.stringify(parsed));

  expect(run([lockCheck, artifact, lock]).exitCode).toBe(1);
});
