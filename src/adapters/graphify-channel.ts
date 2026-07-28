// Where Hive learns which Graphify build to install, and the only place that
// decides whether an answer from the network is allowed to be believed.
//
// This is a supply-chain boundary: what this module returns becomes a binary
// that runs on the user's machine. Everything here is therefore arranged so
// that a compromised or merely wrong GitHub response fails the install rather
// than redirecting it. The manifest is signed and verified before it is
// parsed, the download URLs are re-derived from the signed contents rather
// than trusted as written, and the schemas are strict so an unrecognised field
// is a rejection instead of something silently ignored.
//
// graphify.ts is the consumer: it takes the artifact named here and unpacks it
// only after the size and hash match.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { verifyManifest } from "../release/manifest";
import {
  HIVE_RELEASE_PUBLIC_KEY,
  HIVE_UPDATE_REPO,
  HIVE_VERSION,
} from "../version";

export const GRAPHIFY_CHANNEL_TAG = "graphify-channel";
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
  body: z.string(),
});

const ChannelSchema = z.strictObject({
  manifest: z.string(),
  signature: z.string().min(1),
});

/** Graphify publishes for two Macs. Anything that is not arm64 is treated as
 * x64 — Rosetta runs the x64 build, so an unexpected arch is better served a
 * binary that works than told there is nothing for it. */
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

export function parseGraphifyManifest(bytes: Uint8Array): GraphifyManifest {
  return GraphifyManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
}

/**
 * A manifest read straight off disk, for developing against an unpublished
 * Graphify build.
 *
 * This path skips signature verification entirely, which is why the version
 * gate is not a courtesy check: in a shipped build an environment variable
 * that turns off signature checking is an attack, not a feature. Refusing
 * outside 0.0.0 keeps it from being one. `signed: false` then travels with the
 * result so nothing downstream can mistake this for a channel install.
 */
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

/**
 * The Graphify build this Hive should install, having proved it is the one
 * Hive published.
 *
 * The release body carries the manifest as text alongside its signature, and
 * the signature covers those exact bytes — so verification happens on the raw
 * text and the parse happens afterwards, on bytes already proven. Parsing
 * first and verifying a re-serialised copy would be checking a signature
 * against something other than what arrived.
 */
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
  const channel = ChannelSchema.parse(JSON.parse(release.body));
  const manifestBytes = new TextEncoder().encode(channel.manifest);
  const trust = verifyManifest(
    manifestBytes,
    channel.signature,
    HIVE_RELEASE_PUBLIC_KEY,
  );
  if (!trust.verified) {
    throw new Error(`Graphify manifest is not trusted: ${trust.reason}`);
  }
  const manifest = parseGraphifyManifest(manifestBytes);
  // A signature proves who wrote the manifest, not that what they wrote points
  // somewhere reasonable. Each URL is rebuilt from the release tag and the
  // artifact name and required to match, so a download can only ever come from
  // this repository's own release assets — never from a host a manifest names.
  for (const artifact of manifest.artifacts) {
    const expected = `https://github.com/${repo}/releases/download/${manifest.tag}/${artifact.name}`;
    if (artifact.url !== expected) {
      throw new Error(`Graphify artifact URL must be ${expected}`);
    }
  }
  // Graphify's output shape is a contract with graphify.ts, and a newer channel
  // may have changed it. Refuse rather than install a build this Hive would
  // read wrong.
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
