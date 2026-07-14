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
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PROJECT_PROFILE_SCHEMA_VERSION,
  ProjectProfileSchema,
  ProjectProfileStateSchema,
  mergeProfileGuidance,
  normalizeProfileGuidance,
  type ProjectProfile,
  type ProjectProfileLifecycle,
  type ProjectProfileRequest,
  type ProjectProfileState,
} from "../schemas/project-profile";
import { withFileLock } from "../adapters/file-lock";
import { projectHiveUuid, projectStateDir } from "./project-state";
import {
  proveProfileStillHolds,
  validateProfileSubmission,
  type ProfileRejection,
} from "./project-profile-validate";

export type {
  ProfileRejection,
  ProfileRejectionCode,
} from "./project-profile-validate";

export {
  PROFILE_GUIDANCE_MAX_BYTES,
  mergeProfileGuidance,
  normalizeProfileGuidance,
} from "../schemas/project-profile";

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
  type: "file" | "symlink";
  size: number;
  /** sha256 of file contents or of an allowed repo-relative link target. */
  contentDigest: string;
  linkTarget?: string;
  contentOmissionReason?: "binary" | "outside-project";
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
  "bower_components",
  ".pnpm-store",
  ".yarn",
  "vendor",
  "vendors",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
]);

const CREDENTIAL_DIRECTORIES = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".gnupg",
  ".docker",
]);

const MAX_INVENTORY_FILES = 100_000;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INVENTORY_PATH_SEGMENTS = 64;
const MAX_INVENTORY_MILLISECONDS = 60_000;

export class ProfileInventoryLimitError extends Error {
  readonly code = "inventory-limit" as const;

  constructor(readonly limit: "files" | "bytes" | "path-segments" | "time") {
    super(`inventory-limit: exceeded ${limit}`);
    this.name = "ProfileInventoryLimitError";
  }
}

interface InventoryBudget {
  startedAt: number;
  hashedBytes: number;
}

function assertWithinInventoryTime(budget: InventoryBudget): void {
  if (performance.now() - budget.startedAt > MAX_INVENTORY_MILLISECONDS) {
    throw new ProfileInventoryLimitError("time");
  }
}

function reserveHashedBytes(budget: InventoryBudget, bytes: number): void {
  assertWithinInventoryTime(budget);
  if (budget.hashedBytes + bytes > MAX_INVENTORY_BYTES) {
    throw new ProfileInventoryLimitError("bytes");
  }
  budget.hashedBytes += bytes;
}

function normalizeInventoryPath(path: string): string | null {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) return null;
  const normalized = path.split(sep).join("/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

function isKnownSecretBasename(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env.example" || lower === ".env.sample") return false;
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === ".netrc" ||
    lower === ".git-credentials" ||
    lower === "id_rsa" ||
    lower === "id_ed25519" ||
    lower.startsWith("credentials") ||
    lower.startsWith("secrets") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx")
  ) {
    return true;
  }
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return compact.includes("privatekey") || compact.includes("serviceaccount");
}

function isUnread(path: string): boolean {
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        UNREAD_DIRECTORIES.has(segment) || CREDENTIAL_DIRECTORIES.has(segment),
    )
  ) {
    return true;
  }
  if (
    segments.some(
      (segment, index) => segment === ".config" && segments[index + 1] === "gcloud",
    )
  ) {
    return true;
  }
  return isKnownSecretBasename(segments.at(-1)!);
}

function collectCandidate(
  path: string,
  candidates: Set<string>,
  budget: InventoryBudget,
): void {
  assertWithinInventoryTime(budget);
  const normalized = normalizeInventoryPath(path);
  if (normalized === null || isUnread(normalized)) return;
  if (normalized.split("/").length > MAX_INVENTORY_PATH_SEGMENTS) {
    throw new ProfileInventoryLimitError("path-segments");
  }
  if (!candidates.has(normalized) && candidates.size === MAX_INVENTORY_FILES) {
    throw new ProfileInventoryLimitError("files");
  }
  candidates.add(normalized);
}

function trackedAndUntrackedFiles(
  root: string,
  budget: InventoryBudget,
): Set<string> | null {
  try {
    assertWithinInventoryTime(budget);
    const remaining = MAX_INVENTORY_MILLISECONDS - (performance.now() - budget.startedAt);
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
      {
        stdout: "pipe",
        stderr: "ignore",
        timeout: Math.max(1, Math.min(30_000, remaining)),
        killSignal: "SIGKILL",
      },
    );
    if (result.exitCode !== 0) return null;
    const candidates = new Set<string>();
    for (const path of result.stdout.toString().split("\0")) {
      if (path.length > 0) collectCandidate(path, candidates, budget);
    }
    return candidates;
  } catch (error) {
    if (error instanceof ProfileInventoryLimitError) throw error;
    return null;
  }
}

async function walkFiles(
  directory: string,
  relativeDirectory: string,
  candidates: Set<string>,
  budget: InventoryBudget,
): Promise<void> {
  assertWithinInventoryTime(budget);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assertWithinInventoryTime(budget);
    const full = join(directory, entry.name);
    const path = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const normalized = normalizeInventoryPath(path);
    if (normalized === null || isUnread(normalized)) continue;
    // `withFileTypes` reports a symlink as a symlink, not as what it points at,
    // so a link to a directory outside the tree is never descended into.
    if (entry.isDirectory()) {
      if (normalized.split("/").length >= MAX_INVENTORY_PATH_SEGMENTS) {
        throw new ProfileInventoryLimitError("path-segments");
      }
      await walkFiles(full, normalized, candidates, budget);
    } else {
      collectCandidate(normalized, candidates, budget);
    }
  }
}

async function hasSafeParentChain(
  root: string,
  path: string,
  budget: InventoryBudget,
): Promise<boolean> {
  let directory = root;
  for (const segment of path.split("/").slice(0, -1)) {
    assertWithinInventoryTime(budget);
    directory = join(directory, segment);
    try {
      if (!(await lstat(directory)).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Fingerprint one file without following it out of the project and without
 * reading it into memory whole. A symlink is digested as the *link*: its target
 * is a string, not a file to be read, so a link pointing at `/etc/shadow` is one
 * more path in the inventory and nothing else. */
async function fingerprintFile(
  root: string,
  path: string,
  budget: InventoryBudget,
): Promise<ProfileInventoryEntry | null> {
  assertWithinInventoryTime(budget);
  if (!(await hasSafeParentChain(root, path, budget))) return null;
  const full = resolve(root, path);
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(full);
  } catch {
    // Raced away between listing and stat; it is not in the tree the profiler
    // will read either.
    return null;
  }
  if (entry.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlink(full);
    } catch {
      return null;
    }
    const resolvedTarget = resolve(dirname(full), target);
    const relativeTarget = relative(root, resolvedTarget).split(sep).join("/");
    if (
      relativeTarget.length === 0 ||
      isAbsolute(relativeTarget) ||
      relativeTarget.split("/").some((segment) => segment === "..")
    ) {
      return {
        path,
        type: "symlink",
        size: 0,
        contentDigest: createHash("sha256").update("outside-project").digest("hex"),
        contentOmissionReason: "outside-project",
      };
    }
    reserveHashedBytes(budget, Buffer.byteLength(relativeTarget));
    return {
      path,
      type: "symlink",
      size: entry.size,
      contentDigest: createHash("sha256").update(relativeTarget).digest("hex"),
      linkTarget: relativeTarget,
    };
  }
  if (!entry.isFile()) return null; // sockets, fifos: not repo input

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW closes the lstat/open race: replacing the file with a symlink
    // cannot make the inventory open its target.
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) return null;
    reserveHashedBytes(budget, opened.size);

    const hasher = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let binary = false;
    let bytesRead = 0;
    let reservedBytes = opened.size;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      assertWithinInventoryTime(budget);
      const bytes = chunk as Buffer;
      bytesRead += bytes.byteLength;
      if (bytesRead > reservedBytes) {
        reserveHashedBytes(budget, bytesRead - reservedBytes);
        reservedBytes = bytesRead;
      }
      hasher.update(bytes);
      if (!binary) {
        if (bytes.includes(0)) binary = true;
        else {
          try {
            decoder.decode(bytes, { stream: true });
          } catch {
            binary = true;
          }
        }
      }
    }
    if (!binary) {
      try {
        decoder.decode();
      } catch {
        binary = true;
      }
    }
    return {
      path,
      type: "file",
      size: bytesRead,
      contentDigest: hasher.digest("hex"),
      ...(binary ? { contentOmissionReason: "binary" as const } : {}),
    };
  } catch (error) {
    if (error instanceof ProfileInventoryLimitError) throw error;
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
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
  const absoluteRoot = resolve(root);
  const budget: InventoryBudget = { startedAt: performance.now(), hashedBytes: 0 };
  let paths = trackedAndUntrackedFiles(absoluteRoot, budget);
  if (paths === null) {
    paths = new Set<string>();
    await walkFiles(absoluteRoot, "", paths, budget);
  }
  const entries: ProfileInventoryEntry[] = [];
  for (const path of [...paths].sort()) {
    assertWithinInventoryTime(budget);
    const entry = await fingerprintFile(absoluteRoot, path, budget);
    if (entry !== null) entries.push(entry);
  }
  assertWithinInventoryTime(budget);
  const digest = createHash("sha256")
    .update(
      entries
        .map((entry) => `${entry.type}\0${entry.path}\0${entry.contentDigest}`)
        .join("\0"),
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
/** Write the bytes to a private temp file and fsync them, returning its path.
 * The result is fully on disk but not yet visible under `path`; `commitStaged`
 * makes it visible. Splitting the two is what lets the caller run a last check
 * *after* the expensive write and *immediately before* the rename. */
async function stageJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}

/** Make a staged file the live contents of `path`, atomically and durably. */
async function commitStaged(temporary: string, path: string): Promise<void> {
  await rename(temporary, path);
  // The file's own bytes being on disk is not enough: the rename is a directory
  // change, and an unsynced directory can lose the new name in a power cut while
  // keeping the fully-written data nobody can now reach. Syncing the file and
  // not the directory it lands in is a durability claim the code does not honour.
  const entry = await open(dirname(path), "r");
  try {
    await entry.sync();
  } finally {
    await entry.close();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await commitStaged(await stageJson(path, value), path);
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

function emptyProfileState(root: string): ProjectProfileState {
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

/** The lifecycle state. A project nobody has profiled has no `state.json`, and
 * neither does one whose state file was lost or written by an older schema — all
 * three are `unprofiled`, which is the honest answer and the one that leads to
 * the right next action. Healing of the two-file crash window is applied in
 * memory here; call {@link reconcileProfileState} to persist it (daemon start). */
export async function readProfileState(
  root: string,
): Promise<ProjectProfileState> {
  const raw = await readJson(profileStatePath(root));
  const parsed = ProjectProfileStateSchema.safeParse(raw);
  if (!parsed.success) return emptyProfileState(root);
  return healProfileState(root, parsed.data);
}

/** Heal inconsistencies the write order can produce, without taking the lock.
 *
 * `current.json` is written before `state.json` on purpose: a crash between them
 * leaves a valid new profile that the state has not caught up with, where the
 * other order would leave a state file swearing a profile is current when
 * `current.json` still holds the old one. But "recoverable" is not "recovered",
 * and nothing was recovering it: the state said `profiling`, the run in it was
 * finished and gone, and `beginProfiling({ ifIdle: true })` — seeing a run in
 * flight that would never end — refused to start another one, forever. A profile
 * that landed would have blocked every future profile of that project.
 *
 * The lag is provable, which is why it is safe to heal: `current.json` carries
 * the run id it was authored for. If that is the run the state still thinks is
 * in flight, then the submission was accepted and only the bookkeeping was lost.
 * Nothing else can put that run id in that file.
 *
 * Also: state may never claim a different current digest than the validated
 * profile on disk. When both exist and disagree, the profile wins. */
async function healProfileState(
  root: string,
  state: ProjectProfileState,
): Promise<ProjectProfileState> {
  const current = await readCurrentProfile(root);

  if (
    state.lifecycle === "profiling" &&
    state.run !== null &&
    current !== null &&
    current.profiler.runId === state.run.runId
  ) {
    let acceptedAt = current.generatedAt;
    try {
      acceptedAt = (await lstat(currentProfilePath(root))).mtime.toISOString();
    } catch {
      // The profile parsed a moment ago; if it is gone now, its own timestamp is
      // the best evidence of when it landed.
    }
    return {
      ...state,
      lifecycle: "current",
      updatedAt: new Date().toISOString(),
      run: null,
      profiled: {
        at: acceptedAt,
        inputDigest: current.project.inputDigest,
        profiler: current.profiler,
      },
      reprofile: null,
      failure: null,
    };
  }

  if (
    current !== null &&
    state.profiled !== null &&
    state.profiled.inputDigest !== current.project.inputDigest
  ) {
    let acceptedAt = current.generatedAt;
    try {
      acceptedAt = (await lstat(currentProfilePath(root))).mtime.toISOString();
    } catch {
      // same as above
    }
    return {
      ...state,
      profiled: {
        at: acceptedAt,
        inputDigest: current.project.inputDigest,
        profiler: current.profiler,
      },
    };
  }

  return state;
}

function profileStatesEqual(
  left: ProjectProfileState,
  right: ProjectProfileState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Persist crash-window repair and strip leftover temp files. Safe to call at
 * daemon start and any other moment that must not observe a permanently stuck
 * `profiling` run after a successful current.json rename. */
export async function reconcileProfileState(
  root: string,
): Promise<ProjectProfileState> {
  return withProfileLock(root, async () => {
    const raw = await readJson(profileStatePath(root));
    const parsed = ProjectProfileStateSchema.safeParse(raw);
    const baseline = parsed.success ? parsed.data : emptyProfileState(root);
    const healed = await healProfileState(root, baseline);
    if (!profileStatesEqual(baseline, healed)) {
      await writeProfileState(root, healed);
    }
    await cleanupProfileTemps(root);
    return healed;
  });
}

/** Remove staged `*.tmp` files left by a killed writer. Never touches
 * `current.json` or `state.json`. */
async function cleanupProfileTemps(root: string): Promise<void> {
  const directory = projectProfileDir(root);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".tmp"))
      .map((name) => unlink(join(directory, name)).catch(() => undefined)),
  );
}

async function writeProfileState(
  root: string,
  state: ProjectProfileState,
): Promise<void> {
  await writeJsonAtomic(profileStatePath(root), state);
}

/** Serialise every read-modify-write of `state.json`.
 *
 * Reading the state and then acting on it is not one step, and the `await`
 * between the two halves is all a second caller needs to slip through: two
 * launchers asking "is anything profiling?" at the same time would both be told
 * no, and both start. One profiling job per project cannot be enforced by a
 * caller that checks first — only by a compare-and-begin that no one can be
 * interleaved with. The lock is the repo's own `withFileLock`, so it holds
 * across processes too, not merely across this daemon's event loop. */
async function withProfileLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = projectProfileDir(root);
  await mkdir(directory, { recursive: true });
  return withFileLock(join(directory, "profile.lock"), operation);
}

// --- lifecycle --------------------------------------------------------------

export interface ProfilerIdentity {
  agent: string;
  provider: string;
  model: string;
}

/** Requester metadata recorded on the run and copied into accepted-profile
 * provenance. Guidance is normalized and capped; it never affects validation. */
export interface BeginProfilingRequest {
  source: string;
  requestedBy: string;
  guidance?: string | null;
  /** Vendor session id when already known; otherwise omitted (stored as null). */
  toolSessionId?: string | null;
}

export interface BeginProfilingOptions {
  ifIdle?: boolean;
  request?: BeginProfilingRequest;
}

export interface ProfileRunHandle {
  runId: string;
  /** The digest the submitted profile must carry back. */
  inputDigest: string;
  inventory: ProfileInventory;
  /** Request provenance sealed onto the run at begin. */
  request: ProjectProfileRequest;
}

function sealRunRequest(
  profiler: ProfilerIdentity,
  request: BeginProfilingRequest | undefined,
  at: string,
): ProjectProfileRequest {
  return {
    source: request?.source ?? "daemon",
    requestedAt: at,
    requestedBy: request?.requestedBy ?? profiler.agent,
    guidance: normalizeProfileGuidance(request?.guidance),
  };
}

/** Start a profiling run: `unprofiled | stale | failed | current → profiling`.
 *
 * The daemon observes the inventory here, and *it* — not the model — decides
 * what the profiler was looking at. Nothing is destroyed either way: a profile
 * already in `current.json` stays exactly where it is, and stays readable, for
 * the whole run.
 *
 * Two ways to begin, because there are two honest answers to "a run is already
 * in flight":
 *
 * - By default, beginning supersedes. The new run id is the only one that can
 *   land, so a slow profiler cannot overwrite the work of the run that replaced
 *   it — supersession is enforced at submit, not merely announced here.
 * - With `{ ifIdle: true }`, beginning *refuses* and returns null while a run is
 *   in flight. One profiling job per project is an invariant the daemon owns, so
 *   the primitive that mints runs is what enforces it: a caller that must check
 *   first is a caller that can forget to. Whose job it is, when a dead run may be
 *   taken over, and what counts as dead are policy, and stay out of here.
 *
 * Optional `request` records who asked and any guidance; both become provenance
 * on the accepted profile and never override validation. */
export function beginProfiling(
  root: string,
  profiler: ProfilerIdentity,
  options?: BeginProfilingOptions & { ifIdle?: false | undefined },
): Promise<ProfileRunHandle>;
export function beginProfiling(
  root: string,
  profiler: ProfilerIdentity,
  options: BeginProfilingOptions & { ifIdle: true },
): Promise<ProfileRunHandle | null>;
export async function beginProfiling(
  root: string,
  profiler: ProfilerIdentity,
  options?: BeginProfilingOptions,
): Promise<ProfileRunHandle | null> {
  return withProfileLock(root, async () => {
    const previous = await readProfileState(root);
    if (
      options?.ifIdle === true &&
      previous.lifecycle === "profiling" &&
      previous.run !== null
    ) {
      return null;
    }
    // Inside the lock, so the digest is the tree as it was when this run was
    // minted, and so the check above and the write below cannot be split by a
    // concurrent begin.
    const inventory = await computeProfileInventory(root);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const request = sealRunRequest(profiler, options?.request, startedAt);
    await writeProfileState(root, {
      ...previous,
      schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
      lifecycle: "profiling",
      hiveUuid: projectHiveUuid(root),
      updatedAt: startedAt,
      run: {
        runId,
        agent: profiler.agent,
        provider: profiler.provider,
        model: profiler.model,
        inputDigest: inventory.digest,
        startedAt,
        toolSessionId: options?.request?.toolSessionId ?? null,
        request,
      },
    });
    return {
      runId,
      inputDigest: inventory.digest,
      inventory,
      request,
    };
  });
}

/** Append guidance onto an in-flight run's request provenance (coalesced
 * requesters). Returns null when no matching run is live. Guidance is
 * concatenated in arrival order up to the 4 KiB cap and never affects
 * validation. */
export async function appendProfilingGuidance(
  root: string,
  runId: string,
  guidance: string | null | undefined,
  meta?: { source?: string; requestedBy?: string },
): Promise<ProjectProfileRequest | null> {
  const normalized = normalizeProfileGuidance(guidance);
  return withProfileLock(root, async () => {
    const state = await readProfileState(root);
    if (
      state.run === null ||
      state.run.runId !== runId ||
      state.lifecycle !== "profiling"
    ) {
      return null;
    }
    const merged = mergeProfileGuidance(state.run.request.guidance, normalized);
    const request: ProjectProfileRequest = {
      source: meta?.source ?? state.run.request.source,
      requestedAt: state.run.request.requestedAt,
      requestedBy: meta?.requestedBy ?? state.run.request.requestedBy,
      guidance: merged,
    };
    await writeProfileState(root, {
      ...state,
      updatedAt: new Date().toISOString(),
      run: { ...state.run, request },
    });
    return request;
  });
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

/** Submit a *candidate* profile.
 *
 * `subject` and `runId` are daemon-authenticated credentials — never taken from
 * the model payload. The payload may only carry model-authored content; the
 * daemon assembles schema version, timestamps, project identity/digest,
 * profiler provenance, and request guidance from the active run before
 * validation and commit. A candidate that tries to choose those fields fails
 * the schema boundary.
 *
 * On acceptance: `profiling → current`, and the profile becomes readable in the
 * same instant its state says so. `current.json` is written before `state.json`
 * on purpose. A crash between the two leaves a valid new profile that the state
 * has not caught up with — recoverable, and readable. The other order would
 * leave a state file swearing a profile is current while `current.json` still
 * holds the old one, which is a lie, and lies do not recover.
 *
 * On rejection nothing is written to `current.json` at all.
 *
 * Validation runs *outside* the lock — it hashes the tree and stats every cited
 * path, and holding a lock for that would stall every other caller. Only the
 * decision is locked, and inside it the run is re-read: whatever was true when
 * validation started, the profile lands only if the run it was authored for is
 * still the live one. A run superseded while its profile was being checked
 * cannot land on top of the run that replaced it. */
export async function submitProfile(
  root: string,
  payload: unknown,
  subject: string,
  runId: string,
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
  if (state.run.runId !== runId) {
    return {
      status: "rejected",
      rejections: [
        {
          code: "superseded",
          message: `Run ${runId} is no longer active; the active run is ${state.run.runId}.`,
          at: "runId",
        },
      ],
      lifecycle: state.lifecycle,
    };
  }
  const validatedAgainst = state.run;

  const inventory = await computeProfileInventory(root);
  const validation = await validateProfileSubmission(payload, {
    root,
    hiveUuid: projectHiveUuid(root),
    run: validatedAgainst,
    subject,
    inventoryDigest: inventory.digest,
  });

  return withProfileLock(root, async () => {
    const fresh = await readProfileState(root);
    if (
      fresh.run === null ||
      fresh.run.runId !== validatedAgainst.runId ||
      fresh.run.runId !== runId
    ) {
      // The run moved on while this submission was being validated. Its result
      // describes a run nobody is waiting for, and writing it would clobber
      // whatever replaced it.
      return {
        status: "rejected" as const,
        rejections: [
          {
            code: "superseded" as const,
            message: `Run ${validatedAgainst.runId} was superseded while its profile was being validated.`,
          },
        ],
        lifecycle: fresh.lifecycle,
      };
    }

    if (!validation.ok) {
      // Only the agent that owns the run can change its state. Otherwise any
      // authenticated caller could end someone else's profiling run by
      // submitting rubbish to it — a rejected submission would write `failed`
      // over a run that is still perfectly alive.
      const ownsRun = fresh.run.agent === subject;
      return {
        status: "rejected" as const,
        rejections: validation.rejections,
        lifecycle: ownsRun
          ? await recordRejection(root, fresh, validation.rejections)
          : fresh.lifecycle,
      };
    }

    const profile = validation.profile;
    // The proof has to be taken here, not where validation ran. A check made
    // before the lock is a statement about a repo that was; between it and this
    // rename a cited file can be deleted, and committing then would persist a
    // profile citing a path that is not there — exactly the hallucinated-manifest
    // failure the citation rule exists to catch, arriving through the back door.
    //
    // The bytes are staged (written and fsynced) BEFORE the proof so that after
    // the proof's last stat only the rename remains: the window in which the
    // repo could change between "the citations hold" and "the profile is live"
    // is one rename, not a write plus an fsync plus a rename. It is not zero.
    // Nothing takes `profile.lock` when it edits the repo — the repo does not
    // know this lock exists — so a file deleted in that final instant, or in the
    // instant after the commit, still lands. That residual is unclosable at this
    // layer and is the same event as a deletion the moment after any commit; it
    // belongs to drift detection, which marks a profile stale when a cited path
    // is observed missing. See the staleness contract on ProjectProfileSchema.
    const staged = await stageJson(currentProfilePath(root), profile);
    let committed = false;
    try {
      const proof = await proveProfileStillHolds(profile, {
        root,
        run: fresh.run,
        inventoryDigest: (await computeProfileInventory(root)).digest,
      });
      if (proof.length > 0) {
        return {
          status: "rejected" as const,
          rejections: proof,
          lifecycle: await recordRejection(root, fresh, proof),
        };
      }
      await commitStaged(staged, currentProfilePath(root));
      committed = true;
    } finally {
      if (!committed) await unlink(staged).catch(() => undefined);
    }
    await writeProfileState(root, {
      ...fresh,
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
    return { status: "accepted" as const, profile };
  });
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
  return withProfileLock(root, async () => {
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
  });
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
  return withProfileLock(root, async () => {
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
  });
}
