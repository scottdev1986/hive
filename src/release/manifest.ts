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
 * The offline Ed25519 key exists and every release since 0.0.6 is signed with
 * it: the public half is inlined into each binary at build time, the private
 * half lives only as a CI secret and touches only `scripts/signing/sign-manifest.ts`.
 * Verification is therefore mandatory and fail-closed — a build that knows the
 * key refuses a manifest that is unsigned, altered, or signed by anything else.
 * A stripped `.sig` is a refusal, not a downgrade, because the alternative is an
 * attacker choosing our verification policy for us.
 *
 * A build with *no* key embedded (a source checkout, or a release from before
 * 0.0.6) still takes the unsigned branch and says so out loud rather than
 * implying a signature it never checked. That branch must never be reachable
 * from a current release, and `hive update status` names which one you are on.
 *
 * `HIVE_RELEASE_PUBLIC_KEY` is a *list*, comma-separated, and that is what makes
 * rotation possible without a flag day: ship a release trusting {old, new},
 * wait for it to propagate, then sign with new and drop old. Verification
 * accepts a signature from any listed key, so no single release has to be the
 * one where every installation either updates or bricks. It buys nothing against
 * a *compromised* key — an attacker holding the old private half can still sign
 * for binaries that still list it, and the only answer to that is an
 * out-of-band reinstall. See docs/release/versioning-and-release.md.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";

export const RELEASE_MANIFEST_SCHEMA = 1;

/** The asset name the pipeline publishes the manifest under. */
export const MANIFEST_ASSET = "hive-release.json";
export const SIGNATURE_ASSET = "hive-release.json.sig";

const AssetNameSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "artifact name must be a file name, not a path",
);

const ReleaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const ArtifactSchema = z.strictObject({
  /** Release asset name, e.g. `hive-darwin-arm64`. */
  name: AssetNameSchema,
  kind: z.enum(["cli", "workspace", "sessiond"]),
  platform: z.literal("darwin"),
  arch: z.enum(["arm64", "x64"]),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Content address of the compiled artifact; the daemon handshake's value. */
  buildHash: z.string().min(1),
});

const ManifestSchema = z.strictObject({
  schema: z.literal(RELEASE_MANIFEST_SCHEMA),
  version: ReleaseVersionSchema,
  tag: z.string().min(1),
  channel: z.enum(["stable", "beta"]),
  commit: z.string().min(1),
  publishedAt: z.iso.datetime({ offset: true }),
  /** Overrides every notice rate limit. See docs/release/versioning-and-release.md. */
  securityCritical: z.boolean(),
  wireProtocol: z.strictObject({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
  schemaEpoch: z.number().int().nonnegative(),
  artifacts: z.array(ArtifactSchema).min(1),
}).superRefine((manifest, context) => {
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

/** Split the comma-separated key list; blanks and stray whitespace are ignored. */
export function releaseKeys(publicKeyBase64: string | null): string[] {
  if (publicKeyBase64 === null) return [];
  return publicKeyBase64
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
}

/**
 * Verify the manifest against the embedded release key (or keys).
 *
 * `manifestBytes` must be the exact bytes fetched, not a re-serialization: JSON
 * key order and whitespace are part of what was signed.
 *
 * The one branch worth naming: a build that has a key and gets no signature is a
 * *refusal*, not a fallback to the unsigned path. Letting a missing `.sig` soften
 * the check would hand an attacker the ability to turn verification off by
 * deleting a file.
 */
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
      // Any listed key may vouch for the manifest. That is the whole rotation
      // mechanism: a release that trusts {old, new} bridges the gap between the
      // release that introduces a key and the release that starts signing with it.
      if (verifySignature(null, manifestBytes, key, signature)) {
        return { verified: true, signed: true };
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Every embedded key was unusable — a malformed key list is a broken build,
  // and saying "signature does not match" would send the reader hunting the
  // wrong bug.
  if (failures.length === keys.length) {
    return {
      verified: false,
      reason: `manifest signature could not be checked: ${failures[0]}`,
    };
  }
  return {
    verified: false,
    reason: keys.length === 1
      ? "manifest signature does not match the embedded release key"
      : `manifest signature does not match any of the ${keys.length} embedded release keys`,
  };
}
