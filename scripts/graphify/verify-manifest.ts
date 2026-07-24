#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parseGraphifyManifest } from "../../src/adapters/graphify-channel";
import { verifyManifest } from "../../src/release/manifest";

const path = process.argv[2];
if (path === undefined) throw new Error("manifest path is required");
const bytes = new Uint8Array(readFileSync(path));
parseGraphifyManifest(bytes);

const publicKey = process.env.HIVE_RELEASE_PUBLIC_KEY?.trim();
if (publicKey === undefined || publicKey === "") {
  throw new Error("HIVE_RELEASE_PUBLIC_KEY is required");
}
const signature = readFileSync(`${path}.sig`, "utf8").trim();
const trust = verifyManifest(bytes, signature, publicKey);
if (!trust.verified || !trust.signed) {
  throw new Error(
    trust.verified ? "Graphify manifest is unsigned" : trust.reason,
  );
}
console.log("Graphify manifest signature verified");
