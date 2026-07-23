// Unit tests for `hive embeddings install` helpers: the dependency-closure
// walk and the source node_modules discovery. The full install (copy + bun
// build + model probe) is proven against the compiled binary end-to-end, not
// here — `bun test` never downloads a model.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFastembedClosure,
  findSourceNodeModules,
  provisionEmbeddingsRuntime,
  runEmbeddingsInstall,
  type EmbeddingsProvisionDeps,
} from "./embeddings";

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

async function plantPackage(
  nodeModules: string,
  name: string,
  dependencies: Record<string, string> = {},
): Promise<void> {
  const dir = join(nodeModules, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", dependencies }),
  );
}

describe("collectFastembedClosure", () => {
  test("walks the transitive dependency graph, scoped packages included", async () => {
    const root = await makeTempDir("hive-embed-closure-");
    const nm = join(root, "node_modules");
    await plantPackage(nm, "fastembed", { a: "1.0.0", "@scope/b": "1.0.0" });
    await plantPackage(nm, "a", { "@scope/b": "1.0.0" });
    await plantPackage(nm, "@scope/b");
    await plantPackage(nm, "unrelated");

    const closure = await collectFastembedClosure(nm);
    expect([...closure.keys()].sort()).toEqual(["@scope/b", "a", "fastembed"]);
    expect(closure.get("fastembed")).toBe(join(nm, "fastembed"));
    expect(closure.get("@scope/b")).toBe(join(nm, "@scope/b"));
  });

  test("optional dependencies are copied when present, skipped when absent", async () => {
    const root = await makeTempDir("hive-embed-closure-");
    const nm = join(root, "node_modules");
    // The napi pattern: native bindings ride in optionalDependencies, and
    // only the host platform's package is ever installed.
    await plantPackage(nm, "fastembed", { a: "1.0.0" });
    await mkdir(join(nm, "a"), { recursive: true });
    await writeFile(
      join(nm, "a", "package.json"),
      JSON.stringify({
        name: "a",
        version: "1.0.0",
        optionalDependencies: { "native-host": "0.0.0", "native-other": "0.0.0" },
      }),
    );
    await plantPackage(nm, "native-host");

    const closure = await collectFastembedClosure(nm);
    expect([...closure.keys()].sort()).toEqual(["a", "fastembed", "native-host"]);
  });

  test("a missing dependency is an explicit error, not a silent skip", async () => {
    const root = await makeTempDir("hive-embed-closure-");
    const nm = join(root, "node_modules");
    await plantPackage(nm, "fastembed", { "not-installed": "1.0.0" });
    await expect(collectFastembedClosure(nm)).rejects.toThrow("not-installed");
  });
});

describe("findSourceNodeModules", () => {
  test("finds node_modules walking up, and accepts it directly", async () => {
    const root = await makeTempDir("hive-embed-find-");
    const nm = join(root, "node_modules");
    await plantPackage(nm, "fastembed");
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(await findSourceNodeModules(nested)).toBe(nm);
    expect(await findSourceNodeModules(nm)).toBe(nm);
    expect(await findSourceNodeModules(root)).toBe(nm);
  });

  test("returns null when no ancestor node_modules carries fastembed", async () => {
    const root = await makeTempDir("hive-embed-find-");
    expect(await findSourceNodeModules(root)).toBeNull();
  });
});

describe("runEmbeddingsInstall fast path", () => {
  // The runtime dir is HIVE_EMBEDDINGS_HOME-relative; point it at a temp dir
  // per test so `bun test` never touches a real install. The injected probe
  // stands in for the model-loading probe — `bun test` never downloads one.
  async function withRuntimeHome<T>(
    run: (runtimeDir: string) => Promise<T>,
  ): Promise<T> {
    const runtimeDir = await makeTempDir("hive-embed-runtime-");
    const previous = process.env.HIVE_EMBEDDINGS_HOME;
    process.env.HIVE_EMBEDDINGS_HOME = runtimeDir;
    try {
      return await run(runtimeDir);
    } finally {
      if (previous === undefined) delete process.env.HIVE_EMBEDDINGS_HOME;
      else process.env.HIVE_EMBEDDINGS_HOME = previous;
    }
  }

  const okProbe = async () => ({
    bundlePath: "/unused/dist/entry.js",
    model: "bge-small-en-v1.5",
    dimensions: 384,
  });

  /** What a completed install looks like to the fast path: the bundle on
   * disk. The probe decides whether it is healthy. */
  async function plantBundle(runtimeDir: string): Promise<void> {
    await mkdir(join(runtimeDir, "dist"), { recursive: true });
    await writeFile(join(runtimeDir, "dist", "entry.js"), "// bundle\n");
  }

  test("an installed bundle + a passing probe skips the reinstall entirely", async () => {
    await withRuntimeHome(async (runtimeDir) => {
      await plantBundle(runtimeDir);
      // No fastembed anywhere under `from`: the full path WOULD fail here, so
      // a zero exit can only come from the skip path.
      const empty = await makeTempDir("hive-embed-empty-");
      let probes = 0;
      const code = await runEmbeddingsInstall({
        from: empty,
        probe: async (...args) => {
          probes += 1;
          expect(args[0]).toBe(runtimeDir);
          return okProbe();
        },
      });
      expect(code).toBe(0);
      expect(probes).toBe(1);
    });
  });

  test("an installed bundle whose probe fails falls through to a full reinstall", async () => {
    await withRuntimeHome(async (runtimeDir) => {
      await plantBundle(runtimeDir);
      const empty = await makeTempDir("hive-embed-empty-");
      let probes = 0;
      const code = await runEmbeddingsInstall({
        from: empty,
        probe: async () => {
          probes += 1;
          throw new Error("embedding-runtime-broken: planted probe failure");
        },
      });
      // The skip is refused and the full path runs — which fails here only
      // because this fixture has no fastembed source to copy from.
      expect(code).toBe(1);
      expect(probes).toBe(1);
    });
  });

  test("no bundle on disk means no skip-path probe at all", async () => {
    await withRuntimeHome(async () => {
      const empty = await makeTempDir("hive-embed-empty-");
      let probes = 0;
      const code = await runEmbeddingsInstall({
        from: empty,
        probe: async () => {
          probes += 1;
          return okProbe();
        },
      });
      expect(code).toBe(1);
      expect(probes).toBe(0);
    });
  });
});

describe("provisionEmbeddingsRuntime — dev checkout first, release download second", () => {
  function recorder(runtimeDir: string) {
    const calls: string[] = [];
    const deps: EmbeddingsProvisionDeps = {
      runtimeDir,
      cwd: "",
      installFromCheckout: async (source) => {
        calls.push(`checkout:${source}`);
        return { ok: true, detail: "staged from checkout" };
      },
      installFromRelease: async () => {
        calls.push("release");
        return { ok: true, detail: "downloaded from release" };
      },
    };
    return { calls, deps };
  }

  test("a checkout in reach stages from it and never touches the network", async () => {
    const root = await makeTempDir("hive-embed-order-");
    const nm = join(root, "node_modules");
    await plantPackage(nm, "fastembed");
    const runtimeDir = join(root, "runtime");
    const { calls, deps } = recorder(runtimeDir);
    deps.cwd = join(root, "a", "b"); // nested: found by walking up
    await mkdir(deps.cwd, { recursive: true });

    const outcome = await provisionEmbeddingsRuntime({}, deps);

    expect(outcome).toEqual({ ok: true, detail: "staged from checkout" });
    expect(calls).toEqual([`checkout:${nm}`]);
  });

  test("no checkout anywhere downloads the pinned release runtime", async () => {
    const root = await makeTempDir("hive-embed-order-");
    const { calls, deps } = recorder(join(root, "runtime"));
    deps.cwd = root;

    const outcome = await provisionEmbeddingsRuntime({}, deps);

    expect(outcome).toEqual({ ok: true, detail: "downloaded from release" });
    expect(calls).toEqual(["release"]);
  });

  test("an explicit --from that names no fastembed fails loudly — no silent network fallback", async () => {
    const root = await makeTempDir("hive-embed-order-");
    const { calls, deps } = recorder(join(root, "runtime"));

    const outcome = await provisionEmbeddingsRuntime({ from: root }, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain(root);
      expect(outcome.reason).toContain("--from");
    }
    expect(calls).toEqual([]);
  });

  test("an explicit --from wins over the release path when it does name a source", async () => {
    const root = await makeTempDir("hive-embed-order-");
    const nm = join(root, "node_modules");
    await plantPackage(nm, "fastembed");
    const { calls, deps } = recorder(join(root, "runtime"));

    const outcome = await provisionEmbeddingsRuntime({ from: root }, deps);

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([`checkout:${nm}`]);
  });
});
