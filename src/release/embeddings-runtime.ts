/**
 * The embedding runtime bundling pipeline, shared by the two producers of the
 * exact same output:
 *
 *   - `hive embeddings install` (src/cli/embeddings.ts) stages it into
 *     ~/.hive/tools/embeddings from a checkout's node_modules — the dev flow.
 *   - the release build (src/release/build.ts) stages the identical tree into
 *     a scratch dir and tars it as `embeddings-runtime.tar.gz`, the artifact a
 *     released binary downloads so a user without a checkout gets the same
 *     byte-layout (single ESM bundle + native napi assets + INSTALL.json).
 *
 * One pipeline, no duplicated staging: whatever install produces on a
 * developer's machine is what the release ships.
 *
 * The artifact is universal for darwin, like HiveWorkspace.tar.gz: the
 * onnxruntime-node package ships both darwin slices (arm64 and x64) in one
 * bin/, and the tokenizers napi binding Hive's closure pins is
 * darwin-universal — so one tarball is listed for both architectures in the
 * release manifest. (linux/win32 natives ride along; pruning them is a size
 * optimization, not a correctness one, and install does not prune either.)
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EMBEDDINGS_RUNTIME_BUNDLE } from "../daemon/memory-embeddings";

/** The release asset name; listed in hive-release.json for both darwin arches. */
export const EMBEDDINGS_RUNTIME_ASSET = "embeddings-runtime.tar.gz";

/** The top-level directory inside the tarball; install unpacks with
 * `--strip-components 1`, the graphify bundle convention. */
const TARBALL_TOPLEVEL = "embeddings-runtime";

/** The bundle entry: exactly the surface memory-embeddings.ts consumes. */
const RUNTIME_ENTRY =
  'export { FlagEmbedding, EmbeddingModel } from "fastembed";\n';

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as
      PackageJson;
  } catch {
    return null;
  }
}

/** Walk up from `start` looking for a node_modules that contains fastembed;
 * `--from` may name the node_modules dir itself or its parent. */
export async function findSourceNodeModules(
  start: string,
): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    const candidate = dir.endsWith("node_modules")
      ? dir
      : join(dir, "node_modules");
    if ((await readPackageJson(join(candidate, "fastembed"))) !== null) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** fastembed plus its transitive dependency closure, resolved against the
 * source node_modules (bun/npm layouts hoist, so a flat walk suffices; each
 * package is copied wholesale, nested node_modules included). Both
 * `dependencies` and `optionalDependencies` are walked — the napi native
 * bindings (@anush008/tokenizers-*) are optional deps, and without them the
 * bundle's loader has nothing to dlopen — but a missing optional dep is
 * skipped (that is what optional means; the other platforms' binaries are
 * never installed), while a missing hard dependency is an explicit error.
 * Returns package name → source directory, fastembed first. */
export async function collectFastembedClosure(
  sourceNodeModules: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const queue: Array<{ name: string; optional: boolean }> = [
    { name: "fastembed", optional: false },
  ];
  while (queue.length > 0) {
    const { name, optional } = queue.shift()!;
    if (resolved.has(name)) continue;
    const dir = join(sourceNodeModules, name);
    const manifest = await readPackageJson(dir);
    if (manifest === null) {
      if (optional) continue;
      throw new Error(
        `dependency ${name} is not installed under ${sourceNodeModules} — ` +
          "run `bun install` in the source checkout first",
      );
    }
    resolved.set(name, dir);
    queue.push(
      ...Object.keys(manifest.dependencies ?? {}).map((dep) => ({
        name: dep,
        optional: false,
      })),
      ...Object.keys(manifest.optionalDependencies ?? {})
        .map((dep) => ({ name: dep, optional: true })),
    );
  }
  return resolved;
}

/** Copy the closure into the runtime dir, write the bundle entry, build the
 * single-file bundle, and place the native bin/ the bundle's runtime require
 * resolves (`../bin/napi-v3/...` relative to dist/). Returns the bundle path. */
export async function stageEmbeddingRuntime(
  sourceNodeModules: string,
  runtimeDir: string,
): Promise<string> {
  const closure = await collectFastembedClosure(sourceNodeModules);
  const targetNodeModules = join(runtimeDir, "node_modules");
  await rm(targetNodeModules, { recursive: true, force: true });
  await mkdir(targetNodeModules, { recursive: true });
  for (const [name, sourceDir] of closure) {
    await mkdir(dirname(join(targetNodeModules, name)), { recursive: true });
    await cp(sourceDir, join(targetNodeModules, name), { recursive: true });
  }

  const onnxBin = join(targetNodeModules, "onnxruntime-node", "bin");
  if (!Bun.which("bun")) {
    throw new Error(
      "bun is not on PATH; the runtime bundle is built with `bun build`",
    );
  }
  const nativeBin = await stat(join(onnxBin, "napi-v3")).catch(() => null);
  if (nativeBin === null || !nativeBin.isDirectory()) {
    throw new Error(
      `onnxruntime-node under ${sourceNodeModules} ships no native bin/ — ` +
        "the runtime would have nothing to load",
    );
  }
  await rm(join(runtimeDir, "bin"), { recursive: true, force: true });
  await cp(onnxBin, join(runtimeDir, "bin"), { recursive: true });

  const entryPath = join(runtimeDir, "entry.ts");
  await writeFile(entryPath, RUNTIME_ENTRY);
  await rm(join(runtimeDir, "dist"), { recursive: true, force: true });
  const build = Bun.spawn(
    [
      "bun", "build", entryPath,
      "--target=bun",
      "--packages=bundle",
      "--outdir", join(runtimeDir, "dist"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await build.exited) !== 0) {
    throw new Error("bun build of the embedding runtime bundle failed");
  }
  const bundlePath = join(runtimeDir, EMBEDDINGS_RUNTIME_BUNDLE);
  if (!(await Bun.file(bundlePath).exists())) {
    throw new Error(`bun build produced no runtime bundle at ${bundlePath}`);
  }

  const fastembedVersion =
    (await readPackageJson(join(targetNodeModules, "fastembed")))?.version ??
      "unknown";
  await writeFile(
    join(runtimeDir, "INSTALL.json"),
    `${JSON.stringify(
      {
        fastembed: fastembedVersion,
        source: sourceNodeModules,
        installedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    )}\n`,
  );
  return bundlePath;
}

export interface EmbeddingsRuntimeArtifact {
  /** Path to the produced tar.gz. */
  path: string;
  sha256: string;
  size: number;
}

/**
 * Stage the runtime into a scratch dir under `outDir` and tar it as
 * `<outDir>/embeddings-runtime.tar.gz` with a single top-level
 * `embeddings-runtime/` directory — the release artifact `hive embeddings
 * install` downloads and verifies on machines without a checkout. The staged
 * tree is exactly what the CLI's own install flow produces, because both call
 * `stageEmbeddingRuntime`.
 */
export async function buildEmbeddingsRuntimeArtifact(options: {
  sourceNodeModules: string;
  outDir: string;
}): Promise<EmbeddingsRuntimeArtifact> {
  const staging = join(options.outDir, TARBALL_TOPLEVEL);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const tarball = join(options.outDir, EMBEDDINGS_RUNTIME_ASSET);
  await rm(tarball, { force: true });
  try {
    await stageEmbeddingRuntime(options.sourceNodeModules, staging);
    const tar = Bun.spawn(
      ["tar", "-czf", tarball, "-C", options.outDir, TARBALL_TOPLEVEL],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await tar.exited) !== 0) {
      throw new Error(`tar of ${EMBEDDINGS_RUNTIME_ASSET} failed`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (!(await Bun.file(tarball).exists())) {
    throw new Error(`the runtime tarball was not produced at ${tarball}`);
  }
  const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
  return {
    path: tarball,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}
