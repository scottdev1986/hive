// The project profile: what *this* repo is, authored by a read-only profiling
// agent and accepted by the daemon (SPEC.md decision 14 replaces the derived
// TOML cache in `src/adapters/profile.ts` with this).
//
// Two properties drive every shape below.
//
// 1. A repo is not one language with one test command. A profile that can only
//    say "typescript" and "bun test" is a lie about a monorepo with a Rust
//    backend and a Python notebook package, and a lie a spawned agent will act
//    on. So languages, package managers, build systems and commands are all
//    *lists*, and every command carries the working directory and the workspace
//    it belongs to. `cargo test --workspace` run from the repo root is a
//    different command from the same string run in `backend/`, and only one of
//    them works.
//
// 2. A model wrote this. Nothing here is trusted because it sounds right: every
//    load-bearing claim cites the file it came from (`evidence`) and says how
//    firmly it is held (`confidence`), the daemon checks the citation exists
//    before the profile is ever read by anything, and what the profiler could
//    not determine goes in `unknowns` — never a plausible guess. An empty repo
//    profiles to empty lists and honest unknowns, not to `npm test`.
import { z } from "zod";

export const PROJECT_PROFILE_SCHEMA_VERSION = 1;

/** Repo-relative. The schema only checks non-emptiness; that the path exists,
 * and stays inside the project, is the daemon's job at submit time — a string
 * schema cannot know either. */
const RepoRelativePath = z.string().min(1);

/** How firmly a claim is held. `observed`: read directly in a file (a `[[bin]]`
 * table names this entry point). `derived`: inferred from evidence that implies
 * it (a `Cargo.toml` workspace manifest implies `cargo test --workspace`).
 * `assumed`: a convention, not a fact in this repo — the weakest thing that may
 * still be written down, and only with the file that made it plausible. */
export const ProjectProfileConfidenceSchema = z.enum([
  "observed",
  "derived",
  "assumed",
]);
export type ProjectProfileConfidence = z.infer<
  typeof ProjectProfileConfidenceSchema
>;

/** The citation behind a claim. `path` is what the profiler read; `basis` is
 * what it read there. The daemon rejects a profile whose evidence points at a
 * file that does not exist, which is the cheapest possible check against a
 * confident model inventing a manifest. */
export const ProjectProfileEvidenceSchema = z.strictObject({
  path: RepoRelativePath,
  basis: z.string().min(1),
  line: z.number().int().positive().optional(),
});
export type ProjectProfileEvidence = z.infer<
  typeof ProjectProfileEvidenceSchema
>;

/** The workspace a claim belongs to: a workspace `name`, or `repo` for a claim
 * that genuinely holds repo-wide. */
export const REPO_SCOPE = "repo";
const Scope = z.string().min(1);

export const ProjectProfileLanguageSchema = z.strictObject({
  /** Lowercase, e.g. `typescript`, `rust`, `python`. */
  name: z.string().min(1),
  /** The toolchain the language is used through here, e.g. `node`, `cargo`,
   * `uv`. Null when the profiler found the language but not its ecosystem. */
  ecosystem: z.string().min(1).nullable(),
  scope: Scope,
  evidence: ProjectProfileEvidenceSchema,
  confidence: ProjectProfileConfidenceSchema,
});
export type ProjectProfileLanguage = z.infer<
  typeof ProjectProfileLanguageSchema
>;

/** A package manager (`bun`, `pnpm`, `cargo`, `poetry`) or a build system
 * (`make`, `just`, `bazel`, `vite`). Same shape, separate lists: a repo can have
 * several of each, and they are not the same question. */
export const ProjectProfileToolSchema = z.strictObject({
  name: z.string().min(1),
  scope: Scope,
  evidence: ProjectProfileEvidenceSchema,
  confidence: ProjectProfileConfidenceSchema,
});
export type ProjectProfileTool = z.infer<typeof ProjectProfileToolSchema>;

export const ProjectProfileWorkspaceSchema = z.strictObject({
  /** The name commands scope to. Unique within a profile. */
  name: z.string().min(1),
  /** Repo-relative directory. `.` is the repo root. */
  path: RepoRelativePath,
  evidence: ProjectProfileEvidenceSchema,
  confidence: ProjectProfileConfidenceSchema,
});
export type ProjectProfileWorkspace = z.infer<
  typeof ProjectProfileWorkspaceSchema
>;

/** `validate` is any other gate a change must pass — a format check, an audit, a
 * migration check — that is not one of the five named purposes. */
export const ProjectProfileCommandPurposeSchema = z.enum([
  "build",
  "test",
  "typecheck",
  "lint",
  "run",
  "validate",
]);
export type ProjectProfileCommandPurpose = z.infer<
  typeof ProjectProfileCommandPurposeSchema
>;

/** A command is never a bare string. The landing gate that runs "the tests" in
 * the wrong directory has not run the tests, and a monorepo has more than one
 * answer to "the tests" — so purpose, working directory and workspace ride
 * along, and the daemon checks the directory exists and lives inside the
 * workspace the command claims.
 *
 * There is deliberately no `verified` flag. The profiler is read-only: it may
 * not execute the project's scripts, so nothing in the system could ever set
 * such a flag true, and a field no writer can write is the `index_budget`
 * mistake SPEC §14 already made once. A command's verification state is its
 * `confidence` — `observed` means the profiler read this exact string in a
 * manifest, which is as verified as a read-only profiler can make it. Whoever
 * builds command execution adds the field along with the code that sets it. */
export const ProjectProfileCommandSchema = z.strictObject({
  purpose: ProjectProfileCommandPurposeSchema,
  command: z.string().min(1),
  /** Repo-relative directory the command runs in. `.` is the repo root. */
  cwd: RepoRelativePath,
  scope: Scope,
  evidence: ProjectProfileEvidenceSchema,
  confidence: ProjectProfileConfidenceSchema,
});
export type ProjectProfileCommand = z.infer<typeof ProjectProfileCommandSchema>;

/** A briefable doc: one a spawn brief may quote from. This is a *claim*, not a
 * file listing — `brief.ts` acts on it, so "this doc is worth a spawn's tokens"
 * has to cite why, exactly like every other conclusion a reader will act on. */
export const ProjectProfileBriefableDocSchema = z.strictObject({
  path: RepoRelativePath,
  evidence: ProjectProfileEvidenceSchema,
  confidence: ProjectProfileConfidenceSchema,
});
export type ProjectProfileBriefableDoc = z.infer<
  typeof ProjectProfileBriefableDocSchema
>;

/** The doc set a spawn brief may quote from, and which doc earns the bare-name
 * `§`-selector rule that `brief.ts` hardcodes for "SPEC" today. `primary` is
 * null in a repo with no single design doc — the special case drops away rather
 * than being faked. */
export const ProjectProfileDocsSchema = z.strictObject({
  primary: z
    .strictObject({
      path: RepoRelativePath,
      evidence: ProjectProfileEvidenceSchema,
      confidence: ProjectProfileConfidenceSchema,
    })
    .nullable(),
  briefable: z.array(ProjectProfileBriefableDocSchema),
});
export type ProjectProfileDocs = z.infer<typeof ProjectProfileDocsSchema>;

/** A pointer to conventions, never a copy of them: `AGENTS.md` and `CLAUDE.md`
 * are loaded natively by the vendor. The profile records only that they exist
 * and where.
 *
 * `kind` is load-bearing — it is what tells a spawner "this is the file this
 * vendor loads natively" — so it is evidenced like any other claim. A file named
 * `CONVENTIONS.md` claimed as `kind: agents` is a claim about what reads it, not
 * a fact about its name. */
export const ProjectProfileConventionFileSchema = z.strictObject({
  path: RepoRelativePath,
  kind: z.enum(["agents", "claude", "other"]),
  evidence: ProjectProfileEvidenceSchema,
  confidence: ProjectProfileConfidenceSchema,
});
export type ProjectProfileConventionFile = z.infer<
  typeof ProjectProfileConventionFileSchema
>;

export const ProjectProfileEntryPointSchema = z.strictObject({
  path: RepoRelativePath,
  /** What it is: `cli`, `daemon`, `library`, `app`, `worker`… free text, because
   * the roles a repo has are not a set Hive can enumerate in advance. */
  role: z.string().min(1),
  evidence: ProjectProfileEvidenceSchema,
  confidence: ProjectProfileConfidenceSchema,
});
export type ProjectProfileEntryPoint = z.infer<
  typeof ProjectProfileEntryPointSchema
>;

/** What the profiler could not determine. This exists so that a model with a
 * gap has somewhere to put it that is not a guess: an empty repo has no test
 * command, and "no test command" is the correct profile, not `npm test`. */
export const ProjectProfileUnknownSchema = z.strictObject({
  subject: z.string().min(1),
  why: z.string().min(1),
});
export type ProjectProfileUnknown = z.infer<typeof ProjectProfileUnknownSchema>;

/** Two or more readings the evidence genuinely allows, none of them chosen. */
export const ProjectProfileAmbiguitySchema = z.strictObject({
  subject: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  why: z.string().min(1),
});
export type ProjectProfileAmbiguity = z.infer<
  typeof ProjectProfileAmbiguitySchema
>;

/** Evidence that disagrees with itself — a README that says `yarn test` and a
 * `package.json` that has no test script. The daemon rejects contradictions it
 * can detect *unless* they are declared here: a known conflict is a fact about
 * the repo, an undeclared one is a broken profile. */
export const ProjectProfileConflictSchema = z.strictObject({
  subject: z.string().min(1),
  claims: z.array(z.string().min(1)).min(2),
  detail: z.string().min(1),
});
export type ProjectProfileConflict = z.infer<
  typeof ProjectProfileConflictSchema
>;

/** What this profile depends on: change one of these and the answers above may
 * be wrong. Deliberately not "the Git tree" — hashing the tree is what made the
 * old profile look stale on every unrelated commit (SPEC §14). `notes` carries
 * an observation that is not a single path ("the set of crates under crates/"),
 * which drift detection reads as prose, not as a hash input.
 *
 * FOUNDATION CONTRACT — the freshness guarantee, and its explicit limit. The
 * daemon runs a final proof, under lock and immediately before it commits, that
 * every path a profile cites exists and that the repository digest still matches
 * the one the profiler read (`proveProfileStillHolds`). The commit itself is a
 * rename, and that rename follows the proof — so even "at commit" is one
 * unclosable instant later than the proof, and a cited file deleted in that
 * instant (or at any moment after) still lands in `current.json` and stays
 * there. Nothing that edits the repository takes the profile lock; the
 * repository does not know the lock exists. So the honest guarantee is not
 * "valid at commit" and certainly not "valid now": it is that every citation was
 * OBSERVED VALID BY THE FINAL PRE-COMMIT PROOF, and no stronger.
 *
 * Closing the gap is drift detection's job (P7), and this is the interface it
 * inherits: a consumer that acts on a profile is entitled to assume its
 * citations were observed valid immediately before commit and nothing more;
 * drift detection MUST, on observing that a `staleness.paths` entry or any cited
 * path has gone missing or changed, drive the profile to `stale` via
 * `markProfileStale` so the lifecycle reprofiles it. `stale` keeps the profile
 * readable and in use until a replacement is accepted, so this backstop never
 * leaves a consumer with nothing — it leaves them with a profile flagged as due
 * for refresh. */
export const ProjectProfileStalenessSchema = z.strictObject({
  paths: z.array(RepoRelativePath),
  notes: z.array(z.string().min(1)),
});
export type ProjectProfileStaleness = z.infer<
  typeof ProjectProfileStalenessSchema
>;

/** Who profiled, on what, with what. `runId` and `inputDigest` are what make a
 * submission checkable: the daemon minted the run and observed the digest, so a
 * payload carrying someone else's run, or a digest from a repo that has since
 * changed, is refused rather than committed. */
export const ProjectProfileProvenanceSchema = z.strictObject({
  agent: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  runId: z.string().min(1),
  /** The vendor session the profile was authored in, when the tool exposes one. */
  toolSessionId: z.string().min(1).nullable(),
});
export type ProjectProfileProvenance = z.infer<
  typeof ProjectProfileProvenanceSchema
>;

export const ProjectProfileSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_PROFILE_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  project: z.strictObject({
    /** The uuid the project registry minted; the profile is keyed by identity,
     * not by path, so it survives the repo moving. */
    hiveUuid: z.string().min(1),
    /** Digest of the repository inventory the profiler was handed at the start
     * of its run. If the repo has changed since, the profile describes a repo
     * that no longer exists. */
    inputDigest: z.string().min(1),
  }),
  profiler: ProjectProfileProvenanceSchema,
  languages: z.array(ProjectProfileLanguageSchema),
  packageManagers: z.array(ProjectProfileToolSchema),
  buildSystems: z.array(ProjectProfileToolSchema),
  workspaces: z.array(ProjectProfileWorkspaceSchema),
  commands: z.array(ProjectProfileCommandSchema),
  docs: ProjectProfileDocsSchema,
  conventionFiles: z.array(ProjectProfileConventionFileSchema),
  entryPoints: z.array(ProjectProfileEntryPointSchema),
  unknowns: z.array(ProjectProfileUnknownSchema),
  ambiguities: z.array(ProjectProfileAmbiguitySchema),
  conflicts: z.array(ProjectProfileConflictSchema),
  staleness: ProjectProfileStalenessSchema,
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

// ---------------------------------------------------------------------------
// Lifecycle. `state.json` is the only place the profile's state is written
// down: a directory listing cannot tell a repo nobody has profiled from one
// whose profiler died halfway, and both of those from one whose profile is
// simply old. Each is a different next action, so each is an explicit state.
//
//   unprofiled → profiling → current | failed
//   current → stale → profiling → current
//
// `current` stays readable in every one of them. A refresh that fails, or is
// interrupted, or is superseded, leaves the last validated profile exactly where
// it was: the only thing that ever replaces `current.json` is a submission that
// passed validation, and it replaces it with a rename.
// ---------------------------------------------------------------------------

export const ProjectProfileLifecycleSchema = z.enum([
  "unprofiled",
  "profiling",
  "current",
  "stale",
  "failed",
]);
export type ProjectProfileLifecycle = z.infer<
  typeof ProjectProfileLifecycleSchema
>;

/** The profiling run in flight. A second `beginProfiling` mints a new one, and
 * the older run's submission is then superseded — it cannot land behind the
 * newer one's back. */
export const ProjectProfileRunSchema = z.strictObject({
  runId: z.string().min(1),
  agent: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** The inventory digest observed when the run began. */
  inputDigest: z.string().min(1),
  startedAt: z.iso.datetime(),
});
export type ProjectProfileRun = z.infer<typeof ProjectProfileRunSchema>;

/** Why a rerun is due, recorded by the *daemon* — never by a model. Whoever asks
 * for a reprofile says who they are and what they saw, so the next profiling run
 * (and the human watching it) can tell drift from a repo that changed mid-run
 * from an operator who simply asked. Without the source, every rerun looks the
 * same from the outside and none of them can be debugged. */
export const ProjectProfileReprofileSchema = z.strictObject({
  at: z.iso.datetime(),
  /** `drift`, `digest-mismatch`, `operator`, … — whoever made the call. */
  source: z.string().min(1),
  reason: z.string().min(1),
});
export type ProjectProfileReprofile = z.infer<
  typeof ProjectProfileReprofileSchema
>;

export const ProjectProfileFailureSchema = z.strictObject({
  at: z.iso.datetime(),
  /** The rejection that ended the run, e.g. `missing-path`. */
  code: z.string().min(1),
  detail: z.string().min(1),
  runId: z.string().min(1).nullable(),
});
export type ProjectProfileFailure = z.infer<typeof ProjectProfileFailureSchema>;

export const ProjectProfileStateSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_PROFILE_SCHEMA_VERSION),
  lifecycle: ProjectProfileLifecycleSchema,
  hiveUuid: z.string().min(1),
  updatedAt: z.iso.datetime(),
  /** Non-null while a run is in flight. */
  run: ProjectProfileRunSchema.nullable(),
  /** The profile in `current.json`. Non-null from the first accepted submission
   * on — it survives `stale`, `profiling` and `failed`, because the profile
   * itself does. */
  profiled: z
    .strictObject({
      at: z.iso.datetime(),
      inputDigest: z.string().min(1),
      profiler: ProjectProfileProvenanceSchema,
    })
    .nullable(),
  /** Why a rerun is due — set when the profile goes stale or a run is discarded,
   * cleared when a new profile is accepted. */
  reprofile: ProjectProfileReprofileSchema.nullable(),
  /** The last failure, kept after recovery so a repeated failure is visible. */
  failure: ProjectProfileFailureSchema.nullable(),
});
export type ProjectProfileState = z.infer<typeof ProjectProfileStateSchema>;
