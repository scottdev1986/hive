import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The ESM file the compiled daemon dynamic-imports. Lives next to the digest so the loader and the packer share one path without either importing the other subsystem. */
export const EMBEDDINGS_RUNTIME_BUNDLE = join("dist", "entry.js");

const COVERED_ROOTS = ["dist", "bin"] as const;

/** SHA-256 over every file under `dist/` and `bin/`, each contribution being the runtime-relative path followed by the file's bytes, in sorted path order — so the digest is stable across machines and changes if a file is modified, added, removed, or renamed. Throws if a covered root is missing, which is itself a runtime that must not be loaded. */
export async function embeddingsRuntimeDigest(
  runtimeDir: string,
): Promise<string> {
  const relativePaths: string[] = [];
  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(runtimeDir, relativeDir), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else relativePaths.push(path);
    }
  };
  for (const root of COVERED_ROOTS) await walk(root);

  relativePaths.sort();
  const hash = createHash("sha256");
  for (const path of relativePaths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(runtimeDir, path)));
  }
  return hash.digest("hex");
}
