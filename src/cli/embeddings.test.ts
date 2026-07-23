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
