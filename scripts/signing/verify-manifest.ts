#!/usr/bin/env bun
/**
 * Prove the release we are about to publish is one that `hive update` will
 * actually accept.
 *
 * `bun run scripts/signing/verify-manifest.ts dist/hive-release.json`
 *
 * This is the gate that catches a mismatched key pair, and it matters more than
 * it looks. Verification is fail-closed: a binary that embeds a public key
 * refuses any manifest that key cannot vouch for. So if `HIVE_RELEASE_PUBLIC_KEY`
 * and `HIVE_RELEASE_PRIVATE_KEY` ever disagree — a bad paste into a secret, a
 * half-finished rotation — the pipeline would happily sign, tag, and publish a
 * release that *every installed Hive on earth refuses to install*, including the
 * ones that would have carried the fix. The failure is silent at build time and
 * total at update time.
 *
 * So we check it here, before the tag exists, using the same `verifyManifest`
 * the client uses and the same public key the binary embedded. A mismatch fails
 * the release instead of burning a version number on an uninstallable one.
 */
import { readFileSync } from "node:fs";
import { verifyManifest, releaseKeys } from "../../src/release/manifest";

const manifestPath = process.argv[2];
if (manifestPath === undefined) {
  console.error("usage: verify-manifest.ts <manifest.json>");
  process.exit(2);
}

const publicKey = process.env.HIVE_RELEASE_PUBLIC_KEY?.trim();
if (publicKey === undefined || publicKey === "") {
  // Nothing was embedded, so the client will take the unsigned branch and there
  // is no signature to check. Not an error — that is the fork's path.
  console.log("no HIVE_RELEASE_PUBLIC_KEY embedded; nothing to verify");
  process.exit(0);
}

const manifestBytes = new Uint8Array(readFileSync(manifestPath));
let signature: string | null;
try {
  signature = readFileSync(`${manifestPath}.sig`, "utf8").trim();
} catch {
  signature = null;
}

const trust = verifyManifest(manifestBytes, signature, publicKey);

if (!trust.verified) {
  console.error(`::error::The release manifest does not verify against the embedded public key: ${trust.reason}`);
  console.error(
    "Every installed hive would REFUSE this release. Check that " +
      "HIVE_RELEASE_PRIVATE_KEY is the private half of HIVE_RELEASE_PUBLIC_KEY.",
  );
  process.exit(1);
}
if (!trust.signed) {
  console.error("::error::A public key is embedded but the manifest is unsigned; this release would be refused.");
  process.exit(1);
}

const count = releaseKeys(publicKey).length;
console.log(
  `manifest signature verifies against the embedded release key ` +
    `(${count} key${count === 1 ? "" : "s"} trusted by this build)`,
);
