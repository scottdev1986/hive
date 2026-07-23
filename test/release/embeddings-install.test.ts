/**
 * The no-checkout install path: download the pinned runtime from the running
 * binary's own release, verify it against the (signed) manifest, unpack into
 * a staging sibling, probe, and swap. Tests run a real Ed25519 keypair and a
 * real tar fixture against a fake ReleaseSource — no network, no model; the
 * probe is injected (its contract is "throws on any failure").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultReleaseInstallDeps,
  installEmbeddingsFromRelease,
  type EmbeddingsReleaseInstallDeps,
} from "../../src/release/embeddings-install";
import { EMBEDDINGS_RUNTIME_ASSET } from "../../src/release/embeddings-runtime";
import type { ReleaseManifest } from "../../src/release/manifest";
import type { ReleaseSource } from "../../src/update/source";
import { HIVE_VERSION } from "../../src/version";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const RELEASE_KEY = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (bytes: Uint8Array) => sign(null, bytes, privateKey).toString("base64"),
  };
})();

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

interface Fixture {
  root: string;
  runtimeDir: string;
  tarballBytes: Uint8Array;
  manifest: ReleaseManifest;
  manifestBytes: Uint8Array;
  signature: string;
}

/** A real tar.gz with the published layout (top-level embeddings-runtime/). */
async function makeFixture(version = "1.2.3"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "hive-emb-install-"));
  tempRoots.push(root);
  const staging = join(root, "payload", "embeddings-runtime");
  await mkdir(join(staging, "dist"), { recursive: true });
  await writeFile(join(staging, "dist", "entry.js"), "// bundled fastembed\n");
  await writeFile(
    join(staging, "INSTALL.json"),
    `${JSON.stringify({ fastembed: "9.9.9-fixture" })}\n`,
  );
  const tarballPath = join(root, EMBEDDINGS_RUNTIME_ASSET);
  const tar = Bun.spawn(
    ["tar", "-czf", tarballPath, "-C", join(root, "payload"), "embeddings-runtime"],
  );
  expect(await tar.exited).toBe(0);
  const tarballBytes = new Uint8Array(await Bun.file(tarballPath).arrayBuffer());

  const runtimeDir = join(root, "tools", "embeddings");
  const artifacts = (["arm64", "x64"] as const).map((arch) => ({
    name: EMBEDDINGS_RUNTIME_ASSET,
    kind: "embeddings" as const,
    platform: "darwin" as const,
    arch,
    size: tarballBytes.byteLength,
    sha256: sha256(tarballBytes),
    buildHash: sha256(tarballBytes),
  }));
  const manifest: ReleaseManifest = {
    schema: 1,
    version,
    tag: `v${version}`,
    channel: "stable",
    commit: "abc1234",
    publishedAt: "2026-07-23T00:00:00Z",
    securityCritical: false,
    wireProtocol: { min: 1, max: 1 },
    schemaEpoch: 1,
    artifacts,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  return {
    root,
    runtimeDir,
    tarballBytes,
    manifest,
    manifestBytes,
    signature: RELEASE_KEY.sign(manifestBytes),
  };
}

function depsFor(
  fixture: Fixture,
  overrides: Partial<EmbeddingsReleaseInstallDeps> = {},
): EmbeddingsReleaseInstallDeps {
  const downloads: string[] = [];
  return {
    version: fixture.manifest.version,
    arch: "arm64",
    publicKey: RELEASE_KEY.publicKey,
    source: async (version) => {
      const source: ReleaseSource = {
        manifest: fixture.manifest,
        manifestBytes: fixture.manifestBytes,
        signature: fixture.signature,
        download: async (assetName) => {
          downloads.push(assetName);
          return fixture.tarballBytes;
        },
      };
      return source;
    },
    runtimeDir: fixture.runtimeDir,
    probe: async () => ({ model: "bge-small-en-v1.5", dimensions: 384 }),
    ...overrides,
  };
}

describe("installEmbeddingsFromRelease", () => {
  test("downloads, verifies, unpacks, probes, and swaps into place", async () => {
    const fixture = await makeFixture();
    // A stale prior install: must be replaced wholesale, never layered onto.
    await mkdir(fixture.runtimeDir, { recursive: true });
    await writeFile(join(fixture.runtimeDir, "stale"), "old\n");
    const probedDirs: string[] = [];

    const outcome = await installEmbeddingsFromRelease(
      depsFor(fixture, {
        probe: async (dir) => {
          probedDirs.push(dir);
          return { model: "bge-small-en-v1.5", dimensions: 384 };
        },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.detail).toContain("hive 1.2.3");
      expect(outcome.detail).toContain("dimensions=384");
    }
    expect(await Bun.file(join(fixture.runtimeDir, "dist", "entry.js")).exists())
      .toBe(true);
    expect(await Bun.file(join(fixture.runtimeDir, "INSTALL.json")).exists())
      .toBe(true);
    expect(await Bun.file(join(fixture.runtimeDir, "stale")).exists()).toBe(false);
    // The probe ran against the staging sibling, not the live dir; the
    // staging dir is gone after the swap.
    expect(probedDirs).toHaveLength(1);
    expect(probedDirs[0]).not.toBe(fixture.runtimeDir);
    expect(probedDirs[0]!.startsWith(`${fixture.runtimeDir}.staging-`)).toBe(true);
    expect(await Bun.file(probedDirs[0]!).exists()).toBe(false);
  });

  test("a dev build has no release to pin to and is refused before any download", async () => {
    const fixture = await makeFixture();
    let sourced = false;
    const outcome = await installEmbeddingsFromRelease(
      depsFor(fixture, {
        version: "0.0.0-dev",
        source: async () => {
          sourced = true;
          throw new Error("must not be called");
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("not a release");
    expect(sourced).toBe(false);
  });

  test("a manifest signature that does not match is refused", async () => {
    const fixture = await makeFixture();
    const outcome = await installEmbeddingsFromRelease(
      depsFor(fixture, {
        source: async () => ({
          manifest: fixture.manifest,
          manifestBytes: fixture.manifestBytes,
          signature: RELEASE_KEY.sign(new TextEncoder().encode("other bytes")),
          download: async () => fixture.tarballBytes,
        }),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("refusing to install");
  });

  test("bytes that do not match the manifest SHA-256 are refused, install untouched", async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.runtimeDir, { recursive: true });
    await writeFile(join(fixture.runtimeDir, "kept"), "working\n");

    const outcome = await installEmbeddingsFromRelease(
      depsFor(fixture, {
        source: async () => ({
          manifest: fixture.manifest,
          manifestBytes: fixture.manifestBytes,
          signature: fixture.signature,
          download: async () => new TextEncoder().encode("tampered tarball"),
        }),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("SHA-256");
    expect(await Bun.file(join(fixture.runtimeDir, "kept")).text()).toBe("working\n");
  });

  test("a release without an embeddings artifact for this arch is an honest refusal", async () => {
    const fixture = await makeFixture();
    const outcome = await installEmbeddingsFromRelease(
      depsFor(fixture, {
        arch: "x64",
        source: async () => {
          const manifest: ReleaseManifest = {
            ...fixture.manifest,
            artifacts: fixture.manifest.artifacts.filter((a) => a.arch === "arm64"),
          };
          const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
          return {
            manifest,
            manifestBytes,
            signature: RELEASE_KEY.sign(manifestBytes),
            download: async () => fixture.tarballBytes,
          };
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("no embedding runtime for darwin-x64");
    }
  });

  test("a failed probe keeps the old install and cleans the staging dir", async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.runtimeDir, { recursive: true });
    await writeFile(join(fixture.runtimeDir, "kept"), "working\n");

    const outcome = await installEmbeddingsFromRelease(
      depsFor(fixture, {
        probe: async () => {
          throw new Error("embedding-runtime-broken: native lib unloadable");
        },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("embedding-runtime-broken");
    expect(await Bun.file(join(fixture.runtimeDir, "kept")).text()).toBe("working\n");
    const siblings = await readdir(join(fixture.root, "tools"));
    expect(siblings.filter((name) => name.includes("staging"))).toEqual([]);
  });
});

describe("defaultReleaseInstallDeps — the version pin", () => {
  const base = {
    runtimeDir: "/unused",
    probe: async () => ({ model: "bge-small-en-v1.5", dimensions: 384 }),
  };

  test("defaults to the running binary's own version", () => {
    expect(defaultReleaseInstallDeps(base).version).toBe(HIVE_VERSION);
  });

  test("an explicit version wins — hive update pins to the version it activated", () => {
    expect(defaultReleaseInstallDeps({ ...base, version: "9.9.9" }).version)
      .toBe("9.9.9");
  });
});
