#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import {
  parseReleaseManifest,
  releaseKeys,
  verifyManifest,
} from "../../src/release/manifest";

const manifestPath = process.argv[2];
if (manifestPath === undefined) {
  console.error("usage: verify-manifest.ts <manifest.json>");
  process.exit(2);
}

const manifestBytes = new Uint8Array(readFileSync(manifestPath));
try {
  parseReleaseManifest(JSON.parse(Buffer.from(manifestBytes).toString("utf8")));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::invalid release manifest: ${message}`);
  process.exit(1);
}

const publicKey = process.env.HIVE_RELEASE_PUBLIC_KEY?.trim();
if (publicKey === undefined || publicKey === "") {
  console.log("no HIVE_RELEASE_PUBLIC_KEY embedded; nothing to verify");
  process.exit(0);
}

let signature: string | null;
try {
  signature = readFileSync(`${manifestPath}.sig`, "utf8").trim();
} catch {
  signature = null;
}

const trust = verifyManifest(manifestBytes, signature, publicKey);

if (!trust.verified) {
  console.error(
    `::error::The release manifest does not verify against the embedded public key: ${trust.reason}`,
  );
  console.error(
    "Every installed hive would REFUSE this release. Check that " +
      "HIVE_RELEASE_PRIVATE_KEY is the private half of HIVE_RELEASE_PUBLIC_KEY.",
  );
  process.exit(1);
}
if (!trust.signed) {
  console.error(
    "::error::A public key is embedded but the manifest is unsigned; this release would be refused.",
  );
  process.exit(1);
}

const count = releaseKeys(publicKey).length;
console.log(
  `manifest signature verifies against the embedded release key ` +
    `(${count} key${count === 1 ? "" : "s"} trusted by this build)`,
);
