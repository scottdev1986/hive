import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EMBEDDINGS_RUNTIME_BUNDLE, embeddingsRuntimeDigest } from "./digest";

export const EMBEDDINGS_RUNTIME_ASSET = "embeddings-runtime.tar.gz";

const TARBALL_TOPLEVEL = "embeddings-runtime";

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
    // SAFETY: The surrounding code already established this contract.
    return JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    ) as PackageJson;
  } catch {
    return null;
  }
}

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

/** fastembed plus its transitive dependency closure, resolved against the source node_modules (bun/npm layouts hoist, so a flat walk suffices; each package is copied wholesale, nested node_modules included). Both `dependencies` and `optionalDependencies` are walked — the napi native bindings (@anush008/tokenizers-*) are optional deps, and without them the bundle's loader has nothing to dlopen — but a missing optional dep is skipped (that is what optional means; the other platforms' binaries are never installed), while a missing hard dependency is an explicit error. Returns package name → source directory, fastembed first. */
export async function collectFastembedClosure(
  sourceNodeModules: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const queue: Array<{ name: string; optional: boolean }> = [
    { name: "fastembed", optional: false },
  ];
  while (queue.length > 0) {
    const dependency = queue.shift();
    if (dependency === undefined) break;
    const { name, optional } = dependency;
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
      ...Object.keys(manifest.optionalDependencies ?? {}).map((dep) => ({
        name: dep,
        optional: true,
      })),
    );
  }
  return resolved;
}

export interface EmbeddingsRuntimeStamp {
  readonly installedAt?: string;
  readonly source?: string;
}

export async function stageEmbeddingRuntime(
  sourceNodeModules: string,
  runtimeDir: string,
  stamp?: EmbeddingsRuntimeStamp,
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
      "bun",
      "build",
      entryPath,
      "--target=bun",
      "--packages=bundle",
      "--outdir",
      join(runtimeDir, "dist"),
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
        source: stamp?.source ?? sourceNodeModules,
        installedAt: stamp?.installedAt ?? new Date().toISOString(),
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
  path: string;
  sha256: string;
  size: number;
  /** SHA-256 of the staged tree's LOADED surface (see digest.ts). Computed before the staging dir is torn down, and equal to what a user's machine has after unpacking, because the tarball extracts the same files at the same relative paths. This is the value compiled into the CLI so the loader can refuse a tampered runtime. */
  loadedDigest: string;
}

async function packTarGz(
  parentDir: string,
  entryName: string,
  tarball: string,
  deterministicMtime?: string,
): Promise<void> {
  if (deterministicMtime === undefined) {
    const tar = Bun.spawn(
      ["tar", "-czf", tarball, "-C", parentDir, entryName],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await tar.exited) !== 0) {
      throw new Error(`tar of ${EMBEDDINGS_RUNTIME_ASSET} failed`);
    }
    return;
  }
  const parsed = Date.parse(deterministicMtime);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `deterministic embeddings mtime is not a date: ${deterministicMtime}`,
    );
  }
  const stamped = new Date(parsed);
  const touch = [
    stamped.getUTCFullYear().toString().padStart(4, "0"),
    (stamped.getUTCMonth() + 1).toString().padStart(2, "0"),
    stamped.getUTCDate().toString().padStart(2, "0"),
    stamped.getUTCHours().toString().padStart(2, "0"),
    stamped.getUTCMinutes().toString().padStart(2, "0"),
    ".",
    stamped.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  const pin = Bun.spawn(
    [
      "/usr/bin/find",
      join(parentDir, entryName),
      "-exec",
      "/usr/bin/env",
      "TZ=UTC",
      "/usr/bin/touch",
      "-t",
      touch,
      "{}",
      "+",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [pinCode, pinErr] = await Promise.all([
    pin.exited,
    new Response(pin.stderr).text(),
  ]);
  if (pinCode !== 0) {
    throw new Error(`pinning embeddings mtimes failed: ${pinErr.trim()}`);
  }
  const pack = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'set -e; /usr/bin/find "$1" -print | /usr/bin/sort | COPYFILE_DISABLE=1 /bin/pax -w -x ustar | /usr/bin/gzip -n > "$2"',
      "pack-embeddings",
      entryName,
      tarball,
    ],
    { cwd: parentDir, stdout: "inherit", stderr: "pipe" },
  );
  const [packCode, packErr] = await Promise.all([
    pack.exited,
    new Response(pack.stderr).text(),
  ]);
  if (packCode !== 0) {
    throw new Error(
      `deterministic tar of ${EMBEDDINGS_RUNTIME_ASSET} failed: ${packErr.trim()}`,
    );
  }
}

export async function buildEmbeddingsRuntimeArtifact(options: {
  sourceNodeModules: string;
  outDir: string;
  installedAt?: string;
  sourceLabel?: string;
  deterministicMtime?: string;
}): Promise<EmbeddingsRuntimeArtifact> {
  const staging = join(options.outDir, TARBALL_TOPLEVEL);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const tarball = join(options.outDir, EMBEDDINGS_RUNTIME_ASSET);
  await rm(tarball, { force: true });
  let loadedDigest: string;
  try {
    await stageEmbeddingRuntime(options.sourceNodeModules, staging, {
      installedAt: options.installedAt,
      source: options.sourceLabel,
    });
    loadedDigest = await embeddingsRuntimeDigest(staging);
    await packTarGz(
      options.outDir,
      TARBALL_TOPLEVEL,
      tarball,
      options.deterministicMtime,
    );
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
    loadedDigest,
  };
}
