/** The attester half of the proof factory: it never compiles, and it is the only thing that decides.
 *
 * Everything it judges it measures itself, from bytes on disk and from a program it ran. It takes no claim from the producer, and it takes no claim from the candidate — including the candidate's own account of what it is. `--version` is recorded in the evidence and gates nothing, because a version string is a stamp, and stamps in this repo have been absent or wrong more than once while the raw bytes have never lied.
 *
 * Three legs, none of which substitutes for another:
 *
 * Identity, from raw bytes. The attester computes the build stamp from the sealed tree before the producer runs, then requires those exact byte sequences back out of the compiled candidate, alongside pinned literals that prove the landing path is genuinely linked in rather than merely intended. The pinned literals live here, in the attester, not in the candidate: a witness the change supplies is a change vouching for itself. They are fail-closed on purpose — if main renames one of these, the factory refuses until someone updates the witness, which is the correct direction to fail.
 *
 * Semantics, from the compiled fixture. See fixture-entry.ts. The attester runs it and reads its measurements; the fixture reaches no verdict and its exit code alone proves nothing.
 *
 * Naming. The artifact's identity is the SHA-256 computed here, from the bytes the producer left behind. The producer cannot name its own output, so no producer claim can survive into an artifact id. */
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { embeddingsRuntimeDigest } from "../release/embeddings-digest";
import { FIXTURE_CHILD_TOKEN, type FixtureReport } from "./fixture-entry";
import {
  type BuildStamp,
  CLI_ARTIFACT,
  EMBEDDINGS_ARTIFACT,
  FIXTURE_ARTIFACT,
  SESSIOND_ARTIFACT,
  WORKSPACE_ARTIFACT,
  WORKSPACE_EXECUTABLE,
} from "./producer";

/** Literals the attester requires in the candidate's raw bytes, pinned here rather than proposed by the change being deployed. `hive_land` is the landing tool's registered name and the refusal text is on its diagnostic path, so together they prove the landing surface is compiled in — the same thing the owner has been confirming by hand with `strings`. */
const PINNED_WITNESSES = [
  { label: "landing-tool-registered", literal: "hive_land" },
  { label: "landing-diagnostics-linked", literal: "Nothing to land for " },
] as const;

/** The role `hive-sessiond` must answer so a launcher can learn the linked VT engine. A binary without this string cannot fence Workspace. */
const SESSIOND_ENGINE_QUERY = "engine-build-id";

/** The os_log subsystem Workspace writes termination reasons under. Absence means the Mach-O is not the Hive app. */
const WORKSPACE_LOG_SUBSYSTEM = "dev.hive.workspace";

/** The export `bun build --packages=bundle` must inline into `dist/entry.js`. A tarball without it is not the embedding runtime. */
const EMBEDDINGS_ENTRY_EXPORT = "FlagEmbedding";

export type RefusalCode =
  | "artifact-missing"
  | "witness-missing"
  | "fixture-unreadable"
  | "fixture-self-invocation"
  | "fixture-landing-post-state"
  | "sessiond-engine-id"
  | "embeddings-runtime";

export interface Refusal {
  readonly code: RefusalCode;
  readonly detail: string;
}

export interface ArtifactDigest {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface WitnessObservation {
  readonly label: string;
  readonly literal: string;
  readonly present: boolean;
}

export interface SealedInput {
  readonly mainCommit: string;
  readonly mainTree: string;
  readonly sourceHash: string;
}

/** Who did a thing, recorded so the evidence shows on its face that producing and attesting were two processes rather than two function calls. */
export interface ProcessRecord {
  readonly program: string;
  readonly pid: number;
}

export interface AttestRequest {
  /** Where the producer left its bytes. */
  readonly stagingDir: string;
  /** A disposable directory the fixture may build a repository in. */
  readonly fixtureWorkspace: string;
  readonly sealed: SealedInput;
  /** The stamp the attester handed the producer, and now requires back out of the bytes. */
  readonly stamp: BuildStamp;
  readonly producedBy: ProcessRecord;
}

export interface Evidence {
  readonly attestedAt: string;
  readonly sealed: SealedInput;
  readonly stamp: BuildStamp;
  readonly artifacts: readonly ArtifactDigest[];
  readonly witnesses: readonly WitnessObservation[];
  /** The candidate's own account of itself. Recorded for the operator; never a gate. */
  readonly versionText: string;
  readonly fixture: FixtureReport | null;
  readonly fixtureExitCode: number | null;
  /** The hex `hive-sessiond engine-build-id` printed. Recorded; the gate is that it is 64 hex chars, not a particular value. */
  readonly sessiondEngineBuildId: string | null;
  /** SHA-256 of the extracted runtime's loaded surface (`dist/` + `bin/`). Computed here, never taken from the producer. */
  readonly embeddingsLoadedDigest: string | null;
  readonly producedBy: ProcessRecord;
  readonly attestedBy: ProcessRecord;
  readonly ready: boolean;
  readonly refusal: Refusal | null;
}

const ATTESTER = "hive-deployd attest (stage A)";

async function digest(
  path: string,
  name: string,
): Promise<{ digest: ArtifactDigest; bytes: Buffer } | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const raw = new Uint8Array(await file.arrayBuffer());
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    digest: {
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    bytes,
  };
}

function observeWitnesses(
  candidate: Buffer,
  stamp: BuildStamp,
  sealed: SealedInput,
): WitnessObservation[] {
  const required: { label: string; literal: string | null }[] = [
    { label: "build-hash-inlined", literal: stamp.buildHash },
    { label: "source-hash-inlined", literal: stamp.sourceHash },
    { label: "main-commit-inlined", literal: sealed.mainCommit },
    ...PINNED_WITNESSES.map((witness) => ({ ...witness })),
  ];
  return required
    .filter(
      (witness): witness is { label: string; literal: string } =>
        witness.literal !== null,
    )
    .map(({ label, literal }) => ({
      label,
      literal,
      present: candidate.includes(Buffer.from(literal, "utf8")),
    }));
}

async function readVersionText(binary: string): Promise<string> {
  const child = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return stdout.trim();
}

async function readSessiondEngineId(
  binary: string,
): Promise<{ ok: boolean; text: string }> {
  const child = Bun.spawn([binary, SESSIOND_ENGINE_QUERY], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const text = stdout.trim();
  return {
    ok: exitCode === 0 && /^[0-9a-f]{64}$/.test(text),
    text: text.length > 0 ? text : stderr.trim(),
  };
}

async function extractEmbeddings(
  tarball: string,
  into: string,
): Promise<{ digest: string; entry: Buffer } | { detail: string }> {
  await mkdir(into, { recursive: true });
  const child = Bun.spawn(["tar", "-xzf", tarball, "-C", into], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    return {
      detail: `extracting ${EMBEDDINGS_ARTIFACT} failed: ${stderr.trim()}`,
    };
  }
  const runtime = join(into, "embeddings-runtime");
  const entryFile = Bun.file(join(runtime, "dist", "entry.js"));
  if (!(await entryFile.exists())) {
    return {
      detail: `${EMBEDDINGS_ARTIFACT} has no embeddings-runtime/dist/entry.js`,
    };
  }
  try {
    const digest = await embeddingsRuntimeDigest(runtime);
    const raw = new Uint8Array(await entryFile.arrayBuffer());
    return {
      digest,
      entry: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength),
    };
  } catch (error) {
    return {
      detail:
        error instanceof Error
          ? error.message
          : `embeddings loaded-surface digest failed: ${String(error)}`,
    };
  }
}

interface FixtureRun {
  readonly report: FixtureReport | null;
  readonly exitCode: number;
  readonly detail: string;
}

/** Run the fixture to completion. As in the producer, there is no deadline, because a deadline needs the power to terminate a process and this stage holds no such power for any purpose. */
async function runFixture(
  binary: string,
  workspace: string,
): Promise<FixtureRun> {
  const child = Bun.spawn([binary, "--workspace", workspace], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    return {
      report: JSON.parse(stdout.trim()) as FixtureReport,
      exitCode,
      detail: stderr.trim(),
    };
  } catch {
    return {
      report: null,
      exitCode,
      detail: `fixture produced no readable report (exit ${exitCode})\n${stdout.trim()}\n${stderr.trim()}`,
    };
  }
}

function judgeSelfInvocation(report: FixtureReport): Refusal | null {
  const { argv, exitCode, stdout, stderr } = report.selfInvocation;
  if (exitCode === 0 && stdout === FIXTURE_CHILD_TOKEN) return null;
  return {
    code: "fixture-self-invocation",
    detail:
      `the candidate builds ${JSON.stringify(argv)} to re-invoke itself and that argv does not run: ` +
      `exit ${exitCode}, stdout ${JSON.stringify(stdout)}, stderr ${JSON.stringify(stderr)}. ` +
      `A compiled Hive must invoke itself with no script argument; ${argv.length} argument(s) means it believes it is a source checkout ` +
      `(HIVE_BUILD_HASH inlined: ${report.isReleaseBuild}), so every child process it spawns is the compiled executable used as if it were Bun.`,
  };
}

function judgeLandingPostState(report: FixtureReport): Refusal | null {
  const { landing } = report;
  if (landing.landError !== null) {
    return {
      code: "fixture-landing-post-state",
      detail: `the candidate refused a valid landing: ${landing.landError}`,
    };
  }
  if (landing.mainAfterLand !== landing.branchCommit) {
    return {
      code: "fixture-landing-post-state",
      detail:
        `the candidate reported a successful landing and moved nothing: main was ${landing.mainBeforeLand}, ` +
        `is ${landing.mainAfterLand}, and the branch commit that should have landed is ${landing.branchCommit}.`,
    };
  }
  if (landing.ancestorExitCode !== 0) {
    return {
      code: "fixture-landing-post-state",
      detail: `main claims to be at ${landing.mainAfterLand} but git does not report ${landing.branchCommit} as its ancestor`,
    };
  }
  return null;
}

/** Measure the staged bytes, run the compiled fixture, and return the evidence bundle with a verdict. Refuses rather than throws: a named refusal with its evidence is the product, and a factory that only ever says yes is unproven. */
export async function attest(request: AttestRequest): Promise<Evidence> {
  const candidate = await digest(
    join(request.stagingDir, CLI_ARTIFACT),
    CLI_ARTIFACT,
  );
  const fixtureBinary = await digest(
    join(request.stagingDir, FIXTURE_ARTIFACT),
    FIXTURE_ARTIFACT,
  );
  const sessiond = await digest(
    join(request.stagingDir, SESSIOND_ARTIFACT),
    SESSIOND_ARTIFACT,
  );
  const workspace = await digest(
    join(request.stagingDir, WORKSPACE_EXECUTABLE),
    WORKSPACE_ARTIFACT,
  );
  const embeddings = await digest(
    join(request.stagingDir, EMBEDDINGS_ARTIFACT),
    EMBEDDINGS_ARTIFACT,
  );
  const base = {
    attestedAt: new Date().toISOString(),
    sealed: request.sealed,
    stamp: request.stamp,
    producedBy: request.producedBy,
    attestedBy: { program: ATTESTER, pid: process.pid },
    sessiondEngineBuildId: null as string | null,
    embeddingsLoadedDigest: null as string | null,
  };
  if (candidate === null || fixtureBinary === null) {
    return {
      ...base,
      artifacts: [candidate?.digest, fixtureBinary?.digest].filter(
        (entry): entry is ArtifactDigest => entry !== undefined,
      ),
      witnesses: [],
      versionText: "",
      fixture: null,
      fixtureExitCode: null,
      ready: false,
      refusal: {
        code: "artifact-missing",
        detail: `the producer left no ${candidate === null ? CLI_ARTIFACT : FIXTURE_ARTIFACT} in ${request.stagingDir}`,
      },
    };
  }

  const artifacts = [candidate.digest, fixtureBinary.digest];
  const witnesses = observeWitnesses(
    candidate.bytes,
    request.stamp,
    request.sealed,
  );
  const versionText = await readVersionText(
    join(request.stagingDir, CLI_ARTIFACT),
  );
  const missing = witnesses.filter((witness) => !witness.present);
  if (missing.length > 0) {
    return {
      ...base,
      artifacts,
      witnesses,
      versionText,
      fixture: null,
      fixtureExitCode: null,
      ready: false,
      refusal: {
        code: "witness-missing",
        detail: `the candidate's raw bytes do not contain ${missing.map((witness) => `${witness.label} (${JSON.stringify(witness.literal)})`).join(", ")}`,
      },
    };
  }

  const fixture = await runFixture(
    join(request.stagingDir, FIXTURE_ARTIFACT),
    request.fixtureWorkspace,
  );
  if (fixture.report === null) {
    return {
      ...base,
      artifacts,
      witnesses,
      versionText,
      fixture: null,
      fixtureExitCode: fixture.exitCode,
      ready: false,
      refusal: { code: "fixture-unreadable", detail: fixture.detail },
    };
  }
  const fixtureRefusal =
    judgeSelfInvocation(fixture.report) ??
    judgeLandingPostState(fixture.report);
  if (fixtureRefusal !== null) {
    return {
      ...base,
      artifacts,
      witnesses,
      versionText,
      fixture: fixture.report,
      fixtureExitCode: fixture.exitCode,
      ready: false,
      refusal: fixtureRefusal,
    };
  }

  if (sessiond === null || workspace === null || embeddings === null) {
    const absent =
      sessiond === null
        ? SESSIOND_ARTIFACT
        : workspace === null
          ? WORKSPACE_ARTIFACT
          : EMBEDDINGS_ARTIFACT;
    return {
      ...base,
      artifacts,
      witnesses,
      versionText,
      fixture: fixture.report,
      fixtureExitCode: fixture.exitCode,
      ready: false,
      refusal: {
        code: "artifact-missing",
        detail: `the producer left no ${absent} in ${request.stagingDir}; a complete install needs hive-sessiond, HiveWorkspace.app and embeddings-runtime.tar.gz alongside the CLI`,
      },
    };
  }
  artifacts.push(sessiond.digest, workspace.digest, embeddings.digest);

  const embeddingsExtract = join(request.fixtureWorkspace, "embeddings");
  const extracted = await extractEmbeddings(
    join(request.stagingDir, EMBEDDINGS_ARTIFACT),
    embeddingsExtract,
  );
  if ("detail" in extracted) {
    await rm(embeddingsExtract, { recursive: true, force: true });
    return {
      ...base,
      artifacts,
      witnesses,
      versionText,
      fixture: fixture.report,
      fixtureExitCode: fixture.exitCode,
      ready: false,
      refusal: { code: "embeddings-runtime", detail: extracted.detail },
    };
  }
  base.embeddingsLoadedDigest = extracted.digest;

  witnesses.push(
    {
      label: "sessiond-engine-query",
      literal: SESSIOND_ENGINE_QUERY,
      present: sessiond.bytes.includes(
        Buffer.from(SESSIOND_ENGINE_QUERY, "utf8"),
      ),
    },
    {
      label: "workspace-log-subsystem",
      literal: WORKSPACE_LOG_SUBSYSTEM,
      present: workspace.bytes.includes(
        Buffer.from(WORKSPACE_LOG_SUBSYSTEM, "utf8"),
      ),
    },
    {
      label: "embeddings-entry-bundled",
      literal: EMBEDDINGS_ENTRY_EXPORT,
      present: extracted.entry.includes(
        Buffer.from(EMBEDDINGS_ENTRY_EXPORT, "utf8"),
      ),
    },
  );
  const componentMissing = witnesses.filter((witness) => !witness.present);
  if (componentMissing.length > 0) {
    await rm(embeddingsExtract, { recursive: true, force: true });
    return {
      ...base,
      artifacts,
      witnesses,
      versionText,
      fixture: fixture.report,
      fixtureExitCode: fixture.exitCode,
      ready: false,
      refusal: {
        code: "witness-missing",
        detail: `an install component's bytes do not contain ${componentMissing.map((witness) => `${witness.label} (${JSON.stringify(witness.literal)})`).join(", ")}`,
      },
    };
  }

  const engine = await readSessiondEngineId(
    join(request.stagingDir, SESSIOND_ARTIFACT),
  );
  await rm(embeddingsExtract, { recursive: true, force: true });
  if (!engine.ok) {
    return {
      ...base,
      artifacts,
      witnesses,
      versionText,
      fixture: fixture.report,
      fixtureExitCode: fixture.exitCode,
      ready: false,
      refusal: {
        code: "sessiond-engine-id",
        detail: `hive-sessiond ${SESSIOND_ENGINE_QUERY} did not print a 64-char hex engine id: ${engine.text}`,
      },
    };
  }
  base.sessiondEngineBuildId = engine.text;

  return {
    ...base,
    artifacts,
    witnesses,
    versionText,
    fixture: fixture.report,
    fixtureExitCode: fixture.exitCode,
    ready: true,
    refusal: null,
  };
}
