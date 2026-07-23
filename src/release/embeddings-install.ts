/**
 * Install the embedding runtime from Hive's own release — the no-checkout path.
 *
 * The pin is the running binary's own version: a released `hive` downloads the
 * `embeddings-runtime.tar.gz` asset from the release tag `v<HIVE_VERSION>`,
 * i.e. the exact build the binary itself was cut from. There is no separate
 * embedded sha256 constant (graphify's scheme) because the release manifest is
 * the pin: the artifact's SHA-256 and size come from `hive-release.json`,
 * which is Ed25519-verified against the release key embedded in this binary
 * before any byte is trusted — the same manifest verification posture
 * `hive update` enforces. A build with no embedded key (a source checkout)
 * cannot take this path at all: it has no release version to pin to, and says
 * so instead of guessing.
 *
 * Staging is all-or-nothing, like the updater's: the tarball is unpacked and
 * probe-verified in a sibling staging directory, and only a passing probe
 * swaps it into place with one rename — a failed download, hash mismatch, or
 * broken bundle never disturbs a working install.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactMatches,
  selectArtifact,
  verifyManifest,
  type HiveArch,
} from "./manifest";
import { EMBEDDINGS_RUNTIME_ASSET } from "./embeddings-runtime";
import { githubReleaseSource, type ReleaseSource } from "../update/source";
import { HIVE_ARCH, HIVE_RELEASE_PUBLIC_KEY, HIVE_VERSION } from "../version";

export type EmbeddingsInstallOutcome =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

export interface EmbeddingsProbeResult {
  model: string;
  dimensions: number;
}

export interface EmbeddingsReleaseInstallDeps {
  /** The running binary's version — the pin. Must be a real release semver. */
  version: string;
  arch: HiveArch;
  /** The embedded release key(s), exactly as `hive update` uses them. */
  publicKey: string | null;
  /** Resolve a release into verifiable bytes; injectable so tests never touch
   * the network. Defaults to GitHub Releases. */
  source: (version: string) => Promise<ReleaseSource>;
  /** Where the runtime lands (and where the staging sibling is created). */
  runtimeDir: string;
  /** Load the staged bundle and embed a probe string; throws on any failure.
   * Install is only "done" when this passes. */
  probe: (runtimeDir: string) => Promise<EmbeddingsProbeResult>;
}

const RELEASE_SEMVER = /^\d+\.\d+\.\d+$/;

async function untar(tarball: string, into: string): Promise<void> {
  const proc = Bun.spawn(
    ["/usr/bin/tar", "-xzf", tarball, "-C", into, "--strip-components", "1"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`could not unpack the runtime tarball: ${stderr.trim()}`);
  }
}

export async function installEmbeddingsFromRelease(
  deps: EmbeddingsReleaseInstallDeps,
): Promise<EmbeddingsInstallOutcome> {
  const fail = (reason: string): EmbeddingsInstallOutcome => ({
    ok: false,
    reason,
  });

  if (!RELEASE_SEMVER.test(deps.version)) {
    return fail(
      `this Hive build reports version ${deps.version}, not a release — ` +
        "there is no pinned release to download the runtime from " +
        "(install from a checkout instead)",
    );
  }

  let source: ReleaseSource;
  try {
    source = await deps.source(deps.version);
  } catch (error) {
    return fail(
      `could not read the hive ${deps.version} release: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The manifest is the pin, and it is verified before it is read — the same
  // fail-closed posture as `hive update`: an embedded key with a missing or
  // mismatching signature is a refusal, never a softening to unsigned.
  const trust = verifyManifest(
    source.manifestBytes,
    source.signature,
    deps.publicKey,
  );
  if (!trust.verified) {
    return fail(`refusing to install: ${trust.reason}`);
  }
  const unsignedWarning = trust.signed ? null : trust.warning;

  const artifact = selectArtifact(source.manifest, "embeddings", deps.arch);
  if (artifact === null) {
    return fail(
      `release ${source.manifest.version} publishes no embedding runtime ` +
        `for darwin-${deps.arch}`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await source.download(EMBEDDINGS_RUNTIME_ASSET);
  } catch (error) {
    return fail(
      `could not download ${EMBEDDINGS_RUNTIME_ASSET}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!artifactMatches(artifact, bytes)) {
    return fail(
      `refusing to install: downloaded ${EMBEDDINGS_RUNTIME_ASSET} does not ` +
        "match the SHA-256 in the signed release manifest",
    );
  }

  // Stage, unpack, and probe beside the live install; the swap is one rename.
  const staging = `${deps.runtimeDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const tarball = join(staging, EMBEDDINGS_RUNTIME_ASSET);
    await writeFile(tarball, bytes);
    await untar(tarball, staging);
    await rm(tarball, { force: true });
    const probe = await deps.probe(staging);
    await rm(deps.runtimeDir, { recursive: true, force: true });
    await rename(staging, deps.runtimeDir);
    return {
      ok: true,
      detail:
        `embedding runtime from hive ${source.manifest.version} installed ` +
        "(sha256-verified against the release manifest) and probe-verified " +
        `(${probe.model}, dimensions=${probe.dimensions})` +
        (unsignedWarning === null ? "" : ` — ${unsignedWarning}`),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    return fail(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** The production dep set: this binary's version, key, and arch. `hive update`
 * passes an explicit `version` — the one it just activated — so the runtime is
 * pinned to the new binary, not the old one still executing the update. */
export function defaultReleaseInstallDeps(options: {
  runtimeDir: string;
  probe: (runtimeDir: string) => Promise<EmbeddingsProbeResult>;
  /** Defaults to this binary's own version (the `hive init` /
   * `hive embeddings install` pin). */
  version?: string;
}): EmbeddingsReleaseInstallDeps {
  return {
    version: options.version ?? HIVE_VERSION,
    arch: HIVE_ARCH === "arm64" ? "arm64" : "x64",
    publicKey: HIVE_RELEASE_PUBLIC_KEY,
    source: (version) => githubReleaseSource(version),
    runtimeDir: options.runtimeDir,
    probe: options.probe,
  };
}
