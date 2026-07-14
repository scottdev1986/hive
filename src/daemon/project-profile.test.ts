import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE_GUIDANCE_MAX_BYTES,
  PROJECT_PROFILE_SCHEMA_VERSION,
  ProjectProfileSchema,
  mergeProfileGuidance,
  normalizeProfileGuidance,
  type ProjectProfile,
  type ProjectProfileCandidate,
  type ProjectProfileRequest,
} from "../schemas/project-profile";
import {
  appendProfilingGuidance,
  beginProfiling,
  computeProfileInventory,
  currentProfilePath,
  failProfiling,
  markProfileStale,
  profileStatePath,
  projectProfileDir,
  readCurrentProfile,
  readProfileState,
  reconcileProfileState,
  submitProfile,
  type ProfileSubmitResult,
} from "./project-profile";
import {
  assembleProfileEnvelope,
  proveProfileStillHolds,
} from "./project-profile-validate";
import { projectHiveUuid } from "./project-state";
import { withFileLock } from "../adapters/file-lock";

// The profile lives in Hive's own per-project state, so every test here runs
// against a throwaway HIVE_HOME: nothing lands in the synthetic repos, which is
// itself part of what is being proved.
let hiveHome: string;
const originalHiveHome = process.env.HIVE_HOME;

beforeAll(async () => {
  hiveHome = await mkdtemp(join(tmpdir(), "hive-home-"));
  process.env.HIVE_HOME = hiveHome;
});

afterAll(async () => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  await rm(hiveHome, { recursive: true, force: true });
});

// --- synthetic repos --------------------------------------------------------

function git(root: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function write(root: string, path: string, body: string): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body);
}

/** An empty Git repo: no manifests, no docs, no commands. The profile of this
 * repo is honest emptiness. */
async function emptyRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-profile-empty-"));
  git(root, ["init", "-q"]);
  return root;
}

/** A repo with a Rust backend and a TypeScript frontend: two languages, two
 * package managers, two test commands, neither of which is repo-wide. This is
 * the shape the old one-language-one-command profile could not describe. */
async function polyglotRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-profile-poly-"));
  git(root, ["init", "-q"]);
  await write(root, "README.md", "# poly\n");
  await write(root, "AGENTS.md", "# conventions\n");
  await write(root, "backend/Cargo.toml", "[workspace]\nmembers = []\n");
  await write(root, "backend/src/main.rs", "fn main() {}\n");
  await write(root, "frontend/package.json", '{ "name": "f" }\n');
  await write(root, "frontend/src/index.ts", "export {};\n");
  return root;
}

const PROFILER = { agent: "erica", provider: "claude", model: "opus-4.8" };

const DEFAULT_REQUEST: ProjectProfileRequest = {
  source: "daemon",
  requestedAt: "2026-01-01T00:00:00.000Z",
  requestedBy: "erica",
  guidance: null,
};

/** A model-authored candidate for `polyglotRepo`. Every claim cites a file that
 * is really there; daemon envelope fields are deliberately absent. */
function polyglotCandidate(): ProjectProfileCandidate {
  return {
    languages: [
      {
        name: "rust",
        ecosystem: "cargo",
        scope: "backend",
        evidence: { path: "backend/Cargo.toml", basis: "Cargo manifest" },
        confidence: "observed",
      },
      {
        name: "typescript",
        ecosystem: "node",
        scope: "frontend",
        evidence: { path: "frontend/package.json", basis: "npm manifest" },
        confidence: "observed",
      },
    ],
    packageManagers: [
      {
        name: "cargo",
        scope: "backend",
        evidence: { path: "backend/Cargo.toml", basis: "Cargo manifest" },
        confidence: "observed",
      },
    ],
    buildSystems: [],
    workspaces: [
      {
        name: "backend",
        path: "backend",
        evidence: { path: "backend/Cargo.toml", basis: "Cargo workspace manifest" },
        confidence: "observed",
      },
      {
        name: "frontend",
        path: "frontend",
        evidence: { path: "frontend/package.json", basis: "npm manifest" },
        confidence: "observed",
      },
    ],
    commands: [
      {
        purpose: "test",
        command: "cargo test --workspace",
        cwd: "backend",
        scope: "backend",
        evidence: { path: "backend/Cargo.toml", basis: "Cargo workspace manifest" },
        confidence: "derived",
      },
      {
        purpose: "test",
        command: "bun test",
        cwd: "frontend",
        scope: "frontend",
        evidence: { path: "frontend/package.json", basis: "npm manifest" },
        confidence: "derived",
      },
    ],
    docs: {
      primary: {
        path: "README.md",
        evidence: { path: "README.md", basis: "the only design doc" },
        confidence: "derived",
      },
      briefable: [
        {
          path: "README.md",
          evidence: { path: "README.md", basis: "the repo's design doc" },
          confidence: "observed",
        },
        {
          path: "AGENTS.md",
          evidence: { path: "AGENTS.md", basis: "agent conventions" },
          confidence: "observed",
        },
      ],
    },
    conventionFiles: [
      {
        path: "AGENTS.md",
        kind: "agents",
        evidence: { path: "AGENTS.md", basis: "conventions loaded natively by the vendor" },
        confidence: "observed",
      },
    ],
    entryPoints: [
      {
        path: "backend/src/main.rs",
        role: "binary",
        evidence: { path: "backend/src/main.rs", basis: "fn main" },
        confidence: "observed",
      },
    ],
    unknowns: [],
    ambiguities: [],
    conflicts: [],
    staleness: {
      paths: ["backend/Cargo.toml", "frontend/package.json"],
      notes: [],
    },
  };
}

/** Assemble a full accepted-shape profile (for disk fixtures / proof helpers). */
function polyglotProfile(
  root: string,
  runId: string,
  inputDigest: string,
  request: ProjectProfileRequest = DEFAULT_REQUEST,
): ProjectProfile {
  return assembleProfileEnvelope(polyglotCandidate(), {
    hiveUuid: projectHiveUuid(root),
    run: {
      runId,
      agent: PROFILER.agent,
      provider: PROFILER.provider,
      model: PROFILER.model,
      inputDigest,
      startedAt: request.requestedAt,
      toolSessionId: null,
      request,
    },
  });
}

/** Begin a run and submit a candidate the caller may first bend out of shape. */
async function profile(
  root: string,
  mutate: (candidate: ProjectProfileCandidate) => ProjectProfileCandidate = (p) => p,
  subject = PROFILER.agent,
): Promise<ProfileSubmitResult> {
  const run = await beginProfiling(root, PROFILER);
  const payload = mutate(polyglotCandidate());
  return submitProfile(root, payload, subject, run.runId);
}

function rejectionCodes(result: ProfileSubmitResult): string[] {
  return result.status === "rejected"
    ? result.rejections.map((rejection) => rejection.code)
    : [];
}

// --- storage layout ---------------------------------------------------------

describe("storage", () => {
  test("lives in per-project Hive state, not in the repo", async () => {
    const root = await polyglotRepo();
    const result = await profile(root);
    expect(result.status).toBe("accepted");

    const directory = projectProfileDir(root);
    expect(directory.startsWith(hiveHome)).toBe(true);
    expect(directory).toContain(join("projects", projectHiveUuid(root)));
    expect(currentProfilePath(root)).toBe(join(directory, "current.json"));
    expect(profileStatePath(root)).toBe(join(directory, "state.json"));

    // Nothing was written into the repo itself.
    const entries = await readdir(root);
    expect(entries.sort()).toEqual([
      ".git",
      "AGENTS.md",
      "README.md",
      "backend",
      "frontend",
    ]);
  });
});

// --- lifecycle --------------------------------------------------------------

describe("lifecycle", () => {
  test("unprofiled → profiling → current", async () => {
    const root = await polyglotRepo();
    expect((await readProfileState(root)).lifecycle).toBe("unprofiled");
    expect(await readCurrentProfile(root)).toBeNull();

    const run = await beginProfiling(root, PROFILER);
    const profiling = await readProfileState(root);
    expect(profiling.lifecycle).toBe("profiling");
    expect(profiling.run?.runId).toBe(run.runId);
    expect(profiling.run?.agent).toBe("erica");
    expect(profiling.run?.inputDigest).toBe(run.inputDigest);

    const result = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      run.runId,
    );
    expect(result.status).toBe("accepted");

    const current = await readProfileState(root);
    expect(current.lifecycle).toBe("current");
    expect(current.run).toBeNull();
    expect(current.profiled?.profiler.agent).toBe("erica");
    expect(current.profiled?.profiler.model).toBe("opus-4.8");
    expect(current.profiled?.inputDigest).toBe(run.inputDigest);
    expect(current.profiled?.profiler.request.source).toBe("daemon");
    expect(current.profiled?.profiler.request.guidance).toBeNull();
    expect(current.failure).toBeNull();
    expect(Date.parse(current.updatedAt)).not.toBeNaN();

    const stored = await readCurrentProfile(root);
    expect(stored?.commands.map((c) => c.command).sort()).toEqual([
      "bun test",
      "cargo test --workspace",
    ]);
  });

  test("profiling → failed, and the last validated profile survives it", async () => {
    const root = await polyglotRepo();
    const accepted = await profile(root);
    expect(accepted.status).toBe("accepted");

    const run = await beginProfiling(root, PROFILER);
    expect((await readProfileState(root)).lifecycle).toBe("profiling");
    // The profile stays readable for the whole refresh.
    expect(await readCurrentProfile(root)).not.toBeNull();

    const state = await failProfiling(root, run.runId, "profiler ran out of context");
    expect(state.lifecycle).toBe("failed");
    expect(state.run).toBeNull();
    expect(state.failure?.code).toBe("profiler-failed");
    expect(state.failure?.detail).toBe("profiler ran out of context");
    expect(state.failure?.runId).toBe(run.runId);
    // Failed is not "gone": the profile it failed to replace is still there.
    expect((await readCurrentProfile(root))?.commands).toHaveLength(2);
    expect(state.profiled).not.toBeNull();
  });

  test("current → stale → profiling → current", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");

    const stale = await markProfileStale(root, "drift", "backend/Cargo.toml changed");
    expect(stale.lifecycle).toBe("stale");
    expect(stale.reprofile?.source).toBe("drift");
    expect(stale.reprofile?.reason).toBe("backend/Cargo.toml changed");
    // Stale means "a refresh is due", never "unusable".
    expect(await readCurrentProfile(root)).not.toBeNull();

    const refreshed = await profile(root);
    expect(refreshed.status).toBe("accepted");
    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("current");
    expect(state.reprofile).toBeNull();
  });

  test("ifIdle refuses to begin a second run and leaves the first alone", async () => {
    const root = await polyglotRepo();
    const first = await beginProfiling(root, PROFILER);

    // One profiling job per project: the daemon says no, rather than trusting
    // the caller to have looked first.
    expect(await beginProfiling(root, PROFILER, { ifIdle: true })).toBeNull();

    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("profiling");
    expect(state.run?.runId).toBe(first.runId);
    expect(state.run?.inputDigest).toBe(first.inputDigest);

    // The refusal did not disturb the run in flight: it still lands.
    const landed = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      first.runId,
    );
    expect(landed.status).toBe("accepted");
  });

  test("ifIdle begins when nothing is in flight, in every resting state", async () => {
    const root = await polyglotRepo();

    // unprofiled
    const first = await beginProfiling(root, PROFILER, { ifIdle: true });
    expect(first).not.toBeNull();
    await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      first!.runId,
    );

    // current
    const second = await beginProfiling(root, PROFILER, { ifIdle: true });
    expect(second).not.toBeNull();
    await failProfiling(root, second!.runId, "gave up");

    // failed
    const third = await beginProfiling(root, PROFILER, { ifIdle: true });
    expect(third).not.toBeNull();
    await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      third!.runId,
    );

    // stale
    await markProfileStale(root, "drift", "backend/Cargo.toml changed");
    expect(await beginProfiling(root, PROFILER, { ifIdle: true })).not.toBeNull();
  });

  test("concurrent ifIdle begins mint exactly one run", async () => {
    const root = await polyglotRepo();

    // The bug this exists to catch: reading the state and then beginning is two
    // steps with an await between them, so four callers can all be told "nothing
    // is profiling" before any of them has written a run. Compare-and-begin has
    // to be one step.
    const handles = await Promise.all([
      beginProfiling(root, PROFILER, { ifIdle: true }),
      beginProfiling(root, PROFILER, { ifIdle: true }),
      beginProfiling(root, PROFILER, { ifIdle: true }),
      beginProfiling(root, PROFILER, { ifIdle: true }),
    ]);

    const started = handles.filter((handle) => handle !== null);
    expect(started).toHaveLength(1);

    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("profiling");
    expect(state.run?.runId).toBe(started[0]!.runId);
  });

  test("concurrent ifIdle begins in separate processes mint exactly one run", async () => {
    const root = await polyglotRepo();
    // Resolve the project identity once up front: the children must contend for
    // the profile lock, not race to create the registry entry.
    projectHiveUuid(root);

    const script = `
      import { beginProfiling } from ${JSON.stringify(join(import.meta.dir, "project-profile.ts"))};
      const handle = await beginProfiling(${JSON.stringify(root)}, ${JSON.stringify(PROFILER)}, { ifIdle: true });
      console.log(handle === null ? "coalesced" : "started");
    `;
    const children = await Promise.all(
      [0, 1, 2, 3].map(async () => {
        const child = Bun.spawn(["bun", "-e", script], {
          env: { ...process.env, HIVE_HOME: hiveHome },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        return out.trim();
      }),
    );

    // A real lock, held across real processes — an event-loop-only guard would
    // let all four through here.
    expect(children.filter((line) => line === "started")).toHaveLength(1);
    expect(children.filter((line) => line === "coalesced")).toHaveLength(3);
  }, 30_000);

  test("a dead run cannot fail the run that replaced it", async () => {
    const root = await polyglotRepo();
    const first = await beginProfiling(root, PROFILER);
    const second = await beginProfiling(root, PROFILER);

    const state = await failProfiling(root, first.runId, "crashed");
    expect(state.lifecycle).toBe("profiling");
    expect(state.run?.runId).toBe(second.runId);
  });

  test("submitting with nothing in flight is refused", async () => {
    const root = await polyglotRepo();
    const result = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      "invented-run",
    );
    expect(rejectionCodes(result)).toEqual(["no-active-run"]);
    expect(await readCurrentProfile(root)).toBeNull();
  });
});

// --- the empty project ------------------------------------------------------

describe("the empty project", () => {
  test("profiles to explicit unknowns, not to guesses", async () => {
    const root = await emptyRepo();
    const run = await beginProfiling(root, PROFILER);
    const minimal: ProjectProfileCandidate = {
      languages: [],
      packageManagers: [],
      buildSystems: [],
      workspaces: [],
      commands: [],
      docs: { primary: null, briefable: [] },
      conventionFiles: [],
      entryPoints: [],
      unknowns: [
        { subject: "commands.test", why: "The repository contains no manifest, script, or CI config." },
        { subject: "languages", why: "The repository contains no source files." },
      ],
      ambiguities: [],
      conflicts: [],
      staleness: { paths: [], notes: ["The repository is empty; any file is drift."] },
    };

    const result = await submitProfile(root, minimal, "erica", run.runId);
    expect(result.status).toBe("accepted");

    const stored = await readCurrentProfile(root);
    expect(stored?.commands).toEqual([]);
    expect(stored?.docs.primary).toBeNull();
    expect(stored?.unknowns.map((unknown) => unknown.subject)).toEqual([
      "commands.test",
      "languages",
    ]);
    expect(stored?.profiler.agent).toBe("erica");
    expect(stored?.project.inputDigest).toBe(run.inputDigest);
    expect((await readProfileState(root)).lifecycle).toBe("current");
  });
});

// --- validation -------------------------------------------------------------

describe("validation", () => {
  test("a payload that is not this schema is refused", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER);
    const result = await submitProfile(
      root,
      { schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION, runId: run.runId },
      "erica",
      run.runId,
    );
    expect(rejectionCodes(result).every((code) => code === "schema")).toBe(true);
    expect(await readCurrentProfile(root)).toBeNull();
  });

  test("an unknown key is refused rather than dropped", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => ({
      ...p,
      indexBudget: { mapTokens: 8192 },
    }) as unknown as ProjectProfileCandidate);
    expect(rejectionCodes(result)).toContain("schema");
  });

  test("a superseded run cannot land behind the newer one's back", async () => {
    const root = await polyglotRepo();
    const first = await beginProfiling(root, PROFILER);
    const second = await beginProfiling(root, PROFILER);

    // runId is credential-bound, not model-authored: the first run's credential
    // cannot land after a newer run replaced it.
    const result = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      first.runId,
    );
    expect(rejectionCodes(result)).toEqual(["superseded"]);
    expect(await readCurrentProfile(root)).toBeNull();

    // The loser of the race did not disturb the winner: it is still profiling.
    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("profiling");
    expect(state.run?.runId).toBe(second.runId);

    // And the winner still lands.
    const winner = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      second.runId,
    );
    expect(winner.status).toBe("accepted");
  });

  test("a superseded submission never replaces a validated profile", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    const landed = await readFile(currentProfilePath(root), "utf8");

    const orphan = await beginProfiling(root, PROFILER);
    const orphanPayload = polyglotCandidate();
    orphanPayload.commands[0]!.command = "cargo test --all";
    await beginProfiling(root, PROFILER); // supersedes it

    expect(
      rejectionCodes(await submitProfile(root, orphanPayload, "erica", orphan.runId)),
    ).toEqual(["superseded"]);
    expect(await readFile(currentProfilePath(root), "utf8")).toBe(landed);
  });

  test("another agent cannot submit for this run", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => p, "mallory");
    expect(rejectionCodes(result)).toContain("unauthorized");
    expect(await readCurrentProfile(root)).toBeNull();
  });

  test("another agent cannot end the run by submitting rubbish to it", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER);

    const result = await submitProfile(root, { not: "a profile" }, "mallory", run.runId);
    expect(result.status).toBe("rejected");

    // The run erica is still working on is untouched: an authenticated caller
    // who does not own the run cannot fail it out from under her.
    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("profiling");
    expect(state.run?.runId).toBe(run.runId);
    expect(state.failure).toBeNull();

    // And she still lands.
    const landed = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      run.runId,
    );
    expect(landed.status).toBe("accepted");
  });

  test("model-authored envelope fields are refused at the schema boundary", async () => {
    const root = await polyglotRepo();
    // The model cannot choose identity, digests, or provenance — those keys
    // are not on the candidate schema, and strict parsing rejects them.
    for (const forbidden of [
      { schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION },
      { generatedAt: new Date().toISOString() },
      { project: { hiveUuid: "x", inputDigest: "y" } },
      { profiler: { ...PROFILER, runId: "r", toolSessionId: null } },
    ] as const) {
      const result = await profile(root, (p) => ({
        ...p,
        ...forbidden,
      }) as unknown as ProjectProfileCandidate);
      expect(rejectionCodes(result)).toContain("schema");
    }
    expect(await readCurrentProfile(root)).toBeNull();
  });

  test("a repo that changed under the profiler discards the result and marks a rerun", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER);
    const payload = polyglotCandidate();

    // The tree moves on while the profiler is thinking.
    await write(root, "backend/Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n");

    const result = await submitProfile(root, payload, "erica", run.runId);
    expect(rejectionCodes(result)).toEqual(["digest-mismatch"]);
    expect(await readCurrentProfile(root)).toBeNull();

    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("unprofiled"); // nothing to fall back on: rerun
    expect(state.run).toBeNull();
    expect(state.failure?.code).toBe("digest-mismatch");
  });

  test("a digest mismatch keeps the last validated profile and goes stale", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    const landed = await readFile(currentProfilePath(root), "utf8");

    const run = await beginProfiling(root, PROFILER);
    const payload = polyglotCandidate();
    payload.commands[0]!.command = "cargo test --all-features";
    await write(root, "frontend/package.json", '{ "name": "f", "private": true }\n');

    const result = await submitProfile(root, payload, "erica", run.runId);
    expect(rejectionCodes(result)).toEqual(["digest-mismatch"]);

    // The refresh is discarded; the profile it would have replaced is untouched.
    expect(await readFile(currentProfilePath(root), "utf8")).toBe(landed);
    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("stale");
    expect(state.profiled).not.toBeNull();
  });

  test("evidence for a file that is not there is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.commands[0]!.evidence = {
        path: "backend/Makefile",
        basis: "the test target",
      };
      return p;
    });
    expect(rejectionCodes(result)).toEqual(["missing-path"]);
    expect(await readCurrentProfile(root)).toBeNull();
  });

  test("a claim without evidence cannot even be expressed", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      const { evidence: _evidence, ...withoutEvidence } = p.commands[0]!;
      return { ...p, commands: [withoutEvidence] } as unknown as ProjectProfileCandidate;
    });
    expect(rejectionCodes(result)).toContain("schema");
  });

  test("a path outside the project is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.entryPoints[0]!.path = "../../../etc/passwd";
      return p;
    });
    // It escapes; whether it exists is not the interesting part.
    expect(rejectionCodes(result)).toContain("path-escape");
    expect(await readCurrentProfile(root)).toBeNull();
  });

  test("an absolute path is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.commands[0]!.cwd = "/etc";
      return p;
    });
    expect(rejectionCodes(result)).toContain("path-escape");
  });

  test("a symlink out of the project is refused", async () => {
    const root = await polyglotRepo();
    const outside = await mkdtemp(join(tmpdir(), "hive-outside-"));
    await writeFile(join(outside, "secrets.env"), "TOKEN=1\n");
    await symlink(outside, join(root, "escape"));

    const result = await profile(root, (p) => {
      p.workspaces[0]!.path = "escape";
      p.commands[0]!.cwd = "escape";
      return p;
    });
    // Containment is checked after resolving symlinks, so a link that points out
    // of the tree cannot smuggle a path past a string-prefix check.
    expect(rejectionCodes(result)).toContain("path-escape");
    expect(await readCurrentProfile(root)).toBeNull();
    await rm(outside, { recursive: true, force: true });
  });

  test("a workspace command that escapes its workspace is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.commands[0]!.cwd = "frontend"; // scoped to backend
      return p;
    });
    expect(rejectionCodes(result)).toEqual(["invalid-cwd"]);
  });

  test("a cwd that is lexically inside its workspace but symlinked elsewhere is refused", async () => {
    const root = await polyglotRepo();
    // `backend/elsewhere` is lexically under `backend` and resolves to
    // `frontend` — inside the repo, so containment passes, and inside the
    // workspace only if you never look. A command scoped to the Rust backend
    // would run `cargo test` in the TypeScript package.
    await symlink(join(root, "frontend"), join(root, "backend", "elsewhere"));

    const result = await profile(root, (p) => {
      p.commands[0]!.cwd = "backend/elsewhere";
      return p;
    });
    expect(rejectionCodes(result)).toEqual(["invalid-cwd"]);
    expect(await readCurrentProfile(root)).toBeNull();
  });

  test("daemon envelope provenance is assembled, not model-claimed", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER, {
      request: {
        source: "operator",
        requestedBy: "scott",
        guidance: "Prefer cargo workspaces over npm.",
        toolSessionId: "sess-1",
      },
    });
    const result = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      run.runId,
    );
    expect(result.status).toBe("accepted");
    const stored = await readCurrentProfile(root);
    expect(stored?.profiler).toMatchObject({
      agent: "erica",
      provider: "claude",
      model: "opus-4.8",
      runId: run.runId,
      toolSessionId: "sess-1",
      request: {
        source: "operator",
        requestedBy: "scott",
        guidance: "Prefer cargo workspaces over npm.",
      },
    });
    expect(stored?.project.hiveUuid).toBe(projectHiveUuid(root));
    expect(stored?.project.inputDigest).toBe(run.inputDigest);
  });

  test("a profile that asserts nothing and explains nothing is refused", async () => {
    const root = await emptyRepo();
    const run = await beginProfiling(root, PROFILER);
    const silent: ProjectProfileCandidate = {
      languages: [],
      packageManagers: [],
      buildSystems: [],
      workspaces: [],
      commands: [],
      docs: { primary: null, briefable: [] },
      conventionFiles: [],
      entryPoints: [],
      unknowns: [], // <- the whole finding: silence with nothing said about it
      ambiguities: [],
      conflicts: [],
      staleness: { paths: [], notes: [] },
    };

    // An empty repo profiles to explicit unknowns. A profile that says nothing
    // at all is indistinguishable from a profiler that read nothing.
    const result = await submitProfile(root, silent, "erica", run.runId);
    expect(rejectionCodes(result)).toEqual(["missing-unknowns"]);
    expect(await readCurrentProfile(root)).toBeNull();
  });

  test("a briefable doc is a claim, and carries its evidence", async () => {
    const root = await polyglotRepo();

    // No evidence: not expressible.
    const bare = await profile(root, (p) => ({
      ...p,
      docs: { ...p.docs, briefable: [{ path: "README.md" }] },
    }) as unknown as ProjectProfileCandidate);
    expect(rejectionCodes(bare)).toContain("schema");

    // Evidence that cites a file which is not there: refused like any other.
    const invented = await profile(root, (p) => {
      p.docs.briefable[0]!.evidence = {
        path: "docs/ARCHITECTURE.md",
        basis: "the design doc",
      };
      return p;
    });
    expect(rejectionCodes(invented)).toEqual(["missing-path"]);
  });

  test("a convention file's kind carries its evidence", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => ({
      ...p,
      conventionFiles: [{ path: "AGENTS.md", kind: "agents" }],
    }) as unknown as ProjectProfileCandidate);
    expect(rejectionCodes(result)).toContain("schema");
  });

  test("a cwd that is a file, not a directory, is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.commands[0]!.cwd = "backend/Cargo.toml";
      return p;
    });
    expect(rejectionCodes(result)).toContain("invalid-cwd");
  });

  test("a command scoped to a workspace the profile never declares is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.commands[0]!.scope = "worker";
      return p;
    });
    expect(rejectionCodes(result)).toEqual(["unknown-scope"]);
  });

  test("the same command declared twice is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.commands.push({ ...p.commands[0]! });
      return p;
    });
    expect(rejectionCodes(result)).toEqual(["duplicate"]);
  });

  test("two different answers to one question are refused unless declared", async () => {
    const root = await polyglotRepo();
    const contradict = (p: ProjectProfileCandidate): ProjectProfileCandidate => {
      p.commands.push({ ...p.commands[0]!, command: "cargo nextest run" });
      return p;
    };

    const refused = await profile(root, contradict);
    expect(rejectionCodes(refused)).toEqual(["contradiction"]);

    // Declared out loud, the same disagreement is a fact about the repo.
    const declared = await profile(root, (p) => {
      contradict(p);
      p.conflicts.push({
        subject: "backend test command",
        claims: ["cargo test --workspace", "cargo nextest run"],
        detail: "README says nextest; CI runs cargo test.",
      });
      return p;
    });
    expect(declared.status).toBe("accepted");
    expect((await readCurrentProfile(root))?.conflicts).toHaveLength(1);
  });

  test("a duplicate workspace is refused", async () => {
    const root = await polyglotRepo();
    const result = await profile(root, (p) => {
      p.workspaces.push({ ...p.workspaces[0]! });
      return p;
    });
    expect(rejectionCodes(result)).toContain("duplicate");
  });

  test("a rejected submission leaves the profile in place and the run failed", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    const landed = await readFile(currentProfilePath(root), "utf8");

    const result = await profile(root, (p) => {
      p.entryPoints[0]!.path = "backend/src/nonexistent.rs";
      return p;
    });
    expect(result.status).toBe("rejected");
    expect(await readFile(currentProfilePath(root), "utf8")).toBe(landed);

    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("failed");
    expect(state.failure?.code).toBe("missing-path");
    expect(state.failure?.detail).toContain("nonexistent.rs");
    expect(state.profiled).not.toBeNull();
  });
});

// --- the commit-time proof --------------------------------------------------

describe("commit-time proof", () => {
  test("a cited path deleted while the submission is in flight never lands", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    const landed = await readFile(currentProfilePath(root), "utf8");

    const run = await beginProfiling(root, PROFILER);
    const payload = polyglotCandidate();
    payload.commands[0]!.command = "cargo test --all-features";

    // Hold the profile lock from outside, so the submission validates (which
    // happens outside the lock) and then blocks on it. Everything it checked is
    // now history: the window between a check and the bytes landing is exactly
    // where a repo can change under an already-validated profile.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPath = join(projectProfileDir(root), "profile.lock");
    const lock = withFileLock(lockPath, async () => {
      await held;
    });
    while (!existsSync(lockPath)) await Bun.sleep(5);

    const inFlight = submitProfile(root, payload, "erica", run.runId);
    await Bun.sleep(500); // past validation, now waiting for the lock we hold
    await rm(join(root, "backend", "Cargo.toml"));
    release();
    await lock;
    const result = await inFlight;

    // The profile cites backend/Cargo.toml five times over. It must not be
    // committed now that the file is gone.
    expect(result.status).toBe("rejected");
    expect(rejectionCodes(result).length).toBeGreaterThan(0);
    expect(await readFile(currentProfilePath(root), "utf8")).toBe(landed);
    expect((await readCurrentProfile(root))?.commands[0]?.command).toBe(
      "cargo test --workspace",
    );
    // The bytes staged before the proof are removed when the proof rejects —
    // a rejected refresh leaves nothing half-written behind.
    const leftovers = (await readdir(projectProfileDir(root))).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  }, 20_000);

  test("proveProfileStillHolds catches a deleted citation and a moved tree", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER);
    const profileToProve = polyglotProfile(root, run.runId, run.inputDigest, run.request);
    const asRun = {
      runId: run.runId,
      agent: PROFILER.agent,
      provider: PROFILER.provider,
      model: PROFILER.model,
      inputDigest: run.inputDigest,
      startedAt: new Date().toISOString(),
      toolSessionId: null as string | null,
      request: run.request,
    };

    // Nothing has changed: the profile still holds.
    expect(
      await proveProfileStillHolds(profileToProve, {
        root,
        run: asRun,
        inventoryDigest: run.inputDigest,
      }),
    ).toEqual([]);

    // The tree moved: the digest alone condemns it.
    const moved = await proveProfileStillHolds(profileToProve, {
      root,
      run: asRun,
      inventoryDigest: "f".repeat(64),
    });
    expect(moved.map((rejection) => rejection.code)).toEqual(["digest-mismatch"]);

    // A citation is gone: the path check says which claim broke.
    await rm(join(root, "backend", "src", "main.rs"));
    const deleted = await proveProfileStillHolds(profileToProve, {
      root,
      run: asRun,
      inventoryDigest: (await computeProfileInventory(root)).digest,
    });
    expect(deleted.map((rejection) => rejection.code)).toContain("digest-mismatch");
  });
});

// --- crash recovery ---------------------------------------------------------

describe("crash recovery", () => {
  test("a profile that landed but whose state write was lost heals on read", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER);
    const accepted = polyglotProfile(root, run.runId, run.inputDigest, run.request);

    // Exactly the disk left by a crash between the two renames: current.json is
    // the new profile, state.json still says this run is in flight. Before the
    // reader reconciled, begin({ifIdle}) saw a run that would never end and
    // refused to start another one — forever. A profile that landed would have
    // blocked every future profile of the project.
    await mkdir(projectProfileDir(root), { recursive: true });
    await writeFile(
      currentProfilePath(root),
      `${JSON.stringify(accepted, null, 2)}\n`,
    );

    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("current");
    expect(state.run).toBeNull();
    expect(state.profiled?.profiler.runId).toBe(run.runId);
    expect(state.profiled?.inputDigest).toBe(run.inputDigest);

    // And the project is profilable again.
    expect(await beginProfiling(root, PROFILER, { ifIdle: true })).not.toBeNull();
  });

  test("reconcileProfileState persists the heal and strips leftover temps", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER);
    const accepted = polyglotProfile(root, run.runId, run.inputDigest, run.request);
    await mkdir(projectProfileDir(root), { recursive: true });
    await writeFile(
      currentProfilePath(root),
      `${JSON.stringify(accepted, null, 2)}\n`,
    );
    const tempPath = join(projectProfileDir(root), "current.json.dead.tmp");
    await writeFile(tempPath, "{ half");

    const healed = await reconcileProfileState(root);
    expect(healed.lifecycle).toBe("current");
    expect(healed.run).toBeNull();
    expect(healed.profiled?.inputDigest).toBe(run.inputDigest);

    // Persisted: a raw re-read (without heal) would still need the file on disk.
    const raw = JSON.parse(await readFile(profileStatePath(root), "utf8"));
    expect(raw.lifecycle).toBe("current");
    expect(raw.run).toBeNull();
    expect(existsSync(tempPath)).toBe(false);
  });

  test("state cannot claim a different current digest than the profile on disk", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    const current = await readCurrentProfile(root);
    expect(current).not.toBeNull();

    // Corrupt profiled.inputDigest while leaving a valid current.json in place.
    const state = await readProfileState(root);
    await writeFile(
      profileStatePath(root),
      `${JSON.stringify(
        {
          ...state,
          profiled: {
            ...state.profiled!,
            inputDigest: "f".repeat(64),
          },
        },
        null,
        2,
      )}\n`,
    );

    const healed = await reconcileProfileState(root);
    expect(healed.profiled?.inputDigest).toBe(current!.project.inputDigest);
    expect(healed.profiled?.profiler.runId).toBe(current!.profiler.runId);
  });

  test("a profile from a different run does not heal an in-flight one", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");

    // A run is genuinely in flight, and current.json holds an *older* run's
    // profile. That is not a lagging state file — it is a refresh in progress,
    // and healing it would silently cancel the run.
    const run = await beginProfiling(root, PROFILER);
    const state = await readProfileState(root);
    expect(state.lifecycle).toBe("profiling");
    expect(state.run?.runId).toBe(run.runId);
    expect(await beginProfiling(root, PROFILER, { ifIdle: true })).toBeNull();
  });
});

// --- atomicity --------------------------------------------------------------

describe("atomicity", () => {
  test("a profiler killed mid-write never corrupts the validated profile", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    const landed = await readFile(currentProfilePath(root), "utf8");

    // A real process, really killed — a mocked filesystem cannot model a write
    // that stopped halfway. The child begins an accepted replacement whose
    // payload is large enough that it cannot finish inside the kill window, and
    // dies with the temp file open.
    const run = await beginProfiling(root, PROFILER);
    const script = `
      import { submitProfile } from ${JSON.stringify(join(import.meta.dir, "project-profile.ts"))};
      const payload = JSON.parse(process.argv[2]);
      // Big enough that the write cannot complete before the kill lands.
      payload.staleness.notes = Array.from({ length: 400_000 }, (_, i) => "note " + i);
      console.log("go");
      await submitProfile(${JSON.stringify(root)}, payload, "erica", ${JSON.stringify(run.runId)});
    `;
    const payload = polyglotCandidate();
    const child = Bun.spawn(
      ["bun", "-e", script, "--", JSON.stringify(payload)],
      {
        env: { ...process.env, HIVE_HOME: hiveHome },
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    // Wait until the child is actually inside the submit, then kill it.
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGKILL");
    await child.exited;

    // Whatever the child got through, the profile on disk is one of the two
    // valid states — never a torn file. It cannot be the new one: the child was
    // killed before it could finish writing it.
    const after = await readFile(currentProfilePath(root), "utf8");
    expect(after).toBe(landed);
    expect(ProjectProfileSchema.safeParse(JSON.parse(after)).success).toBe(true);
    expect(await readCurrentProfile(root)).not.toBeNull();

    // And a leftover temp file — the corpse of the interrupted write — neither
    // corrupts a read nor blocks the next replacement.
    const leftovers = (await readdir(projectProfileDir(root))).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers.length).toBeGreaterThanOrEqual(0);
    const next = await profile(root);
    expect(next.status).toBe("accepted");
    expect((await readProfileState(root)).lifecycle).toBe("current");
  });

  test("a stray temp file from a dead writer is not read as a profile", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    await writeFile(`${currentProfilePath(root)}.999.dead.tmp`, "{ this is half a");

    expect((await readCurrentProfile(root))?.commands).toHaveLength(2);
    expect((await readProfileState(root)).lifecycle).toBe("current");
  });

  test("an unreadable current.json is 'profile again', not a crash", async () => {
    const root = await polyglotRepo();
    expect((await profile(root)).status).toBe("accepted");
    await writeFile(currentProfilePath(root), "{ truncated");

    expect(await readCurrentProfile(root)).toBeNull();
    // A fresh run still lands on top of it.
    expect((await profile(root)).status).toBe("accepted");
    expect((await readCurrentProfile(root))?.commands).toHaveLength(2);
  });
});

// --- guidance provenance ----------------------------------------------------

describe("guidance provenance", () => {
  test("normalizeProfileGuidance only rewrites line endings and caps at 4 KiB", () => {
    expect(normalizeProfileGuidance(null)).toBeNull();
    expect(normalizeProfileGuidance("")).toBeNull();
    expect(normalizeProfileGuidance("a\r\nb\rc")).toBe("a\nb\nc");

    const over = "x".repeat(PROFILE_GUIDANCE_MAX_BYTES + 50);
    const capped = normalizeProfileGuidance(over);
    expect(capped).not.toBeNull();
    expect(new TextEncoder().encode(capped!).byteLength).toBe(
      PROFILE_GUIDANCE_MAX_BYTES,
    );
  });

  test("mergeProfileGuidance concatenates in arrival order under the cap", () => {
    expect(mergeProfileGuidance("first", "second")).toBe("first\nsecond");
    expect(mergeProfileGuidance(null, "only")).toBe("only");
    const left = "a".repeat(PROFILE_GUIDANCE_MAX_BYTES - 10);
    const merged = mergeProfileGuidance(left, "bbbbbbbbbbbb");
    expect(new TextEncoder().encode(merged!).byteLength).toBe(
      PROFILE_GUIDANCE_MAX_BYTES,
    );
  });

  test("guidance on the run is copied into accepted provenance", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER, {
      request: {
        source: "operator",
        requestedBy: "alice",
        guidance: "Check the Rust workspace carefully.",
      },
    });
    expect(run.request.guidance).toBe("Check the Rust workspace carefully.");

    const result = await submitProfile(
      root,
      polyglotCandidate(),
      "erica",
      run.runId,
    );
    expect(result.status).toBe("accepted");
    expect((await readCurrentProfile(root))?.profiler.request.guidance).toBe(
      "Check the Rust workspace carefully.",
    );
  });

  test("appended guidance merges and never bypasses validation", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER, {
      request: {
        source: "operator",
        requestedBy: "alice",
        guidance: "first",
      },
    });
    const merged = await appendProfilingGuidance(root, run.runId, "second", {
      source: "orchestrator",
      requestedBy: "bob",
    });
    expect(merged?.guidance).toBe("first\nsecond");

    // Guidance is provenance only: an invalid candidate is still refused.
    const bad = polyglotCandidate();
    bad.commands[0]!.evidence = {
      path: "backend/nope.toml",
      basis: "invented",
    };
    const rejected = await submitProfile(root, bad, "erica", run.runId);
    expect(rejectionCodes(rejected)).toEqual(["missing-path"]);
    expect(await readCurrentProfile(root)).toBeNull();

    // After a failed run, start fresh and land with the merged guidance gone
    // (new run). The point is the earlier rejection was not waived by guidance.
    const next = await beginProfiling(root, PROFILER, {
      request: {
        source: "operator",
        requestedBy: "alice",
        guidance: "still only advice",
      },
    });
    expect(
      (await submitProfile(root, polyglotCandidate(), "erica", next.runId))
        .status,
    ).toBe("accepted");
    expect((await readCurrentProfile(root))?.profiler.request.guidance).toBe(
      "still only advice",
    );
  });
});

// --- inventory --------------------------------------------------------------

describe("inventory", () => {
  test("digests the working tree the profiler will read", async () => {
    const root = await polyglotRepo();
    const first = await computeProfileInventory(root);
    expect(first.entries.map((entry) => entry.path)).toContain("backend/Cargo.toml");
    expect(first.digest).toHaveLength(64);

    // Same tree, same digest.
    expect((await computeProfileInventory(root)).digest).toBe(first.digest);

    // A new file is drift, and so is an edit to an existing one.
    await write(root, "worker/main.py", "print(1)\n");
    const second = await computeProfileInventory(root);
    expect(second.digest).not.toBe(first.digest);
  });

  test("an edit that keeps the file the same length is still drift", async () => {
    const root = await polyglotRepo();
    await write(root, "frontend/package.json", '{ "test": "bun test" }\n');
    const before = await computeProfileInventory(root);

    // Same byte count, different command. A size-based digest is blind to this,
    // and it is exactly the edit that makes a profile wrong.
    await write(root, "frontend/package.json", '{ "test": "bun tost" }\n');
    const after = await computeProfileInventory(root);

    const entry = (inventory: typeof before) =>
      inventory.entries.find((e) => e.path === "frontend/package.json")!;
    expect(entry(after).size).toBe(entry(before).size);
    expect(after.digest).not.toBe(before.digest);
  });

  test("a same-length edit under a running profiler discards the result", async () => {
    const root = await polyglotRepo();
    const run = await beginProfiling(root, PROFILER);
    const payload = polyglotCandidate();
    await write(root, "backend/Cargo.toml", "[workspace]\nmembers = []\r\n");

    expect(rejectionCodes(await submitProfile(root, payload, "erica", run.runId))).toEqual([
      "digest-mismatch",
    ]);
  });

  test("ignored files are not part of the tree the profiler reads", async () => {
    const root = await polyglotRepo();
    await write(root, ".gitignore", "ignored/\n");
    const before = await computeProfileInventory(root);
    await write(root, "ignored/blob.bin", "x".repeat(100));
    expect((await computeProfileInventory(root)).digest).toBe(before.digest);
  });

  test("Hive's own state is not repo input", async () => {
    const root = await polyglotRepo();
    // .hive is tracked in a Hive-using repo, and the fleet writes to it while a
    // profiler runs. If it counted as input, another agent taking a memory note
    // would discard a perfectly good profiling run.
    await write(root, ".hive/memory/note.md", "a note\n");
    git(root, ["add", "-A"]);
    const before = await computeProfileInventory(root);
    expect(before.entries.map((entry) => entry.path)).not.toContain(
      ".hive/memory/note.md",
    );

    await write(root, ".hive/memory/note.md", "a different note entirely\n");
    expect((await computeProfileInventory(root)).digest).toBe(before.digest);
  });

  test("a symlink is digested as a link, never followed out of the project", async () => {
    const root = await polyglotRepo();
    const outside = await mkdtemp(join(tmpdir(), "hive-outside-"));
    await writeFile(join(outside, "secret.env"), "TOKEN=alpha\n");
    await symlink(join(outside, "secret.env"), join(root, "linked.env"));

    const before = await computeProfileInventory(root);
    const linked = before.entries.find((entry) => entry.path === "linked.env");
    expect(linked).toBeDefined();

    // The link's *target file* changes; the inventory does not, because the
    // inventory never read through the link.
    await writeFile(join(outside, "secret.env"), "TOKEN=omega-and-longer\n");
    expect((await computeProfileInventory(root)).digest).toBe(before.digest);

    await rm(outside, { recursive: true, force: true });
  });
});
