import { describe, expect, test } from "bun:test";
import { githubReleaseSource } from "./source";
import { MANIFEST_ASSET, SIGNATURE_ASSET } from "../release/manifest";

const MANIFEST = {
  schema: 1,
  version: "0.0.9",
  tag: "v0.0.9",
  channel: "stable",
  commit: "abc1234",
  publishedAt: "2026-07-11T00:00:00Z",
  securityCritical: false,
  wireProtocol: { min: 1, max: 1 },
  schemaEpoch: 1,
  artifacts: [
    {
      name: "hive-darwin-arm64",
      kind: "cli",
      platform: "darwin",
      arch: "arm64",
      size: 12,
      sha256: "a".repeat(64),
      buildHash: "deadbeef",
    },
  ],
};

/** A body delivered in several chunks, the way a real socket delivers one. */
function streamed(chunks: Uint8Array[], contentLength: number | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, {
    headers: contentLength === null
      ? {}
      : { "content-length": String(contentLength) },
  });
}

interface AssetResponse {
  readonly chunks: Uint8Array[];
  readonly contentLength: number | null;
}

/** A GitHub that serves the manifest, no signature, and one asset. */
function fakeGitHub(
  asset: AssetResponse,
  releaseTag = "v0.0.9",
  manifest: typeof MANIFEST = MANIFEST,
): typeof fetch {
  return ((url: string) => {
    if (url.includes("api.github.com")) {
      return Promise.resolve(
        Response.json({
          tag_name: releaseTag,
          assets: [
            { name: MANIFEST_ASSET, browser_download_url: "https://x/manifest" },
            { name: "hive-darwin-arm64", browser_download_url: "https://x/cli" },
          ],
        }),
      );
    }
    if (url.endsWith("/manifest")) {
      return Promise.resolve(new Response(JSON.stringify(manifest)));
    }
    if (url.endsWith("/cli")) {
      return Promise.resolve(streamed(asset.chunks, asset.contentLength));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;
}

const chunk = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("githubReleaseSource download", () => {
  test("streams the body and reports progress as it arrives", async () => {
    const source = await githubReleaseSource(
      "0.0.9",
      "owner/repo",
      fakeGitHub({ chunks: [chunk("abcd"), chunk("efgh"), chunk("ijkl")], contentLength: 12 }),
    );

    const seen: Array<[number, number | null]> = [];
    const bytes = await source.download("hive-darwin-arm64", (read, total) => {
      seen.push([read, total]);
    });

    expect(new TextDecoder().decode(bytes)).toBe("abcdefghijkl");
    // Progress is reported incrementally — the whole reason for streaming
    // instead of awaiting arrayBuffer(), which can only ever report once.
    expect(seen).toEqual([[0, 12], [4, 12], [8, 12], [12, 12]]);
  });

  test("a body with no Content-Length reports a null total rather than guessing one", async () => {
    const source = await githubReleaseSource(
      "0.0.9",
      "owner/repo",
      fakeGitHub({ chunks: [chunk("abcd"), chunk("efgh")], contentLength: null }),
    );

    const totals: Array<number | null> = [];
    const bytes = await source.download("hive-darwin-arm64", (_read, total) => {
      totals.push(total);
    });

    expect(bytes.byteLength).toBe(8);
    expect(totals.every((total) => total === null)).toBe(true);
  });

  test("a truncated body is a refusal, named as truncation", async () => {
    // The server promised 12 bytes and closed the connection after 4. Without
    // this check the failure would surface as an inscrutable SHA-256 mismatch.
    const source = await githubReleaseSource(
      "0.0.9",
      "owner/repo",
      fakeGitHub({ chunks: [chunk("abcd")], contentLength: 12 }),
    );

    await expect(source.download("hive-darwin-arm64")).rejects.toThrow(/truncated/);
  });

  test("downloading works with no progress callback at all", async () => {
    const source = await githubReleaseSource(
      "0.0.9",
      "owner/repo",
      fakeGitHub({ chunks: [chunk("abcdefghijkl")], contentLength: 12 }),
    );
    const bytes = await source.download("hive-darwin-arm64");
    expect(bytes.byteLength).toBe(12);
  });

  test("a release with no signature asset yields a null signature", async () => {
    const source = await githubReleaseSource(
      "0.0.9",
      "owner/repo",
      fakeGitHub({ chunks: [chunk("abcdefghijkl")], contentLength: 12 }),
    );
    expect(source.signature).toBeNull();
    expect(source.manifest.version).toBe("0.0.9");
    // The exact bytes, not a re-serialization: the signature is over these.
    expect(new TextDecoder().decode(source.manifestBytes)).toBe(JSON.stringify(MANIFEST));
  });

  test("refuses a signed-manifest replay from a different release tag", async () => {
    const replayed = { ...MANIFEST, version: "0.0.8", tag: "v0.0.8" };
    await expect(githubReleaseSource(
      "0.0.9",
      "owner/repo",
      fakeGitHub(
        { chunks: [chunk("abcdefghijkl")], contentLength: 12 },
        "v0.0.9",
        replayed,
      ),
    )).rejects.toThrow(/manifest names v0\.0\.8 but GitHub returned v0\.0\.9/);
  });

  test("an exact request refuses a different release response", async () => {
    const other = { ...MANIFEST, version: "0.0.8", tag: "v0.0.8" };
    await expect(githubReleaseSource(
      "0.0.9",
      "owner/repo",
      fakeGitHub(
        { chunks: [chunk("abcdefghijkl")], contentLength: 12 },
        "v0.0.8",
        other,
      ),
    )).rejects.toThrow(/requested hive 0\.0\.9 but GitHub returned v0\.0\.8/);
  });

  test("SIGNATURE_ASSET is the name the source looks for", () => {
    expect(SIGNATURE_ASSET).toBe("hive-release.json.sig");
  });
});
