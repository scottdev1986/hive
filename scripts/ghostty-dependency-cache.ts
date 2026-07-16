import { existsSync } from "node:fs";
import { resolve } from "node:path";

type Dependency = { name: string; url: string; hash: string };

const [mode, zigArg, cacheArg, manifestArg] = process.argv.slice(2);
if ((mode !== "fetch" && mode !== "verify") || !zigArg || !cacheArg || !manifestArg) {
  console.error("usage: ghostty-dependency-cache.ts fetch|verify ZIG CACHE build.zig.zon.json");
  process.exit(2);
}

const zig = resolve(zigArg);
const cache = resolve(cacheArg);
const manifestPath = resolve(manifestArg);
const manifest = (await Bun.file(manifestPath).json()) as Record<string, Dependency>;
const dependencies = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));

for (const [expected, dependency] of dependencies) {
  const cached = resolve(cache, "p", expected);
  if (existsSync(cached)) continue;
  if (mode === "verify") {
    console.error(`Ghostty dependency is absent from the offline cache: ${dependency.name} (${expected})`);
    process.exit(1);
  }

  console.log(`fetching Ghostty dependency ${dependency.name}`);
  const result = Bun.spawnSync({
    cmd: [zig, "fetch", "--global-cache-dir", cache, dependency.url],
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  const actual = result.stdout.toString().trim();
  if (actual !== expected) {
    console.error(
      `Ghostty dependency hash mismatch for ${dependency.name}: expected ${expected}, found ${actual}`,
    );
    process.exit(1);
  }
}

console.log(`Ghostty dependency cache ${mode === "fetch" ? "populated" : "verified"}: ${dependencies.length} packages`);
