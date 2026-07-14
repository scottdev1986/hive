// The profile service: the daemon's side of an agent-authored project profile.
//
// The rule the whole file exists to hold: **the last validated profile stays
// active until an atomic replacement succeeds.** A profiler that crashes, is
// killed, submits garbage, or is beaten to the punch by a newer run leaves
// `current.json` exactly as it found it. `current.json` is only ever replaced by
// a rename of a fully written temp file, so a reader sees the old profile or the
// new one and never half of either — not even if the machine loses power between
// the write and the rename.
//
// Storage is per project, keyed by the uuid the registry mints, next to the rest
// of Hive's derived state and inside nobody's diff:
//
//   ~/.hive/projects/<hiveUuid>/profile/current.json   last validated profile
//   ~/.hive/projects/<hiveUuid>/profile/state.json     lifecycle, digest, run
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  PROJECT_PROFILE_SCHEMA_VERSION,
  ProjectProfileSchema,
  ProjectProfileStateSchema,
  type ProjectProfile,
  type ProjectProfileLifecycle,
  type ProjectProfileState,
} from "../schemas/project-profile";
import { projectHiveUuid, projectStateDir } from "./project-state";
import {
  validateProfileSubmission,
  type ProfileRejection,
} from "./project-profile-validate";

export type {
  ProfileRejection,
  ProfileRejectionCode,
} from "./project-profile-validate";

export function projectProfileDir(root: string): string {
  return join(projectStateDir(root), "profile");
}

export function currentProfilePath(root: string): string {
  return join(projectProfileDir(root), "current.json");
}

export function profileStatePath(root: string): string {
  return join(projectProfileDir(root), "state.json");
}

// --- the repository inventory ----------------------------------------------

export interface ProfileInventoryEntry {
  path: string;
  size: number;
  /** sha256 of the file's contents; of the link target, for a symlink. */
  contentDigest: string;
}

export interface ProfileInventory {
  entries: ProfileInventoryEntry[];
  /** Digest over the entries. Changes when a file is added, removed, or *edited*
   * — which is what "the repo the profiler read" means. */
  digest: string;
}

/** Directories a repository inventory has no business reading. These are skipped
 * even when they are tracked, on both the Git and the walk path:
 *
 * - `.hive` is Hive's own state. Agents write memory and skills into it while a
 *   profiler is running, so counting it as repo input would discard perfectly
 *   good profiling runs because something else in the fleet took a note.
 * - the rest are dependency and build trees. They are enormous, they are not the
 *   project, and hashing them would dominate the cost of every inventory.
 */
const UNREAD_DIRECTORIES = new Set([
  ".git",
  ".hive",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  ".venv",
]);

const isUnread = (path: string): boolean =>
  path.split("/").some((segment) => UNREAD_DIRECTORIES.has(segment));

function trackedAndUntrackedFiles(root: string): string[] | null {
  try {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        root,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { stdout: "pipe", stderr: "ignore", timeout: 30_000, killSignal: "SIGKILL" },
    );
    if (result.exitCode !== 0) return null;
    return result.stdout
      .toString()
      .split("\0")
      .filter((path) => path.length > 0);
  } catch {
    return null;
  }
}

async function walkFiles(root: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (UNREAD_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    // `withFileTypes` reports a symlink as a symlink, not as what it points at,
    // so a link to a directory outside the tree is never descended into.
    if (entry.isDirectory()) found.push(...(await walkFiles(root, full)));
    else found.push(relative(root, full));
  }
  return found;
}

/** Fingerprint one file without following it out of the project and without
 * reading it into memory whole. A symlink is digested as the *link*: its target
 * is a string, not a file to be read, so a link pointing at `/etc/shadow` is one
 * more path in the inventory and nothing else. */
async function fingerprintFile(
  root: string,
  path: string,
): Promise<ProfileInventoryEntry | null> {
  const full = join(root, path);
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(full);
  } catch {
    // Raced away between listing and stat; it is not in the tree the profiler
    // will read either.
    return null;
  }
  const hasher = createHash("sha256");
  if (entry.isSymbolicLink()) {
    hasher.update(`symlink:${await readlink(full)}`);
  } else if (entry.isFile()) {
    for await (const chunk of Bun.file(full).stream()) hasher.update(chunk);
  } else {
    return null; // sockets, fifos: not repo input
  }
  return { path, size: entry.size, contentDigest: hasher.digest("hex") };
}

/** What the repo looked like at a moment: every file the profiler could have
 * read, by path and content. The profiler is handed this digest when its run
 * begins and hands it back with its profile; if the tree has moved on by then,
 * the profile describes a repo that no longer exists.
 *
 * The digest is over content, not size. A one-character edit that keeps a file
 * the same length — `debug = true` → `debug = fals`, `"test": "bun test"` →
 * `"test": "bun tost"` — is exactly the kind of change that makes a profile
 * wrong, and a size-based digest cannot see it at all.
 *
 * This is a *run-scoped* check, not a staleness signal. Staleness is the
 * profile's own `staleness.paths` — hashing the whole tree to decide whether an
 * accepted profile is still good is precisely the mistake SPEC §14 records,
 * where a typo fixed in a comment made a correct profile nag the user to refresh
 * it. Over the minutes one profiler runs, though, "did anything at all change"
 * is the right question, and content is the only honest way to ask it. */
export async function computeProfileInventory(
  root: string,
): Promise<ProfileInventory> {
  const paths = trackedAndUntrackedFiles(root) ?? (await walkFiles(root, root));
  const entries: ProfileInventoryEntry[] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (isUnread(path)) continue;
    const entry = await fingerprintFile(root, path);
    if (entry !== null) entries.push(entry);
  }
  const digest = createHash("sha256")
    .update(
      entries
        .map((entry) => `${entry.path}:${entry.size}:${entry.contentDigest}`)
        .join("\n"),
    )
    .digest("hex");
  return { entries, digest };
}

// --- atomic storage ---------------------------------------------------------

/** Write JSON so that no reader — and no crash — can ever see a partial file.
 * The temp name is unique per process *and* per call, so two daemons writing at
 * once cannot land in each other's temp file; the contents are flushed to disk
 * before the rename, so a power cut cannot leave a renamed-but-empty file; and
 * the rename is atomic within the directory, so `current.json` is the old bytes
 * until the instant it is all of the new ones. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The last validated profile, or null when there is none. A `current.json` that
 * does not parse is treated as absent rather than thrown: the profile is a
 * cache, and an unreadable cache means "profile again", never "Hive will not
 * start". */
export async function readCurrentProfile(
  root: string,
): Promise<ProjectProfile | null> {
  const raw = await readJson(currentProfilePath(root));
  if (raw === null) return null;
  const parsed = ProjectProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The lifecycle state. A project nobody has profiled has no `state.json`, and
 * neither does one whose state file was lost or written by an older schema — all
 * three are `unprofiled`, which is the honest answer and the one that leads to
 * the right next action. */
export async function readProfileState(
  root: string,
): Promise<ProjectProfileState> {
  const raw = await readJson(profileStatePath(root));
  const parsed = ProjectProfileStateSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    lifecycle: "unprofiled",
    hiveUuid: projectHiveUuid(root),
    updatedAt: new Date().toISOString(),
    run: null,
    profiled: null,
    reprofile: null,
    failure: null,
  };
}

async function writeProfileState(
  root: string,
  state: ProjectProfileState,
): Promise<void> {
  await writeJsonAtomic(profileStatePath(root), state);
}

// --- lifecycle --------------------------------------------------------------

export interface ProfilerIdentity {
  agent: string;
  provider: string;
  model: string;
}

export interface ProfileRunHandle {
  runId: string;
  /** The digest the submitted profile must carry back. */
  inputDigest: string;
  inventory: ProfileInventory;
}

/** Start a profiling run: `unprofiled | stale | failed | current → profiling`.
 *
 * The daemon observes the inventory here, and *it* — not the model — decides
 * what the profiler was looking at. Beginning a second run supersedes the first:
 * the new run id is the only one that can land, so a slow profiler cannot
 * overwrite the work of the one that replaced it. Nothing is destroyed; a
 * profile already in `current.json` stays exactly where it is and stays readable
 * for the whole run. */
export async function beginProfiling(
  root: string,
  profiler: ProfilerIdentity,
): Promise<ProfileRunHandle> {
  const inventory = await computeProfileInventory(root);
  const previous = await readProfileState(root);
  const runId = randomUUID();
  await writeProfileState(root, {
    ...previous,
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    lifecycle: "profiling",
    hiveUuid: projectHiveUuid(root),
    updatedAt: new Date().toISOString(),
    run: {
      runId,
      agent: profiler.agent,
      provider: profiler.provider,
      model: profiler.model,
      inputDigest: inventory.digest,
      startedAt: new Date().toISOString(),
    },
  });
  return { runId, inputDigest: inventory.digest, inventory };
}

export type ProfileSubmitResult =
  | { status: "accepted"; profile: ProjectProfile }
  | {
      status: "rejected";
      rejections: ProfileRejection[];
      /** What the project is in *after* the rejection. A superseded submission
       * leaves the newer run profiling; a repo that changed under the profiler
       * goes back to needing one; anything else is a failed run. */
      lifecycle: ProjectProfileLifecycle;
    };

/** Submit a profile. `subject` is the caller the daemon authenticated — not a
 * name out of the payload, which is only a claim.
 *
 * On acceptance: `profiling → current`, and the profile becomes readable in the
 * same instant its state says so. `current.json` is written before `state.json`
 * on purpose. A crash between the two leaves a valid new profile that the state
 * has not caught up with — recoverable, and readable. The other order would
 * leave a state file swearing a profile is current while `current.json` still
 * holds the old one, which is a lie, and lies do not recover.
 *
 * On rejection nothing is written to `current.json` at all. */
export async function submitProfile(
  root: string,
  payload: unknown,
  subject: string,
): Promise<ProfileSubmitResult> {
  const state = await readProfileState(root);
  if (state.run === null || state.lifecycle !== "profiling") {
    return {
      status: "rejected",
      rejections: [
        {
          code: "no-active-run",
          message: `No profiling run is in flight for this project (lifecycle: ${state.lifecycle}).`,
        },
      ],
      lifecycle: state.lifecycle,
    };
  }

  const inventory = await computeProfileInventory(root);
  const validation = await validateProfileSubmission(payload, {
    root,
    hiveUuid: projectHiveUuid(root),
    run: state.run,
    subject,
    inventoryDigest: inventory.digest,
  });

  if (!validation.ok) {
    // Only the agent that owns the run can change its state. Otherwise any
    // authenticated caller could end someone else's profiling run by submitting
    // rubbish to it — a rejected submission would write `failed` over a run that
    // is still perfectly alive.
    const ownsRun = state.run.agent === subject;
    return {
      status: "rejected",
      rejections: validation.rejections,
      lifecycle: ownsRun
        ? await recordRejection(root, state, validation.rejections)
        : state.lifecycle,
    };
  }

  const profile = validation.profile;
  await writeJsonAtomic(currentProfilePath(root), profile);
  await writeProfileState(root, {
    ...state,
    lifecycle: "current",
    updatedAt: new Date().toISOString(),
    run: null,
    profiled: {
      at: new Date().toISOString(),
      inputDigest: profile.project.inputDigest,
      profiler: profile.profiler,
    },
    reprofile: null,
    failure: null,
  });
  return { status: "accepted", profile };
}

/** Where a rejected submission leaves the project.
 *
 * A *superseded* submission changes nothing: a newer run owns the state, and
 * letting the loser of the race write its failure over the winner's run would be
 * the very corruption this service exists to prevent.
 *
 * A *digest mismatch* is not the profiler's fault — the repo moved. The result
 * is discarded and the project is marked for a rerun: back to `stale` if a
 * validated profile is still there to use in the meantime, `unprofiled` if not.
 *
 * Everything else is a failed run, recorded with the reason, and the last
 * validated profile stays exactly where it was. */
async function recordRejection(
  root: string,
  state: ProjectProfileState,
  rejections: ProfileRejection[],
): Promise<ProjectProfileLifecycle> {
  const first = rejections[0];
  if (first === undefined || first.code === "superseded") {
    return state.lifecycle;
  }

  const now = new Date().toISOString();
  const failure = {
    at: now,
    code: first.code,
    detail: rejections
      .map((rejection) =>
        rejection.at === undefined
          ? rejection.message
          : `${rejection.at}: ${rejection.message}`,
      )
      .join(" "),
    runId: state.run?.runId ?? null,
  };

  if (first.code === "digest-mismatch") {
    const lifecycle: ProjectProfileLifecycle =
      state.profiled === null ? "unprofiled" : "stale";
    await writeProfileState(root, {
      ...state,
      lifecycle,
      updatedAt: now,
      run: null,
      reprofile: {
        at: now,
        source: "digest-mismatch",
        reason: first.message,
      },
      failure,
    });
    return lifecycle;
  }

  await writeProfileState(root, {
    ...state,
    lifecycle: "failed",
    updatedAt: now,
    run: null,
    failure,
  });
  return "failed";
}

/** End a run that produced nothing — the profiler crashed, ran out of context,
 * or gave up: `profiling → failed`. A stale run id is ignored, so a dead
 * profiler cannot fail the run that replaced it. The last validated profile is
 * untouched, and stays readable. */
export async function failProfiling(
  root: string,
  runId: string,
  reason: string,
): Promise<ProjectProfileState> {
  const state = await readProfileState(root);
  if (state.run === null || state.run.runId !== runId) return state;
  const now = new Date().toISOString();
  const next: ProjectProfileState = {
    ...state,
    lifecycle: "failed",
    updatedAt: now,
    run: null,
    failure: { at: now, code: "profiler-failed", detail: reason, runId },
  };
  await writeProfileState(root, next);
  return next;
}

/** `current → stale`: the profile's own staleness inputs moved, so it should be
 * rebuilt. It stays readable and stays in use until a new one is accepted —
 * "stale" means "a refresh is due", never "unusable". Drift detection (a later
 * slice) is what decides this; the transition itself lives here because it is
 * part of the lifecycle. A project that is currently profiling is left alone:
 * the run in flight is already the refresh.
 *
 * `source` is who made the call — `drift`, `operator`, a tool name. It is
 * recorded by the daemon, never taken from a model, and it is what lets a rerun
 * be explained afterwards instead of merely observed. */
export async function markProfileStale(
  root: string,
  source: string,
  reason: string,
): Promise<ProjectProfileState> {
  const state = await readProfileState(root);
  if (state.lifecycle !== "current") return state;
  const next: ProjectProfileState = {
    ...state,
    lifecycle: "stale",
    updatedAt: new Date().toISOString(),
    reprofile: { at: new Date().toISOString(), source, reason },
  };
  await writeProfileState(root, next);
  return next;
}
