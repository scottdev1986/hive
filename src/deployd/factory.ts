/** Stage A of Hive self-deployment: the proof factory. It builds a complete install the owner would otherwise assemble by hand — hive, hive-sessiond, HiveWorkspace.app, and the embedding runtime — proves the result, and hands him a ready-to-activate artifact with its evidence. He still performs the swap.
 *
 * What it replaces. Today shipping a change to Hive itself means merging to main, running the build from exactly the right directory, sha256-ing the staged file, reading its version string, fetching the handshake build hash off the running process, and grepping the binary to confirm the intended code is really in there. That whole sequence happens here, and its result is written down instead of remembered.
 *
 * What it deliberately cannot do. Nothing in this subsystem stops, restarts, swaps or terminates anything. It moves no install pointer, signals no process, registers with no system supervisor, and sets no deadline that would need to end one — the capability is absent rather than unused, because a capability that exists gets reached for. A test in test/deployd holds that line by refusing the tokens outright. Activation is the owner's, and the later stage that automates it needs its own adversarial review before it is written.
 *
 * Main-only, by construction. `sealMainSnapshot` takes no ref: there is no parameter, flag, or environment variable anywhere in this subsystem that names one, so a build of a branch is not a thing the code can express. What the producer receives is a tree with no `.git` in it, which leaves it nothing to resolve even if it wanted to.
 *
 * Working-directory-independent, by construction. A rebuild once ran from the wrong checkout, recompiled main's bytes, and staged them where nothing served them — an hour of forensics, caused by a Makefile that stages relative to `CURDIR`. Every path here is derived from `deploydRoot()`, which is a function of the home directory. Nothing reads the current directory, and the producer refuses any output path that is relative or that sits inside a checkout. Where the bytes land is the same no matter where the command was typed. */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runGit } from "../adapters/git";
import { sourceBuildHash } from "../daemon/lifecycle/handshake";
import { buildHashFor } from "../release/build";
import { attest, type Evidence } from "./attest";
import { type BuildStamp, CLI_ARTIFACT, INSTALL_ARTIFACTS } from "./producer";

/** The only source a deployable artifact may be built from. There is no second value and no way to supply one. */
export const DEPLOY_SOURCE_REF = "refs/heads/main";

const LATEST = "latest.json";
const EVIDENCE = "evidence.json";

export interface SealedSnapshot {
  readonly dir: string;
  readonly mainCommit: string;
  readonly mainTree: string;
  /** Main's own commit date, which is what gets stamped into the artifact. Deliberately not the wall clock: a wall-clock stamp is inlined into the compiled bytes, so it changes the artifact's digest on every run and two builds of one commit stop being comparable. Reading it off the commit means the same main produces the same bytes, and a digest that moved says something really moved. */
  readonly mainDate: string;
}

export interface ProduceResult {
  readonly evidence: Evidence;
  readonly artifactDir: string;
}

/** Where the factory keeps its sealed sources, staging area and artifacts: outside every checkout and outside the release tree it builds, so no clean, prune or branch switch can reach it. Derived from the home directory and never from the current one — that independence is the whole point, so `HIVE_DEPLOYD_ROOT` (which tests and QA use) must be absolute for the same reason. */
export function deploydRoot(): string {
  const configured = process.env.HIVE_DEPLOYD_ROOT;
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      throw new Error(
        `HIVE_DEPLOYD_ROOT must be absolute; ${configured} would resolve against the caller's working directory`,
      );
    }
    return configured;
  }
  return join(homedir(), "Library", "Application Support", "Hive", "deployd");
}

/** The repository whose `main` gets built: the checkout this module was loaded from. Reading it off the module's own location rather than off the current directory is deliberate — a factory that sealed whatever repository the operator happened to be standing in would rebuild the wrong-checkout failure with the inputs instead of the outputs. */
export function hiveRepoRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await runGit(repoRoot, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${repoRoot} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** Copy main's tree, and only main's tree, into `into`. `git archive` writes the committed tree with no `.git` and no working-copy state, so what comes out cannot contain a branch, an uncommitted edit, or a way to reach either. */
export async function sealMainSnapshot(
  repoRoot: string,
  into: string,
): Promise<SealedSnapshot> {
  const mainCommit = await git(repoRoot, ["rev-parse", DEPLOY_SOURCE_REF]);
  const mainTree = await git(repoRoot, [
    "rev-parse",
    `${DEPLOY_SOURCE_REF}^{tree}`,
  ]);
  const mainDate = await git(repoRoot, [
    "show",
    "-s",
    "--format=%cI",
    DEPLOY_SOURCE_REF,
  ]);
  const archive = `${into}.tar`;
  await mkdir(into, { recursive: true });
  await git(repoRoot, [
    "archive",
    "--format=tar",
    "--output",
    archive,
    DEPLOY_SOURCE_REF,
  ]);
  const extract = Bun.spawn(["tar", "-xf", archive, "-C", into], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    extract.exited,
    new Response(extract.stderr).text(),
  ]);
  await rm(archive, { force: true });
  if (exitCode !== 0) {
    throw new Error(`extracting ${DEPLOY_SOURCE_REF} failed: ${stderr.trim()}`);
  }
  if (existsSync(join(into, ".git"))) {
    throw new Error(
      `sealed snapshot ${into} contains a .git; a snapshot that can resolve refs is not sealed`,
    );
  }
  return { dir: into, mainCommit, mainTree, mainDate };
}

/** The producer, resolved next to this module rather than through the current directory or PATH. Running it as a child process is what makes the producer/attester split structural: the bytes are made in one process and judged in another, and the judging process never imports the compiling one. */
function producerEntry(): string {
  return join(import.meta.dir, "producer.ts");
}

async function readVersion(sourceDir: string): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(join(sourceDir, "package.json"), "utf8"),
  );
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error(`${sourceDir}/package.json declares no version`);
  }
  return version;
}

interface ProducerRun {
  readonly argv: string[];
  readonly pid: number;
}

/** Run the producer to completion and record which process it was. Its stdout is not consulted for anything: what it produced is read off the filesystem by the attester, because a build's account of itself is worth least exactly when the build is what went wrong. */
async function runProducer(argv: string[]): Promise<ProducerRun> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`producer failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return { argv, pid: child.pid };
}

function stampArgs(stamp: BuildStamp): string[] {
  return [
    "--build-version",
    stamp.version,
    "--build-commit",
    stamp.commit,
    "--build-date",
    stamp.buildDate,
    ...(stamp.buildHash === null ? [] : ["--build-hash", stamp.buildHash]),
    ...(stamp.sourceHash === null ? [] : ["--source-hash", stamp.sourceHash]),
    "--build-variant",
    stamp.variant,
  ];
}

/** Seal main, build it, prove it, and write the artifact with its evidence. Returns the evidence whether or not the candidate is ready: a named refusal with its measurements is as much the product as a green verdict is. */
export async function produce(
  repoRoot: string = hiveRepoRoot(),
): Promise<ProduceResult> {
  const root = deploydRoot();
  const work = join(root, "work");
  await rm(work, { recursive: true, force: true });
  const sourceDir = join(work, "source");
  const stagingDir = join(work, "staging");
  const fixtureWorkspace = join(work, "fixture");
  await mkdir(fixtureWorkspace, { recursive: true });

  const sealed = await sealMainSnapshot(repoRoot, sourceDir);
  const version = await readVersion(sourceDir);
  const sourceHash = await sourceBuildHash(sourceDir);
  // A deployd candidate is a rehearsal of the published release, so it is built as prod. Named
  // once here and carried in the stamp, so the define the binary gets and the hash that addresses
  // it cannot disagree.
  const variant = "prod" as const;
  const stamp: BuildStamp = {
    version,
    commit: sealed.mainCommit,
    buildDate: sealed.mainDate,
    buildHash: buildHashFor(
      sourceHash,
      version,
      sealed.mainCommit,
      `bun-${process.platform}-${process.arch}`,
      variant,
    ),
    sourceHash,
    variant,
  };

  const producer = await runProducer([
    "bun",
    "run",
    producerEntry(),
    "--source",
    sourceDir,
    "--out",
    stagingDir,
    ...stampArgs(stamp),
  ]);

  const evidence = await attest({
    stagingDir,
    fixtureWorkspace,
    sealed: {
      mainCommit: sealed.mainCommit,
      mainTree: sealed.mainTree,
      sourceHash,
    },
    stamp,
    producedBy: { program: producer.argv.join(" "), pid: producer.pid },
  });

  const artifactDir = await retain(
    root,
    sealed.mainCommit,
    stagingDir,
    evidence,
  );
  // The scratch goes only once the evidence is safely written, and only then.
  // Nothing unrecoverable is in it: the artifact and its evidence are retained
  // whether the verdict was ready or refused, and the sealed tree is exactly
  // the main OID the evidence records. A run that dies before this line —
  // a producer that failed, an attester that threw — leaves its whole workspace
  // standing to be looked at.
  await rm(work, { recursive: true, force: true });
  return { evidence, artifactDir };
}

/** Name the artifact by the digest the attester computed and move the bytes there. The producer never learns this name, so nothing it claimed can become the artifact's identity. A directory that already exists holds byte-identical content — its name is their digest — so the bytes are left alone and only the fresh attestation is written. */
async function retain(
  root: string,
  mainCommit: string,
  stagingDir: string,
  evidence: Evidence,
): Promise<string> {
  const cli = evidence.artifacts.find(
    (artifact) => artifact.name === CLI_ARTIFACT,
  );
  const name =
    cli === undefined
      ? `dev-${mainCommit}-unbuilt`
      : `dev-${mainCommit}-${cli.sha256.slice(0, 12)}`;
  const artifactDir = join(root, "artifacts", name);
  await mkdir(artifactDir, { recursive: true });
  let moved = false;
  for (const artifact of INSTALL_ARTIFACTS) {
    const staged = join(stagingDir, artifact);
    if (existsSync(staged) && !existsSync(join(artifactDir, artifact))) {
      await rename(staged, join(artifactDir, artifact));
      moved = true;
    }
  }
  // A digest-named directory already holds the first writer's bytes. Do not
  // replace its evidence with a later measurement of files that were not
  // retained — the embeddings tarball is the one component that still moves
  // between runs, and overwriting would make the evidence describe a file
  // that is not in the directory.
  const evidencePath = join(artifactDir, EVIDENCE);
  if (moved || !existsSync(evidencePath)) {
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  await writeFile(
    join(root, LATEST),
    `${JSON.stringify({ artifact: name, ready: evidence.ready, attestedAt: evidence.attestedAt }, null, 2)}\n`,
  );
  return artifactDir;
}

/** What the owner reads. Prints the verdict and the measurements behind it, and runs nothing: the swap is his, and this stage holds no authority to perform it. */
export async function present(): Promise<string> {
  const root = deploydRoot();
  const latest = join(root, LATEST);
  if (!existsSync(latest)) {
    return `no artifact has been produced yet under ${root}`;
  }
  const pointer: unknown = JSON.parse(await readFile(latest, "utf8"));
  const name = (pointer as { artifact?: unknown }).artifact;
  if (typeof name !== "string") {
    return `${latest} names no artifact`;
  }
  const artifactDir = join(root, "artifacts", name);
  const evidence: Evidence = JSON.parse(
    await readFile(join(artifactDir, EVIDENCE), "utf8"),
  );
  return render(artifactDir, evidence);
}

export function render(artifactDir: string, evidence: Evidence): string {
  const lines = [
    evidence.ready
      ? "READY TO ACTIVATE"
      : `REFUSED: ${evidence.refusal?.code ?? "unknown"}`,
    "",
    `  built from        ${DEPLOY_SOURCE_REF} @ ${evidence.sealed.mainCommit}`,
    `  main tree         ${evidence.sealed.mainTree}`,
    `  input closure     ${evidence.sealed.sourceHash}`,
    `  build hash        ${evidence.stamp.buildHash ?? "ABSENT"}`,
    `  artifact          ${artifactDir}`,
  ];
  for (const artifact of evidence.artifacts) {
    lines.push(
      `  ${artifact.name.padEnd(17)} sha256 ${artifact.sha256} (${artifact.bytes} bytes)`,
    );
  }
  lines.push(
    `  version text      ${evidence.versionText} (recorded, not proof)`,
    "",
    "  raw-byte witnesses",
  );
  for (const witness of evidence.witnesses) {
    lines.push(
      `    ${witness.present ? "present" : "MISSING"}  ${witness.label}`,
    );
  }
  const landing = evidence.fixture?.landing;
  lines.push(
    "",
    "  compiled landing fixture",
    `    self-invocation  ${evidence.fixture === null ? "not run" : JSON.stringify(evidence.fixture.selfInvocation.argv)} exit ${evidence.fixture?.selfInvocation.exitCode ?? "-"}`,
    `    landed commit    ${landing?.branchCommit ?? "not run"}`,
    `    main after land  ${landing?.mainAfterLand ?? "not run"}`,
    `    ancestor readback exit ${landing?.ancestorExitCode ?? "-"}`,
    `    sessiond engine  ${evidence.sessiondEngineBuildId ?? "not run"}`,
    `    embeddings digest ${evidence.embeddingsLoadedDigest ?? "not run"}`,
    "",
    `  produced by       pid ${evidence.producedBy.pid}: ${evidence.producedBy.program}`,
    `  attested by       pid ${evidence.attestedBy.pid}: ${evidence.attestedBy.program}`,
  );
  if (evidence.refusal !== null) {
    lines.push("", `  refusal           ${evidence.refusal.detail}`);
  } else {
    // Named from the artifact list rather than written out, so the claim cannot
    // drift as the candidate grows. A verdict that reads as "everything the
    // install needs is here" when it covers one file is the kind of green light
    // this factory exists to stop issuing.
    lines.push(
      "",
      `  This verdict covers ${evidence.artifacts.map((artifact) => artifact.name).join(" and ")}, and nothing else.`,
      "  The swap is yours. hive-deployd has no authority to stop, restart or replace",
      "  a running daemon, and holds no code that could.",
    );
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const verb = process.argv[2];
  if (verb === "produce") {
    const { evidence, artifactDir } = await produce();
    console.log(render(artifactDir, evidence));
    process.exitCode = evidence.ready ? 0 : 1;
  } else if (verb === "present") {
    console.log(await present());
  } else {
    console.error("usage: hive-deployd (produce|present)");
    process.exitCode = 2;
  }
}
