import { readFile } from "node:fs/promises";
import { z } from "zod";
import { verifyManifest } from "../release/manifest";
import {
  HIVE_RELEASE_PUBLIC_KEY,
  HIVE_UPDATE_REPO,
  HIVE_VERSION,
} from "../version";

export const GRAPHIFY_CHANNEL_TAG = "graphify-channel";
export const GRAPHIFY_MANIFEST_ASSET = "graphify-runtime.json";
export const GRAPHIFY_SIGNATURE_ASSET = `${GRAPHIFY_MANIFEST_ASSET}.sig`;
export const GRAPHIFY_CONSUMER_API = 1;

const GraphifyArtifactSchema = z.strictObject({
  platform: z.literal("darwin"),
  arch: z.enum(["arm64", "x64"]),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  url: z.url(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const GraphifyManifestSchema = z
  .strictObject({
    schema: z.literal(1),
    graphifyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    hiveBuild: z.number().int().positive(),
    consumerApi: z.number().int().positive(),
    tag: z.string().regex(/^graphify-v\d+\.\d+\.\d+-hive\.\d+$/),
    sourceCommit: z.string().min(1),
    publishedAt: z.iso.datetime({ offset: true }),
    artifacts: z.array(GraphifyArtifactSchema).min(1),
  })
  .superRefine((manifest, context) => {
    if (
      manifest.tag !==
      `graphify-v${manifest.graphifyVersion}-hive.${manifest.hiveBuild}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "tag must match the Graphify version and Hive build",
      });
    }
  });

export type GraphifyManifest = z.infer<typeof GraphifyManifestSchema>;
export type GraphifyArtifact = z.infer<typeof GraphifyArtifactSchema>;

export interface GraphifyRelease {
  readonly manifest: GraphifyManifest;
  readonly artifact: GraphifyArtifact;
  readonly signed: boolean;
  readonly local: boolean;
}

const ReleaseSchema = z.object({
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.url(),
    }),
  ),
});

function platformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch === "arm64" ? "arm64" : "x64"}`;
}

function selectArtifact(manifest: GraphifyManifest): GraphifyArtifact {
  const key = platformKey();
  const artifact = manifest.artifacts.find(
    (candidate) => `${candidate.platform}-${candidate.arch}` === key,
  );
  if (artifact === undefined) {
    throw new Error(`Graphify publishes no runtime for ${key}`);
  }
  return artifact;
}

async function responseBytes(
  url: string,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function parseGraphifyManifest(bytes: Uint8Array): GraphifyManifest {
  return GraphifyManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
}

async function localRelease(path: string): Promise<GraphifyRelease> {
  if (HIVE_VERSION !== "0.0.0" && HIVE_VERSION !== "0.0.0-dev") {
    throw new Error(
      "HIVE_GRAPHIFY_MANIFEST is accepted only by the 0.0.0 development build",
    );
  }
  const manifest = parseGraphifyManifest(new Uint8Array(await readFile(path)));
  return {
    manifest,
    artifact: selectArtifact(manifest),
    signed: false,
    local: true,
  };
}

export async function fetchGraphifyRelease(
  fetcher: typeof fetch = fetch,
  repo = HIVE_UPDATE_REPO,
): Promise<GraphifyRelease> {
  const local = process.env.HIVE_GRAPHIFY_MANIFEST;
  if (local !== undefined) return localRelease(local);

  const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${GRAPHIFY_CHANNEL_TAG}`;
  const response = await fetcher(releaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Graphify channel returned HTTP ${response.status}`);
  }
  const release = ReleaseSchema.parse(await response.json());
  const assetUrl = (name: string): string => {
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (asset === undefined) {
      throw new Error(`Graphify channel publishes no ${name}`);
    }
    return asset.browser_download_url;
  };
  const manifestBytes = await responseBytes(
    assetUrl(GRAPHIFY_MANIFEST_ASSET),
    fetcher,
  );
  const signature = new TextDecoder()
    .decode(await responseBytes(assetUrl(GRAPHIFY_SIGNATURE_ASSET), fetcher))
    .trim();
  const trust = verifyManifest(
    manifestBytes,
    signature,
    HIVE_RELEASE_PUBLIC_KEY,
  );
  if (!trust.verified) {
    throw new Error(`Graphify manifest is not trusted: ${trust.reason}`);
  }
  const manifest = parseGraphifyManifest(manifestBytes);
  for (const artifact of manifest.artifacts) {
    const expected = `https://github.com/${repo}/releases/download/${manifest.tag}/${artifact.name}`;
    if (artifact.url !== expected) {
      throw new Error(`Graphify artifact URL must be ${expected}`);
    }
  }
  if (manifest.consumerApi !== GRAPHIFY_CONSUMER_API) {
    throw new Error(
      `Graphify consumer API ${manifest.consumerApi} is incompatible with Hive API ${GRAPHIFY_CONSUMER_API}`,
    );
  }
  return {
    manifest,
    artifact: selectArtifact(manifest),
    signed: trust.signed,
    local: false,
  };
}
