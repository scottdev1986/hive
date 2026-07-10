#!/usr/bin/env bun
/**
 * Sign a release manifest with the offline Ed25519 release key.
 *
 * `bun run scripts/signing/sign-manifest.ts dist/hive-release.json`
 *
 * Reads the private key from `HIVE_RELEASE_PRIVATE_KEY` (base64 of the PKCS#8
 * DER, exactly what `openssl pkey -outform DER | base64` prints) and writes
 * `<manifest>.sig` — the base64 Ed25519 signature over the manifest's *exact*
 * bytes. Key order and whitespace are part of what is signed, so this signs the
 * file on disk rather than a re-serialization.
 *
 * This is the one small script the private key ever touches. The build never
 * sees it; the key lives offline and reaches CI only as a secret consumed here.
 * The public half is embedded in the binary via `build.ts --public-key`, and the
 * moment it is embedded `verifyManifest` becomes mandatory and fail-closed — a
 * stripped `.sig` is then a refusal, not a downgrade.
 */
import { createPrivateKey, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SIGNATURE_SUFFIX = ".sig";

function loadPrivateKey(base64: string) {
  return createPrivateKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

export function signManifest(manifestBytes: Uint8Array, privateKeyBase64: string): string {
  const key = loadPrivateKey(privateKeyBase64);
  return edSign(null, manifestBytes, key).toString("base64");
}

if (import.meta.main) {
  const manifestPath = process.argv[2];
  if (manifestPath === undefined) {
    console.error("usage: sign-manifest.ts <manifest.json>");
    process.exit(2);
  }
  const privateKey = process.env.HIVE_RELEASE_PRIVATE_KEY;
  if (privateKey === undefined || privateKey.trim() === "") {
    console.error("HIVE_RELEASE_PRIVATE_KEY is not set; nothing to sign with");
    process.exit(2);
  }
  const bytes = new Uint8Array(readFileSync(manifestPath));
  const signature = signManifest(bytes, privateKey.trim());
  writeFileSync(`${manifestPath}${SIGNATURE_SUFFIX}`, `${signature}\n`);
  console.log(`signed ${manifestPath} -> ${manifestPath}${SIGNATURE_SUFFIX}`);
}
