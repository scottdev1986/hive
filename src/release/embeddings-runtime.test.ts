/**
 * The shared bundling pipeline (src/release/embeddings-runtime.ts), exercised
 * end to end against a planted fixture node_modules: stage the closure, run
 * the real `bun build`, and tar the result — the artifact step build.ts runs.
 * The fixture's "fastembed" is a trivial ESM module; no model, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEmbeddingsRuntimeArtifact,
  EMBEDDINGS_RUNTIME_ASSET,
  stageEmbeddingRuntime,
} from "./embeddings-runtime";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** A minimal fastembed + onnxruntime-node pair: enough for the closure walk,
 * the native-bin check, and a real `bun build` of the runtime entry. */
async function plantFixtureNodeModules(root: string): Promise<string> {
  const nm = join(root, "node_modules");
  await mkdir(join(nm, "fastembed"), { recursive: true });
  await writeFile(
    join(nm, "fastembed", "package.json"),
    JSON.stringify({
      name: "fastembed",
      version: "9.9.9-fixture",
      main: "index.js",
      dependencies: { "onnxruntime-node": "1.0.0" },
    }),
  );
  await writeFile(
    join(nm, "fastembed", "index.js"),
    "export const FlagEmbedding = {};\nexport const EmbeddingModel = {};\n",
  );
  const onnxBin = join(nm, "onnxruntime-node", "bin", "napi-v3", "darwin");
  for (const arch of ["arm64", "x64"]) {
    await mkdir(join(onnxBin, arch), { recursive: true });
    await writeFile(join(onnxBin, arch, "onnxruntime_binding.node"), "native\n");
  }
  await writeFile(
    join(nm, "onnxruntime-node", "package.json"),
    JSON.stringify({ name: "onnxruntime-node", version: "1.0.0" }),
  );
  return nm;
}

async function tarList(tarball: string): Promise<string[]> {
  const proc = Bun.spawn(["tar", "-tzf", tarball], { stdout: "pipe" });
  const listing = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return listing.split("\n").filter((line) => line !== "");
}

describe("stageEmbeddingRuntime", () => {
  test("produces the bundle, native bin/, and INSTALL.json", async () => {
    const root = await makeTempDir("hive-emb-stage-");
    const nm = await plantFixtureNodeModules(root);
    const runtimeDir = join(root, "runtime");

    const bundlePath = await stageEmbeddingRuntime(nm, runtimeDir);

    expect(bundlePath).toBe(join(runtimeDir, "dist", "entry.js"));
    expect(await Bun.file(bundlePath).exists()).toBe(true);
    // The bundle really bundled fastembed: the marker export is inlined.
    expect(await readFile(bundlePath, "utf8")).toContain("FlagEmbedding");
    expect(
      await Bun.file(
        join(runtimeDir, "bin", "napi-v3", "darwin", "arm64", "onnxruntime_binding.node"),
      ).exists(),
    ).toBe(true);
    const install = JSON.parse(
      await readFile(join(runtimeDir, "INSTALL.json"), "utf8"),
    ) as { fastembed: string; source: string };
    expect(install.fastembed).toBe("9.9.9-fixture");
    expect(install.source).toBe(nm);
  }, 30_000);
});

describe("buildEmbeddingsRuntimeArtifact", () => {
  test("produces embeddings-runtime.tar.gz with the install layout under a top-level dir", async () => {
    const root = await makeTempDir("hive-emb-artifact-");
    const nm = await plantFixtureNodeModules(root);
    const out = join(root, "dist");
    await mkdir(out, { recursive: true });

    const artifact = await buildEmbeddingsRuntimeArtifact({
      sourceNodeModules: nm,
      outDir: out,
    });

    expect(artifact.path).toBe(join(out, EMBEDDINGS_RUNTIME_ASSET));
    expect(artifact.size).toBeGreaterThan(0);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);

    const entries = await tarList(artifact.path);
    expect(entries).toContain("embeddings-runtime/dist/entry.js");
    expect(entries).toContain("embeddings-runtime/INSTALL.json");
    expect(entries).toContain("embeddings-runtime/node_modules/fastembed/package.json");
    expect(entries).toContain(
      "embeddings-runtime/bin/napi-v3/darwin/arm64/onnxruntime_binding.node",
    );
    expect(entries).toContain(
      "embeddings-runtime/bin/napi-v3/darwin/x64/onnxruntime_binding.node",
    );

    // The staging dir is cleaned up: only the tarball remains in out/.
    expect(
      await Bun.file(join(out, "embeddings-runtime")).exists(),
    ).toBe(false);
  }, 30_000);
});
