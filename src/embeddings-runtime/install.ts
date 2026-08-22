import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  githubReleaseSource,
  type ReleaseSource,
} from "../update-service/source";
import {
  HIVE_ARCH,
  HIVE_RELEASE_PUBLIC_KEY,
  HIVE_VERSION,
} from "../shared/version";
import { EMBEDDINGS_RUNTIME_ASSET } from "./runtime";
import {
  artifactMatches,
  type HiveArch,
  selectArtifact,
  verifyManifest,
} from "../release/manifest";
import { errorMessage } from "../shared/error-message";

export type EmbeddingsInstallOutcome =
  { ok: true; detail: string } | { ok: false; reason: string };

export interface EmbeddingsProbeResult {
  model: string;
  dimensions: number;
}

export interface EmbeddingsReleaseInstallDeps {
  version: string;
  arch: HiveArch;
  publicKey: string | null;
  /** Resolve a release into verifiable bytes; injectable so tests never touch the network. Defaults to GitHub Releases. */
  source: (version: string) => Promise<ReleaseSource>;
  runtimeDir: string;
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
      `could not read the hive ${deps.version} release: ${errorMessage(error)}`,
    );
  }

  // The manifest is the pin, and it is verified before it is read — the same fail-closed posture as `hive update`: an embedded key with a missing or mismatching signature is a refusal, never a softening to unsigned.
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
      `could not download ${EMBEDDINGS_RUNTIME_ASSET}: ${errorMessage(error)}`,
    );
  }
  if (!artifactMatches(artifact, bytes)) {
    return fail(
      `refusing to install: downloaded ${EMBEDDINGS_RUNTIME_ASSET} does not ` +
        "match the SHA-256 in the signed release manifest",
    );
  }

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
    return fail(errorMessage(error));
  }
}

export function defaultReleaseInstallDeps(options: {
  runtimeDir: string;
  probe: (runtimeDir: string) => Promise<EmbeddingsProbeResult>;
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
