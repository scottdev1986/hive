#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import graphifyLock from "../../graphify.lock" with { type: "text" };

const value = (name: string): string => {
  const index = process.argv.indexOf(name);
  const result = index < 0 ? undefined : process.argv[index + 1];
  if (result === undefined) throw new Error(`${name} is required`);
  return result;
};

const out = value("--out");
const manifestPath = value("--manifest");
const hiveBuild = Number.parseInt(value("--build"), 10);
const sourceCommit = value("--source");
const baseUrl = process.argv.includes("--base-url")
  ? value("--base-url").replace(/\/$/, "")
  : null;
const pin = graphifyLock.match(/^graphifyy==(\S+?)\s*\\?$/m)?.[1];
if (pin === undefined) throw new Error("graphify.lock does not pin graphifyy");

const artifacts = (["arm64", "x64"] as const).flatMap((arch) => {
  const name = `graphify-${pin}-darwin-${arch}.tar.zst`;
  const path = `${out}/${name}`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return [];
  }
  return [
    {
      platform: "darwin" as const,
      arch,
      name,
      url: baseUrl === null ? pathToFileURL(path).href : `${baseUrl}/${name}`,
      size: statSync(path).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
});
if (artifacts.length === 0) throw new Error(`no Graphify artifacts in ${out}`);

const manifest = {
  schema: 1,
  graphifyVersion: pin,
  hiveBuild,
  consumerApi: 1,
  tag: `graphify-v${pin}-hive.${hiveBuild}`,
  sourceCommit,
  publishedAt: new Date().toISOString(),
  artifacts,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifestPath}`);
