import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, type ReleaseManifest } from "../release/manifest";
import {
  UpdateError,
  activate,
  activateWithHealthCheck,
  isStaged,
  pruneOldVersions,
  readInstallState,
  rollback,
  stageRelease,
  versionsToPrune,
  writeInstallState,
} from "./install";
import { cliPath, currentLink, stagingDir, versionDir, versionsDir } from "./paths";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hive-install-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CLI_BYTES = new TextEncoder().encode("#!/bin/sh\necho hive 0.0.7\n");

const manifestFor = (version: string, bytes: Uint8Array): ReleaseManifest => ({
  schema: 1,
  version,
  tag: `v${version}`,
  channel: "stable",
  commit: "abc1234",
  publishedAt: "2026-07-10T00:00:00Z",
  securityCritical: false,
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  artifacts: [{
    name: "hive-darwin-arm64",
    kind: "cli",
    platform: "darwin",
    arch: "arm64",
    size: bytes.byteLength,
    sha256: sha256(bytes),
    buildHash: `hash-of-${version}`,
  }],
});

const stageDeps = (
  version: string,
  over: Partial<Parameters<typeof stageRelease>[0]> = {},
) => {
  const manifest = manifestFor(version, CLI_BYTES);
  return {
    manifest,
    manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
    signature: null,
    arch: "arm64" as const,
    root,
    publicKey: null,
    download: async () => CLI_BYTES,
    probeVersion: async () => `hive ${version} (abc1234)`,
    ...over,
  };
};

/** A fake installed version, so activation tests need no downloads. */
function fakeVersion(version: string, exitOk = true): void {
  const dir = versionDir(version, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(cliPath(dir), `#!/bin/sh\n${exitOk ? "echo hive " + version : "exit 1"}\n`);
  chmodSync(cliPath(dir), 0o755);
}

describe("staging a release", () => {
  test("verifies, stages, and leaves an immutable version directory", async () => {
    const result = await stageRelease(stageDeps("0.0.7"));
    expect(result.version).toEqual("0.0.7");
    expect(result.signed).toEqual(false);
    expect(result.warning).toContain("not signed");
    expect(isStaged("0.0.7", root)).toEqual(true);
  });

  test("refuses bytes whose digest the manifest did not name", async () => {
    const promise = stageRelease(stageDeps("0.0.7", {
      download: async () => new TextEncoder().encode("malicious"),
    }));
    await expect(promise).rejects.toThrow(/does not match the SHA-256/);
    expect(isStaged("0.0.7", root)).toEqual(false);
  });

  test("refuses a binary that will not say its own version", async () => {
    const promise = stageRelease(stageDeps("0.0.7", {
      probeVersion: async () => "hive 0.0.6 (old)",
    }));
    await expect(promise).rejects.toThrow(/reported "hive 0\.0\.6 \(old\)"/);
    expect(isStaged("0.0.7", root)).toEqual(false);
  });

  test("refuses a binary that will not run at all, and cleans up its staging dir", async () => {
    const promise = stageRelease(stageDeps("0.0.7", {
      probeVersion: async () => {
        throw new Error("Bad CPU type in executable");
      },
    }));
    await expect(promise).rejects.toThrow(/did not run/);
    expect(isStaged("0.0.7", root)).toEqual(false);
    expect(existsSync(join(stagingDir(root), "0.0.7"))).toEqual(false);
  });

  test("fails closed when a release key is embedded but the manifest is unsigned", async () => {
    // Stripping the signature must not downgrade the check to "unsigned is fine".
    const promise = stageRelease(stageDeps("0.0.7", {
      publicKey: "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=",
      signature: null,
    }));
    await expect(promise).rejects.toThrow(UpdateError);
    await expect(promise).rejects.toThrow(/no hive-release\.json\.sig/);
  });

  test("refuses a release with no build for this architecture", async () => {
    const deps = stageDeps("0.0.7");
    await expect(stageRelease({ ...deps, arch: "x64" })).rejects.toThrow(
      /no CLI build for darwin-x64/,
    );
  });
});

describe("activation", () => {
  test("points current at the version through one relative symlink", async () => {
    fakeVersion("0.0.7");
    await activate("0.0.7", root);
    expect(readlinkSync(currentLink(root))).toEqual(join("versions", "0.0.7"));
  });

  test("refuses to activate a version that is not staged", async () => {
    await expect(activate("0.0.9", root)).rejects.toThrow(UpdateError);
  });

  test("records the previous version so rollback has a target", async () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    await activate("0.0.6", root);
    writeInstallState({ active: "0.0.6", previous: null }, root);

    const outcome = await activateWithHealthCheck("0.0.7", {
      root,
      healthCheck: async () => true,
    });
    expect(outcome).toEqual({ activated: true, version: "0.0.7", previous: "0.0.6" });
    expect(readInstallState(root)).toEqual({ active: "0.0.7", previous: "0.0.6" });
  });

  test("a new version that fails its health check is reverted automatically", async () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    writeInstallState({ active: "0.0.6", previous: null }, root);

    const outcome = await activateWithHealthCheck("0.0.7", {
      root,
      healthCheck: async () => false,
    });
    expect(outcome).toMatchObject({ activated: false, revertedTo: "0.0.6" });
    // `current` is back on the old version, and state was not advanced.
    expect(readlinkSync(currentLink(root))).toEqual(join("versions", "0.0.6"));
    expect(readInstallState(root)).toEqual({ active: "0.0.6", previous: null });
  });

  test("the failed version is retained on disk for diagnosis", async () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    writeInstallState({ active: "0.0.6", previous: null }, root);
    await activateWithHealthCheck("0.0.7", { root, healthCheck: async () => false });
    expect(isStaged("0.0.7", root)).toEqual(true);
  });

  test("a first install with nothing to revert to says so rather than unlinking", async () => {
    fakeVersion("0.0.7");
    const outcome = await activateWithHealthCheck("0.0.7", {
      root,
      healthCheck: async () => false,
    });
    expect(outcome).toMatchObject({ activated: false, revertedTo: null });
    expect(readlinkSync(currentLink(root))).toEqual(join("versions", "0.0.7"));
  });
});

describe("rollback", () => {
  test("reactivates the retained version without a network call", async () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    await activate("0.0.7", root);
    writeInstallState({ active: "0.0.7", previous: "0.0.6" }, root);

    const outcome = await rollback({ root, healthCheck: async () => true });
    expect(outcome).toMatchObject({ activated: true, version: "0.0.6" });
    expect(readlinkSync(currentLink(root))).toEqual(join("versions", "0.0.6"));
  });

  test("a rollback is itself reversible", async () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    writeInstallState({ active: "0.0.7", previous: "0.0.6" }, root);
    await rollback({ root, healthCheck: async () => true });
    expect(readInstallState(root)).toEqual({ active: "0.0.6", previous: "0.0.7" });
  });

  test("refuses when nothing is retained", async () => {
    writeInstallState({ active: "0.0.7", previous: null }, root);
    await expect(rollback({ root, healthCheck: async () => true }))
      .rejects.toThrow(/No retained previous version/);
  });

  test("refuses when the retained version was removed from disk", async () => {
    writeInstallState({ active: "0.0.7", previous: "0.0.6" }, root);
    rmSync(versionsDir(root), { recursive: true, force: true });
    await expect(rollback({ root, healthCheck: async () => true }))
      .rejects.toThrow(/missing from/);
  });

  test("a rollback target that fails its health check is reverted, not left active", async () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    await activate("0.0.7", root);
    writeInstallState({ active: "0.0.7", previous: "0.0.6" }, root);

    const outcome = await rollback({ root, healthCheck: async () => false });
    expect(outcome).toMatchObject({ activated: false, revertedTo: "0.0.7" });
    // `current` is back on the version that was running before the rollback
    // attempt, not stranded on the one that just failed its health check.
    expect(readlinkSync(currentLink(root))).toEqual(join("versions", "0.0.7"));
    expect(readInstallState(root)).toEqual({ active: "0.0.7", previous: "0.0.6" });
  });

  test("a rollback with nothing healthy to fall back to says so rather than stranding current", async () => {
    fakeVersion("0.0.6");
    writeInstallState({ active: null, previous: "0.0.6" }, root);

    const outcome = await rollback({ root, healthCheck: async () => false });
    expect(outcome).toMatchObject({ activated: false, revertedTo: null });
    expect(readlinkSync(currentLink(root))).toEqual(join("versions", "0.0.6"));
  });
});

describe("retention set for pruning old versions", () => {
  test("keeps the active version, the rollback target, and the next most recent", () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7", "0.0.8"].forEach((v) => fakeVersion(v));
    // active/previous are the two newest; the next most recent is 0.0.6.
    expect(versionsToPrune(root, "0.0.8", "0.0.7").sort()).toEqual(["0.0.4", "0.0.5"]);
  });

  test("never counts active or the rollback target against the budget, wherever they sort", () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7"].forEach((v) => fakeVersion(v));
    // active/previous are the two oldest; pruning must still spare both of them.
    expect(versionsToPrune(root, "0.0.4", "0.0.5")).toEqual(["0.0.6"]);
  });

  test("prunes nothing when three or fewer versions are staged", () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    expect(versionsToPrune(root, "0.0.7", "0.0.6")).toEqual([]);
  });

  test("is not confused by a directory that is not a version", () => {
    fakeVersion("0.0.6");
    fakeVersion("0.0.7");
    mkdirSync(join(versionsDir(root), "staging-leftover"), { recursive: true });
    expect(versionsToPrune(root, "0.0.7", "0.0.6")).toEqual([]);
  });
});

describe("pruneOldVersions", () => {
  test("removes exactly the versions outside the retention budget, and logs each one", async () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7"].forEach((v) => fakeVersion(v));
    const logs: string[] = [];

    const pruned = await pruneOldVersions("0.0.7", "0.0.6", { root, log: (m) => logs.push(m) });

    expect(pruned).toEqual(["0.0.4"]);
    expect(isStaged("0.0.4", root)).toEqual(false);
    expect(isStaged("0.0.5", root)).toEqual(true);
    expect(isStaged("0.0.6", root)).toEqual(true);
    expect(isStaged("0.0.7", root)).toEqual(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("0.0.4");
  });

  test("never removes the active version or the rollback target", async () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7", "0.0.8"].forEach((v) => fakeVersion(v));
    await pruneOldVersions("0.0.8", "0.0.4", { root, log: () => {} });
    expect(isStaged("0.0.8", root)).toEqual(true);
    expect(isStaged("0.0.4", root)).toEqual(true);
  });

  test("a removal failure is logged and swallowed, never thrown", async () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7"].forEach((v) => fakeVersion(v));
    const logs: string[] = [];
    const failing = versionDir("0.0.4", root);

    const pruned = await pruneOldVersions("0.0.7", "0.0.6", {
      root,
      log: (m) => logs.push(m),
      remove: async (dir) => {
        if (dir === failing) throw new Error("permission denied");
      },
    });

    expect(pruned).toEqual([]);
    expect(isStaged("0.0.4", root)).toEqual(true);
    expect(logs.some((m) => m.includes("0.0.4") && m.includes("permission denied"))).toEqual(true);
  });

  test("activating a new version prunes old ones, keeping active/previous/next", async () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7"].forEach((v) => fakeVersion(v));
    writeInstallState({ active: "0.0.6", previous: "0.0.5" }, root);

    const outcome = await activateWithHealthCheck("0.0.7", {
      root,
      healthCheck: async () => true,
      log: () => {},
    });

    expect(outcome).toMatchObject({ activated: true, version: "0.0.7", previous: "0.0.6" });
    expect(isStaged("0.0.7", root)).toEqual(true);
    expect(isStaged("0.0.6", root)).toEqual(true);
    expect(isStaged("0.0.5", root)).toEqual(true);
    expect(isStaged("0.0.4", root)).toEqual(false);
  });

  test("a successful rollback prunes old versions too", async () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7"].forEach((v) => fakeVersion(v));
    await activate("0.0.7", root);
    writeInstallState({ active: "0.0.7", previous: "0.0.6" }, root);

    const outcome = await rollback({ root, healthCheck: async () => true, log: () => {} });

    expect(outcome).toMatchObject({ activated: true, version: "0.0.6", previous: "0.0.7" });
    expect(isStaged("0.0.6", root)).toEqual(true);
    expect(isStaged("0.0.7", root)).toEqual(true);
    expect(isStaged("0.0.5", root)).toEqual(true);
    expect(isStaged("0.0.4", root)).toEqual(false);
  });

  test("a failed activation that reverts does not prune anything", async () => {
    ["0.0.4", "0.0.5", "0.0.6", "0.0.7"].forEach((v) => fakeVersion(v));
    writeInstallState({ active: "0.0.6", previous: "0.0.5" }, root);

    await activateWithHealthCheck("0.0.7", { root, healthCheck: async () => false, log: () => {} });

    // A failed activation never reaches the prune step at all.
    expect(isStaged("0.0.4", root)).toEqual(true);
  });
});
