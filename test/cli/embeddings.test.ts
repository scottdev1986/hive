// Unit tests for the embedding-runtime provisioning helpers: the
// dependency-closure walk, the source node_modules discovery, and the
// already-installed fast path every provisioning caller shares. The full
// install (copy + bun build + model probe) is proven against the compiled
// binary end-to-end, not here — `bun test` never downloads a model.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectFastembedClosure,
  EMBEDDINGS_SOURCE_ENV,
  type EmbeddingsProvisionDeps,
  ensureEmbeddingsRuntime,
  findSourceNodeModules,
  provisionEmbeddingsRuntime,
} from "../../src/cli/embeddings";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, prefix));
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
        optionalDependencies: {
          "native-host": "0.0.0",
          "native-other": "0.0.0",
        },
      }),
    );
    await plantPackage(nm, "native-host");

    const closure = await collectFastembedClosure(nm);
    expect([...closure.keys()].sort()).toEqual([
      "a",
      "fastembed",
      "native-host",
    ]);
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

describe("ensureEmbeddingsRuntime — the fast path every provisioning caller shares", () => {
  // The runtime dir is HIVE_EMBEDDINGS_HOME-relative; point it at a temp dir
  // per test so `bun test` never touches a real install. HIVE_EMBEDDINGS_SOURCE
  // names a source with no fastembed in it, so the full provisioning path can
  // only fail here — a successful outcome can therefore only be the skip.
  async function withRuntimeHome<T>(
    run: (runtimeDir: string) => Promise<T>,
  ): Promise<T> {
    const runtimeDir = await makeTempDir("hive-embed-runtime-");
    const source = await makeTempDir("hive-embed-empty-");
    const previousHome = process.env.HIVE_EMBEDDINGS_HOME;
    const previousSource = process.env[EMBEDDINGS_SOURCE_ENV];
    process.env.HIVE_EMBEDDINGS_HOME = runtimeDir;
    process.env[EMBEDDINGS_SOURCE_ENV] = source;
    try {
      return await run(runtimeDir);
    } finally {
      if (previousHome === undefined) delete process.env.HIVE_EMBEDDINGS_HOME;
      else process.env.HIVE_EMBEDDINGS_HOME = previousHome;
      if (previousSource === undefined)
        delete process.env[EMBEDDINGS_SOURCE_ENV];
      else process.env[EMBEDDINGS_SOURCE_ENV] = previousSource;
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
      let probes = 0;
      const outcome = await ensureEmbeddingsRuntime(async (dir) => {
        probes += 1;
        expect(dir).toBe(runtimeDir);
        return okProbe();
      });
      expect(outcome.ok).toBe(true);
      expect(probes).toBe(1);
    });
  });

  test("an installed bundle whose probe fails falls through to a full reinstall", async () => {
    await withRuntimeHome(async (runtimeDir) => {
      await plantBundle(runtimeDir);
      let probes = 0;
      const outcome = await ensureEmbeddingsRuntime(async () => {
        probes += 1;
        throw new Error("embedding-runtime-broken: planted probe failure");
      });
      // The skip is refused and the full path runs — which fails here only
      // because this fixture has no fastembed source to copy from.
      expect(outcome.ok).toBe(false);
      expect(probes).toBe(1);
    });
  });

  test("no bundle on disk means no skip-path probe at all", async () => {
    await withRuntimeHome(async () => {
      let probes = 0;
      const outcome = await ensureEmbeddingsRuntime(async () => {
        probes += 1;
        return okProbe();
      });
      expect(outcome.ok).toBe(false);
      expect(probes).toBe(0);
    });
  });

  test("a HIVE_EMBEDDINGS_SOURCE with no fastembed fails loudly rather than downloading", async () => {
    await withRuntimeHome(async () => {
      const outcome = await ensureEmbeddingsRuntime(okProbe);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toContain("no node_modules containing fastembed");
    });
  });
});

describe("provisionEmbeddingsRuntime — dev checkout first, release download second", () => {
  function recorder(runtimeDir: string) {
    const calls: string[] = [];
    const deps: EmbeddingsProvisionDeps = {
      runtimeDir,
      cwd: "",
      releaseBuild: false,
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

  test("an explicit source that names no fastembed fails loudly — no silent network fallback", async () => {
    const root = await makeTempDir("hive-embed-order-");
    const { calls, deps } = recorder(join(root, "runtime"));

    const outcome = await provisionEmbeddingsRuntime({ from: root }, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain(root);
      expect(outcome.reason).toContain("HIVE_EMBEDDINGS_SOURCE");
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

describe("provisionEmbeddingsRuntime — a release build never takes a dev path", () => {
  test("a checkout in reach is ignored: the release download runs anyway", async () => {
    const root = await makeTempDir("hive-embed-release-build-");
    const nm = join(root, "node_modules");
    await plantPackage(nm, "fastembed");
    const calls: string[] = [];
    const deps: EmbeddingsProvisionDeps = {
      runtimeDir: join(root, "runtime"),
      cwd: root,
      releaseBuild: true,
      installFromCheckout: async () => {
        throw new Error("a release build must never stage from a checkout");
      },
      installFromRelease: async () => {
        calls.push("release");
        return { ok: true, detail: "downloaded from release" };
      },
    };

    const outcome = await provisionEmbeddingsRuntime({}, deps);

    expect(outcome).toEqual({ ok: true, detail: "downloaded from release" });
    expect(calls).toEqual(["release"]);
  });

  test("an explicit dev source is refused loudly, never staged or downloaded", async () => {
    const root = await makeTempDir("hive-embed-release-build-");
    const nm = join(root, "node_modules");
    await plantPackage(nm, "fastembed");
    const deps: EmbeddingsProvisionDeps = {
      runtimeDir: join(root, "runtime"),
      cwd: root,
      releaseBuild: true,
      installFromCheckout: async () => {
        throw new Error("a release build must never stage from a checkout");
      },
      installFromRelease: async () => {
        throw new Error("an explicit dev source must refuse, not download");
      },
    };

    const outcome = await provisionEmbeddingsRuntime({ from: root }, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain(EMBEDDINGS_SOURCE_ENV);
      expect(outcome.reason).toContain("dev-build control");
    }
  });
});
