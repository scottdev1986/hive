/** The producer half of the proof factory: the only thing here that compiles, and the only thing here that is not allowed to have an opinion about what it compiled.
 *
 * It is a separate program run as a separate process for one reason. A self-signed proof is worth nothing exactly when the build is the thing that went wrong, so the process that makes the bytes may not be the process that certifies them. What enforces that is not a rule but the interface: this program is handed a sealed source directory and an absolute output directory, it writes the install bytes there, and it returns nothing else. It computes no digest, writes no manifest, names no artifact, and never learns whether its output was accepted. The artifact's identity is the SHA-256 the attester computes from the bytes on disk afterwards, so a producer claim can never become an artifact identity.
 *
 * Two of this repo's real failures are refused here rather than discouraged:
 *
 * A branch build reaching production. A sealed snapshot is a tree with no `.git` in it, so there is no ref to resolve, no branch to check out, and no working copy to pick up. This program refuses a source directory that carries a `.git`, which means the only thing it can ever compile is whatever the attester already sealed — and the attester only seals `refs/heads/main`. There is no argument here that names a ref, because a build of anything but main must not be expressible.
 *
 * A rebuild from the wrong checkout that staged main's bytes where nothing served them. That happened because the Makefile derives its install paths from `CURDIR`. Nothing here reads the working directory: both paths arrive as arguments and both must be absolute, the output is refused if it sits inside the sealed source or inside any git checkout, and the child compilers run with their working directory pinned to the sealed source. Where the bytes land is a property of the attester that asked, never of the shell that typed the command. */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { type HiveVariant, parseVariant } from "../hive-home/variant";
import { compileSessiondTo, compileWorkspaceTo } from "../release/build";
import {
  buildEmbeddingsRuntimeArtifact,
  EMBEDDINGS_RUNTIME_ASSET,
  findSourceNodeModules,
} from "../release/embeddings-runtime";

/** The compiled Hive CLI: the candidate daemon's bytes. */
export const CLI_ARTIFACT = "hive";

/** The compiled landing fixture, built from the same source with the same stamp so it carries whatever defect the candidate carries. */
export const FIXTURE_ARTIFACT = "hive-landing-fixture";

/** Host-arch sessiond, ReleaseFast, named as the install layout names it. */
export const SESSIOND_ARTIFACT = "hive-sessiond";

/** The Workspace app bundle the owner would launch. */
export const WORKSPACE_ARTIFACT = "HiveWorkspace.app";

/** The embedding runtime tarball `hive init` would install. */
export const EMBEDDINGS_ARTIFACT = EMBEDDINGS_RUNTIME_ASSET;

/** Every file or bundle the factory must leave in the staging directory for a complete install. */
export const INSTALL_ARTIFACTS = [
  CLI_ARTIFACT,
  FIXTURE_ARTIFACT,
  SESSIOND_ARTIFACT,
  WORKSPACE_ARTIFACT,
  EMBEDDINGS_ARTIFACT,
] as const;

export const WORKSPACE_EXECUTABLE = join(
  WORKSPACE_ARTIFACT,
  "Contents",
  "MacOS",
  "HiveWorkspace",
);

/** What `bun build --define` inlines into both binaries. A build stamp is data the producer is given, never data it decides: the attester computes these values from the sealed tree and then requires the same bytes back out of the compiled artifact, which only works while the producer is a courier for them.
 *
 * `buildHash` is nullable because a build with no hash inlined is this repo's real historical defect rather than a hypothetical one. `IS_RELEASE_BUILD` is `HIVE_BUILD_HASH !== null`, so an absent hash makes a compiled binary believe it is a source checkout and re-invoke itself as `[hive, src/cli.ts, …]` — the compiled executable used as if it were Bun. It starts, it answers a handshake, and it fails every child invocation. The producer inlines what it is handed and lets the fixture find that out. */
export interface BuildStamp {
  readonly version: string;
  readonly commit: string;
  readonly buildDate: string;
  readonly buildHash: string | null;
  readonly sourceHash: string | null;
  /** Which variant these bytes are built as. Inlined like the rest of the stamp rather than left to the environment, and an input to `buildHashFor`, so the hash names the artifact the define actually produced. */
  readonly variant: HiveVariant;
}

export interface ProducerRequest {
  /** Absolute path to a sealed source snapshot. Must not be a git checkout. */
  readonly source: string;
  /** Absolute path the attester owns. Must not be inside the source or inside any checkout. */
  readonly out: string;
  readonly stamp: BuildStamp;
  /** Production is a complete install. Tests of the historical CLI defect pass false so they do not compile Zig and Swift. */
  readonly completeInstall?: boolean;
}

function refuse(reason: string): never {
  throw new Error(`producer refused: ${reason}`);
}

function assertSealedSource(source: string): void {
  if (!isAbsolute(source)) {
    refuse(
      `source ${source} is not absolute, so it would resolve against whatever directory the caller happened to be in`,
    );
  }
  if (existsSync(join(source, ".git"))) {
    refuse(
      `source ${source} is a git checkout, not a sealed snapshot; a checkout carries refs and a working tree, and a build that can see either can build something other than main`,
    );
  }
  if (!existsSync(join(source, "package.json"))) {
    refuse(`source ${source} has no package.json, so it is not a Hive tree`);
  }
}

function assertAttesterOwnedOutput(out: string, source: string): void {
  if (!isAbsolute(out)) {
    refuse(
      `output ${out} is not absolute; a relative output is the wrong-checkout failure, where a build succeeds and stages its bytes somewhere nothing reads them`,
    );
  }
  if (out === source || out.startsWith(`${source}${sep}`)) {
    refuse(
      `output ${out} is inside the sealed source ${source}; the source is the input and must not also be the destination`,
    );
  }
  for (let dir = out; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      refuse(
        `output ${out} is inside the git checkout at ${dir}; deployment artifacts belong to the attester, not to any working copy`,
      );
    }
    const parent = dirname(dir);
    if (parent === dir) break;
  }
}

function definesFor(stamp: BuildStamp): string[] {
  const pairs: [string, string | null][] = [
    ["HIVE_BUILD_VERSION", stamp.version],
    ["HIVE_BUILD_COMMIT", stamp.commit],
    ["HIVE_BUILD_DATE", stamp.buildDate],
    ["HIVE_BUILD_HASH", stamp.buildHash],
    ["HIVE_SOURCE_HASH", stamp.sourceHash],
    ["HIVE_BUILD_VARIANT", stamp.variant],
  ];
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== null)
    .flatMap(([name, value]) => [
      "--define",
      `process.env.${name}=${JSON.stringify(value)}`,
    ]);
}

/** Run a child to completion. There is deliberately no deadline: a deadline needs something that terminates a process, and this stage of self-deployment is not permitted to hold that capability for any reason, including a convenient one. A compile that hangs is a compile the operator can see and interrupt. */
async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `producer command failed (exit ${exitCode}): ${command.join(" ")}\n${stderr}`,
    );
  }
}

function nativeCacheDir(): string {
  const configured = process.env.HIVE_NATIVE_CACHE;
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      refuse(
        `HIVE_NATIVE_CACHE ${configured} is not absolute; a relative cache would resolve against the caller's working directory`,
      );
    }
    return configured;
  }
  return join(homedir(), ".cache", "hive", "native");
}

async function lockValue(lock: string, key: string): Promise<string> {
  const child = Bun.spawn(
    ["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", lock],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    refuse(`cannot read ${key} from ${lock}: ${stderr.trim()}`);
  }
  return stdout.trim();
}

/** Stage the lock-keyed GhosttyKit from the shared cache into the sealed Workspace tree. The factory will not invoke `make build` or rebuild GhosttyKit from a tree with no `.git`. */
async function stageGhosttyKit(source: string): Promise<void> {
  const lock = join(source, "native/toolchain-lock.json");
  const zigVersion = await lockValue(lock, "zig.version");
  const commit = await lockValue(lock, "ghostty.commit");
  const artifact = join(
    nativeCacheDir(),
    "artifacts",
    `ghostty-${commit}-zig-${zigVersion}`,
  );
  const check = Bun.spawn(
    [
      join(source, "scripts/native/ghostty-artifact-lock-check.sh"),
      artifact,
      lock,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    check.exited,
    new Response(check.stderr).text(),
  ]);
  if (exitCode !== 0) {
    refuse(
      `GhosttyKit cache at ${artifact} is missing or does not match the sealed lock; build it once with scripts/native/build-ghosttykit.sh from a checkout of this same lock, then re-run the factory. Do not invoke make build. ${stderr.trim()}`,
    );
  }
  const vendor = join(source, "workspace", "Vendor");
  await mkdir(vendor, { recursive: true });
  await run(
    [
      "/usr/bin/ditto",
      join(artifact, "GhosttyKit.xcframework"),
      join(vendor, "GhosttyKit.xcframework"),
    ],
    source,
  );
  await run(
    [
      "/usr/bin/ditto",
      join(artifact, "checkpoint-fixtures"),
      join(vendor, "checkpoint-fixtures"),
    ],
    source,
  );
}

function hostZigArch(): string {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x86_64";
  refuse(`unsupported host architecture ${process.arch}`);
}

function hostSwiftArch(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  refuse(`unsupported host architecture ${process.arch}`);
}

async function produceInstallComponents(
  source: string,
  out: string,
  stamp: BuildStamp,
): Promise<void> {
  await stageGhosttyKit(source);
  await compileSessiondTo({
    repoRoot: source,
    outFile: join(out, SESSIOND_ARTIFACT),
    zigArch: hostZigArch(),
  });
  await compileWorkspaceTo({
    repoRoot: source,
    outBundle: join(out, WORKSPACE_ARTIFACT),
    version: stamp.version,
    arches: [hostSwiftArch()],
    sourceDate: stamp.buildDate,
  });
  const nodeModules = await findSourceNodeModules(join(source, "node_modules"));
  if (nodeModules === null) {
    refuse(
      `sealed source ${source} has no node_modules containing fastembed after bun install`,
    );
  }
  await buildEmbeddingsRuntimeArtifact({
    sourceNodeModules: nodeModules,
    outDir: out,
    installedAt: stamp.buildDate,
    sourceLabel: "sealed-main",
    deterministicMtime: stamp.buildDate,
  });
}

/** Compile the candidate, its fixture, and the rest of a complete install from a sealed snapshot into an attester-owned directory. Writes the install files and nothing that resembles a claim about them. */
export async function produceArtifacts(
  request: ProducerRequest,
): Promise<void> {
  assertSealedSource(request.source);
  assertAttesterOwnedOutput(request.out, request.source);
  await mkdir(request.out, { recursive: true });

  await run(
    ["bun", "install", "--frozen-lockfile", "--os=darwin", "--cpu=*"],
    request.source,
  );
  const defines = definesFor(request.stamp);
  await run(
    [
      "bun",
      "build",
      "--compile",
      ...defines,
      "src/cli.ts",
      "src/cli/agent-ui/unified-diff-worker.ts",
      "--outfile",
      join(request.out, CLI_ARTIFACT),
    ],
    request.source,
  );
  await run(
    [
      "bun",
      "build",
      "--compile",
      ...defines,
      "src/deployd/fixture-entry.ts",
      "--outfile",
      join(request.out, FIXTURE_ARTIFACT),
    ],
    request.source,
  );
  if (request.completeInstall === false) return;
  await produceInstallComponents(request.source, request.out, request.stamp);
}

function requiredArg(argv: string[], flag: string): string {
  const value = argv[argv.indexOf(flag) + 1];
  if (argv.indexOf(flag) < 0 || value === undefined) {
    refuse(`missing ${flag}`);
  }
  return value;
}

function optionalArg(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

export async function main(argv: string[]): Promise<void> {
  await produceArtifacts({
    source: requiredArg(argv, "--source"),
    out: requiredArg(argv, "--out"),
    stamp: {
      version: requiredArg(argv, "--build-version"),
      commit: requiredArg(argv, "--build-commit"),
      buildDate: requiredArg(argv, "--build-date"),
      buildHash: optionalArg(argv, "--build-hash"),
      sourceHash: optionalArg(argv, "--source-hash"),
      variant: parseVariant(optionalArg(argv, "--build-variant") ?? undefined),
    },
  });
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
