#!/usr/bin/env bun
/**
 * Build the release artifacts and the manifest that describes them.
 *
 * `bun run src/release/build.ts --version 0.0.7 --commit abc1234 --out dist`
 *
 * Two CLI binaries (`darwin-arm64`, `darwin-x64`) and one universal Workspace
 * application. The app is universal rather than sliced because one lipo'd
 * bundle runs everywhere, and a 3 MB duplicate is cheaper than a second
 * bundle to sign and notarize. See compileWorkspace for why the slices are
 * built per-arch and joined rather than via one two-`--arch` invocation.
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

interface Options {
  version: string;
  commit: string;
  buildDate: string;
  out: string;
  repoRoot: string;
  publicKey: string | null;
  securityCritical: boolean;
  skipWorkspace: boolean;
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
  buildHash: string,
  signed: boolean,
): Promise<CliBuild> {
  const outfile = join(options.out, target.asset);
  const defines = [
    ["HIVE_BUILD_VERSION", options.version],
    ["HIVE_BUILD_COMMIT", options.commit],
    ["HIVE_BUILD_DATE", options.buildDate],
    ["HIVE_BUILD_HASH", buildHash],
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
  return bundle;
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
        buildHashFor(sourceHash, options, target.bunTarget),
        signing !== null,
      ),
    );
  }
  const appBundle = options.skipWorkspace ? null : await compileWorkspace(options);

  // Sign, notarize, and staple in place. A no-op when no Developer ID is set.
  if (signing !== null) {
    await signRelease({ cliSlices: cliBuilds.map((build) => build.outfile), appBundle }, signing);
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
  if (appBundle !== null) {
    artifacts.push(...(await finalizeWorkspace(options, appBundle)));
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
