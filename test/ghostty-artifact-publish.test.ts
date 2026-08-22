import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./temp-root";

// The GhosttyKit shared-cache key omits the patch series and other locked
// inputs. Publishing must compare the full manifest before keeping a same-key
// incumbent, or a stale engine can replace a freshly built one. The fixtures
// use one patch series for the incumbent and another for the current lock.

const root = join(import.meta.dir, "..");
const publish = join(root, "scripts", "native", "publish-ghostty-artifact.sh");
const lockCheck = join(
  root,
  "scripts",
  "native",
  "ghostty-artifact-lock-check.sh",
);

const GHOSTTY_COMMIT = "73534c4680a809398b396c94ac7f12fcccb7963d";
const OLD_PATCH_SHA =
  "ddeaf79284f0072f29d69dbf6580fd8f58eba98ceff11525f83f91f03f6e09e0";
const NEW_PATCH_SHA =
  "fb10c6972457dbebfc163f59b130c9e3118c68739edd3107f1c35168a9cad8fc";
const OLD_TREE = "d92dc8fe76f3cd7c13879b34c972c8eaa0ed3dcb";
const NEW_TREE = "316bf46b0c89385a47191c462a9432bb163c32dd";
const HEADER_SHA =
  "36ca1c10cd07094abbf77cb14c2531899ca74c089a62f6f6cdeb07aa4927b2af";
const BRIDGE_SHA =
  "0c3817a25030029468d72454edba38c6b3c9aa694a575e758e6de9c75d667872";
const SYMBOL_SHA =
  "cc5f40c736e4f7dc401c760d586801f075502e452909ec1da3f6d50c13723968";

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

function writeArtifact(
  dir: string,
  source: SourceIdentity,
  marker: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "artifact-manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        source,
        buildEnvironment: { optimizeMode: "ReleaseFast" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "engine-marker.txt"), marker);
}

function writeLock(path: string, ghostty: SourceIdentity): void {
  writeFileSync(path, JSON.stringify({ ghostty }, null, 2));
}

function manifestPatchSha(dir: string): string {
  // SAFETY: The test owns this value and its fields.
  const parsed = JSON.parse(
    readFileSync(join(dir, "artifact-manifest.json"), "utf8"),
  ) as { source: SourceIdentity };
  return parsed.source.patchSeriesSha256;
}

function run(cmd: string[]) {
  const result = Bun.spawnSync(cmd, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

test("publish replaces a same-key incumbent built from a different patch series (689bc0a0)", () => {
  const base = tempRoot("ghostty-publish-");
  const out = join(base, "build-tmp");
  const finalOut = join(base, `ghostty-${GHOSTTY_COMMIT}-zig-0.15.2`);
  const lock = join(base, "toolchain-lock.json");
  writeArtifact(finalOut, oldIdentity, "stale-engine");
  writeArtifact(out, newIdentity, "fresh-engine");
  writeLock(lock, newIdentity);
  expect(manifestPatchSha(finalOut)).toBe(OLD_PATCH_SHA);
  expect(manifestPatchSha(out)).toBe(NEW_PATCH_SHA);

  const result = run([publish, out, finalOut, lock]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  // The fresh build must win when the full locked identity differs.
  expect(manifestPatchSha(finalOut)).toBe(NEW_PATCH_SHA);
  expect(readFileSync(join(finalOut, "engine-marker.txt"), "utf8")).toBe(
    "fresh-engine",
  );
  expect(existsSync(out)).toBe(false);
});

test("publish keeps a same-key incumbent built from the same locked inputs (#46 race)", () => {
  const base = tempRoot("ghostty-publish-");
  const out = join(base, "build-tmp");
  const finalOut = join(base, `ghostty-${GHOSTTY_COMMIT}-zig-0.15.2`);
  const lock = join(base, "toolchain-lock.json");
  writeArtifact(finalOut, newIdentity, "incumbent-engine");
  writeArtifact(out, newIdentity, "duplicate-engine");
  writeLock(lock, newIdentity);

  const result = run([publish, out, finalOut, lock]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(finalOut, "engine-marker.txt"), "utf8")).toBe(
    "incumbent-engine",
  );
  expect(existsSync(out)).toBe(false);
});

test("publish into an empty slot lands the fresh build", () => {
  const base = tempRoot("ghostty-publish-");
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
  const base = tempRoot("ghostty-lockcheck-");
  const lock = join(base, "toolchain-lock.json");
  writeLock(lock, newIdentity);

  const matching = join(base, "matching");
  writeArtifact(matching, newIdentity, "engine");
  expect(run([lockCheck, matching, lock]).exitCode).toBe(0);

  // Each field contributes independently to the locked identity.
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
    expect({
      field,
      exitCode: run([lockCheck, drifted, lock]).exitCode,
    }).toEqual({ field, exitCode: 1 });
  }
});

test("lock check fails closed on missing manifest, missing key, and empty value", () => {
  const base = tempRoot("ghostty-lockcheck-");
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
  const base = tempRoot("ghostty-lockcheck-");
  const lock = join(base, "toolchain-lock.json");
  const artifact = join(base, "debug-artifact");
  writeLock(lock, newIdentity);
  writeArtifact(artifact, newIdentity, "debug-engine");
  const manifest = join(artifact, "artifact-manifest.json");
  // SAFETY: The test owns this value and its fields.
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    buildEnvironment: { optimizeMode: string };
  };
  parsed.buildEnvironment.optimizeMode = "Debug";
  writeFileSync(manifest, JSON.stringify(parsed));

  expect(run([lockCheck, artifact, lock]).exitCode).toBe(1);
});
