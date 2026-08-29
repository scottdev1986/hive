import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { z } from "zod";
import { errorMessage } from "../shared/error-message";

export const RELEASE_MANIFEST_SCHEMA = 1;

export const MANIFEST_ASSET = "hive-release.json";
export const SIGNATURE_ASSET = "hive-release.json.sig";

const AssetNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "artifact name must be a file name, not a path",
  );

const ReleaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const ArtifactSchema = z.strictObject({
  name: AssetNameSchema,
  kind: z.enum(["cli", "workspace", "sessiond", "embeddings"]),
  platform: z.literal("darwin"),
  arch: z.enum(["arm64", "x64"]),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  buildHash: z.string().min(1),
});

const ManifestSchema = z
  .strictObject({
    schema: z.literal(RELEASE_MANIFEST_SCHEMA),
    version: ReleaseVersionSchema,
    tag: z.string().min(1),
    channel: z.enum(["stable", "beta"]),
    commit: z.string().min(1),
    publishedAt: z.iso.datetime({ offset: true }),
    /** Overrides every notice rate limit. */
    securityCritical: z.boolean(),
    wireProtocol: z.strictObject({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
    }),
    schemaEpoch: z.number().int().nonnegative(),
    artifacts: z.array(ArtifactSchema).min(1),
  })
  .superRefine((manifest, context) => {
    if (manifest.tag !== `v${manifest.version}`) {
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "tag must name the manifest version",
      });
    }
    if (manifest.wireProtocol.min > manifest.wireProtocol.max) {
      context.addIssue({
        code: "custom",
        path: ["wireProtocol"],
        message: "wire protocol minimum must not exceed its maximum",
      });
    }
    const targets = new Set<string>();
    const assets = new Map<string, string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const target = `${artifact.kind}\0${artifact.platform}\0${artifact.arch}`;
      if (targets.has(target)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index],
          message: `duplicate artifact target ${artifact.kind}/${artifact.platform}-${artifact.arch}`,
        });
      }
      targets.add(target);
      const identity = [
        artifact.kind,
        artifact.platform,
        artifact.size,
        artifact.sha256,
        artifact.buildHash,
      ].join("\0");
      const existing = assets.get(artifact.name);
      if (existing !== undefined && existing !== identity) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "name"],
          message: `artifact name ${artifact.name} describes conflicting bytes`,
        });
      }
      assets.set(artifact.name, identity);
    }
  });

export type ReleaseArtifact = z.infer<typeof ArtifactSchema>;
export type ReleaseManifest = z.infer<typeof ManifestSchema>;

export function parseReleaseManifest<T>(value: T): ReleaseManifest {
  return ManifestSchema.parse(value);
}

export type HiveArch = "arm64" | "x64";

export function selectArtifact(
  manifest: ReleaseManifest,
  kind: ReleaseArtifact["kind"],
  arch: HiveArch,
): ReleaseArtifact | null {
  return (
    manifest.artifacts.find(
      (artifact) => artifact.kind === kind && artifact.arch === arch,
    ) ?? null
  );
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Constant-time-ish only in the sense that it compares digests, not secrets; a mismatching artifact is public information. The point is that we never execute bytes whose digest the manifest did not name. */
export function artifactMatches(
  artifact: ReleaseArtifact,
  bytes: Uint8Array,
): boolean {
  return (
    bytes.byteLength === artifact.size && sha256(bytes) === artifact.sha256
  );
}

export type ManifestTrust =
  | { verified: true; signed: true }
  | { verified: true; signed: false; warning: string }
  | { verified: false; reason: string };

export function releaseKeys(publicKeyBase64: string | null): string[] {
  if (publicKeyBase64 === null) return [];
  return publicKeyBase64
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
}

/** Verify the manifest against the embedded release key (or keys). `manifestBytes` must be the exact bytes fetched, not a re-serialization: JSON key order and whitespace are part of what was signed. The one branch worth naming: a build that has a key and gets no signature is a *refusal*, not a fallback to the unsigned path. Letting a missing `.sig` soften the check would hand an attacker the ability to turn verification off by deleting a file. */
export function verifyManifest(
  manifestBytes: Uint8Array,
  signatureBase64: string | null,
  publicKeyBase64: string | null,
): ManifestTrust {
  const keys = releaseKeys(publicKeyBase64);
  if (keys.length === 0) {
    return {
      verified: true,
      signed: false,
      warning:
        "this release is not signed by a Hive release key; its integrity rests on " +
        "GitHub's immutable release and TLS",
    };
  }
  if (signatureBase64 === null) {
    return { verified: false, reason: `manifest has no ${SIGNATURE_ASSET}` };
  }

  const signature = Buffer.from(signatureBase64, "base64");
  const failures: string[] = [];
  for (const candidate of keys) {
    try {
      const key = createPublicKey({
        key: Buffer.from(candidate, "base64"),
        format: "der",
        type: "spki",
      });
      if (verifySignature(null, manifestBytes, key, signature)) {
        return { verified: true, signed: true };
      }
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }

  if (failures.length === keys.length) {
    return {
      verified: false,
      reason: `manifest signature could not be checked: ${failures[0]}`,
    };
  }
  return {
    verified: false,
    reason:
      keys.length === 1
        ? "manifest signature does not match the embedded release key"
        : `manifest signature does not match any of the ${keys.length} embedded release keys`,
  };
}
