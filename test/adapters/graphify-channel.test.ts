import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchGraphifyRelease,
  GRAPHIFY_MANIFEST_ASSET,
  GRAPHIFY_SIGNATURE_ASSET,
} from "../../src/adapters/graphify-channel";

const originalOverride = process.env.HIVE_GRAPHIFY_MANIFEST;

afterEach(() => {
  if (originalOverride === undefined) delete process.env.HIVE_GRAPHIFY_MANIFEST;
  else process.env.HIVE_GRAPHIFY_MANIFEST = originalOverride;
});

function manifest(url = "https://example.test/graphify.tar.zst") {
  return {
    schema: 1,
    graphifyVersion: "0.9.25",
    hiveBuild: 2,
    consumerApi: 1,
    tag: "graphify-v0.9.25-hive.2",
    sourceCommit: "abc123",
    publishedAt: "2026-07-24T00:00:00Z",
    artifacts: [
      {
        platform: "darwin",
        arch: process.arch === "arm64" ? "arm64" : "x64",
        name: "graphify.tar.zst",
        url,
        size: 10,
        sha256: "a".repeat(64),
      },
    ],
  };
}

describe("Graphify runtime channel", () => {
  test("resolves the platform artifact from the published channel manifest", async () => {
    const manifestUrl = "https://example.test/manifest";
    const signatureUrl = "https://example.test/signature";
    const artifactUrl =
      "https://github.com/owner/repo/releases/download/graphify-v0.9.25-hive.2/graphify.tar.zst";
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/releases/tags/graphify-channel")) {
        return Response.json({
          assets: [
            {
              name: GRAPHIFY_MANIFEST_ASSET,
              browser_download_url: manifestUrl,
            },
            {
              name: GRAPHIFY_SIGNATURE_ASSET,
              browser_download_url: signatureUrl,
            },
          ],
        });
      }
      if (url === manifestUrl) return Response.json(manifest(artifactUrl));
      if (url === signatureUrl) return new Response("development-signature");
      throw new Error(`unexpected URL ${url}`);
    };

    const release = await fetchGraphifyRelease(
      fetcher as typeof fetch,
      "owner/repo",
    );
    expect(release.manifest.graphifyVersion).toBe("0.9.25");
    expect(release.artifact.url).toBe(artifactUrl);
    expect(release.local).toBe(false);
  });

  test("development Hive can test a local manifest without the network", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-graphify-channel-"));
    const path = join(root, "graphify-runtime.json");
    await writeFile(path, `${JSON.stringify(manifest("file:///tmp/a"))}\n`);
    process.env.HIVE_GRAPHIFY_MANIFEST = path;
    try {
      const release = await fetchGraphifyRelease((() => {
        throw new Error("network must not be used");
      }) as unknown as typeof fetch);
      expect(release.local).toBe(true);
      expect(release.artifact.url).toBe("file:///tmp/a");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
