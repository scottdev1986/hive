/**
 * Where release bytes come from.
 *
 * GitHub Releases hold immutable bytes; a small signed channel document on a
 * CDN should hold mutable channel and rollout policy. The channel endpoint does
 * not exist yet, so this reads `releases/latest` and its manifest asset, and
 * `research/distribution-auto-update.md` records the deviation. The interface is
 * the seam: swapping in a channel document changes this file and nothing else.
 */
import { z } from "zod";
import {
  MANIFEST_ASSET,
  SIGNATURE_ASSET,
  parseReleaseManifest,
  type ReleaseManifest,
} from "../release/manifest";
import { HIVE_UPDATE_REPO } from "../version";

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const METADATA_TIMEOUT_MS = 10_000;

const AssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string(),
});
const ReleaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(AssetSchema),
});

export interface ReleaseSource {
  readonly manifest: ReleaseManifest;
  /** Exact bytes fetched — key order and whitespace are part of the signature. */
  readonly manifestBytes: Uint8Array;
  readonly signature: string | null;
  readonly download: (assetName: string) => Promise<Uint8Array>;
}

async function bytes(url: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const response = await fetcher(url, {
    headers: { Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Resolve a release (latest, or an exact `0.0.4`) into verifiable bytes. */
export async function githubReleaseSource(
  version: string | "latest",
  repo = HIVE_UPDATE_REPO,
  fetcher: typeof fetch = fetch,
): Promise<ReleaseSource> {
  const path = version === "latest"
    ? `releases/latest`
    : `releases/tags/v${version}`;
  const response = await fetcher(`https://api.github.com/repos/${repo}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      version === "latest"
        ? `no published Hive release (GitHub returned ${response.status})`
        : `hive ${version} has no published release (GitHub returned ${response.status})`,
    );
  }
  const release = ReleaseSchema.parse(await response.json());
  const assetUrl = (name: string): string | null =>
    release.assets.find((asset) => asset.name === name)?.browser_download_url ?? null;

  const manifestUrl = assetUrl(MANIFEST_ASSET);
  if (manifestUrl === null) {
    throw new Error(`release ${release.tag_name} publishes no ${MANIFEST_ASSET}`);
  }
  const manifestBytes = await bytes(manifestUrl, fetcher);
  const manifest = parseReleaseManifest(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  );

  const signatureUrl = assetUrl(SIGNATURE_ASSET);
  const signature = signatureUrl === null
    ? null
    : new TextDecoder().decode(await bytes(signatureUrl, fetcher)).trim();

  return {
    manifest,
    manifestBytes,
    signature,
    download: async (assetName: string) => {
      const url = assetUrl(assetName);
      if (url === null) {
        throw new Error(`release ${release.tag_name} publishes no ${assetName}`);
      }
      return bytes(url, fetcher);
    },
  };
}
