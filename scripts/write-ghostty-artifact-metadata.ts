import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync } from "node:fs";
import { relative, resolve } from "node:path";

type FileRecord = { path: string; sha256: string; size: number; type: "file" | "symlink" };
type MachORecord = {
  archive: string;
  member: string;
  architecture: string;
  platform: string;
  minOS: string;
  sdk: string;
};
type Dependency = { name: string; url: string; hash: string };

const [outputArg] = process.argv.slice(2);
if (!outputArg) {
  console.error("usage: write-ghostty-artifact-metadata.ts OUTPUT_DIR");
  process.exit(2);
}

const root = resolve(import.meta.dir, "..");
const output = resolve(outputArg);
const lock = await Bun.file(resolve(root, "native/toolchain-lock.json")).json();
const dependencyMap = (await Bun.file(resolve(root, "vendor/ghostty/build.zig.zon.json")).json()) as Record<
  string,
  Dependency
>;
const excluded = new Set(["artifact-manifest.json", "sbom.cdx.json"]);

function sha256(data: string | ArrayBuffer): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function collectNotices(source: string, destination: string): number {
  let count = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = resolve(source, entry.name);
    const outputPath = resolve(destination, relative(source, path));
    if (entry.isDirectory()) {
      count += collectNotices(path, outputPath);
    } else if (entry.isFile() && /^(?:license|copying|notice|copyright)/i.test(entry.name)) {
      mkdirSync(resolve(outputPath, ".."), { recursive: true });
      copyFileSync(path, outputPath);
      count += 1;
    }
  }
  return count;
}

async function walk(directory: string): Promise<FileRecord[]> {
  const records: FileRecord[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    const artifactPath = relative(output, path);
    if (excluded.has(artifactPath)) continue;
    if (entry.isDirectory()) {
      records.push(...(await walk(path)));
    } else if (entry.isSymbolicLink()) {
      const target = readlinkSync(path);
      records.push({ path: artifactPath, sha256: sha256(target), size: target.length, type: "symlink" });
    } else if (entry.isFile()) {
      const data = await Bun.file(path).arrayBuffer();
      records.push({ path: artifactPath, sha256: sha256(data), size: lstatSync(path).size, type: "file" });
    }
  }
  return records;
}

function run(command: string[]): string {
  const result = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function archiveArchitectures(path: string): string[] {
  return run(["/usr/bin/lipo", "-archs", path]).trim().split(/\s+/).sort();
}

function inspectArchive(path: string): MachORecord[] {
  const archive = relative(output, path);
  const defaultArchitectures = archiveArchitectures(path);
  const text = run(["/usr/bin/xcrun", "otool", "-arch", "all", "-l", path]);
  const lines = text.split("\n");
  const expectedCommands = lines.filter((line) => line.trim() === "cmd LC_BUILD_VERSION").length;
  const records: MachORecord[] = [];
  let member = archive;
  let architecture = defaultArchitectures.length === 1 ? (defaultArchitectures[0] ?? "unknown") : "unknown";
  let platform = "unknown";
  let pending: MachORecord | undefined;

  for (const line of lines) {
    if (line.endsWith(":")) {
      const archMatch = line.match(/\(architecture ([^)]+)\)/);
      const memberMatch = line.match(/\(([^()]+\.(?:o|a))\):$/);
      architecture = archMatch?.[1] ?? (defaultArchitectures.length === 1 ? (defaultArchitectures[0] ?? "unknown") : "unknown");
      member = memberMatch?.[1] ?? line.slice(0, -1);
      continue;
    }
    const platformMatch = line.match(/^\s*platform\s+(.+)$/);
    if (platformMatch?.[1]) platform = platformMatch[1].trim();
    const minOSMatch = line.match(/^\s*minos\s+(.+)$/);
    if (minOSMatch?.[1]) {
      pending = { archive, member, architecture, platform, minOS: minOSMatch[1].trim(), sdk: "unknown" };
      records.push(pending);
    }
    const sdkMatch = line.match(/^\s*sdk\s+(.+)$/);
    if (sdkMatch?.[1] && pending) pending.sdk = sdkMatch[1].trim();
  }

  if (records.length !== expectedCommands) {
    throw new Error(`${archive}: found ${expectedCommands} LC_BUILD_VERSION commands but ${records.length} minOS values`);
  }
  return records;
}

function versionNumber(version: string): number {
  const [major = "0", minor = "0"] = version.split(".");
  return Number(major) * 1000 + Number(minor);
}

// build-ghosttykit.sh reads the macOS slice's directory/archive name from
// the xcframework's own Info.plist (it can drift if Ghostty renames its
// LibraryIdentifier/BinaryPath) and passes the resulting relative path
// here rather than this script hardcoding a second, possibly-stale copy.
const macArchivePath =
  process.env.HIVE_MAC_XCFRAMEWORK_ARCHIVE ??
  "GhosttyKit.xcframework/macos-arm64_x86_64/ghostty-internal.a";

const expectedArchitectures: Array<[string, string[]]> = [
  [macArchivePath, ["arm64", "x86_64"]],
  ["lib-vt/arm64/libghostty-vt.a", ["arm64"]],
  ["lib-vt/x86_64/libghostty-vt.a", ["x86_64"]],
];
for (const [artifact, expected] of expectedArchitectures) {
  const actual = archiveArchitectures(resolve(output, artifact));
  if (actual.join(" ") !== [...expected].sort().join(" ")) {
    throw new Error(`${artifact}: expected architectures ${expected.join(" ")}, found ${actual.join(" ")}`);
  }
}

const dependencyCache = process.env.HIVE_ZIG_GLOBAL_CACHE;
if (!dependencyCache) throw new Error("build did not provide the verified Zig dependency-cache path");
const dependencyNoticeCounts = Object.fromEntries(
  Object.keys(dependencyMap)
    .sort()
    .map((dependency) => [
      dependency,
      collectNotices(resolve(dependencyCache, "p", dependency), resolve(output, "notices/dependencies", dependency)),
    ]),
);
if (Object.values(dependencyNoticeCounts).reduce((sum, count) => sum + count, 0) === 0) {
  throw new Error("no transitive dependency notices were collected");
}

const files = await walk(output);
if (files.some((file) => file.path.endsWith(".dylib"))) {
  throw new Error("artifact set unexpectedly contains a dynamic library");
}
const archives = files.filter((file) => file.type === "file" && file.path.endsWith(".a"));
const machO = archives.flatMap((archive) => inspectArchive(resolve(output, archive.path)));
const productFloor = String(lock.deploymentTarget);
for (const member of machO) {
  if ((member.platform === "1" || member.platform === "MACOS") && versionNumber(member.minOS) > versionNumber(productFloor)) {
    throw new Error(`${member.archive}(${member.member}) minOS ${member.minOS} exceeds product floor ${productFloor}`);
  }
}

const bundledStub = process.env.HIVE_ZIG_BUNDLED_STUB;
const xcodeStub = process.env.HIVE_XCODE_LIBSYSTEM_STUB;
if (!bundledStub || !xcodeStub) throw new Error("build did not provide Darwin stub provenance paths");
const patchSeriesSha256 = process.env.HIVE_PATCH_SERIES_SHA256;
const metalToolchain = process.env.HIVE_METAL_TOOLCHAIN;
const upstreamPublicHeaderSha256 = process.env.HIVE_UPSTREAM_PUBLIC_HEADER_SHA256;
const bridgeHeaderSha256 = process.env.HIVE_BRIDGE_HEADER_SHA256;
const symbolListSha256 = process.env.HIVE_SYMBOL_LIST_SHA256;
const metalBuild = process.env.HIVE_METAL_BUILD;
const zigArchiveSha256 = process.env.HIVE_ZIG_ARCHIVE_SHA256;
if (!patchSeriesSha256 || !upstreamPublicHeaderSha256 || !bridgeHeaderSha256 || !symbolListSha256) {
  throw new Error("build did not provide source/ABI provenance hashes");
}
if (!metalToolchain || !metalBuild || !zigArchiveSha256) {
  throw new Error("build did not provide Zig/Metal provenance");
}

const artifactManifest = {
  schemaVersion: 1,
  source: {
    repository: "https://github.com/ghostty-org/ghostty.git",
    commit: lock.ghostty.commit,
    declaredVersion: lock.ghostty.declaredVersion,
    upstreamTree: lock.ghostty.upstreamTree,
    patchedTree: lock.ghostty.patchedTree,
    patchSeriesSha256,
    upstreamPublicHeaderSha256,
    bridgeHeaderSha256,
    symbolListSha256,
  },
  toolchain: lock,
  buildEnvironment: {
    metalToolchain,
    metalBuild,
    zigArchiveSha256,
    networkPolicy: "offline; dependency cache verified before build",
    runnerLink: "Zig bundled Darwin stubs selected by scripts/zig-runner-tools/xcrun",
    sdkOverlay: "locked Xcode SDKs with only macOS libSystem.tbd replaced by Zig's bundled stub",
    bundledLibSystemSha256: sha256(await Bun.file(bundledStub).arrayBuffer()),
    xcodeLibSystemSha256: sha256(await Bun.file(xcodeStub).arrayBuffer()),
    dependencyNoticeCounts,
  },
  verification: {
    productFloor,
    architectureSets: Object.fromEntries(expectedArchitectures),
    machO,
  },
  files,
};
await Bun.write(resolve(output, "artifact-manifest.json"), `${JSON.stringify(artifactManifest, null, 2)}\n`);

const dependencyComponents = Object.entries(dependencyMap)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([bomRef, dependency]) => ({
    type: "library",
    "bom-ref": bomRef,
    name: dependency.name,
    hashes: [{ alg: "SHA-256", content: Buffer.from(dependency.hash.slice("sha256-".length), "base64").toString("hex") }],
    externalReferences: [{ type: "distribution", url: dependency.url }],
  }));
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: {
      type: "framework",
      "bom-ref": "ghostty",
      name: "GhosttyKit",
      version: lock.ghostty.declaredVersion,
      licenses: [{ license: { id: "MIT" } }],
      externalReferences: [{ type: "vcs", url: `https://github.com/ghostty-org/ghostty/tree/${lock.ghostty.commit}` }],
    },
    tools: { components: [{ type: "application", name: "Zig", version: lock.zig.version }] },
  },
  components: dependencyComponents,
  dependencies: [{ ref: "ghostty", dependsOn: dependencyComponents.map((component) => component["bom-ref"]) }],
};
await Bun.write(resolve(output, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

console.log(`artifact metadata written: ${files.length} files, ${machO.length} Mach-O members`);
