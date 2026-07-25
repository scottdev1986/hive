/**
 * The digest that gives the embedding runtime load-time integrity.
 *
 * WHY THIS EXISTS. The daemon loads the runtime with `await import()` of a plain
 * JavaScript file on disk (dist/entry.js) plus native libraries it dlopens.
 * Nothing about that is signature-checked, so anyone who can write the runtime
 * directory can execute code inside a Developer-ID-signed, notarized hive
 * process and inherit every TCC grant the user gave it. That was demonstrated,
 * not theorized: editing dist/entry.js and running the signed binary executed
 * the edit.
 *
 * WHY THE DIGEST CANNOT LIVE NEXT TO THE CODE. The release manifest's SHA-256
 * pins the downloaded TARBALL, not the extracted tree, and the tarball is
 * deleted after unpacking. Recording a digest inside the runtime directory would
 * be worthless: the attacker who rewrites a file rewrites the recorded digest in
 * the same breath. So the expected value is compiled into the binary
 * (HIVE_EMBEDDINGS_DIGEST) — the one place in this picture an attacker provably
 * cannot reach without invalidating a code signature.
 *
 * WHAT IS COVERED, and what is deliberately not. `dist/` and `bin/` in full, as
 * complete recursive listings, so ADDING a file changes the digest and not only
 * modifying one. Excluded:
 *   - node_modules/ (232 MB) — not loaded. `bun build --packages=bundle` inlines
 *     the dependency graph into dist/entry.js and copies the native binding
 *     beside it; the tree is leftover staging. Verified by moving it aside and
 *     loading the runtime successfully, not by reading the bundler's docs.
 *   - INSTALL.json and entry.ts — data, never imported. INSTALL.json also
 *     records an install timestamp and a source path, so it is not stable across
 *     machines and could never be part of a build-time constant.
 * Covering exactly the loaded surface costs 110 ms for 227 MB (measured), paid
 * once per process because the embedder is a lazy memoized singleton — so there
 * is no digest cache, because nothing needs one.
 *
 * KNOWN LIMIT, stated rather than hidden: hashing the bytes and then importing
 * the path is not atomic. A local attacker who can write the directory could in
 * principle swap a file between the two. Closing that would require importing
 * from verified bytes in memory, which the runtime loader cannot do for a native
 * dlopen. This raises the bar from "edit a file" to "win a race against a
 * process you do not control"; it does not eliminate it.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Runtime-dir-relative roots whose bytes the loader executes. */
const COVERED_ROOTS = ["dist", "bin"] as const;

/**
 * SHA-256 over every file under `dist/` and `bin/`, each contribution being the
 * runtime-relative path followed by the file's bytes, in sorted path order — so
 * the digest is stable across machines and changes if a file is modified, added,
 * removed, or renamed. Throws if a covered root is missing, which is itself a
 * runtime that must not be loaded.
 */
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
      // Anything that is not a directory is content the loader could read, so a
      // symlinked file is hashed by what it resolves to.
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
