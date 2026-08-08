#!/usr/bin/env bun
/** Sign a release manifest with the offline Ed25519 release key. `bun run scripts/signing/sign-manifest.ts dist/hive-release.json` Private key from `HIVE_RELEASE_PRIVATE_KEY` (base64 PKCS#8 DER from `openssl pkey -outform DER | base64`). Writes `<manifest>.sig` — base64 Ed25519 over the manifest's exact on-disk bytes (key order and whitespace are part of the signed surface). Only script the private key ever touches. Public half is embedded via `build.ts --public-key`; once embedded, `verifyManifest` is fail-closed — a stripped `.sig` is a refusal, not a downgrade. */
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

export function signManifest(
  manifestBytes: Uint8Array,
  privateKeyBase64: string,
): string {
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
