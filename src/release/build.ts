#!/usr/bin/env bun
/** Build the release artifacts and the manifest that describes them. `bun run src/release/build.ts --version 0.0.7 --commit abc1234 --out dist` Two CLI binaries (`darwin-arm64`, `darwin-x64`), two `hive-sessiond` broker binaries (same arches), one universal Workspace application, and the universal embedding runtime tarball (`embeddings-runtime.tar.gz`) that the installer downloads on machines without a checkout — built through the same pipeline the CLI's dev install uses, so the shipped bytes are those bytes. Sessiond is built ReleaseFast so its embedded Ghostty VT engine fingerprint matches the Workspace release renderer — a Debug sessiond against a ReleaseFast renderer fails the engine-build fence by design. The app is universal rather than sliced because one lipo'd bundle runs everywhere, and a 3 MB duplicate is cheaper than a second bundle to sign and notarize. See compileWorkspace for why the slices are built per-arch and joined rather than via one two-`--arch` invocation. The build hash is a content address of the *inputs*: source tree, version, commit, target triple, and — for the CLI, whose bytes carry it as a define — the variant. It cannot be a hash of the output, because the output embeds the hash — that circularity is why Hive addresses what it built from rather than what it built. The property the daemon handshake needs holds either way: two different releases always disagree, and a rebuild of one release always agrees with itself. Signing, when the environment carries a Developer ID (see sign.ts), happens after every artifact is built and before any digest is taken: Apple's tools rewrite the signature into the Mach-O and stapling rewrites the app bundle, so the SHA-256 the manifest records must be of the final, signed, stapled bytes — the exact bytes `hive update` will re-hash on the way in. With no Developer ID in the environment this step is skipped entirely and the artifacts go out unsigned — the graceful-degradation path for a fork, not the one Hive's own pipeline takes. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  currentBuildHash,
  DAEMON_SCHEMA_EPOCH,
  DAEMON_WIRE_PROTOCOL,
} from "../daemon/lifecycle/daemon-lifecycle";
import { type HiveVariant, parseVariant } from "../hive-home/variant";
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
import { type SigningConfig, signingConfigFromEnv, signRelease } from "./sign";

const TARGETS = [
  { arch: "arm64", bunTarget: "bun-darwin-arm64", asset: "hive-darwin-arm64" },
  { arch: "x64", bunTarget: "bun-darwin-x64", asset: "hive-darwin-x64" },
] as const;

const WORKSPACE_ASSET = "HiveWorkspace.tar.gz";
export const WORKSPACE_BUNDLE = "HiveWorkspace.app";
const DEFAULT_ENTITLEMENTS = "scripts/signing/entitlements.plist";
const SESSIOND_TARGETS = [
  {
    arch: "arm64" as const,
    zigArch: "aarch64",
    asset: "hive-sessiond-darwin-arm64",
  },
  {
    arch: "x64" as const,
    zigArch: "x86_64",
    asset: "hive-sessiond-darwin-x64",
  },
];

interface Options {
  version: string;
  commit: string;
  buildDate: string;
  out: string;
  repoRoot: string;
  publicKey: string | null;
  variant: HiveVariant;
  securityCritical: boolean;
  skipWorkspace: boolean;
  skipSessiond: boolean;
  skipEmbeddings: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
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
    // Absent means prod, and which names are legal is decided in src/hive-home/variant.ts rather
    // than restated here — the binary reads its compiled-in value through the same function.
    variant: parseVariant(get("--variant") ?? undefined),
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
  return [
    ...new Set(
      otoolOutput
        .split("\n")
        .filter((line) => /^\s+(?:\/|@)/.test(line))
        .map((line) => line.trim())
        .map((line) => line.split(" (compatibility version", 1)[0] ?? "")
        .filter(
          (path) =>
            !path.startsWith("/System/Library/") &&
            !path.startsWith("/usr/lib/"),
        ),
    ),
  ];
}

async function makeWorkspaceSelfContained(
  executable: string,
  cwd: string,
): Promise<void> {
  const initial = machoRpaths(
    await output(["/usr/bin/otool", "-l", executable], cwd),
  );
  for (const path of initial) {
    if (
      path.startsWith("/") &&
      !path.startsWith("/System/Library/") &&
      !path.startsWith("/usr/lib/")
    ) {
      await sh(
        ["/usr/bin/install_name_tool", "-delete_rpath", path, executable],
        cwd,
      );
    }
  }

  const remaining = machoRpaths(
    await output(["/usr/bin/otool", "-l", executable], cwd),
  ).filter(
    (path) =>
      path.startsWith("/") &&
      !path.startsWith("/System/Library/") &&
      !path.startsWith("/usr/lib/"),
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

/** The one definition of a Hive build hash. Shared by the release pipeline and its tests so a second derivation cannot become a second answer to the question the daemon handshake asks.
 *
 * This is a content address, so it must cover everything that changes the content and nothing that does not. `variant` is therefore an input for the CLI, whose bytes carry the variant as a compiled-in define, and null for sessiond, whose Zig bytes are identical whichever variant is being built — a hash that moved for an artifact that did not would be as wrong as one that stayed for an artifact that did. The version prefix is `v2` because adding that field changed every value this function returns. */
export function buildHashFor(
  sourceHash: string,
  version: string,
  commit: string,
  target: string,
  variant: HiveVariant | null,
): string {
  return createHash("sha256")
    .update("hive-build-v2\0")
    .update(sourceHash)
    .update("\0")
    .update(version)
    .update("\0")
    .update(commit)
    .update("\0")
    .update(target)
    .update("\0")
    .update(variant ?? "")
    .digest("hex");
}

interface CliBuild {
  readonly target: (typeof TARGETS)[number];
  readonly buildHash: string;
  readonly outfile: string;
}

/** Only a keyed release can trust a runtime digest compiled into its CLI. Unsigned local builds restage the runtime during `hive init`, and Bun embeds the staging path in the generated bundle, so those bytes cannot equal the release-build staging tree. */
export function embeddingsDigestForBuild(
  publicKey: string | null,
  loadedDigest: string,
): string | null {
  return publicKey === null ? null : loadedDigest;
}

/** Everything a CLI binary is told about itself at compile time. Each `--define` rewrites a `process.env.X` member expression into a string literal before the bundle is written, so none of these can be changed by exporting a variable at the finished binary — which is the whole reason they are compiled in rather than read. Exported so the list itself can be asserted: it decides the binary's identity, its trust anchor and the one capability that is absent from production, and a value silently dropped from it would fail open. */
export function cliDefines(
  options: Pick<
    Options,
    "version" | "commit" | "buildDate" | "publicKey" | "variant"
  >,
  sourceHash: string,
  buildHash: string,
  embeddingsDigest: string | null,
): string[] {
  return [
    ["HIVE_BUILD_VERSION", options.version],
    ["HIVE_BUILD_COMMIT", options.commit],
    ["HIVE_BUILD_DATE", options.buildDate],
    ["HIVE_BUILD_HASH", buildHash],
    ["HIVE_SOURCE_HASH", sourceHash],
    // Which variant this binary IS. Always emitted, including for prod: a define that is only
    // sometimes present leaves a build whose variant is decided by whatever the environment held.
    ["HIVE_BUILD_VARIANT", options.variant],
    ...(options.publicKey === null
      ? []
      : [["HIVE_RELEASE_PUBLIC_KEY", options.publicKey]]),
    // The embedding runtime's loaded-surface digest, so the binary can refuse a tampered runtime. Compiled in, never read from the environment: a digest an attacker could set is not a digest.
    ...(embeddingsDigest === null
      ? []
      : [["HIVE_EMBEDDINGS_DIGEST", embeddingsDigest]]),
  ].flatMap(([name, value]) => [
    "--define",
    `process.env.${name}=${JSON.stringify(value)}`,
  ]);
}

async function compileCli(
  options: Options,
  target: (typeof TARGETS)[number],
  sourceHash: string,
  buildHash: string,
  signed: boolean,
  embeddingsDigest: string | null,
): Promise<CliBuild> {
  const outfile = join(options.out, target.asset);
  const defines = cliDefines(options, sourceHash, buildHash, embeddingsDigest);

  // `bun build --compile` copies its runtime binary into the process cwd as
  // `.<id>-00000000.bun-build` and never removes it, not even on a successful
  // build — with cwd = repoRoot every release compile left a 61 MB executable
  // beside the checkout. Run the compile from an owned scratch directory
  // instead; the finally removes it and whatever Bun left inside. Entry points
  // go absolute so the scratch cwd cannot change module resolution.
  const scratch = await mkdtemp(join(tmpdir(), "hive-release-compile-"));
  try {
    await sh(
      [
        "bun",
        "build",
        "--compile",
        `--target=${target.bunTarget}`,
        ...defines,
        join(options.repoRoot, "src/cli.ts"),
        join(options.repoRoot, "src/cli/agent-ui/unified-diff-worker.ts"),
        "--outfile",
        outfile,
      ],
      scratch,
      signed ? { BUN_NO_CODESIGN_MACHO_BINARY: "1" } : undefined,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

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

/** Compile the Workspace app bundle to an explicit path. Host-only is enough for an install the owner can activate; the release pipeline still builds both arches by omitting `arches`. */
export async function compileWorkspaceTo(args: {
  repoRoot: string;
  outBundle: string;
  version: string;
  arches?: readonly string[];
  sourceDate?: string;
}): Promise<void> {
  const workspace = join(args.repoRoot, "workspace");
  const arches = args.arches ?? ["arm64", "x86_64"];
  const swiftEnv =
    args.sourceDate === undefined
      ? undefined
      : {
          ZERO_AR_DATE: "1",
          SOURCE_DATE_EPOCH: String(
            Math.floor(Date.parse(args.sourceDate) / 1000),
          ),
          TZ: "UTC",
        };
  const binPaths: string[] = [];
  for (const arch of arches) {
    await sh(
      ["swift", "build", "-c", "release", "--arch", arch],
      workspace,
      swiftEnv,
    );
    binPaths.push(
      (
        await Bun.$`swift build -c release --arch ${arch} --show-bin-path`
          .cwd(workspace)
          .text()
      ).trim(),
    );
  }

  const bundle = args.outBundle;
  const macos = join(bundle, "Contents", "MacOS");
  const resources = join(bundle, "Contents", "Resources");
  await rm(bundle, { recursive: true, force: true });
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    INFO_PLIST(args.version),
  );
  await copyFile(
    join(workspace, "Resources", "AppIcon.icns"),
    join(resources, "AppIcon.icns"),
  );
  await copyFile(
    join(workspace, "Resources", "Assets.car"),
    join(resources, "Assets.car"),
  );
  const resourceBinPath = binPaths[0];
  if (resourceBinPath === undefined) {
    throw new Error("Swift build produced no binary path");
  }
  await sh(
    [
      "cp",
      "-R",
      join(resourceBinPath, "HiveWorkspace_HiveWorkspace.bundle"),
      resources,
    ],
    args.repoRoot,
  );
  const executable = join(macos, "HiveWorkspace");
  if (binPaths.length === 1) {
    await copyFile(join(resourceBinPath, "HiveWorkspace"), executable);
  } else {
    await sh(
      [
        "lipo",
        "-create",
        ...binPaths.map((binPath) => join(binPath, "HiveWorkspace")),
        "-output",
        executable,
      ],
      args.repoRoot,
    );
  }
  await makeWorkspaceSelfContained(executable, args.repoRoot);
}

async function compileWorkspace(options: Options): Promise<string> {
  const bundle = join(options.out, WORKSPACE_BUNDLE);
  await compileWorkspaceTo({
    repoRoot: options.repoRoot,
    outBundle: bundle,
    version: options.version,
  });
  return bundle;
}

interface SessiondBuild {
  readonly target: (typeof SESSIOND_TARGETS)[number];
  readonly buildHash: string;
  readonly outfile: string;
}

/** Build one `hive-sessiond` slice with the locked Zig and ReleaseFast into an explicit file. The factory calls this instead of `make build` so the bytes land in the attester's staging directory, never relative to the caller's working directory. Debug vs ReleaseFast is an intentional fence failure — never stage Debug. */
export async function compileSessiondTo(args: {
  repoRoot: string;
  outFile: string;
  zigArch: string;
}): Promise<void> {
  const lockPath = join(args.repoRoot, "native/toolchain-lock.json");
  const zigVersion = (
    await Bun.$`/usr/bin/plutil -extract zig.version raw -o - ${lockPath}`.text()
  ).trim();
  const deploymentTarget = (
    await Bun.$`/usr/bin/plutil -extract deploymentTarget raw -o - ${lockPath}`.text()
  ).trim();
  const nativeCache =
    process.env.HIVE_NATIVE_CACHE ??
    join(process.env.HOME ?? "", ".cache/hive/native");
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

  const prefix = `${args.outFile}.prefix`;
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });

  const overlayProc = Bun.spawn(
    [join(args.repoRoot, "scripts/native/prepare-zig-xcode-overlay.sh")],
    { cwd: args.repoRoot, stdout: "pipe", stderr: "inherit" },
  );
  const overlay = (await new Response(overlayProc.stdout).text()).trim();
  if ((await overlayProc.exited) !== 0 || overlay.length === 0) {
    throw new Error("prepare-zig-xcode-overlay.sh failed");
  }

  const zigRunnerTools = join(args.repoRoot, "scripts/native/zig-runner-tools");
  await sh(
    [
      zig,
      "build",
      "install",
      "--prefix",
      prefix,
      "--global-cache-dir",
      join(nativeCache, "zig-global"),
      `-Dtarget=${args.zigArch}-macos.${deploymentTarget}`,
      "-Doptimize=ReleaseFast",
      "--sysroot",
      overlay,
    ],
    join(args.repoRoot, "native/sessiond"),
    { PATH: `${zigRunnerTools}:${process.env.PATH ?? ""}` },
  );

  const built = join(prefix, "bin", "hive-sessiond");
  if (!(await Bun.file(built).exists())) {
    throw new Error(
      `sessiond ${args.zigArch} build produced no binary at ${built}`,
    );
  }
  await mkdir(dirname(args.outFile), { recursive: true });
  await copyFile(built, args.outFile);
  await rm(prefix, { recursive: true, force: true });
}

/** Build one `hive-sessiond` slice with the locked Zig and ReleaseFast, so the embedded VT engine fingerprint matches the Workspace release GhosttyKit. Debug vs ReleaseFast is an intentional fence failure — never stage Debug. */
async function compileSessiond(
  options: Options,
  target: (typeof SESSIOND_TARGETS)[number],
  buildHash: string,
): Promise<SessiondBuild> {
  const outfile = join(options.out, target.asset);
  await compileSessiondTo({
    repoRoot: options.repoRoot,
    outFile: outfile,
    zigArch: target.zigArch,
  });
  return { target, buildHash, outfile };
}

async function finalizeWorkspace(
  options: Options,
  bundle: string,
): Promise<ReleaseArtifact[]> {
  const tarball = join(options.out, WORKSPACE_ASSET);
  await sh(
    ["tar", "-czf", tarball, "-C", options.out, WORKSPACE_BUNDLE],
    options.repoRoot,
  );
  await rm(bundle, { recursive: true, force: true });

  const stat = await digest(tarball);
  return TARGETS.map((target) => ({
    name: WORKSPACE_ASSET,
    kind: "workspace" as const,
    platform: "darwin" as const,
    arch: target.arch,
    buildHash: stat.sha256,
    ...stat,
  }));
}

/** The embedding runtime the installer downloads on machines without a checkout. Staged from this checkout's node_modules through the exact pipeline the CLI's own install uses (src/release/embeddings-runtime.ts), so the shipped bytes are the bytes the dev flow produces. The bundle is darwin-universal — onnxruntime-node ships both darwin slices in one package and the tokenizers binding is a universal napi binary — so, like the Workspace tarball, one asset is listed for both architectures. Nothing in it is Developer-ID-signed (they are upstream napi binaries); its trust anchor is the manifest SHA-256, exactly like every other artifact. */
async function buildEmbeddingsRuntime(
  options: Options,
): Promise<{ artifacts: ReleaseArtifact[]; loadedDigest: string }> {
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
  return {
    artifacts: TARGETS.map((target) => ({
      name: EMBEDDINGS_RUNTIME_ASSET,
      kind: "embeddings" as const,
      platform: "darwin" as const,
      arch: target.arch,
      buildHash: artifact.sha256,
      sha256: artifact.sha256,
      size: artifact.size,
    })),
    loadedDigest: artifact.loadedDigest,
  };
}

export async function build(options: Options): Promise<ReleaseManifest> {
  await mkdir(options.out, { recursive: true });
  const sourceHash = await currentBuildHash();
  const signing: SigningConfig | null = signingConfigFromEnv(
    process.env,
    join(options.repoRoot, DEFAULT_ENTITLEMENTS),
  );

  // The embedding runtime is staged FIRST, before the CLI compiles, because the CLI must carry the digest of the runtime it will be shipped beside — that constant is what lets a release binary refuse a tampered runtime, and the binary cannot be given it after it is compiled and signed. Not signed itself (upstream napi binaries, not ours to re-sign).
  const embeddings = options.skipEmbeddings
    ? null
    : await buildEmbeddingsRuntime(options);
  if (embeddings === null && options.publicKey !== null) {
    throw new Error(
      "refusing to build a keyed release with --skip-embeddings: the CLI would " +
        "ship without the embedding runtime digest and could not verify the " +
        "runtime it loads",
    );
  }

  const cliBuilds: CliBuild[] = [];
  for (const target of TARGETS) {
    cliBuilds.push(
      await compileCli(
        options,
        target,
        sourceHash,
        buildHashFor(
          sourceHash,
          options.version,
          options.commit,
          target.bunTarget,
          options.variant,
        ),
        signing !== null,
        embeddings === null
          ? null
          : embeddingsDigestForBuild(
              options.publicKey,
              embeddings.loadedDigest,
            ),
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
          buildHashFor(
            sourceHash,
            options.version,
            options.commit,
            `sessiond-${target.zigArch}-ReleaseFast`,
            // Zig gets no variant define, so two variants produce identical sessiond bytes.
            null,
          ),
        ),
      );
    }
  }
  const appBundle = options.skipWorkspace
    ? null
    : await compileWorkspace(options);

  // Sign, notarize, and staple in place. A no-op when no Developer ID is set. Sessiond Mach-Os take the same Developer ID path as the CLI slices.
  if (signing !== null) {
    await signRelease(
      {
        cliSlices: [
          ...cliBuilds.map((build) => build.outfile),
          ...sessiondBuilds.map((build) => build.outfile),
        ],
        appBundle,
      },
      signing,
    );
  }

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
  if (embeddings !== null) {
    artifacts.push(...embeddings.artifacts);
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
    console.log(
      `  ${artifact.name} ${artifact.arch} ${artifact.sha256.slice(0, 12)}`,
    );
  }
}
