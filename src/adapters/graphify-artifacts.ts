/**
 * The graphify bundle registry: which Hive-built artifact this Hive binary
 * trusts, per platform (docs/architecture/graphify-bundling.md).
 *
 * Hive ships graphify as a frozen, self-contained bundle it built itself — no
 * uv, no Python, no PyPI on the user's machine. The bundle is published as a
 * per-platform tar.zst asset on a Hive-owned release tag, and this module is
 * the trust anchor: `hive graphify enable` downloads the one matching asset
 * and refuses to unpack bytes whose sha256 does not match the constant here.
 *
 * A bump PR touches exactly this file plus `graphify.lock`: the pipeline
 * (scripts/graphify/build.sh, run by .github/workflows/graphify-artifacts.yml)
 * freezes the lock into per-platform bundles, uploads them to the release
 * tag, and the CI-built sha256s land here. `null` means no artifact is
 * published for that platform in this build — enable reports it in one
 * honest line and nothing degrades below the integration doc's floor.
 */
import { HIVE_UPDATE_REPO } from "../version";

export interface GraphifyArtifact {
  /** The Hive-owned release tag the asset lives under, e.g. `graphify-v0.9.12-hive.1`. */
  tag: string;
  /** Asset file name, e.g. `graphify-0.9.12-darwin-arm64.tar.zst`. */
  asset: string;
  /** sha256 (hex) of the exact published bytes, from the CI build that uploaded them. */
  sha256: string;
}

/** Platforms follow Hive's own release slices (src/release/build.ts). */
export const GRAPHIFY_ARTIFACTS: Record<string, GraphifyArtifact | null> = {
  "darwin-arm64": {
    tag: "graphify-v0.9.12-hive.1",
    asset: "graphify-0.9.12-darwin-arm64.tar.zst",
    sha256: "d629ae7732be0452ea0f7774be310f40ed0bfa1f1f502e22494a03f1a1c1e763",
  },
  "darwin-x64": {
    tag: "graphify-v0.9.12-hive.1",
    asset: "graphify-0.9.12-darwin-x64.tar.zst",
    sha256: "c2abc5762a5aa2983c5bb957cdaf051be0f1aa55e7d2e074eeceeae999fb107c",
  },
};

export function graphifyPlatformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch === "arm64" ? "arm64" : "x64"}`;
}

export function graphifyArtifact(
  platformKey: string = graphifyPlatformKey(),
): GraphifyArtifact | null {
  return GRAPHIFY_ARTIFACTS[platformKey] ?? null;
}

export function graphifyArtifactUrl(artifact: GraphifyArtifact): string {
  return `https://github.com/${HIVE_UPDATE_REPO}/releases/download/${artifact.tag}/${artifact.asset}`;
}
