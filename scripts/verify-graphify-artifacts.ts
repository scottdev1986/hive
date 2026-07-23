#!/usr/bin/env bun
import {
  GRAPHIFY_ARTIFACTS,
  graphifyArtifactUrl,
} from "../src/adapters/graphify-artifacts";
import { graphifyPin } from "../src/adapters/graphify";

const REQUIRED_PLATFORMS = ["darwin-arm64", "darwin-x64"] as const;
const pin = graphifyPin();

for (const platform of REQUIRED_PLATFORMS) {
  const artifact = GRAPHIFY_ARTIFACTS[platform];
  if (artifact === null || artifact === undefined) {
    throw new Error(`Graphify artifact is missing for ${platform}`);
  }
  if (!artifact.tag.includes(`graphify-v${pin}-`) || !artifact.asset.includes(pin)) {
    throw new Error(
      `${platform} Graphify artifact does not match graphifyy==${pin}`,
    );
  }
  const url = graphifyArtifactUrl(artifact);
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Graphify artifact is unavailable for ${platform}: HTTP ${response.status} ${url}`,
    );
  }
  console.log(`${platform}: ${artifact.asset}`);
}
