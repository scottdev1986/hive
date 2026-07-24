#!/usr/bin/env bun
/**
 * Build the release artifacts and the manifest that describes them.
 *
 * `bun run src/release/build.ts --version 0.0.7 --commit abc1234 --out dist`
 *
 * Two CLI binaries (`darwin-arm64`, `darwin-x64`), two `hive-sessiond` broker
 * binaries (same arches), one universal Workspace application, and the
 * universal embedding runtime tarball (`embeddings-runtime.tar.gz`) that
 * `hive embeddings install` downloads on machines without a checkout — built
 * through the same pipeline the CLI's dev install uses, so the shipped bytes
 * are those bytes. Sessiond is
 * built ReleaseFast so its embedded Ghostty VT engine fingerprint matches the
 * Workspace release renderer — a Debug sessiond against a ReleaseFast renderer
 * fails the engine-build fence by design. The app is universal rather than
 * sliced because one lipo'd bundle runs everywhere, and a 3 MB duplicate is
 * cheaper than a second bundle to sign and notarize. See compileWorkspace for
 * why the slices are built per-arch and joined rather than via one two-`--arch`
 * invocation.
 *
 * The build hash is a content address of the *inputs*: source tree, version,
 * commit, and target triple. It cannot be a hash of the output, because the
 * output embeds the hash — that circularity is why Hive addresses what it built
 * from rather than what it built. The property the daemon handshake needs holds
 * either way: two different releases always disagree, and a rebuild of one
 * release always agrees with itself.
 *
 * Signing, when the environment carries a Developer ID (see sign.ts), happens
 * after every artifact is built and before any digest is taken: Apple's tools
 * rewrite the signature into the Mach-O and stapling rewrites the app bundle, so
 * the SHA-256 the manifest records must be of the final, signed, stapled bytes —
 * the exact bytes `hive update` will re-hash on the way in. With no Developer ID
 * in the environment this step is skipped entirely and the artifacts go out
 * unsigned — the graceful-degradation path for a fork, not the one Hive's own
 * pipeline takes.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { currentBuildHash } from "../daemon/handshake";
import { DAEMON_SCHEMA_EPOCH, DAEMON_WIRE_PROTOCOL } from "../daemon/handshake";
import {
  buildEmbeddingsRuntimeArtifact,
  EMBEDDINGS_RUNTIME_ASSET,
  findSourceNodeModules,
} from "./embeddings-runtime";
import {
  MANIFEST_ASSET,
  parseReleaseManifest,
  RELEASE_MANIFEST_SCHEMA,
  type ReleaseArtifact,
  type ReleaseManifest,
} from "./manifest";
import { signRelease, signingConfigFromEnv, type SigningConfig } from "./sign";

const TARGETS = [
  { arch: "arm64", bunTarget: "bun-darwin-arm64", asset: "hive-darwin-arm64" },
  { arch: "x64", bunTarget: "bun-darwin-x64", asset: "hive-darwin-x64" },
] as const;

const WORKSPACE_ASSET = "HiveWorkspace.tar.gz";
const WORKSPACE_BUNDLE = "HiveWorkspace.app";
const DEFAULT_ENTITLEMENTS = "scripts/signing/entitlements.plist";
const SESSIOND_TARGETS = [
  { arch: "arm64" as const, zigArch: "aarch64", asset: "hive-sessiond-darwin-arm64" },
  { arch: "x64" as const, zigArch: "x86_64", asset: "hive-sessiond-darwin-x64" },
];

interface Options {
  version: string;
  commit: string;
  buildDate: string;
  out: string;
  repoRoot: string;
  publicKey: string | null;
  securityCritical: boolean;
  skipWorkspace: boolean;
  skipSessiond: boolean;
  skipEmbeddings: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const version = get("--version");
  if (version === null) throw new Error("--version is required");
  const repoRoot = resolve(get("--repo-root") ?? process.cwd());
  return {
    version,
    commit: get("--commit") ?? "unknown",
    buildDate: get("--build-date") ?? new Date().toISOString(),
    out: resolve(get("--out") ?? join(repoRoot, "dist")),
    repoRoot,
    publicKey: get("--public-key"),
    securityCritical: argv.includes("--security-critical"),
    skipWorkspace: argv.includes("--skip-workspace"),
    skipSessiond: argv.includes("--skip-sessiond"),
    skipEmbeddings: argv.includes("--skip-embeddings"),
  };
}

async function sh(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

async function digest(path: string): Promise<{ sha256: string; size: number }> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function output(command: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
  return text;
}

export function machoRpaths(otoolOutput: string): string[] {
  const paths: string[] = [];
  let awaitingPath = false;
  for (const line of otoolOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "cmd LC_RPATH") {
      awaitingPath = true;
      continue;
    }
    if (!awaitingPath || !trimmed.startsWith("path ")) continue;
    paths.push(trimmed.slice("path ".length).replace(/ \(offset \d+\)$/, ""));
    awaitingPath = false;
  }
  return [...new Set(paths)];
}

export function nonSystemMachODependencies(otoolOutput: string): string[] {
  return [...new Set(
    otoolOutput.split("\n")
      .filter((line) => /^\s+(?:\/|@)/.test(line))
      .map((line) => line.trim())
      .map((line) => line.split(" (compatibility version", 1)[0]!)
      .filter((path) =>
        !path.startsWith("/System/Library/") &&
        !path.startsWith("/usr/lib/")
      ),
  )];
}

/**
 * SwiftPM carries its build toolchain's absolute Swift-library RPATH into the
 * linked executable. The app uses only macOS system libraries, so remove every
 * absolute non-system RPATH and prove the final executable has no external
 * dynamic-library dependency before it can be signed or archived.
 */
async function makeWorkspaceSelfContained(executable: string, cwd: string): Promise<void> {
  const initial = machoRpaths(
    await output(["/usr/bin/otool", "-l", executable], cwd),
  );
  for (const path of initial) {
    if (
      path.startsWith("/") &&
      !path.startsWith("/System/Library/") &&
      !path.startsWith("/usr/lib/")
    ) {
      await sh(["/usr/bin/install_name_tool", "-delete_rpath", path, executable], cwd);
    }
  }

  const remaining = machoRpaths(
    await output(["/usr/bin/otool", "-l", executable], cwd),
  ).filter((path) =>
    path.startsWith("/") &&
    !path.startsWith("/System/Library/") &&
    !path.startsWith("/usr/lib/")
  );
  if (remaining.length > 0) {
    throw new Error(
      `Workspace executable retains build-machine RPATHs: ${remaining.join(", ")}`,
    );
  }

  const dependencies = nonSystemMachODependencies(
    await output(["/usr/bin/otool", "-L", executable], cwd),
  );
  if (dependencies.length > 0) {
    throw new Error(
      `Workspace executable links non-system libraries: ${dependencies.join(", ")}`,
    );
  }
}

/** Content address of the inputs; see the header. */
function buildHashFor(sourceHash: string, options: Options, target: string): string {
  return createHash("sha256")
    .update("hive-build-v1\0")
    .update(sourceHash).update("\0")
    .update(options.version).update("\0")
    .update(options.commit).update("\0")
    .update(target)
    .digest("hex");
}

interface CliBuild {
  readonly target: (typeof TARGETS)[number];
  readonly buildHash: string;
  readonly outfile: string;
}

/**
 * Compile one CLI slice. When the build will be signed, compile with
 * `BUN_NO_CODESIGN_MACHO_BINARY=1`: Bun's own ad-hoc signature reserves too
 * little space in __LINKEDIT (oven-sh/bun#29120), and codesign re-signing on top
 * of it produces a truncated signature that fails `codesign --verify --strict`.
 * The env var makes the compiled binary re-signable; sign.ts's header records
 * the proof. Unsigned builds keep Bun's default so today's output is unchanged.
 */
async function compileCli(
  options: Options,
  target: (typeof TARGETS)[number],
  sourceHash: string,
  buildHash: string,
  signed: boolean,
): Promise<CliBuild> {
  const outfile = join(options.out, target.asset);
  const defines = [
    ["HIVE_BUILD_VERSION", options.version],
    ["HIVE_BUILD_COMMIT", options.commit],
    ["HIVE_BUILD_DATE", options.buildDate],
    ["HIVE_BUILD_HASH", buildHash],
    ["HIVE_SOURCE_HASH", sourceHash],
    ...(options.publicKey === null
      ? []
      : [["HIVE_RELEASE_PUBLIC_KEY", options.publicKey]]),
  ].flatMap(([name, value]) => [
    "--define",
    // JSON-encode so the value lands as a string literal in the bundle.
    `process.env.${name}=${JSON.stringify(value)}`,
  ]);

  await sh(
    [
      "bun", "build", "--compile",
      `--target=${target.bunTarget}`,
      ...defines,
      "src/cli.ts",
      "--outfile", outfile,
    ],
    options.repoRoot,
    signed ? { BUN_NO_CODESIGN_MACHO_BINARY: "1" } : undefined,
  );

  return { target, buildHash, outfile };
}

const INFO_PLIST = (version: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>HiveWorkspace</string>
  <key>CFBundleIdentifier</key><string>dev.hive.workspace</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIconName</key><string>AppIcon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Hive Workspace</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`;

/**
 * Build the universal .app bundle and leave it on disk; return its path.
 *
 * Each architecture is built separately with SwiftPM's native build system
 * and the executables are joined with `lipo -create`. The single-invocation
 * form (`swift build --arch arm64 --arch x86_64`) hands the build to xcbuild,
 * which links the GhosttyKit binary target's lib-prefixed archive as
 * `-lghostty-internal` while emitting no library search path on the object
 * libraries it partial-links, so the build fails with "library not found"
 * (Xcode 26.6; the native build system passes the archive by full path). The
 * output is the same one universal bundle either way.
 */
async function compileWorkspace(options: Options): Promise<string> {
  const workspace = join(options.repoRoot, "workspace");
  const binPaths: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    await sh(["swift", "build", "-c", "release", "--arch", arch], workspace);
    binPaths.push(
      (await Bun.$`swift build -c release --arch ${arch} --show-bin-path`
        .cwd(workspace).text()).trim(),
    );
  }

  const bundle = join(options.out, WORKSPACE_BUNDLE);
  const macos = join(bundle, "Contents", "MacOS");
  const resources = join(bundle, "Contents", "Resources");
  await rm(bundle, { recursive: true, force: true });
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(join(bundle, "Contents", "Info.plist"), INFO_PLIST(options.version));
  await copyFile(join(workspace, "Resources", "AppIcon.icns"), join(resources, "AppIcon.icns"));
  await copyFile(join(workspace, "Resources", "Assets.car"), join(resources, "Assets.car"));
  // SPM target resources (vendor marks for the Model Control Center).
  // Bundle.module resolves against Bundle.main.resourceURL in a bundled app,
  // so the generated bundle must ship inside Contents/Resources. The bundle
  // is architecture-independent; either slice's copy is the same bytes.
  await sh(
    ["cp", "-R", join(binPaths[0]!, "HiveWorkspace_HiveWorkspace.bundle"), resources],
    options.repoRoot,
  );
  await sh(
    [
      "lipo", "-create",
      ...binPaths.map((binPath) => join(binPath, "HiveWorkspace")),
      "-output", join(macos, "HiveWorkspace"),
    ],
    options.repoRoot,
  );
  await makeWorkspaceSelfContained(join(macos, "HiveWorkspace"), options.repoRoot);
  return bundle;
}

interface SessiondBuild {
  readonly target: (typeof SESSIOND_TARGETS)[number];
  readonly buildHash: string;
  readonly outfile: string;
}

/**
 * Build one `hive-sessiond` slice with the locked Zig and ReleaseFast, so the
 * embedded VT engine fingerprint matches the Workspace release GhosttyKit.
 * Debug vs ReleaseFast is an intentional fence failure — never stage Debug.
 */
async function compileSessiond(
  options: Options,
  target: (typeof SESSIOND_TARGETS)[number],
  buildHash: string,
): Promise<SessiondBuild> {
  const lockPath = join(options.repoRoot, "native/toolchain-lock.json");
  const zigVersion = (await Bun.$`/usr/bin/plutil -extract zig.version raw -o - ${lockPath}`.text()).trim();
  const deploymentTarget = (await Bun.$`/usr/bin/plutil -extract deploymentTarget raw -o - ${lockPath}`.text()).trim();
  const nativeCache =
    process.env.HIVE_NATIVE_CACHE ??
    join(process.env.HOME ?? "", ".cache/hive/native");
  // System zig from PATH; the lock pins the exact version.
  const zig = Bun.which("zig");
  if (!zig) {
    throw new Error(
      `zig is not on PATH; install Zig ${zigVersion} (brew install zig@0.15 && brew link --force zig@0.15)`,
    );
  }
  const actualZigVersion = (await Bun.$`${zig} version`.text()).trim();
  if (actualZigVersion !== zigVersion) {
    throw new Error(
      `zig on PATH is ${actualZigVersion}; the toolchain lock requires ${zigVersion}`,
    );
  }

  const prefix = join(options.out, `sessiond-${target.arch}`);
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });

  const overlayProc = Bun.spawn(
    [join(options.repoRoot, "scripts/prepare-zig-xcode-overlay.sh")],
    { cwd: options.repoRoot, stdout: "pipe", stderr: "inherit" },
  );
  const overlay = (await new Response(overlayProc.stdout).text()).trim();
  if ((await overlayProc.exited) !== 0 || overlay.length === 0) {
    throw new Error("prepare-zig-xcode-overlay.sh failed");
  }

  const zigRunnerTools = join(options.repoRoot, "scripts/zig-runner-tools");
  await sh(
    [
      zig, "build", "install",
      "--prefix", prefix,
      "--global-cache-dir", join(nativeCache, "zig-global"),
      `-Dtarget=${target.zigArch}-macos.${deploymentTarget}`,
      "-Doptimize=ReleaseFast",
      "--sysroot", overlay,
    ],
    join(options.repoRoot, "native/sessiond"),
    { PATH: `${zigRunnerTools}:${process.env.PATH ?? ""}` },
  );

  const built = join(prefix, "bin", "hive-sessiond");
  if (!(await Bun.file(built).exists())) {
    throw new Error(`sessiond ${target.arch} build produced no binary at ${built}`);
  }
  const outfile = join(options.out, target.asset);
  await copyFile(built, outfile);
  return { target, buildHash, outfile };
}

/** Tar the (now signed and stapled) bundle, digest it, and clean up. */
async function finalizeWorkspace(options: Options, bundle: string): Promise<ReleaseArtifact[]> {
  const tarball = join(options.out, WORKSPACE_ASSET);
  await sh(["tar", "-czf", tarball, "-C", options.out, WORKSPACE_BUNDLE], options.repoRoot);
  await rm(bundle, { recursive: true, force: true });

  const stat = await digest(tarball);
  // One universal bundle, listed for both architectures so `selectArtifact`
  // resolves on either machine.
  return TARGETS.map((target) => ({
    name: WORKSPACE_ASSET,
    kind: "workspace" as const,
    platform: "darwin" as const,
    arch: target.arch,
    buildHash: stat.sha256,
    ...stat,
  }));
}

/**
 * The embedding runtime `hive embeddings install` downloads on machines
 * without a checkout. Staged from this checkout's node_modules through the
 * exact pipeline the CLI's own install uses (src/release/embeddings-runtime.ts),
 * so the shipped bytes are the bytes the dev flow produces. The bundle is
 * darwin-universal — onnxruntime-node ships both darwin slices in one package
 * and the tokenizers binding is a universal napi binary — so, like the
 * Workspace tarball, one asset is listed for both architectures. Nothing in
 * it is Developer-ID-signed (they are upstream napi binaries); its trust
 * anchor is the manifest SHA-256, exactly like every other artifact.
 */
async function buildEmbeddingsRuntime(options: Options): Promise<ReleaseArtifact[]> {
  const source = await findSourceNodeModules(
    join(options.repoRoot, "node_modules"),
  );
  if (source === null) {
    throw new Error(
      "no node_modules containing fastembed under the repo root — " +
        "run `bun install` before building the release",
    );
  }
  const artifact = await buildEmbeddingsRuntimeArtifact({
    sourceNodeModules: source,
    outDir: options.out,
  });
  return TARGETS.map((target) => ({
    name: EMBEDDINGS_RUNTIME_ASSET,
    kind: "embeddings" as const,
    platform: "darwin" as const,
    arch: target.arch,
    buildHash: artifact.sha256,
    sha256: artifact.sha256,
    size: artifact.size,
  }));
}

export async function build(options: Options): Promise<ReleaseManifest> {
  await mkdir(options.out, { recursive: true });
  const sourceHash = await currentBuildHash();
  const signing: SigningConfig | null = signingConfigFromEnv(
    process.env,
    join(options.repoRoot, DEFAULT_ENTITLEMENTS),
  );

  // Build everything first, unsigned, so signing sees final on-disk artifacts.
  const cliBuilds: CliBuild[] = [];
  for (const target of TARGETS) {
    cliBuilds.push(
      await compileCli(
        options,
        target,
        sourceHash,
        buildHashFor(sourceHash, options, target.bunTarget),
        signing !== null,
      ),
    );
  }
  const sessiondBuilds: SessiondBuild[] = [];
  if (!options.skipSessiond) {
    for (const target of SESSIOND_TARGETS) {
      sessiondBuilds.push(
        await compileSessiond(
          options,
          target,
          buildHashFor(sourceHash, options, `sessiond-${target.zigArch}-ReleaseFast`),
        ),
      );
    }
  }
  const appBundle = options.skipWorkspace ? null : await compileWorkspace(options);
  // Not signed (upstream napi binaries, not ours to re-sign) — built here so
  // it is digested alongside everything else below.
  const embeddingsArtifacts = options.skipEmbeddings
    ? null
    : await buildEmbeddingsRuntime(options);

  // Sign, notarize, and staple in place. A no-op when no Developer ID is set.
  // Sessiond Mach-Os take the same Developer ID path as the CLI slices.
  if (signing !== null) {
    await signRelease({
      cliSlices: [
        ...cliBuilds.map((build) => build.outfile),
        ...sessiondBuilds.map((build) => build.outfile),
      ],
      appBundle,
    }, signing);
  }

  // Digest last, so the manifest records the signed and stapled bytes.
  const artifacts: ReleaseArtifact[] = [];
  for (const build of cliBuilds) {
    artifacts.push({
      name: build.target.asset,
      kind: "cli",
      platform: "darwin",
      arch: build.target.arch,
      buildHash: build.buildHash,
      ...(await digest(build.outfile)),
    });
  }
  for (const build of sessiondBuilds) {
    artifacts.push({
      name: build.target.asset,
      kind: "sessiond",
      platform: "darwin",
      arch: build.target.arch,
      buildHash: build.buildHash,
      ...(await digest(build.outfile)),
    });
  }
  if (appBundle !== null) {
    artifacts.push(...(await finalizeWorkspace(options, appBundle)));
  }
  if (embeddingsArtifacts !== null) {
    artifacts.push(...embeddingsArtifacts);
  }

  const manifest = parseReleaseManifest({
    schema: RELEASE_MANIFEST_SCHEMA,
    version: options.version,
    tag: `v${options.version}`,
    channel: "stable",
    commit: options.commit,
    publishedAt: options.buildDate,
    securityCritical: options.securityCritical,
    wireProtocol: { ...DAEMON_WIRE_PROTOCOL },
    schemaEpoch: DAEMON_SCHEMA_EPOCH,
    artifacts,
  });
  await writeFile(
    join(options.out, MANIFEST_ASSET),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await build(options);
  console.log(`built hive ${manifest.version} -> ${options.out}`);
  for (const artifact of manifest.artifacts) {
    console.log(`  ${artifact.name} ${artifact.arch} ${artifact.sha256.slice(0, 12)}`);
  }
}
