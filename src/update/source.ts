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
import type { ProgressCallback } from "./progress";
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
  readonly download: (
    assetName: string,
    onProgress?: ProgressCallback,
  ) => Promise<Uint8Array>;
}

/**
 * Read a response body chunk by chunk rather than buffering it whole.
 *
 * `response.arrayBuffer()` — what this used to be — cannot report progress even
 * in principle: it resolves once, at the end. Streaming is what makes a bar
 * possible at all, and it is also what lets us notice a truncated transfer at
 * the moment the body ends rather than after the SHA-256 of a short file fails
 * to explain itself.
 *
 * `Content-Length` is the server's claim about the body, not the manifest's.
 * We report it as-is (null when absent) and let the caller reconcile it with the
 * signed size; conflating the two here would hide the disagreement that matters.
 */
async function bytes(
  url: string,
  fetcher: typeof fetch,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    headers: { Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);

  const header = response.headers.get("content-length");
  const declared = header === null ? null : Number.parseInt(header, 10);
  const total = declared !== null && Number.isSafeInteger(declared) && declared >= 0
    ? declared
    : null;

  if (response.body === null) {
    // No stream to read (a mocked or bodiless response). Fall back rather than
    // fail: the digest check downstream is what actually guards the bytes.
    const buffered = new Uint8Array(await response.arrayBuffer());
    onProgress?.(buffered.byteLength, total ?? buffered.byteLength);
    return buffered;
  }

  const chunks: Uint8Array[] = [];
  let read = 0;
  onProgress?.(0, total);
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    read += chunk.byteLength;
    onProgress?.(read, total);
  }

  if (total !== null && read !== total) {
    throw new Error(
      `${url} sent ${read} bytes but declared ${total}; the download was truncated`,
    );
  }

  const body = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
    download: async (assetName: string, onProgress?: ProgressCallback) => {
      const url = assetUrl(assetName);
      if (url === null) {
        throw new Error(`release ${release.tag_name} publishes no ${assetName}`);
      }
      return bytes(url, fetcher, onProgress);
    },
  };
}
