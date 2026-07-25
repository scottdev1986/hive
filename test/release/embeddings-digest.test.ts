// The digest is the whole basis of load-time integrity for the embedding
// runtime, so what it does and does not cover is a contract, not an
// implementation detail. An unstated exclusion is a silent hole, so the
// exclusions are asserted here too.
//
// The end-to-end proof that a release binary REFUSES a tampered runtime cannot
// live in `bun test`: HIVE_EMBEDDINGS_DIGEST is a compile-time constant and is
// null here, which is exactly the dev-skip branch. That leg is proven against a
// real keyed release build, signed Developer ID with hardened runtime, by
// injecting into dist/entry.js and observing the refusal.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embeddingsDigestForBuild } from "../../src/release/build";
import { embeddingsRuntimeDigest } from "../../src/release/embeddings-digest";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

/** A minimal runtime tree with the same shape provisioning produces. */
async function runtime(
  overrides: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "hive-digest-"));
  const files: Record<string, string> = {
    "dist/entry.js": 'export const x = "bundle";\n',
    "dist/tokenizers.darwin-universal-abc.node": "native-bytes\n",
    "bin/napi-v3/darwin/arm64/onnxruntime_binding.node": "onnx-bytes\n",
    "node_modules/fastembed/package.json": '{"name":"fastembed"}\n',
    "INSTALL.json": '{"installedAt":"2026-07-25T00:00:00.000Z"}\n',
    "entry.ts": 'export {} from "fastembed";\n',
    ...overrides,
  };
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

describe("embeddingsRuntimeDigest", () => {
  const roots: string[] = [];
  const track = async (overrides?: Record<string, string>): Promise<string> => {
    const dir = await runtime(overrides);
    roots.push(dir);
    return dir;
  };
  const cleanup = async (): Promise<void> => {
    await Promise.all(
      roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  };

  test("two identical trees in different directories digest the same", async () => {
    try {
      const [a, b] = [await track(), await track()];
      expect(await embeddingsRuntimeDigest(a)).toBe(
        await embeddingsRuntimeDigest(b),
      );
    } finally {
      await cleanup();
    }
  });

  test("modifying the bundle that gets imported changes the digest", async () => {
    try {
      const baseline = await embeddingsRuntimeDigest(await track());
      const tampered = await embeddingsRuntimeDigest(
        await track({ "dist/entry.js": 'console.error("pwned");\n' }),
      );
      expect(tampered).not.toBe(baseline);
    } finally {
      await cleanup();
    }
  });

  test("modifying a native library under dist or bin changes the digest", async () => {
    try {
      const baseline = await embeddingsRuntimeDigest(await track());
      expect(
        await embeddingsRuntimeDigest(
          await track({
            "dist/tokenizers.darwin-universal-abc.node": "evil\n",
          }),
        ),
      ).not.toBe(baseline);
      expect(
        await embeddingsRuntimeDigest(
          await track({
            "bin/napi-v3/darwin/arm64/onnxruntime_binding.node": "evil\n",
          }),
        ),
      ).not.toBe(baseline);
    } finally {
      await cleanup();
    }
  });

  test("ADDING a file changes the digest — coverage is the listing, not a file list", async () => {
    try {
      const baseline = await embeddingsRuntimeDigest(await track());
      expect(
        await embeddingsRuntimeDigest(
          await track({ "dist/extra.js": 'console.error("pwned");\n' }),
        ),
      ).not.toBe(baseline);
    } finally {
      await cleanup();
    }
  });

  test("removing a covered file changes the digest", async () => {
    try {
      const dir = await track();
      const baseline = await embeddingsRuntimeDigest(dir);
      await rm(join(dir, "dist", "tokenizers.darwin-universal-abc.node"));
      expect(await embeddingsRuntimeDigest(dir)).not.toBe(baseline);
    } finally {
      await cleanup();
    }
  });

  test("a file's PATH is part of the digest, so renaming one is not invisible", async () => {
    try {
      const baseline = await embeddingsRuntimeDigest(await track());
      // Same bytes, different name: only the path contribution differs.
      const renamed = await track();
      await rm(join(renamed, "dist", "tokenizers.darwin-universal-abc.node"));
      await writeFile(
        join(renamed, "dist", "tokenizers.darwin-universal-xyz.node"),
        "native-bytes\n",
      );
      expect(await embeddingsRuntimeDigest(renamed)).not.toBe(baseline);
    } finally {
      await cleanup();
    }
  });

  test("the stated exclusions really are excluded", async () => {
    // node_modules is not loaded (verified by moving it aside and loading the
    // runtime), and INSTALL.json records an install timestamp and source path,
    // so it can never be part of a build-time constant.
    try {
      const baseline = await embeddingsRuntimeDigest(await track());
      const exclusions: Array<Record<string, string>> = [
        { "node_modules/fastembed/package.json": '{"name":"evil"}\n' },
        { "node_modules/evil.js": 'console.error("pwned");\n' },
        { "INSTALL.json": '{"installedAt":"2030-01-01T00:00:00.000Z"}\n' },
        { "entry.ts": "// different\n" },
      ];
      for (const override of exclusions) {
        expect(await embeddingsRuntimeDigest(await track(override))).toBe(
          baseline,
        );
      }
    } finally {
      await cleanup();
    }
  });

  test("a runtime missing a covered root cannot be digested, so it cannot be trusted", async () => {
    try {
      const dir = await track();
      await rm(join(dir, "bin"), { recursive: true });
      await expect(embeddingsRuntimeDigest(dir)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe("embedding digest build policy", () => {
  test("unsigned dev builds do not pin a separately staged runtime", () => {
    expect(embeddingsDigestForBuild(null, "loaded-digest")).toBeNull();
  });

  test("keyed releases pin the runtime they ship", () => {
    expect(embeddingsDigestForBuild("release-public-key", "loaded-digest")).toBe(
      "loaded-digest",
    );
  });
});
