// The daemon accepts a profile; the model only proposes one.
//
// Everything a profiling agent submits is a claim about a repo the daemon can
// read for itself, so it does — before a single byte reaches `current.json`.
// Nothing here is a taste check on the model's answers: each rule refuses a
// payload that is *checkably* wrong, and a payload that survives all of them is
// still only as good as the model that wrote it. That is the point of
// `evidence`, `confidence` and `unknowns` — the profile carries its own audit
// trail forward to whatever reads it.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  ProjectProfileSchema,
  REPO_SCOPE,
  type ProjectProfile,
  type ProjectProfileEvidence,
  type ProjectProfileRun,
} from "../schemas/project-profile";

export type ProfileRejectionCode =
  /** The payload is not a profile of the current schema version. */
  | "schema"
  /** The caller is not the agent that owns the active run, or the profile names
   * another project. */
  | "unauthorized"
  /** The run this payload belongs to is no longer the active one. */
  | "superseded"
  /** Nothing is profiling; there is no run to submit to. */
  | "no-active-run"
  /** The repo changed since the profiler read it. */
  | "digest-mismatch"
  /** A cited path does not exist. */
  | "missing-path"
  /** A cited path resolves outside the project. */
  | "path-escape"
  /** A command's `cwd` is not a directory, or lies outside its workspace. */
  | "invalid-cwd"
  /** A claim is scoped to a workspace the profile never declares. */
  | "unknown-scope"
  /** The same thing is claimed twice. */
  | "duplicate"
  /** Two claims disagree and the profile does not say so. */
  | "contradiction";

export interface ProfileRejection {
  code: ProfileRejectionCode;
  message: string;
  /** The field or path the rejection is about, when there is one. */
  at?: string;
}

export interface ProfileValidationContext {
  /** The project's working tree, for reading the paths the profile cites. */
  root: string;
  /** The project the daemon resolved `root` to. */
  hiveUuid: string;
  /** The run in flight, from `state.json`. */
  run: ProjectProfileRun;
  /** The authenticated caller. The daemon knows who this is; the payload only
   * claims who it is, which is why both are checked against the run. */
  subject: string;
  /** The inventory digest as observed *now*, not when the run began. */
  inventoryDigest: string;
}

export type ProfileValidation =
  | { ok: true; profile: ProjectProfile }
  | { ok: false; rejections: ProfileRejection[] };

/** Validate a submitted payload against the repo it describes. The checks run in
 * order of cost and of consequence: schema, then who is submitting, then whether
 * the repo they profiled is still the repo on disk, and only then the contents.
 * A payload that fails an early check is not read further — there is nothing to
 * learn from the contents of a profile submitted by the wrong agent. */
export async function validateProfileSubmission(
  payload: unknown,
  context: ProfileValidationContext,
): Promise<ProfileValidation> {
  const parsed = ProjectProfileSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      rejections: parsed.error.issues.map((issue) => ({
        code: "schema" as const,
        message: issue.message,
        at: issue.path.join(".") || "(root)",
      })),
    };
  }
  const profile = parsed.data;

  const identity = checkIdentity(profile, context);
  if (identity.length > 0) return { ok: false, rejections: identity };

  const digest = checkDigest(profile, context);
  if (digest.length > 0) return { ok: false, rejections: digest };

  const rejections = [
    ...checkDuplicates(profile),
    ...checkScopes(profile),
    ...(await checkPaths(profile, context.root)),
  ];
  return rejections.length > 0
    ? { ok: false, rejections }
    : { ok: true, profile };
}

/** The credential the daemon authenticated must own the active run, and the run
 * must be the one in flight. A submission from a superseded run is not a failure
 * of *this* run — the newer one is still going — so the two are distinct codes,
 * and the caller treats them differently. */
function checkIdentity(
  profile: ProjectProfile,
  context: ProfileValidationContext,
): ProfileRejection[] {
  const { run, subject, hiveUuid } = context;
  if (profile.profiler.runId !== run.runId) {
    return [
      {
        code: "superseded",
        message: `Profile was authored for run ${profile.profiler.runId}; the active run is ${run.runId}.`,
        at: "profiler.runId",
      },
    ];
  }
  const rejections: ProfileRejection[] = [];
  if (subject !== run.agent) {
    rejections.push({
      code: "unauthorized",
      message: `${subject} is not the profiler for run ${run.runId} (${run.agent} is).`,
      at: "profiler.agent",
    });
  }
  if (profile.profiler.agent !== run.agent) {
    rejections.push({
      code: "unauthorized",
      message: `Profile claims profiler ${profile.profiler.agent}; run ${run.runId} belongs to ${run.agent}.`,
      at: "profiler.agent",
    });
  }
  if (profile.project.hiveUuid !== hiveUuid) {
    rejections.push({
      code: "unauthorized",
      message: `Profile describes project ${profile.project.hiveUuid}, not ${hiveUuid}.`,
      at: "project.hiveUuid",
    });
  }
  return rejections;
}

/** The repo the profiler read must still be the repo on disk. Two ways it might
 * not be: the payload cites a digest that was never handed out (a fabricated or
 * replayed digest), or the tree moved under the profiler while it worked. Both
 * discard the result — a profile of a repo that no longer exists is worse than
 * no profile, because something will act on it. */
function checkDigest(
  profile: ProjectProfile,
  context: ProfileValidationContext,
): ProfileRejection[] {
  const { run, inventoryDigest } = context;
  if (profile.project.inputDigest !== run.inputDigest) {
    return [
      {
        code: "digest-mismatch",
        message: `Profile cites input digest ${profile.project.inputDigest}; run ${run.runId} was started on ${run.inputDigest}.`,
        at: "project.inputDigest",
      },
    ];
  }
  if (run.inputDigest !== inventoryDigest) {
    return [
      {
        code: "digest-mismatch",
        message: `The repository changed while ${run.agent} was profiling it (${run.inputDigest} → ${inventoryDigest}); the result describes a tree that no longer exists.`,
        at: "project.inputDigest",
      },
    ];
  }
  return [];
}

/** Every claim scoped to a workspace names a workspace the profile declares.
 * This is what stops `{"purpose":"test","command":"cargo test","scope":"backend"}`
 * from being submitted by a profile that never said what `backend` is. */
function checkScopes(profile: ProjectProfile): ProfileRejection[] {
  const workspaces = new Set(profile.workspaces.map((w) => w.name));
  const rejections: ProfileRejection[] = [];
  const check = (scope: string, at: string): void => {
    if (scope === REPO_SCOPE || workspaces.has(scope)) return;
    rejections.push({
      code: "unknown-scope",
      message: `Scope "${scope}" is not a declared workspace.`,
      at,
    });
  };
  profile.languages.forEach((l, i) => check(l.scope, `languages.${i}.scope`));
  profile.packageManagers.forEach((p, i) =>
    check(p.scope, `packageManagers.${i}.scope`),
  );
  profile.buildSystems.forEach((b, i) =>
    check(b.scope, `buildSystems.${i}.scope`),
  );
  profile.commands.forEach((c, i) => check(c.scope, `commands.${i}.scope`));
  return rejections;
}

/** Duplicates and contradictions. A duplicate is noise; a contradiction is two
 * incompatible answers to the same question, and a reader that takes the first
 * one silently picks a coin flip. Either the profiler resolves it, or it says
 * out loud in `conflicts` that the repo itself disagrees — which is a real thing
 * for a repo to do, and worth knowing. */
function checkDuplicates(profile: ProjectProfile): ProfileRejection[] {
  const rejections: ProfileRejection[] = [];
  const seen = (
    keys: string[],
    what: string,
    at: (index: number) => string,
  ): void => {
    const first = new Map<string, number>();
    keys.forEach((key, index) => {
      const earlier = first.get(key);
      if (earlier === undefined) {
        first.set(key, index);
        return;
      }
      rejections.push({
        code: "duplicate",
        message: `${what} "${key}" is declared twice (also at index ${earlier}).`,
        at: at(index),
      });
    });
  };

  seen(
    profile.workspaces.map((w) => w.name),
    "Workspace",
    (i) => `workspaces.${i}.name`,
  );
  seen(
    profile.workspaces.map((w) => w.path),
    "Workspace path",
    (i) => `workspaces.${i}.path`,
  );
  seen(
    profile.languages.map((l) => `${l.name}@${l.scope}`),
    "Language",
    (i) => `languages.${i}`,
  );
  seen(
    profile.packageManagers.map((p) => `${p.name}@${p.scope}`),
    "Package manager",
    (i) => `packageManagers.${i}`,
  );
  seen(
    profile.buildSystems.map((b) => `${b.name}@${b.scope}`),
    "Build system",
    (i) => `buildSystems.${i}`,
  );
  seen(
    profile.entryPoints.map((e) => e.path),
    "Entry point",
    (i) => `entryPoints.${i}.path`,
  );
  seen(
    profile.conventionFiles.map((c) => c.path),
    "Convention file",
    (i) => `conventionFiles.${i}.path`,
  );
  seen(profile.docs.briefable, "Briefable doc", (i) => `docs.briefable.${i}`);

  // A command is identified by what it is for and where it runs. Two commands
  // sharing that identity are either the same command written twice, or two
  // different answers to one question.
  const declared = new Set(
    profile.conflicts.flatMap((conflict) => conflict.claims),
  );
  const byIdentity = new Map<string, { command: string; index: number }>();
  profile.commands.forEach((command, index) => {
    const identity = `${command.purpose}@${command.scope}:${command.cwd}`;
    const earlier = byIdentity.get(identity);
    if (earlier === undefined) {
      byIdentity.set(identity, { command: command.command, index });
      return;
    }
    if (earlier.command === command.command) {
      rejections.push({
        code: "duplicate",
        message: `Command "${command.command}" is declared twice for ${identity}.`,
        at: `commands.${index}`,
      });
      return;
    }
    if (declared.has(earlier.command) && declared.has(command.command)) return;
    rejections.push({
      code: "contradiction",
      message: `Two ${command.purpose} commands for ${identity} — "${earlier.command}" and "${command.command}" — and neither is declared in conflicts.`,
      at: `commands.${index}.command`,
    });
  });

  return rejections;
}

/** Every path the profile cites is read from disk: it must exist, and it must be
 * inside the project. Both halves matter. A citation to a file that is not there
 * is a hallucinated manifest, and it is the single cheapest lie to catch. A path
 * that resolves outside the project — `../../etc`, an absolute path, a symlink
 * out of the tree — is a profile telling a spawned agent to read or run
 * something that is not this repo, so containment is checked after resolving
 * symlinks, not before. */
/** Is `path` the directory `parent`, or inside it? Both arguments are already
 * absolute; the `sep` is what stops `/repo-backup` from counting as inside
 * `/repo`. */
function contains(parent: string, path: string): boolean {
  return path === parent || path.startsWith(parent + sep);
}

async function checkPaths(
  profile: ProjectProfile,
  root: string,
): Promise<ProfileRejection[]> {
  const realRoot = await realpath(root);
  const rejections: ProfileRejection[] = [];

  const check = async (
    relative: string,
    at: string,
    kind: "file" | "directory" | "any",
  ): Promise<void> => {
    if (isAbsolute(relative)) {
      rejections.push({
        code: "path-escape",
        message: `"${relative}" is absolute; profile paths are repo-relative.`,
        at,
      });
      return;
    }
    const resolved = resolve(root, relative);
    // Lexical containment first, and it is not redundant with the realpath check
    // below: `../../etc/passwd` escapes whether or not it exists, and reporting
    // it as merely "missing" would hide what it was.
    if (!contains(resolve(root), resolved)) {
      rejections.push({
        code: "path-escape",
        message: `"${relative}" points outside the project.`,
        at,
      });
      return;
    }
    let real: string;
    let entry: Awaited<ReturnType<typeof stat>>;
    try {
      real = await realpath(resolved);
      entry = await stat(real);
    } catch {
      rejections.push({
        code: "missing-path",
        message: `"${relative}" does not exist in the project.`,
        at,
      });
      return;
    }
    // After realpath, so a symlink pointing out of the tree cannot smuggle a
    // path past a string-prefix check.
    if (!contains(realRoot, real)) {
      rejections.push({
        code: "path-escape",
        message: `"${relative}" resolves to ${real}, outside the project.`,
        at,
      });
      return;
    }
    if (kind === "directory" && !entry.isDirectory()) {
      rejections.push({
        code: at.endsWith(".cwd") ? "invalid-cwd" : "missing-path",
        message: `"${relative}" is not a directory.`,
        at,
      });
      return;
    }
    if (kind === "file" && !entry.isFile()) {
      rejections.push({
        code: "missing-path",
        message: `"${relative}" is not a file.`,
        at,
      });
    }
  };

  const checkEvidence = async (
    evidence: ProjectProfileEvidence,
    at: string,
  ): Promise<void> => {
    await check(evidence.path, `${at}.path`, "any");
  };

  for (const [index, language] of profile.languages.entries()) {
    await checkEvidence(language.evidence, `languages.${index}.evidence`);
  }
  for (const [index, manager] of profile.packageManagers.entries()) {
    await checkEvidence(manager.evidence, `packageManagers.${index}.evidence`);
  }
  for (const [index, system] of profile.buildSystems.entries()) {
    await checkEvidence(system.evidence, `buildSystems.${index}.evidence`);
  }
  for (const [index, workspace] of profile.workspaces.entries()) {
    await check(workspace.path, `workspaces.${index}.path`, "directory");
    await checkEvidence(workspace.evidence, `workspaces.${index}.evidence`);
  }
  for (const [index, command] of profile.commands.entries()) {
    await check(command.cwd, `commands.${index}.cwd`, "directory");
    await checkEvidence(command.evidence, `commands.${index}.evidence`);
  }
  for (const [index, entryPoint] of profile.entryPoints.entries()) {
    await check(entryPoint.path, `entryPoints.${index}.path`, "file");
    await checkEvidence(entryPoint.evidence, `entryPoints.${index}.evidence`);
  }
  for (const [index, convention] of profile.conventionFiles.entries()) {
    await check(convention.path, `conventionFiles.${index}.path`, "file");
  }
  for (const [index, doc] of profile.docs.briefable.entries()) {
    await check(doc, `docs.briefable.${index}`, "file");
  }
  if (profile.docs.primary !== null) {
    await check(profile.docs.primary.path, "docs.primary.path", "file");
    await checkEvidence(profile.docs.primary.evidence, "docs.primary.evidence");
  }
  for (const [index, path] of profile.staleness.paths.entries()) {
    await check(path, `staleness.paths.${index}`, "any");
  }

  // A command's working directory must be inside the workspace it claims —
  // otherwise `scope` is decoration and the command is repo-wide after all.
  const workspacePaths = new Map(
    profile.workspaces.map((workspace) => [workspace.name, workspace.path]),
  );
  for (const [index, command] of profile.commands.entries()) {
    if (command.scope === REPO_SCOPE) continue;
    const workspacePath = workspacePaths.get(command.scope);
    if (workspacePath === undefined) continue; // already an unknown-scope rejection
    const workspaceRoot = resolve(root, workspacePath);
    const commandRoot = resolve(root, command.cwd);
    if (!contains(workspaceRoot, commandRoot)) {
      rejections.push({
        code: "invalid-cwd",
        message: `Command "${command.command}" is scoped to workspace ${command.scope} (${workspacePath}) but runs in "${command.cwd}".`,
        at: `commands.${index}.cwd`,
      });
    }
  }

  return rejections;
}
