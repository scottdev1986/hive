import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  artifactMatches,
  parseReleaseManifest,
  selectArtifact,
  sha256,
  verifyManifest,
  type ReleaseManifest,
} from "./manifest";

const manifest: ReleaseManifest = {
  schema: 1,
  version: "0.0.7",
  tag: "v0.0.7",
  channel: "stable",
  commit: "abc1234",
  publishedAt: "2026-07-10T00:00:00Z",
  securityCritical: false,
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  artifacts: [
    {
      name: "hive-darwin-arm64",
      kind: "cli",
      platform: "darwin",
      arch: "arm64",
      size: 4,
      sha256: "a".repeat(64),
      buildHash: "hash",
    },
    {
      name: "hive-darwin-x64",
      kind: "cli",
      platform: "darwin",
      arch: "x64",
      size: 4,
      sha256: "b".repeat(64),
      buildHash: "hash",
    },
    {
      name: "HiveWorkspace.tar.gz",
      kind: "workspace",
      platform: "darwin",
      arch: "arm64",
      size: 9,
      sha256: "c".repeat(64),
      buildHash: "hash",
    },
  ],
};

/** An offline release key, exactly as the pipeline would hold one. */
function releaseKey(): { publicKey: string; signBytes: (bytes: Uint8Array) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signBytes: (bytes) => sign(null, bytes, privateKey).toString("base64"),
  };
}

describe("manifest parsing", () => {
  test("round-trips through JSON", () => {
    expect(parseReleaseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  test("rejects a manifest from a future schema", () => {
    expect(() => parseReleaseManifest({ ...manifest, schema: 2 })).toThrow();
  });

  test("rejects a malformed digest", () => {
    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], sha256: "nope" }],
      })
    ).toThrow();
  });
});

describe("artifact selection", () => {
  test("picks the CLI for this architecture", () => {
    expect(selectArtifact(manifest, "cli", "arm64")?.name).toEqual("hive-darwin-arm64");
    expect(selectArtifact(manifest, "cli", "x64")?.name).toEqual("hive-darwin-x64");
  });

  test("returns null when the release has no build for the architecture", () => {
    expect(selectArtifact(manifest, "workspace", "x64")).toEqual(null);
  });

  test("matches bytes only when both size and digest agree", () => {
    const bytes = new TextEncoder().encode("hive");
    const artifact = { ...manifest.artifacts[0]!, size: bytes.byteLength, sha256: sha256(bytes) };
    expect(artifactMatches(artifact, bytes)).toEqual(true);
    expect(artifactMatches({ ...artifact, size: 3 }, bytes)).toEqual(false);
    expect(artifactMatches(artifact, new TextEncoder().encode("hivf"))).toEqual(false);
  });
});

describe("manifest signature", () => {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));

  test("accepts a manifest signed by the embedded key", () => {
    const key = releaseKey();
    expect(verifyManifest(bytes, key.signBytes(bytes), key.publicKey))
      .toEqual({ verified: true, signed: true });
  });

  test("rejects a manifest signed by a different key", () => {
    const signer = releaseKey();
    const other = releaseKey();
    const trust = verifyManifest(bytes, signer.signBytes(bytes), other.publicKey);
    expect(trust).toMatchObject({ verified: false });
  });

  test("rejects a manifest whose bytes changed after signing", () => {
    const key = releaseKey();
    const signature = key.signBytes(bytes);
    const tampered = new TextEncoder().encode(
      JSON.stringify({ ...manifest, version: "9.9.9" }),
    );
    expect(verifyManifest(tampered, signature, key.publicKey))
      .toMatchObject({ verified: false });
  });

  test("fails closed when the signature is stripped from a signed build", () => {
    const key = releaseKey();
    expect(verifyManifest(bytes, null, key.publicKey)).toMatchObject({ verified: false });
  });

  test("a build with no embedded key accepts the manifest but says it is unsigned", () => {
    const trust = verifyManifest(bytes, null, null);
    expect(trust).toMatchObject({ verified: true, signed: false });
    if (trust.verified && !trust.signed) {
      expect(trust.warning).toContain("not signed");
    }
  });

  test("a garbage public key is a refusal, not a crash", () => {
    expect(verifyManifest(bytes, "AAAA", "not-a-key")).toMatchObject({ verified: false });
  });
});
