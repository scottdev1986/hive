/**
 * The release manifest: the one document `hive update` trusts.
 *
 * Two independent signatures protect a release, and neither substitutes for the
 * other. Apple's Developer ID signature authenticates the executable to macOS.
 * The Ed25519 signature over this manifest authenticates *update policy* to
 * Hive: which version is current, which bytes are it, whether it is a security
 * release. A notarized binary served from the wrong manifest is still the wrong
 * update.
 *
 * Until Scott generates the offline release key, `HIVE_RELEASE_PUBLIC_KEY` is
 * absent and the trust anchor is GitHub's immutable release plus TLS plus the
 * SHA-256 in this manifest. That is weaker, and `hive update` says so out loud
 * rather than implying a signature it never checked. The moment a key is
 * embedded, `verifyManifest` becomes mandatory and fail-closed with no other
 * code change — which is why the signature field exists before the key does.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";

export const RELEASE_MANIFEST_SCHEMA = 1;

/** The asset name the pipeline publishes the manifest under. */
export const MANIFEST_ASSET = "hive-release.json";
export const SIGNATURE_ASSET = "hive-release.json.sig";

const ArtifactSchema = z.object({
  /** Release asset name, e.g. `hive-darwin-arm64`. */
  name: z.string().min(1),
  kind: z.enum(["cli", "workspace"]),
  platform: z.literal("darwin"),
  arch: z.enum(["arm64", "x64"]),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Content address of the compiled artifact; the daemon handshake's value. */
  buildHash: z.string().min(1),
});

const ManifestSchema = z.object({
  schema: z.literal(RELEASE_MANIFEST_SCHEMA),
  version: z.string().min(1),
  tag: z.string().min(1),
  channel: z.enum(["stable", "beta"]),
  commit: z.string().min(1),
  publishedAt: z.string().min(1),
  /** Overrides every notice rate limit. See docs/versioning-and-release.md. */
  securityCritical: z.boolean(),
  wireProtocol: z.object({ min: z.number().int(), max: z.number().int() }),
  schemaEpoch: z.number().int(),
  artifacts: z.array(ArtifactSchema).min(1),
});

export type ReleaseArtifact = z.infer<typeof ArtifactSchema>;
export type ReleaseManifest = z.infer<typeof ManifestSchema>;

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  return ManifestSchema.parse(value);
}

/** Node's `arch` for a Mach-O slice; `x64` in Node, `x86_64` to Apple's tools. */
export type HiveArch = "arm64" | "x64";

export function selectArtifact(
  manifest: ReleaseManifest,
  kind: ReleaseArtifact["kind"],
  arch: HiveArch,
): ReleaseArtifact | null {
  return manifest.artifacts.find(
    (artifact) => artifact.kind === kind && artifact.arch === arch,
  ) ?? null;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Constant-time-ish only in the sense that it compares digests, not secrets;
 * a mismatching artifact is public information. The point is that we never
 * execute bytes whose digest the manifest did not name.
 */
export function artifactMatches(artifact: ReleaseArtifact, bytes: Uint8Array): boolean {
  return bytes.byteLength === artifact.size && sha256(bytes) === artifact.sha256;
}

export type ManifestTrust =
  | { verified: true; signed: true }
  /** No key embedded in this build: GitHub + TLS + SHA-256 is the whole anchor. */
  | { verified: true; signed: false; warning: string }
  | { verified: false; reason: string };

/**
 * Verify the manifest against the embedded release key.
 *
 * `manifestBytes` must be the exact bytes fetched, not a re-serialization: JSON
 * key order and whitespace are part of what was signed.
 */
export function verifyManifest(
  manifestBytes: Uint8Array,
  signatureBase64: string | null,
  publicKeyBase64: string | null,
): ManifestTrust {
  if (publicKeyBase64 === null) {
    return {
      verified: true,
      signed: false,
      warning:
        "this release is not signed by a Hive release key; its integrity rests on " +
        "GitHub's immutable release and TLS",
    };
  }
  if (signatureBase64 === null) {
    // Fail closed. A build that knows the key must never accept an unsigned
    // manifest, or an attacker strips the signature to downgrade the check.
    return { verified: false, reason: `manifest has no ${SIGNATURE_ASSET}` };
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const ok = verifySignature(
      null,
      manifestBytes,
      key,
      Buffer.from(signatureBase64, "base64"),
    );
    return ok ? { verified: true, signed: true } : {
      verified: false,
      reason: "manifest signature does not match the embedded release key",
    };
  } catch (error) {
    return {
      verified: false,
      reason: `manifest signature could not be checked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
