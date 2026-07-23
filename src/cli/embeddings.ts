// `hive embeddings install` — provision the external embedding runtime the
// compiled daemon loads (defect D1; see the header of
// src/daemon/memory-embeddings.ts for why a single-file binary cannot carry
// fastembed's native graph).
//
// The dev-root flow: copy fastembed and its full dependency closure from a
// checkout's node_modules into ~/.hive/tools/embeddings (HIVE_EMBEDDINGS_HOME
// override), bundle it into the single ESM file the daemon dynamic-imports,
// place onnxruntime's native bin/ where the bundle's runtime require expects
// it, and then — the strict check — load the bundle and embed a probe string,
// asserting dimensions=384. Install is only "done" when the probe passes.
// Release/bootstrap wiring (downloading a pinned runtime instead of copying
// from a checkout) is a documented follow-up.
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  EMBEDDINGS_RUNTIME_BUNDLE,
  embeddingsRuntimeDir,
  memoryModelsDir,
  probeExternalRuntime,
} from "../daemon/memory-embeddings";

const PROBE_MODEL = "bge-small-en-v1.5" as const;

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

export async function runEmbeddingsInstall(options: {
  from?: string;
}): Promise<0 | 1> {
  try {
    const source = await findSourceNodeModules(options.from ?? process.cwd());
    if (source === null) {
      throw new Error(
        "no node_modules containing fastembed found from " +
          `${options.from ?? process.cwd()} — run this from a Hive checkout ` +
          "(or pass --from <repo root>)",
      );
    }
    const runtimeDir = embeddingsRuntimeDir();
    console.log(`source:      ${source}`);
    console.log(`runtime dir: ${runtimeDir}`);
    const bundlePath = await stageEmbeddingRuntime(source, runtimeDir);
    console.log(`bundle:      ${bundlePath}`);

    // The strict check: load the bundle that was just installed — never the
    // node_modules fallback — and embed a probe string at the model's width.
    // A failed probe is a failed install, whatever the copies looked like.
    const probe = await probeExternalRuntime(
      runtimeDir,
      PROBE_MODEL,
      memoryModelsDir(),
    );
    console.log(
      `probe:       OK (${probe.model}, dimensions=${probe.dimensions})`,
    );
    console.log("embedding runtime installed and probe-verified");
    return 0;
  } catch (error) {
    console.error(
      `hive embeddings install failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
}
